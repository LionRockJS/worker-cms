// ============================================================
// Plugin tenant enrollment (host side).
//
// A multi-tenant plugin Worker keeps one `tenant:<cms origin>` record per
// connected CMS, holding that pair's shared secret. Historically an operator
// copied the secret into the plugin's KV by hand. When a plugin's manifest
// declares `autoTenant`, an admin can instead press Connect and let this CMS
// hand the secret over — without ever putting it on an unauthenticated wire:
//
//   1. This CMS mints a single-use ticket, stores only its SHA-256, and POSTs
//      {tenant, plugin_id, ticket, tenant_vars} to
//      {plugin}/__plugin/tenants/enroll. The optional tenant_vars list comes
//      from the plugin's validated manifest; it contains names only, never
//      values.
//   2. The plugin calls back to THIS origin's /__cms/tenant/claim to redeem the
//      ticket. Because the plugin dials the origin itself, a request that lies
//      about which CMS it is cannot be redeemed anywhere.
//   3. Only that claim response carries the secret, and only once.
//
// The ticket is a bearer capability, so it is short-lived (5 min), single use
// (claimed with a compare-and-delete), bound to one plugin id + registered URL,
// and stored hashed so a `settings` read never yields a usable one.
// ============================================================

import type { Env } from '../../types';
import type { PluginManifest, ResolvedPlugin } from './types';
import { getSetting, saveSetting } from '../../core/db/settings';
import { PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { pluginTenantId, timingSafeEqualStr } from './proxy';

/** How long a minted enrollment ticket stays redeemable. */
export const ENROLL_TTL_MS = 5 * 60_000;

/** Path the plugin enrollment endpoint is served under on the plugin Worker. */
const ENROLL_PATH = `${PLUGIN_PREFIX}/tenants/enroll`;
const REVOKE_PATH = `${PLUGIN_PREFIX}/tenants/revoke`;

/** Settings key holding the pending ticket for one plugin. */
function enrollmentKey(pluginId: string): string {
  return `plugin.enrollment.${pluginId}`;
}

interface PendingEnrollment {
  /** SHA-256 of the issued ticket — the plaintext is never stored. */
  hash: string;
  /** Registered plugin base URL the ticket was issued for. */
  url: string;
  /** Epoch ms after which the ticket is dead. */
  exp: number;
  /** Admin who pressed Connect (audit trail). */
  by: string;
}

/** True when a manifest advertises host-initiated tenant enrollment. */
export function manifestAllowsAutoTenant(manifest: PluginManifest): boolean {
  return manifest.autoTenant === true || manifest.auto_tenant === true;
}

/**
 * Returns the union of both supported manifest spellings. The registry has
 * already validated these names, so this function only needs to deduplicate
 * them before putting them on the enrollment wire.
 */
function manifestTenantVars(manifest: PluginManifest): string[] {
  return [...new Set([
    ...(manifest.tenantVars ?? []),
    ...(manifest.tenant_vars ?? []),
  ])];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 256 bits of entropy, URL-safe — the enrollment bearer ticket. */
function generateTicket(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Condenses a plugin's error response into one audit-log line. The body is
 * plugin-controlled text landing in stored records, so it is stripped of
 * control characters and hard-capped rather than logged verbatim.
 */
async function failureDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const clean = body.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${response.status}${clean ? ` ${clean}` : ''}`;
}

/** Outcome codes surfaced to the admin as a flash message. */
export type EnrollCode =
  | 'connected'
  | 'no-canonical-origin'
  | 'not-supported'
  | 'no-secret'
  | 'unreachable'
  | 'rejected';

export interface EnrollResult {
  ok: boolean;
  code: EnrollCode;
  /** Plugin-reported detail, for the audit log only (never a secret). */
  detail?: string;
}

/**
 * Runs the Connect handshake for one plugin. Returns a result rather than
 * throwing so the admin route can always render a flash.
 */
export async function enrollPluginTenant(
  env: Env,
  plugin: ResolvedPlugin,
  actorEmail: string,
): Promise<EnrollResult> {
  // The tenant id IS this CMS's canonical origin; without it the plugin has no
  // origin to call back to and nothing can be verified.
  const tenantId = pluginTenantId(env);
  if (!tenantId) return { ok: false, code: 'no-canonical-origin' };
  if (!manifestAllowsAutoTenant(plugin.manifest)) return { ok: false, code: 'not-supported' };
  if (!plugin.apiSecret) return { ok: false, code: 'no-secret' };

  const ticket = generateTicket();
  const pending: PendingEnrollment = {
    hash: await sha256Hex(ticket),
    url: plugin.binding,
    exp: Date.now() + ENROLL_TTL_MS,
    by: actorEmail,
  };
  await saveSetting(env, enrollmentKey(plugin.manifest.id), JSON.stringify(pending));

  try {
    const tenantVars = manifestTenantVars(plugin.manifest);
    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${ENROLL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant: tenantId,
        plugin_id: plugin.manifest.id,
        ticket,
        ...(tenantVars.length ? { tenant_vars: tenantVars } : {}),
      }),
    });
    if (response.ok) return { ok: true, code: 'connected' };
    return { ok: false, code: 'rejected', detail: await failureDetail(response) };
  } catch (error) {
    console.error(`Plugin ${plugin.binding} enrollment failed:`, error);
    return { ok: false, code: 'unreachable' };
  } finally {
    // Whether the plugin redeemed it or not, the window closes with the
    // request — a ticket left behind is a credential nobody is watching.
    await clearPendingEnrollment(env, plugin.manifest.id);
  }
}

/**
 * Asks the plugin to drop this CMS's tenant record. Authenticated with the
 * pairwise secret, so it can only ever remove our own row.
 */
export async function revokePluginTenant(env: Env, plugin: ResolvedPlugin): Promise<EnrollResult> {
  if (!plugin.apiSecret) return { ok: false, code: 'no-secret' };
  const headers = new Headers({ 'x-plugin-secret': plugin.apiSecret });
  const tenantId = pluginTenantId(env);
  if (tenantId) headers.set('x-cms-tenant', tenantId);

  try {
    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${REVOKE_PATH}`, { method: 'POST', headers });
    if (response.ok) return { ok: true, code: 'connected' };
    return { ok: false, code: 'rejected', detail: await failureDetail(response) };
  } catch (error) {
    console.error(`Plugin ${plugin.binding} revoke failed:`, error);
    return { ok: false, code: 'unreachable' };
  }
}

