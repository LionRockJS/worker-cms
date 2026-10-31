// ============================================================
// Publish registry — resolves the configured publish targets
// and orchestrates publish / unpublish across all of them.
//
// Built-in targets come from the comma-separated PUBLISH_TARGETS
// var (default "d1"): "d1" needs the PUBLISHED_DB binding, "r2"
// needs the PUBLISH_BUCKET binding. Plugin targets are discovered
// from plugin manifests (publishTarget: true), mirroring how
// lifecycle hooks are wired.
//
// The draft snapshot is built once from DB and fanned out to every
// target; per-target failures are collected (not thrown) so the
// admin can report partial publishes. The first adapter that
// implements live-state reads serves the admin UI's publish badges.
// ============================================================

import type { Env, Page } from '../../types';
import type {
  LivePageSnapshot,
  PublishAdapter,
  PublishSnapshot,
  PublishSnapshotTag,
  PublishedTag,
} from './adapter';
import { d1Adapter } from './d1';
import { coreExtensions } from '../extensions';
import { r2Adapter } from './r2';
import { isSubmissionMirror, submissionMirrorIds } from '../db/submission-ingest';
import { projectLect, publishLectRules } from './projection';
import { regulatedPages, type PublishRefusal } from './regulated';
import { auditPublishTransfer, auditWithdrawal, withdrawalReads, type WithdrawalRead } from './audit';
import type { AuditActor } from '../db/audit';
import { classFor, resolveDataClasses } from '../db/data-classes';
import { inventoried } from '../http/regulated-profile';
import { auditLiveReads } from './read-audit';
import { regulatedWritesBlocked } from '../http/regulated-writes';

export interface PublishOutcome {
  /** Targets that were attempted, in order. */
  targets: string[];
  /** Target ids whose publish/unpublish threw. */
  failures: string[];
  /** Containment proceeded with incomplete audit evidence for these targets. */
  auditFailures?: string[];
  /**
   * Set when the page never reached an adapter. Either it is a submission
   * mirror — publishing one would upsert the original live row it shares a uuid
   * with, and unpublishing/trashing one would DELETE that live row — or it holds
   * regulated data, which is never published, or deployment write containment
   * prevents any publication.
   */
  refused?: boolean;
  /** Which refusal it was, for the message the admin sees. */
  refusedReason?: PublishRefusal;
}

const refusal = (reason: PublishRefusal): PublishOutcome => (
  { targets: [], failures: [], refused: true, refusedReason: reason }
);

const DEFAULT_TARGETS = 'd1';

export async function getPublishAdapters(env: Env): Promise<PublishAdapter[]> {
  const adapters: PublishAdapter[] = [];

  const targets = (env.PUBLISH_TARGETS ?? DEFAULT_TARGETS)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  for (const target of targets) {
    if (target === 'd1') {
      if (env.PUBLISHED_DB) adapters.push(d1Adapter(env.PUBLISHED_DB));
      else console.error('Publish target "d1" requires the PUBLISHED_DB binding');
    } else if (target === 'r2') {
      if (env.PUBLISH_BUCKET) adapters.push(r2Adapter(env.PUBLISH_BUCKET));
      else console.error('Publish target "r2" requires the PUBLISH_BUCKET binding');
    } else {
      console.error(`Unknown publish target "${target}" in PUBLISH_TARGETS`);
    }
  }

  // Plugin publish targets, when the plugin platform is installed. Without it
  // this contributes nothing and publishing falls back to the built-ins.
  const contributed = await coreExtensions().publishAdapters?.(env);
  if (contributed) adapters.push(...contributed);

  return adapters;
}

/**
 * Snapshots for pages the caller already holds — the set-based form of
 * buildSnapshot. Costs one projection-rule lookup and one tag read per chunk
 * for the whole slice, where the per-page path costs two reads each.
 *
 * The input rows are never mutated: projection writes into a copy, so a caller
 * that goes on to use the same Page objects (lifecycle hooks, audit) still sees
 * the unthinned draft lect.
 */
