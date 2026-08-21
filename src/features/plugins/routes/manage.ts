// ============================================================
// Plugin management — register / enable / disable / configure plugins,
// stored in the `plugins` D1 table (URL transport). Gated by plugin:manage.
//
// Distinct from src/routes/admin/plugins.ts, which proxies *into* a plugin's
// admin UI (plugin:access). This router manages the registry rows themselves.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { renderPage } from '../../../core/render/chrome';
import { logAudit } from '../../../core/db/audit';
import { str, num } from '../../../core/http/forms';
import { getPlugins, clearManifestCache, pluginIdentityStates } from '../registry';
import { clearConfigCache } from '../../../core/db/content-config';
import {
  listPlugins,
  getPlugin,
  getPluginByUrl,
  createPlugin,
  updatePlugin,
  deletePlugin,
  setPluginEnabled,
  setPluginSecret,
  generatePluginSecret,
  type PluginInput,
} from '../store';
import { approveAsset, computeIntegrity, getAssetApproval, inspectAssetHealth, listApprovals, revokeAllAssets, revokeAsset } from '../assets';
import {
  approvePageTypeAccess,
  getPageTypeApproval,
  isPageTypeWildcard,
  listPageTypeApprovals,
  revokeAllPageTypeAccess,
  revokePageTypeAccess,
} from '../page-types';
import {
  approveFilePrefix,
  FilePrefixConflictError,
  findFilePrefixConflict,
  getFilePrefixApproval,
  listFilePrefixApprovals,
  revokeAllFilePrefixes,
  revokeFilePrefix,
} from '../file-prefixes';
import { deleteAllPluginState } from '../state';
import { getIdentityForRow, movePluginState, releaseIdentity, repinIdentity } from '../identity';
import { PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../registry';
import { pluginTenantId } from '../proxy';
import { enrollPluginTenant, manifestAllowsAutoTenant, revokePluginTenant } from '../enroll';
import {
  countLimitUsage,
  declaredLimits,
  limitScopeTypes,
  loadLimitValues,
  saveLimitValues,
  type NormalizedLimitDef,
  type PluginLimitValues,
} from '../limits';
import { callFeatureService } from '../../services';
import {
  pluginsManagePage,
  pluginFormPage,
  pluginAssetsPage,
  pluginFilePrefixesPage,
  pluginCreditsPage,
  pluginLimitsPage,
  pluginPageTypesPage,
  type PluginCreditRow,
  type PluginLimitRow,
  type PluginListItem,
} from '../templates/manage';
import { pluginTrustLevel, type PluginManifest, type PluginPageTypeAccess, type ResolvedPlugin } from '../types';

export const pluginsManageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pluginsManageRoutes.use('/plugins-manage', requirePermission('plugin:manage'));
pluginsManageRoutes.use('/plugins-manage/*', requirePermission('plugin:manage'));

/**
 * Best-effort SSRF guard: rejects hostnames that are literally a private,
 * loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, or
 * .internal address. The CMS issues server-side requests to plugin URLs and
 * forwards the signed-in user summary + the plugin secret, so a registered URL
 * must not be able to point those at internal infrastructure. This does not
 * defend against DNS rebinding or a public hostname that resolves to a private
 * IP — it only blocks the obvious literals.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // WHATWG URL canonicalizes IPv4-mapped IPv6 addresses to hexadecimal, e.g.
  // [::ffff:127.0.0.1] becomes [::ffff:7f00:1]. Block the mapped loopback and
  // private IPv4 ranges as well as their dotted spelling.
  if (/^::ffff:(?:7f[0-9a-f]{2}|a[0-9a-f]{2}|a9fe|c0a8|ac1[0-9a-f]|64[4-7][0-9a-f]):[0-9a-f]{1,4}$/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true; // IPv6 ULA / link-local
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/** Normalizes + validates a plugin base URL. Returns [normalized, error]. */
function normalizeUrl(raw: string): [string, string | null] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [trimmed, 'Enter a valid URL.'];
  }
  // localhost over http stays allowed for local development against a plugin
  // Worker on another port; every other host must be HTTPS and non-private.
  if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
    return [trimmed, null];
  }
  if (parsed.protocol !== 'https:') {
    return [trimmed, 'URL must be HTTPS (http is allowed only for localhost).'];
  }
  if (isPrivateHost(parsed.hostname)) {
    return [trimmed, 'URL must not point to a private, loopback, or internal host.'];
  }
  return [trimmed, null];
}

