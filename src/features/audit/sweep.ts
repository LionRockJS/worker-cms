// ============================================================
// The audit archive and retention sweep.
//
// D1 is SQLite with a size ceiling and no append-only mode, so it is the right
// place to query recent audit events and the wrong place to keep six years of
// them. Each run moves one bounded segment to R2 as gzipped NDJSON, records a
// seal for it, and only then prunes the rows it has archived.
//
// Three rules the ordering exists to keep:
//
//   - nothing is pruned that was not archived. No bucket, no sweep at all:
//     losing the trail is worse than letting D1 grow.
//   - the archive is written before the seal, so a crash between the two
//     re-archives the same range to the same key on the next run rather than
//     leaving a sealed range with no object.
//   - seals chain. A segment cannot be swapped in isolation, because every
//     later seal's rolling_hash covers it.
//
// See docs/access-logging-design-2026-10-29.md.
// ============================================================

import type { Env } from '../../types';

/** Events per segment. Bounded so one cron tick cannot exceed the CPU budget
 *  gzipping and hashing, nor D1's result-size limit reading them. */
const SEGMENT_SIZE = 1000;

/** Rows a single run may prune, so a long backlog drains over several ticks
 *  instead of timing out on one. */
const PRUNE_LIMIT = 2000;

/**
 * Days each retention class stays queryable in D1. The archive keeps its own,
 * longer horizon; this is only how long the hot copy lives.
 *
 * HIPAA pulls retention up and GDPR's storage limitation pulls it down, which
 * is why this is per class rather than one number.
 */
const HOT_DAYS: Record<string, number> = {
  phi_access: 90,
  phi_mutation: 365,
  content_mutation: 365,
  pii_access: 90,
  auth: 90,
  admin_config: 365,
  none: 90,
};

/** Anything unrecognised keeps the most conservative horizon rather than the
 *  shortest, so a new class added without touching this file is not swept away. */
const DEFAULT_HOT_DAYS = 365;

export interface SweepResult {
  /** Events written to the archive this run. */
  archived: number;
  /** Rows deleted from D1 this run. */
  pruned: number;
  /** The segment key written, when one was. */
  key: string | null;
  /** Why the sweep did nothing, when it did nothing. */
  skipped?: 'no_bucket' | 'nothing_to_archive';
}

interface SealRow {
  last_seq: number;
  rolling_hash: string;
}

/** The columns a segment carries, in a fixed order so the hash is reproducible. */
const SEGMENT_COLUMNS = [
  'seq', 'event_id', 'occurred_at', 'event_class', 'data_class', 'retention_class',
  'action', 'outcome', 'actor_user_id', 'actor_roles', 'acting_via', 'session_sid',
  'request_id', 'source_ip', 'user_agent', 'target_type', 'target_id', 'target_ids',
  'target_count', 'container_key', 'query_fingerprint', 'detail',
] as const;

type SegmentRow = Record<typeof SEGMENT_COLUMNS[number], unknown>;

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The segment's canonical form: one JSON object per line, keys in
 * SEGMENT_COLUMNS order. Canonical because the hash has to be recomputable
 * from the archived bytes years later, by code that must not depend on how a
 * driver happened to order columns.
 */
export function canonicalSegment(rows: SegmentRow[]): string {
  return rows.map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const column of SEGMENT_COLUMNS) ordered[column] = row[column] ?? null;
    return JSON.stringify(ordered);
  }).join('\n') + (rows.length ? '\n' : '');
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(body: ArrayBuffer): Promise<string> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** `audit/dt=2026-10-30/seg-000000001234-000000002233.ndjson.gz` — date
 *  partitioned so the archive is queryable in place by Athena or Synapse, and
 *  zero padded so keys sort in seq order. */
function segmentKey(firstSeq: number, lastSeq: number, occurredAt: string): string {
  const day = occurredAt.slice(0, 10);
  const pad = (value: number) => String(value).padStart(12, '0');
  return `audit/dt=${day}/seg-${pad(firstSeq)}-${pad(lastSeq)}.ndjson.gz`;
}

/**
 * Archives one segment and prunes what retention no longer keeps hot.
 *
 * Returns what it did rather than throwing on an empty run, because this is
 * called from a cron tick that logs its own result.
 */