async function buildSnapshots(env: Env, pages: Page[]): Promise<PublishSnapshot[]> {
  if (!pages.length) return [];

  // Data minimization: project the lect BEFORE fan-out so every publish
  // target (D1, R2, plugin targets) receives the same thinned snapshot.
  const rules = await publishLectRules(env);
  const tagsByPage = await readSnapshotTags(env, pages.map((page) => page.id));
  const publishedAt = new Date().toISOString();

  return pages.map((page) => ({
    page: { ...page, lect: projectLect(page.lect, rules[page.page_type ?? '']) },
    ...(tagsByPage.get(page.id) ?? { tags: [], tagCatalogue: [] }),
    publishedAt,
  }));
}

/** Page ids per tag read, bounded by D1's cap on bound parameters. */
const PAGE_ID_CHUNK = 90;

/** The link fields publishing has always carried, without the tag row's own. */
const tagLinksSql = (placeholders: string) => `SELECT pt.page_id, pt.uuid, pt.tag_id, pt.weight, t.slug, t.name
     FROM page_tags pt
     LEFT JOIN tags t ON t.id = pt.tag_id
     WHERE pt.page_id IN (${placeholders})
     ORDER BY pt.page_id ASC, pt.weight ASC, pt.id ASC`;

interface SnapshotTags {
  tags: PublishSnapshotTag[];
  tagCatalogue: PublishedTag[];
}

/**
 * Tag links per page, plus the catalogue rows behind them so a target that
 * stores tags separately can upsert the pair in one publish. Both come from one
 * read: `tags` is the link list every target already receives, `tagCatalogue`
 * is the distinct tag rows, keyed by the same ids `DB.tags` uses.
 *
 * Pages with no tags are absent from the map; callers default them to empty.
 */