/** Validates optional config JSON. Returns [stored, error]. */
function normalizeConfig(raw: string): [string | null, string | null] {
  const trimmed = raw.trim();
  if (!trimmed) return [null, null];
  try {
    JSON.parse(trimmed);
    return [trimmed, null];
  } catch {
    return [trimmed, 'Config must be valid JSON (or left blank).'];
  }
}

const TENANT_CONFIG_PATH = `${PLUGIN_PREFIX}/tenants/config`;
const TENANT_VAR_FORM_PREFIX = 'tenant_var_';

function manifestTenantVars(manifest: PluginManifest | undefined): string[] {
  return [...new Set([
    ...(manifest?.tenantVars ?? []),
    ...(manifest?.tenant_vars ?? []),
  ])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface TenantConfigRead {
  available: boolean;
  values: Record<string, string>;
}

/** Reads only the manifest-declared tenant vars; never logs or stores values. */
async function readPluginTenantConfig(
  plugin: ResolvedPlugin | undefined,
  tenantId: string,
  names: string[],
): Promise<TenantConfigRead> {
  if (!plugin || !tenantId || !names.length) return { available: false, values: {} };
  const secret = plugin.apiSecret || plugin.secret;
  if (!secret) return { available: false, values: {} };

  try {
    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${TENANT_CONFIG_PATH}`, {
      headers: {
        'x-plugin-secret': secret,
        'x-cms-tenant': tenantId,
      },
    });
    if (!response.ok) return { available: false, values: {} };
    const body = await response.json().catch(() => null) as unknown;
    if (!isRecord(body)) return { available: false, values: {} };
    const rawVars = body.vars;
    if (!isRecord(rawVars)) return { available: false, values: {} };
    return {
      available: true,
      values: Object.fromEntries(names.map((name) => [
        name,
        typeof rawVars[name] === 'string' ? rawVars[name] : '',
      ])),
    };
  } catch {
    return { available: false, values: {} };
  }
}

function readForm(form: FormData): { input: PluginInput | null; error: string | null; raw: { label: string; url: string; enabled: boolean; sortOrder: number; config: string } } {
  const label = str(form.get('label'));
  const [url, urlError] = normalizeUrl(str(form.get('url')));
  const enabled = form.get('enabled') != null;
  const sortOrder = num(form.get('sort_order'), 0);
  const [config, configError] = normalizeConfig(str(form.get('config')));
  const raw = { label, url, enabled, sortOrder, config: str(form.get('config')) };

  const error = urlError ?? configError;
  if (error) return { input: null, error, raw };
  return { input: { label, url, enabled, config, sort_order: sortOrder }, error: null, raw };
}

// ── List ──────────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage', async (c) => {
  const [rows, resolved, identities] = await Promise.all([
    listPlugins(c.env.DB),
    getPlugins(c.env),
    pluginIdentityStates(c.env),
  ]);
  // resolved plugins are keyed by their base URL (ResolvedPlugin.binding).
  const byUrl = new Map(resolved.map((p) => [p.binding, p]));
  // A plugin held back over its identity is reachable but deliberately not
  // resolved, so it must not read as merely "unreachable" in the list.
  const identityById = new Map(identities.map((state) => [state.rowId, state]));

  const plugins: PluginListItem[] = await Promise.all(rows.map(async (row) => {
    const plugin = byUrl.get(row.url);
    const manifest = plugin?.manifest;
    const identity = identityById.get(row.id);
    const status: PluginListItem['status'] = !row.enabled
      ? 'disabled'
      : manifest
        ? 'active'
        : identity && identity.status !== 'ok'
          ? 'identity'
          : 'unreachable';
    const assetHealth = plugin && manifest?.assets?.length
      ? await inspectAssetHealth(c.env.DB, manifest.id, plugin.fetcher, manifest.assets)
      : undefined;
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      enabled: !!row.enabled,
      status,
      manifestId: manifest?.id ?? identity?.servedId,
      manifestName: manifest?.name,
      version: manifest?.version,
      trustLevel: manifest ? pluginTrustLevel(manifest) : undefined,
      hasAssets: !!manifest?.assets?.length,
      hasFilePrefixes: !!manifest?.filePrefixes?.length,
      hasPageTypes: !!(
        Object.keys(manifest?.contentTypes?.blueprint ?? {}).length
        + Object.keys(manifest?.contentTypes?.taxonomies ?? {}).length
        + (manifest?.contentTypes?.readTypes?.length ?? 0)
        + (manifest?.contentTypes?.writeTypes?.length ?? 0)
      ),
      hasLimits: !!manifest?.limits?.length,
      hasCredits: !!manifest?.credits?.length,
      assetNeedsApproval: !!assetHealth?.needsApproval,
      assetNeedsUpdate: !!assetHealth?.needsUpdate,
      assetStatusError: !!assetHealth?.fetchError,
    };
  }));

  return renderPage(c, pluginsManagePage, { plugins });
});

// ── Create ──────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/new', async (c) => {
  return renderPage(c, pluginFormPage, {
    isNew: true,
    label: '',
    url: '',
    enabled: true,
    sortOrder: 0,
    config: '',
  });
});

pluginsManageRoutes.post('/plugins-manage', async (c) => {
  const { input, error, raw } = readForm(await c.req.formData());
  if (!input) {
    return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: error ?? undefined });
  }
  // Auto-generate a dedicated secret for the new plugin; the edit page (where we
  // land next) shows it so the admin can copy it onto the plugin Worker.
  const dbError = await createPlugin(c.env.DB, { ...input, secret: generatePluginSecret() });
  if (dbError) {
    return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: dbError });
  }
  invalidate();
  logAudit(c, 'plugin.create', 'plugin', input.url, { label: input.label, enabled: input.enabled });
  const created = await getPluginByUrl(c.env.DB, input.url);
  return c.redirect(created ? `/admin/plugins-manage/${created.id}/edit?flash=secret-generated` : '/admin/plugins-manage');
});

// ── Edit ────────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row: plugin, resolved } = found;
  const tenantId = pluginTenantId(c.env);
  const tenantVarNames = manifestTenantVars(resolved?.manifest);
  const tenantConfig = await readPluginTenantConfig(resolved, tenantId, tenantVarNames);
  const identity = (await pluginIdentityStates(c.env)).find((state) => state.rowId === id);
  return renderPage(c, pluginFormPage, {
    isNew: false,
    id: plugin.id,
    identityStatus: identity?.status ?? (plugin.enabled ? 'unreachable' : 'disabled'),
    identityPinnedId: identity?.pinnedId ?? '',
    identityServedId: identity?.servedId ?? '',
    identityAction: `/admin/plugins-manage/${plugin.id}/identity`,
    label: plugin.label,
    url: plugin.url,
    enabled: !!plugin.enabled,
    sortOrder: plugin.sort_order,
    config: plugin.config ?? '',
    secret: plugin.secret ?? '',
    tenantKvKey: `tenant:${tenantId}`,
    tenantVars: tenantVarNames.map((name) => ({ name, value: tenantConfig.values[name] ?? '' })),
    tenantConfigAvailable: tenantConfig.available,
    tenantConfigAction: `/admin/plugins-manage/${plugin.id}/tenant-config`,
    // Connect is offered only when the plugin says it accepts enrollment AND
    // we have a canonical origin for it to verify us against.
    autoTenant: !!resolved && manifestAllowsAutoTenant(resolved.manifest) && !!tenantId,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/tenant-config', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row: plugin, resolved } = found;
  const tenantId = pluginTenantId(c.env);
  const names = manifestTenantVars(resolved?.manifest);
  const secret = resolved?.apiSecret || resolved?.secret || '';
  if (!resolved || !tenantId || !names.length || !secret) {
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
  }

  const form = await c.req.formData();
  const vars: Record<string, string | null> = {};
  for (const name of names) {
    const value = form.get(`${TENANT_VAR_FORM_PREFIX}${name}`);
    if (value === null) continue;
    if (typeof value !== 'string') {
      logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, { ok: false, keys: [name] });
      return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
    }
    vars[name] = value === '' ? null : value;
  }

  try {
    const response = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${TENANT_CONFIG_PATH}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-plugin-secret': secret,
        'x-cms-tenant': tenantId,
      },
      body: JSON.stringify({ vars }),
    });
    const ok = response.ok;
    logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, {
      ok,
      keys: Object.keys(vars),
      status: response.status,
    });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${ok ? 'tenant-config-saved' : 'tenant-config-failed'}`);
  } catch (error) {
    console.error(`Plugin ${plugin.url} tenant config update failed:`, error);
    logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, { ok: false, keys: Object.keys(vars) });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
  }
});

