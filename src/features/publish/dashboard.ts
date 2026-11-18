import { requestPageFilter } from '../../core/auth/page-access';
import type { Page } from '../../types';
import type { AppContext } from '../../core/http/context';
import type { DashboardPageRow, DashboardPublicationQuery } from '../publication';
import { listDashboardDraftPagesByUuids, listDashboardDraftPageUuids } from '../../core/db/admin-queries';
import { publicationStatusForPage, withLiveStatus } from './status';
import { recordTagReads } from '../../core/http/access-log';
import { readD1PageSource } from './d1';
import { auditLiveReads } from './read-audit';
import { draftLectProjector } from './projection';

type DashboardPublishedPageTagRow = { page_id: number; tag_id: number };
type DashboardTagNameRow = { id: number; name: string; taxonomy_slug: string | null };

export async function dashboardPublishedTags(c: AppContext, ids: number[]) {
  if (!c.env.PUBLISHED_DB || !ids.length) return [];
  const publishedTagRows = await c.env.PUBLISHED_DB.prepare(
    `SELECT page_id, tag_id FROM page_tags
     WHERE page_id IN (${ids.map(() => '?').join(',')})
     ORDER BY page_id ASC, weight ASC, id ASC`,
  ).bind(...ids).all<DashboardPublishedPageTagRow>();
  const publishedTagIds = Array.from(new Set(publishedTagRows.results.map((row) => row.tag_id)));
  if (!publishedTagIds.length) return [];
  const tagNames = await c.env.DB.prepare(
    `SELECT id, name, taxonomy_slug FROM tags WHERE id IN (${publishedTagIds.map(() => '?').join(',')})`,
  )
    .bind(...publishedTagIds)
    .all<DashboardTagNameRow>();
  recordTagReads('tag.dashboard-label', tagNames.results);
  const tagNamesById = new Map(tagNames.results.map((tag) => [tag.id, tag.name]));
  return publishedTagRows.results.flatMap((row) => {
    const name = tagNamesById.get(row.tag_id);
    return name ? [{ pageId: row.page_id, name }] : [];
  });
}

function dashboardPaginationResult<T>(items: T[], requestedPage: number, limit: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * limit;
  return {
    results: items.slice(offset, offset + limit),
    pagination: {
      total,
      totalPages,
      currentPage,
      limit,
    },
  };
}

async function liveDashboardUuids(c: AppContext): Promise<Set<string>> {
  if (!c.env.PUBLISHED_DB) return new Set<string>();
  const source = await readD1PageSource<{ uuid: string; page_type: string | null }>(c.env.PUBLISHED_DB, 'identity', '1', []);
  await auditLiveReads(c.env, { id: 'd1' }, source.provenance, undefined, 'page.live-status');
  return new Set(source.rows.map((page) => page.uuid));
}

async function liveDashboardPagesForRequest(c: AppContext, options: DashboardPublicationQuery) {
  const { pageType, requestedPage, pageSize, statusFilter, now } = options;
  const publishedDb = c.env.PUBLISHED_DB;
  if (!publishedDb) return dashboardPaginationResult<DashboardPageRow & { isPublished: boolean }>([], requestedPage, pageSize);
  const whereSql = pageType ? 'p.page_type = ?' : '1';
  const baseParams = pageType ? [pageType] : [];
  // Filter on schedule columns only; lect and the rest are loaded below for
  // just the rows on this page, not for every published page.
  const source = await readD1PageSource<{ uuid: string; page_type: string | null; start: string | null; end: string | null; timezone: string | null }>(
    publishedDb, 'schedule', whereSql, baseParams, 'ORDER BY p.weight ASC, p.name ASC, p.id ASC',
  );
  await auditLiveReads(c.env, { id: 'd1' }, source.provenance, undefined, 'page.live-status');
  const access = await requestPageFilter(c, 'read', 'live.value');
  const visible = new Set((await c.env.DB.prepare(`SELECT value FROM json_each(?) live WHERE ${access.sql}`)
    .bind(JSON.stringify(source.rows.map(page => page.uuid)), ...access.args).all<{ value: string }>()).results.map(row => row.value));
  const matchingRows = source.rows.filter(page => visible.has(page.uuid) &&
    publicationStatusForPage(page, true, now) === statusFilter);
  const paginatedUuids = dashboardPaginationResult(matchingRows.map((page) => page.uuid), requestedPage, pageSize);
  const pageUuids = paginatedUuids.results;
  const liveRows = pageUuids.length
    ? (await readD1PageSource<Page>(publishedDb, 'full', 'p.uuid IN (SELECT value FROM json_each(?))', [JSON.stringify(pageUuids)])).rows
    : [];
  const liveMap = new Map(liveRows.map((page) => [page.uuid, page]));
  const paginated = {
    results: pageUuids.map((uuid) => liveMap.get(uuid)).filter((page): page is Page => !!page),
    pagination: paginatedUuids.pagination,
  };
  const draftRows = await listDashboardDraftPagesByUuids(
    c.env.DB,
    paginated.results.map((page) => page.uuid),
    { pageType, access: await requestPageFilter(c, 'read', 'p.uuid') },
  );
  const draftMap = new Map(draftRows.map((page) => [page.uuid, page]));
  const results: DashboardPageRow[] = paginated.results.map((page) => {
    const draft = draftMap.get(page.uuid);
    return draft ?? { ...page, isDraftMissing: true };
  });
  const projectDraft = await draftLectProjector(c.env);

  return {
    results: withLiveStatus(results, liveMap, projectDraft, now),
    pagination: paginated.pagination,
  };
}

async function draftDashboardPagesForRequest(
  c: AppContext,
  options: { pageType?: string; requestedPage: number; pageSize: number },
) {
  const { pageType, requestedPage, pageSize } = options;
  const access = await requestPageFilter(c, 'read', 'p.uuid');
  const [draftUuids, liveUuids] = await Promise.all([
    listDashboardDraftPageUuids(c.env.DB, { pageType, access }),
    liveDashboardUuids(c),
  ]);
  const draftOnlyUuids = draftUuids.filter((uuid) => !liveUuids.has(uuid));
  const paginated = dashboardPaginationResult(draftOnlyUuids, requestedPage, pageSize);
  const draftRows = await listDashboardDraftPagesByUuids(c.env.DB, paginated.results, { access });
  const draftMap = new Map(draftRows.map((page) => [page.uuid, page]));
  const results = paginated.results
    .map((uuid) => draftMap.get(uuid))
    .filter((page): page is Page => !!page);

  return {
    results: withLiveStatus(results, new Map()),
    pagination: paginated.pagination,
  };
}

export function filteredDashboardPages(c: AppContext, options: DashboardPublicationQuery) {
  const { statusFilter, ...query } = options;
  return statusFilter === 'draft'
    ? draftDashboardPagesForRequest(c, query)
    : liveDashboardPagesForRequest(c, { ...query, statusFilter });
}
