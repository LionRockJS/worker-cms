import { applyLocalPageChanges, type LocalPageChange, type ContentBatchContext } from './batch-mutation-evidence';
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
import { logAuditBatch, type AuditActor } from '../db/audit';
import { submissionMirrorIds } from '../db/submission-ingest';
import { publicationStatusForPage, withDraftMetadata } from '../db/page-logic';
import { safeParseLect, stringifyLect, type Lect } from '../db/lect';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

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
  /** Pages the publish targets declined: submission mirrors and regulated pages. */
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
export async function resolveBulkTargetIds(env: Env, query: BulkTargetQuery, actor?: AuditActor): Promise<number[]> {
  const ids = await advancedSearchMatchingPageIds(env.DB, query.pageTypes, query.criteria, query.operator);
  if (!query.status) return ids;

  const livePages = await listLiveByTypes(env, query.pageTypes, actor);
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
  context: ContentBatchContext = {},
): Promise<BulkPageActionOutcome> {
  if (action !== 'unpublish') assertRegulatedWritesAllowed(env);
  const failedTargets = new Set<string>();
  let updated = 0;
  let refused = 0;

  if (!ids.length) return { updated, refused, failedTargets };

  if (action === 'add_tag' || action === 'remove_tag' || action === 'replace_text') {
    if (ids.length>BULK_ACTION_PAGE_LIMIT || ids.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error('Invalid bulk target manifest');
    const pages = await draftPagesByIds(env.DB,[...new Set(ids)]);
    const changes: LocalPageChange[] = [];
    if (action === 'replace_text') {
      const searchText=options.searchText??'';
      if (!searchText) return {updated,refused,failedTargets};
      for (const page of pages) {
        const replaced=replaceLectText(safeParseLect(page.lect),searchText,options.replacementText??'');
        const name=replaceLiteralText(page.name,searchText,options.replacementText??'');
        if (!replaced.changed && name===page.name) continue;
        const lect=replaced.changed ? stringifyLect(withDraftMetadata(replaced.lect,Number.parseInt(user.sub,10)||0)):page.lect;
        changes.push({before:page,name,lect});
      }
    } else {
      const tagIds=[...new Set((options.targetTagIds??[]).filter(id=>Number.isSafeInteger(id)&&id>0))];
      if (tagIds.length>5000) throw new Error('Bulk tag manifest requires review');
      const [tags,links]=await env.DB.batch([
        env.DB.prepare('SELECT id FROM tags WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(tagIds)),
        env.DB.prepare('SELECT page_id,tag_id FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(JSON.stringify(pages.map(p=>p.id))),
      ]);
      if (links.results.length>5000) throw new Error('Bulk tag manifest requires review');
      const existing=new Set((tags.results as Array<{id:number}>).map(t=>t.id));
      for (const page of pages) {
        const old=(links.results as Array<{page_id:number;tag_id:number}>).filter(l=>l.page_id===page.id).map(l=>l.tag_id);
        const next=action==='add_tag' ? [...new Set([...old,...existing])] : old.filter(id=>!existing.has(id));
        if (action==='add_tag' ? [...existing].every(id=>old.includes(id)) : next.length===old.length) continue;
        changes.push({before:page,tags:next,previousTagIds:old});
      }
    }
    await applyLocalPageChanges(env,user,changes,context);
    await emitPageLifecycle(env,user,'update',changes.map(c=>({...c.before,name:c.name??c.before.name})),true);
    return {updated:changes.length,refused,failedTargets};
  }

  if (action === 'delete') {
    const deleted: TrashedPageRef[] = [];
    for (const chunk of chunks(ids)) {
      const trashed = await trashDraftPages(env.DB, chunk);
      if (!trashed.length) continue;
      // One bulk unpublish per chunk instead of a per-page delete: D1 collapses
      // the whole slice into a single batch, so a 90-page chunk costs ~1 round
      // trip to the published DB rather than ~3 per page.
      const outcome = await unpublishPagesFromTargets(env, trashed, { userId: user.sub, roles: user.role, sessionSid: user.sid ?? null, via: null });
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
    const outcome = await publishPagesToTargets(env, pages, {
      userId: user.sub, roles: user.role, sessionSid: user.sid ?? null, via: null,
    });
    outcome.failures.forEach((target) => failedTargets.add(target));
    succeeded.push(...outcome.published);
    updated += outcome.published.length;
    refused += outcome.refused.length;
  } else {
    const mirrors = await submissionMirrorIds(env.DB, pages.map((page) => page.id));
    const outcome = await unpublishPagesFromTargets(
      env,
      pages.map((page) => ({ uuid: page.uuid, submission_origin: mirrors.has(page.id) ? 1 : 0 })),
      { userId: user.sub, roles: user.role, sessionSid: user.sid ?? null, via: null },
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
  if (refused) {
    notes.push(`${refused} ${refused === 1 ? 'page was' : 'pages were'} skipped (submission mirrors or regulated data)`);
  }
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
  durableEvidence = false,
): Promise<void> {
  if (!pages.length) return;
  const auditPromise = durableEvidence ? Promise.resolve() : logAuditBatch(env, user, pages.map((page) => ({
    action: `page.${event}`,
    entityType: 'page',
    entityId: page.id,
    detail: { name: page.name, slug: page.slug, page_type: page.page_type },
  })));
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

function chunks<T>(values: T[], size = 90): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
