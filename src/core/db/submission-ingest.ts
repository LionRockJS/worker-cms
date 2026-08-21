// ============================================================
// Generic submission ingest — published DB → draft pages.
//
// Any page that exists in the published D1 but has no draft row with the same
// uuid is a submission, regardless of its page type or which public Worker
// created it. This module mirrors those rows into draft so they are versioned,
// auditable, and visible to plugins; creating the draft copy fires the
// dedicated `submission` lifecycle hook.
//
// Idempotency: the draft copy keeps the source row's uuid, so the draft
// `uuid` unique constraint makes re-ingest a no-op. Progress is tracked by a
// (created_at, uuid) cursor in the settings table; the published rows are
// never mutated or deleted.
//
// Budget: creates per run are capped so one invocation (cron tick or
// /__cms/ingest/submissions call) stays well inside the subrequest budget —
// the next run resumes from the cursor.
// ============================================================

import type { Env } from '../../types';
import { coreExtensions } from '../extensions';
import { getSetting, saveSetting } from './settings';
import { savePageVersion } from './admin-queries';

const CURSOR_SETTING_KEY = 'submissions.ingest.cursor';
/** Rows scanned from the published DB per run. */
const SCAN_LIMIT = 40;
/** Draft pages created per run (each costs ~4 D1 ops + 1 hook fetch). */
const MAX_CREATES_PER_RUN = 8;

interface LiveSubmissionRow {
  uuid: string;
  created_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_type: string;
  lect: string | null;
  page_id: number | null;
}

export interface IngestResult {
  /** Rows read past the cursor this run. */
  scanned: number;
  /** Draft pages created (rows already in draft are skipped silently). */
  created: number;
  /** True when the caller should run another batch (cap reached or scan wrapped). */
  more: boolean;
}

/** Submission origin is recorded in existing version history, avoiding any
 * page-schema flag while remaining stable across later edits and restore. */
export async function isSubmissionMirror(db: D1DatabaseClient, pageId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM page_versions
     WHERE page_id = ? AND action IN ('ingest-submission', 'pull-published')
     LIMIT 1`,
  ).bind(pageId).first();
  return row !== null;
}

/** Page ids per read, bounded by D1's cap on bound parameters. */
const MIRROR_ID_CHUNK = 90;

/**
 * Which of `pageIds` are submission mirrors — the set-based form of
 * isSubmissionMirror, for callers holding a whole slice. One read per chunk
 * instead of one per page, which is what keeps a bulk publish/unpublish off
 * the subrequest budget.
 */
export async function submissionMirrorIds(
  db: D1DatabaseClient,
  pageIds: number[],
): Promise<Set<number>> {
  const mirrors = new Set<number>();
  const unique = [...new Set(pageIds)];
  for (let index = 0; index < unique.length; index += MIRROR_ID_CHUNK) {
    const chunk = unique.slice(index, index + MIRROR_ID_CHUNK);
    const { results } = await db.prepare(
      `SELECT DISTINCT page_id FROM page_versions
       WHERE page_id IN (${chunk.map(() => '?').join(',')})
         AND action IN ('ingest-submission', 'pull-published')`,
    ).bind(...chunk).all<{ page_id: number }>();
    for (const row of results) mirrors.add(row.page_id);
  }
  return mirrors;
}

interface Cursor {
  created_at: string;
  uuid: string;
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { created_at: '', uuid: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
      uuid: typeof parsed.uuid === 'string' ? parsed.uuid : '',
    };
  } catch {
    return { created_at: '', uuid: '' };
  }
}

/**
 * Finds live-only rows and mirrors them into the draft DB. Safe to call
 * concurrently or repeatedly: creation is idempotent by uuid, and the bounded
 * cursor wraps after a complete pass so older rows are reconsidered.
 */
export async function ingestSubmissions(env: Env): Promise<IngestResult> {
  if (!env.PUBLISHED_DB) return { scanned: 0, created: 0, more: false };

  const cursor = parseCursor(await getSetting(env, CURSOR_SETTING_KEY));

  const rows = await env.PUBLISHED_DB.prepare(
    `SELECT uuid, created_at, name, slug, weight, start, end, timezone, page_type, lect, page_id
     FROM pages
     WHERE created_at > ? OR (created_at = ? AND uuid > ?)
     ORDER BY created_at ASC, uuid ASC
     LIMIT ?`,
  )
    .bind(cursor.created_at, cursor.created_at, cursor.uuid, SCAN_LIMIT)
    .all<LiveSubmissionRow>();

  if (!rows.results.length) {
    // A completed pass resets the cursor so later runs can detect a formerly
    // mirrored/live page whose draft counterpart has since disappeared.
    if (cursor.created_at || cursor.uuid) {
      await saveSetting(env, CURSOR_SETTING_KEY, JSON.stringify({ created_at: '', uuid: '' }));
      return { scanned: 0, created: 0, more: true };
    }
    return { scanned: 0, created: 0, more: false };
  }

  // One query for both pre-checks: which rows already exist in draft, and
  // which referenced parent pages exist locally.
  const uuids = rows.results.map((row) => row.uuid);
  const parentIds = [...new Set(rows.results.map((row) => row.page_id).filter((id): id is number => id !== null))];
  const existingUuids = new Set(
    (await env.DB.prepare(`SELECT uuid FROM pages WHERE uuid IN (${uuids.map(() => '?').join(', ')})`)
      .bind(...uuids)
      .all<{ uuid: string }>()).results.map((row) => row.uuid),
  );
  const existingParents = new Set(
    parentIds.length
      ? (await env.DB.prepare(`SELECT id FROM pages WHERE id IN (${parentIds.map(() => '?').join(', ')})`)
        .bind(...parentIds)
        .all<{ id: number }>()).results.map((row) => row.id)
      : [],
  );

  let created = 0;
  let handled = 0;
  let last: Cursor = cursor;

  for (const row of rows.results) {
    if (created >= MAX_CREATES_PER_RUN) break;
    handled += 1;
    last = { created_at: row.created_at, uuid: row.uuid };
    if (existingUuids.has(row.uuid)) continue;

    const parentId = row.page_id !== null && existingParents.has(row.page_id) ? row.page_id : null;
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO pages (uuid, created_at, name, slug, weight, start, end, timezone, page_type, lect, page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        row.uuid,
        row.created_at,
        row.name,
        row.slug,
        row.weight,
        row.start,
        row.end,
        row.timezone,
        row.page_type,
        row.lect,
        parentId,
      )
      .first<{ id: number }>();
    if (!inserted) continue; // lost a race to a concurrent run — already ingested

    await savePageVersion(env.DB, inserted.id, row.lect, 'ingest-submission');
    created += 1;

    await coreExtensions().notifyPageEvent?.(env, undefined, 'submission', [{
      id: inserted.id,
      uuid: row.uuid,
      page_type: row.page_type,
      name: row.name,
      slug: row.slug,
    }]);
  }

  if (last.created_at !== cursor.created_at || last.uuid !== cursor.uuid) {
    await saveSetting(env, CURSOR_SETTING_KEY, JSON.stringify(last));
  }

  return {
    scanned: handled,
    created,
    more: handled < rows.results.length || rows.results.length === SCAN_LIMIT,
  };
}