/** Maps an enrollment outcome onto the flash code the edit page renders. */
function enrollFlash(prefix: string, result: { ok: boolean; code: string }): string {
  return result.ok ? `${prefix}-ok` : `${prefix}-${result.code}`;
}

pluginsManageRoutes.post('/plugins-manage/:id/connect', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) return c.redirect(`/admin/plugins-manage/${id}/edit?flash=connect-unreachable`);

  const result = await enrollPluginTenant(c.env, resolved, c.get('user').email);
  if (result.ok) {
    // Enrollment changes the plugin's effective connection state outside D1.
    // Treat it like enable/disable: discard the resolved registry/config
    // snapshots, then eagerly resolve once so the redirect lands on freshly
    // validated plugin state instead of waiting for cache expiry.
    invalidate();
    await getPlugins(c.env);
  }
  logAudit(c, 'plugin.tenant.connect', 'plugin', row.url, {
    ok: result.ok,
    code: result.code,
    ...(result.detail ? { detail: result.detail } : {}),
  });
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('connect', result)}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/disconnect', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) return c.redirect(`/admin/plugins-manage/${id}/edit?flash=disconnect-unreachable`);

  const result = await revokePluginTenant(c.env, resolved);
  logAudit(c, 'plugin.tenant.disconnect', 'plugin', row.url, {
    ok: result.ok,
    code: result.code,
    ...(result.detail ? { detail: result.detail } : {}),
  });
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('disconnect', result)}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/rotate-secret', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();
  await setPluginSecret(c.env.DB, id, generatePluginSecret());
  invalidate();
  logAudit(c, 'plugin.rotate_secret', 'plugin', plugin.url);

  // Rotation breaks the connection the instant it lands, so push the new
  // secret straight away for plugins that accept enrollment — otherwise the
  // admin is left with a plugin that 403s until they remember to reconnect.
  const resolved = (await getPlugins(c.env)).find((candidate) => candidate.binding === plugin.url);
  if (resolved && manifestAllowsAutoTenant(resolved.manifest)) {
    const result = await enrollPluginTenant(c.env, resolved, c.get('user').email);
    logAudit(c, 'plugin.tenant.connect', 'plugin', plugin.url, {
      ok: result.ok,
      code: result.code,
      after: 'rotate',
      ...(result.detail ? { detail: result.detail } : {}),
    });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('rotate-connect', result)}`);
  }
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=secret-rotated`);
});

