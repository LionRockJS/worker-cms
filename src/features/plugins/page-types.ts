// ============================================================
// Admin-approved delegated plugin page-type access.
//
// A plugin manifest may declare contentTypes.readTypes/writeTypes as candidate
// access to page types it does not own. The /__cms API only honors those
// delegated scopes after an admin approves them here.
// ============================================================

import type { PluginPageTypeApproval, PluginPageTypeAccess } from './types';

export const PAGE_TYPE_WILDCARD = '*';

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_page_type_approvals/i.test(error.message);
}

export function isPageTypeWildcard(value: string): boolean {
  return value === PAGE_TYPE_WILDCARD;
}

export function pageTypeScopeAllows(scope: Set<string>, pageType: string): boolean {
  return pageType.length > 0
    && !isPageTypeWildcard(pageType)
    && (scope.has(PAGE_TYPE_WILDCARD) || scope.has(pageType));
}

/** All delegated page-type approvals for a plugin, ordered for display. */
export async function listPageTypeApprovals(db: D1DatabaseClient, pluginId: string): Promise<PluginPageTypeApproval[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_page_type_approvals WHERE plugin_id = ? ORDER BY page_type ASC, access ASC')
      .bind(pluginId)
      .all<PluginPageTypeApproval>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getPageTypeApproval(
  db: D1DatabaseClient,
  pluginId: string,
  pageType: string,
  access: PluginPageTypeAccess,
): Promise<PluginPageTypeApproval | null> {
  try {
    return await db
      .prepare('SELECT * FROM plugin_page_type_approvals WHERE plugin_id = ? AND page_type = ? AND access = ?')
      .bind(pluginId, pageType, access)
      .first<PluginPageTypeApproval>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

export async function approvePageTypeAccess(
  db: D1DatabaseClient,
  pluginId: string,
  pageType: string,
  access: PluginPageTypeAccess,
  approvedBy: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_page_type_approvals (plugin_id, page_type, access, approved_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(plugin_id, page_type, access) DO UPDATE SET
         approved_by = excluded.approved_by,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(pluginId, pageType, access, approvedBy)
    .run();
}

export async function revokePageTypeAccess(
  db: D1DatabaseClient,
  pluginId: string,
  pageType: string,
  access: PluginPageTypeAccess,
): Promise<void> {
  await db
    .prepare('DELETE FROM plugin_page_type_approvals WHERE plugin_id = ? AND page_type = ? AND access = ?')
    .bind(pluginId, pageType, access)
    .run();
}

/** Approve declared scopes together, preserving existing approval attribution. */
export async function approvePageTypeAccessBatch(
  db: D1DatabaseClient,
  pluginId: string,
  scopes: Array<{ pageType: string; access: PluginPageTypeAccess }>,
  approvedBy: string,
): Promise<void> {
  for (let offset = 0; offset < scopes.length; offset += 100) {
    await db.batch(scopes.slice(offset, offset + 100).map(({ pageType, access }) => db
      .prepare(
        `INSERT INTO plugin_page_type_approvals (plugin_id, page_type, access, approved_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(plugin_id, page_type, access) DO NOTHING`,
      )
      .bind(pluginId, pageType, access, approvedBy)));
  }
}

/**
 * Drops every page-type approval a plugin holds — for unregistering it. Like
 * asset approvals these are keyed by manifest id, so deleting the registry row
 * alone leaves them behind, to be silently inherited by whatever is registered
 * next under the same manifest id.
 */
export async function revokeAllPageTypeAccess(db: D1DatabaseClient, pluginId: string): Promise<void> {
  await db.prepare('DELETE FROM plugin_page_type_approvals WHERE plugin_id = ?').bind(pluginId).run();
}
