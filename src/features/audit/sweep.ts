// ============================================================
// The audit archive and retention sweep.
//
// D1 is SQLite with a size ceiling and no append-only mode, so it is the right
// place to query recent audit events and the wrong place to keep six years of
// them. Each run moves one bounded segment to R2 as gzipped NDJSON, records a
// seal for it, reads it back, and only then prunes the rows it has archived.
//
// The rules the ordering exists to keep:
//
//   - nothing is pruned that was not archived *and read back*. No bucket, no
//     sweep at all; and the prune ceiling is the last seal whose object was
//     fetched and still hashed to what was sealed, not merely the last seal.
//   - one candidate segment per chain position, frozen in D1 before the object
//     is written. A crash between the write and the seal resumes that exact
//     range; an object already at the key is checked, never overwritten.
//   - one runner at a time, and no forks even without it. A lease serialises
//     cron ticks, and the seal insert is a compare-and-swap on the chain head,
//     so a runner whose lease lapsed mid-run cannot seal a second branch.
//   - seals chain, and the chain leaves the database. Every later seal's
//     rolling_hash covers each segment, each object carries its own link, and
//     verified checkpoints go to the independent receiver — because a chain
//     whose only copy sits in the D1 it protects can be rewritten with it.
//
// See docs/access-logging-design-2026-10-29.md and docs/w5-archive-protection.md.
// ============================================================

import type { Env } from '../../types';
import type { AuditRow } from '../../core/db/audit';
import { monitorSource, recordAuditOutage } from '../../core/db/audit-outages';

/** Events per segment. Bounded so one cron tick cannot exceed the CPU budget
 *  gzipping and hashing, nor D1's result-size limit reading them. */
const SEGMENT_SIZE = 1000;

/** Rows a single run may prune, so a long backlog drains over several ticks
 *  instead of timing out on one. */
const PRUNE_LIMIT = 2000;

/** Seals read back from R2 per run before the prune ceiling may move. */
const VERIFY_LIMIT = 10;

/** Checkpoints handed to the independent receiver per run. */
const ANCHOR_LIMIT = 10;

/** Archive keys the orphan reconciler lists per run. Each is bound three times
 *  in one lookup, and D1 binds at most 100 parameters. */
const ORPHAN_SCAN_LIMIT = 30;

/** Sealed segments an orphan may be compared against line by line. */
const ORPHAN_COMPARE_SEALS = 4;

/** Outlasts one bounded run; short enough that a crashed run holding it only
 *  delays the archive by a couple of ticks. Correctness never depends on it —
 *  the seal compare-and-swap does — it only stops two runners doing the work twice. */
export const LEASE_MS = 10 * 60_000;

const ARCHIVE_PREFIX = 'audit/';
const SEGMENT_KEY = /^audit\/dt=\d{4}-\d{2}-\d{2}\/seg-(\d{12})-(\d{12})\.ndjson\.gz$/;

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

/** Coarse, PHI-free reasons the archive stopped making progress. */
export type ArchiveFaultKind =
  | 'bucket-missing'       // no AUDIT_BUCKET binding
  | 'bucket-unavailable'   // R2 refused or failed a request
  | 'segment-drift'        // D1 rows no longer hash to the frozen intent
  | 'segment-conflict'     // an object already at the key holds other bytes
  | 'seal-conflict'        // the chain head moved without this intent
  | 'verification-failed'  // a sealed object is missing, corrupt or off-chain
  | 'anchor-conflict'      // the receiver holds a different checkpoint
  | 'orphan';              // an object with no seal that is not a superseded copy

export interface SweepResult {
  /** Events written to the archive this run. */
  archived: number;
  /** Rows deleted from D1 this run. */
  pruned: number;
  /** The segment key written, when one was. */
  key: string | null;
  /** Why the sweep did nothing, when it did nothing. */
  skipped?: 'no_bucket' | 'nothing_to_archive' | 'claimed';
  /** Prune ceiling after this run: the last seq read back and verified. */
  verifiedSeq?: number;
  /** Last seq whose checkpoint the independent receiver accepted. */
  anchoredSeq?: number;
  /** The first fault this run hit; reported through the outage path. */
  fault?: ArchiveFaultKind;
}

