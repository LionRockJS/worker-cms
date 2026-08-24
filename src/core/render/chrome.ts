// The admin chrome: the props and shell every authenticated admin page shares.
//
// Was utils/admin-render.ts, which every admin route imports for renderPage()
// — and which itself imported credits, publish, publish/projection, search and
// the advanced-search template, so the trash screen transitively depended on
// the billing engine. Those came from two things that have since moved out:
// renderAdvancedSearch (now features/search/render.ts) and the credit
// balances (now a feature contribution, see core/feature.ts).

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Permission } from '../../types';
import type { AppContext } from '../http/context';
import { dashboardPageHref, userIdFromContext } from '../http/forms';
import { coreExtensions } from '../extensions';
import { fetchUserAvatar } from '../db/admin-queries';
import type { DashboardListResult } from '../db/admin-queries';
import { userPermissions } from '../auth/permissions';
import { viewRevision } from '../http/view-revision';
import { mintFormOnceToken } from '../auth/form-once';
import {
  SIDEBAR_MENU_ITEMS,
  menuItemFeature,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadSystemTimezone,
  loadSidebarChromeSettings,
  pluginSidebarKey,
  type SidebarMenuItemKey,
} from '../db/settings';

import { CORE_CLIENT_ASSETS } from './layout';
import type { BaseTemplateProps, SidebarNavItem } from './layout';
import { withActiveSidebarItems } from './sidebar';
import { localeRegistry, resolveUiLocale } from '../i18n';
import { featureInstalled, features } from '../../features';

/**
 * Builds the template props shared by every authenticated admin page:
 * site title, signed-in user's name/role, avatar, and plugin nav. Handlers
 * spread the result and add page-specific fields (and may override siteTitle).
 */
