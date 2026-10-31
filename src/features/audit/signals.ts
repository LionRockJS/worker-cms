// ============================================================
// Review signals.
//
// Recording an audit trail nobody reads satisfies no regime: ISO 27001 A 8.16,
// SOC 2 CC7.2, NIST AU-6 and HIPAA §164.308(a)(1)(ii)(D) all require that the
// log be *examined*, not merely written. These are the queries that turn the
// table into something reviewable in one screen.
//
// Detection only. Where an alert is delivered — email, webhook, a SIEM — is a
// deployment decision this module deliberately does not make; it answers "what
// would you want to be told about" and leaves the telling to whoever asks.
//
// Thresholds below are defaults chosen to be quiet on an ordinary install, not
// policy. They are exported so tests pin them and an operator can see them.
// ============================================================

import type { Env } from '../../types';
import { verifyAuditArchive, type SealVerification } from './sweep';

/** Records one actor may read from one classified container in a day before it
 *  is worth a second look. A busy editor browsing lists stays well under. */
export const BULK_READ_RECORDS = 500;

/** Refused attempts from one actor or address in a day before flagging. Low on
 *  purpose: a handful of denials is a misconfiguration, a stream is a probe. */
export const REFUSED_ATTEMPTS = 5;

/** How far back each signal looks. */
const READ_WINDOW_HOURS = 24;
const CONTRIBUTOR_WINDOW_HOURS = 24 * 7;

/** Rows per signal. These are leads to follow in the log, not a report. */
const SIGNAL_LIMIT = 10;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export interface SignalRow {
  /** Actual joined user source, for metadata policy; never a synthetic fallback label. */
  user_id?: number | null;
  /** Internal source sensitivity for classified audit-of-audit reads. */
  data_class?: 'pii' | 'phi' | null;
  /** Who or what the row is about. */
  subject: string;
  /** Where it happened — a container, a path, an address. */
  context: string;
  /** The number that triggered the flag. */
  value: number;
  /** Supporting count, e.g. how many requests made up `value`. */
  events: number;
}

export interface ReviewSignal {
  id: 'bulk_reads' | 'refused_access' | 'contributor_alone';
  /** The threshold this signal applied, for display. */
  threshold: number;
  windowHours: number;
  rows: SignalRow[];
}

export interface ArchiveHealth {
  seals: number;
  fromSeq: number | null;
  toSeq: number | null;
  /** Events written but not yet archived. Normal; a growing number is not. */
  backlog: number;
  /** Oldest unarchived event, which is what reveals a stalled sweep. */
  oldestUnarchived: string | null;
  /** Null when there is no bucket, so the screen can say so rather than
   *  reporting a healthy archive that does not exist. */
  verification: SealVerification[] | null;
  bucketBound: boolean;
}

/**
 * Actors reading unusually many records from a classified container. The
 * canonical exfiltration shape, and the reason target_count is recorded rather
 * than just a row per request.
 */
