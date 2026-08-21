// Applying one action to many pages: publish, unpublish, move to trash, change tags,
// or replace text in draft content.
//
// Core, not a feature, for the same reason the advanced-search query builder
// is: two callers need it and neither may depend on the other. The search
// screen runs it inline when there is nothing durable to run it on, and the
// jobs feature runs it one bounded slice at a time from a queue. All it
// touches is core — pages, the publish targets, the trash, the audit
// log — so it carries no job or screen concepts of its own.

import { coreExtensions, type PageEvent, type PageEventPage } from '../extensions';
import {
  listLiveByTypes,
  publishPagesToTargets,
  unpublishPagesFromTargets,
} from '../publish';
import type { Env, JWTPayload, Page } from '../../types';
import { trashDraftPages, type TrashedPageRef } from '../db/admin-queries';
import { advancedSearchMatchingPageIds, type AdvancedSearchCriterion, type AdvancedSearchOperator } from '../db/search';
import { submissionMirrorIds } from '../db/submission-ingest';
import { publicationStatusForPage, withDraftMetadata } from '../db/page-logic';
import { safeParseLect, stringifyLect, type Lect } from '../db/lect';

/** The bulk actions a page listing offers. */
export type BulkPageAction = 'publish' | 'unpublish' | 'delete' | 'add_tag' | 'remove_tag' | 'replace_text';

/** Extra values used only by the bulk actions that need them. */
export interface BulkPageActionOptions {
  targetTagIds?: number[];
  searchText?: string;
  replacementText?: string;
}

export interface LectTextReplacementPreview {
  path: string;
  currentValue: string;
  futureValue: string;
}

/**
 * Pages per slice. A slice is sized to fit one Worker invocation's subrequest
 * budget: publishing fans out to every configured target per page, so a larger
 * slice is what makes a bulk action fail at the 1000-subrequest limit.
 */
export const BULK_ACTION_PAGE_LIMIT = 100;

/** What one slice of a bulk action achieved. */
export interface BulkPageActionOutcome {
  updated: number;
  /** Pages the publish targets declined (submission mirrors). */
  refused: number;
  /** Targets that errored, by name. */
  failedTargets: Set<string>;
}

/** The criteria half of a bulk action over a whole result set. */
export interface BulkTargetQuery {
  pageTypes: string[];
  criteria: AdvancedSearchCriterion[];
  operator: AdvancedSearchOperator;
  /** Narrows to a page-list publication status. */
  status?: 'draft' | 'scheduled' | 'live' | 'ended';
}

/**
 * Every page id a `scope: 'all'` bulk action covers. Resolved once, up front:
 * the criteria are evaluated against the draft table now, so a page edited
 * while the action runs cannot slip in or out of the set half way through.
 */
export async function resolveBulkTargetIds(env: Env, query: BulkTargetQuery): Promise<number[]> {
  const ids = await advancedSearchMatchingPageIds(env.DB, query.pageTypes, query.criteria, query.operator);
  if (!query.status) return ids;

  const livePages = await listLiveByTypes(env, query.pageTypes);
  const liveMap = new Map(livePages.map((page) => [page.uuid, page]));
  const pages = await draftPagesByIds(env.DB, ids);
  return pages.filter((page) => {
    const livePage = liveMap.get(page.uuid);
    if (query.status === 'draft') return !livePage;
    return !!livePage && publicationStatusForPage(livePage, true) === query.status;
  }).map((page) => page.id);
}

/**
 * Applies `action` to `ids`. Caller-bounded: pass at most
 * BULK_ACTION_PAGE_LIMIT ids per call, and drive the slices yourself.
 */
