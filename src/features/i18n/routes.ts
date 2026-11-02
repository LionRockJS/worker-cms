import { mutateLocaleAdmin,LocaleMutationUnavailableError } from './mutation-evidence';
import { LocaleInputValidationError } from '../../core/i18n';
import type { AppContext } from '../../core/http/context';
// Language and translation administration: which locales exist, which are
// enabled for content and for the UI, and per-locale message overrides.
//
// Extracted from routes/admin/settings.ts. Serving the catalog stays core
// (routes/admin/i18n-catalog.ts) — only editing is optional.

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { requirePermission } from '../../core/auth/guards';
import { renderPage } from '../../core/render/chrome';
import { languagesPage, translationsPage, type LocaleViewRow } from './template';
import {
  listLocaleMessages,
  listLocales,
  localeRegistry,
  loadBundledLocaleCatalog,
} from '../../core/i18n';

export const i18nRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
i18nRoutes.onError((error,c)=>{if(error instanceof LocaleMutationUnavailableError)return c.json({error:'locale_change_unavailable'},503,{'Cache-Control':'no-store'});throw error;});

function validationRedirect(c:AppContext,error:unknown,href:string):Response {
  if(error instanceof LocaleInputValidationError)return c.redirect(`${href}${href.includes('?')?'&':'?'}error=${encodeURIComponent(error.message)}`,303);
  throw error;
}

i18nRoutes.use('/settings/languages', requirePermission('menu:manage'));
i18nRoutes.use('/settings/languages/*', requirePermission('menu:manage'));
i18nRoutes.use('/settings/translations', requirePermission('menu:manage'));
i18nRoutes.use('/settings/translations/*', requirePermission('menu:manage'));

function message(value: string | undefined): string {
  return value ? value.slice(0, 300) : '';
}

i18nRoutes.get('/settings/languages', async (c) => {
  const registry = await localeRegistry(c.env);
  const locales = registry.locales;
  const rows: LocaleViewRow[] = locales.map((locale) => ({
    code: locale.code,
    label: locale.label,
    contentEnabled: locale.content_enabled === 1,
    uiEnabled: locale.ui_enabled === 1,
    isDefault: locale.code === registry.defaultContentLanguage,
    direction: locale.direction,
    fallbackCode: locale.fallback_code ?? '',
    weight: locale.weight,
    builtin: locale.builtin === 1,
    protected: locale.code === 'mis',
    updateAction: `/admin/settings/languages/${encodeURIComponent(locale.code)}`,
    deleteAction: `/admin/settings/languages/${encodeURIComponent(locale.code)}/delete`,
    translationsHref: `/admin/settings/translations?locale=${encodeURIComponent(locale.code)}`,
    fallbackOptions: locales.filter((option) => option.code !== locale.code).map((option) => ({
      code: option.code,
      label: `${option.label} (${option.code})`,
      selected: option.code === locale.fallback_code,
    })),
  }));
  return renderPage(c, languagesPage, {
    locales: rows,
    defaultLanguage: registry.defaultContentLanguage,
    defaultLanguageOptions: locales
      .filter((locale) => locale.content_enabled === 1)
      .map((locale) => ({
        code: locale.code,
        label: locale.label,
        selected: locale.code === registry.defaultContentLanguage,
      })),
    flash: message(c.req.query('flash')),
    error: message(c.req.query('error')),
  });
});

i18nRoutes.post('/settings/languages/default', async (c) => {
  const form = await c.req.formData();
  try {
    await mutateLocaleAdmin(c,{action:'default',code:form.get('default_language')});
    return c.redirect('/admin/settings/languages?flash=Default+language+saved', 303);
  } catch (error) {
    return validationRedirect(c,error,'/admin/settings/languages');
  }
});

i18nRoutes.post('/settings/languages', async (c) => {
  const form = await c.req.formData();
  try {
    await mutateLocaleAdmin(c,{action:'create',input:Object.fromEntries(form)});
    return c.redirect('/admin/settings/languages?flash=Language+added', 303);
  } catch (error) {
    return validationRedirect(c,error,'/admin/settings/languages');
  }
});

i18nRoutes.post('/settings/languages/:code', async (c) => {
  const form = await c.req.formData();
  try {
    await mutateLocaleAdmin(c,{action:'update',input:Object.fromEntries(form),code:c.req.param('code')});
    return c.redirect('/admin/settings/languages?flash=Language+saved', 303);
  } catch (error) {
    return validationRedirect(c,error,'/admin/settings/languages');
  }
});

i18nRoutes.post('/settings/languages/:code/delete', async (c) => {
  try {
    await mutateLocaleAdmin(c,{action:'delete',code:c.req.param('code')});
    return c.redirect('/admin/settings/languages?flash=Language+deleted', 303);
  } catch (error) {
    return validationRedirect(c,error,'/admin/settings/languages');
  }
});

i18nRoutes.get('/settings/translations', async (c) => {
  const locales = await listLocales(c.env);
  const requested = c.req.query('locale') ?? 'en';
  const selected = locales.find((locale) => locale.code === requested) ?? locales.find((locale) => locale.code === 'en') ?? locales[0];
  if (!selected) return c.notFound();
  const [messages, bundledMessages] = await Promise.all([
    listLocaleMessages(c.env, selected.code),
    loadBundledLocaleCatalog(c.env, selected.code),
  ]);
  const overrides = new Map(messages.map((entry) => [entry.message_key, entry]));
  const messageKeys = [...new Set([...Object.keys(bundledMessages), ...overrides.keys()])].sort();
  return renderPage(c, translationsPage, {
    localeCode: selected.code,
    localeLabel: selected.label,
    localeOptions: locales.map((locale) => ({ code: locale.code, label: locale.label, selected: locale.code === selected.code })),
    messages: messageKeys.map((key) => {
      const override = overrides.get(key);
      return {
        key,
        fileValue: bundledMessages[key] ?? '',
        hasFileValue: key in bundledMessages,
        overrideValue: override?.value ?? '',
        hasOverride: !!override,
        deleteAction: override
          ? `/admin/settings/translations/${encodeURIComponent(selected.code)}/${encodeURIComponent(key)}/delete`
          : '',
      };
    }),
    flash: message(c.req.query('flash')),
    error: message(c.req.query('error')),
  });
});

i18nRoutes.post('/settings/translations', async (c) => {
  const form = await c.req.formData();
  const locale = String(form.get('locale') ?? 'en');
  try {
    await mutateLocaleAdmin(c,{action:'message-save',code:locale,key:form.get('key'),value:form.get('value')});
    return c.redirect(`/admin/settings/translations?locale=${encodeURIComponent(locale)}&flash=Translation+saved`, 303);
  } catch (error) {
    return validationRedirect(c,error,`/admin/settings/translations?locale=${encodeURIComponent(locale)}`);
  }
});

i18nRoutes.post('/settings/translations/:locale/:key/delete', async (c) => {
  const requested = c.req.param('locale');
  try {
    const locale = await mutateLocaleAdmin(c,{action:'message-delete',code:requested,key:c.req.param('key')});
    return c.redirect(`/admin/settings/translations?locale=${encodeURIComponent(locale)}&flash=Translation+deleted`, 303);
  } catch(error) {
    return validationRedirect(c,error,`/admin/settings/translations?locale=${encodeURIComponent(requested)}`);
  }
});