pluginsManageRoutes.post('/plugins-manage/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();

  const { input, error, raw } = readForm(await c.req.formData());
  if (!input) {
    return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: error ?? undefined });
  }
  const dbError = await updatePlugin(c.env.DB, id, input);
  if (dbError) {
    return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: dbError });
  }
  invalidate();
  logAudit(c, 'plugin.update', 'plugin', input.url, { label: input.label, enabled: input.enabled });
  return c.redirect('/admin/plugins-manage');
});

pluginsManageRoutes.post('/plugins-manage/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();
  await setPluginEnabled(c.env.DB, id, !plugin.enabled);
  invalidate();
  logAudit(c, 'plugin.toggle', 'plugin', plugin.url, { enabled: !plugin.enabled });
  return c.redirect('/admin/plugins-manage');
});

/**
 * Re-approves a plugin's identity after its manifest id changed.
 *
 * A changed id is either a rename or a takeover, and the CMS cannot tell them
 * apart — so the plugin stays unresolved until an admin says which it is. The
 * capabilities the previous identity held are NOT carried over: asset,
 * page-type and file-prefix approvals were granted to that id and must be
 * granted again deliberately. Host-held state moves, because it is the
 * plugin's data rather than a privilege.
 */
pluginsManageRoutes.post('/plugins-manage/:id/identity', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();

  const state = (await pluginIdentityStates(c.env)).find((entry) => entry.rowId === id);
  if (!state || !state.servedId) return c.redirect(`/admin/plugins-manage/${id}/edit?flash=identity-unreachable`);
  if (state.status === 'ok') return c.redirect(`/admin/plugins-manage/${id}/edit?flash=identity-ok`);

  const previousId = state.pinnedId;
  if (!(await repinIdentity(c.env.DB, id, state.servedId, c.get('user').email))) {
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=identity-claimed`);
  }
  if (previousId && previousId !== state.servedId) {
    await Promise.all([
      revokeAllAssets(c.env.DB, previousId),
      revokeAllPageTypeAccess(c.env.DB, previousId),
      revokeAllFilePrefixes(c.env.DB, previousId),
    ]);
    await movePluginState(c.env.DB, previousId, state.servedId);
  }
  invalidate();
  logAudit(c, 'plugin.identity.approve', 'plugin', plugin.url, { from: previousId, to: state.servedId });
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=identity-approved`);
});