export async function applyBulkPageAction(
  env: Env,
  user: JWTPayload,
  action: BulkPageAction,
  ids: number[],
  options: BulkPageActionOptions = {},
): Promise<BulkPageActionOutcome> {
  const failedTargets = new Set<string>();
  let updated = 0;
  let refused = 0;

  if (!ids.length) return { updated, refused, failedTargets };

  if (action === 'add_tag') {
    const pages = await draftPagesByIds(env.DB, ids);
    const taggedPageIds = await addTagsToDraftPages(
      env.DB,
      pages.map((page) => page.id),
      options.targetTagIds ?? [],
    );
    const tagged = new Set(taggedPageIds);
    await emitPageLifecycle(env, user, 'update', pages.filter((page) => tagged.has(page.id)));
    return { updated: taggedPageIds.length, refused, failedTargets };
  }

  if (action === 'remove_tag') {
    const pages = await draftPagesByIds(env.DB, ids);
    const untaggedPageIds = await removeTagsFromDraftPages(
      env.DB,
      pages.map((page) => page.id),
      options.targetTagIds ?? [],
    );
    const untagged = new Set(untaggedPageIds);
    await emitPageLifecycle(env, user, 'update', pages.filter((page) => untagged.has(page.id)));
    return { updated: untaggedPageIds.length, refused, failedTargets };
  }

  if (action === 'replace_text') {
    const searchText = options.searchText ?? '';
    if (!searchText) return { updated, refused, failedTargets };

    const changed: Page[] = [];
    const statements: D1PreparedStatement[] = [];
    for (const page of await draftPagesByIds(env.DB, ids)) {
      const replaced = replaceLectText(safeParseLect(page.lect), searchText, options.replacementText ?? '');
      const name = replaceLiteralText(page.name, searchText, options.replacementText ?? '');
      if (!replaced.changed && name === page.name) continue;
      const lect = replaced.changed
        ? stringifyLect(withDraftMetadata(replaced.lect, Number.parseInt(user.sub, 10) || 0))
        : page.lect;
      statements.push(
        env.DB.prepare('UPDATE pages SET name = ?, lect = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(name, lect, page.id),
        env.DB.prepare("INSERT INTO page_versions (page_id, lect, action) VALUES (?, ?, 'bulk-replace')").bind(page.id, lect),
      );
      changed.push({ ...page, name, lect });
    }
    if (statements.length) await env.DB.batch(statements);
    await emitPageLifecycle(env, user, 'update', changed);
    return { updated: changed.length, refused, failedTargets };
  }

  if (action === 'delete') {
    const deleted: TrashedPageRef[] = [];
    for (const chunk of chunks(ids)) {
      const trashed = await trashDraftPages(env.DB, chunk);
      if (!trashed.length) continue;
      // One bulk unpublish per chunk instead of a per-page delete: D1 collapses
      // the whole slice into a single batch, so a 90-page chunk costs ~1 round
      // trip to the published DB rather than ~3 per page.
      const outcome = await unpublishPagesFromTargets(env, trashed);
      refused += outcome.refusedCount;
      outcome.failures.forEach((target) => failedTargets.add(target));
      deleted.push(...trashed);
      updated += trashed.length;
    }
    await emitPageLifecycle(env, user, 'delete', deleted);
    return { updated, refused, failedTargets };
  }

  // Publish and unpublish both fan out to every configured target, so both go
  // through the set-based form: one submission-mirror check and one tag read
  // for the slice, and one batch per target — not the ~6 round trips per page
  // the per-page helpers cost, which is what put a full slice within reach of
  // the 1000-subrequest limit.
  const pages = await draftPagesByIds(env.DB, ids);
  const succeeded: Page[] = [];

  if (action === 'publish') {
    const outcome = await publishPagesToTargets(env, pages);
    outcome.failures.forEach((target) => failedTargets.add(target));
    succeeded.push(...outcome.published);
    updated += outcome.published.length;
    refused += outcome.refused.length;
  } else {
    const mirrors = await submissionMirrorIds(env.DB, pages.map((page) => page.id));
    const outcome = await unpublishPagesFromTargets(
      env,
      pages.map((page) => ({ uuid: page.uuid, submission_origin: mirrors.has(page.id) ? 1 : 0 })),
    );
    outcome.failures.forEach((target) => failedTargets.add(target));
    succeeded.push(...pages.filter((page) => !mirrors.has(page.id)));
    updated += succeeded.length;
    refused += outcome.refusedCount;
  }

  await emitPageLifecycle(env, user, action, succeeded);

  return { updated, refused, failedTargets };
}

/** The flash a finished bulk action reports. */
export function bulkActionFlash(
  action: BulkPageAction,
  count: number,
  refused = 0,
  failedTargets: string[] = [],
): string {
  const past = action === 'delete'
    ? 'moved to trash'
    : action === 'add_tag'
      ? 'tagged'
      : action === 'remove_tag'
        ? 'had tags removed'
        : action === 'replace_text'
          ? 'had text replaced'
        : `${action}ed`;
  const pageLabel = count === 1 ? 'page' : 'pages';
  const base = count === 0 ? 'No pages updated' : `${count} ${pageLabel} ${past}`;
  const notes: string[] = [];
  if (refused) notes.push(`${refused} submission ${refused === 1 ? 'page was' : 'pages were'} skipped`);
  if (failedTargets.length) notes.push(`target failures: ${failedTargets.join(', ')}`);
  return notes.length ? `${base}; ${notes.join('; ')}` : base;
}

/**
 * Literal, case-sensitive replacement in user-authored Lect values. Structural
 * metadata and pointer values are left intact, while blocks/items are walked
 * recursively. JSON keys are never modified.
 */
export function replaceLectText(lect: Lect, searchText: string, replacementText: string): { lect: Lect; changed: boolean } {
  const result = transformLectText(lect, searchText, replacementText);
  return { lect: result.lect, changed: result.changes.length > 0 };
}

/** Literal, case-sensitive replacement for a single text value. */
export function replaceLiteralText(value: string, searchText: string, replacementText: string): string {
  return searchText && value.includes(searchText)
    ? value.split(searchText).join(replacementText)
    : value;
}

/** Builds the field-level before/after rows used by the confirmation preview. */
export function previewLectTextReplacement(
  lect: Lect,
  searchText: string,
  replacementText: string,
): { lect: Lect; changes: LectTextReplacementPreview[] } {
  return transformLectText(lect, searchText, replacementText);
}

function transformLectText(
  lect: Lect,
  searchText: string,
  replacementText: string,
): { lect: Lect; changes: LectTextReplacementPreview[] } {
  if (!searchText) return { lect, changes: [] };
  const changes: LectTextReplacementPreview[] = [];

  const visit = (value: unknown, path: string[], key = ''): unknown => {
    if (typeof value === 'string') {
      if (key.startsWith('_') || !value.includes(searchText)) return value;
      const futureValue = replaceLiteralText(value, searchText, replacementText);
      changes.push({ path: path.join('.'), currentValue: value, futureValue });
      return futureValue;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => visit(entry, [
        ...path.slice(0, -1),
        `${path.at(-1) ?? 'item'}[${index + 1}]`,
      ]));
    }
    if (!value || typeof value !== 'object') return value;

    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const displayKey = childKey === '_blocks' ? 'blocks' : childKey === '_tags' ? 'tags' : childKey;
      result[childKey] = childKey === '_pointers'
        ? childValue
        : visit(childValue, [...path, displayKey], childKey);
    }
    return result;
  };

  return { lect: visit(lect, []) as Lect, changes };
}

