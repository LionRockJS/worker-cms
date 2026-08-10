// Admin-approved host file prefixes declared by PluginManifest.filePrefixes.
//
// The manifest is only a request. The /__cms/files API uses the intersection
// of declared and approved prefixes, and approvals reserve a prefix globally
// so one plugin cannot overwrite another plugin's folder. Nested prefixes are
// treated as overlapping too: `uploads/` reserves `uploads/images/` as well.

import type { PluginFilePrefixApproval } from './types';

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_file_prefix_approvals/i.test(error.message);
}

/** Returns whether two slash-terminated prefixes overlap. */
export function filePrefixesOverlap(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

/** All approved prefixes for one plugin, ordered for display. */
export async function listFilePrefixApprovals(
  db: D1DatabaseClient,
  pluginId: string,
): Promise<PluginFilePrefixApproval[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_file_prefix_approvals WHERE plugin_id = ? ORDER BY prefix ASC')
      .bind(pluginId)
      .all<PluginFilePrefixApproval>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getFilePrefixApproval(
  db: D1DatabaseClient,
  pluginId: string,
  prefix: string,
): Promise<PluginFilePrefixApproval | null> {
  try {
    return await db
      .prepare('SELECT * FROM plugin_file_prefix_approvals WHERE plugin_id = ? AND prefix = ?')
      .bind(pluginId, prefix)
      .first<PluginFilePrefixApproval>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/** Finds another plugin that already owns this prefix or an overlapping one. */
export async function findFilePrefixConflict(
  db: D1DatabaseClient,
  pluginId: string,
  prefix: string,
): Promise<PluginFilePrefixApproval | null> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_file_prefix_approvals WHERE plugin_id != ? ORDER BY prefix ASC')
      .bind(pluginId)
      .all<PluginFilePrefixApproval>();
    return results.find((approval) => filePrefixesOverlap(approval.prefix, prefix)) ?? null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/** Approves or re-approves a prefix, rejecting overlaps owned by another plugin. */
export async function approveFilePrefix(
  db: D1DatabaseClient,
  pluginId: string,
  prefix: string,
  approvedBy: string,
): Promise<void> {
  const conflict = await findFilePrefixConflict(db, pluginId, prefix);
  if (conflict) throw new FilePrefixConflictError(conflict);

  try {
    await db
      .prepare(
        `INSERT INTO plugin_file_prefix_approvals (plugin_id, prefix, approved_by, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(plugin_id, prefix) DO UPDATE SET
           approved_by = excluded.approved_by,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(pluginId, prefix, approvedBy)
      .run();
  } catch (error) {
    // The global UNIQUE(prefix) constraint closes the small race between the
    // overlap read and insert. Turn it into the same stable conflict signal.
    if (error instanceof Error && /unique constraint failed/i.test(error.message)) {
      const current = await findFilePrefixConflict(db, pluginId, prefix);
      if (current) throw new FilePrefixConflictError(current);
    }
    throw error;
  }
}

export async function revokeFilePrefix(db: D1DatabaseClient, pluginId: string, prefix: string): Promise<void> {
  await db
    .prepare('DELETE FROM plugin_file_prefix_approvals WHERE plugin_id = ? AND prefix = ?')
    .bind(pluginId, prefix)
    .run();
}

/** Drops every approval a plugin holds when its registry row is deleted. */
export async function revokeAllFilePrefixes(db: D1DatabaseClient, pluginId: string): Promise<void> {
  await db.prepare('DELETE FROM plugin_file_prefix_approvals WHERE plugin_id = ?').bind(pluginId).run();
}

export class FilePrefixConflictError extends Error {
  constructor(readonly conflict: PluginFilePrefixApproval) {
    super(`File prefix '${conflict.prefix}' is already approved for plugin '${conflict.plugin_id}'.`);
    this.name = 'FilePrefixConflictError';
  }
}
