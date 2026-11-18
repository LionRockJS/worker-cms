// Legacy storage helpers exercised by the trash compatibility tests.
import type { Page, PageVersion, PageTag } from '../src/types';
import { nextIdSql } from '../src/core/pages/snapshot-id';

/**
 * Soft-deletes a draft page: copies the page, its version history, and its tag
 * links into the trash tables (preserving ids so a restore keeps identity),
 * then removes it from `pages`. Returns the page that was trashed, or
 * null when no such page exists. Callers remain responsible for unpublishing
 * and firing the `delete` lifecycle hook — this is the DB-copy half only, used
 * by tests that seed a previously trashed record.
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
        `INSERT OR IGNORE INTO trash_page_tags (id, uuid, page_id, tag_id, weight) VALUES (${nextIdSql('trash_page_tags')}, ?, ?, ?, ?)`,
      )
        .bind(pt.uuid, trashPage.id, pt.tag_id, pt.weight)
        .run();
    }
  }

  await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
  return page;
}

/**
 * Bulk-restores trashed pages back to draft, set-based so the work is a fixed
 * handful of statements regardless of how many pages are restored (the per-page
 * restore route does ~5 D1 ops EACH, which would time out on a big trash — e.g.
 * after deleting an event with thousands of guests). IDs are preserved, so version history and tags re-link by the same
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
      `INSERT OR IGNORE INTO page_tags (id, uuid, page_id, tag_id, weight)
       SELECT ${nextIdSql('page_tags')} + ROW_NUMBER() OVER (ORDER BY id) - 1, uuid, page_id, tag_id, weight FROM trash_page_tags
       WHERE page_id IN (${idSubquery})`,
    ).bind(...params),
    // 4. Remove the restored rows from trash (children first; trash_pages cascades too).
    db.prepare(`DELETE FROM trash_page_versions WHERE page_id IN (${idSubquery})`).bind(...params),
    db.prepare(`DELETE FROM trash_page_tags WHERE page_id IN (${idSubquery})`).bind(...params),
    db.prepare(`DELETE FROM trash_pages ${where}`).bind(...params),
  ]);

  return count;
}