interface SealRecord {
  first_seq: number;
  last_seq: number;
  event_count: number;
  segment_hash: string;
  prev_hash: string | null;
  rolling_hash: string;
  r2_key: string;
  sealed_at: string;
}

interface Intent {
  cursor_seq: number;
  first_seq: number;
  last_seq: number;
  event_count: number;
  segment_hash: string;
  prev_hash: string | null;
  rolling_hash: string;
  r2_key: string;
  format: number;
}

interface ArchiveState {
  verified_seq: number;
  verified_hash: string | null;
  anchored_seq: number;
  fault: string | null;
  orphan_cursor: string | null;
}

/**
 * The columns each canonical segment format carries, in a fixed order so the
 * hash is reproducible. This is the archive's event contract: archiving a new
 * audit_events column means adding format 2 here, never editing format 1,
 * because a frozen intent names the format its hash was computed in.
 */
const SEGMENT_FORMATS: Record<number, readonly string[]> = {
  1: [
    'seq', 'event_id', 'occurred_at', 'event_class', 'data_class', 'retention_class',
    'action', 'outcome', 'actor_user_id', 'actor_roles', 'acting_via', 'session_sid',
    'request_id', 'source_ip', 'user_agent', 'target_type', 'target_id', 'target_ids',
    'target_count', 'container_key', 'query_fingerprint', 'detail',
  ],
};

/** The format new segments are written in. */
export const CURRENT_SEGMENT_FORMAT = 1;

type SegmentRow = Record<string, unknown>;

/** A fault the sweep reports and recovers from, as opposed to a D1 failure,
 *  which propagates: with no database there is no state to recover into. */
class ArchiveFault extends Error {
  constructor(readonly kind: ArchiveFaultKind, readonly key: string | null = null) {
    super(kind);
  }
}

/** R2 failures become a coarse fault, so the run reports them and retries. */
async function r2<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch {
    throw new ArchiveFault('bucket-unavailable');
  }
}

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The segment's canonical form: one JSON object per line, keys in the format's
 * column order. Canonical because the hash has to be recomputable from the
 * archived bytes years later, by code that must not depend on how a driver
 * happened to order columns.
 */
export function canonicalSegment(rows: SegmentRow[], format = CURRENT_SEGMENT_FORMAT): string {
  const columns = SEGMENT_FORMATS[format];
  if (!columns) throw new Error(`Unknown segment format ${format}`);
  return rows.map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const column of columns) ordered[column] = row[column] ?? null;
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

/** The decompressed text of an object, or null when it is not valid gzip. */
async function objectText(object: R2ObjectBody): Promise<string | null> {
  const bytes = await r2(object.arrayBuffer());
  return gunzip(bytes).catch(() => null);
}

/** `audit/dt=2026-10-30/seg-000000001234-000000002233.ndjson.gz` — date
 *  partitioned so the archive is queryable in place by Athena or Synapse, and
 *  zero padded so keys sort in seq order. */
function segmentKey(firstSeq: number, lastSeq: number, occurredAt: string): string {
  const day = occurredAt.slice(0, 10);
  const pad = (value: number) => String(value).padStart(12, '0');
  return `audit/dt=${day}/seg-${pad(firstSeq)}-${pad(lastSeq)}.ndjson.gz`;
}

async function readState(env: Env): Promise<ArchiveState> {
  const state = await env.DB.prepare(
    `SELECT verified_seq, verified_hash, anchored_seq, fault, orphan_cursor
       FROM audit_archive_state WHERE id = 1`,
  ).first<ArchiveState>();
  return state ?? { verified_seq: 0, verified_hash: null, anchored_seq: 0, fault: null, orphan_cursor: null };
}