async function readSnapshotTags(
  env: Env,
  pageIds: number[],
): Promise<Map<number, SnapshotTags>> {
  type LinkRow = PublishSnapshotTag & {
    page_id: number;
    tag_uuid: string | null;
    tag_weight: number | null;
    taxonomy_slug: string | null;
    parent_tag: number | null;
    lect: string | null;
  };

  const byPage = new Map<number, SnapshotTags>();
  const entry = (pageId: number): SnapshotTags => {
    const existing = byPage.get(pageId);
    if (existing) return existing;
    const created: SnapshotTags = { tags: [], tagCatalogue: [] };
    byPage.set(pageId, created);
    return created;
  };

  const unique = [...new Set(pageIds)];
  for (let index = 0; index < unique.length; index += PAGE_ID_CHUNK) {
    const chunk = unique.slice(index, index + PAGE_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');

    let rows: LinkRow[];
    try {
      rows = (await env.DB.prepare(
        `SELECT pt.page_id, pt.uuid, pt.tag_id, pt.weight, t.slug, t.name,
                t.uuid AS tag_uuid, t.weight AS tag_weight, t.taxonomy_slug, t.parent_tag, t.lect
         FROM page_tags pt
         LEFT JOIN tags t ON t.id = pt.tag_id
         WHERE pt.page_id IN (${placeholders})
         ORDER BY pt.page_id ASC, pt.weight ASC, pt.id ASC`,
      ).bind(...chunk).all<LinkRow>()).results;
    } catch (error) {
      // A tags table predating weight / taxonomy_slug / parent_tag / lect — the
      // legacy shape the tags admin probes for — cannot answer that query at all.
      // Publish the links it has always published; the catalogue for those tags
      // then arrives on the next tag edit or from Admin → Tags → Sync published.
      console.error('Publish: tag catalogue unavailable for this schema', error);
      const links = await env.DB.prepare(tagLinksSql(placeholders))
        .bind(...chunk)
        .all<PublishSnapshotTag & { page_id: number }>();
      for (const { page_id, uuid, tag_id, weight, slug, name } of links.results) {
        entry(page_id).tags.push({ uuid, tag_id, weight, slug, name });
      }
      continue;
    }

    // Deduped per page, matching what the single-page read always returned: a
    // page linking the same tag twice catalogues it once.
    const catalogued = new Map<number, Set<number>>();
    for (const row of rows) {
      const target = entry(row.page_id);
      target.tags.push({
        uuid: row.uuid,
        tag_id: row.tag_id,
        weight: row.weight,
        slug: row.slug,
        name: row.name,
      });
      // A link whose tag row is gone (LEFT JOIN miss) has nothing to catalogue.
      if (!row.tag_uuid) continue;
      const seen = catalogued.get(row.page_id) ?? new Set<number>();
      catalogued.set(row.page_id, seen);
      if (seen.has(row.tag_id)) continue;
      seen.add(row.tag_id);
      target.tagCatalogue.push(toPublishedTag({
        id: row.tag_id,
        uuid: row.tag_uuid,
        name: row.name,
        slug: row.slug,
        weight: row.tag_weight,
        taxonomy_slug: row.taxonomy_slug,
        parent_tag: row.parent_tag,
        lect: row.lect,
      }));
    }
  }

  return byPage;
}

async function runOnAll(
  adapters: PublishAdapter[],
  run: (adapter: PublishAdapter) => Promise<void>,
): Promise<PublishOutcome> {
  const results = await Promise.allSettled(adapters.map((adapter) => run(adapter)));
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} failed:`, result.reason);
    }
  });
  return { targets: adapters.map((adapter) => adapter.id), failures };
}

/** Publishes a draft page to every configured target. Null when a missing draft
 * is looked up outside containment. Admission refusals precede the snapshot. */
export async function publishPageToTargets(env: Env, pageId: number, actor?: AuditActor): Promise<PublishOutcome | null> {
  if (regulatedWritesBlocked(env)) return refusal('writes_unavailable');
  const page = await env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return null;
  if (await isSubmissionMirror(env.DB, pageId)) return refusal('submission');

  const regulated = await regulatedPages(env, [page]);
  if (regulated.unavailable) return refusal('classification_unavailable');
  if (regulated.ids.has(page.id)) return refusal('regulated');

  const snapshot = (await buildSnapshots(env, [page]))[0];
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, async (adapter) => {
    await auditPublishTransfer(env, adapter, 'page', [snapshot.page], snapshot.tagCatalogue, actor);
    await adapter.publish(snapshot);
  });
}

/** Result of a bulk publish. `published` and `refused` are the input rows split
 *  by whether they reached the targets, so callers can attribute per-page
 *  outcomes without re-reading anything. `failures` is per-target for the whole
 *  slice, matching how unpublishPagesFromTargets reports. */
export interface BulkPublishOutcome {
  targets: string[];
  failures: string[];
  /** Pages handed to the targets, in input order. */
  published: Page[];
  /** Pages skipped before an adapter: all input under deployment containment;
   * otherwise submission mirrors first, then regulated pages. */
  refused: Page[];
  /** The regulated subset of `refused`. A policy refusal, not a structural one,
   *  so a caller that reports per-page outcomes can say which it was. */
  refusedRegulated: Page[];
  /** Whole-deployment containment; separate from record-level PHI refusals. */
  refusedReason?: 'writes_unavailable';
}

/**
 * Publishes many draft pages to every target in as few round-trips as possible.
 * Adapters that implement publishMany() write in bulk (D1: batched statements,
 * with the tag catalogue deduplicated across the slice; R2: one index rewrite
 * for the whole slice); the rest fall back to publish() per snapshot, in order.
 *
 * Callers pass pages they already hold, so nothing is re-read: the whole slice
 * costs one submission-mirror check and one tag read per chunk, where the
 * per-page path costs about six round trips each.
 *
 * Submission mirrors and regulated pages are refused exactly as in the
 * single-page path, and reported in `refused` instead of being sent to any
 * adapter. A classification outage refuses the whole slice.
 */
export async function publishPagesToTargets(env: Env, pages: Page[], actor?: AuditActor): Promise<BulkPublishOutcome> {
  if (regulatedWritesBlocked(env)) return { targets: [], failures: [], published: [], refused: pages,
    refusedRegulated: [], refusedReason: 'writes_unavailable' };
  const adapters = await getPublishAdapters(env);
  const targets = adapters.map((adapter) => adapter.id);
  const empty = { targets, failures: [], published: [], refused: [], refusedRegulated: [] };
  if (!pages.length) return empty;

  const mirrors = await submissionMirrorIds(env.DB, pages.map((page) => page.id));
  const candidates = pages.filter((page) => !mirrors.has(page.id));

  const regulated = await regulatedPages(env, candidates);
  const refusedRegulated = regulated.unavailable
    ? candidates
    : candidates.filter((page) => regulated.ids.has(page.id));
  const regulatedIds = new Set(refusedRegulated.map((page) => page.id));

  const refused = [...pages.filter((page) => mirrors.has(page.id)), ...refusedRegulated];
  const publishable = candidates.filter((page) => !regulatedIds.has(page.id));
  // Without a configured target there is nothing to fan out to, but the pages
  // still count as handled — the single-page path reports the same empty
  // `targets` and leaves the caller to decide what that means.
  if (!publishable.length || !adapters.length) {
    return { targets, failures: [], published: publishable, refused, refusedRegulated };
  }

  const snapshots = await buildSnapshots(env, publishable);
  const failures: string[] = [];
  const results = await Promise.allSettled(adapters.map(async (adapter) => {
    if (adapter.publishMany) {
      await auditPublishTransfer(env, adapter, 'page', snapshots.map(s => s.page), snapshots.flatMap(s => s.tagCatalogue), actor);
      await adapter.publishMany(snapshots);
    } else {
      for (const snapshot of snapshots) {
        await auditPublishTransfer(env, adapter, 'page', [snapshot.page], snapshot.tagCatalogue, actor);
        await adapter.publish(snapshot);
      }
    }
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} bulk publish failed:`, result.reason);
    }
  });

  return { targets, failures, published: publishable, refused, refusedRegulated };
}

