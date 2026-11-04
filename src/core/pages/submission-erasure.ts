// ============================================================
// Erasing purged submissions from the published database (W12, A.8.10).
//
// A submission's source row lives in PUBLISHED_DB, written by a public Worker;
// the CMS works on a draft mirror of it. Purging the mirror records the uuid in
// submission_erasures in the same batch as the purge, so the obligation to
// erase cannot be lost between the two databases. This deletes the source rows
// afterwards and sets erased_at as the confirmation. Anything left pending,
// because the published database was unreachable, is retried by cron.
// ============================================================

import type { Env } from '../../types';

/** Uuids per pass, bounded by D1's cap on bound parameters. */
const ERASURE_CHUNK = 90;

/** Erases up to one chunk of pending submission sources. Returns how many were confirmed. */
export async function eraseSubmissionSources(env: Env): Promise<number> {
  if (!env.PUBLISHED_DB) return 0;
  const pending = (await env.DB.prepare(
    'SELECT uuid FROM submission_erasures WHERE erased_at IS NULL ORDER BY requested_at, uuid LIMIT ?',
  ).bind(ERASURE_CHUNK).all<{ uuid: string }>()).results.map((row) => row.uuid);
  if (!pending.length) return 0;
  const uuids = JSON.stringify(pending);
  await env.PUBLISHED_DB.batch([
    env.PUBLISHED_DB.prepare('DELETE FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE uuid IN (SELECT value FROM json_each(?)))').bind(uuids),
    env.PUBLISHED_DB.prepare('DELETE FROM pages WHERE uuid IN (SELECT value FROM json_each(?))').bind(uuids),
  ]);
  await env.DB.prepare('UPDATE submission_erasures SET erased_at = CURRENT_TIMESTAMP WHERE erased_at IS NULL AND uuid IN (SELECT value FROM json_each(?))')
    .bind(uuids).run();
  return pending.length;
}
