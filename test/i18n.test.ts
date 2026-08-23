import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { clearConfigCache, resolveCmsConfig } from '../src/core/db/content-config';
import {
  buildTranslationCatalog,
  CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,
  deleteLocale,
  flattenMessages,
  loadDefaultContentLanguage,
  listLocales,
  saveDefaultContentLanguage,
  saveLocale,
  saveLocaleMessage,
} from '../src/core/i18n';
import { APP_ICON_OPTIONS, SIDEBAR_MENU_ITEMS } from '../src/core/db/settings';
import { USER_ROLES } from '../src/types';

const cmsEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM locale_messages WHERE locale_code = 'fr'").run();
  await env.DB.prepare("DELETE FROM locales WHERE code = 'fr'").run();
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CONTENT_DEFAULT_LANGUAGE_SETTING_KEY).run();
  await env.DB.prepare("UPDATE locales SET content_enabled = 1 WHERE code = 'mis'").run();
  clearConfigCache();
});

describe('database locale registry', () => {
  it('keeps mis as the protected unspecified content language', async () => {
    const locales = await listLocales(cmsEnv);
    const unspecified = locales.find((locale) => locale.code === 'mis');
    expect(unspecified).toMatchObject({ content_enabled: 1, ui_enabled: 0, builtin: 1 });
    await expect(deleteLocale(cmsEnv, 'mis')).rejects.toThrow('cannot be deleted');
  });

  it('allows another enabled content language to become default and then disables mis', async () => {
    await saveDefaultContentLanguage(cmsEnv, 'zh-hant');
    expect(await loadDefaultContentLanguage(cmsEnv)).toBe('zh-hant');

    await saveLocale(cmsEnv, {
      label: 'Unspecified language', content_enabled: '', ui_enabled: '', fallback_code: '', weight: '0',
    }, 'mis');

    const locales = await listLocales(cmsEnv);
    expect(locales.find((locale) => locale.code === 'mis')?.content_enabled).toBe(0);
    expect((await resolveCmsConfig(cmsEnv)).defaultLanguage).toBe('zh-hant');
  });

  it('keeps the selected default content language enabled', async () => {
    await expect(saveLocale(cmsEnv, {
      label: 'Unspecified language', content_enabled: '', ui_enabled: '', fallback_code: '', weight: '0',
    }, 'mis')).resolves.toBe('mis');
    expect((await listLocales(cmsEnv)).find((locale) => locale.code === 'mis')?.content_enabled).toBe(1);
  });

  it('does not allow the selected default content language to be deleted', async () => {
    await saveDefaultContentLanguage(cmsEnv, 'zh-hant');
    await expect(deleteLocale(cmsEnv, 'zh-hant')).rejects.toThrow('default content language');
  });

  it('extends the effective content languages from the database', async () => {
    await saveLocale(cmsEnv, {
      code: 'fr', label: 'Français', content_enabled: 'on', ui_enabled: 'on', fallback_code: 'en', weight: '40',
    });
    clearConfigCache();
    const config = await resolveCmsConfig(cmsEnv);
    expect(config.defaultLanguage).toBe('mis');
    expect(config.languages).toContain('fr');
  });

  it('merges bundled fallback strings with database overrides', async () => {
    await saveLocale(cmsEnv, {
      code: 'fr', label: 'Français', content_enabled: 'on', ui_enabled: 'on', fallback_code: 'en', weight: '40',
    });
    await saveLocaleMessage(cmsEnv, 'fr', 'common.save', 'Enregistrer');
    await saveLocaleMessage(cmsEnv, 'fr', 'plugin.demo.label', 'Extension démo');

    const catalog = await buildTranslationCatalog(cmsEnv, 'fr');
    expect(catalog['common.add']).toBe('Add');
    expect(catalog['common.save']).toBe('Enregistrer');
    expect(catalog['plugin.demo.label']).toBe('Extension démo');
  });

  it('keeps bundled locale files aligned with the English catalog', async () => {
    const catalogs = await Promise.all(['en', 'mis', 'zh-hans', 'zh-hant'].map(async (locale) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/locales/${locale}.json`);
      expect(response.ok).toBe(true);
      return flattenMessages(await response.json());
    }));
    const [english, unspecified, ...translated] = catalogs;
    const englishKeys = Object.keys(english).sort();

    expect(unspecified).toEqual(english);
    for (const catalog of translated) expect(Object.keys(catalog).sort()).toEqual(englishKeys);
  });

  it('defines every translation key used by core CMS views', async () => {
    const englishResponse = await cmsEnv.VIEWS.fetch('https://views.local/locales/en.json');
    const english = flattenMessages(await englishResponse.json());
    const viewPaths = [
      'layout/default.liquid',
      ...[
        'advanced-search', 'block-type-form', 'bulk-replace-preview', 'content-list', 'credit-summary', 'dashboard', 'editor', 'error', 'viewer-home',
        'languages', 'login', 'menu-settings', 'page-type-form', 'plugin-assets', 'plugin-credits', 'plugin-form',
        'plugin-limits', 'plugin-page-types', 'plugins-manage', 'profile', 'role-form', 'roles', 'tag-form', 'tags',
        'taxonomies', 'taxonomy-form', 'translations', 'trash', 'type-list', 'user-form', 'users',
      ].map((name) => `sections/${name}.liquid`),
      'snippets/color-tag-picker.liquid',
      'snippets/structured-editor.liquid',
      'snippets/structured-item-group.liquid',
      'snippets/structured-item.liquid',
      ...[
        'boolean/basic', 'checkbox/basic', 'color/basic', 'date/basic', 'date/datetime', 'date/range-tz',
        'email/basic', 'link/basic', 'number/basic', 'page/basic', 'picture/basic', 'radio/basic', 'richtext/md',
        'select/basic', 'switch/basic', 'tel/basic', 'text/basic', 'text/title', 'textarea/basic', 'time/basic', 'url/basic',
      ].map((name) => `snippets/pagefield/${name}.liquid`),
    ];
    const sources = await Promise.all(viewPaths.map(async (path) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/${path}`);
      expect(response.ok).toBe(true);
      return response.text();
    }));
    const usedKeys = sources.flatMap((source) => [
      ...source.matchAll(/["']([a-z0-9_.:-]+)["']\s*\|\s*t\b/gi),
    ].map((match) => match[1]));

    expect(usedKeys.length).toBeGreaterThan(0);
    expect(usedKeys.filter((key) => !(key in english))).toEqual([]);

    const generatedKeys = [
      ...APP_ICON_OPTIONS.map((option) => `settings.icons.${option.value}`),
      ...SIDEBAR_MENU_ITEMS.flatMap((item) => [`nav.${item.key}`, `settings.menu.${item.key}_description`]),
      ...['active', 'unreachable', 'disabled'].map((status) => `plugins.status.${status}`),
      ...['enable', 'disable'].map((action) => `plugins.actions.${action}`),
      ...USER_ROLES.map((role) => `roles.names.${role}`),
      ...['admin', 'builtin', 'custom'].map((type) => `roles.types.${type}`),
      ...['on_create', 'metered_per', 'free', 'per_second', 'per_parent_page', 'per', 'total', 'unlimited']
        .map((key) => `credits.summary.${key}`),
      // Wallet strings are chosen per currency in src/features/credits/, so
      // the views reference them through variables rather than literals.
      ...['credit', 'diamond'].flatMap((currency) => [
        `credits.currency.${currency}`,
        `credits.unit.${currency}`,
        `credits.currency_description.${currency}`,
      ]),
    ];
    expect(generatedKeys.filter((key) => !(key in english))).toEqual([]);
  });

  it('translates the page-list bulk controls in both Chinese locales', async () => {
    const [simplified, traditional] = await Promise.all(['zh-hans', 'zh-hant'].map(async (locale) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/locales/${locale}.json`);
      return flattenMessages(await response.json());
    }));

    expect(simplified['view_strings.shared_bulk_actions.move_to_trash']).toBe('移至回收站');
    expect(simplified['view_strings.shared_bulk_actions.apply_to']).toBe('应用于');
    expect(simplified['view_strings.shared_bulk_actions.add_tags']).toBe('添加索引');
    expect(simplified['view_strings.shared_bulk_actions.remove_tags']).toBe('移除索引');
    expect(simplified['view_strings.shared_bulk_actions.tags_to_remove']).toBe('要移除的索引');
    expect(simplified['view_strings.shared_bulk_actions.replace_text']).toBe('搜索并替换文本');
    expect(simplified['view_strings.sections_dashboard.all_matching_pages']).toBe('所有匹配页面');
    expect(traditional['view_strings.shared_bulk_actions.move_to_trash']).toBe('移至回收站');
    expect(traditional['view_strings.shared_bulk_actions.apply_to']).toBe('套用至');
    expect(traditional['view_strings.shared_bulk_actions.add_tags']).toBe('新增索引');
    expect(traditional['view_strings.shared_bulk_actions.remove_tags']).toBe('移除索引');
    expect(traditional['view_strings.shared_bulk_actions.tags_to_remove']).toBe('要移除的索引');
    expect(traditional['view_strings.shared_bulk_actions.replace_text']).toBe('搜尋並取代文字');
    expect(traditional['view_strings.sections_dashboard.all_matching_pages']).toBe('所有相符頁面');
  });

  it('translates flash message keys across core admin sections', async () => {
    const paths = [
      'sections/dashboard.liquid',
      'sections/editor.liquid',
      'sections/languages.liquid',
      'sections/translations.liquid',
      'sections/trash.liquid',
      'sections/user-form.liquid',
      'sections/users.liquid',
    ];
    const sources = await Promise.all(paths.map(async (path) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/${path}`);
      expect(response.ok).toBe(true);
      return response.text();
    }));
    expect(sources.every((source) => source.includes('{{ flash | t }}'))).toBe(true);
  });

  it('rejects Liquid syntax in database messages', async () => {
    await expect(saveLocaleMessage(cmsEnv, 'en', 'unsafe.label', '{{ user.name }}')).rejects.toThrow('plain text');
  });
});
