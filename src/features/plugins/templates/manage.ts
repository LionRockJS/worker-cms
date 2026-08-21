import { adminLayout, type BaseTemplateProps } from '../../../core/render/layout';
import { renderView } from '../../../core/render/liquid';

export interface PluginListItem {
  id: number;
  label: string;
  url: string;
  enabled: boolean;
  /** Resolved from the live manifest, when the plugin is reachable.
   *  'identity' means the manifest resolved but its id is pinned elsewhere or
   *  no longer matches this row's pin — see registry.pluginIdentityStates. */
  status: 'active' | 'unreachable' | 'disabled' | 'identity';
  manifestId?: string;
  manifestName?: string;
  version?: string;
  trustLevel?: 'server-only' | 'sandboxed-ui' | 'trusted-ui';
  /** True when the manifest declares candidate JS/CSS assets to approve. */
  hasAssets?: boolean;
  /** True when the manifest declares host file prefixes to approve. */
  hasFilePrefixes?: boolean;
  /** Live approval health for the manifest-declared assets. */
  assetNeedsApproval?: boolean;
  assetNeedsUpdate?: boolean;
  assetStatusError?: boolean;
  /** True when the manifest defines page types/taxonomies or declares delegated access. */
  hasPageTypes?: boolean;
  /** True when the manifest declares configurable quota limits. */
  hasLimits?: boolean;
  /** True when the manifest declares configurable credit costs. */
  hasCredits?: boolean;
}

const STATUS_BADGE: Record<PluginListItem['status'], string> = {
  active: 'bg-green-100 text-green-800',
  unreachable: 'bg-red-100 text-red-800',
  identity: 'bg-red-100 text-red-800',
  disabled: 'bg-gray-100 text-gray-600',
};

export async function pluginsManagePage(views: Fetcher, opts: BaseTemplateProps & {
  plugins: PluginListItem[];
}): Promise<string> {
  const { plugins } = opts;
  const body = await renderView(views, '/templates/plugins-manage.json', {
    hasPlugins: plugins.length > 0,
    plugins: plugins.map((plugin) => ({
      title: plugin.manifestName || plugin.label || plugin.manifestId || plugin.url,
      subtitle: plugin.manifestId ? `${plugin.manifestId}${plugin.version ? ` · v${plugin.version}` : ''}` : plugin.url,
      url: plugin.url,
      enabled: plugin.enabled,
      status: plugin.status,
      statusKey: `plugins.status.${plugin.status}`,
      statusClass: STATUS_BADGE[plugin.status],
      trustLevelKey: plugin.trustLevel ? `plugins.trust.${plugin.trustLevel.replaceAll('-', '_')}` : '',
      trustLevelClass: plugin.trustLevel === 'trusted-ui'
        ? 'bg-red-100 text-red-800'
        : plugin.trustLevel === 'sandboxed-ui'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-green-100 text-green-800',
      toggleAction: `/admin/plugins-manage/${plugin.id}/toggle`,
      editHref: `/admin/plugins-manage/${plugin.id}/edit`,
      deleteAction: `/admin/plugins-manage/${plugin.id}/delete`,
      hasAssets: !!plugin.hasAssets,
      assetNeedsApproval: !!plugin.assetNeedsApproval,
      assetNeedsUpdate: !!plugin.assetNeedsUpdate,
      assetStatusError: !!plugin.assetStatusError,
      assetsHref: `/admin/plugins-manage/${plugin.id}/assets`,
      hasFilePrefixes: !!plugin.hasFilePrefixes,
      filePrefixesHref: `/admin/plugins-manage/${plugin.id}/files`,
      hasPageTypes: !!plugin.hasPageTypes,
      pageTypesHref: `/admin/plugins-manage/${plugin.id}/page-types`,
      hasLimits: !!plugin.hasLimits,
      limitsHref: `/admin/plugins-manage/${plugin.id}/limits`,
      hasCredits: !!plugin.hasCredits,
      creditsHref: `/admin/plugins-manage/${plugin.id}/credits`,
    })),
  });

  return adminLayout(views, opts, { title: 'Plugins', body });
}

