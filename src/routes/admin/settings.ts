import { Hono } from 'hono';
import { requirePermission } from '../../core/auth/guards';
import { coreExtensions } from '../../core/extensions';
import { featureInstalled } from '../../features';
import { systemSettingsPage } from '../../core/templates/settings';
import type { Env, Variables } from '../../types';
import { logAudit } from '../../core/db/audit';
import { renderPage } from '../../core/render/chrome';
import {
  APP_FONT_OPTIONS,
  APP_ICON_OPTIONS,
  SIDEBAR_MENU_ITEMS,
  installedMenuItems,
  menuItemFeature,
  SYSTEM_TIMEZONE_OPTIONS,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadAdminHomeSettings,
  loadSidebarChromeSettings,
  loadSystemTimezone,
  normalizeSystemTimezone,
  pluginSidebarKey,
  saveAdminHomeSettings,
  saveAppBrandingSettings,
  saveSidebarMenuSettings,
  saveSystemTimezone,
} from '../../core/db/settings';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.use('/settings/system', requirePermission('menu:manage'));
settingsRoutes.use('/settings/menu', requirePermission('menu:manage'));
// The credit summary is a read-only view any admin user may see; editing the
// prices happens under /plugins-manage/* which stays gated by plugin:manage.
// So no per-route permission here — editorGuard already limits it to signed-in
// admin users, and the "Configure" links are hidden below for non-managers.


settingsRoutes.get('/settings/menu', (c) => c.redirect('/admin/settings/system'));

// Shared row comparator: group by plugin, then by human label, then key.
settingsRoutes.get('/settings/system', async (c) => {
  const fallbackName = c.env.SITE_TITLE ?? '0xCMS';
  const [sidebarSettings, branding, adminHome, pluginItems, systemTimezone] = await Promise.all([
    loadSidebarChromeSettings(c.env),
    loadAppBrandingSettings(c.env, fallbackName),
    loadAdminHomeSettings(c.env),
    coreExtensions().sidebarNav?.(c.env) ?? [],
    loadSystemTimezone(c.env),
  ]);
  // An entry owned by a feature that is not installed has nothing to configure
  // — the chrome would hide it whatever this screen saved.
  const menuItems = installedMenuItems(featureInstalled);
  const menuOption = (item: typeof SIDEBAR_MENU_ITEMS[number], index: number) => ({
    value: item.key,
    label: item.label,
    description: item.description,
    labelKey: `nav.${item.key}`,
    descriptionKey: `settings.menu.${item.key}_description`,
    checked: sidebarSettings.items[item.key].visible,
    locked: item.key === 'system',
    weight: sidebarSettings.items[item.key].weight,
    group: item.group,
    icon: item.icon,
    index,
  });
  const options = menuItems.map(menuOption);
  const pluginOptions = pluginItems.map((item, index) => {
    const key = pluginSidebarKey(item);
    return {
      label: item.label,
      href: item.href,
      groupLabel: item.group === 'settings' ? 'Settings' : 'Main',
      groupKey: item.group === 'settings' ? 'settings.groups.settings' : 'settings.groups.main',
      group: item.group === 'settings' ? 'settings' as const : 'main' as const,
      key,
      formKey: encodeURIComponent(key),
      checked: !sidebarSettings.hiddenPluginKeys.has(key),
      weight: sidebarSettings.pluginWeights[key] ?? defaultPluginNavWeight(item.group),
      icon: sidebarSettings.pluginIcons[key] ?? 'beaker',
      index: SIDEBAR_MENU_ITEMS.length + index,
    };
  });
  const coreSidebarOption = (option: typeof options[number]) => ({
    label: '',
    labelKey: option.labelKey,
    description: '',
    descriptionKey: option.descriptionKey,
    visibleName: 'visible_items',
    visibleValue: option.value,
    checked: option.checked,
    locked: option.locked,
    weightName: `weight_${option.value}`,
    weight: option.weight,
    icon: option.icon,
    iconName: '',
    index: option.index,
  });
  const pluginSidebarOption = (option: typeof pluginOptions[number]) => ({
    label: option.label,
    labelKey: '',
    description: option.href,
    descriptionKey: '',
    visibleName: 'plugin_visible_items',
    visibleValue: option.key,
    checked: option.checked,
    locked: false,
    weightName: `plugin_weight_${option.formKey}`,
    weight: option.weight,
    icon: option.icon,
    iconName: `plugin_icon_${option.formKey}`,
    index: option.index,
  });
  const byWeight = <T extends { weight: number; index: number }>(a: T, b: T) => a.weight - b.weight || a.index - b.index;
  const mainSidebarOptions = [
    ...options.filter((option) => option.group === 'main').map(coreSidebarOption),
    ...pluginOptions.filter((option) => option.group === 'main').map(pluginSidebarOption),
    {
      label: '',
      labelKey: 'nav.settings',
      description: '',
      descriptionKey: '',
      visibleName: '',
      visibleValue: '',
      checked: true,
      locked: true,
      weightName: 'settings_group_weight',
      weight: sidebarSettings.settingsGroupWeight,
      icon: 'settings',
      iconName: '',
      // The chrome adds the group after contributed links, so keep that same
      // tie-breaker when a plugin and the group share a weight.
      index: SIDEBAR_MENU_ITEMS.length + pluginOptions.length,
    },
  ].sort(byWeight);
  const settingsSidebarOptions = [
    ...options.filter((option) => option.group === 'settings').map(coreSidebarOption),
    ...pluginOptions.filter((option) => option.group === 'settings').map(pluginSidebarOption),
  ].sort(byWeight);
  return renderPage(c, systemSettingsPage, {
    appName: branding.appName,
    appIcon: branding.appIcon,
    primaryColor: branding.primaryColor,
    fontOptions: APP_FONT_OPTIONS.map((option) => ({
      value: option.value,
      labelKey: `settings.appearance.fonts.${option.value}`,
      stack: option.stack,
      selected: option.value === branding.appFont,
    })),
    adminHomePath: adminHome.href,
    systemTimezone,
    timezoneOptions: [
      ...(SYSTEM_TIMEZONE_OPTIONS.some((option) => option.value === systemTimezone)
        ? []
        : [{ value: systemTimezone, label: systemTimezone }]),
      ...SYSTEM_TIMEZONE_OPTIONS,
    ].map((option) => ({ ...option, selected: option.value === systemTimezone })),
    iconOptions: [...APP_ICON_OPTIONS].sort((a, b) => a.label.localeCompare(b.label)).map((option) => ({
      ...option,
      labelKey: `settings.icons.${option.value}`,
      selected: option.value === branding.appIcon,
    })),
    settingsGroupWeight: sidebarSettings.settingsGroupWeight,
    mainOptions: options.filter((option) => option.group === 'main'),
    settingsOptions: options.filter((option) => option.group === 'settings'),
    options,
    pluginOptions,
    mainSidebarOptions,
    settingsSidebarOptions,
    flashKey: c.req.query('flash') === 'saved' ? 'settings.system_saved' : '',
    errorKey: c.req.query('error') === 'invalid-timezone' ? 'settings.timezone_invalid' : '',
  });
});

