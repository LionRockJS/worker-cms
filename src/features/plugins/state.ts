// ============================================================
// Plugin state — host-owned key/value storage a plugin Worker reads and
// writes over /__cms/state.
//
// Why the host rather than the plugin: one plugin Worker serves many CMS
// hosts, so a record it keeps in its own KV outlives the host that owns it,
// cannot be audited or exported from the CMS, and is visible to whoever
// operates the plugin. Anything that describes ONE host's relationship with
// the outside world (a connected GitHub App installation, a linked account,
// a per-host preference) belongs here; only the plugin's own global identity
// stays in the plugin.
//
// The value is opaque JSON: the CMS stores and returns it without parsing.
// This is deliberately NOT a secret store — D1 is plaintext at rest, so
// credentials belong in the plugin's Worker secrets, not here.
//
// Production PUT/DELETE uses state-evidence.ts; these DB-only primitives do
// not establish caller authority or a durable mutation receipt.
//
// Every read tolerates a missing `plugin_state` table (a database that has
// not run the migration yet) by returning empty, so an un-migrated CMS
// degrades to "no state" instead of failing every plugin call at once.
// ============================================================

/** Longest key a plugin may address. */
export const MAX_STATE_KEY_LENGTH = 64;
/** Largest value a plugin may store, in bytes of UTF-8 JSON. */
export const MAX_STATE_VALUE_BYTES = 64 * 1024;
/** Hard cap on distinct keys per plugin, so a loop cannot fill the database. */
export const MAX_STATE_KEYS_PER_PLUGIN = 100;

const STATE_KEY_RE = /^[a-z0-9._-]{1,64}$/;

export interface PluginStateEntry {
  key: string;
  value: string;
  updated_at: string;
}

/** True for a key shaped like `github.connection` — lowercase, dotted, short. */
export function isValidStateKey(key: string): boolean {
  return STATE_KEY_RE.test(key);
}

/** Byte length of a value, which is what the size cap is expressed in. */
export function stateValueBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_state/i.test(error.message);
}

/**
 * Escapes a prefix for a LIKE pattern. Valid keys may contain `_`, which LIKE
 * reads as "any single character" — without this, prefix `a_b` would also
 * match `axb`.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** One plugin's entries, optionally narrowed to a key prefix. */
export async function listPluginState(
  db: D1DatabaseClient,
  pluginId: string,
  prefix = '',
): Promise<PluginStateEntry[]> {
  try {
    const { results } = prefix
      ? await db
        .prepare("SELECT key, value, updated_at FROM plugin_state WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC")
        .bind(pluginId, `${likeEscape(prefix)}%`)
        .all<PluginStateEntry>()
      : await db
        .prepare('SELECT key, value, updated_at FROM plugin_state WHERE plugin_id = ? ORDER BY key ASC')
        .bind(pluginId)
        .all<PluginStateEntry>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getPluginState(
  db: D1DatabaseClient,
  pluginId: string,
  key: string,
): Promise<PluginStateEntry | null> {
  try {
    return await db
      .prepare('SELECT key, value, updated_at FROM plugin_state WHERE plugin_id = ? AND key = ?')
      .bind(pluginId, key)
      .first<PluginStateEntry>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/** Distinct keys already stored for a plugin, for the per-plugin cap. */
export async function countPluginStateKeys(db: D1DatabaseClient, pluginId: string): Promise<number> {
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS total FROM plugin_state WHERE plugin_id = ?')
      .bind(pluginId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  } catch (error) {
    if (missingTable(error)) return 0;
    throw error;
  }
}

/**
 * Writes one entry. Unlike the reads this does NOT swallow a missing table:
 * a plugin that believes a write succeeded would go on to clear its own copy,
 * so an un-migrated database must fail loudly here.
 */
export async function putPluginState(
  db: D1DatabaseClient,
  pluginId: string,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_state (plugin_id, key, value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(pluginId, key, value)
    .run();
}

export async function deletePluginState(
  db: D1DatabaseClient,
  pluginId: string,
  key: string,
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?')
      .bind(pluginId, key)
      .run();
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
}

/** Drops every entry a plugin owns — used when the plugin is unregistered. */
export async function deleteAllPluginState(db: D1DatabaseClient, pluginId: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM plugin_state WHERE plugin_id = ?').bind(pluginId).run();
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
}