/**
 * Flash code → translation key for the plugin form. Enrollment adds a family of
 * outcome codes (`connect-*`, `disconnect-*`, `rotate-connect-*`); unknown
 * codes render nothing rather than a missing-key placeholder.
 */
function pluginFormFlashKey(flash: string | undefined): string {
  if (!flash) return '';
  const keys: Record<string, string> = {
    'secret-generated': 'plugins.form.registered_flash',
    'secret-rotated': 'plugins.form.rotated_flash',
    'connect-ok': 'plugins.form.connect_ok',
    'connect-unreachable': 'plugins.form.connect_unreachable',
    'connect-rejected': 'plugins.form.connect_rejected',
    'connect-not-supported': 'plugins.form.connect_not_supported',
    'connect-no-secret': 'plugins.form.connect_no_secret',
    'connect-no-canonical-origin': 'plugins.form.connect_no_origin',
    'tenant-config-saved': 'view_strings.sections_plugin_form.tenant_config_saved',
    'tenant-config-failed': 'view_strings.sections_plugin_form.tenant_config_failed',
    'rotate-connect-ok': 'plugins.form.rotate_connect_ok',
    'disconnect-ok': 'plugins.form.disconnect_ok',
    'disconnect-unreachable': 'plugins.form.connect_unreachable',
    'disconnect-rejected': 'plugins.form.disconnect_rejected',
    'disconnect-no-secret': 'plugins.form.connect_no_secret',
    'identity-approved': 'plugins.identity.approved',
    'identity-claimed': 'plugins.identity.claimed_flash',
    'identity-unreachable': 'plugins.identity.unreachable_flash',
    'identity-ok': 'plugins.identity.already_ok',
  };
  // Every rotate-then-connect failure carries the same advice: the secret DID
  // rotate, the plugin just did not take it.
  if (!keys[flash] && flash.startsWith('rotate-connect-')) return 'plugins.form.rotate_connect_failed';
  return keys[flash] ?? '';
}

export async function pluginFormPage(views: Fetcher, opts: BaseTemplateProps & {
  isNew: boolean;
  id?: number;
  label: string;
  url: string;
  enabled: boolean;
  sortOrder: number;
  config: string;
  secret?: string;
  /** Pinned-identity state for this row (see registry.pluginIdentityStates). */
  identityStatus?: 'ok' | 'mismatch' | 'claimed' | 'unreachable' | 'disabled';
  identityPinnedId?: string;
  identityServedId?: string;
  identityAction?: string;
  tenantKvKey?: string;
  tenantVars?: Array<{ name: string; value: string }>;
  tenantConfigAvailable?: boolean;
  tenantConfigAction?: string;
  autoTenant?: boolean;
  flash?: string;
  error?: string;
}): Promise<string> {
  const {
    isNew,
    id,
    label,
    url,
    enabled,
    sortOrder,
    config,
    secret,
    identityStatus,
    identityPinnedId,
    identityServedId,
    identityAction,
    tenantKvKey,
    tenantVars,
    tenantConfigAvailable,
    tenantConfigAction,
    autoTenant,
    flash,
    error,
  } = opts;
  const heading = isNew ? 'Register Plugin' : 'Edit Plugin';
  const flashMessageKey = pluginFormFlashKey(flash);
  // A failed enrollment is a warning, not the usual informational flash.
  const flashIsError = !!flash && /-(unreachable|rejected|not-supported|no-secret|no-canonical-origin|claimed)$/.test(flash);

  const body = await renderView(views, '/templates/plugin-form.json', {
    headingKey: isNew ? 'plugins.form.register_title' : 'plugins.form.edit_title',
    action: isNew ? '/admin/plugins-manage' : `/admin/plugins-manage/${id}`,
    submitLabelKey: isNew ? 'plugins.form.register' : 'common.save',
    label,
    url,
    enabled,
    sortOrder,
    config,
    hasError: !!error,
    error: error ?? '',
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    flashIsError,
    showSecret: !isNew,
    secret: secret ?? '',
    // The panel only appears when there is something to act on: a pin that no
    // longer matches, or an id another plugin already owns.
    showIdentity: !isNew && (identityStatus === 'mismatch' || identityStatus === 'claimed'),
    identityMismatch: identityStatus === 'mismatch',
    identityPinnedId: identityPinnedId ?? '',
    identityServedId: identityServedId ?? '',
    identityAction: identityAction ?? '',
    tenantKvKey: tenantKvKey ?? '',
    tenantKvValue: JSON.stringify({ secret: secret ?? '' }),
    hasTenantVars: !!tenantVars?.length,
    tenantVars: tenantVars ?? [],
    tenantConfigAvailable: !!tenantConfigAvailable,
    tenantConfigAction: tenantConfigAction ?? '',
    usesSharedSecret: !secret,
    rotateSecretAction: isNew ? '' : `/admin/plugins-manage/${id}/rotate-secret`,
    autoTenant: !isNew && !!autoTenant,
    connectAction: isNew ? '' : `/admin/plugins-manage/${id}/connect`,
    disconnectAction: isNew ? '' : `/admin/plugins-manage/${id}/disconnect`,
  });

  return adminLayout(views, opts, { title: heading, body });
}

