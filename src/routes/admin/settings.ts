import { HOST_SETTINGS_KEYS, prepareHostSettingsMutation } from '../../core/db/settings-mutation-evidence';
import { Hono } from 'hono';
import { requirePermission } from '../../core/auth/guards';
import { coreExtensions } from '../../core/extensions';
import { localeRegistry } from '../../core/i18n';
import { featureInstalled } from '../../features';
import { featureAdminScreenProps, featureSystemSettingsWrites } from '../../features/services';
import { systemSettingsPage } from '../../core/templates/settings';
import type { Env, Variables } from '../../types';
import { renderPage } from '../../core/render/chrome';
import { customIconHref, MAX_ICON_SPRITE_BYTES, parseIconSprite } from '../../core/render/icon-sprite';
import {
  APP_FONT_OPTIONS,
  APP_ICON_OPTIONS,
  SIDEBAR_MENU_ITEMS,
  installedMenuItems,
  menuItemFeature,
  SYSTEM_TIMEZONE_OPTIONS,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadCustomIconSprite,
  customIconSpriteFromRaw,
  loadAdminHomeSettings,
  loadSidebarChromeSettings,
  loadSystemTimezone,
  normalizeSystemTimezone,
  pluginSidebarKey,
  normalizeAdminHomeSettings,
  normalizeAppBrandingSettings,
  buildSidebarMenuSettings,
  sidebarChromeSettingsFromRaw,
  APP_BRANDING_SETTING_KEY, ADMIN_HOME_SETTING_KEY, SYSTEM_TIMEZONE_SETTING_KEY,
  SIDEBAR_MENU_SETTING_KEY, DEFAULT_SYSTEM_TIMEZONE, CUSTOM_ICON_SPRITE_SETTING_KEY,
} from '../../core/db/settings';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.use('/settings/system', requirePermission('menu:manage'));
settingsRoutes.use('/settings/system/icon-sprite', requirePermission('menu:manage'));
settingsRoutes.use('/settings/menu', requirePermission('menu:manage'));
// The credit summary is a read-only view any admin user may see; editing the
// prices happens under /plugins-manage/* which stays gated by plugin:manage.
// So no per-route permission here — editorGuard already limits it to signed-in
// admin users, and the "Configure" links are hidden below for non-managers.


settingsRoutes.get('/settings/menu', (c) => c.redirect('/admin/settings/system'));

