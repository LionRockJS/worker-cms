import { currentCspNonce } from '../http/request-context';
import { appearanceStyleSheet } from './theme';
import { builtinRoleTranslationKey } from '../auth/roles';
import { isClientView, type RenderedView } from './liquid';

export interface SidebarNavItem {
  label: string;
  translationKey?: string;
  href: string;
  icon: string;
  isSettingsGroup?: boolean;
  isActive?: boolean;
}

/**
 * Browser scripts the core chrome always loads. Features append to this via
 * CmsFeature.clientAssets; the combined list drives both the bootstrap shell
 * below and the `<script>` tags in layout/default.liquid, which used to be two
 * hand-maintained copies of the same seven paths.
 */
export const CORE_CLIENT_ASSETS: readonly string[] = [
  '/assets/table-filter.js',
  '/assets/privacy-table.js',
  '/assets/color-tag.js',
  '/assets/picture-field.js',
  '/assets/page-ref.js',
  '/assets/richtext-md.js',
  '/assets/editor.js',
];

const EDITOR_SYNC_CLIENT_ASSETS: readonly string[] = [
  '/assets/yjs.js',
  '/assets/editor-sync.js',
];

/**
 * The engine and the renderer, loaded before anything else and only in the
 * bootstrap: client-render.js replaces the whole document with the rendered
 * layout, so re-listing them in default.liquid would reload the renderer into
 * the page it just produced.
 */
const BOOTSTRAP_CLIENT_ASSETS: readonly string[] = [
  '/assets/liquid.browser.min.js',
  '/assets/client-render.js',
];

/** A compact balance contributed to the sidebar by an optional feature. */
export interface SidebarWallet {
  currency: string;
  userBalance: number;
  sharedBalance: number;
  unitKey: string;
  icon: string;
  className: string;
}

/** Nav-gating flags forwarded into the sidebar; default false (hidden). */
export interface NavFlags {
  canManageUsers?: boolean;
  canManageRoles?: boolean;
  canManagePlugins?: boolean;
  canManageMenu?: boolean;
  sidebarNav?: SidebarNavItem[];
  sidebarSettingsNav?: SidebarNavItem[];
  showSidebarPages?: boolean;
  showSidebarTags?: boolean;
  showSidebarTaxonomies?: boolean;
  showSidebarPageTypes?: boolean;
  showSidebarBlockTypes?: boolean;
  showSidebarUsers?: boolean;
  showSidebarRoles?: boolean;
  showSidebarPlugins?: boolean;
  showSidebarMenu?: boolean;
  showSidebarTrash?: boolean;
}

/** Extracts the nav-gating flags from a page's props for forwarding to layout().
 *  Accepts any props object (the flags come from buildBaseProps at runtime). */
export function navFlags(opts: unknown): NavFlags {
  const o = (opts ?? {}) as NavFlags;
  return {
    canManageUsers: o.canManageUsers,
    canManageRoles: o.canManageRoles,
    canManagePlugins: o.canManagePlugins,
    canManageMenu: o.canManageMenu,
    sidebarNav: o.sidebarNav,
    sidebarSettingsNav: o.sidebarSettingsNav,
    showSidebarPages: o.showSidebarPages,
    showSidebarTags: o.showSidebarTags,
    showSidebarTaxonomies: o.showSidebarTaxonomies,
    showSidebarPageTypes: o.showSidebarPageTypes,
    showSidebarBlockTypes: o.showSidebarBlockTypes,
    showSidebarUsers: o.showSidebarUsers,
    showSidebarRoles: o.showSidebarRoles,
    showSidebarPlugins: o.showSidebarPlugins,
    showSidebarMenu: o.showSidebarMenu,
    showSidebarTrash: o.showSidebarTrash,
  };
}

/**
 * Template props shared by every authenticated admin page (built by
 * buildBaseProps). Page opts extend this and add page-specific fields.
 */
