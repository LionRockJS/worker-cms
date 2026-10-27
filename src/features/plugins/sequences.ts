// ============================================================
// Plugin sequences — host-owned atomic counters a plugin Worker advances over
// /__cms/sequences.
//
// Why the host: a plugin's own KV is not atomic, so two concurrent submits
// could both read 41 and both issue PO-0042. Here the advance is a single
// D1 upsert with RETURNING, which SQLite serializes.
//
// Counters survive plugin unregistration on purpose (see the schema comment),
// and follow the plugin when its manifest id is re-pinned (identity.ts).
// ============================================================

import { isValidStateKey } from './state';

/** Hard cap on distinct counters per plugin, so a loop cannot fill the table. */
export const MAX_SEQUENCES_PER_PLUGIN = 1000;

/** Sequence keys share the state-key shape: `po.2026`, `rfq.2026`. */
export const isValidSequenceKey = isValidStateKey;

/** Current value, or 0 for a counter that was never advanced. */
export async function getPluginSequence(db: D1DatabaseClient, pluginId: string, key: string): Promise<number> {
  const row = await db
    .prepare('SELECT value FROM plugin_sequences WHERE plugin_id = ? AND key = ?')
    .bind(pluginId, key)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

export async function countPluginSequences(db: D1DatabaseClient, pluginId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM plugin_sequences WHERE plugin_id = ?')
    .bind(pluginId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Advances a counter by one and returns the new value (the first is 1). */
export async function nextPluginSequence(db: D1DatabaseClient, pluginId: string, key: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO plugin_sequences (plugin_id, key, value) VALUES (?, ?, 1)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = value + 1, updated_at = CURRENT_TIMESTAMP
       RETURNING value`,
    )
    .bind(pluginId, key)
    .first<{ value: number }>();
  if (!row) throw new Error('sequence upsert returned no row');
  return row.value;
}
