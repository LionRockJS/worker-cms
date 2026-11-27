import { pluginViewSource } from '../view-source';
import { readForm } from '../registration-form';
import { mutatePluginSettings,PluginSettingsUnavailableError } from '../settings-evidence';
import { mutatePluginApproval,PluginApprovalUnavailableError } from '../approval-evidence';
import { preparePluginRegistrationMutation,PluginRegistrationUnavailableError,PluginRegistrationConflictError } from '../registration-evidence';
import { limitedBytes } from '../../../core/http/body-limit';
// ============================================================
// Plugin management — register / enable / disable / configure plugins,
// stored in the `plugins` D1 table (URL transport). Gated by plugin:manage.
//
// Distinct from src/routes/admin/plugins.ts, which proxies *into* a plugin's
// admin UI (plugin:access). This router manages the registry rows themselves.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { renderPage } from '../../../core/render/chrome';
import { contextActor, logAudit } from '../../../core/db/audit';
import { auditUnavailable } from '../../../core/http/access-log';
import type { AppContext } from '../../../core/http/context';
import { auditPluginManagement } from '../disclosure-audit';
import { recordContributorReads, recordMetadataReads, recordTableReads } from '../../../core/http/access-log';
import { getIdentityForRow, listIdentityApprovals } from '../identity';
import { str } from '../../../core/http/forms';
import { getPlugins, clearManifestCache, pluginIdentityStates } from '../registry';
import { clearConfigCache } from '../../../core/db/content-config';
import {
  listPlugins,
  getPlugin,
} from '../store';
import { computeIntegrity, inspectAssetHealth, listApprovals } from '../assets';
import { isPageTypeWildcard } from '../page-types';
import {
  findFilePrefixConflict,
  listFilePrefixApprovals,
} from '../file-prefixes';
import { PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../registry';
import { pluginTenantId } from '../proxy';
import { enrollPluginTenant, manifestAllowsAutoTenant, revokePluginTenant } from '../enroll';
import {
  countLimitUsage,
  declaredLimits,
  limitScopeTypes,
  loadLimitValues,
  type NormalizedLimitDef,
} from '../limits';
import { callFeatureService } from '../../services';
import {
  pluginsManagePage,
  pluginFormPage,
  pluginAssetsPage,
  pluginFilePrefixesPage,
  pluginCreditsPage,
  pluginLimitsPage,
  pluginPageTypesPage,
  type PluginCreditRow,
  type PluginLimitRow,
  type PluginListItem,
} from '../templates/manage';
import { pluginTrustLevel, type PluginManifest, type PluginPageTypeApproval, type ResolvedPlugin } from '../types';

export const pluginsManageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
pluginsManageRoutes.onError((error,c)=>{if(error instanceof PluginSettingsUnavailableError)return c.json({error:'plugin_settings_change_unavailable'},503,{'Cache-Control':'no-store'});if(error instanceof PluginApprovalUnavailableError)return c.json({error:'plugin_approval_change_unavailable'},503,{'Cache-Control':'no-store'});if(error instanceof PluginRegistrationUnavailableError)return c.json({error:'plugin_registration_change_unavailable'},503,{'Cache-Control':'no-store'});throw error;});

pluginsManageRoutes.use('/plugins-manage', requirePermission('plugin:manage'));
pluginsManageRoutes.use('/plugins-manage/*', requirePermission('plugin:manage'));

const TENANT_CONFIG_PATH = `${PLUGIN_PREFIX}/tenants/config`;
const TENANT_VAR_FORM_PREFIX = 'tenant_var_';

function manifestTenantVars(manifest: PluginManifest | undefined): string[] {
  return [...new Set([
    ...(manifest?.tenantVars ?? []),
    ...(manifest?.tenant_vars ?? []),
  ])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface TenantConfigRead {
  available: boolean;
  values: Record<string, string>;
  retryable?: boolean;
}

/** Reads only the manifest-declared tenant vars; never logs or stores values. */
async function readPluginTenantConfig(
  c: AppContext,
  plugin: ResolvedPlugin | undefined,
  tenantId: string,
  names: string[],
): Promise<TenantConfigRead> {
  if (!plugin || !tenantId || !names.length) return { available: false, values: {} };
  const secret = plugin.apiSecret || plugin.secret;
  if (!secret) return { available: false, values: {} };

  await auditPluginManagement(c.env, plugin.manifest.id, 'tenant-config-read', contextActor(c));
  try {
    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${TENANT_CONFIG_PATH}`, {
      headers: {
        'x-plugin-secret': secret,
        'x-cms-tenant': tenantId,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        available: false,
        values: {},
        // An isolate can still see an empty registry, a missing tenant, or
        // the legacy tenant while a newly enrolled KV record propagates.
        retryable: [403, 404, 409, 500].includes(response.status),
      };
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!isRecord(body)) return { available: false, values: {} };
    const rawVars = body.vars;
    if (!isRecord(rawVars)) return { available: false, values: {} };
    return {
      available: true,
      values: Object.fromEntries(names.map((name) => [
        name,
        typeof rawVars[name] === 'string' ? rawVars[name] : '',
      ])),
    };
  } catch {
    return { available: false, values: {}, retryable: true };
  }
}


// ── List ──────────────────────────────────────────────────────────────────────

function requestedPageTypeScopes(contentTypes: PluginManifest['contentTypes']) {
  return {
    readTypes: new Set(contentTypes?.readTypes ?? []),
    writeTypes: new Set([...(contentTypes?.writeTypes ?? []), ...Object.keys(contentTypes?.blueprint ?? {})]),
  };
}

function pageTypeApprovalIndex(approvals: PluginPageTypeApproval[]) {
  recordMetadataReads('plugin.type-approvals-read', 'plugin_page_type_approvals', approvals.map(approval => `${approval.plugin_id}:${approval.page_type}:${approval.access}`));
  return new Map(approvals.map(approval => [`${approval.page_type}:${approval.access}`, approval]));
}

async function taxonomyGrants(c: AppContext, registrationId?: number) {
  const query = `SELECT pin.plugin_row_id AS registrationId, grantRow.id FROM plugin_identity_approvals pin
    JOIN plugin_capability_approvals grantRow ON grantRow.plugin_id=pin.manifest_id
    WHERE grantRow.capability='taxonomy:create'`;
  const rows = await c.env.DB.prepare(query + (registrationId === undefined ? '' : ' AND pin.plugin_row_id=?'))
    .bind(...(registrationId === undefined ? [] : [registrationId])).all<{registrationId: number; id: number}>();
  recordTableReads('plugin.capability-read', 'plugin_capability_approvals', rows.results.map(row => row.id));
  return new Set(rows.results.map(row => row.registrationId));
}

pluginsManageRoutes.get('/plugins-manage', async (c) => {
  const [rows, resolved, identities, taxonomyApprovals] = await Promise.all([
    listPlugins(c.env.DB),
    getPlugins(c.env),
    pluginIdentityStates(c.env),
    taxonomyGrants(c),
  ]);
  recordTableReads('plugin.registry-list', 'plugins', rows.map(row => row.id));
  recordMetadataReads('plugin.identity-read', 'plugin_identity_approvals', identities.filter(state => state.pinnedId).map(state => state.rowId));
  recordContributorReads('plugin.metadata-read', [...resolved.map(plugin => plugin.manifest.id), ...identities.flatMap(state => state.pinnedId ? [state.pinnedId] : [])]);
  // resolved plugins are keyed by their base URL (ResolvedPlugin.binding).
  const byUrl = new Map(resolved.map((p) => [p.binding, p]));
  // A plugin held back over its identity is reachable but deliberately not
  // resolved, so it must not read as merely "unreachable" in the list.
  const identityById = new Map(identities.map((state) => [state.rowId, state]));

  const plugins: PluginListItem[] = await Promise.all(rows.map(async (row) => {
    const plugin = byUrl.get(row.url);
    const manifest = plugin?.requestedManifest ?? plugin?.manifest;
    const identity = identityById.get(row.id);
    const status: PluginListItem['status'] = !row.enabled
      ? 'disabled'
      : manifest
        ? 'active'
        : identity && identity.status !== 'ok'
          ? 'identity'
          : 'unreachable';
    const assetHealth = plugin && manifest?.assets?.length
      ? await inspectAssetHealth(c.env.DB, manifest.id, plugin.fetcher, manifest.assets)
      : undefined;
    const { readTypes, writeTypes } = requestedPageTypeScopes(manifest?.contentTypes);
    let pageTypeStatus: PluginListItem['pageTypeStatus'];
    const requestsTaxonomies = manifest?.capabilities?.includes('taxonomy:create');
    if (plugin && (readTypes.size || writeTypes.size || requestsTaxonomies)) {
      const approvals = pageTypeApprovalIndex(plugin.pageTypeApprovals);
      const pending = (requestsTaxonomies && !taxonomyApprovals.has(row.id)) || [...readTypes].some(type => !approvals.has(`${type}:read`))
        || [...writeTypes].some(type => !approvals.has(`${type}:write`));
      pageTypeStatus = pending ? 'pending' : 'approved';
    }
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      enabled: !!row.enabled,
      status,
      manifestId: manifest?.id ?? identity?.servedId,
      manifestName: manifest?.name,
      version: manifest?.version,
      trustLevel: plugin ? pluginTrustLevel(plugin.manifest) : undefined,
      hasAssets: !!manifest?.assets?.length,
      hasFilePrefixes: !!manifest?.filePrefixes?.length,
      hasPageTypes: !!(pageTypeStatus || taxonomyApprovals.has(row.id) || Object.keys(manifest?.contentTypes?.taxonomies ?? {}).length),
      pageTypeStatus,
      hasLimits: !!manifest?.limits?.length,
      hasCredits: !!manifest?.credits?.length,
      assetNeedsApproval: !!assetHealth?.needsApproval,
      assetNeedsUpdate: !!assetHealth?.needsUpdate,
      assetStatusError: !!assetHealth?.fetchError,
    };
  }));

  return renderPage(c, pluginsManagePage, { plugins });
});

// ── Create ──────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/new', async (c) => {
  return renderPage(c, pluginFormPage, {
    isNew: true,
    label: '',
    url: '',
    enabled: true,
    sortOrder: 0,
    config: '',
  });
});

pluginsManageRoutes.post('/plugins-manage', async (c) => {
  const { input, error, raw } = readForm(await c.req.formData(), !!c.env.PLUGIN_VIEWS_BUCKET, !!c.env.PLUGIN_LOCAL_VIEWS);
  if (!input) {
    return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: error ?? undefined });
  }
  const mutation = await preparePluginRegistrationMutation(c);
  try {
    const created = await mutation.create(input);
    return c.redirect(`/admin/plugins-manage/${created.id}/edit?flash=secret-generated`);
  } catch (error) {
    if (error instanceof PluginRegistrationConflictError) return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: error.message });
    throw error;
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row: plugin, resolved } = found;
  const tenantId = pluginTenantId(c.env);
  const tenantVarNames = manifestTenantVars(resolved?.manifest);
  const flash = c.req.query('flash');
  let tenantConfig: TenantConfigRead;
  try { tenantConfig = await readPluginTenantConfig(c, resolved, tenantId, tenantVarNames); }
  catch { return auditUnavailable(c); }
  const identity = (await pluginIdentityStates(c.env)).find((state) => state.rowId === id);
  return renderPage(c, pluginFormPage, {
    isNew: false,
    id: plugin.id,
    identityStatus: identity?.status ?? (plugin.enabled ? 'unreachable' : 'disabled'),
    identityPinnedId: identity?.pinnedId ?? '',
    identityServedId: identity?.servedId ?? '',
    identityAction: `/admin/plugins-manage/${plugin.id}/identity`,
    label: plugin.label,
    url: plugin.url,
    enabled: !!plugin.enabled,
    sortOrder: plugin.sort_order,
    config: plugin.config ?? '',
    viewSource: pluginViewSource(plugin.config),
    trustedUi: (() => { try { return JSON.parse(plugin.config || '{}').cmsTrustedUi === true; } catch { return false; } })(),
    secret: plugin.secret ?? '',
    tenantKvKey: `tenant:${tenantId}`,
    tenantVars: tenantVarNames.map((name) => ({ name, value: tenantConfig.values[name] ?? '' })),
    tenantConfigAvailable: tenantConfig.available,
    tenantConfigPending: !!tenantConfig.retryable && (flash === 'connect-ok' || flash === 'rotate-connect-ok'),
    tenantConfigAction: `/admin/plugins-manage/${plugin.id}/tenant-config`,
    // Connect is offered only when the plugin says it accepts enrollment AND
    // we have a canonical origin for it to verify us against.
    autoTenant: !!resolved && manifestAllowsAutoTenant(resolved.manifest) && !!tenantId,
    flash,
  });
});

pluginsManageRoutes.get('/plugins-manage/:id/tenant-config', async (c) => {
  const found = await resolvedPluginFor(c.env, Number(c.req.param('id')));
  if (!found) return c.notFound();
  try {
    const config = await readPluginTenantConfig(c, found.resolved, pluginTenantId(c.env), manifestTenantVars(found.resolved?.manifest));
    return c.json(config);
  } catch {
    return auditUnavailable(c);
  }
});

pluginsManageRoutes.post('/plugins-manage/:id/tenant-config', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row: plugin, resolved } = found;
  const tenantId = pluginTenantId(c.env);
  const names = manifestTenantVars(resolved?.manifest);
  const secret = resolved?.apiSecret || resolved?.secret || '';
  if (!resolved || !tenantId || !names.length || !secret) {
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
  }

  const form = await c.req.formData();
  const vars: Record<string, string | null> = {};
  for (const name of names) {
    const value = form.get(`${TENANT_VAR_FORM_PREFIX}${name}`);
    if (value === null) continue;
    if (typeof value !== 'string') {
      logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, { ok: false, keys: [name] });
      return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
    }
    vars[name] = value === '' ? null : value;
  }

  try { await auditPluginManagement(c.env, resolved.manifest.id, 'tenant-config-write', contextActor(c)); }
  catch { return auditUnavailable(c); }
  try {
    const response = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${TENANT_CONFIG_PATH}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-plugin-secret': secret,
        'x-cms-tenant': tenantId,
      },
      body: JSON.stringify({ vars }),
    });
    const ok = response.ok;
    await response.body?.cancel();
    logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, {
      ok,
      keys: Object.keys(vars),
      status: response.status,
    });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${ok ? 'tenant-config-saved' : 'tenant-config-failed'}`);
  } catch (error) {
    console.error('Plugin tenant config update failed', { plugin: resolved.manifest.id });
    logAudit(c, 'plugin.tenant.config', 'plugin', plugin.url, { ok: false, keys: Object.keys(vars) });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=tenant-config-failed`);
  }
});

/** Maps an enrollment outcome onto the flash code the edit page renders. */
function enrollFlash(prefix: string, result: { ok: boolean; code: string }): string {
  return result.ok ? `${prefix}-ok` : `${prefix}-${result.code}`;
}

pluginsManageRoutes.post('/plugins-manage/:id/connect', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) return c.redirect(`/admin/plugins-manage/${id}/edit?flash=connect-unreachable`);

  const result = await enrollPluginTenant(c.env, resolved, contextActor(c));
  if (result.code === 'audit-unavailable') return auditUnavailable(c);
  if (result.ok) {
    // Enrollment changes the plugin's effective connection state outside D1.
    // Treat it like enable/disable: discard the resolved registry/config
    // snapshots, then eagerly resolve once so the redirect lands on freshly
    // validated plugin state instead of waiting for cache expiry.
    invalidate();
    await getPlugins(c.env);
  }
  logAudit(c, 'plugin.tenant.connect', 'plugin', row.url, {
    ok: result.ok,
    code: result.code,
    ...(result.detail ? { detail: result.detail } : {}),
  });
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('connect', result)}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/disconnect', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) return c.redirect(`/admin/plugins-manage/${id}/edit?flash=disconnect-unreachable`);

  const result = await revokePluginTenant(c.env, resolved, contextActor(c));
  logAudit(c, 'plugin.tenant.disconnect', 'plugin', row.url, {
    ok: result.ok,
    code: result.code,
    ...(result.auditUnavailable ? { audit_unavailable: true } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
  });
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('disconnect', result)}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/rotate-secret', async (c) => {
  const id = Number(c.req.param('id'));
  const mutation = await preparePluginRegistrationMutation(c);
  if (!mutation.row(id)) return c.notFound();
  const plugin = await mutation.rotate(id);

  // Rotation breaks the connection the instant it lands, so push the new
  // secret straight away for plugins that accept enrollment — otherwise the
  // admin is left with a plugin that 403s until they remember to reconnect.
  const resolved = (await getPlugins(c.env)).find((candidate) => candidate.binding === plugin.url);
  if (resolved && manifestAllowsAutoTenant(resolved.manifest)) {
    const result = await enrollPluginTenant(c.env, resolved, contextActor(c));
    if (result.code === 'audit-unavailable') return auditUnavailable(c);
    logAudit(c, 'plugin.tenant.connect', 'plugin', plugin.url, {
      ok: result.ok,
      code: result.code,
      after: 'rotate',
      ...(result.detail ? { detail: result.detail } : {}),
    });
    return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${enrollFlash('rotate-connect', result)}`);
  }
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=secret-rotated`);
});

pluginsManageRoutes.post('/plugins-manage/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const mutation = await preparePluginRegistrationMutation(c);
  if (!mutation.row(id)) return c.notFound();
  const { input, error, raw } = readForm(await c.req.formData(), !!c.env.PLUGIN_VIEWS_BUCKET, !!c.env.PLUGIN_LOCAL_VIEWS);
  if (!input) return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: error ?? undefined });
  try {
    await mutation.update(id,input);
  } catch (error) {
    if (error instanceof PluginRegistrationConflictError) return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: error.message });
    throw error;
  }
  return c.redirect('/admin/plugins-manage');
});

pluginsManageRoutes.post('/plugins-manage/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  const mutation = await preparePluginRegistrationMutation(c);
  if (!mutation.row(id)) return c.notFound();
  await mutation.toggle(id);
  return c.redirect('/admin/plugins-manage');
});

/**
 * Re-approves a plugin's identity after its manifest id changed.
 *
 * A changed id is either a rename or a takeover, and the CMS cannot tell them
 * apart — so the plugin stays unresolved until an admin says which it is. The
 * capabilities the previous identity held are NOT carried over: asset,
 * page-type and file-prefix approvals were granted to that id and must be
 * granted again deliberately. Host-held state moves, because it is the
 * plugin's data rather than a privilege.
 */
pluginsManageRoutes.post('/plugins-manage/:id/identity', async (c) => {
  const id = Number(c.req.param('id'));
  const result = await mutatePluginApproval(c, {id, action:'plugin.identity.approve'});
  if (result === 'missing') return c.notFound();
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=${result === 'unreachable' ? 'identity-unreachable' : result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const mutation = await preparePluginRegistrationMutation(c);
  if (!mutation.row(id)) return c.notFound();
  // Use the captured pin even when disabled/offline. Unpinned legacy rows
  // remove only their registry entry; do not infer ownership from a live URL.
  const pin = await getIdentityForRow(c.env.DB, id);
  await mutation.remove(id);
  // Unregistering releases the manifest id, so the credits its creator
  // supplied are forfeited — a Worker that later claims the id inherits
  // nothing. Inert when no credits feature is installed.
  if (pin) {
    await callFeatureService('credits', 'forfeit-plugin-wallet', c.env, {
      contributorId: pin.manifest_id,
      createdBy: String(c.get('user').sub),
    });
  }
  return c.redirect('/admin/plugins-manage');
});

// ── Asset approvals ────────────────────────────────────────────────────────
// A plugin's manifest only *declares* candidate JS/CSS files (PluginManifest.
// assets); nothing runs in CMS chrome until an admin explicitly approves a
// path here, pinning its content hash. See utils/plugin-assets.ts.

async function resolvedPluginFor(env: Env, id: number, announce = false) {
  const row = await getPlugin(env.DB, id);
  if (!row) return null;
  const resolved = (await getPlugins(env)).find((plugin) => plugin.binding === row.url);
  if (announce) {
    recordMetadataReads('plugin.registry-read', 'plugins', [row.id]);
    const identity = (await listIdentityApprovals(env.DB)).find(identity => identity.plugin_row_id === id);
    recordMetadataReads('plugin.identity-read', 'plugin_identity_approvals', identity ? [id] : []);
    const sourceId = resolved?.manifest.id ?? identity?.manifest_id;
    if (sourceId) recordContributorReads('plugin.metadata-read', [sourceId]);
  }
  return { row, resolved };
}

pluginsManageRoutes.get('/plugins-manage/:id/assets', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginAssetsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      assets: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declared = resolved.manifest.assets ?? [];
  const approvals = new Map((await listApprovals(c.env.DB, resolved.manifest.id)).map((a) => [a.path, a]));
  recordMetadataReads('plugin.asset-approvals-read', 'plugin_asset_approvals', [...approvals.keys()].map(path => `${resolved.manifest.id}:${path}`));

  // Approval inspection fetches manifest-declared resources from the plugin.
  // Gate the exchange before starting any of the parallel requests.
  if (declared.length) {
    try { await auditPluginManagement(c.env, resolved.manifest.id, 'asset-inspect', contextActor(c)); }
    catch { return auditUnavailable(c); }
  }

  const assets = await Promise.all(declared.map(async (asset) => {
    const approval = approvals.get(asset.path);
    let currentIntegrity: string | null = null;
    let fetchError = false;
    try {
      const upstream = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${asset.path}`);
      if (upstream.ok) currentIntegrity = await computeIntegrity(await limitedBytes(upstream));
      else fetchError = true;
    } catch {
      fetchError = true;
    }
    const approved = !!approval;
    const drifted = approved && currentIntegrity !== null && currentIntegrity !== approval.integrity;
    return {
      path: asset.path,
      label: asset.label || asset.path,
      approved,
      drifted,
      fetchError,
      approvedBy: approval?.approved_by ?? '',
      integrity: approval?.integrity ?? '',
      approveAction: `/admin/plugins-manage/${id}/assets/approve`,
      revokeAction: `/admin/plugins-manage/${id}/assets/revoke`,
    };
  }));

  return renderPage(c, pluginAssetsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    assets,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/approve-all', async (c) => {
  const id = Number(c.req.param('id'));
  const result = await mutatePluginApproval(c, {id, action:'plugin.asset.approve_all'});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.asset.approve', key:str(form.get('path'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown asset path', 400);
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.asset.revoke', key:str(form.get('path'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown asset path', 400);
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=${result}`);
});

// ── File-prefix approvals ─────────────────────────────────────────────────
// A manifest only declares candidate host-storage namespaces. Approval is
// explicit and global: an approved prefix also reserves every nested prefix
// from another plugin, so plugins cannot overwrite one another's R2 folders.

pluginsManageRoutes.get('/plugins-manage/:id/files', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginFilePrefixesPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      prefixes: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declared = resolved.manifest.filePrefixes ?? [];
  const approvals = new Map((await listFilePrefixApprovals(c.env.DB, resolved.manifest.id)).map((approval) => [approval.prefix, approval]));
  recordMetadataReads('plugin.file-approvals-read', 'plugin_file_prefix_approvals', [...approvals.keys()].map(prefix => `${resolved.manifest.id}:${prefix}`));
  const prefixes = await Promise.all(declared.map(async (prefix) => {
    const approval = approvals.get(prefix);
    const conflict = approval ? null : await findFilePrefixConflict(c.env.DB, resolved.manifest.id, prefix);
    if (conflict) {
      recordMetadataReads('plugin.file-approvals-read', 'plugin_file_prefix_approvals', [`${conflict.plugin_id}:${conflict.prefix}`]);
      recordContributorReads('plugin.conflict-metadata-read', [conflict.plugin_id]);
    }
    return {
      prefix,
      approved: !!approval,
      approvedBy: approval?.approved_by ?? '',
      conflict: !!conflict,
      conflictPluginId: conflict?.plugin_id ?? '',
      approveAction: `/admin/plugins-manage/${id}/files/approve`,
      revokeAction: `/admin/plugins-manage/${id}/files/revoke`,
    };
  }));

  return renderPage(c, pluginFilePrefixesPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    prefixes,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/files/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.file_prefix.approve', key:str(form.get('prefix'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown file prefix', 400);
  return c.redirect(`/admin/plugins-manage/${id}/files?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/files/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.file_prefix.revoke', key:str(form.get('prefix'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown file prefix', 400);
  return c.redirect(`/admin/plugins-manage/${id}/files?flash=${result}`);
});