export interface BaseTemplateProps extends NavFlags {
  siteTitle: string;
  appIcon: string;
  /** Saved admin accent colour (`#rrggbb`) and interface font key. */
  appPrimaryColor: string;
  appFont: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  /** Optional feature-contributed balances shown in the sidebar footer. */
  sidebarWallets?: SidebarWallet[];
  currentUserId: string;
  /** Navigation entries contributed by active plugins, filtered to the user's roles. */
  pluginNav: Array<{ label: string; href: string }>;
  /** Plugin nav entries targeting the Settings group (group: 'settings'). */
  pluginSettingsNav: Array<{ label: string; href: string }>;
  /** Cache-busting revision appended to browser-fetched view files. */
  viewRevision: string;
  /** Signed single-use form token page part; the layout's submit guard stamps
   *  it (plus a per-form suffix) into POST forms as `_cms_once`. */
  cmsOnce?: string;
  uiLocale: string;
  uiDirection: 'ltr' | 'rtl';
  uiLocaleOptions: Array<{ code: string; label: string; selected: boolean }>;
  uiLocaleAction: string;
  uiLocaleReturnTo: string;
  catalogHref: string;
  /** IANA timezone used by client-side date/time localization. */
  systemTimezone: string;
  /** Core scripts plus every installed feature's; built by buildBaseProps. */
  clientAssets?: readonly string[];
  canManageUsers: boolean;
  canManageRoles: boolean;
  canManagePlugins: boolean;
  canManageMenu: boolean;
  sidebarNav: SidebarNavItem[];
  sidebarSettingsNav: SidebarNavItem[];
  showSidebarPages: boolean;
  showSidebarTags: boolean;
  showSidebarTaxonomies: boolean;
  showSidebarPageTypes: boolean;
  showSidebarBlockTypes: boolean;
  showSidebarUsers: boolean;
  showSidebarRoles: boolean;
  showSidebarPlugins: boolean;
  showSidebarMenu: boolean;
  showSidebarTrash: boolean;
}

/**
 * Wraps a rendered page body in the standard admin layout, forwarding the
 * shared base props (site title, user identity, nav flags). Page functions
 * pass their full opts object as `base` and supply the page title + body.
 */
export async function adminLayout(
  views: Fetcher,
  base: BaseTemplateProps,
  opts: { title: string; body: RenderedView; approvedPluginAssets?: ApprovedPluginAssets; editorSync?: boolean },
): Promise<string> {
  return layout(views, {
    ...navFlags(base),
    title: opts.title,
    siteTitle: base.siteTitle,
    appIcon: base.appIcon,
    appPrimaryColor: base.appPrimaryColor,
    appFont: base.appFont,
    body: opts.body,
    admin: true,
    userName: base.userName,
    userRole: base.userRole,
    userAvatar: base.userAvatar,
    sidebarWallets: base.sidebarWallets,
    pluginNav: base.pluginNav,
    pluginSettingsNav: base.pluginSettingsNav,
    viewRevision: base.viewRevision,
    cmsOnce: base.cmsOnce,
    uiLocale: base.uiLocale,
    uiDirection: base.uiDirection,
    uiLocaleOptions: base.uiLocaleOptions,
    uiLocaleAction: base.uiLocaleAction,
    uiLocaleReturnTo: base.uiLocaleReturnTo,
    catalogHref: base.catalogHref,
    systemTimezone: base.systemTimezone,
    clientAssets: base.clientAssets,
    approvedPluginAssets: opts.approvedPluginAssets,
    editorSync: opts.editorSync ?? false,
  });
}

/** Admin-approved plugin assets (see PluginManifest.assets), keyed by plugin id,
 *  forwarded into the client render payload so client-render.js can let a
 *  matching <script src> / <link> survive plugin-HTML sanitization. */
export interface ApprovedPluginAsset {
  path: string;
  integrity: string;
  revision: string;
}
export type ApprovedPluginAssets = Record<string, ApprovedPluginAsset[]>;