/**
 * Removes a page from every configured target. Callers that have the page at
 * hand must pass its submission marker so source mirrors are refused.
 */
export async function unpublishPageFromTargets(env: Env, uuid: string, isSubmission = false, actor?: AuditActor): Promise<PublishOutcome> {
  if (isSubmission) return refusal('submission');
  const adapters = await getPublishAdapters(env);
  const auditFailures = new Set<string>();
  let metadata: Promise<WithdrawalRead[]> | undefined;
  const outcome = await runOnAll(adapters, async (adapter) => {
    if (!await auditWithdrawal(env, adapter, 'unpublish', [uuid], () => metadata ??= withdrawalReads(env, 'unpublish', [uuid]), actor)) auditFailures.add(adapter.id);
    await adapter.unpublish(uuid);
  });
  return { ...outcome, ...(auditFailures.size ? { auditFailures: outcome.targets.filter(id => auditFailures.has(id)) } : {}) };
}

/** Result of a bulk unpublish: `refusedCount` is how many pages were submission
 *  mirrors (skipped, never deleted), so callers can fold it into their metrics. */
export interface BulkUnpublishOutcome {
  targets: string[];
  failures: string[];
  auditFailures?: string[];
  refusedCount: number;
}

/**
 * Removes many pages from every target in as few round-trips as possible.
 * Adapters that implement unpublishMany() delete in bulk (D1: one batch per
 * chunk; R2: one multi-key delete + a single index rewrite); the rest fall back
 * to unpublish() per uuid. Submission mirrors are refused exactly as in the
 * single-page path — publishing/unpublishing one would touch the shared live
 * row — and counted in `refusedCount` instead of being sent to any adapter.
 */
