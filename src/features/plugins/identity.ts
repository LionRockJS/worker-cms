// ============================================================
// Pinned plugin identity (trust on first use).
//
// A plugin Worker asserts its own `manifest.id`, and every capability the CMS
// grants a plugin — asset approvals, delegated page types, file prefixes,
// plugin_state, tenant enrollment, limit/credit settings — is keyed by that
// string. The registry row's real identity is its URL, so nothing stopped a
// second plugin from serving `"id": "events"` and inheriting the approvals an
// admin granted to the events plugin (or reclaiming the ones a deleted plugin
// left behind).
//
// This binds the asserted id to the registry row that first resolved it:
//   • one row owns a manifest id (UNIQUE), so a second plugin cannot claim it;
//   • a row whose manifest id changes stops resolving until an admin
//     re-approves, which revokes the old identity's capability approvals.
//
// Reads tolerate a missing table (pre-migration databases) by reporting "no
// pins", which keeps an un-migrated install working exactly as before.
// ============================================================

import type { PluginIdentityApproval } from './types';

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_identity_approvals/i.test(error.message);
}

/** Every pinned identity, for resolution and the manage screens. */
export async function listIdentityApprovals(db: D1DatabaseClient): Promise<PluginIdentityApproval[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_identity_approvals ORDER BY manifest_id ASC')
      .all<PluginIdentityApproval>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

/** The manifest id pinned to one registry row, or null when it has none yet. */
export async function getIdentityForRow(db: D1DatabaseClient, rowId: number): Promise<PluginIdentityApproval | null> {
  try {
    return await db
      .prepare('SELECT * FROM plugin_identity_approvals WHERE plugin_row_id = ?')
      .bind(rowId)
      .first<PluginIdentityApproval>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/**
 * Claims a manifest id for a registry row. Returns false when the id already
 * belongs to another row (or the row already holds a different id) — the
 * caller must then refuse to resolve the plugin rather than let it borrow an
 * identity. `INSERT OR IGNORE` makes the UNIQUE constraint the arbiter, so two
 * isolates racing on the same first resolution cannot both win.
 */
export async function claimIdentity(
  db: D1DatabaseClient,
  rowId: number,
  manifestId: string,
  approvedBy = '',
): Promise<boolean> {
  try {
    await db
      .prepare('INSERT OR IGNORE INTO plugin_identity_approvals (plugin_row_id, manifest_id, approved_by) VALUES (?, ?, ?)')
      .bind(rowId, manifestId, approvedBy)
      .run();
    // Re-read instead of trusting meta.changes: the INSERT is ignored both when
    // this row already has a pin and when another row owns the id, and only the
    // stored pair says which happened.
    const pinned = await getIdentityForRow(db, rowId);
    return pinned?.manifest_id === manifestId;
  } catch (error) {
    if (missingTable(error)) return true; // enforcement unavailable — see module header
    throw error;
  }
}

/**
 * Re-pins a row to a new manifest id (admin action). Fails when another row
 * already owns that id. The caller is responsible for revoking the capability
 * approvals the previous identity held.
 */
export async function repinIdentity(
  db: D1DatabaseClient,
  rowId: number,
  manifestId: string,
  approvedBy: string,
): Promise<boolean> {
  try {
    const owner = await db
      .prepare('SELECT plugin_row_id FROM plugin_identity_approvals WHERE manifest_id = ?')
      .bind(manifestId)
      .first<{ plugin_row_id: number }>();
    if (owner && owner.plugin_row_id !== rowId) return false;
    await db
      .prepare(
        `INSERT INTO plugin_identity_approvals (plugin_row_id, manifest_id, approved_by) VALUES (?, ?, ?)
           ON CONFLICT(plugin_row_id) DO UPDATE SET
             manifest_id = excluded.manifest_id,
             approved_by = excluded.approved_by,
             updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(rowId, manifestId, approvedBy)
      .run();
    return true;
  } catch (error) {
    if (missingTable(error)) return false;
    throw error;
  }
}

/** Releases a row's pin, so the manifest id can be claimed again. */
export async function releaseIdentity(db: D1DatabaseClient, rowId: number): Promise<void> {
  try {
    await db.prepare('DELETE FROM plugin_identity_approvals WHERE plugin_row_id = ?').bind(rowId).run();
  } catch (error) {
    if (missingTable(error)) return;
    throw error;
  }
}

/** Moves host-held plugin state from a retired manifest id to the new one.
 *  `UPDATE OR REPLACE` keeps the (plugin_id, key) primary key intact when a
 *  key already exists under the new id. */
export async function movePluginState(db: D1DatabaseClient, fromId: string, toId: string): Promise<void> {
  if (!fromId || !toId || fromId === toId) return;
  try {
    await db
      .prepare('UPDATE OR REPLACE plugin_state SET plugin_id = ? WHERE plugin_id = ?')
      .bind(toId, fromId)
      .run();
  } catch (error) {
    if (error instanceof Error && /no such table: plugin_state/i.test(error.message)) return;
    throw error;
  }
}