// ── Quota limits ───────────────────────────────────────────────────────────
// A plugin's manifest only *declares* which limits exist (PluginManifest.
// limits). Values are stored in settings. The host enforces page quotas on
// creates; plugins enforce operational limits. See utils/plugin-limits.ts.

function scopeKey(def: NormalizedLimitDef): string {
  if (def.scope === 'per_second') return 'view_strings.sections_plugin_limits.scope_per_second';
  if (def.scope === 'per_parent') return 'view_strings.sections_plugin_limits.scope_per_parent';
  if (def.scope === 'per_pointer') return 'view_strings.sections_plugin_limits.scope_per';
  return 'view_strings.sections_plugin_limits.scope_total';
}

function limitLabel(value: number | null): string {
  return value === null ? '' : String(value);
}

pluginsManageRoutes.get('/plugins-manage/:id/limits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginLimitsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      limits: [],
      saveAction: `/admin/plugins-manage/${id}/limits`,
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const allowed = await limitScopeTypes(c.env.DB, resolved.manifest);
  const defs = declaredLimits(resolved.manifest, allowed);
  const values = await loadLimitValues(c.env, resolved.manifest.id);

  const limits: PluginLimitRow[] = await Promise.all(defs.map(async (def) => {
    const configured = def.key in values;
    const effective = configured ? values[def.key] : def.defaultValue;
    // Scoped usage varies per parent/collection, so only totals are shown here.
    const usageLabel = def.scope === 'total' ? String(await countLimitUsage(c.env.DB, def, null)) : '';
    const usageKey = def.scope === 'per_second'
      ? 'view_strings.sections_plugin_limits.usage_not_counted'
      : def.scope === 'total'
        ? ''
        : 'view_strings.sections_plugin_limits.usage_varies_by_group';
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      pageType: def.pageType ?? '',
      pageTypeKey: def.pageType ? '' : 'view_strings.sections_plugin_limits.email_delivery',
      scopeLabel: '',
      scopeKey: scopeKey(def),
      scopeDetail: def.scope === 'per_pointer' ? def.pointerKey ?? '' : '',
      defaultLabel: limitLabel(def.defaultValue),
      defaultKey: def.defaultValue === null ? 'view_strings.sections_plugin_limits.unlimited' : '',
      effectiveLabel: limitLabel(effective),
      effectiveKey: effective === null ? 'view_strings.sections_plugin_limits.unlimited' : '',
      usesDefault: !configured,
      usageLabel,
      usageKey,
      value: configured && values[def.key] !== null ? String(values[def.key]) : '',
      unlimited: configured && values[def.key] === null,
    };
  }));

  return renderPage(c, pluginLimitsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    limits,
    saveAction: `/admin/plugins-manage/${id}/limits`,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/limits', async (c) => {
  const id = Number(c.req.param('id'));
  if(!await mutatePluginSettings(c,id,'limits',await c.req.formData()))return c.notFound();
  return c.redirect(`/admin/plugins-manage/${id}/limits?flash=saved`);
});

