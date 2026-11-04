import { recordPageReads } from '../../core/http/access-log';
import { countPageMetadata } from '../../core/db/count-metadata';
import { countTrashMetadataByType } from './queries';
// Trash listing, restore-to-draft, and permanent delete.

import { Hono } from 'hono';
import { holdsPage, trashPage, type HoldRow } from './template';
import type { Env, Variables, Page } from '../../types';
import type { AppContext } from '../../core/http/context';
import { mutatePageLifecycle, RecordHeldError } from '../../core/pages/lifecycle-mutation-evidence';
import { captureAccessAuthorization } from '../../core/auth/access-authorization';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';
import { mutationAuditEvidence } from '../../core/db/audit';
import { dashboardPagination, renderPage } from '../../core/render/chrome';
import { userCan } from '../../core/auth/permissions';
import { dashboardPageNumber, dashboardPageSize } from '../../core/http/forms';
import { requireAnyPermission, requirePermission } from '../../core/auth/guards';

export const trashRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Trash list ────────────────────────────────────────────────────────────────

trashRoutes.get('/trash', requireAnyPermission('content:read', 'trash:restore', 'trash:purge'), async (c) => {
  const flash = c.req.query('flash') ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));
  // Active type filter (the dropdown). Empty = all types.
  const filterType = c.req.query('type')?.trim() || '';
  const typeWhere = filterType ? 'WHERE page_type = ?' : '';
  const typeParams = filterType ? [filterType] : [];

  const countOptions = { source: 'trash_pages' as const, types: filterType ? [filterType] : undefined };
  const [total, typeRows, recentCount] = await Promise.all([
    // Listing total/recent are scoped to the filter; the type breakdown is not,
    // so the dropdown always lists every type with its full count.
    countPageMetadata(c.env.DB, filterType ? 'p.page_type = ?' : '1', typeParams, countOptions),
    countTrashMetadataByType(c.env.DB),
    countPageMetadata(c.env.DB, `p.created_at >= datetime('now', '-1 hour') ${filterType ? 'AND p.page_type = ?' : ''}`,
      typeParams, { ...countOptions, action: 'page.trash-recent-count' }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const trashedPages = await c.env.DB.prepare(
    `SELECT * FROM trash_pages ${typeWhere} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(...typeParams, pageSize, offset).all<Page>();

  recordPageReads('page.trash-list', trashedPages.results);
  const held = new Set((await c.env.DB.prepare(
    'SELECT page_uuid FROM record_holds WHERE released_at IS NULL AND page_uuid IN (SELECT value FROM json_each(?))',
  ).bind(JSON.stringify(trashedPages.results.map((page) => page.uuid))).all<{ page_uuid: string }>()).results.map((row) => row.page_uuid));

  const paginationResult = {
    results: trashedPages.results,
    pagination: { total, totalPages, currentPage, limit: pageSize },
  };
  const pagination = dashboardPagination('/admin/trash', paginationResult);
  // Carry the active type filter across page links.
  if (filterType) {
    const suffix = `&type=${encodeURIComponent(filterType)}`;
    for (const key of ['firstHref', 'previousHref', 'nextHref', 'lastHref'] as const) {
      if (pagination[key]) pagination[key] += suffix;
    }
  }

  const typeCounts = typeRows.map((r) => ({ pageType: r.page_type ?? 'unknown', count: r.cnt }));
  const grandTotal = typeCounts.reduce((sum, t) => sum + t.count, 0);

  return renderPage(c, trashPage, {
    pages: trashedPages.results,
    flash: flash || undefined,
    pagination,
    total,
    grandTotal,
    filterType,
    typeCounts,
    recentCount,
    canPurgeTrash: await userCan(c, 'trash:purge'),
    canHold: await userCan(c, 'records:hold'),
    held,
    retentionDays: trashRetentionDays(c.env),
  });
});

// ── Restore page from trash → draft ──────────────────────────────────────────

trashRoutes.post('/trash/:id/restore', requirePermission('trash:restore'), async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);

  const result=await mutatePageLifecycle(c.env,c.get('user'),'restore',{ids:[trashId]},{request:c});
  if(!result.count)return c.notFound();

  return c.redirect('/admin/trash?flash=Page+restored+to+draft');
});

// ── Bulk restore (all, by type, or last-hour only) ───────────────────────────
// Accepts optional form fields:
//   type   — page type to restore (empty = all types)
//   action — "now" (default) restore all matching; "1h" restore only those
//            trashed within the last hour
// Set-based so a large trash (e.g. an event's worth of guests) restores without
// the per-page route's per-row work timing out.

trashRoutes.post('/trash/restore', requirePermission('trash:restore'), async (c) => {
  const form = await c.req.formData();
  const pageType = (form.get('type') as string | null)?.trim() || null;
  const withinLastHour = (form.get('action') as string | null)?.trim() === '1h';

  const {count}=await mutatePageLifecycle(c.env,c.get('user'),'restore',{pageType,withinLastHour},{request:c});

  const noun = count === 1 ? 'page' : 'pages';
  const scope = withinLastHour ? ' from the last hour' : '';
  return c.redirect(`/admin/trash?flash=${encodeURIComponent(`Restored ${count} ${noun}${scope} to drafts`)}`);
});

// ── Permanently delete from trash ─────────────────────────────────────────────

trashRoutes.post('/trash/:id/delete', requirePermission('trash:purge'), async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  try {
    await mutatePageLifecycle(c.env,c.get('user'),'purge',{ids:[trashId]},{request:c});
  } catch (error) {
    if (error instanceof RecordHeldError) return c.redirect('/admin/trash?flash=Page+is+under+hold+and+was+not+deleted');
    throw error;
  }
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});

// ── Empty trash (all, by type, last-hour only, or past retention) ────────────
// Accepts optional form fields:
//   type   — page type to purge (empty = all types)
//   action — "now" (default) purge all matching; "1h" purge only those trashed
//            within the last hour; "expired" purge only those in trash longer
//            than TRASH_RETENTION_DAYS
// Held pages, and any parent whose purge would cascade to one, are left alone.

trashRoutes.post('/trash/empty', requirePermission('trash:purge'), async (c) => {
  const form = await c.req.formData();
  const pageType = (form.get('type') as string | null)?.trim() || null;
  const action = (form.get('action') as string | null)?.trim();
  const withinLastHour = action === '1h';
  const olderThanDays = action === 'expired' ? trashRetentionDays(c.env) : undefined;
  if (olderThanDays === null) return c.redirect('/admin/trash?flash=No+trash+retention+period+is+set');

  const {count}=await mutatePageLifecycle(c.env,c.get('user'),'purge',{pageType,withinLastHour,olderThanDays},{request:c});

  if (olderThanDays !== undefined) return c.redirect(`/admin/trash?flash=${encodeURIComponent(`Purged ${count} expired ${count === 1 ? 'page' : 'pages'}`)}`);
  const label = pageType ? `${pageType}+pages` : 'Trash';
  const flash = withinLastHour ? `${label}+from+last+hour+emptied` : `${label}+emptied`;
  return c.redirect(`/admin/trash?flash=${flash}`);
});

// ── Holds ─────────────────────────────────────────────────────────────────────
// A hold blocks permanent deletion of one page, in trash or not, until it is
// released. Placing and releasing are separate from trash:purge so the people
// who can purge are not the people who decide what must be kept.

trashRoutes.get('/holds', requirePermission('records:hold'), async (c) => {
  const holds = await c.env.DB.prepare(
    `SELECT id, page_uuid, reason, placed_by, placed_at, released_by, released_at FROM record_holds
     ORDER BY released_at IS NOT NULL, id DESC LIMIT 200`,
  ).all<HoldRow>();
  return renderPage(c, holdsPage, { holds: holds.results, flash: c.req.query('flash') || undefined });
});

trashRoutes.post('/holds', requirePermission('records:hold'), async (c) => {
  const form = await c.req.formData();
  // Page uuids are minted by the CMS or copied from a submission's source row,
  // so accept any plain identifier rather than only the CMS's own format.
  const uuid = String(form.get('uuid') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const back = form.get('back') === 'trash' ? '/admin/trash' : '/admin/holds';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(uuid) || !reason || reason.length > 500) return c.redirect(`${back}?flash=A+page+UUID+and+a+reason+are+required`);
  if (await c.env.DB.prepare('SELECT 1 FROM record_holds WHERE page_uuid = ? AND released_at IS NULL').bind(uuid).first()) {
    return c.redirect(`${back}?flash=That+page+is+already+held`);
  }
  await changeHold(c, 'hold.place', uuid, { reason },
    c.env.DB.prepare('INSERT INTO record_holds (page_uuid, reason, placed_by) VALUES (?, ?, ?)').bind(uuid, reason, Number(c.get('user').sub)));
  return c.redirect(`${back}?flash=Hold+placed`);
});

trashRoutes.post('/holds/:id/release', requirePermission('records:hold'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const hold = await c.env.DB.prepare('SELECT page_uuid FROM record_holds WHERE id = ? AND released_at IS NULL').bind(id).first<{ page_uuid: string }>();
  if (!hold) return c.notFound();
  await changeHold(c, 'hold.release', hold.page_uuid, { hold_id: id },
    c.env.DB.prepare('UPDATE record_holds SET released_by = ?, released_at = CURRENT_TIMESTAMP WHERE id = ? AND released_at IS NULL')
      .bind(Number(c.get('user').sub), id));
  return c.redirect('/admin/holds?flash=Hold+released');
});

/** Applies one hold change with its audit receipt in the same batch; a change
 *  that matches no row (a concurrent place or release) rolls the batch back. */
async function changeHold(c: AppContext, action: string, uuid: string, detail: Record<string, unknown>, change: D1PreparedStatement): Promise<void> {
  const authority = await captureAccessAuthorization(c.env, c.get('user'), 'records:hold');
  if (!authority.allowed) throw new Error('Hold authority unavailable');
  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) throw new Error('Hold classification unavailable');
  const receipt = mutationAuditEvidence(c, { action, entityType: 'page', entityId: uuid, detail },
    classFor(policy, 'table', 'record_holds') ?? 'none', { policy, requirePreviousChange: true });
  await c.env.DB.batch([authority.guard(), change, receipt.write, receipt.guard]);
}

/** TRASH_RETENTION_DAYS as a whole number of days, or null when unset or invalid. */
function trashRetentionDays(env: Env): number | null {
  const days = Number(env.TRASH_RETENTION_DAYS);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}