export async function sweepAuditEvents(env: Env): Promise<SweepResult> {
  const bucket = env.AUDIT_BUCKET;
  // No archive means no sweep. Pruning without somewhere to put the rows first
  // would destroy the trail the whole mechanism exists to keep.
  if (!bucket) return { archived: 0, pruned: 0, key: null, skipped: 'no_bucket' };

  const lastSeal = await env.DB.prepare(
    'SELECT last_seq, rolling_hash FROM audit_seals ORDER BY last_seq DESC LIMIT 1',
  ).first<SealRow>();
  const cursor = lastSeal?.last_seq ?? 0;

  const columns = SEGMENT_COLUMNS.join(', ');
  const rows = await env.DB.prepare(
    `SELECT ${columns} FROM audit_events WHERE seq > ? ORDER BY seq LIMIT ?`,
  ).bind(cursor, SEGMENT_SIZE).all<SegmentRow>();

  let archived = 0;
  let key: string | null = null;
  if (rows.results.length) {
    const first = rows.results[0];
    const last = rows.results[rows.results.length - 1];
    const firstSeq = Number(first.seq);
    const lastSeq = Number(last.seq);
    const ndjson = canonicalSegment(rows.results);
    const segmentHash = await sha256Hex(ndjson);
    const prevHash = lastSeal?.rolling_hash ?? null;
    const rollingHash = await sha256Hex(`${prevHash ?? ''}${segmentHash}`);
    key = segmentKey(firstSeq, lastSeq, String(first.occurred_at));

    // Archive first. A failure here leaves the range unsealed, so the next run
    // retries it; the reverse order could seal a range with no object behind it.
    await bucket.put(key, await gzip(ndjson), {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      customMetadata: { firstSeq: String(firstSeq), lastSeq: String(lastSeq), segmentHash },
    });

    await env.DB.prepare(
      `INSERT INTO audit_seals
         (first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, sealed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      firstSeq,
      lastSeq,
      rows.results.length,
      segmentHash,
      prevHash,
      rollingHash,
      key,
      new Date().toISOString(),
    ).run();
    archived = rows.results.length;
  }

  const pruned = await pruneArchived(env);
  if (!archived && !pruned) return { archived: 0, pruned: 0, key: null, skipped: 'nothing_to_archive' };
  return { archived, pruned, key };
}

/**
 * Deletes rows that are both archived and past their class's hot window.
 * Scoped to `seq <= the highest sealed seq`, so an unarchived row can never be
 * deleted however old it is.
 */
async function pruneArchived(env: Env): Promise<number> {
  const sealedTo = await env.DB.prepare('SELECT MAX(last_seq) AS sealed FROM audit_seals')
    .first<{ sealed: number | null }>();
  const ceiling = sealedTo?.sealed ?? 0;
  if (!ceiling) return 0;

  // One statement per class: SQLite has no per-row window function here, and
  // each class has its own cutoff. The subselect bounds the work per run.
  let pruned = 0;
  for (const [retentionClass, days] of Object.entries(HOT_DAYS)) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const result = await env.DB.prepare(
      `DELETE FROM audit_events WHERE seq IN (
         SELECT seq FROM audit_events
          WHERE seq <= ? AND retention_class = ? AND occurred_at < ?
          LIMIT ?
       )`,
    ).bind(ceiling, retentionClass, cutoff, PRUNE_LIMIT).run();
    pruned += result.meta.changes ?? 0;
    if (pruned >= PRUNE_LIMIT) break;
  }
  return pruned;
}

/** Unrecognised retention classes keep the conservative horizon. */
export function hotDaysFor(retentionClass: string): number {
  return HOT_DAYS[retentionClass] ?? DEFAULT_HOT_DAYS;
}

export interface SealVerification {
  r2Key: string;
  firstSeq: number;
  lastSeq: number;
  /** False when the archived bytes no longer hash to what was sealed. */
  contentOk: boolean;
  /** False when this seal does not chain onto the previous one. */
  chainOk: boolean;
  /** Set when the object is gone from the bucket entirely. */
  missing?: true;
}

/**
 * Recomputes every seal from the archived bytes.
 *
 * This is the check an auditor asks for: it proves the archive still hashes to
 * what was recorded at the time, and that no segment has been replaced — a
 * swapped object fails its own `segment_hash`, and a swapped *seal* fails the
 * chain of every seal after it.
 */
export async function verifyAuditArchive(env: Env, limit = 100): Promise<SealVerification[]> {
  const bucket = env.AUDIT_BUCKET;
  if (!bucket) return [];

  const seals = await env.DB.prepare(
    `SELECT first_seq, last_seq, segment_hash, prev_hash, rolling_hash, r2_key
       FROM audit_seals ORDER BY last_seq LIMIT ?`,
  ).bind(limit).all<{
    first_seq: number;
    last_seq: number;
    segment_hash: string;
    prev_hash: string | null;
    rolling_hash: string;
    r2_key: string;
  }>();

  const results: SealVerification[] = [];
  let expectedPrev: string | null = null;
  for (const seal of seals.results) {
    const object = await bucket.get(seal.r2_key);
    const chainOk = (seal.prev_hash ?? null) === expectedPrev
      && seal.rolling_hash === await sha256Hex(`${seal.prev_hash ?? ''}${seal.segment_hash}`);
    if (!object) {
      results.push({
        r2Key: seal.r2_key,
        firstSeq: seal.first_seq,
        lastSeq: seal.last_seq,
        contentOk: false,
        chainOk,
        missing: true,
      });
    } else {
      const ndjson = await gunzip(await object.arrayBuffer());
      results.push({
        r2Key: seal.r2_key,
        firstSeq: seal.first_seq,
        lastSeq: seal.last_seq,
        contentOk: await sha256Hex(ndjson) === seal.segment_hash,
        chainOk,
      });
    }
    expectedPrev = seal.rolling_hash;
  }
  return results;
}