// ── Credit costs ───────────────────────────────────────────────────────────
// A plugin's manifest only *declares* which chargeable actions exist
// (PluginManifest.credits). Prices configured here are stored in the settings
// table; the host deducts from the acting user's balance on each action and
// logs every change in credit_ledger. See utils/credits.ts.

function priceLabel(value: number): string {
  return value === 0 ? '' : String(value);
}

interface CreditPricingPayload {
  key: string;
  label: string;
  description: string;
  currency: string;
  currencyKey: string;
  chargeLabel: string;
  chargeKey: string;
  defaultValue: number;
  effectiveValue: number;
  configured: boolean;
  pluginOnly?: boolean;
}

/** The plugin's own wallets — credits its creator supplied — as the credits
 *  feature reports them. Absent when no credits feature is installed. */
type PluginWalletPayload = NonNullable<Parameters<typeof pluginCreditsPage>[1]['wallet']>;

pluginsManageRoutes.get('/plugins-manage/:id/credits', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginCreditsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      credits: [],
      wallet: null,
      saveAction: `/admin/plugins-manage/${id}/credits`,
      flash: c.req.query('flash') ?? undefined,
    });
  }

  // Prices come from whoever meters them; with no such feature installed the
  // list is empty and the screen shows a plugin with nothing chargeable.
  const pricing = await callFeatureService<CreditPricingPayload[]>(
    'credits',
    'pricing',
    c.env,
    { contributorId: resolved.manifest.id },
  ) ?? [];
  const credits: PluginCreditRow[] = pricing.map((row) => ({
    key: row.key,
    label: row.label,
    description: row.description,
    currency: row.currency,
    currencyKey: row.currencyKey,
    chargeLabel: row.chargeLabel,
    chargeKey: row.chargeKey,
    chargeDetail: row.chargeLabel,
    defaultLabel: priceLabel(row.defaultValue),
    defaultKey: row.defaultValue === 0 ? 'view_strings.sections_plugin_credits.free' : '',
    effectiveLabel: priceLabel(row.effectiveValue),
    effectiveKey: row.effectiveValue === 0 ? 'view_strings.sections_plugin_credits.free' : '',
    usesDefault: !row.configured,
    value: row.configured ? String(row.effectiveValue) : '',
    pluginOnly: row.pluginOnly === true,
  }));
  const wallet = await callFeatureService<PluginWalletPayload>(
    'credits',
    'plugin-wallet',
    c.env,
    { contributorId: resolved.manifest.id },
  ) ?? null;

  return renderPage(c, pluginCreditsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    credits,
    wallet,
    saveAction: `/admin/plugins-manage/${id}/credits`,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/credits', async (c) => {
  const id = Number(c.req.param('id'));
  if(!await mutatePluginSettings(c,id,'pricing',await c.req.formData()))return c.notFound();
  return c.redirect(`/admin/plugins-manage/${id}/credits?flash=saved`);
});

