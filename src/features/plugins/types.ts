// Types for the plugin platform: what a plugin's manifest may declare, and the
// shapes the CMS resolves it into.
//
// Split out of src/types.ts, which was 23 kB of everything — these were more
// than half of it, and nothing outside the plugin platform and its admin
// screens needs them.

import type { BlueprintEntry } from '../../cms-config';
import type { PublishLectRule } from '../../core/publish/projection';
export type { PublishLectRule };

export type PluginTrustLevel = 'server-only' | 'sandboxed-ui' | 'trusted-ui';

/** A registered plugin (URL transport) stored in the `plugins` table. The CMS
 *  reaches it at `{url}/__plugin/...`; see src/plugins/registry.ts. */
export interface PluginRecord {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  label: string;
  url: string;
  /** 1 = active; 0 = registered but inert. */
  enabled: number;
  config: string | null;
  sort_order: number;
  /** Per-plugin shared secret. Legacy null rows may use the env fallback only
   *  for outbound CMS → plugin calls; inbound /__cms access stays disabled. */
  secret: string | null;
}

// ============================================================
// Plugins (service-binding model — each plugin is its own Worker)
// ============================================================

export interface PluginNavItem {
  /** Display label shown in the admin navigation. */
  label: string;
  /** Path relative to the plugin's admin mount, e.g. "events" → /admin/plugins/<id>/events. */
  href: string;
  /** Roles allowed to see the item; omit/empty to show for all editor roles. */
  roles?: string[];
  /** Which sidebar group the item belongs to. "settings" nests it under the
   *  Settings group; omitted (default) places it at the top level. */
  group?: 'settings';
}

export interface PluginFieldType {
  /** Field type id; resolves to /snippets/pagefield/<type>/basic.liquid. Namespace by plugin id. */
  type: string;
}

/**
 * Publish-time lect projection for one page type. `keep` retains ONLY the
 * listed top-level fields (structural `_`-prefixed keys always survive);
 * `drop` removes the listed fields and keeps everything else. When both are
 * set, `keep` wins. Data minimization: the published DB is read by
 * public-facing Workers, so fields no published-side consumer needs (PII,
 * secrets) should never land there.
 */

/** Content-type fragments a plugin merges into the effective CmsConfig. */
export interface PluginContentTypes {
  blueprint?: Record<string, BlueprintEntry[]>;
  blocks?: Record<string, BlueprintEntry[]>;
  blockLists?: Record<string, string[]>;
  /**
   * Publish-time lect projection per page type this plugin OWNS (declared in
   * `blueprint`). Rules for types the plugin does not own are ignored — a
   * plugin must not be able to thin out another plugin's published pages.
   */
  publishLect?: Record<string, PublishLectRule>;
  /** Taxonomy definitions keyed by slug; values are display names. */
  taxonomies?: Record<string, string>;
  taxonomyLists?: Record<string, string[]>;
  /**
   * Page types this plugin may WRITE through the write-back API without
   * contributing/owning their blueprint. Use this for companion plugins that
   * mutate another plugin's pages by explicit delegation. Admin approval is
   * required before the CMS honors each declared write scope. Use `*` to request
   * write access to every concrete page type.
   */
  writeTypes?: string[];
  /**
   * Page types this plugin may READ (but not write) through the write-back API,
   * in addition to the types it owns via `blueprint` or may write via
   * `writeTypes`. Lets a plugin pull data from pages another plugin owns —
   * e.g. the events suite reading `contact` pages to refresh a guest. Admin
   * approval is required before the CMS honors each declared read scope. Use `*`
   * to request read access to every concrete page type.
   */
  readTypes?: string[];
}