export interface LayoutOptions extends NavFlags {
  title: string;
  siteTitle: string;
  appIcon?: string;
  /** Saved admin accent colour (`#rrggbb`); falls back to the built-in one. */
  appPrimaryColor?: string;
  /** Saved interface font key (see APP_FONT_OPTIONS). */
  appFont?: string;
  body: RenderedView;
  /** Include the admin sidebar? */
  admin?: boolean;
  userName?: string;
  userRole?: string;
  userAvatar?: string;
  /** Optional feature-contributed balances shown in the sidebar footer. */
  sidebarWallets?: SidebarWallet[];
  /** Nav entries contributed by active plugins (already role-filtered). */
  pluginNav?: Array<{ label: string; href: string }>;
  /** Plugin nav entries for the Settings group (already role-filtered). */
  pluginSettingsNav?: Array<{ label: string; href: string }>;
  /** Cache-busting revision appended to browser-fetched view files. */
  viewRevision?: string;
  /** Signed single-use form token page part (see BaseTemplateProps.cmsOnce). */
  cmsOnce?: string;
  uiLocale?: string;
  uiDirection?: 'ltr' | 'rtl';
  uiLocaleOptions?: Array<{ code: string; label: string; selected: boolean }>;
  uiLocaleAction?: string;
  uiLocaleReturnTo?: string;
  catalogHref?: string;
  systemTimezone?: string;
  /** Core + installed features' browser scripts. Defaults to CORE_CLIENT_ASSETS
   *  for renders with no chrome behind them (the login page). */
  clientAssets?: readonly string[];
  /** Admin-approved plugin assets available to the current page's plugin (if any). */
  approvedPluginAssets?: ApprovedPluginAssets;
  /** Load CMS-owned Yjs and presence/sync assets in the rendered editor document. */
  editorSync?: boolean;
}

