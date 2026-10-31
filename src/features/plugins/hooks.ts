// ============================================================
// Lifecycle hook dispatch — fans a CMS event out to every plugin
// that subscribed to it in its manifest.
//
// Hooks are best-effort: delivered via executionCtx.waitUntil so
// they never block the editor response, and failures are logged
// rather than surfaced to the user.
// ============================================================

import type { AppContext } from '../../core/http/context';
import type { Env, JWTPayload } from '../../types';
import type { PluginHookEvent } from './types';
import { pluginsForHook, pluginById, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { pluginTenantId } from './proxy';
import { auditHookDelivery } from './hook-audit';
import type { AuditActor } from '../../core/db/audit';
import { logAudit } from '../../core/db/audit';

/** A minimal page snapshot delivered to plugins. Plugins receive whatever the
 *  triggering handler has on hand — `id` is always present. */
export interface HookPage {
  id: number;
  uuid?: string;
  page_type?: string | null;
  name?: string;
  slug?: string;
}

/** Lifecycle events the CMS emits. */
export type HookEvent = PluginHookEvent;

/**
 * Fire-and-forget hook dispatch. Safe to call from any admin handler; it never
 * throws and never blocks the response.
 */
export function dispatchHook(c: AppContext, event: HookEvent, page: HookPage): void {
  // Every page lifecycle event flows through here — the natural choke point
  // for the audit trail.
  logAudit(c, `page.${event}`, 'page', page.id, {
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  const promise = deliverHook(c.env, c.get('user'), event, page).catch(error => console.error('hook delivery withheld or failed', error));
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let the promise run detached.
    void promise.catch(() => {});
  }
}

/**
 * Awaitable core: POSTs the event to each subscribed plugin. Exported so tests
 * can await delivery deterministically.
 */
export async function deliverHook(
  env: Env,
  user: JWTPayload | undefined,
  event: HookEvent,
  page: HookPage,
): Promise<void> {
  await deliverHooks(env, user, event, [page]);
}

/** Pages per bulk hook POST — bounds the payload size per delivery. */
const HOOK_BATCH_SIZE = 100;

/**
 * Bulk delivery: one POST per subscribed plugin per HOOK_BATCH_SIZE pages,
 * instead of one fetch per page — a thousand-guest bulk delete used to fan out
 * a thousand subrequests (and their CPU) from a single invocation. The payload
 * carries the chunk in `pages`; `page` stays set to the first entry so handlers
 * written for single-page payloads keep working.
 */
export async function deliverHooks(
  env: Env,
  user: JWTPayload | undefined,
  event: HookEvent,
  pages: HookPage[],
  initiatingActor?: AuditActor,
): Promise<void> {
  if (!pages.length) return;
  const plugins = await pluginsForHook(env, event);
  if (plugins.length === 0) return;

  const actor: AuditActor = initiatingActor ?? { userId: user?.sub ?? null, roles: user?.role ?? null, sessionSid: user?.sid ?? null, via: user ? null : 'system:background' };
  const userPayload = user
    ? { id: user.sub, email: user.email, name: user.name, role: user.role }
    : null;
  const tenantId = pluginTenantId(env);

  for (let start = 0; start < pages.length; start += HOOK_BATCH_SIZE) {
    const chunk = pages.slice(start, start + HOOK_BATCH_SIZE);
    const body = JSON.stringify({ event, page: chunk[0], pages: chunk, user: userPayload });

    for (const candidate of plugins) {
      // Re-read host-owned enablement/secret immediately before each chunk.
      const plugin = await pluginById(env, candidate.manifest.id);
      if (!plugin || !plugin.secret || !(plugin.manifest.hooks ?? []).includes(event)) continue;
      await auditHookDelivery(env, plugin, user, event, chunk, actor);
      try {
        const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/hooks/${event}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-plugin-secret': plugin.secret,
            ...(tenantId ? { 'x-cms-tenant': tenantId } : {}) }, body,
        });
        if (!response.ok) console.error(`Plugin hook ${event} returned ${response.status}`);
        await response.body?.cancel();
      } catch (error) { console.error(`Plugin hook ${event} failed:`, error); }
    }
  }
}