async function bulkReads(env: Env): Promise<ReviewSignal> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(u.name, 'user #' || ae.actor_user_id, 'no actor') AS subject,
            ae.container_key AS context, MAX(u.id) AS user_id,
            SUM(ae.target_count) AS value,
            COUNT(*) AS events,
            CASE WHEN MAX(ae.data_class = 'phi') = 1 THEN 'phi' WHEN MAX(ae.data_class = 'pii') = 1 THEN 'pii' END AS data_class
       FROM audit_events ae
       LEFT JOIN users u ON u.id = CAST(ae.actor_user_id AS INTEGER)
      WHERE ae.event_class IN ('read', 'export') AND ae.data_class IN ('pii', 'phi')
        AND ae.occurred_at >= ?
      GROUP BY ae.actor_user_id, ae.container_key
     HAVING SUM(ae.target_count) >= ?
      ORDER BY value DESC
      LIMIT ?`,
  ).bind(hoursAgo(READ_WINDOW_HOURS), BULK_READ_RECORDS, SIGNAL_LIMIT).all<SignalRow>();
  return {
    id: 'bulk_reads',
    threshold: BULK_READ_RECORDS,
    windowHours: READ_WINDOW_HOURS,
    rows: rows.results,
  };
}

/**
 * Repeated refusals — failed sign-ins and denied capability checks. Grouped by
 * actor and address because the two shapes differ: one account failing
 * everywhere is a misconfiguration, one address failing across accounts is not.
 */
async function refusedAccess(env: Env): Promise<ReviewSignal> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(u.name, 'user #' || ae.actor_user_id, 'no actor') AS subject,
            COALESCE(ae.source_ip, 'no address') AS context, MAX(u.id) AS user_id,
            COUNT(*) AS value,
            COUNT(DISTINCT ae.action) AS events,
            CASE WHEN MAX(ae.data_class = 'phi') = 1 THEN 'phi' WHEN MAX(ae.data_class = 'pii') = 1 THEN 'pii' END AS data_class
       FROM audit_events ae
       LEFT JOIN users u ON u.id = CAST(ae.actor_user_id AS INTEGER)
      WHERE ae.outcome = 'denied' AND ae.occurred_at >= ?
      GROUP BY ae.actor_user_id, ae.source_ip
     HAVING COUNT(*) >= ?
      ORDER BY value DESC
      LIMIT ?`,
  ).bind(hoursAgo(READ_WINDOW_HOURS), REFUSED_ATTEMPTS, SIGNAL_LIMIT).all<SignalRow>();
  return {
    id: 'refused_access',
    threshold: REFUSED_ATTEMPTS,
    windowHours: READ_WINDOW_HOURS,
    rows: rows.results,
  };
}

/**
 * A contributor reading a classified container on its own behalf, with no user
 * it was acting for. Legitimate for scheduled work, but it is regulated data
 * read with nobody accountable for it, so every occurrence is listed rather
 * than thresholded.
 */
async function contributorAlone(env: Env): Promise<ReviewSignal> {
  const rows = await env.DB.prepare(
    `SELECT ae.acting_via AS subject,
            ae.container_key AS context,
            SUM(ae.target_count) AS value,
            COUNT(*) AS events,
            CASE WHEN MAX(ae.data_class = 'phi') = 1 THEN 'phi' WHEN MAX(ae.data_class = 'pii') = 1 THEN 'pii' END AS data_class
       FROM audit_events ae
      WHERE ae.event_class IN ('read', 'export') AND ae.data_class IN ('pii', 'phi')
        AND ae.acting_via IS NOT NULL AND ae.actor_user_id IS NULL
        AND ae.occurred_at >= ?
      GROUP BY ae.acting_via, ae.container_key
      ORDER BY value DESC
      LIMIT ?`,
  ).bind(hoursAgo(CONTRIBUTOR_WINDOW_HOURS), SIGNAL_LIMIT).all<SignalRow>();
  return {
    id: 'contributor_alone',
    threshold: 1,
    windowHours: CONTRIBUTOR_WINDOW_HOURS,
    rows: rows.results,
  };
}

/** Whether the archive is keeping up, and whether it still verifies. */
export async function archiveHealth(env: Env, verificationLimit = 25): Promise<ArchiveHealth> {
  const [seals, backlog] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS seals, MIN(first_seq) AS fromSeq, MAX(last_seq) AS toSeq FROM audit_seals',
    ).first<{ seals: number; fromSeq: number | null; toSeq: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS backlog, MIN(occurred_at) AS oldest
         FROM audit_events
        WHERE seq > (SELECT COALESCE(MAX(last_seq), 0) FROM audit_seals)`,
    ).first<{ backlog: number; oldest: string | null }>(),
  ]);

  const bucketBound = !!env.AUDIT_BUCKET;
  return {
    seals: seals?.seals ?? 0,
    fromSeq: seals?.fromSeq ?? null,
    toSeq: seals?.toSeq ?? null,
    backlog: backlog?.backlog ?? 0,
    oldestUnarchived: backlog?.oldest ?? null,
    // Verification reads every segment back from R2, so it is only run when
    // there is a bucket to read from, and only over the newest window.
    verification: bucketBound ? await verifyAuditArchive(env, verificationLimit) : null,
    bucketBound,
  };
}

/** Every signal, run in parallel. */
export function reviewSignals(env: Env): Promise<ReviewSignal[]> {
  return Promise.all([bulkReads(env), refusedAccess(env), contributorAlone(env)]);
}