export async function buildBaseProps(c: AppContext): Promise<BaseTemplateProps> {
  const user = c.get('user');
  const userRoles = user.role.split(',').map((role) => role.trim()).filter(Boolean);
  const fallbackSiteTitle = c.env.SITE_TITLE ?? '0xCMS';
  const requestUrl = new URL(c.req.url);
  const [userAvatar, navItems, permissions, branding, cmsOnce, uiLocale, systemTimezone, localeState, contributed] = await Promise.all([
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    coreExtensions().sidebarNav?.(c.env) ?? [],
    userPermissions(c),
    loadAppBrandingSettings(c.env, fallbackSiteTitle),
    mintFormOnceToken(c.env.JWT_SECRET),
    resolveUiLocale(c),
    loadSystemTimezone(c.env),
    localeRegistry(c.env),
    // Feature contributions run alongside the chrome's own queries so an
    // installed feature costs no extra round trip.
    Promise.all(features.map((feature) => feature.baseProps?.(c) ?? {}))
      .then((parts) => Object.assign({}, ...parts) as Partial<BaseTemplateProps>),
  ]);
  const sidebarSettings = await loadSidebarChromeSettings(c.env);
  const menuSettings = sidebarSettings.items;
  const isAdmin = userRoles.includes('admin');
  const visible = navItems
    .filter((item) => !item.roles?.length || item.roles.some((role) => userRoles.includes(role)))
    .filter((item) => isAdmin || (item.permissions?.some((permission) => permissions.has(permission as Permission)) ?? false));
  // Plugins that do not ship locale catalogs (manifest `i18n: true`) get no
  // translation key at all: the sidebar renders their manifest label directly
  // instead of asking the client for a key that can never resolve.
  const pluginTranslationKey = (item: { pluginId: string; href: string; i18n: boolean }): string | undefined => {
    if (!item.i18n) return undefined;
    const pluginPath = item.href.replace(`/admin/plugins/${item.pluginId}/`, '').replace(/[^a-z0-9]+/gi, '.').replace(/^\.|\.$/g, '');
    return `plugins.${item.pluginId}.nav.${pluginPath || 'index'}`;
  };
  const toLink = (item: { pluginId: string; label: string; href: string; i18n: boolean }) => {
    return {
      label: item.label,
      translationKey: pluginTranslationKey(item),
      href: item.href,
    };
  };
  // Plugins may target the Settings group (group: 'settings'); everything else
  // sits at the top level of the sidebar.
  const nav = visible.filter((item) => item.group !== 'settings').map(toLink);
  const settingsNav = visible.filter((item) => item.group === 'settings').map(toLink);
  const canSeeMenuItem = (key: SidebarMenuItemKey): boolean => {
    if (key === 'pages') return permissions.has('content:read');
    if (key === 'trash') return permissions.has('content:read') || permissions.has('trash:restore') || permissions.has('trash:purge');
    if (key === 'tags' || key === 'taxonomies') return permissions.has('content:read');
    if (key === 'pageTypes' || key === 'blockTypes') return permissions.has('content:read');
    if (key === 'users') return permissions.has('users:manage');
    if (key === 'roles') return permissions.has('roles:manage');
    if (key === 'plugins') return permissions.has('plugin:manage');
    // Credit summary is read-only and visible to content/plugin operators; only the
    // configure links inside it require plugin:manage.
    if (key === 'credits') return permissions.has('content:read') || permissions.has('plugin:manage');
    if (key === 'languages') return permissions.has('menu:manage');
    if (key === 'system') return permissions.has('menu:manage');
    if (key === 'content') return permissions.has('content:read') || permissions.has('media:upload');
    return true;
  };
  const orderedSidebarItems = SIDEBAR_MENU_ITEMS
    .map((item, index) => ({ item, index, setting: menuSettings[item.key] }))
    // An entry owned by a feature disappears with that feature, whatever the
    // saved menu settings say.
    .filter((entry) => featureInstalled(menuItemFeature(entry.item))
      && entry.setting.visible
      && canSeeMenuItem(entry.item.key))
    .sort((a, b) => a.setting.weight - b.setting.weight || a.index - b.index);
  const sidebarSettingsNavEntries: Array<{ item: SidebarNavItem; weight: number; index: number }> = orderedSidebarItems
    .filter((entry) => entry.item.group === 'settings')
    .map((entry) => ({
      item: {
        label: entry.item.label,
        translationKey: `nav.${entry.item.key}`,
        href: entry.item.href,
        icon: entry.item.icon,
      },
      weight: entry.setting.weight,
      index: entry.index,
    }));
  const sidebarNavEntries: Array<{ item: SidebarNavItem; weight: number; index: number }> = orderedSidebarItems
    .filter((entry) => entry.item.group === 'main')
    .map((entry) => ({
      item: {
        label: entry.item.label,
        translationKey: `nav.${entry.item.key}`,
        href: entry.item.href,
        icon: entry.item.icon,
      },
      weight: entry.setting.weight,
      index: entry.index,
    }));
  visible.forEach((item, index) => {
    const key = pluginSidebarKey(item);
    if (sidebarSettings.hiddenPluginKeys.has(key)) return;
    const entry = {
      item: {
        label: item.label,
        translationKey: pluginTranslationKey(item),
        href: item.href,
        icon: sidebarSettings.pluginIcons[key] ?? 'beaker',
      },
      weight: sidebarSettings.pluginWeights[key] ?? defaultPluginNavWeight(item.group),
      index: SIDEBAR_MENU_ITEMS.length + index,
    };
    if (item.group === 'settings') sidebarSettingsNavEntries.push(entry);
    else sidebarNavEntries.push(entry);
  });
  const unorderedSidebarSettingsNav = sidebarSettingsNavEntries
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.item);
  if (unorderedSidebarSettingsNav.length > 0) {
    sidebarNavEntries.push({
      item: {
        label: 'Settings',
        translationKey: 'nav.settings',
        href: '',
        icon: 'settings',
        isSettingsGroup: true,
      },
      weight: sidebarSettings.settingsGroupWeight,
      index: SIDEBAR_MENU_ITEMS.length,
    });
  }
  const unorderedSidebarNav = sidebarNavEntries
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.item);
  const { sidebarNav, sidebarSettingsNav } = withActiveSidebarItems(
    c.req.path,
    unorderedSidebarNav,
    unorderedSidebarSettingsNav,
    c.req.query('return_to'),
  );
  return {
    siteTitle: branding.appName,
    appIcon: branding.appIcon,
    appPrimaryColor: branding.primaryColor,
    appFont: branding.appFont,
    userName: user.name,
    userRole: user.role,
    userAvatar: userAvatar ?? '',
    currentUserId: String(user.sub),
    pluginNav: nav,
    pluginSettingsNav: settingsNav,
    viewRevision: viewRevision(c.env),
    cmsOnce,
    uiLocale: uiLocale.code,
    uiDirection: uiLocale.direction,
    uiLocaleOptions: localeState.uiLocales.map((locale) => ({
      code: locale.code,
      label: locale.label,
      selected: locale.code === uiLocale.code,
    })),
    uiLocaleAction: '/admin/profile/locale',
    uiLocaleReturnTo: `${requestUrl.pathname}${requestUrl.search}`,
    catalogHref: `/admin/i18n/catalog/${encodeURIComponent(uiLocale.code)}`,
    systemTimezone,
    clientAssets: [...CORE_CLIENT_ASSETS, ...features.flatMap((feature) => feature.clientAssets ?? [])],
    canManageUsers: permissions.has('users:manage'),
    canManageRoles: permissions.has('roles:manage'),
    canManagePlugins: permissions.has('plugin:manage'),
    canManageMenu: permissions.has('menu:manage'),
    sidebarNav,
    sidebarSettingsNav,
    showSidebarPages: menuSettings.pages.visible && permissions.has('content:read'),
    showSidebarTags: menuSettings.tags.visible && permissions.has('content:read'),
    showSidebarTaxonomies: menuSettings.taxonomies.visible && permissions.has('content:read'),
    showSidebarPageTypes: menuSettings.pageTypes.visible && permissions.has('content:read'),
    showSidebarBlockTypes: menuSettings.blockTypes.visible && permissions.has('content:read'),
    showSidebarUsers: menuSettings.users.visible,
    showSidebarRoles: menuSettings.roles.visible,
    showSidebarPlugins: menuSettings.plugins.visible,
    showSidebarMenu: menuSettings.system.visible,
    showSidebarTrash: menuSettings.trash.visible && featureInstalled('trash')
      && (permissions.has('content:read') || permissions.has('trash:restore') || permissions.has('trash:purge')),
    ...contributed,
  };
}