export async function layout(views: Fetcher, opts: LayoutOptions): Promise<string> {
  const { admin = false, userName = '', userRole = '', userAvatar = '' } = opts;
  const normalizedUserAvatar = userAvatar.trim();
  const hasUserAvatar = normalizedUserAvatar.length > 0;
  const userRoleLabel = userRole.split(',').map((role) => role.trim()).filter(Boolean).join(', ');
  const userRoleItems = userRole.split(',').map((role) => role.trim()).filter(Boolean).map((role) => ({
    label: role,
    labelKey: builtinRoleTranslationKey(role),
  }));
  const nonce = currentCspNonce();
  const revision = opts.viewRevision || 'dev';
  const revisionQuery = assetRevisionQuery(revision);
  // The bootstrap shell only needs general chrome assets. Collaboration assets
  // belong exclusively to the rendered editor document: loading Yjs in both
  // phases creates two module copies and breaks Yjs constructor identity.
  const installedAssets = opts.clientAssets ?? CORE_CLIENT_ASSETS;
  const documentAssets = opts.editorSync
    ? [...installedAssets, ...EDITOR_SYNC_CLIENT_ASSETS.filter((asset) => !installedAssets.includes(asset))]
    : [...installedAssets];
  const layoutData = {
    ...opts,
    body: isClientView(opts.body) ? '' : opts.body,
    admin,
    userName,
    userRole,
    userAvatar: normalizedUserAvatar,
    hasUserAvatar,
    userRoleLabel,
    userRoleItems,
    sidebarWallets: opts.sidebarWallets ?? [],
    userInitial: userName.trim().charAt(0).toUpperCase() || '?',
    appIcon: opts.appIcon || 'document',
    contentClass: admin ? 'md:ml-64' : '',
    canManageUsers: opts.canManageUsers ?? false,
    canManageRoles: opts.canManageRoles ?? false,
    canManagePlugins: opts.canManagePlugins ?? false,
    canManageMenu: opts.canManageMenu ?? false,
    sidebarNav: opts.sidebarNav ?? [],
    sidebarSettingsNav: opts.sidebarSettingsNav ?? [],
    showSidebarPages: opts.showSidebarPages ?? true,
    showSidebarTags: opts.showSidebarTags ?? true,
    showSidebarTaxonomies: opts.showSidebarTaxonomies ?? true,
    showSidebarPageTypes: opts.showSidebarPageTypes ?? true,
    showSidebarBlockTypes: opts.showSidebarBlockTypes ?? true,
    showSidebarUsers: opts.showSidebarUsers ?? true,
    showSidebarRoles: opts.showSidebarRoles ?? true,
    showSidebarPlugins: opts.showSidebarPlugins ?? true,
    showSidebarMenu: opts.showSidebarMenu ?? true,
    showSidebarTrash: opts.showSidebarTrash ?? true,
    pluginNav: opts.pluginNav ?? [],
    pluginSettingsNav: opts.pluginSettingsNav ?? [],
    viewRevision: revision,
    assetRevisionQuery: revisionQuery,
    iconHrefPrefix: `/assets/icons.svg${revisionQuery}`,
    nonce,
    uiLocale: opts.uiLocale || 'en',
    uiDirection: opts.uiDirection || 'ltr',
    uiLocaleOptions: opts.uiLocaleOptions ?? [],
    uiLocaleAction: opts.uiLocaleAction || '/admin/profile/locale',
    uiLocaleReturnTo: opts.uiLocaleReturnTo || '/admin',
    systemTimezone: opts.systemTimezone || '+0000',
    clientAssets: documentAssets,
  };
  const payload = {
    nonce,
    viewRevision: revision,
    viewBasePath: admin ? '/admin/views' : '/views',
    layoutPath: '/layout/default.liquid',
    layoutData,
    bodyView: isClientView(opts.body) ? opts.body : null,
    approvedPluginAssets: opts.approvedPluginAssets ?? {},
    catalogHref: opts.catalogHref || '',
  };

  void views;
  return `<!DOCTYPE html>
<html lang="${escHtml(opts.uiLocale || 'en')}" dir="${escHtml(opts.uiDirection || 'ltr')}" class="h-full overflow-x-hidden bg-gray-50">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(opts.title)} - ${escHtml(opts.siteTitle)}</title>
  <link rel="stylesheet" href="/assets/admin.css${escHtml(revisionQuery)}">
  <style nonce="${escHtml(nonce)}">${appearanceStyleSheet(opts.appPrimaryColor, opts.appFont)}</style>
</head>
<body class="h-full overflow-x-hidden">
  <div id="cms-client-root" class="min-h-full">${loadingMarkup('100vh')}</div>
  <script id="cms-render-payload" type="application/json" nonce="${escHtml(nonce)}">${jsonScript(payload)}</script>
  ${admin ? `<script nonce="${escHtml(nonce)}">${adminSessionKeepaliveScript()}</script>` : ''}
  ${[...BOOTSTRAP_CLIENT_ASSETS, ...installedAssets]
    .map((src) => `<script src="${escHtml(src)}${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>`)
    .join('\n  ')}
</body>
</html>`;
}

export function assetRevisionQuery(revision?: string): string {
  const value = revision || 'dev';
  return value ? `?r=${encodeURIComponent(value)}` : '';
}

/** Minimal HTML escaping to prevent XSS in pre-rendered HTML fragments. */
export function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function loadingMarkup(minHeight: string): string {
  return `<div role="status" aria-label="Loading" style="min-height:${escHtml(minHeight)};display:flex;align-items:center;justify-content:center;color:#6b7280">
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" style="display:block">
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="3" opacity="0.2"></circle>
      <path d="M28 16a12 12 0 0 0-12-12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="0.8s" repeatCount="indefinite"></animateTransform>
      </path>
    </svg>
  </div>`;
}

function adminSessionKeepaliveScript(): string {
  return `(function() {
      if (window.__cmsSessionKeepaliveBound) return;
      window.__cmsSessionKeepaliveBound = true;
      var INTERVAL = 10 * 60 * 1000;
      var inFlight = false;

      async function refresh() {
        if (inFlight) return;
        inFlight = true;
        try {
          var res = await fetch('/auth/refresh', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
          });
          if (res.status === 401) window.location.href = '/auth/login';
        } catch (error) {
          /* retry on the next tick */
        } finally {
          inFlight = false;
        }
      }

      window.setInterval(refresh, INTERVAL);
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') refresh();
      });
    })();`;
}