pluginsManageRoutes.post('/plugins-manage/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row: plugin, resolved } = found;

  // Everything a plugin owns outside the registry row — approvals and host-held
  // state — is keyed by MANIFEST id, not by this row, so deleting the row alone
  // orphans it: invisible in the admin, yet silently inherited by whatever is
  // registered next under the same manifest id.
  //
  // The pinned identity is what makes that purge reliable: it is stored against
  // the row, so a plugin that is disabled or offline right now (the common case
  // when an admin is removing a dead plugin) still deletes with its approvals
  // instead of leaving a claimable id behind. The live manifest is only a
  // fallback for rows registered before identity pinning existed.
  const pinned = await getIdentityForRow(c.env.DB, id);
  const manifestId = pinned?.manifest_id || resolved?.manifest.id || '';
  if (manifestId) {
    await Promise.all([
      deleteAllPluginState(c.env.DB, manifestId),
      revokeAllAssets(c.env.DB, manifestId),
      revokeAllPageTypeAccess(c.env.DB, manifestId),
      revokeAllFilePrefixes(c.env.DB, manifestId),
    ]);
  } else {
    console.warn(
      `Deleted plugin ${plugin.url} without a pinned identity or a resolvable manifest; any approvals `
      + 'and plugin_state rows it owned remain and must be cleared manually.',
    );
  }
  await releaseIdentity(c.env.DB, id);

  await deletePlugin(c.env.DB, id);
  invalidate();
  logAudit(c, 'plugin.delete', 'plugin', plugin.url, { plugin_id: manifestId, purged: !!manifestId });
  return c.redirect('/admin/plugins-manage');
});

// ── Asset approvals ────────────────────────────────────────────────────────
// A plugin's manifest only *declares* candidate JS/CSS files (PluginManifest.
// assets); nothing runs in CMS chrome until an admin explicitly approves a
// path here, pinning its content hash. See utils/plugin-assets.ts.

async function resolvedPluginFor(env: Env, id: number) {
  const row = await getPlugin(env.DB, id);
  if (!row) return null;
  const resolved = (await getPlugins(env)).find((plugin) => plugin.binding === row.url);
  return { row, resolved };
}