/** Takes the sweep lease when it is free or expired. RETURNING rather than
 *  meta.changes, which also counts trigger writes. */
async function claimLease(env: Env, holder: string): Promise<boolean> {
  const now = Date.now();
  const [, claimed] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO audit_archive_state (id) VALUES (1)'),
    env.DB.prepare(
      `UPDATE audit_archive_state SET lease_holder = ?, lease_expires_at = ?
        WHERE id = 1 AND (lease_holder IS NULL OR lease_expires_at <= ?)
        RETURNING lease_holder`,
    ).bind(holder, now + LEASE_MS, now),
  ]);
  return claimed.results.length === 1;
}

async function releaseLease(env: Env, holder: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE audit_archive_state SET lease_holder = NULL, lease_expires_at = 0 WHERE id = 1 AND lease_holder = ?',
  ).bind(holder).run();
}

async function readIntent(env: Env, cursor: number): Promise<Intent | null> {
  return env.DB.prepare(
    `SELECT cursor_seq, first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, format
       FROM audit_archive_intents WHERE cursor_seq = ?`,
  ).bind(cursor).first<Intent>();
}

/**
 * Extends the chain by one segment: freeze, write (or check), seal.
 *
 * Every decision that matters is a conditional write on the primary — the
 * freeze, the seal — so a stale read from a replica, a lapsed lease or a
 * concurrent runner can waste work but cannot fork the chain.
 */