// Shared row comparator: group by plugin, then by human label, then key.
settingsRoutes.get('/settings/system', async (c) => {
  const fallbackName = c.env.SITE_TITLE ?? '0xCMS';
  const customIcons = loadCustomIconSprite(c.env).then((sprite) => new Set(sprite?.icons));
  const [sidebarSettings, branding, adminHome, pluginItems, systemTimezone, featureProps, { uiLocales }, uploaded] = await Promise.all([
    loadSidebarChromeSettings(c.env, customIcons),
    loadAppBrandingSettings(c.env, fallbackName, customIcons),
    loadAdminHomeSettings(c.env),
    coreExtensions().sidebarNav?.(c.env) ?? [],
    loadSystemTimezone(c.env),
    featureAdminScreenProps(c, { screen: 'system-settings' }),
    localeRegistry(c.env),
    customIcons,
  ]);
  const uploadedIcons = [...uploaded].map((value) => ({
    value,
    label: value.slice('custom-'.length).replace(/[-_.]+/g, ' '),
    labelKey: '',
    href: customIconHref(value),
  }));
  // An entry owned by a feature that is not installed has nothing to configure
  // — the chrome would hide it whatever this screen saved.
  const showCredits = featureProps.showCredits === true;
  const menuItems = installedMenuItems(featureInstalled);
  const menuOption = (item: typeof SIDEBAR_MENU_ITEMS[number], index: number) => ({
    value: item.key,
    label: item.key === 'users' && !showCredits ? 'Users' : item.label,
    description: item.description,
    labelKey: item.key === 'users' && !showCredits ? 'nav.users_without_credits' : `nav.${item.key}`,
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
  const labelFields = (key: string) => uiLocales.map((locale) => ({
    name: `sidebar_label_${encodeURIComponent(key)}_${locale.code}`,
    label: locale.label,
    code: locale.code,
    direction: locale.direction,
    value: sidebarSettings.labels[key]?.[locale.code] ?? '',
  }));
  const coreSidebarOption = (option: typeof options[number]) => ({
    label: '',
    labelKey: option.labelKey,
    description: '',
    descriptionKey: option.descriptionKey,
    visibleName: 'visible_items',
    visibleValue: option.value,
    checked: option.checked,
    locked: option.locked,
    labelFields: labelFields(option.value),
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
    labelFields: labelFields(option.key),
    weightName: `plugin_weight_${option.formKey}`,
    weight: option.weight,
    icon: option.icon,
    iconName: `plugin_icon_${option.formKey}`,
    iconHref: customIconHref(option.icon),
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
      labelFields: labelFields('settings'),
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
    hasI18nFeature: featureInstalled('i18n'),
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
    hasCreditsFeature: featureProps.hasCreditsFeature === true,
    showCredits,
    systemTimezone,
    timezoneOptions: [
      ...(SYSTEM_TIMEZONE_OPTIONS.some((option) => option.value === systemTimezone)
        ? []
        : [{ value: systemTimezone, label: systemTimezone }]),
      ...SYSTEM_TIMEZONE_OPTIONS,
    ].map((option) => ({ ...option, selected: option.value === systemTimezone })),
    iconOptions: [
      ...APP_ICON_OPTIONS.map((option) => ({ ...option, labelKey: `settings.icons.${option.value}`, href: '' })),
      ...uploadedIcons,
    ].sort((a, b) => a.label.localeCompare(b.label)).map((option) => ({ ...option, selected: option.value === branding.appIcon })),
    uploadedIcons,
    settingsGroupWeight: sidebarSettings.settingsGroupWeight,
    mainOptions: options.filter((option) => option.group === 'main'),
    settingsOptions: options.filter((option) => option.group === 'settings'),
    options,
    pluginOptions,
    mainSidebarOptions,
    settingsSidebarOptions,
    flashKey: c.req.query('flash') === 'icon-sprite-uploaded' ? 'settings.icon_sprite.uploaded'
      : c.req.query('flash') === 'saved' ? 'settings.system_saved' : '',
    errorKey: c.req.query('error') === 'invalid-icon-sprite' ? 'settings.icon_sprite.invalid'
      : c.req.query('error') === 'icon-sprite-too-large' ? 'settings.icon_sprite.too_large'
      : c.req.query('error') === 'invalid-timezone' ? 'settings.timezone_invalid' : '',
  });
});

settingsRoutes.post('/settings/menu', async (c) => c.redirect('/admin/settings/system', 303));

settingsRoutes.post('/settings/system/icon-sprite', async (c) => {
  const invalid = '/admin/settings/system?error=invalid-icon-sprite';
  let sprite: ReturnType<typeof parseIconSprite>;
  try {
    const file = (await c.req.formData()).get('icon_sprite');
    if (!(file instanceof File) || !file.size) return c.redirect(invalid, 303);
    if (file.size > MAX_ICON_SPRITE_BYTES) return c.redirect('/admin/settings/system?error=icon-sprite-too-large', 303);
    sprite = parseIconSprite(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await file.arrayBuffer()));
  } catch {
    return c.redirect(invalid, 303);
  }
  const mutation = await prepareHostSettingsMutation(c, [CUSTOM_ICON_SPRITE_SETTING_KEY]);
  await mutation.commit([{ key: CUSTOM_ICON_SPRITE_SETTING_KEY, value: JSON.stringify(sprite) }]);
  return c.redirect('/admin/settings/system?flash=icon-sprite-uploaded', 303);
});

settingsRoutes.post('/settings/system', async (c) => {
  const form = await c.req.formData();
  const submittedTimezone = form.get('system_timezone');
  if (submittedTimezone !== null && !normalizeSystemTimezone(submittedTimezone)) return c.redirect('/admin/settings/system?error=invalid-timezone', 303);
  const mutation = await prepareHostSettingsMutation(c, [...HOST_SETTINGS_KEYS, CUSTOM_ICON_SPRITE_SETTING_KEY]);
  const customIcons = new Set(customIconSpriteFromRaw(mutation.value(CUSTOM_ICON_SPRITE_SETTING_KEY))?.icons);
  const systemTimezone = submittedTimezone === null
    ? normalizeSystemTimezone(mutation.value(SYSTEM_TIMEZONE_SETTING_KEY)) ?? DEFAULT_SYSTEM_TIMEZONE
    : normalizeSystemTimezone(submittedTimezone)!;
  const pluginItems = await (coreExtensions().sidebarNav?.(c.env) ?? []);
  // Entries this build does not show were never rendered, so the form says
  // nothing about them. Carry their saved state forward instead of reading the
  // silence as "hidden" — otherwise re-enabling a feature brings it back off.
  const saved = sidebarChromeSettingsFromRaw(mutation.value(SIDEBAR_MENU_SETTING_KEY), customIcons);
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
  const { uiLocales } = await localeRegistry(c.env);
  const labels = { ...saved.labels };
  const labelKeys = [...installedMenuItems(featureInstalled).map((item) => item.key), 'settings', ...pluginItems.map(pluginSidebarKey)];
  for (const key of labelKeys) {
    const translations = { ...labels[key] };
    for (const locale of uiLocales) {
      const value = form.get(`sidebar_label_${encodeURIComponent(key)}_${locale.code}`);
      // Missing fields belong to older forms or disabled languages/features.
      if (typeof value === 'string') translations[locale.code] = value;
    }
    labels[key] = translations;
  }
  const pluginVisibleKeys = form.getAll('plugin_visible_items').map(String);
  const branding = normalizeAppBrandingSettings({
    appName: form.get('app_name'), appIcon: form.get('app_icon'),
    primaryColor: form.get('primary_color'), appFont: form.get('app_font'),
  }, c.env.SITE_TITLE ?? '0xCMS', customIcons);
  const sidebar = buildSidebarMenuSettings(visibleKeys, weights, {
    labels, settingsGroupWeight: form.get('settings_group_weight'), pluginWeights, pluginIcons, pluginVisibleKeys,
    savedPluginMenu: saved,
    customIcons,
  });
  await mutation.commit([
    { key: APP_BRANDING_SETTING_KEY, value: JSON.stringify(branding) },
    { key: ADMIN_HOME_SETTING_KEY, value: JSON.stringify(normalizeAdminHomeSettings({href: form.get('admin_home_path')})) },
    { key: SYSTEM_TIMEZONE_SETTING_KEY, value: systemTimezone },
    ...featureSystemSettingsWrites(form),
    { key: SIDEBAR_MENU_SETTING_KEY, value: sidebar.value },
  ]);
  return c.redirect('/admin/settings/system?flash=saved');
});
