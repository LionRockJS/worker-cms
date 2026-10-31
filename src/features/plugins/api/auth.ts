// Plugin authentication and page-type scoping for /__cms.
//
// Callers are plugin Workers, not browsers: they name themselves with
// x-plugin-id and prove it with that row's own secret. Writes are scoped to
// the plugin's manifest blueprint types plus admin-approved writeTypes.

import type { AppContext } from '../../../core/http/context';
import type { PluginAuth } from './types';
import { pluginById } from '../registry';
import { timingSafeEqualStr } from '../proxy';
import { listPageTypeApprovals } from '../page-types';
import { requestContext } from '../../../core/http/request-context';
import { pluginReadActor } from './read-audit';

// ── Auth + scoping ────────────────────────────────────────────────────────────

/**
 * Verifies the plugin's dedicated secret and resolves the caller so writes can be
 * scoped to the page types it owns. Returns a Response (to short-circuit) on
 * any failure, otherwise the resolved plugin + its allowed page types.
 */
export async function authenticatePlugin(c: AppContext): Promise<PluginAuth | Response> {
  // Resolve the caller first so we can check its OWN secret: per-plugin secrets
  // make this scope a real boundary, and let one plugin be rotated/revoked
  // without touching the others.
  const pluginId = (c.req.header('x-plugin-id') ?? '').trim();
  if (!pluginId) return c.json({ error: 'missing_plugin_id' }, 400);

  const plugin = await pluginById(c.env, pluginId);
  if (!plugin) return c.json({ error: 'unknown_plugin' }, 403);

  if (!plugin.apiSecret) {
    console.error(`Plugin ${pluginId} called the write-back API but has no secret configured`);
    return c.json({ error: 'plugin_api_unavailable' }, 503);
  }
  if (!timingSafeEqualStr(c.req.header('x-plugin-secret') ?? '', plugin.apiSecret)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const context = requestContext.getStore();
  if (context) context.readActor = pluginReadActor(c, pluginId);

  const contentTypes = plugin.manifest.contentTypes;
  const allowedTypes = new Set(Object.keys(contentTypes?.blueprint ?? {}));
  const approvals = await listPageTypeApprovals(c.env.DB, plugin.manifest.id);
  const approvedReadTypes = new Set(approvals.filter((approval) => approval.access === 'read').map((approval) => approval.page_type));
  const approvedWriteTypes = new Set(approvals.filter((approval) => approval.access === 'write').map((approval) => approval.page_type));
  for (const type of contentTypes?.writeTypes ?? []) {
    if (approvedWriteTypes.has(type)) allowedTypes.add(type);
  }
  // Reads may also reach admin-approved `readTypes` (pages owned by other plugins).
  const readableTypes = new Set(allowedTypes);
  for (const type of contentTypes?.readTypes ?? []) {
    if (approvedReadTypes.has(type)) readableTypes.add(type);
  }
  return { plugin, pluginId, allowedTypes, readableTypes };
}

/**
 * 403 body for a page type outside the caller's approved scope. The
 * `forbidden_page_type` code is stable API; `page_type` and `message` tell the
 * plugin (and its admin error panel) which type was refused and that the fix
 * is an admin approval — not a CMS_URL/PLUGIN_SECRET problem. Types declared
 * as readTypes/writeTypes in a manifest stay inert until an admin approves
 * them under Plugins → (plugin) → Page types, which is easy to miss right
 * after installing a plugin.
 */
export function forbiddenPageTypeBody(auth: PluginAuth, pageType: string) {
  return {
    error: 'forbidden_page_type' as const,
    page_type: pageType,
    message: `Page type '${pageType}' is not approved for plugin '${auth.pluginId}'. `
      + `An administrator can approve the plugin's declared page types in the CMS admin under Plugins → ${auth.pluginId} → Page types.`,
  };
}

export function forbiddenPageType(c: AppContext, auth: PluginAuth, pageType: string) {
  return c.json(forbiddenPageTypeBody(auth, pageType), 403);
}