async function advanceArchive(env: Env, bucket: R2Bucket): Promise<{ archived: number; key: string | null }> {
  const head = await env.DB.prepare(
    'SELECT last_seq, rolling_hash FROM audit_seals ORDER BY last_seq DESC LIMIT 1',
  ).first<{ last_seq: number; rolling_hash: string }>();
  const cursor = head?.last_seq ?? 0;

  // An intent behind the head was overtaken by a seal written some other way —
  // an older Worker version during rollout. The row no longer describes
  // anything sealable; an object it left behind is the orphan reconciler's.
  await env.DB.prepare('DELETE FROM audit_archive_intents WHERE cursor_seq < ?').bind(cursor).run();

  let intent = await readIntent(env, cursor);
  let ndjson: string | null = null;
  if (!intent) {
    const format = CURRENT_SEGMENT_FORMAT;
    const rows = await env.DB.prepare(
      `SELECT ${SEGMENT_FORMATS[format].join(', ')} FROM audit_events WHERE seq > ? ORDER BY seq LIMIT ?`,
    ).bind(cursor, SEGMENT_SIZE).all<SegmentRow>();
    if (!rows.results.length) return { archived: 0, key: null };

    const first = rows.results[0];
    const last = rows.results[rows.results.length - 1];
    ndjson = canonicalSegment(rows.results, format);
    const segmentHash = await sha256Hex(ndjson);
    const prevHash = head?.rolling_hash ?? null;
    const rollingHash = await sha256Hex(`${prevHash ?? ''}${segmentHash}`);

    // Freeze before writing anything, and only while the head is still where
    // it was read. If another runner froze this position first, theirs stands.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO audit_archive_intents
         (cursor_seq, first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, format, frozen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COALESCE(MAX(last_seq), 0) FROM audit_seals) = ?`,
    ).bind(
      cursor,
      Number(first.seq),
      Number(last.seq),
      rows.results.length,
      segmentHash,
      prevHash,
      rollingHash,
      segmentKey(Number(first.seq), Number(last.seq), String(first.occurred_at)),
      format,
      new Date().toISOString(),
      cursor,
    ).run();
    intent = await readIntent(env, cursor);
    // The head moved under us; the next run starts from wherever it is now.
    if (!intent) return { archived: 0, key: null };
    if (intent.segment_hash !== segmentHash) ndjson = null;
  }

  if (ndjson === null) {
    // Resuming a frozen range. Its rows are still in D1: nothing above the
    // head is pruned, and seq only grows, so the range cannot gain rows either.
    const columns = SEGMENT_FORMATS[intent.format];
    if (!columns) throw new ArchiveFault('segment-drift', intent.r2_key);
    const rows = await env.DB.prepare(
      `SELECT ${columns.join(', ')} FROM audit_events WHERE seq BETWEEN ? AND ? ORDER BY seq`,
    ).bind(intent.first_seq, intent.last_seq).all<SegmentRow>();
    const text = canonicalSegment(rows.results, intent.format);
    if (rows.results.length !== intent.event_count || await sha256Hex(text) !== intent.segment_hash) {
      throw new ArchiveFault('segment-drift', intent.r2_key);
    }
    ndjson = text;
  }

  // Never overwrite. An object already here is either this exact segment from
  // a run that died before sealing — adopt it — or something a person must
  // look at. Under a bucket lock an overwrite would be refused anyway.
  const existing = await r2(bucket.get(intent.r2_key));
  if (existing) {
    const text = await objectText(existing);
    if (text === null || await sha256Hex(text) !== intent.segment_hash) {
      throw new ArchiveFault('segment-conflict', intent.r2_key);
    }
  } else {
    await r2(bucket.put(intent.r2_key, await gzip(ndjson), {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      // The object's own copy of its chain link. With the bucket locked, a seal
      // row rewritten in D1 afterwards no longer matches it.
      customMetadata: {
        format: String(intent.format),
        firstSeq: String(intent.first_seq),
        lastSeq: String(intent.last_seq),
        segmentHash: intent.segment_hash,
        prevHash: intent.prev_hash ?? '',
        rollingHash: intent.rolling_hash,
      },
    }));
  }

  // Seal from the frozen row, only if the head is still the position it
  // extends. One transaction: the intent goes exactly when its seal exists.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_seals
         (first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, sealed_at)
       SELECT i.first_seq, i.last_seq, i.event_count, i.segment_hash, i.prev_hash, i.rolling_hash, i.r2_key, ?
         FROM audit_archive_intents i
        WHERE i.cursor_seq = ? AND i.segment_hash = ?
          AND (SELECT COALESCE(MAX(last_seq), 0) FROM audit_seals) = i.cursor_seq
          AND (SELECT rolling_hash FROM audit_seals ORDER BY last_seq DESC LIMIT 1) IS i.prev_hash
       RETURNING id`,
    ).bind(new Date().toISOString(), intent.cursor_seq, intent.segment_hash),
    env.DB.prepare(
      `DELETE FROM audit_archive_intents
        WHERE cursor_seq = ? AND EXISTS (
          SELECT 1 FROM audit_seals WHERE first_seq = ? AND last_seq = ? AND segment_hash = ?)`,
    ).bind(intent.cursor_seq, intent.first_seq, intent.last_seq, intent.segment_hash),
  ]);
  if (inserted.results.length) return { archived: intent.event_count, key: intent.r2_key };

  // A concurrent runner sealed this same intent first: nothing left to do.
  const twin = await env.DB.prepare(
    'SELECT 1 AS found FROM audit_seals WHERE first_seq = ? AND last_seq = ? AND segment_hash = ?',
  ).bind(intent.first_seq, intent.last_seq, intent.segment_hash).first();
  if (twin) return { archived: 0, key: intent.r2_key };
  throw new ArchiveFault('seal-conflict', intent.r2_key);
}

