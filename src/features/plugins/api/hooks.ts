// Lifecycle hooks and audit entries for plugin-originated writes. The actor
// is the calling plugin, not a signed-in user, so these never read c.get('user').

import type { AppContext } from '../../../core/http/context';
import { logAuditBatchVia, type AuditActor } from '../../../core/db/audit';
import { actingUserId } from './create';
import { deliverHooks, type HookEvent, type HookPage } from '../hooks';

// ── Lifecycle hook + audit (plugin actor, no signed-in user) ──────────────────

/**
 * Fires the lifecycle hook to subscribed plugins and records an audit row, both
 * best-effort via waitUntil. Mirrors dispatchHook but attributes the action to
 * the calling plugin instead of a CMS user. Writers that already committed
 * durable evidence suppress the legacy event and supply their verified service
 * actor for the separate hook delivery.
 */
export function emitPluginHook(c: AppContext, event: HookEvent, page: HookPage, pluginId: string): void {
  emitPluginHooks(c, event, [page], pluginId);
}

export function emitPluginHooks(c: AppContext, event: HookEvent, pages: HookPage[], pluginId: string, options: { evidenceCommitted?: boolean; actor?: AuditActor } = {}): void {
  if (!pages.length) return;

  const auditPromise = options.evidenceCommitted ? Promise.resolve() : logAuditBatchVia(c, pluginId, pages.map((page) => ({
    action: `page.${event}`,
    entityType: 'page',
    entityId: page.id,
    detail: { name: page.name, slug: page.slug, page_type: page.page_type },
  })));

  // deliverHooks tolerates a null user (passes user: null in the payload) and
  // chunks the pages so a bulk delete costs a fetch per hundred, not per page.
  const userId = actingUserId(c);
  const hookPromise = deliverHooks(c.env, undefined, event, pages, options.actor ?? { userId: userId === null ? null : String(userId), roles: null, sessionSid: null, via: pluginId });

  const combined = Promise.allSettled([auditPromise, hookPromise]);
  try {
    c.executionCtx.waitUntil(combined);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let it run detached.
    void combined;
  }
}
