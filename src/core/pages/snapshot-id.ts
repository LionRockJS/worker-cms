/** Evaluated inside the INSERT, under the same serialized D1 write transaction.
 * The legacy time/16-bit-nonce default can collide within a hundred-row batch.
 * Advancing above the stored maximum prevents that collision while retaining
 * the legacy time/nonce floor when history is empty.
 * Callers must reject ids outside JavaScript's positive safe-integer range. */
export const NEXT_SNAPSHOT_ID_SQL = `(SELECT MAX(COALESCE(MAX(id),0),
  (CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 FROM page_versions)`;
