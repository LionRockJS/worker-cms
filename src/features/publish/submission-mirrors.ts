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
