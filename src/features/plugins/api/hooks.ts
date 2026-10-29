// Lifecycle hooks and audit entries for plugin-originated writes. The actor
// is the calling plugin, not a signed-in user, so these never read c.get('user').

import type { AppContext } from '../../../core/http/context';
import { logAuditBatchVia } from '../../../core/db/audit';
import { deliverHooks, type HookEvent, type HookPage } from '../hooks';

// ── Lifecycle hook + audit (plugin actor, no signed-in user) ──────────────────

/**
 * Fires the lifecycle hook to subscribed plugins and records an audit row, both
 * best-effort via waitUntil. Mirrors dispatchHook but attributes the action to
 * the calling plugin instead of a CMS user, which the audit envelope carries as
 * a null actor plus the plugin id in acting_via.
 */
export function emitPluginHook(c: AppContext, event: HookEvent, page: HookPage, pluginId: string): void {
  emitPluginHooks(c, event, [page], pluginId);
}

export function emitPluginHooks(c: AppContext, event: HookEvent, pages: HookPage[], pluginId: string): void {
  if (!pages.length) return;

  const auditPromise = logAuditBatchVia(c, pluginId, pages.map((page) => ({
    action: `page.${event}`,
    entityType: 'page',
    entityId: page.id,
    detail: { name: page.name, slug: page.slug, page_type: page.page_type },
  })));

  // deliverHooks tolerates a null user (passes user: null in the payload) and
  // chunks the pages so a bulk delete costs a fetch per hundred, not per page.
  const hookPromise = deliverHooks(c.env, undefined, event, pages);

  const combined = Promise.allSettled([auditPromise, hookPromise]);
  try {
    c.executionCtx.waitUntil(combined);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let it run detached.
    void combined;
  }
}