pluginsManageRoutes.get('/plugins-manage/:id/assets', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginAssetsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      assets: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declared = resolved.manifest.assets ?? [];
  const approvals = new Map((await listApprovals(c.env.DB, resolved.manifest.id)).map((a) => [a.path, a]));

  const assets = await Promise.all(declared.map(async (asset) => {
    const approval = approvals.get(asset.path);
    let currentIntegrity: string | null = null;
    let fetchError = false;
    try {
      const upstream = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${asset.path}`);
      if (upstream.ok) currentIntegrity = await computeIntegrity(await upstream.arrayBuffer());
      else fetchError = true;
    } catch {
      fetchError = true;
    }
    const approved = !!approval;
    const drifted = approved && currentIntegrity !== null && currentIntegrity !== approval.integrity;
    return {
      path: asset.path,
      label: asset.label || asset.path,
      approved,
      drifted,
      fetchError,
      approvedBy: approval?.approved_by ?? '',
      integrity: approval?.integrity ?? '',
      approveAction: `/admin/plugins-manage/${id}/assets/approve`,
      revokeAction: `/admin/plugins-manage/${id}/assets/revoke`,
    };
  }));

  return renderPage(c, pluginAssetsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    assets,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const path = str(form.get('path'));
  const declared = (resolved.manifest.assets ?? []).some((asset) => asset.path === path);
  if (!declared) return c.text('Unknown asset path', 400);

  const upstream = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${path}`);
  if (!upstream.ok) return c.redirect(`/admin/plugins-manage/${id}/assets?flash=fetch-failed`);
  const integrity = await computeIntegrity(await upstream.arrayBuffer());
  await approveAsset(c.env.DB, resolved.manifest.id, path, integrity, c.get('user').email);
  logAudit(c, 'plugin.asset.approve', 'plugin', resolved.manifest.id, { path, integrity });
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=approved`);
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const path = str(form.get('path'));
  const existing = await getAssetApproval(c.env.DB, resolved.manifest.id, path);
  if (existing) {
    await revokeAsset(c.env.DB, resolved.manifest.id, path);
    logAudit(c, 'plugin.asset.revoke', 'plugin', resolved.manifest.id, { path });
  }
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=revoked`);
});

// ── File-prefix approvals ─────────────────────────────────────────────────
// A manifest only declares candidate host-storage namespaces. Approval is
// explicit and global: an approved prefix also reserves every nested prefix
// from another plugin, so plugins cannot overwrite one another's R2 folders.

pluginsManageRoutes.get('/plugins-manage/:id/files', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginFilePrefixesPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      prefixes: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declared = resolved.manifest.filePrefixes ?? [];
  const approvals = new Map((await listFilePrefixApprovals(c.env.DB, resolved.manifest.id)).map((approval) => [approval.prefix, approval]));
  const prefixes = await Promise.all(declared.map(async (prefix) => {
    const approval = approvals.get(prefix);
    const conflict = approval ? null : await findFilePrefixConflict(c.env.DB, resolved.manifest.id, prefix);
    return {
      prefix,
      approved: !!approval,
      approvedBy: approval?.approved_by ?? '',
      conflict: !!conflict,
      conflictPluginId: conflict?.plugin_id ?? '',
      approveAction: `/admin/plugins-manage/${id}/files/approve`,
      revokeAction: `/admin/plugins-manage/${id}/files/revoke`,
    };
  }));

  return renderPage(c, pluginFilePrefixesPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    prefixes,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/files/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const prefix = str((await c.req.formData()).get('prefix'));
  if (!(resolved.manifest.filePrefixes ?? []).includes(prefix)) {
    return c.text('Unknown file prefix', 400);
  }

  try {
    await approveFilePrefix(c.env.DB, resolved.manifest.id, prefix, c.get('user').email);
  } catch (error) {
    if (error instanceof FilePrefixConflictError) {
      logAudit(c, 'plugin.file_prefix.approve', 'plugin', resolved.manifest.id, {
        prefix,
        ok: false,
        conflict_plugin_id: error.conflict.plugin_id,
        conflict_prefix: error.conflict.prefix,
      });
      return c.redirect(`/admin/plugins-manage/${id}/files?flash=conflict`);
    }
    throw error;
  }

  logAudit(c, 'plugin.file_prefix.approve', 'plugin', resolved.manifest.id, { prefix, ok: true });
  return c.redirect(`/admin/plugins-manage/${id}/files?flash=approved`);
});

pluginsManageRoutes.post('/plugins-manage/:id/files/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const prefix = str((await c.req.formData()).get('prefix'));
  const existing = await getFilePrefixApproval(c.env.DB, resolved.manifest.id, prefix);
  if (existing) {
    await revokeFilePrefix(c.env.DB, resolved.manifest.id, prefix);
    logAudit(c, 'plugin.file_prefix.revoke', 'plugin', resolved.manifest.id, { prefix });
  }
  return c.redirect(`/admin/plugins-manage/${id}/files?flash=revoked`);
});

// ── Quota limits ───────────────────────────────────────────────────────────
// A plugin's manifest only *declares* which limits exist (PluginManifest.
// limits). Values are stored in settings. The host enforces page quotas on
// creates; plugins enforce operational limits. See utils/plugin-limits.ts.

function scopeKey(def: NormalizedLimitDef): string {
  if (def.scope === 'per_second') return 'view_strings.sections_plugin_limits.scope_per_second';
  if (def.scope === 'per_parent') return 'view_strings.sections_plugin_limits.scope_per_parent';
  if (def.scope === 'per_pointer') return 'view_strings.sections_plugin_limits.scope_per';
  return 'view_strings.sections_plugin_limits.scope_total';
}

function limitLabel(value: number | null): string {
  return value === null ? '' : String(value);
}

