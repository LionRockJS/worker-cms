import type { PageAccessFilter } from '../auth/page-access';
// Centralized D1 access helpers used across the admin routes.
// SQL stays raw here — this module just removes the duplication of issuing it.

import type { Page, Tag, Taxonomy } from '../../types';
import { recordPageReads, recordTableReads } from '../http/access-log';
import { num } from '../http/forms';
import { countPageMetadata } from './count-metadata';

export interface DashboardListResult {
  results: Page[];
  pagination: {
    total: number;
    totalPages: number;
    currentPage: number;
    limit: number;
  };
}

/** Avatar URL for the signed-in user — replaces the avatar lookup duplicated across handlers. */
export async function fetchUserAvatar(db: D1DatabaseClient, userId: number): Promise<string | null> {
  const row = await db.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(userId)
    .first<{ avatar_url: string | null }>();
  return row?.avatar_url ?? null;
}

/** Display name for a user id (e.g. the page's `_modifier`); null when missing or unknown. */
export async function fetchUserName(db: D1DatabaseClient, userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const row = await db.prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  if (!row) return null;
  recordTableReads('user.display', 'users', [userId]);
  return row.name?.trim() || row.email || null;
}

/**
 * Resolves a page's comma-separated `editors` id string to display chips for
 * the editors combobox. Ids without a matching user keep the raw id as their
 * label so they remain visible and removable.
 */
export async function fetchEditorUsers(
  db: D1DatabaseClient,
  editors: string | null | undefined,
): Promise<Array<{ id: number; name: string }>> {
  const ids = Array.from(new Set(
    (editors ?? '')
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0),
  ));
  if (!ids.length) return [];

  const rows = await db.prepare(
    `SELECT id, name, email FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: number; name: string | null; email: string | null }>();
  recordTableReads('user.display', 'users', rows.results.map(row => row.id));
  const names = new Map(rows.results.map((row) => [row.id, row.name?.trim() || row.email || '']));
  return ids.map((id) => ({ id, name: names.get(id) || `#${id}` }));
}

/**
 * Returns a draft-page slug guaranteed not to collide with another draft page,
 * appending `-2`, `-3`, … to the desired slug until it is free. Pass the page's
 * own id as `excludeId` on update so it doesn't collide with itself.
 */
export async function ensureUniqueDraftSlug(
  db: D1DatabaseClient,
  slug: string,
  excludeId?: number,
): Promise<string> {
  let candidate = slug;
  let suffix = 2;
  while (
    await db
      .prepare('SELECT 1 FROM pages WHERE slug = ? AND (? IS NULL OR id != ?) LIMIT 1')
      .bind(candidate, excludeId ?? null, excludeId ?? null)
      .first()
  ) {
    candidate = `${slug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function parentPageOption(db: D1DatabaseClient, pageId: string | number | null | undefined): Promise<Page[]> {
  const id = num(pageId, 0);
  if (!id) return [];
  const page = await db.prepare('SELECT id, name, slug, page_type FROM pages WHERE id = ?')
    .bind(id)
    .first<Page>();
  if (page) recordPageReads('page.parent-option', [page]);
  return page ? [page] : [];
}

/**
 * Resolves a submitted parent-page id to one that actually exists, or null.
 *
 * DB.pages.page_id carries no foreign key (it mirrors PUBLISHED_DB.pages), so
 * the database no longer rejects a parent that was deleted between rendering the
 * form and submitting it, or one supplied by a hand-made POST. Storing a
 * dangling id is harmless to read but makes the page look parented in data
 * while showing no parent in the UI, so resolve it at the point of write.
 */
export async function resolveParentPageId(
  db: D1DatabaseClient,
  pageId: string | number | null | undefined,
): Promise<number | null> {
  const id = num(pageId, 0);
  if (!id) return null;
  const parent = await db.prepare('SELECT id FROM pages WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();
  return parent?.id ?? null;
}

export async function editorTaxonomy(db: D1DatabaseClient): Promise<{ tags: Tag[]; taxonomies: Taxonomy[] }> {
  const [tags, taxonomies] = await Promise.all([
    db.prepare('SELECT * FROM tags ORDER BY weight ASC, name ASC').all<Tag>(),
    db.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
  ]);
  return {
    tags: tags.results,
    taxonomies: taxonomies.results,
  };
}

export async function savePageVersion(
  db: D1DatabaseClient,
  pageId: number,
  lect: string | null,
  action: string | null,
): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO page_versions (page_id, lect, action) VALUES (?, ?, ?)`,
  )
    .bind(pageId, lect, action)
    .run();
  const row = await db.prepare('SELECT id FROM page_versions WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  return row!.id;
}

export async function listDashboardDraftPages(
  db: D1DatabaseClient,
  options: { pageType?: string; page: number; limit: number; access?: PageAccessFilter },
): Promise<DashboardListResult> {
  const whereSql = `WHERE ${options.pageType ? 'page_type = ? AND ' : ''}${options.access?.sql ?? '1'}`;
  const baseParams = [...(options.pageType ? [options.pageType] : []), ...(options.access?.args ?? [])];
  const total = await countPageMetadata(db, whereSql.replace(/^WHERE\s+/, ''), baseParams, { types: options.pageType ? [options.pageType] : undefined });
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  const currentPage = Math.min(options.page, totalPages);
  const currentOffset = (currentPage - 1) * options.limit;

  const pages = await db.prepare(
    `SELECT p.* FROM pages p ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, options.limit, currentOffset)
    .all<Page>();

  return {
    results: pages.results,
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: options.limit,
    },
  };
}

export async function listDashboardDraftPageUuids(
  db: D1DatabaseClient,
  options: { pageType?: string; access?: PageAccessFilter } = {},
): Promise<string[]> {
  const whereSql = `WHERE ${options.pageType ? 'page_type = ? AND ' : ''}${options.access?.sql ?? '1'}`;
  const params = [...(options.pageType ? [options.pageType] : []), ...(options.access?.args ?? [])];
  const pages = await db.prepare(
    `SELECT uuid FROM pages p ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC`,
  )
    .bind(...params)
    .all<{ uuid: string }>();
  return pages.results.map((page) => page.uuid);
}

export async function listDashboardDraftPagesByUuids(
  db: D1DatabaseClient,
  uuids: string[],
  options: { pageType?: string; access?: PageAccessFilter } = {},
): Promise<Page[]> {
  if (!uuids.length) return [];
  const placeholders = uuids.map(() => '?').join(',');
  const pageTypeSql = options.pageType ? ' AND page_type = ?' : '';
  const params = [...uuids, ...(options.pageType ? [options.pageType] : []), ...(options.access?.args ?? [])];
  const pages = await db.prepare(
    `SELECT p.* FROM pages p
     WHERE uuid IN (${placeholders})${pageTypeSql} AND ${options.access?.sql ?? '1'}`,
  )
    .bind(...params)
    .all<Page>();
  return pages.results;
}