async function clearPendingEnrollment(env: Env, pluginId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(enrollmentKey(pluginId)).run().catch(() => undefined);
}

export interface ClaimedEnrollment {
  url: string;
}

/**
 * Redeems a ticket presented by a plugin. Returns the pending record on
 * success, or null for anything else — expired, unknown, wrong plugin, or
 * already claimed.
 *
 * The delete is conditional on the exact stored value, so two racing claims
 * cannot both win, and a wrong ticket cannot burn a legitimate pending
 * enrollment (which would be a cheap denial of the admin's Connect click).
 */
export async function claimEnrollmentTicket(
  env: Env,
  pluginId: string,
  ticket: string,
): Promise<ClaimedEnrollment | null> {
  const key = enrollmentKey(pluginId);
  const stored = await getSetting(env, key);
  if (!stored) return null;

  let pending: PendingEnrollment;
  try {
    pending = JSON.parse(stored) as PendingEnrollment;
  } catch {
    await clearPendingEnrollment(env, pluginId);
    return null;
  }

  if (!pending.hash || !pending.exp || pending.exp < Date.now()) {
    await clearPendingEnrollment(env, pluginId);
    return null;
  }
  if (!timingSafeEqualStr(await sha256Hex(ticket), pending.hash)) return null;

  const claimed = await env.DB
    .prepare('DELETE FROM settings WHERE key = ? AND value = ? RETURNING key')
    .bind(key, stored)
    .first<{ key: string }>();
  if (!claimed) return null;

  return { url: pending.url };
}