/** Page lifecycle events a plugin can subscribe to through manifest.hooks. */
export type PluginHookEvent = 'create' | 'submission' | 'update' | 'publish' | 'unpublish' | 'delete';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Browser trust boundary. `server-only` forbids admin UI declarations;
   * `sandboxed-ui` renders plugin pages in an opaque-origin iframe;
   * `trusted-ui` allows approved code to execute in CMS chrome and therefore
   * grants it the signed-in user's same-origin authority.
   *
   * Legacy manifests remain trusted-ui for compatibility because older plugins
   * could expose unlisted admin routes. New plugins should always be explicit.
   */
  trustLevel?: PluginTrustLevel;
  /** Snake-case alias for static JSON manifests. */
  trust_level?: PluginTrustLevel;
  /** Plugin Worker deploy revision. Plugins should expose CF_VERSION_METADATA.id here when available. */
  workerVersionId?: string;
  /** Snake-case alias for plugin manifests that expose worker_version_id. */
  worker_version_id?: string;
  /** Optional structured Worker version metadata, if the plugin chooses to expose it. */
  workerVersion?: string | Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  /** Back-compat alias for plugins that expose Cloudflare metadata verbatim. */
  cfVersionMetadata?: Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  CF_VERSION_METADATA?: Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  /** Lifecycle events the plugin wants to receive. `submission` is emitted for
   *  pages found in the published database without a draft counterpart. */
  hooks?: PluginHookEvent[];
  /** Plugin-owned page types that should be republished after each save once
   *  they are already live. Types must also be declared in contentTypes.blueprint;
   *  the first publish always remains an explicit editor action. */
  autoPublishTypes?: string[];
  /** When true, the plugin is a publish target: it receives full page
   *  snapshots on publish/unpublish via /__plugin/publish/*. */
  publishTarget?: boolean;
  /**
   * When true, the plugin provides UI translation catalogs at
   * `/__plugin/views/locales/:locale.json`. Locale catalogs are opt-in so the
   * CMS does not probe that endpoint on plugins that are not i18n-ready.
   */
  i18n?: boolean;
  nav?: PluginNavItem[];
  contentTypes?: PluginContentTypes;
  fieldTypes?: PluginFieldType[];
  /**
   * Page-type slugs whose edit view this plugin renders itself. For a page of
   * one of these types the CMS POSTs the editor context to the plugin's
   * `/__plugin/edit` endpoint and wraps the returned HTML fragment in the admin
   * chrome instead of rendering the built-in editor. The plugin's form posts
   * back to the CMS's normal save handler, so save/version/publish logic is
   * unchanged. A 404 (or any error) from the plugin falls back to the built-in
   * editor. For backwards compatibility, `editViews` also owns the create/new
   * view unless `newViews` is declared by a plugin for that page type. See
   * src/plugins/edit-view.ts.
   */
  editViews?: string[];
  /**
   * Page-type slugs whose create/new view this plugin renders itself. The CMS
   * POSTs the same editor context to `/__plugin/edit`, with `mode: "new"` and
   * `action` pointing at the CMS create handler. This lets a plugin override
   * creation without overriding the edit view for existing pages.
   */
  newViews?: string[];
  /**
   * Page-type slugs whose read-only view this plugin renders itself. For a page
   * of one of these types the CMS POSTs the read context to the plugin's
   * `/__plugin/read` endpoint and wraps the returned HTML fragment in the admin
   * chrome instead of rendering the built-in read view. A 404 (or any error)
   * from the plugin falls back to the built-in read view, and `?native=1`
   * forces it. Independent of `editViews`: a plugin may own the edit view, the
   * read view, both, or neither. See src/plugins/edit-view.ts (pluginReadView).
   */
  readViews?: string[];
  /**
   * Additional permission types this plugin contributes. They appear in the
   * Roles admin alongside built-in permissions so editors can grant them to
   * custom roles. Values should be namespaced by plugin id (e.g. "events:manage").
   */
  permissions?: Array<{ value: string; label: string }>;
  /**
   * Static JS/CSS files this plugin wants to execute/apply inside CMS chrome
   * (e.g. a live camera scanner). Declaring a file here only makes it eligible
   * for approval — an admin must still explicitly approve each path (pinning
   * its content hash) from the plugin's admin-registry page before
   * client-render.js will let it survive sanitization. Path is relative to the
   * plugin's own origin, e.g. "/assets/js/kiosk.js". See utils/plugin-assets.ts.
   */
  assets?: Array<{ path: string; label?: string }>;
  /**
   * Quota definitions this plugin exposes for admin configuration. The plugin
   * only *declares* which limits exist (key, counting scope, optional target
   * page type/default); the CMS stores configured values in the `settings`
   * table. It enforces page quotas on every create path; plugins enforce
   * operational limits such as per-second delivery rates. See
   * utils/plugin-limits.ts.
   */
  limits?: PluginLimitDef[];
  /**
   * Credit costs this plugin exposes for admin configuration. Like limits, the
   * plugin only *declares* which chargeable actions exist; the CMS stores the
   * configured prices in the `settings` table, deducts from the acting user's
   * balance, and records every change in the credit ledger. See
   * src/features/credits/service.ts.
   *
   * Each cost may name the wallet it is paid from (`currency`): omitted means
   * ordinary credits, `"diamond"` the premium wallet for actions the operator
   * pays real money for (SMS and WhatsApp delivery). The wallets never convert
   * into each other, and an unrecognised currency drops the cost.
   */
  credits?: PluginCreditDef[];
  /**
   * When true the plugin serves `POST /__plugin/tenants/enroll` and this CMS
   * can register itself as a tenant instead of an operator hand-writing the
   * plugin's TENANTS KV record. The flag is only a hint that the button should
   * be offered: the plugin authenticates the enrollment itself by redeeming a
   * single-use ticket back at this CMS's canonical origin, and grants nothing
   * on the strength of the manifest alone. See utils/plugin-enroll.ts.
   */
  autoTenant?: boolean;
  /** Snake-case alias for manifests that expose auto_tenant. */
  auto_tenant?: boolean;
  /** Candidate key prefixes; each needs host-admin approval before file API access. */
  filePrefixes?: string[];
  /**
   * Environment variable names that the plugin may copy into a newly enrolled
   * tenant record's `vars` object. The CMS forwards this validated declaration
   * as `tenant_vars` during enrollment; the SDK copies matching non-empty
   * plugin env values after the ticket is redeemed.
   */
  tenantVars?: string[];
  /** Snake-case alias for manifests that expose tenant_vars. */
  tenant_vars?: string[];
}