export interface PluginAssetRow {
  path: string;
  label: string;
  approved: boolean;
  drifted: boolean;
  fetchError: boolean;
  approvedBy: string;
  integrity: string;
  approveAction: string;
  revokeAction: string;
}

export async function pluginAssetsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  assets: PluginAssetRow[];
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, assets, flash } = opts;
  const flashMessageKey = flash === 'approved'
    ? 'view_strings.sections_plugin_assets.flash_approved'
    : flash === 'revoked'
      ? 'view_strings.sections_plugin_assets.flash_revoked'
      : flash === 'fetch-failed'
        ? 'view_strings.sections_plugin_assets.flash_fetch_failed'
        : '';

  const body = await renderView(views, '/templates/plugin-assets.json', {
    pluginLabel,
    unreachable,
    hasAssets: assets.length > 0,
    assets: assets.map((asset) => ({
      ...asset,
      statusKey: asset.drifted
        ? 'view_strings.sections_plugin_assets.status_expired'
        : asset.approved
          ? 'view_strings.sections_plugin_assets.status_approved'
          : 'view_strings.sections_plugin_assets.status_not_approved',
      statusClass: asset.drifted ? 'bg-red-400 text-amber-800' : asset.approved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Assets`, body });
}

export interface PluginFilePrefixRow {
  prefix: string;
  approved: boolean;
  approvedBy: string;
  conflict: boolean;
  conflictPluginId: string;
  approveAction: string;
  revokeAction: string;
}

export async function pluginFilePrefixesPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  prefixes: PluginFilePrefixRow[];
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, prefixes, flash } = opts;
  const flashMessageKey = flash === 'approved'
    ? 'view_strings.sections_plugin_file_prefixes.flash_approved'
    : flash === 'revoked'
      ? 'view_strings.sections_plugin_file_prefixes.flash_revoked'
      : flash === 'conflict'
        ? 'view_strings.sections_plugin_file_prefixes.flash_conflict'
        : '';

  const body = await renderView(views, '/templates/plugin-file-prefixes.json', {
    pluginLabel,
    unreachable,
    hasPrefixes: prefixes.length > 0,
    prefixes: prefixes.map((prefix) => ({
      ...prefix,
      statusKey: prefix.conflict
        ? 'view_strings.sections_plugin_file_prefixes.status_reserved'
        : prefix.approved
          ? 'view_strings.sections_plugin_file_prefixes.status_approved'
          : 'view_strings.sections_plugin_file_prefixes.status_not_approved',
      statusClass: prefix.conflict
        ? 'bg-red-100 text-red-800'
        : prefix.approved
          ? 'bg-green-100 text-green-800'
          : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Files`, body });
}

export interface PluginLimitRow {
  key: string;
  label: string;
  description: string;
  pageType: string;
  scopeLabel: string;
  scopeKey: string;
  scopeDetail: string;
  defaultLabel: string;
  defaultKey: string;
  effectiveLabel: string;
  effectiveKey: string;
  usesDefault: boolean;
  usageLabel: string;
  usageKey: string;
  pageTypeKey: string;
  /** Configured numeric value as a string, or '' when unset/unlimited. */
  value: string;
  unlimited: boolean;
}

export async function pluginLimitsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  limits: PluginLimitRow[];
  saveAction: string;
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, limits, saveAction, flash } = opts;
  const flashMessageKey = flash === 'saved'
    ? 'view_strings.sections_plugin_limits.flash_saved'
    : '';

  const body = await renderView(views, '/templates/plugin-limits.json', {
    pluginLabel,
    unreachable,
    hasLimits: limits.length > 0,
    limits,
    saveAction,
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Limits`, body });
}

export interface PluginCreditRow {
  key: string;
  label: string;
  description: string;
  /** Wallet the price is denominated in, and the key naming it. */
  currency: string;
  currencyKey: string;
  chargeLabel: string;
  chargeKey: string;
  chargeDetail: string;
  defaultLabel: string;
  defaultKey: string;
  effectiveLabel: string;
  effectiveKey: string;
  usesDefault: boolean;
  /** Configured price as a string, or '' when unset (default applies). */
  value: string;
}

export async function pluginCreditsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  credits: PluginCreditRow[];
  saveAction: string;
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, credits, saveAction, flash } = opts;
  const flashMessageKey = flash === 'saved'
    ? 'view_strings.sections_plugin_credits.flash_saved'
    : '';

  const body = await renderView(views, '/templates/plugin-credits.json', {
    pluginLabel,
    unreachable,
    hasCredits: credits.length > 0,
    credits,
    saveAction,
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Credits`, body });
}