pluginsManageRoutes.get('/plugins-manage/:id/limits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginLimitsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      limits: [],
      saveAction: `/admin/plugins-manage/${id}/limits`,
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const allowed = await limitScopeTypes(c.env.DB, resolved.manifest);
  const defs = declaredLimits(resolved.manifest, allowed);
  const values = await loadLimitValues(c.env, resolved.manifest.id);

  const limits: PluginLimitRow[] = await Promise.all(defs.map(async (def) => {
    const configured = def.key in values;
    const effective = configured ? values[def.key] : def.defaultValue;
    // Scoped usage varies per parent/collection, so only totals are shown here.
    const usageLabel = def.scope === 'total' ? String(await countLimitUsage(c.env.DB, def, null)) : '';
    const usageKey = def.scope === 'per_second'
      ? 'view_strings.sections_plugin_limits.usage_not_counted'
      : def.scope === 'total'
        ? ''
        : 'view_strings.sections_plugin_limits.usage_varies_by_group';
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      pageType: def.pageType ?? '',
      pageTypeKey: def.pageType ? '' : 'view_strings.sections_plugin_limits.email_delivery',
      scopeLabel: '',
      scopeKey: scopeKey(def),
      scopeDetail: def.scope === 'per_pointer' ? def.pointerKey ?? '' : '',
      defaultLabel: limitLabel(def.defaultValue),
      defaultKey: def.defaultValue === null ? 'view_strings.sections_plugin_limits.unlimited' : '',
      effectiveLabel: limitLabel(effective),
      effectiveKey: effective === null ? 'view_strings.sections_plugin_limits.unlimited' : '',
      usesDefault: !configured,
      usageLabel,
      usageKey,
      value: configured && values[def.key] !== null ? String(values[def.key]) : '',
      unlimited: configured && values[def.key] === null,
    };
  }));

  return renderPage(c, pluginLimitsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    limits,
    saveAction: `/admin/plugins-manage/${id}/limits`,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/limits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const allowed = await limitScopeTypes(c.env.DB, resolved.manifest);
  const defs = declaredLimits(resolved.manifest, allowed);
  const form = await c.req.formData();

  // Only manifest-declared keys are saved; anything stale simply drops out.
  const values: PluginLimitValues = {};
  for (const def of defs) {
    if (form.get(`unlimited_${def.key}`) != null) {
      values[def.key] = null;
      continue;
    }
    const raw = str(form.get(`value_${def.key}`));
    if (!raw) continue; // unset — the manifest default (or unlimited) applies
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) values[def.key] = Math.trunc(parsed);
  }

  await saveLimitValues(c.env, resolved.manifest.id, values);
  logAudit(c, 'plugin.limits.update', 'plugin', resolved.manifest.id, values);
  return c.redirect(`/admin/plugins-manage/${id}/limits?flash=saved`);
});

// ── Credit costs ───────────────────────────────────────────────────────────
// A plugin's manifest only *declares* which chargeable actions exist
// (PluginManifest.credits). Prices configured here are stored in the settings
// table; the host deducts from the acting user's balance on each action and
// logs every change in credit_ledger. See utils/credits.ts.

function priceLabel(value: number): string {
  return value === 0 ? '' : String(value);
}

interface CreditPricingPayload {
  key: string;
  label: string;
  description: string;
  currency: string;
  currencyKey: string;
  chargeLabel: string;
  chargeKey: string;
  defaultValue: number;
  effectiveValue: number;
  configured: boolean;
}

pluginsManageRoutes.get('/plugins-manage/:id/credits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginCreditsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      credits: [],
      saveAction: `/admin/plugins-manage/${id}/credits`,
      flash: c.req.query('flash') ?? undefined,
    });
  }

  // Prices come from whoever meters them; with no such feature installed the
  // list is empty and the screen shows a plugin with nothing chargeable.
  const pricing = await callFeatureService<CreditPricingPayload[]>(
    'credits',
    'pricing',
    c.env,
    { contributorId: resolved.manifest.id },
  ) ?? [];
  const credits: PluginCreditRow[] = pricing.map((row) => ({
    key: row.key,
    label: row.label,
    description: row.description,
    currency: row.currency,
    currencyKey: row.currencyKey,
    chargeLabel: row.chargeLabel,
    chargeKey: row.chargeKey,
    chargeDetail: row.chargeLabel,
    defaultLabel: priceLabel(row.defaultValue),
    defaultKey: row.defaultValue === 0 ? 'view_strings.sections_plugin_credits.free' : '',
    effectiveLabel: priceLabel(row.effectiveValue),
    effectiveKey: row.effectiveValue === 0 ? 'view_strings.sections_plugin_credits.free' : '',
    usesDefault: !row.configured,
    value: row.configured ? String(row.effectiveValue) : '',
  }));

  return renderPage(c, pluginCreditsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    credits,
    saveAction: `/admin/plugins-manage/${id}/credits`,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/credits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  // Hand every submitted price to the metering feature keyed by credit key; it
  // owns which keys are real and what a blank means.
  const submitted: Record<string, string> = {};
  for (const [field, value] of form.entries()) {
    if (field.startsWith('value_')) submitted[field.slice('value_'.length)] = str(value);
  }

  const values = await callFeatureService<Record<string, number>>(
    'credits',
    'save-pricing',
    c.env,
    { contributorId: resolved.manifest.id, submitted },
  ) ?? {};
  logAudit(c, 'plugin.credits.update', 'plugin', resolved.manifest.id, values);
  return c.redirect(`/admin/plugins-manage/${id}/credits?flash=saved`);
});