export async function unpublishPagesFromTargets(
  env: Env,
  pages: Array<{ uuid: string; submission_origin?: number | boolean }>,
  actor?: AuditActor,
): Promise<BulkUnpublishOutcome> {
  const targetable = pages.filter((page) => !page.submission_origin);
  const refusedCount = pages.length - targetable.length;
  const uuids = Array.from(new Set(targetable.map((page) => page.uuid)));
  const adapters = await getPublishAdapters(env);
  const targets = adapters.map((adapter) => adapter.id);
  if (!uuids.length || !adapters.length) return { targets, failures: [], refusedCount };

  const failures: string[] = [];
  const auditFailures = new Set<string>();
  let metadata: Promise<WithdrawalRead[]> | undefined;
  const results = await Promise.allSettled(adapters.map(async (adapter) => {
    const reads = () => metadata ??= withdrawalReads(env, 'unpublish', uuids);
    if (adapter.unpublishMany) {
      if (!await auditWithdrawal(env, adapter, 'unpublish', uuids, reads, actor)) auditFailures.add(adapter.id);
      await adapter.unpublishMany(uuids);
    } else {
      for (const uuid of uuids) {
        if (!await auditWithdrawal(env, adapter, 'unpublish', [uuid], async () => (await reads()).filter(read => read.withdrawalUuid === uuid), actor)) auditFailures.add(adapter.id);
        await adapter.unpublish(uuid);
      }
    }
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} bulk unpublish failed:`, result.reason);
    }
  });
  return { targets, failures, refusedCount, ...(auditFailures.size ? { auditFailures: targets.filter(id => auditFailures.has(id)) } : {}) };
}

/** Drops a deleted tag from targets that support it (best effort elsewhere). */
export async function removeTagFromTargets(env: Env, tagId: number, actor?: AuditActor): Promise<PublishOutcome> {
  const adapters = (await getPublishAdapters(env)).filter((adapter) => adapter.removeTag);
  const auditFailures = new Set<string>();
  let metadata: Promise<WithdrawalRead[]> | undefined;
  const outcome = await runOnAll(adapters, async (adapter) => {
    if (!await auditWithdrawal(env, adapter, 'remove-tag', [String(tagId)], () => metadata ??= withdrawalReads(env, 'remove-tag', [String(tagId)]), actor)) auditFailures.add(adapter.id);
    await adapter.removeTag!(tagId);
  });
  return { ...outcome, ...(auditFailures.size ? { auditFailures: outcome.targets.filter(id => auditFailures.has(id)) } : {}) };
}

/** Tag ids per read, bounded by D1's cap on bound parameters. */
const TAG_ID_CHUNK = 90;

/** Tags handed to a target per call; adapters that batch turn one into a trip. */
const TAG_SYNC_CHUNK = 45;

/**
 * Reads a tag in the shape targets want. Tolerates a tag table that predates
 * `weight` / `taxonomy_slug` — the same legacy shape the tags admin probes for
 * (see tagSchema in routes/admin/tags.ts) — so a resync on an old database
 * mirrors what it has instead of failing.
 */
function toPublishedTag(row: Record<string, unknown>): PublishedTag {
  return {
    id: Number(row.id),
    uuid: String(row.uuid),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    weight: typeof row.weight === 'number' ? row.weight : 5,
    taxonomy_slug: (row.taxonomy_slug as string | null) ?? null,
    parent_tag: (row.parent_tag as number | null) ?? null,
    lect: (row.lect as string | null) ?? null,
  };
}

/** Every tag, or just the named ones, read in parameter-cap-sized chunks. */
async function readTags(env: Env, tagIds?: number[], taxonomyRequired = false): Promise<PublishedTag[]> {
  // Old schemas may omit taxonomy_slug only when no taxonomy policy depends
  // on it. Never turn an unknowable regulated taxonomy into the default one.
  const fields = taxonomyRequired ? '*, taxonomy_slug' : '*';
  if (!tagIds) {
    const rows = await env.DB.prepare(`SELECT ${fields} FROM tags ORDER BY id`).all<Record<string, unknown>>();
    return rows.results.map(toPublishedTag);
  }
  const unique = Array.from(new Set(tagIds));
  const tags: PublishedTag[] = [];
  for (let index = 0; index < unique.length; index += TAG_ID_CHUNK) {
    const chunk = unique.slice(index, index + TAG_ID_CHUNK);
    const rows = await env.DB.prepare(`SELECT ${fields} FROM tags WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<Record<string, unknown>>();
    tags.push(...rows.results.map(toPublishedTag));
  }
  return tags;
}

/**
 * Pushes tags to every target that keeps a catalogue, so a rename or a
 * re-grouping reaches readers immediately instead of waiting for every page
 * carrying the tag to be republished. Pass no ids to resync the whole table.
 * `count` is how many tags were actually found and sent.
 */
export async function publishTagsToTargets(
  env: Env,
  tagIds?: number[],
  actor?: AuditActor,
): Promise<PublishOutcome & { count: number; refusedCount?: number }> {
  if (regulatedWritesBlocked(env)) return { ...refusal('writes_unavailable'), count: 0 };
  const adapters = (await getPublishAdapters(env)).filter((adapter) => adapter.publishTags);
  const targets = adapters.map((adapter) => adapter.id);
  if (!adapters.length || (tagIds && !tagIds.length)) return { targets, failures: [], count: 0 };
  const classes = await resolveDataClasses(env, true);
  if (!classes.ok) return { ...refusal('classification_unavailable'), count: 0 };
  let found: PublishedTag[];
  try {
    found = await readTags(env, tagIds, [...classes.exact.keys()].some(key => key.startsWith('taxonomy:')));
  } catch (error) {
    console.error('Publish: tag classification source unavailable', error);
    return { ...refusal('classification_unavailable'), count: 0 };
  }
  if (found.some(tag => !inventoried(env, 'taxonomy', tag.taxonomy_slug ?? 'default'))) {
    return { ...refusal('classification_unavailable'), count: 0 };
  }
  const tags = found.filter(tag => classFor(classes, 'taxonomy', tag.taxonomy_slug ?? 'default') !== 'phi');
  const refusedCount = found.length - tags.length;
  if (refusedCount && !tags.length) return { ...refusal('regulated'), count: 0, refusedCount };
  if (!tags.length) return { targets, failures: [], count: 0 };
  // Chunked so resyncing a large tag table stays inside the subrequest budget:
  // an adapter that batches (D1) turns each chunk into one round-trip.
  const outcome = await runOnAll(adapters, async (adapter) => {
    for (let index = 0; index < tags.length; index += TAG_SYNC_CHUNK) {
      const chunk = tags.slice(index, index + TAG_SYNC_CHUNK);
      await auditPublishTransfer(env, adapter, 'tags', [], chunk, actor);
      await adapter.publishTags!(chunk);
    }
  });
  return { ...outcome, count: tags.length, ...(refusedCount ? { refusedCount } : {}) };
}

/** Pushes one tag, after an admin create or edit. */
export async function publishTagToTargets(env: Env, tagId: number, actor?: AuditActor): Promise<PublishOutcome> {
  return publishTagsToTargets(env, [tagId], actor);
}

/** First configured adapter that can answer live-state reads, if any. */
async function liveReader(env: Env): Promise<PublishAdapter | null> {
  const adapters = await getPublishAdapters(env);
  return adapters.find((adapter) => adapter.liveMap && adapter.listLiveByTypes) ?? null;
}

export async function getLiveLect(env: Env, uuid: string, actor?: AuditActor): Promise<string | null> {
  const reader = await liveReader(env);
  if (!reader) return null;
  const pages = [...(await reader.liveMap!([uuid])).values()];
  await auditLiveReads(env, reader, pages, actor);
  return pages.find(page => page.uuid === uuid)?.lect ?? null;
}

export async function liveMapForDraftPages(env: Env, draftPages: Page[], actor?: AuditActor): Promise<Map<string, LivePageSnapshot>> {
  const reader = await liveReader(env);
  if (!reader) return new Map();
  const uuids = Array.from(new Set(draftPages.map((page) => page.uuid)));
  if (!uuids.length) return new Map();
  const combined = new Map<string, LivePageSnapshot>();
  for (let index = 0; index < uuids.length; index += 90) {
    const chunk = uuids.slice(index, index + 90);
    const liveMap = await reader.liveMap!(chunk);
    liveMap.forEach((page, uuid) => combined.set(uuid, page));
  }
  await auditLiveReads(env, reader, [...combined.values()], actor);
  return combined;
}

export async function listLiveByTypes(env: Env, pageTypes: string[], actor?: AuditActor): Promise<LivePageSnapshot[]> {
  const reader = await liveReader(env);
  if (!reader) return [];
  const pages = await reader.listLiveByTypes!(pageTypes);
  await auditLiveReads(env, reader, pages, actor);
  return pages;
}

/** Human-readable flash fragment for a partially failed publish. */
export function describeFailures(outcome: PublishOutcome): string | null {
  if (!outcome.failures.length) return null;
  return outcome.failures.join(', ');
}
