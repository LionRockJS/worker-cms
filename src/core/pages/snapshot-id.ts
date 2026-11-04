/** Evaluated inside the INSERT, under the same serialized D1 write transaction.
 * The legacy time/16-bit-nonce default can collide within a hundred-row batch.
 * Advancing above the stored maximum prevents that collision while retaining
 * the legacy time/nonce floor when history is empty. The subquery is
 * uncorrelated, so SQLite evaluates it once per statement: a multi-row INSERT
 * must add a per-row offset (0, 1, 2, ...) to keep its ids distinct.
 * Callers must reject ids outside JavaScript's positive safe-integer range. */
export function nextIdSql(table: 'page_versions' | 'page_tags' | 'trash_page_tags'): string {
  return `(SELECT MAX(COALESCE(MAX(id),0),
  (CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 FROM ${table})`;
}

export const NEXT_SNAPSHOT_ID_SQL = nextIdSql('page_versions');
