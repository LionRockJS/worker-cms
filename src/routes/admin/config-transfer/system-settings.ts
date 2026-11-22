import type { AppContext } from '../../../core/http/context';
import { isRecord, planChange, skipItem, type ConfigTransferPlanItem, type ConfigTransferSection } from '../../../core/config-transfer';
import {
  ADMIN_HOME_SETTING_KEY, APP_BRANDING_SETTING_KEY, CUSTOM_ICON_SPRITE_SETTING_KEY, SHOW_CREDITS_SETTING_KEY,
  SIDEBAR_MENU_SETTING_KEY, SYSTEM_TIMEZONE_SETTING_KEY,
  customIconSpriteFromRaw, getSetting, normalizeAdminHomeSettings, normalizeAppBrandingSettings, normalizeSystemTimezone,
} from '../../../core/db/settings';
import { prepareHostSettingsMutation } from '../../../core/evidence/settings-mutation-evidence';
import { MAX_ICON_SPRITE_BYTES, parseIconSprite } from '../../../core/render/icon-sprite';

// The sprite comes first so branding can refer to an imported custom icon.
const SETTING_KEYS = [
  CUSTOM_ICON_SPRITE_SETTING_KEY, APP_BRANDING_SETTING_KEY, ADMIN_HOME_SETTING_KEY,
  SYSTEM_TIMEZONE_SETTING_KEY, SHOW_CREDITS_SETTING_KEY, SIDEBAR_MENU_SETTING_KEY,
] as const;
type SettingKey = typeof SETTING_KEYS[number];

function parsedJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

/** The value to store for an imported setting, or an error message. */
function normalizedSetting(c: AppContext, key: SettingKey, value: string, customIcons: ReadonlySet<string>): string | { error: string } {
  switch (key) {
    case CUSTOM_ICON_SPRITE_SETTING_KEY: {
      const sprite = customIconSpriteFromRaw(value);
      if (!sprite || new TextEncoder().encode(sprite.svg).length > MAX_ICON_SPRITE_BYTES) return { error: 'Invalid icon sprite.' };
      try { return JSON.stringify(parseIconSprite(sprite.svg)); } catch { return { error: 'Invalid icon sprite.' }; }
    }
    case APP_BRANDING_SETTING_KEY: {
      const saved = parsedJson(value);
      if (!isRecord(saved)) return { error: 'Invalid branding.' };
      return JSON.stringify(normalizeAppBrandingSettings({
        appName: saved.appName, appIcon: saved.appIcon, primaryColor: saved.primaryColor, appFont: saved.appFont,
      }, c.env.SITE_TITLE ?? '0xCMS', customIcons));
    }
    case ADMIN_HOME_SETTING_KEY: {
      const saved = parsedJson(value);
      return isRecord(saved) ? JSON.stringify(normalizeAdminHomeSettings({ href: saved.href })) : { error: 'Invalid home page.' };
    }
    case SYSTEM_TIMEZONE_SETTING_KEY:
      return normalizeSystemTimezone(value) ?? { error: 'Invalid timezone.' };
    case SHOW_CREDITS_SETTING_KEY:
      return value === 'true' || value === 'false' ? value : { error: 'Invalid value.' };
    case SIDEBAR_MENU_SETTING_KEY:
      // The menu loader ignores unknown or malformed entries, so any object is safe to store.
      return isRecord(parsedJson(value)) ? value : { error: 'Invalid menu settings.' };
  }
}

export const systemSettingsSection: ConfigTransferSection = {
  id: 'system_settings',
  labelKey: 'settings.transfer.sections.system_settings',
  order: 70,
  permission: 'menu:manage',
  async *exportRecords(c, after) {
    for (const key of SETTING_KEYS.slice(after ? SETTING_KEYS.indexOf(after as SettingKey) + 1 : 0)) {
      const value = await getSetting(c.env, key);
      if (value !== null) yield { key, label: key, item: { key, value } };
    }
  },
  async plan(c, items) {
    const current = new Map<string, string | null>();
    for (const key of SETTING_KEYS) current.set(key, await getSetting(c.env, key));
    const bundleSprite = items.find((item) => isRecord(item) && item.key === CUSTOM_ICON_SPRITE_SETTING_KEY);
    const customIcons = new Set([
      ...(customIconSpriteFromRaw(current.get(CUSTOM_ICON_SPRITE_SETTING_KEY) ?? null)?.icons ?? []),
      ...(isRecord(bundleSprite) && typeof bundleSprite.value === 'string' ? customIconSpriteFromRaw(bundleSprite.value)?.icons ?? [] : []),
    ]);
    const ordered = [...items].sort((a, b) => SETTING_KEYS.indexOf((isRecord(a) ? a.key : '') as SettingKey)
      - SETTING_KEYS.indexOf((isRecord(b) ? b.key : '') as SettingKey));
    return ordered.map((item): ConfigTransferPlanItem => {
      const key = isRecord(item) && typeof item.key === 'string' ? item.key : '?';
      if (!isRecord(item) || !SETTING_KEYS.includes(key as SettingKey) || typeof item.value !== 'string') {
        return skipItem(key, 'This setting cannot be imported.');
      }
      const value = normalizedSetting(c, key as SettingKey, item.value, customIcons);
      if (typeof value !== 'string') return skipItem(key, value.error);
      const before = current.get(key);
      const comparable = (raw: string) => parsedJson(raw) ?? raw;
      return planChange(key, before === null || before === undefined ? undefined : comparable(before), comparable(value), async () => {
        const mutation = await prepareHostSettingsMutation(c, [key as SettingKey]);
        await mutation.commit([{ key: key as SettingKey, value }]);
      });
    });
  },
};
