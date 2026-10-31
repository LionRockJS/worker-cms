// Centralized D1 access helpers used across the admin routes.
// SQL stays raw here — this module just removes the duplication of issuing it.

import type { Page, PageVersion, PageTag, Tag, Taxonomy } from '../../types';
import { recordPageReads, recordTableReads } from '../http/access-log';
import { num, slugify } from '../http/forms';
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

async function uniqueTagSlug(db: D1DatabaseClient, baseSlug: string): Promise<string> {
  let slug = baseSlug || 'tag';
  let suffix = 1;
  while (await db.prepare('SELECT id FROM tags WHERE slug = ?').bind(slug).first<{ id: number }>()) {
    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }
  return slug;
}

/** Finds or creates a tag by (taxonomy, name) — used by the /__cms tag-ensure endpoint. */
export async function ensureTagByName(db: D1DatabaseClient, taxonomy: Taxonomy, name: string): Promise<number> {
  const existing = await db.prepare('SELECT id FROM tags WHERE taxonomy_slug = ? AND name = ?')
    .bind(taxonomy.slug, name)
    .first<{ id: number }>();
  if (existing) return existing.id;

  const slug = await uniqueTagSlug(db, slugify(`${taxonomy.slug || taxonomy.name}-${name}`));
  const insert = await db.prepare('INSERT INTO tags (name, slug, taxonomy_slug) VALUES (?, ?, ?)')
    .bind(name, slug, taxonomy.slug)
    .run();
  const tag = await db.prepare('SELECT id FROM tags WHERE rowid = ?')
    .bind(insert.meta.last_row_id)
    .first<{ id: number }>();
  return tag!.id;
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

/**
 * Soft-deletes a draft page: copies the page, its version history, and its tag
 * links into the trash tables (preserving ids so a restore keeps identity),
 * then removes it from `pages`. Returns the page that was trashed, or
 * null when no such page exists. Callers remain responsible for unpublishing
 * and firing the `delete` lifecycle hook — this is the DB-copy half only, shared
 * by the admin delete handler and the plugin write-back API so the trash schema
 * lives in exactly one place.
 */
export type SubmissionPageRef = Page & { submission_origin: number };

export async function trashDraftPage(db: D1DatabaseClient, pageId: number): Promise<SubmissionPageRef | null> {
  const page = await db.prepare(
    `SELECT dp.*,
       EXISTS(SELECT 1 FROM page_versions pv
              WHERE pv.page_id = dp.id AND pv.action IN ('ingest-submission', 'pull-published')) AS submission_origin
     FROM pages dp WHERE dp.id = ?`,
  ).bind(pageId).first<SubmissionPageRef>();
  if (!page) return null;

  // trash_pages.page_id only accepts a parent that is itself in trash. A child
  // can be deleted while its parent remains live, so retain its original parent
  // separately and leave the trash relation empty in that case.
  const trashParent = page.page_id == null
    ? null
    : await db.prepare('SELECT id FROM trash_pages WHERE id = ?').bind(page.page_id).first<{ id: number }>();
  const trashParentId = trashParent?.id ?? null;

  await db.prepare(
    `INSERT INTO trash_pages (id, uuid, name, slug, weight, start, end, timezone, page_type, lect, page_id, source_page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       timezone = excluded.timezone,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       source_page_id = excluded.source_page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      page.id,
      page.uuid,
      page.name,
      page.slug,
      page.weight,
      page.start,
      page.end,
      page.timezone,
      page.page_type,
      page.lect,
      trashParentId,
      page.page_id,
      page.creator,
      page.editors,
    )
    .run();

  const trashPage = await db.prepare('SELECT id FROM trash_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();

  if (trashPage) {
    const pageVersions = await db.prepare('SELECT * FROM page_versions WHERE page_id = ?')
      .bind(pageId)
      .all<PageVersion>();
    for (const version of pageVersions.results) {
      await db.prepare(
        `INSERT OR IGNORE INTO trash_page_versions (id, uuid, created_at, page_id, lect, action)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(version.id, version.uuid, version.created_at, trashPage.id, version.lect, version.action)
        .run();
    }

    const pageTags = await db.prepare('SELECT * FROM page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<PageTag>();
    for (const pt of pageTags.results) {
      await db.prepare(
        `INSERT OR IGNORE INTO trash_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, trashPage.id, pt.tag_id, pt.weight)
        .run();
    }
  }

  await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
  return page;
}

/** What trashDraftPages reports back per page — enough for unpublish (uuid,
 *  page_type) and lifecycle hooks/audit (id, name, slug), WITHOUT the lect
 *  column: deserializing thousands of fat lect rows just to throw them away
 *  was a measurable share of bulk-delete CPU. */
export interface TrashedPageRef {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  page_type: string | null;
  submission_origin: number;
}

/**
 * Batch-trash multiple draft pages in a single D1 transaction.
 * Equivalent to calling trashDraftPage for each id, but uses INSERT-SELECT
 * to copy pages, versions, and tags in bulk — O(1) round trips regardless
 * of how many pages are deleted, and no page content ever leaves SQLite.
 *
 * Pages not found are silently skipped (same as the single-page variant).
 * Returns light refs to the pages that were actually trashed.
 */
export async function trashDraftPages(db: D1DatabaseClient, ids: number[]): Promise<TrashedPageRef[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');

  const { results: pages } = await db.prepare(
    `SELECT dp.id, dp.uuid, dp.name, dp.slug, dp.page_type,
       EXISTS(SELECT 1 FROM page_versions pv
              WHERE pv.page_id = dp.id AND pv.action IN ('ingest-submission', 'pull-published')) AS submission_origin
     FROM pages dp WHERE dp.id IN (${ph})`,
  ).bind(...ids).all<TrashedPageRef>();
  if (!pages.length) return [];

  const foundIds = pages.map((p) => p.id);
  const foundPh = foundIds.map(() => '?').join(',');

  await db.batch([
    // Copy pages into trash, resolving trash parent inline.
    db.prepare(
      `INSERT INTO trash_pages (id, uuid, name, slug, weight, start, end, timezone, page_type, lect, page_id, source_page_id, creator, editors)
       SELECT dp.id, dp.uuid, dp.name, dp.slug, dp.weight, dp.start, dp.end, dp.timezone, dp.page_type, dp.lect,
         CASE WHEN dp.page_id IS NOT NULL AND EXISTS (SELECT 1 FROM trash_pages tp WHERE tp.id = dp.page_id) THEN dp.page_id ELSE NULL END,
         dp.page_id, dp.creator, dp.editors
       FROM pages dp WHERE dp.id IN (${foundPh})
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name, slug = excluded.slug, weight = excluded.weight,
         start = excluded.start, end = excluded.end, timezone = excluded.timezone,
         page_type = excluded.page_type,
         lect = excluded.lect, page_id = excluded.page_id, source_page_id = excluded.source_page_id,
         creator = excluded.creator, editors = excluded.editors`,
    ).bind(...foundIds),
    // Copy page versions (join via uuid so the trash row's id is used, not the draft id).
    db.prepare(
      `INSERT OR IGNORE INTO trash_page_versions (id, uuid, created_at, page_id, lect, action)
       SELECT pv.id, pv.uuid, pv.created_at, tp.id, pv.lect, pv.action
       FROM page_versions pv
       JOIN trash_pages tp ON tp.uuid = (SELECT dp.uuid FROM pages dp WHERE dp.id = pv.page_id)
       WHERE pv.page_id IN (${foundPh})`,
    ).bind(...foundIds),
    // Copy page tags.
    db.prepare(
      `INSERT OR IGNORE INTO trash_page_tags (uuid, page_id, tag_id, weight)
       SELECT uuid, page_id, tag_id, weight FROM page_tags WHERE page_id IN (${foundPh})`,
    ).bind(...foundIds),
    // Remove from draft.
    db.prepare(`DELETE FROM pages WHERE id IN (${foundPh})`).bind(...foundIds),
  ]);

  return pages;
}

/**
 * Bulk-restores trashed pages back to draft, set-based so the work is a fixed
 * handful of statements regardless of how many pages are restored (the per-page
 * restore route does ~5 D1 ops EACH, which would time out on a big trash — e.g.
 * after deleting an event with thousands of guests). Mirrors trashDraftPages in
 * reverse: ids are preserved, so version history and tags re-link by the same
 * id, and the original parent is re-linked only when it is live again.
 *
 * Returns the number of pages restored. `pageType`/`withinLastHour` scope it to
 * match the trash list's "Empty" controls.
 *
 * Caveat vs. the single-page route: a parent restored in the SAME call is not
 * yet visible to the child's parent check — fine here because guests/lists
 * link by their lect pointer, not by parent page.
 */
export async function restoreTrashedPages(
  db: D1DatabaseClient,
  opts: { pageType?: string | null; withinLastHour?: boolean } = {},
): Promise<number> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.pageType) { conds.push('page_type = ?'); params.push(opts.pageType); }
  if (opts.withinLastHour) conds.push("created_at >= datetime('now', '-1 hour')");
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM trash_pages ${where}`)
    .bind(...params).first<{ n: number }>();
  const count = countRow?.n ?? 0;
  if (!count) return 0;

  const idSubquery = `SELECT id FROM trash_pages ${where}`;
  await db.batch([
    // 1. Pages back to draft (preserve id; re-link the parent only if it is live).
    db.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
       SELECT tp.id, tp.uuid, tp.name, tp.slug, tp.weight, tp.start, tp.end, tp.timezone, tp.page_type, tp.lect,
         CASE WHEN COALESCE(tp.source_page_id, tp.page_id) IS NOT NULL
           AND EXISTS (SELECT 1 FROM pages dp WHERE dp.id = COALESCE(tp.source_page_id, tp.page_id))
           THEN COALESCE(tp.source_page_id, tp.page_id) ELSE NULL END,
         tp.creator, tp.editors
       FROM trash_pages tp ${where}
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name, slug = excluded.slug, weight = excluded.weight,
         start = excluded.start, end = excluded.end, timezone = excluded.timezone,
         page_type = excluded.page_type,
         lect = excluded.lect, page_id = excluded.page_id, creator = excluded.creator, editors = excluded.editors`,
    ).bind(...params),
    // 2. Version history (trash_page_versions.page_id is the preserved page id).
    db.prepare(
      `INSERT OR IGNORE INTO page_versions (id, uuid, created_at, page_id, lect, action)
       SELECT id, uuid, created_at, page_id, lect, action FROM trash_page_versions
       WHERE page_id IN (${idSubquery})`,
    ).bind(...params),
    // 3. Tags.
    db.prepare(
      `INSERT OR IGNORE INTO page_tags (uuid, page_id, tag_id, weight)
       SELECT uuid, page_id, tag_id, weight FROM trash_page_tags
       WHERE page_id IN (${idSubquery})`,
    ).bind(...params),
    // 4. Remove the restored rows from trash (children first; trash_pages cascades too).
    db.prepare(`DELETE FROM trash_page_versions WHERE page_id IN (${idSubquery})`).bind(...params),
    db.prepare(`DELETE FROM trash_page_tags WHERE page_id IN (${idSubquery})`).bind(...params),
    db.prepare(`DELETE FROM trash_pages ${where}`).bind(...params),
  ]);

  return count;
}

export async function listDashboardDraftPages(
  db: D1DatabaseClient,
  options: { pageType?: string; page: number; limit: number },
): Promise<DashboardListResult> {
  const whereSql = options.pageType ? 'WHERE page_type = ?' : '';
  const baseParams = options.pageType ? [options.pageType] : [];
  const total = await countPageMetadata(db, whereSql.replace(/^WHERE\s+/, ''), baseParams, { types: options.pageType ? [options.pageType] : undefined });
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  const currentPage = Math.min(options.page, totalPages);
  const currentOffset = (currentPage - 1) * options.limit;

  const pages = await db.prepare(
    `SELECT * FROM pages ${whereSql}
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
  options: { pageType?: string } = {},
): Promise<string[]> {
  const whereSql = options.pageType ? 'WHERE page_type = ?' : '';
  const params = options.pageType ? [options.pageType] : [];
  const pages = await db.prepare(
    `SELECT uuid FROM pages ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC`,
  )
    .bind(...params)
    .all<{ uuid: string }>();
  return pages.results.map((page) => page.uuid);
}

export async function listDashboardDraftPagesByUuids(
  db: D1DatabaseClient,
  uuids: string[],
  options: { pageType?: string } = {},
): Promise<Page[]> {
  if (!uuids.length) return [];
  const placeholders = uuids.map(() => '?').join(',');
  const pageTypeSql = options.pageType ? ' AND page_type = ?' : '';
  const params = options.pageType ? [...uuids, options.pageType] : uuids;
  const pages = await db.prepare(
    `SELECT * FROM pages
     WHERE uuid IN (${placeholders})${pageTypeSql}`,
  )
    .bind(...params)
    .all<Page>();
  return pages.results;
}