/** How a declared plugin limit counts existing pages. */
export type PluginLimitScope = 'total' | 'per_parent' | 'per_pointer' | 'per_second';

/** A quota declared in a plugin manifest (see PluginManifest.limits). */
export interface PluginLimitDef {
  /** Identifier unique within the plugin, e.g. "max_guests_per_list". */
  key: string;
  /** Human label shown in the limits admin. */
  label?: string;
  /** Optional longer description shown in the limits admin. */
  description?: string;
  /** Page type whose creation this limit bounds. Must be a type the plugin owns
   *  via its blueprint or may write via an approved writeType. */
  page_type?: string;
  /**
   * Counting scope: 'total' counts all pages of the type; 'per_parent' counts
   * siblings under one parent page (page_id); 'per_pointer' counts pages
   * sharing one `_pointers.<pointer_key>` value (e.g. guests in a guest list).
   * 'per_second' is an operational limit read and enforced by the plugin; it
   * does not apply to page creation and does not require page_type.
   */
  scope: PluginLimitScope;
  /** Required when scope is 'per_pointer': the `_pointers` key pages group by. */
  pointer_key?: string;
  /** Limit applied until an admin configures a value. Omitted → unlimited. */
  default?: number;
}

/**
 * How a declared credit cost is charged: 'page_create' costs are observed and
 * charged by the host at every page-create path; 'metered' costs are reported
 * by the plugin via POST /__cms/credits/charge for actions the host can't see
 * (e.g. sending an EDM blast); 'recurring' costs bill a plugin-reported usage
 * quantity (POST /__cms/credits/usage) once per period via the cron sweep
 * (e.g. record storage). See utils/credit-subscriptions.ts.
 */
// Plugin-owned structural view of the credit declaration in a remote
// manifest. The credits feature validates this untrusted shape after it
// crosses the generated feature-service boundary.
export type PluginCreditCharge = 'page_create' | 'metered' | 'recurring';
export type PluginCreditBilling = 'advance' | 'arrears';
export type PluginCreditCurrency = string;
export interface PluginCreditDef {
  key: string;
  label?: string;
  description?: string;
  charge: PluginCreditCharge;
  currency?: PluginCreditCurrency;
  page_type?: string;
  unit?: string;
  default?: number;
  per?: number;
  period?: 'month';
  billing?: PluginCreditBilling;
}

/** An admin-approved plugin asset (see PluginManifest.assets), stored in the
 *  `plugin_asset_approvals` table. `integrity` is the SRI hash (sha384-...) of
 *  the file's bytes pinned at approval time. */
export interface PluginAssetApproval {
  id: number;
  plugin_id: string;
  path: string;
  integrity: string;
  approved_by: string;
  created_at: string;
  updated_at: string;
}