/** Recomputes one seal's chain link and reads its object back. */
async function checkSeal(
  bucket: R2Bucket,
  seal: Pick<SealRecord, 'first_seq' | 'last_seq' | 'segment_hash' | 'prev_hash' | 'rolling_hash' | 'r2_key'>,
  expectedPrev: string | null,
): Promise<SealVerification> {
  const base = { r2Key: seal.r2_key, firstSeq: seal.first_seq, lastSeq: seal.last_seq };
  let chainOk = (seal.prev_hash ?? null) === expectedPrev
    && seal.rolling_hash === await sha256Hex(`${seal.prev_hash ?? ''}${seal.segment_hash}`);
  const object = await r2(bucket.get(seal.r2_key));
  if (!object) return { ...base, contentOk: false, chainOk, missing: true };

  // Objects written since W5 carry their own link; older ones have none to compare.
  const meta = object.customMetadata ?? {};
  if (meta.rollingHash !== undefined
      && (meta.rollingHash !== seal.rolling_hash || (meta.prevHash || null) !== (seal.prev_hash ?? null))) {
    chainOk = false;
  }
  const text = await objectText(object);
  return { ...base, contentOk: text !== null && await sha256Hex(text) === seal.segment_hash, chainOk };
}

/**
 * Moves the prune ceiling forward over seals whose objects still read back
 * correctly and still chain. Stops at the first that does not: everything
 * after it stays in D1 until a person has looked.
 */
async function advanceVerified(env: Env, bucket: R2Bucket, state: ArchiveState): Promise<number> {
  const seals = await env.DB.prepare(
    `SELECT first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, sealed_at
       FROM audit_seals WHERE last_seq > ? ORDER BY last_seq LIMIT ?`,
  ).bind(state.verified_seq, VERIFY_LIMIT).all<SealRecord>();

  let verifiedSeq = state.verified_seq;
  let verifiedHash = state.verified_hash;
  let fault: ArchiveFault | null = null;
  for (const seal of seals.results) {
    try {
      const check = await checkSeal(bucket, seal, verifiedHash);
      // Overlap is a fork that slipped in some other way; it never verifies.
      if (seal.first_seq <= verifiedSeq || !check.contentOk || !check.chainOk) {
        throw new ArchiveFault('verification-failed', seal.r2_key);
      }
    } catch (error) {
      if (!(error instanceof ArchiveFault)) throw error;
      fault = error;
      break;
    }
    verifiedSeq = seal.last_seq;
    verifiedHash = seal.rolling_hash;
  }

  if (verifiedSeq !== state.verified_seq) {
    await env.DB.prepare(
      `UPDATE audit_archive_state SET verified_seq = ?, verified_hash = ?, verified_at = ?
        WHERE id = 1 AND verified_seq = ?`,
    ).bind(verifiedSeq, verifiedHash, new Date().toISOString(), state.verified_seq).run();
  }
  if (fault) throw fault;
  return verifiedSeq;
}

/**
 * Hands verified checkpoints to the independent receiver, in chain order.
 *
 * This is the anchor: the receiver is a separate Worker with its own storage,
 * so the application's database writer cannot rewrite what it already holds.
 * It must keep checkpoints write-once per (source, lastSeq), and refuse with
 * 409 one whose hashes differ or whose prevHash does not match the rollingHash
 * it holds for the checkpoint before. Bounded, PHI-free: seq numbers, counts
 * and hashes only.
 */