/**
 * Renders an admin page template with the shared base props pre-filled.
 * `extra` supplies the page-specific fields and may override base props
 * (e.g. a page-specific siteTitle). `views` defaults to env.VIEWS; pass
 * viewsFor(env) for templates that resolve plugin-owned snippets.
 * `status` overrides the 200 default (e.g. 422 validation re-renders).
 */
export async function renderPage<P extends BaseTemplateProps>(
  c: AppContext,
  page: (views: Fetcher, props: P) => Promise<string>,
  extra: Omit<P, keyof BaseTemplateProps> & Partial<BaseTemplateProps>,
  views: Fetcher = c.env.VIEWS,
  status?: ContentfulStatusCode,
): Promise<Response> {
  const base = await buildBaseProps(c);
  const html = await page(views, { ...base, ...extra } as unknown as P);
  return status ? c.html(html, status) : c.html(html);
}

export function dashboardPagination(
  routeBase: string,
  result: DashboardListResult,
  params: Record<string, string | number | null | undefined> = {},
) {
  const { currentPage, totalPages, limit } = result.pagination;

  return {
    total: result.pagination.total,
    totalPages,
    currentPage,
    pageSize: limit,
    firstHref: currentPage > 1 ? dashboardPageHref(routeBase, 1, limit, params) : '',
    previousHref: currentPage > 1 ? dashboardPageHref(routeBase, currentPage - 1, limit, params) : '',
    nextHref: currentPage < totalPages ? dashboardPageHref(routeBase, currentPage + 1, limit, params) : '',
    lastHref: currentPage < totalPages ? dashboardPageHref(routeBase, totalPages, limit, params) : '',
  };
}