// Records audit rows and fires lifecycle hooks for a whole batch of pages at
// once: one DB.batch of audit inserts instead of an INSERT per page, and hooks
// delivered in chunked bulk POSTs rather than one fetch per page. Both are
// best-effort (a failed audit or hook never fails the bulk action), mirroring
// the plugin bulk path.
async function emitPageLifecycle(
  env: Env,
  user: JWTPayload,
  event: PageEvent,
  pages: PageEventPage[],
): Promise<void> {
  if (!pages.length) return;
  const auditPromise = env.DB.batch(
    pages.map((page) => env.DB.prepare(
      `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, 'page', ?, ?)`,
    ).bind(
      String(user.sub),
      user.email,
      `page.${event}`,
      String(page.id),
      JSON.stringify({ name: page.name, slug: page.slug, page_type: page.page_type }),
    )),
  );
  const hooksPromise = coreExtensions().notifyPageEvent?.(env, user, event, pages) ?? Promise.resolve();
  await Promise.allSettled([auditPromise, hooksPromise]);
}

/** Draft rows for `ids`, in the order given, skipping ids that no longer exist. */
export async function draftPagesByIds(db: D1DatabaseClient, ids: number[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const chunk of chunks(ids)) {
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT * FROM pages WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<Page>();
    pages.push(...rows.results);
  }
  const byId = new Map(pages.map((page) => [page.id, page]));
  return ids.map((id) => byId.get(id)).filter((page): page is Page => !!page);
}