async function anchorCheckpoints(env: Env, state: ArchiveState): Promise<number> {
  const source = monitorSource(env);
  if (!env.AUDIT_MONITOR || !source) return state.anchored_seq;

  const seals = await env.DB.prepare(
    `SELECT first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, sealed_at
       FROM audit_seals
      WHERE last_seq > ? AND last_seq <= (SELECT verified_seq FROM audit_archive_state WHERE id = 1)
      ORDER BY last_seq LIMIT ?`,
  ).bind(state.anchored_seq, ANCHOR_LIMIT).all<SealRecord>();

  let anchoredSeq = state.anchored_seq;
  let fault: ArchiveFault | null = null;
  for (const seal of seals.results) {
    let status = 0;
    try {
      const response = await env.AUDIT_MONITOR.fetch('https://audit-monitor.internal/checkpoints', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': `checkpoint-${seal.last_seq}` },
        signal: AbortSignal.timeout(2000),
        body: JSON.stringify({
          version: 1, kind: 'audit-checkpoint', source,
          firstSeq: seal.first_seq, lastSeq: seal.last_seq, eventCount: seal.event_count,
          segmentHash: seal.segment_hash, prevHash: seal.prev_hash, rollingHash: seal.rolling_hash,
          sealedAt: seal.sealed_at,
        }),
      });
      status = response.status;
      await response.body?.cancel();
    } catch { /* Unreachable: anchoring lags, and the health check reports that. */ }
    if (status === 409) {
      fault = new ArchiveFault('anchor-conflict', seal.r2_key);
      break;
    }
    if (status < 200 || status >= 300) break;
    anchoredSeq = seal.last_seq;
  }

  if (anchoredSeq !== state.anchored_seq) {
    await env.DB.prepare(
      'UPDATE audit_archive_state SET anchored_seq = ?, anchored_at = ? WHERE id = 1 AND anchored_seq = ?',
    ).bind(anchoredSeq, new Date().toISOString(), state.anchored_seq).run();
  }
  if (fault) throw fault;
  return anchoredSeq;
}

/** seq → canonical line for the sealed copy of a range; 'uncovered' when the
 *  range is not wholly inside sealed coverage, 'uncompared' when it spans too
 *  many seals or a sealed copy cannot be read. */
async function sealedLines(env: Env, bucket: R2Bucket, firstSeq: number, lastSeq: number): Promise<Map<number, string> | 'uncovered' | 'uncompared'> {
  const seals = await env.DB.prepare(
    `SELECT first_seq, last_seq, r2_key FROM audit_seals
      WHERE last_seq >= ? AND first_seq <= ? ORDER BY first_seq LIMIT ?`,
  ).bind(firstSeq, lastSeq, ORPHAN_COMPARE_SEALS + 1).all<{ first_seq: number; last_seq: number; r2_key: string }>();
  const found = seals.results;
  if (!found.length || found[0].first_seq > firstSeq) return 'uncovered';
  if (found.length > ORPHAN_COMPARE_SEALS) return 'uncompared';
  if (found[found.length - 1].last_seq < lastSeq) return 'uncovered';

  const lines = new Map<number, string>();
  for (const seal of found) {
    const object = await r2(bucket.get(seal.r2_key));
    const text = object ? await objectText(object) : null;
    // A sealed copy that cannot be read is verification's finding, not ours.
    if (text === null) return 'uncompared';
    try {
      for (const line of text.split('\n')) if (line) lines.set(Number(JSON.parse(line).seq), line);
    } catch {
      return 'uncompared';
    }
  }
  return lines;
}

/**
 * Finds archive objects with no seal and no intent behind them, records each
 * once, and raises a fault for any that is not simply an earlier, identical
 * copy of rows that were later sealed — which is what a crash under the
 * pre-W5 sweep left behind when the retried segment came out longer.
 *
 * Never deletes: the object is evidence either way, and a locked bucket would
 * refuse.
 */
