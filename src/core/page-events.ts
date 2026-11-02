// Page lifecycle announcements.
//
// Every create/update/publish/unpublish/delete an admin handler performs flows
// through here: it is the choke point for the audit trail, and the one place
// that tells whoever is listening (today, the plugin platform's hook delivery)
// that a page changed. Handlers used to call the platform's dispatchHook()
// directly, which put src/routes on the plugin feature's import graph and made
// the platform impossible to drop.

import { logAudit } from './db/audit';
import { coreExtensions, type PageEvent, type PageEventPage } from './extensions';
import type { AppContext } from './http/context';

export type { PageEvent, PageEventPage };

/**
 * Fire-and-forget announcement. Safe to call from any admin handler: it never
 * throws and never blocks the response. Listeners are optional — with none
 * registered this writes the audit row unless the caller already committed
 * durableEvidence with its mutation.
 */
export function announcePageEvent(c: AppContext, event: PageEvent, page: PageEventPage, options: { durableEvidence?: boolean } = {}): void {
  if (!options.durableEvidence) logAudit(c, `page.${event}`, 'page', page.id, {
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  const notify = coreExtensions().notifyPageEvent;
  if (!notify) return;

  const promise = notify(c.env, c.get('user'), event, [page]).catch((error) => {
    console.error(`page.${event} listener failed:`, error);
  });
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let the promise run detached.
    void promise;
  }
}
