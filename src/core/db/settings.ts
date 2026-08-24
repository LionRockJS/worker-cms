import type { Env } from '../../types';

export const SIDEBAR_MENU_SETTING_KEY = 'admin.sidebar_menu.hidden_items';
export const APP_BRANDING_SETTING_KEY = 'admin.app_branding';
export const ADMIN_HOME_SETTING_KEY = 'admin.home';
export const SYSTEM_TIMEZONE_SETTING_KEY = 'admin.system_timezone';
export const DEFAULT_SYSTEM_TIMEZONE = '+0000';

const FIXED_OFFSET_MINUTES = [
  ...Array.from({ length: 53 }, (_, index) => -720 + index * 30),
  345, 525, 765, 825,
].sort((a, b) => a - b);

export const SYSTEM_TIMEZONE_OPTIONS = [...new Set(FIXED_OFFSET_MINUTES)].map((totalMinutes) => {
  const sign = totalMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(totalMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return {
    value: `${sign}${hours}${minutes}`,
    label: `UTC${sign}${hours}:${minutes} (${sign}${hours}${minutes})`,
  };
});
export const DEFAULT_SETTINGS_GROUP_WEIGHT = 30;
export const DEFAULT_PLUGIN_NAV_WEIGHT = 35;
export const DEFAULT_PLUGIN_SETTINGS_NAV_WEIGHT = 80;

// `feature` marks an entry owned by an optional feature: the chrome hides it
// when that feature is absent from src/features/index.ts. The definitions stay
// here rather than in the features because SidebarMenuItemKey is a literal
// union woven through the persisted menu settings; moving them out means
// making that key type dynamic.
export const SIDEBAR_MENU_ITEMS = [
  { key: 'pages', label: 'Pages', description: 'Draft content dashboard and page lists.', href: '/admin/pages/list', icon: 'document', group: 'main', defaultWeight: 10 },
  { key: 'tags', label: 'Tags', description: 'Tag terms shown in the main sidebar.', href: '/admin/tags', icon: 'tag', group: 'main', defaultWeight: 20 },
  { key: 'taxonomies', label: 'Taxonomies', description: 'Taxonomy settings link.', href: '/admin/taxonomies', icon: 'list-filter', group: 'settings', defaultWeight: 10 },
  { key: 'pageTypes', label: 'Page Types', description: 'Database-defined page type settings link.', href: '/admin/page_types', icon: 'list', group: 'settings', defaultWeight: 20, feature: 'runtime-content-types' },
  { key: 'blockTypes', label: 'Block Types', description: 'Database-defined block settings link.', href: '/admin/block_types', icon: 'blocks', group: 'settings', defaultWeight: 30, feature: 'runtime-content-types' },
  { key: 'users', label: 'Users & Credits', description: 'User and credit management link for permitted roles.', href: '/admin/users', icon: 'users', group: 'settings', defaultWeight: 40, feature: 'users-roles' },
  { key: 'roles', label: 'Roles', description: 'Role and permission management link.', href: '/admin/roles', icon: 'shield-check', group: 'settings', defaultWeight: 50, feature: 'users-roles' },
  { key: 'plugins', label: 'Plugins', description: 'Plugin registry settings link.', href: '/admin/plugins-manage', icon: 'beaker', group: 'settings', defaultWeight: 60, feature: 'plugins' },
  { key: 'credits', label: 'Credit Summary', description: 'Chargeable actions and effective prices across plugins.', href: '/admin/settings/credits', icon: 'coins', group: 'settings', defaultWeight: 65, feature: 'credits' },
  { key: 'languages', label: 'Languages', description: 'Content languages and CMS interface translations.', href: '/admin/settings/languages', icon: 'globe', group: 'settings', defaultWeight: 67, feature: 'i18n' },
  { key: 'system', label: 'System', description: 'App branding, menu visibility, and menu order.', href: '/admin/settings/system', icon: 'settings', group: 'settings', defaultWeight: 70 },
  { key: 'content', label: 'Files', description: 'Media files in the bucket and the pages that reference them.', href: '/admin/settings/content', icon: 'folder', group: 'settings', defaultWeight: 80, feature: 'media' },
  { key: 'trash', label: 'Trash', description: 'Deleted content review link.', href: '/admin/trash', icon: 'trash', group: 'main', defaultWeight: 40, feature: 'trash' },
] as const;

export const APP_ICON_OPTIONS = [
  { value: 'arrow-left', label: 'Arrow left' },
  { value: 'beaker', label: 'Beaker' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'contact-card', label: 'Contact card' },
  { value: 'chevron-down', label: 'Chevron down' },
  { value: 'chevron-right', label: 'Chevron right' },
  { value: 'clock', label: 'Clock' },
  { value: 'cloud-upload', label: 'Cloud upload' },
  { value: 'code', label: 'Code' },
  { value: 'copy', label: 'Copy' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'document', label: 'Document' },
  { value: 'coins', label: 'Coins' },
  { value: 'document-plus', label: 'Document plus' },
  { value: 'download', label: 'Download' },
  { value: 'edit-square', label: 'Edit square' },
  { value: 'eye', label: 'Eye' },
  { value: 'eye-off', label: 'Eye off' },
  { value: 'folder', label: 'Folder' },
  { value: 'globe', label: 'Globe' },
  { value: 'github', label: 'GitHub' },
  { value: 'google', label: 'Google' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'apple', label: 'Apple' },
  { value: 'trash-can', label: 'Trash can' },
  { value: 'settings', label: 'Settings' },
  { value: 'check-circle', label: 'Check circle' },
  { value: 'key', label: 'Key' },
  { value: 'list', label: 'List' },
  { value: 'list-filter', label: 'Filtered list' },
  { value: 'logout', label: 'Log out' },
  { value: 'menu', label: 'Menu' },
  { value: 'mail-check', label: 'Email checked' },
  { value: 'moon', label: 'Moon' },
  { value: 'pencil-square', label: 'Pencil square' },
  { value: 'plus', label: 'Plus' },
  { value: 'search', label: 'Search' },
  { value: 'shield-check', label: 'Shield' },
  { value: 'sun', label: 'Sun' },
  { value: 'tag', label: 'Tag' },
  { value: 'trash', label: 'Trash' },
  { value: 'upload', label: 'Upload' },
  { value: 'user', label: 'User' },
  { value: 'user-group', label: 'User group' },
  { value: 'users', label: 'Users' },
  { value: 'warning', label: 'Warning' },
  { value: 'x', label: 'Close' },
] as const;

export type SidebarMenuItemKey = typeof SIDEBAR_MENU_ITEMS[number]['key'];
export type SidebarMenuSettings = Record<SidebarMenuItemKey, { visible: boolean; weight: number }>;
export type SidebarMenuItem = typeof SIDEBAR_MENU_ITEMS[number];

/** The optional feature owning a sidebar entry, if any. */
export function menuItemFeature(item: SidebarMenuItem): string | undefined {
  return 'feature' in item ? item.feature : undefined;
}

/**
 * The entries this build can show: an entry owned by a feature goes with that
 * feature. Takes the predicate rather than reaching for the feature registry
 * itself, so core stays independent of it — callers pass featureInstalled().
 *
 * Every screen that lists menu entries must go through here. The System
 * Settings screen listed SIDEBAR_MENU_ITEMS directly and so offered visibility
 * and weight controls for features that were not installed.
 */
export function installedMenuItems(
  isInstalled: (feature?: string) => boolean,
): readonly SidebarMenuItem[] {
  return SIDEBAR_MENU_ITEMS.filter((item) => isInstalled(menuItemFeature(item)));
}
export type AppIcon = typeof APP_ICON_OPTIONS[number]['value'];

/**
 * Interface font choices. Every stack is composed of faces the operating
 * system already has: the admin CSP is `default-src 'self'`, so a webfont
 * host (Google Fonts and friends) would simply be blocked. `stack` lands in
 * `--font-sans`, which admin.css uses for html/body and Tailwind uses for
 * `font-sans`; monospaced captions keep their own face.
 */
export const APP_FONT_OPTIONS = [
  { value: 'system', label: 'System', stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { value: 'grotesk', label: 'Neo-grotesque', stack: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif' },
  { value: 'geometric', label: 'Geometric', stack: 'Avenir, "Avenir Next", "Century Gothic", "URW Gothic", "Trebuchet MS", sans-serif' },
  { value: 'humanist', label: 'Humanist', stack: 'Optima, Candara, "Gill Sans", "Gill Sans MT", "Segoe UI", sans-serif' },
  { value: 'rounded', label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Verdana, sans-serif' },
  { value: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif' },
  { value: 'slab', label: 'Slab serif', stack: 'Rockwell, "Roboto Slab", "Bookman Old Style", Georgia, serif' },
  { value: 'mono', label: 'Monospace', stack: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace' },
] as const;

export type AppFont = typeof APP_FONT_OPTIONS[number]['value'];

export const DEFAULT_PRIMARY_COLOR = '#cbef34';
export const DEFAULT_APP_FONT: AppFont = 'system';

const APP_FONT_VALUES = new Set<string>(APP_FONT_OPTIONS.map((option) => option.value));

/** The stack for a saved font key, falling back to the system one. */
export function appFontStack(value: unknown): string {
  return (APP_FONT_OPTIONS.find((option) => option.value === value) ?? APP_FONT_OPTIONS[0]).stack;
}

/** `#rgb` / `#rrggbb` (either case) normalized to lower-case `#rrggbb`. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return null;
}

export interface AppBrandingSettings {
  appName: string;
  appIcon: AppIcon;
  /** Accent colour every `indigo-*` / `brand-*` utility resolves to. */
  primaryColor: string;
  appFont: AppFont;
}

export interface AdminHomeSettings {
  href: string;
}

export function normalizeSystemTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timeZone = value.trim().slice(0, 100);
  if (!timeZone) return null;
  const fixedOffset = /^([+-])(\d{2})(\d{2})$/.exec(timeZone);
  if (fixedOffset) {
    const totalMinutes = (fixedOffset[1] === '-' ? -1 : 1)
      * (Number(fixedOffset[2]) * 60 + Number(fixedOffset[3]));
    if (Number(fixedOffset[3]) < 60 && totalMinutes >= -720 && totalMinutes <= 840) return timeZone;
    return null;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
    return timeZone;
  } catch {
    return null;
  }
}

export async function loadSystemTimezone(env: Env): Promise<string> {
  return normalizeSystemTimezone(await getSetting(env, SYSTEM_TIMEZONE_SETTING_KEY)) ?? DEFAULT_SYSTEM_TIMEZONE;
}

export async function saveSystemTimezone(env: Env, value: unknown): Promise<string> {
  const timeZone = normalizeSystemTimezone(value);
  if (!timeZone) throw new Error('Invalid system timezone');
  await saveSetting(env, SYSTEM_TIMEZONE_SETTING_KEY, timeZone);
  return timeZone;
}

export interface SidebarChromeSettings {
  items: SidebarMenuSettings;
  settingsGroupWeight: number;
  pluginWeights: Record<string, number>;
  pluginIcons: Record<string, AppIcon>;
  hiddenPluginKeys: Set<string>;
}

const SIDEBAR_MENU_KEYS = new Set<string>(SIDEBAR_MENU_ITEMS.map((item) => item.key));
const APP_ICON_VALUES = new Set<string>(APP_ICON_OPTIONS.map((option) => option.value));

export function defaultSidebarMenuSettings(): SidebarMenuSettings {
  return Object.fromEntries(SIDEBAR_MENU_ITEMS.map((item) => [item.key, {
    visible: true,
    weight: item.defaultWeight,
  }])) as SidebarMenuSettings;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, value).run();
}

export async function loadAppBrandingSettings(env: Env, fallbackName = '0xCMS'): Promise<AppBrandingSettings> {
  const defaults = defaultAppBrandingSettings(fallbackName);
  const raw = await getSetting(env, APP_BRANDING_SETTING_KEY);
  if (!raw) return defaults;

  try {
    const saved = JSON.parse(raw);
    const appName = typeof saved?.appName === 'string' && saved.appName.trim()
      ? saved.appName.trim()
      : defaults.appName;
    const appIcon = typeof saved?.appIcon === 'string' && APP_ICON_VALUES.has(saved.appIcon)
      ? saved.appIcon as AppIcon
      : defaults.appIcon;
    const primaryColor = normalizeHexColor(saved?.primaryColor) ?? defaults.primaryColor;
    const appFont = typeof saved?.appFont === 'string' && APP_FONT_VALUES.has(saved.appFont)
      ? saved.appFont as AppFont
      : defaults.appFont;
    return { appName, appIcon, primaryColor, appFont };
  } catch (error) {
    return defaults;
  }
}

export async function saveAppBrandingSettings(env: Env, input: { appName: unknown; appIcon: unknown; primaryColor?: unknown; appFont?: unknown }, fallbackName = '0xCMS'): Promise<AppBrandingSettings> {
  const defaults = defaultAppBrandingSettings(fallbackName);
  const appName = typeof input.appName === 'string' && input.appName.trim()
    ? input.appName.trim().slice(0, 80)
    : defaults.appName;
  const appIcon = typeof input.appIcon === 'string' && APP_ICON_VALUES.has(input.appIcon)
    ? input.appIcon as AppIcon
    : defaults.appIcon;
  const primaryColor = normalizeHexColor(input.primaryColor) ?? defaults.primaryColor;
  const appFont = typeof input.appFont === 'string' && APP_FONT_VALUES.has(input.appFont)
    ? input.appFont as AppFont
    : defaults.appFont;
  const settings = { appName, appIcon, primaryColor, appFont };
  await saveSetting(env, APP_BRANDING_SETTING_KEY, JSON.stringify(settings));
  return settings;
}

export async function loadAdminHomeSettings(env: Env): Promise<AdminHomeSettings> {
  const raw = await getSetting(env, ADMIN_HOME_SETTING_KEY);
  if (!raw) return defaultAdminHomeSettings();

  try {
    const saved = JSON.parse(raw);
    return { href: adminHomePath(saved?.href) };
  } catch (error) {
    return defaultAdminHomeSettings();
  }
}

export async function saveAdminHomeSettings(env: Env, input: { href: unknown }): Promise<AdminHomeSettings> {
  const settings = { href: adminHomePath(input.href) };
  await saveSetting(env, ADMIN_HOME_SETTING_KEY, JSON.stringify(settings));
  return settings;
}

export async function loadSidebarChromeSettings(env: Env): Promise<SidebarChromeSettings> {
  const settings = defaultSidebarMenuSettings();
  let settingsGroupWeight = DEFAULT_SETTINGS_GROUP_WEIGHT;
  let pluginWeights: Record<string, number> = {};
  let pluginIcons: Record<string, AppIcon> = {};
  let hiddenPluginKeys = new Set<string>();
  const raw = await getSetting(env, SIDEBAR_MENU_SETTING_KEY);
  if (!raw) return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };

  try {
    const saved = JSON.parse(raw);
    const hidden = Array.isArray(saved)
      ? saved
      : Array.isArray(saved?.hidden)
        ? saved.hidden
        : [];
    for (const key of hidden) {
      const normalizedKey = legacySidebarMenuKey(key);
      if (normalizedKey) {
        settings[normalizedKey].visible = false;
      }
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && saved.weights && typeof saved.weights === 'object') {
      for (const item of SIDEBAR_MENU_ITEMS) {
        const legacyWeight = item.key === 'system' ? saved.weights.menu : undefined;
        const weight = finiteWeight(saved.weights[item.key] ?? legacyWeight, item.defaultWeight);
        settings[item.key].weight = weight;
      }
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      settingsGroupWeight = finiteWeight(saved.groupWeights?.settings, DEFAULT_SETTINGS_GROUP_WEIGHT);
      if (saved.pluginWeights && typeof saved.pluginWeights === 'object') {
        pluginWeights = Object.fromEntries(Object.entries(saved.pluginWeights)
          .map(([key, value]) => [key, finiteWeight(value, defaultPluginNavWeight(key))]));
      }
      if (saved.pluginIcons && typeof saved.pluginIcons === 'object') {
        pluginIcons = Object.fromEntries(Object.entries(saved.pluginIcons)
          .filter((entry): entry is [string, AppIcon] => typeof entry[1] === 'string' && APP_ICON_VALUES.has(entry[1])));
      }
      if (Array.isArray(saved.hiddenPlugins)) {
        hiddenPluginKeys = new Set(saved.hiddenPlugins.filter((key: unknown): key is string => typeof key === 'string'));
      }
    }
    settings.system.visible = true;
  } catch (error) {
    return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
  }

  return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
}

export async function saveSidebarMenuSettings(
  env: Env,
  visibleKeys: string[],
  weights: Record<string, unknown> = {},
  options: { settingsGroupWeight?: unknown; pluginWeights?: Record<string, unknown>; pluginIcons?: Record<string, unknown>; pluginVisibleKeys?: string[] } = {},
): Promise<SidebarChromeSettings> {
  const visible = new Set(visibleKeys.map(legacySidebarMenuKey).filter((key): key is SidebarMenuItemKey => !!key));
  visible.add('system');
  const settings = defaultSidebarMenuSettings();
  const hidden: SidebarMenuItemKey[] = [];
  const savedWeights: Record<string, number> = {};
  const pluginWeights: Record<string, number> = {};
  const pluginIcons: Record<string, AppIcon> = {};
  const hiddenPluginKeys = new Set<string>();
  const visiblePluginKeys = new Set(options.pluginVisibleKeys ?? []);
  const settingsGroupWeight = finiteWeight(options.settingsGroupWeight, DEFAULT_SETTINGS_GROUP_WEIGHT);

  for (const item of SIDEBAR_MENU_ITEMS) {
    const isVisible = visible.has(item.key);
    const weight = finiteWeight(weights[item.key], item.defaultWeight);
    settings[item.key] = { visible: isVisible, weight };
    if (!isVisible && item.key !== 'system') hidden.push(item.key);
    if (weight !== item.defaultWeight) savedWeights[item.key] = weight;
  }

  for (const [key, value] of Object.entries(options.pluginWeights ?? {})) {
    const weight = finiteWeight(value, defaultPluginNavWeight(key));
    if (weight !== defaultPluginNavWeight(key)) pluginWeights[key] = weight;
    if (!visiblePluginKeys.has(key)) hiddenPluginKeys.add(key);
  }
  for (const [key, value] of Object.entries(options.pluginIcons ?? {})) {
    if (typeof value === 'string' && APP_ICON_VALUES.has(value) && value !== 'beaker') {
      pluginIcons[key] = value as AppIcon;
    }
  }

  const groupWeights = settingsGroupWeight === DEFAULT_SETTINGS_GROUP_WEIGHT
    ? {}
    : { settings: settingsGroupWeight };
  await saveSetting(env, SIDEBAR_MENU_SETTING_KEY, JSON.stringify({
    hidden,
    weights: savedWeights,
    groupWeights,
    pluginWeights,
    pluginIcons,
    hiddenPlugins: [...hiddenPluginKeys],
  }));
  return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
}

export function pluginSidebarKey(item: { pluginId: string; href: string; group?: 'settings' }): string {
  return `plugin:${item.pluginId}:${item.group === 'settings' ? 'settings' : 'main'}:${item.href}`;
}

export function defaultPluginNavWeight(keyOrGroup?: string): number {
  return keyOrGroup?.includes(':settings:') || keyOrGroup === 'settings'
    ? DEFAULT_PLUGIN_SETTINGS_NAV_WEIGHT
    : DEFAULT_PLUGIN_NAV_WEIGHT;
}

function defaultAppBrandingSettings(fallbackName: string): AppBrandingSettings {
  return {
    appName: fallbackName,
    appIcon: 'document',
    primaryColor: DEFAULT_PRIMARY_COLOR,
    appFont: DEFAULT_APP_FONT,
  };
}

function defaultAdminHomeSettings(): AdminHomeSettings {
  return { href: '/admin' };
}

function adminHomePath(value: unknown): string {
  if (typeof value !== 'string') return '/admin';
  const href = value.trim().slice(0, 300);
  if (href === '/admin' || href.startsWith('/admin/') || href.startsWith('/admin?')) return href;
  return '/admin';
}

function legacySidebarMenuKey(value: unknown): SidebarMenuItemKey | null {
  if (value === 'menu') return 'system';
  return typeof value === 'string' && SIDEBAR_MENU_KEYS.has(value) ? value as SidebarMenuItemKey : null;
}

function finiteWeight(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