// ── Page type access approvals ─────────────────────────────────────────────
// Manifest readTypes/writeTypes are delegated access requests. They are only
// honored by /__cms after an admin approves the specific plugin/type/access row.

function declaredPageTypeAccess(
  manifest: PluginManifest,
  pageType: string,
  access: PluginPageTypeAccess,
): boolean {
  const declared = access === 'read'
    ? manifest.contentTypes?.readTypes ?? []
    : manifest.contentTypes?.writeTypes ?? [];
  return declared.includes(pageType);
}

function pageTypeAccess(value: string): PluginPageTypeAccess | null {
  return value === 'read' || value === 'write' ? value : null;
}

pluginsManageRoutes.get('/plugins-manage/:id/page-types', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginPageTypesPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      definedPageTypes: [],
      definedTaxonomies: [],
      pageTypes: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const readTypes = new Set(resolved.manifest.contentTypes?.readTypes ?? []);
  const writeTypes = new Set(resolved.manifest.contentTypes?.writeTypes ?? []);
  const definedPageTypes = Object.entries(resolved.manifest.contentTypes?.blueprint ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, blueprint]) => ({
      slug,
      fieldCount: Array.isArray(blueprint) ? blueprint.length : 0,
      viewHref: `/admin/page_types/view/${encodeURIComponent(slug)}`,
    }));
  const definedTaxonomies = Object.entries(resolved.manifest.contentTypes?.taxonomies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, name]) => ({
      slug,
      name,
      viewHref: `/admin/taxonomies/view/${encodeURIComponent(slug)}`,
    }));
  const pageTypeNames = [...new Set([...readTypes, ...writeTypes])].sort();
  const approvals = await listPageTypeApprovals(c.env.DB, resolved.manifest.id);
  const approvalByKey = new Map(approvals.map((approval) => [`${approval.page_type}:${approval.access}`, approval]));

  const pageTypes = pageTypeNames.map((pageType) => {
    const readApproval = approvalByKey.get(`${pageType}:read`);
    const writeApproval = approvalByKey.get(`${pageType}:write`);
    return {
      pageType,
      pageTypeLabel: isPageTypeWildcard(pageType) ? 'All page types' : pageType,
      readDeclared: readTypes.has(pageType),
      writeDeclared: writeTypes.has(pageType),
      readApproved: !!readApproval,
      writeApproved: !!writeApproval,
      readApprovedBy: readApproval?.approved_by ?? '',
      writeApprovedBy: writeApproval?.approved_by ?? '',
      approveReadAction: `/admin/plugins-manage/${id}/page-types/approve`,
      revokeReadAction: `/admin/plugins-manage/${id}/page-types/revoke`,
      approveWriteAction: `/admin/plugins-manage/${id}/page-types/approve`,
      revokeWriteAction: `/admin/plugins-manage/${id}/page-types/revoke`,
    };
  });

  return renderPage(c, pluginPageTypesPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    definedPageTypes,
    definedTaxonomies,
    pageTypes,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/page-types/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const pageType = str(form.get('page_type'));
  const access = pageTypeAccess(str(form.get('access')));
  if (!access || !declaredPageTypeAccess(resolved.manifest, pageType, access)) {
    return c.text('Unknown page type access', 400);
  }

  await approvePageTypeAccess(c.env.DB, resolved.manifest.id, pageType, access, c.get('user').email);
  logAudit(c, 'plugin.page_type.approve', 'plugin', resolved.manifest.id, { page_type: pageType, access });
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=approved`);
});

pluginsManageRoutes.post('/plugins-manage/:id/page-types/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const pageType = str(form.get('page_type'));
  const access = pageTypeAccess(str(form.get('access')));
  if (!access) return c.text('Unknown page type access', 400);

  const existing = await getPageTypeApproval(c.env.DB, resolved.manifest.id, pageType, access);
  if (existing) {
    await revokePageTypeAccess(c.env.DB, resolved.manifest.id, pageType, access);
    logAudit(c, 'plugin.page_type.revoke', 'plugin', resolved.manifest.id, { page_type: pageType, access });
  }
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=revoked`);
});

/** After any registry mutation, drop the plugin-list, manifest, and merged-config caches. */
function invalidate(): void {
  clearManifestCache();
  clearConfigCache();
}
