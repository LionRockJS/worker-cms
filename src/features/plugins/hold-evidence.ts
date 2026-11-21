// Record holds a plugin places on its own pages (POST /__cms/holds): a
// retention period, e.g. a completed form kept 7 years. Each hold carries its
// last day (keep_until) and simply stops counting after it, so a plugin never
// has to release holds in bulk. A plugin only extends its own holds; a hold
// someone else placed is left alone. Admins still change or release any hold
// under Admin → Holds.

import type { AppContext } from '../../core/http/context';
import { serviceMutationAuditEvidence } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { ACTIVE_HOLD, CLOSE_EXPIRED_HOLD, KEEP_UNTIL } from '../../core/db/record-holds';
import { pageTypeScopeAllows } from './page-types';
import { capturePluginStoreAuthority, noteActingUser, unavailable } from './evidence-common';
import type { PluginAuth } from './api/types';

export const MAX_HOLDS = 100;

export interface HoldInput { page_id: number; keep_until: string; reason: string }
export type HoldOutcome = 'placed' | 'extended' | 'unchanged' | 'held_by_other' | 'not_found' | 'forbidden_page_type';

/** Parses `{ holds: [...] }`; null when the body is malformed. */
export function readHoldInputs(body: unknown): HoldInput[] | null {
  const items = body && typeof body === 'object' && Array.isArray((body as { holds?: unknown }).holds) ? (body as { holds: unknown[] }).holds : null;
  if (!items || !items.length || items.length > MAX_HOLDS) return null;
  const holds: HoldInput[] = [];
  for (const item of items) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const pageId = Number(entry.page_id);
    const keepUntil = typeof entry.keep_until === 'string' ? entry.keep_until.trim() : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!Number.isSafeInteger(pageId) || pageId <= 0 || !KEEP_UNTIL.test(keepUntil) || !reason || reason.length > 500) return null;
    holds.push({ page_id: pageId, keep_until: keepUntil, reason });
  }
  return new Set(holds.map((hold) => hold.page_id)).size === holds.length ? holds : null;
}

export async function placePluginHolds(c: AppContext, auth: PluginAuth, holds: HoldInput[]): Promise<Array<{ page_id: number; status: HoldOutcome; keep_until?: string }>> {
  assertRegulatedWritesAllowed(c.env);
  const authority = await capturePluginStoreAuthority(c, auth, 'record_holds', 'plugin.hold-authority-read');
  try {
    const { actor, policy, dataClass, pluginId } = authority;
    const ids = JSON.stringify(holds.map((hold) => hold.page_id));
    const pages = (await c.env.DB.prepare('SELECT id, uuid, page_type FROM pages WHERE id IN (SELECT value FROM json_each(?))').bind(ids)
      .all<{ id: number; uuid: string; page_type: string | null }>()).results;
    const uuids = JSON.stringify(pages.map((page) => page.uuid));
    const existing = (await c.env.DB.prepare(`SELECT id, page_uuid, placed_by_plugin, keep_until FROM record_holds WHERE page_uuid IN (SELECT value FROM json_each(?)) AND ${ACTIVE_HOLD}`).bind(uuids)
      .all<{ id: number; page_uuid: string; placed_by_plugin: string | null; keep_until: string | null }>()).results;
    await auditBackgroundReads(c.env, [
      { action: 'plugin.hold-source-read', kind: 'table', key: 'pages', targetType: 'page', ids: pages.map((page) => String(page.id)), count: pages.length, minimumClass: dataClass === 'none' ? undefined : dataClass },
      { action: 'plugin.hold-source-read', kind: 'table', key: 'record_holds', targetType: 'record_hold', ids: existing.map((hold) => String(hold.id)), count: existing.length, minimumClass: dataClass === 'none' ? undefined : dataClass },
    ], actor);
    if (await flushReadAudit(c)) throw new Error('Hold source evidence unavailable');

    const asserted = Number(c.req.header('x-acting-user-id'));
    const placedBy = Number.isSafeInteger(asserted) && asserted > 0 ? asserted : 0;
    const results: Array<{ page_id: number; status: HoldOutcome; keep_until?: string }> = [];
    const statements: D1PreparedStatement[] = [];
    for (const hold of holds) {
      const page = pages.find((entry) => entry.id === hold.page_id);
      if (!page) { results.push({ page_id: hold.page_id, status: 'not_found' }); continue; }
      if (!pageTypeScopeAllows(auth.allowedTypes, page.page_type ?? '')) { results.push({ page_id: hold.page_id, status: 'forbidden_page_type' }); continue; }
      const current = existing.find((entry) => entry.page_uuid === page.uuid);
      const detail: Record<string, unknown> = { plugin_id: pluginId, page_id: page.id, reason: hold.reason, keep_until: hold.keep_until, principal: 'credential_authenticated_plugin' };
      noteActingUser(c, detail);
      if (current && current.placed_by_plugin !== pluginId) { results.push({ page_id: hold.page_id, status: 'held_by_other', keep_until: current.keep_until ?? undefined }); continue; }
      if (current) {
        // Only ever lengthened: a shorter date would let an earlier, wider retention lapse.
        const keepUntil = current.keep_until && current.keep_until > hold.keep_until ? current.keep_until : hold.keep_until;
        if (keepUntil === current.keep_until) { results.push({ page_id: hold.page_id, status: 'unchanged', keep_until: keepUntil }); continue; }
        const receipt = serviceMutationAuditEvidence(c.env, { action: 'hold.extend', entityType: 'page', entityId: page.uuid, detail: { ...detail, hold_id: current.id, keep_until_before: current.keep_until, keep_until: keepUntil } }, actor, dataClass, policy, c);
        statements.push(
          c.env.DB.prepare(`UPDATE record_holds SET keep_until = ?, reason = ? WHERE id = ? AND placed_by_plugin = ? AND ${ACTIVE_HOLD}`).bind(keepUntil, hold.reason, current.id, pluginId),
          abortIf(c.env, 'changes()<>1'), receipt.write, receipt.guard);
        results.push({ page_id: hold.page_id, status: 'extended', keep_until: keepUntil });
        continue;
      }
      const receipt = serviceMutationAuditEvidence(c.env, { action: 'hold.place', entityType: 'page', entityId: page.uuid, detail }, actor, dataClass, policy, c);
      // An expired hold still holds the page's one unreleased slot: close it first.
      statements.push(
        c.env.DB.prepare(CLOSE_EXPIRED_HOLD).bind(page.uuid),
        abortIf(c.env, `EXISTS(SELECT 1 FROM record_holds WHERE page_uuid = ? AND ${ACTIVE_HOLD})`, [page.uuid]),
        c.env.DB.prepare('INSERT INTO record_holds (page_uuid, reason, placed_by, placed_by_plugin, keep_until) VALUES (?, ?, ?, ?, ?)').bind(page.uuid, hold.reason, placedBy, pluginId, hold.keep_until),
        abortIf(c.env, 'changes()<>1'), receipt.write, receipt.guard);
      results.push({ page_id: hold.page_id, status: 'placed', keep_until: hold.keep_until });
    }
    if (statements.length) await c.env.DB.batch([...authority.check(), ...statements, ...authority.check()]);
    return results;
  } catch { return unavailable(c, authority?.actor); }
}
