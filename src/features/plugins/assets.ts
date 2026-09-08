import { limitedBytes } from '../../core/http/body-limit';
// ============================================================
// Admin-approved plugin static assets (JS/CSS) — see PluginManifest.assets.
//
// A plugin manifest only *declares* candidate files; nothing runs until an
// admin explicitly approves a path here, which pins the file's content hash
// (SRI, "sha384-..."). Every serve re-fetches the plugin's file and recomputes
// the hash — if it no longer matches the approval, the asset is treated as
// unapproved (fail closed) rather than served stale-trusted.
// ============================================================

import type { PluginAssetApproval } from './types';
import { PLUGIN_ORIGIN } from './registry';

export interface PluginAssetHealth {
  needsApproval: boolean;
  needsUpdate: boolean;
  fetchError: boolean;
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_asset_approvals/i.test(error.message);
}

/** All approvals for a plugin, ordered by path. */
export async function listApprovals(db: D1DatabaseClient, pluginId: string): Promise<PluginAssetApproval[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_asset_approvals WHERE plugin_id = ? ORDER BY path ASC')
      .bind(pluginId)
      .all<PluginAssetApproval>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getAssetApproval(db: D1DatabaseClient, pluginId: string, path: string): Promise<PluginAssetApproval | null> {
  try {
    return await db
      .prepare('SELECT * FROM plugin_asset_approvals WHERE plugin_id = ? AND path = ?')
      .bind(pluginId, path)
      .first<PluginAssetApproval>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/**
 * Checks the current files for an asset-bearing plugin without changing any
 * approval. Unapproved files do not need to be fetched: their status is known
 * from the approval table, while approved files must be re-hashed to detect a
 * deploy that requires re-approval.
 */
export async function inspectAssetHealth(
  db: D1DatabaseClient,
  pluginId: string,
  fetcher: Fetcher,
  assets: Array<{ path: string }>,
): Promise<PluginAssetHealth> {
  const approvals = new Map((await listApprovals(db, pluginId)).map((approval) => [approval.path, approval]));
  const checks = await Promise.all(assets.map(async (asset) => {
    const approval = approvals.get(asset.path);
    if (!approval) return { needsApproval: true, needsUpdate: false, fetchError: false };

    try {
      const upstream = await fetcher.fetch(`${PLUGIN_ORIGIN}${asset.path}`);
      if (!upstream.ok) return { needsApproval: false, needsUpdate: false, fetchError: true };
      const currentIntegrity = await computeIntegrity(await limitedBytes(upstream));
      return {
        needsApproval: false,
        needsUpdate: currentIntegrity !== approval.integrity,
        fetchError: false,
      };
    } catch {
      return { needsApproval: false, needsUpdate: false, fetchError: true };
    }
  }));

  return checks.reduce(
    (health, check) => ({
      needsApproval: health.needsApproval || check.needsApproval,
      needsUpdate: health.needsUpdate || check.needsUpdate,
      fetchError: health.fetchError || check.fetchError,
    }),
    { needsApproval: false, needsUpdate: false, fetchError: false },
  );
}

/** Approves (or re-approves) a plugin asset, pinning the given integrity hash. */
export async function approveAsset(
  db: D1DatabaseClient,
  pluginId: string,
  path: string,
  integrity: string,
  approvedBy: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_asset_approvals (plugin_id, path, integrity, approved_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(plugin_id, path) DO UPDATE SET
         integrity = excluded.integrity,
         approved_by = excluded.approved_by,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(pluginId, path, integrity, approvedBy)
    .run();
}

export async function revokeAsset(db: D1DatabaseClient, pluginId: string, path: string): Promise<void> {
  await db.prepare('DELETE FROM plugin_asset_approvals WHERE plugin_id = ? AND path = ?').bind(pluginId, path).run();
}

/**
 * Drops every approval a plugin holds — for unregistering it. Approvals are
 * keyed by manifest id rather than by the registry row, so nothing removes
 * them when that row goes away unless this is called explicitly.
 */
export async function revokeAllAssets(db: D1DatabaseClient, pluginId: string): Promise<void> {
  await db.prepare('DELETE FROM plugin_asset_approvals WHERE plugin_id = ?').bind(pluginId).run();
}

/** SRI-format digest ("sha384-<base64>") of the given bytes. */
export async function computeIntegrity(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  return `sha384-${base64(digest)}`;
}

function base64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