export interface PluginPageTypeRow {
  pageType: string;
  pageTypeLabel: string;
  readDeclared: boolean;
  writeDeclared: boolean;
  readApproved: boolean;
  writeApproved: boolean;
  readApprovedBy: string;
  writeApprovedBy: string;
  approveReadAction: string;
  revokeReadAction: string;
  approveWriteAction: string;
  revokeWriteAction: string;
}

export interface PluginDefinedPageTypeRow {
  slug: string;
  fieldCount: number;
  viewHref: string;
}

export interface PluginDefinedTaxonomyRow {
  slug: string;
  name: string;
  viewHref: string;
}

export async function pluginPageTypesPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  definedPageTypes: PluginDefinedPageTypeRow[];
  definedTaxonomies: PluginDefinedTaxonomyRow[];
  pageTypes: PluginPageTypeRow[];
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, definedPageTypes, definedTaxonomies, pageTypes, flash } = opts;
  const flashMessageKey = flash === 'approved'
    ? 'view_strings.sections_plugin_page_types.flash_approved'
    : flash === 'revoked'
      ? 'view_strings.sections_plugin_page_types.flash_revoked'
      : '';

  const body = await renderView(views, '/templates/plugin-page-types.json', {
    pluginLabel,
    unreachable,
    hasDefinedPageTypes: definedPageTypes.length > 0,
    definedPageTypes,
    hasDefinedTaxonomies: definedTaxonomies.length > 0,
    definedTaxonomies,
    hasPageTypes: pageTypes.length > 0,
    pageTypes: pageTypes.map((row) => ({
      ...row,
      pageTypeLabelKey: row.pageType === '*' ? 'view_strings.sections_plugin_page_types.all_page_types' : '',
      readStatusKey: row.readApproved
        ? 'view_strings.sections_plugin_page_types.status_approved'
        : 'view_strings.sections_plugin_page_types.status_not_approved',
      readStatusClass: row.readApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
      writeStatusKey: row.writeApproved
        ? 'view_strings.sections_plugin_page_types.status_approved'
        : 'view_strings.sections_plugin_page_types.status_not_approved',
      writeStatusClass: row.writeApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Page types`, body });
}