// ── Page type access approvals ─────────────────────────────────────────────
// Manifest readTypes/writeTypes are delegated access requests. They are only
// honored by /__cms after an admin approves the specific plugin/type/access row.

pluginsManageRoutes.get('/plugins-manage/:id/page-types', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id, true);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  const taxonomyApproved = (await taxonomyGrants(c, id)).has(id);
  if (!resolved) {
    return renderPage(c, pluginPageTypesPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true, taxonomyApproved,
      definedPageTypes: [],
      definedTaxonomies: [],
      pageTypes: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declaredManifest = resolved.requestedManifest ?? resolved.manifest;
  const { readTypes, writeTypes } = requestedPageTypeScopes(declaredManifest.contentTypes);
  const definedPageTypes = Object.entries((resolved.requestedManifest ?? resolved.manifest).contentTypes?.blueprint ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, blueprint]) => ({
      slug,
      fieldCount: Array.isArray(blueprint) ? blueprint.length : 0,
      viewHref: `/admin/page_types/view/${encodeURIComponent(slug)}`,
    }));
  const definedTaxonomies = Object.entries((resolved.requestedManifest ?? resolved.manifest).contentTypes?.taxonomies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, name]) => ({
      slug,
      name,
      viewHref: `/admin/taxonomies/view/${encodeURIComponent(slug)}`,
    }));
  const pageTypeNames = [...new Set([...readTypes, ...writeTypes])].sort();
  const approvalByKey = pageTypeApprovalIndex(resolved.pageTypeApprovals);

  const pageTypes = pageTypeNames.map((pageType) => {
    const readApproval = approvalByKey.get(`${pageType}:read`);
    const writeApproval = approvalByKey.get(`${pageType}:write`);
    return {
      pageType,
      pageTypeLabel: isPageTypeWildcard(pageType) ? 'All page types' : pageType,
      readDeclared: readTypes.has(pageType),
      writeDeclared: writeTypes.has(pageType),
      readApproved: !!readApproval,
      writeApproved: !!writeApproval,
      readApprovedBy: readApproval?.approved_by ?? '',
      writeApprovedBy: writeApproval?.approved_by ?? '',
      approveReadAction: `/admin/plugins-manage/${id}/page-types/approve`,
      revokeReadAction: `/admin/plugins-manage/${id}/page-types/revoke`,
      approveWriteAction: `/admin/plugins-manage/${id}/page-types/approve`,
      revokeWriteAction: `/admin/plugins-manage/${id}/page-types/revoke`,
    };
  });

  return renderPage(c, pluginPageTypesPage, {
    pluginId: id,
    pluginLabel: (resolved.requestedManifest ?? resolved.manifest).name || row.label || row.url,
    unreachable: false, taxonomyApproved, taxonomyRequested: declaredManifest.capabilities?.includes('taxonomy:create'),
    definedPageTypes,
    definedTaxonomies,
    pageTypes,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/capabilities/taxonomy-create/:decision', async c => {
  const id = Number(c.req.param('id'));
  const decision = c.req.param('decision');
  if (decision !== 'approve' && decision !== 'revoke') return c.notFound();
  const result = await mutatePluginApproval(c, { id, action: `plugin.capability.${decision}`, key: 'taxonomy:create' });
  if (result === 'invalid') return c.text('The plugin must request taxonomy creation.', 400);
  if (result !== 'approved' && result !== 'revoked') return c.notFound();
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/page-types/approve-all', async (c) => {
  const id = Number(c.req.param('id'));
  const result = await mutatePluginApproval(c, {id, action:'plugin.page_type.approve_all'});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown page type access', 400);
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/page-types/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.page_type.approve', key:str(form.get('page_type')), access:str(form.get('access'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown page type access', 400);
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=${result}`);
});

pluginsManageRoutes.post('/plugins-manage/:id/page-types/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const result = await mutatePluginApproval(c, {id, action:'plugin.page_type.revoke', key:str(form.get('page_type')), access:str(form.get('access'))});
  if (result === 'missing' || result === 'unreachable') return c.notFound();
  if (result === 'invalid') return c.text('Unknown page type access', 400);
  return c.redirect(`/admin/plugins-manage/${id}/page-types?flash=${result}`);
});

/** After any registry mutation, drop the plugin-list, manifest, and merged-config caches. */
function invalidate(): void {
  clearManifestCache();
  clearConfigCache();
}
