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

export interface PublishOutcome {
  /** Targets that were attempted, in order. */
  targets: string[];
  /** Target ids whose publish/unpublish threw. */
  failures: string[];
  /**
   * Set when the page is a submission mirror: publishing one would upsert the
   * original live row it shares a uuid with, and unpublishing/trashing one
   * would DELETE that live row — so both are refused before reaching any adapter.
   */
  refused?: boolean;
}

const REFUSED_OUTCOME: PublishOutcome = { targets: [], failures: [], refused: true };

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

async function buildSnapshot(env: Env, pageId: number): Promise<PublishSnapshot | null> {
  const page = await env.DB.prepare('SELECT * FROM pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return null;
  return (await buildSnapshots(env, [page]))[0];
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

/** Publishes a draft page to every configured target. Null when the draft is missing. */
export async function publishPageToTargets(env: Env, pageId: number): Promise<PublishOutcome | null> {
  const snapshot = await buildSnapshot(env, pageId);
  if (!snapshot) return null;
  if (await isSubmissionMirror(env.DB, pageId)) return REFUSED_OUTCOME;
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.publish(snapshot));
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
  /** Submission mirrors, skipped before any adapter saw them. */
  refused: Page[];
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
 * Submission mirrors are refused exactly as in the single-page path — writing
 * one would upsert the live row it shares a uuid with — and reported in
 * `refused` instead of being sent to any adapter.
 */
export async function publishPagesToTargets(env: Env, pages: Page[]): Promise<BulkPublishOutcome> {
  const adapters = await getPublishAdapters(env);
  const targets = adapters.map((adapter) => adapter.id);
  if (!pages.length) return { targets, failures: [], published: [], refused: [] };

  const mirrors = await submissionMirrorIds(env.DB, pages.map((page) => page.id));
  const refused = pages.filter((page) => mirrors.has(page.id));
  const publishable = pages.filter((page) => !mirrors.has(page.id));
  // Without a configured target there is nothing to fan out to, but the pages
  // still count as handled — the single-page path reports the same empty
  // `targets` and leaves the caller to decide what that means.
  if (!publishable.length || !adapters.length) {
    return { targets, failures: [], published: publishable, refused };
  }

  const snapshots = await buildSnapshots(env, publishable);
  const failures: string[] = [];
  const results = await Promise.allSettled(adapters.map((adapter) => (
    adapter.publishMany
      ? adapter.publishMany(snapshots)
      : snapshots.reduce<Promise<void>>(
        (prior, snapshot) => prior.then(() => adapter.publish(snapshot)),
        Promise.resolve(),
      )
  )));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} bulk publish failed:`, result.reason);
    }
  });

  return { targets, failures, published: publishable, refused };
}

/**
 * Removes a page from every configured target. Callers that have the page at
 * hand must pass its submission marker so source mirrors are refused.
 */
export async function unpublishPageFromTargets(env: Env, uuid: string, isSubmission = false): Promise<PublishOutcome> {
  if (isSubmission) return REFUSED_OUTCOME;
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.unpublish(uuid));
}

/** Result of a bulk unpublish: `refusedCount` is how many pages were submission
 *  mirrors (skipped, never deleted), so callers can fold it into their metrics. */
export interface BulkUnpublishOutcome {
  targets: string[];
  failures: string[];
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
): Promise<BulkUnpublishOutcome> {
  const targetable = pages.filter((page) => !page.submission_origin);
  const refusedCount = pages.length - targetable.length;
  const uuids = Array.from(new Set(targetable.map((page) => page.uuid)));
  const adapters = await getPublishAdapters(env);
  const targets = adapters.map((adapter) => adapter.id);
  if (!uuids.length || !adapters.length) return { targets, failures: [], refusedCount };

  const failures: string[] = [];
  const results = await Promise.allSettled(adapters.map((adapter) => (
    adapter.unpublishMany
      ? adapter.unpublishMany(uuids)
      : uuids.reduce<Promise<void>>((prior, uuid) => prior.then(() => adapter.unpublish(uuid)), Promise.resolve())
  )));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} bulk unpublish failed:`, result.reason);
    }
  });
  return { targets, failures, refusedCount };
}

/** Drops a deleted tag from targets that support it (best effort elsewhere). */
export async function removeTagFromTargets(env: Env, tagId: number): Promise<PublishOutcome> {
  const adapters = (await getPublishAdapters(env)).filter((adapter) => adapter.removeTag);
  return runOnAll(adapters, (adapter) => adapter.removeTag!(tagId));
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
async function readTags(env: Env, tagIds?: number[]): Promise<PublishedTag[]> {
  if (!tagIds) {
    const rows = await env.DB.prepare('SELECT * FROM tags ORDER BY id').all<Record<string, unknown>>();
    return rows.results.map(toPublishedTag);
  }
  const unique = Array.from(new Set(tagIds));
  const tags: PublishedTag[] = [];
  for (let index = 0; index < unique.length; index += TAG_ID_CHUNK) {
    const chunk = unique.slice(index, index + TAG_ID_CHUNK);
    const rows = await env.DB.prepare(`SELECT * FROM tags WHERE id IN (${chunk.map(() => '?').join(',')})`)
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
): Promise<PublishOutcome & { count: number }> {
  const adapters = (await getPublishAdapters(env)).filter((adapter) => adapter.publishTags);
  const targets = adapters.map((adapter) => adapter.id);
  if (!adapters.length || (tagIds && !tagIds.length)) return { targets, failures: [], count: 0 };
  const tags = await readTags(env, tagIds);
  if (!tags.length) return { targets, failures: [], count: 0 };
  // Chunked so resyncing a large tag table stays inside the subrequest budget:
  // an adapter that batches (D1) turns each chunk into one round-trip.
  const outcome = await runOnAll(adapters, async (adapter) => {
    for (let index = 0; index < tags.length; index += TAG_SYNC_CHUNK) {
      await adapter.publishTags!(tags.slice(index, index + TAG_SYNC_CHUNK));
    }
  });
  return { ...outcome, count: tags.length };
}

/** Pushes one tag, after an admin create or edit. */
export async function publishTagToTargets(env: Env, tagId: number): Promise<PublishOutcome> {
  return publishTagsToTargets(env, [tagId]);
}

/** First configured adapter that can answer live-state reads, if any. */
async function liveReader(env: Env): Promise<PublishAdapter | null> {
  const adapters = await getPublishAdapters(env);
  return adapters.find((adapter) => adapter.liveMap && adapter.getLiveLect && adapter.listLiveByTypes) ?? null;
}

export async function getLiveLect(env: Env, uuid: string): Promise<string | null> {
  const reader = await liveReader(env);
  return reader ? reader.getLiveLect!(uuid) : null;
}

export async function liveMapForDraftPages(env: Env, draftPages: Page[]): Promise<Map<string, LivePageSnapshot>> {
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
  return combined;
}

export async function listLiveByTypes(env: Env, pageTypes: string[]): Promise<LivePageSnapshot[]> {
  const reader = await liveReader(env);
  return reader ? reader.listLiveByTypes!(pageTypes) : [];
}

/** Human-readable flash fragment for a partially failed publish. */
export function describeFailures(outcome: PublishOutcome): string | null {
  if (!outcome.failures.length) return null;
  return outcome.failures.join(', ');
}