/**
 * Adds every requested existing tag that is missing from each page. The
 * page_tags table predates a composite unique constraint, so the NOT EXISTS
 * predicate is intentional: repeating a bulk action must not create duplicate
 * links even on databases that still have the original schema.
 */
export async function addTagsToDraftPages(
  db: D1DatabaseClient,
  pageIds: number[],
  tagIds: number[],
): Promise<number[]> {
  const pages = Array.from(new Set(pageIds.filter((id) => Number.isInteger(id) && id > 0)));
  const tags = Array.from(new Set(tagIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (!pages.length || !tags.length) return [];

  const changedPageIds = new Set<number>();
  // Keep each statement comfortably below D1's bound-parameter limit even if
  // a caller selects a large number of target tags.
  for (const pageChunk of chunks(pages, 45)) {
    for (const tagChunk of chunks(tags, 45)) {
      const pagePlaceholders = pageChunk.map(() => '?').join(',');
      const tagPlaceholders = tagChunk.map(() => '?').join(',');
      const missing = await db.prepare(
        `SELECT DISTINCT p.id
         FROM pages p
         CROSS JOIN tags t
         WHERE p.id IN (${pagePlaceholders})
           AND t.id IN (${tagPlaceholders})
           AND NOT EXISTS (
             SELECT 1 FROM page_tags existing
             WHERE existing.page_id = p.id AND existing.tag_id = t.id
           )`,
      )
        .bind(...pageChunk, ...tagChunk)
        .all<{ id: number }>();

      await db.prepare(
        `INSERT INTO page_tags (page_id, tag_id)
         SELECT p.id, t.id
         FROM pages p
         CROSS JOIN tags t
         WHERE p.id IN (${pagePlaceholders})
           AND t.id IN (${tagPlaceholders})
           AND NOT EXISTS (
             SELECT 1 FROM page_tags existing
             WHERE existing.page_id = p.id AND existing.tag_id = t.id
           )`,
      )
        .bind(...pageChunk, ...tagChunk)
        .run();

      missing.results.forEach((page) => changedPageIds.add(page.id));
    }
  }

  for (const pageChunk of chunks([...changedPageIds])) {
    const placeholders = pageChunk.map(() => '?').join(',');
    await db.prepare(`UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`)
      .bind(...pageChunk)
      .run();
  }

  return pages.filter((id) => changedPageIds.has(id));
}

/** Removes every requested existing tag from each page that has it. */
export async function removeTagsFromDraftPages(
  db: D1DatabaseClient,
  pageIds: number[],
  tagIds: number[],
): Promise<number[]> {
  const pages = Array.from(new Set(pageIds.filter((id) => Number.isInteger(id) && id > 0)));
  const tags = Array.from(new Set(tagIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (!pages.length || !tags.length) return [];

  const changedPageIds = new Set<number>();
  for (const pageChunk of chunks(pages, 45)) {
    for (const tagChunk of chunks(tags, 45)) {
      const pagePlaceholders = pageChunk.map(() => '?').join(',');
      const tagPlaceholders = tagChunk.map(() => '?').join(',');
      const existing = await db.prepare(
        `SELECT DISTINCT p.id
         FROM pages p
         JOIN page_tags existing ON existing.page_id = p.id
         JOIN tags t ON t.id = existing.tag_id
         WHERE p.id IN (${pagePlaceholders})
           AND existing.tag_id IN (${tagPlaceholders})`,
      )
        .bind(...pageChunk, ...tagChunk)
        .all<{ id: number }>();

      await db.prepare(
        `DELETE FROM page_tags
         WHERE page_id IN (${pagePlaceholders})
           AND tag_id IN (${tagPlaceholders})
           AND EXISTS (SELECT 1 FROM pages WHERE pages.id = page_tags.page_id)
           AND EXISTS (SELECT 1 FROM tags WHERE tags.id = page_tags.tag_id)`,
      )
        .bind(...pageChunk, ...tagChunk)
        .run();

      existing.results.forEach((page) => changedPageIds.add(page.id));
    }
  }

  for (const pageChunk of chunks([...changedPageIds])) {
    const placeholders = pageChunk.map(() => '?').join(',');
    await db.prepare(`UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`)
      .bind(...pageChunk)
      .run();
  }

  return pages.filter((id) => changedPageIds.has(id));
}

function chunks<T>(values: T[], size = 90): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