async function reconcileOrphans(env: Env, bucket: R2Bucket, cursor: string | null): Promise<void> {
  const page = await r2(bucket.list({ prefix: ARCHIVE_PREFIX, limit: ORPHAN_SCAN_LIMIT, ...(cursor ? { cursor } : {}) }));
  const keys = page.objects.map((object) => object.key);
  let fault: ArchiveFault | null = null;

  if (keys.length) {
    const marks = keys.map(() => '?').join(', ');
    const known = await env.DB.prepare(
      `SELECT r2_key FROM audit_seals WHERE r2_key IN (${marks})
       UNION SELECT r2_key FROM audit_archive_intents WHERE r2_key IN (${marks})
       UNION SELECT r2_key FROM audit_archive_orphans WHERE r2_key IN (${marks})`,
    ).bind(...keys, ...keys, ...keys).all<{ r2_key: string }>();
    const seen = new Set(known.results.map((row) => row.r2_key));

    for (const key of keys.filter((candidate) => !seen.has(candidate))) {
      const object = await r2(bucket.get(key));
      if (!object) continue; // gone since the listing
      const text = await objectText(object);
      const match = SEGMENT_KEY.exec(key);
      let status: 'superseded' | 'divergent' | 'unsealed' | 'uncompared' = 'unsealed';
      if (text !== null && match) {
        const sealed = await sealedLines(env, bucket, Number(match[1]), Number(match[2]));
        if (sealed === 'uncompared') status = 'uncompared';
        else if (sealed !== 'uncovered') {
          const lines = text.split('\n').filter(Boolean);
          const parsed = lines.map((line) => { try { return Number(JSON.parse(line).seq); } catch { return NaN; } });
          status = lines.every((line, i) => sealed.get(parsed[i]) === line) ? 'superseded' : 'divergent';
        }
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO audit_archive_orphans (r2_key, first_seq, last_seq, object_hash, status, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        key,
        match ? Number(match[1]) : null,
        match ? Number(match[2]) : null,
        text === null ? null : await sha256Hex(text),
        status,
        new Date().toISOString(),
      ).run();
      if (status !== 'superseded') fault ??= new ArchiveFault('orphan', key);
    }
  }

  await env.DB.prepare('UPDATE audit_archive_state SET orphan_cursor = ? WHERE id = 1')
    .bind(page.truncated ? page.cursor : null).run();
  if (fault) throw fault;
}

/** The private-journal entry for an archive fault. Coarse by construction: the
 *  receiver sees only `reason: 'archive'`; the key stays in the private journal. */
function faultRow(fault: ArchiveFault): AuditRow {
  return {
    action: `audit.archive.${fault.kind}`,
    eventClass: 'admin',
    dataClass: 'none',
    retentionClass: 'admin_config',
    outcome: 'error',
    targetType: 'audit_segment',
    targetId: fault.key,
    targetIds: null,
    targetCount: fault.key ? 1 : 0,
    containerKey: null,
    queryFingerprint: null,
    detail: null,
  };
}

/**
 * Raises an archive incident when the fault changes, and clears the record
 * when a run is clean. A persisting fault is one incident, not one per tick;
 * the health check keeps reporting it in every heartbeat until it clears.
 */
async function reportFault(env: Env, fault: ArchiveFault | null, previous: string | null): Promise<void> {
  const fingerprint = fault ? `${fault.kind}:${fault.key ?? ''}` : null;
  if (fingerprint === previous) return;
  if (fault) {
    console.error(JSON.stringify({ event: 'audit.archive-fault', kind: fault.kind }));
    await recordAuditOutage(env, 'archive', [faultRow(fault)]);
  }
  await env.DB.prepare('UPDATE audit_archive_state SET fault = ?, fault_at = ? WHERE id = 1')
    .bind(fingerprint, fault ? new Date().toISOString() : null).run();
}

/**
 * Archives one segment, verifies and anchors what is sealed, reconciles
 * orphans, and prunes what retention no longer keeps hot.
 *
 * Returns what it did rather than throwing on an empty run or an archive
 * fault, because this is called from a cron tick that logs its own result.
 * D1 failures do throw: with no database there is nothing to record into, and
 * the health check reports the primary as unwritable.
 */
export async function sweepAuditEvents(env: Env): Promise<SweepResult> {
  const bucket = env.AUDIT_BUCKET;
  // No archive means no sweep. Pruning without somewhere to put the rows first
  // would destroy the trail the whole mechanism exists to keep.
  if (!bucket) {
    await reportFault(env, new ArchiveFault('bucket-missing'), (await readState(env)).fault);
    return { archived: 0, pruned: 0, key: null, skipped: 'no_bucket', fault: 'bucket-missing' };
  }

  const holder = crypto.randomUUID();
  if (!await claimLease(env, holder)) return { archived: 0, pruned: 0, key: null, skipped: 'claimed' };
  try {
    const state = await readState(env);
    const faults: ArchiveFault[] = [];
    // Each step stands alone — a drifted intent must not stop older seals
    // being verified — except that once R2 itself is failing, the rest of the
    // R2 work is skipped rather than failing the same way four times.
    const step = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      if (faults.some((fault) => fault.kind === 'bucket-unavailable')) return fallback;
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof ArchiveFault)) throw error;
        faults.push(error);
        return fallback;
      }
    };

    const advanced = await step(() => advanceArchive(env, bucket), { archived: 0, key: null });
    const verifiedSeq = await step(() => advanceVerified(env, bucket, state), state.verified_seq);
    const anchoredSeq = await step(() => anchorCheckpoints(env, state), state.anchored_seq);
    await step(() => reconcileOrphans(env, bucket, state.orphan_cursor), undefined);
    // D1 only, and bounded by the verified ceiling, so it runs whatever failed.
    const pruned = await pruneArchived(env);

    const fault = faults[0] ?? null;
    await reportFault(env, fault, state.fault);
    return {
      archived: advanced.archived,
      pruned,
      key: advanced.key,
      verifiedSeq,
      anchoredSeq,
      ...(fault ? { fault: fault.kind } : {}),
      ...(!advanced.archived && !pruned && !fault ? { skipped: 'nothing_to_archive' as const } : {}),
    };
  } finally {
    // A failed release only delays the next run until the lease expires.
    await releaseLease(env, holder).catch(() => {});
  }
}