export type PluginPageTypeAccess = 'read' | 'write';

/** An admin-approved delegated page-type scope (see PluginContentTypes
 *  readTypes/writeTypes), stored in the `plugin_page_type_approvals` table. */
/** A registry row's pinned manifest id (see identity.ts), stored in
 * `plugin_identity_approvals`. One manifest id belongs to exactly one row, so
 * a plugin cannot assert an identity another plugin already owns. */
export interface PluginIdentityApproval {
  plugin_row_id: number;
  manifest_id: string;
  /** Admin who re-approved a changed identity; empty for an automatic pin. */
  approved_by: string;
  created_at: string;
  updated_at: string;
}

export interface PluginPageTypeApproval {
  id: number;
  plugin_id: string;
  page_type: string;
  access: PluginPageTypeAccess;
  approved_by: string;
  created_at: string;
  updated_at: string;
}

/** An admin-approved host R2 prefix (see PluginManifest.filePrefixes), stored
 * in `plugin_file_prefix_approvals`. Prefixes are globally reserved so one
 * plugin cannot overwrite another plugin's folder. */
export interface PluginFilePrefixApproval {
  id: number;
  plugin_id: string;
  prefix: string;
  approved_by: string;
  created_at: string;
  updated_at: string;
}

/** A resolved, active plugin: its declared binding name, Fetcher, and manifest. */
export interface ResolvedPlugin {
  binding: string;
  fetcher: Fetcher;
  manifest: PluginManifest;
  /** Effective secret for outbound CMS → plugin calls (own secret, or the
   *  legacy env fallback). Empty when neither is set. */
  secret: string;
  /** Dedicated secret accepted for inbound plugin → CMS API calls. Empty for
   *  legacy rows so one shared env secret cannot impersonate every plugin. */
  apiSecret: string;
  /** Admin-entered display label from the plugin row (Plugins → edit → Label). Empty when unset. */
  label?: string;
}

export function manifestDeclaresUi(manifest: PluginManifest): boolean {
  return !!(
    manifest.nav?.length
    || manifest.assets?.length
    || manifest.editViews?.length
    || manifest.newViews?.length
    || manifest.readViews?.length
  );
}

export function pluginTrustLevel(manifest: PluginManifest): PluginTrustLevel {
  return manifest.trustLevel
    ?? manifest.trust_level
    ?? 'trusted-ui';
}

/** Longest permission list a manifest may contribute, before the rest is ignored. */
export const MAX_PLUGIN_PERMISSIONS = 32;

const PERMISSION_SUFFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The permissions a manifest may actually contribute, namespaced to the
 * plugin's own id.
 *
 * A permission value is a global name: it is what the Roles admin offers, what
 * `role_permissions` stores, and what the plugin admin proxy accepts as proof
 * that a non-admin may reach a plugin. Nothing in the manifest is verified, so
 * an unrestricted value let a plugin declare `content:write` (and be granted it
 * under a friendly label of its own choosing, next to the real checkbox in the
 * role editor) or `events:manage` (and let every holder of another plugin's
 * permission into its own admin UI).
 *
 * Restricting the namespace to `<manifest id>:<suffix>` makes the value say who
 * owns it. Combined with the pinned identity (see identity.ts), which stops a
 * plugin from asserting an id another row owns, a declared permission can no
 * longer name anything but the declaring plugin's own capability. Entries that
 * do not conform are dropped rather than failing the whole manifest, so one bad
 * line cannot take a plugin's content types and hooks offline with it.
 */
export function pluginPermissions(manifest: PluginManifest): Array<{ value: string; label: string }> {
  const declared = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const permissions: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  for (const entry of declared.slice(0, MAX_PLUGIN_PERMISSIONS)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = typeof entry.value === 'string' ? entry.value : '';
    const label = typeof entry.label === 'string' ? entry.label : '';
    const [namespace, suffix, ...extra] = value.split(':');
    if (namespace !== manifest.id || extra.length > 0 || !PERMISSION_SUFFIX.test(suffix ?? '')) {
      console.error(`Plugin ${manifest.id} declares permission "${value}" outside its own "${manifest.id}:" namespace; ignored`);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    permissions.push({ value, label: label || value });
  }
  return permissions;
}