settingsRoutes.post('/settings/menu', async (c) => c.redirect('/admin/settings/system', 303));

settingsRoutes.post('/settings/system', async (c) => {
  const form = await c.req.formData();
  const submittedTimezone = form.get('system_timezone');
  const systemTimezone = submittedTimezone === null
    ? await loadSystemTimezone(c.env)
    : normalizeSystemTimezone(submittedTimezone);
  if (!systemTimezone) return c.redirect('/admin/settings/system?error=invalid-timezone', 303);
  const pluginItems = await (coreExtensions().sidebarNav?.(c.env) ?? []);
  // Entries this build does not show were never rendered, so the form says
  // nothing about them. Carry their saved state forward instead of reading the
  // silence as "hidden" — otherwise re-enabling a feature brings it back off.
  const saved = await loadSidebarChromeSettings(c.env);
  const isShown = (item: typeof SIDEBAR_MENU_ITEMS[number]) => featureInstalled(menuItemFeature(item));
  const visibleKeys = [
    ...form.getAll('visible_items').map(String),
    ...SIDEBAR_MENU_ITEMS.filter((item) => !isShown(item) && saved.items[item.key].visible).map((item) => item.key),
  ];
  const weights = Object.fromEntries(SIDEBAR_MENU_ITEMS.map((item) => [
    item.key,
    isShown(item) ? form.get(`weight_${item.key}`) : saved.items[item.key].weight,
  ]));
  const pluginWeights = Object.fromEntries(pluginItems.map((item) => {
    const key = pluginSidebarKey(item);
    return [key, form.get(`plugin_weight_${encodeURIComponent(key)}`)];
  }));
  const pluginIcons = Object.fromEntries(pluginItems.map((item) => {
    const key = pluginSidebarKey(item);
    return [key, form.get(`plugin_icon_${encodeURIComponent(key)}`)];
  }));
  const pluginVisibleKeys = form.getAll('plugin_visible_items').map(String);
  await Promise.all([
    saveAppBrandingSettings(c.env, {
      appName: form.get('app_name'),
      appIcon: form.get('app_icon'),
      primaryColor: form.get('primary_color'),
      appFont: form.get('app_font'),
    }, c.env.SITE_TITLE ?? '0xCMS'),
    saveAdminHomeSettings(c.env, {
      href: form.get('admin_home_path'),
    }),
    saveSystemTimezone(c.env, systemTimezone),
    saveSidebarMenuSettings(c.env, visibleKeys, weights, {
      settingsGroupWeight: form.get('settings_group_weight'),
      pluginWeights,
      pluginIcons,
      pluginVisibleKeys,
    }),
  ]);
  logAudit(c, 'settings.system.update', 'settings', 'admin.system');
  return c.redirect('/admin/settings/system?flash=saved');
});