/**
 * Deletes rows that are both archived and past their class's hot window.
 * Scoped to `seq <= the verified ceiling` — the last seal read back from the
 * bucket and found intact — so an unarchived or unverified row can never be
 * deleted however old it is.
 */
async function pruneArchived(env: Env): Promise<number> {
  const state = await env.DB.prepare('SELECT verified_seq FROM audit_archive_state WHERE id = 1')
    .first<{ verified_seq: number }>();
  const ceiling = state?.verified_seq ?? 0;
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
  /** False when this seal does not chain onto the previous one, or no longer
   *  matches the link its own object carries. */
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
 * chain of every seal after it. It does not prove the D1 seals themselves were
 * never rewritten together; that is what the receiver's checkpoints are for.
 */
export async function verifyAuditArchive(env: Env, limit = 25): Promise<SealVerification[]> {
  const bucket = env.AUDIT_BUCKET;
  if (!bucket) return [];

  // The newest `limit` seals, returned in chain order. Deliberately the newest
  // rather than walking forward from the first seal: a tamper in last week's
  // segment is what an operator is looking for, and on a long archive a
  // forward walk would never reach it.
  const seals = await env.DB.prepare(
    `SELECT first_seq, last_seq, segment_hash, prev_hash, rolling_hash, r2_key
       FROM (SELECT * FROM audit_seals ORDER BY last_seq DESC LIMIT ?)
      ORDER BY last_seq`,
  ).bind(limit).all<SealRecord>();

  if (!seals.results.length) return [];

  // A window's chain can only be checked against what came before it, so seed
  // from the seal immediately preceding the window. Null when the window
  // starts at the first seal ever written, which is the genesis case.
  const preceding = await env.DB.prepare(
    'SELECT rolling_hash FROM audit_seals WHERE last_seq < ? ORDER BY last_seq DESC LIMIT 1',
  ).bind(seals.results[0].last_seq).first<{ rolling_hash: string }>();

  const results: SealVerification[] = [];
  let expectedPrev: string | null = preceding?.rolling_hash ?? null;
  for (const seal of seals.results) {
    results.push(await checkSeal(bucket, seal, expectedPrev));
    expectedPrev = seal.rolling_hash;
  }
  return results;
}
