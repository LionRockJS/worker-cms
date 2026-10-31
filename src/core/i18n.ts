import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env } from '../types';
import { getSetting, saveSetting } from './db/settings';
import { coreExtensions } from './extensions';
import { recordMetadataReads } from './http/access-log';

export const DEFAULT_CONTENT_LANGUAGE = 'mis';
export const CONTENT_DEFAULT_LANGUAGE_SETTING_KEY = 'content.default_language';
export const DEFAULT_UI_LOCALE = 'en';
export const UI_LOCALE_COOKIE = 'cms_ui_locale';

const LOCALE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const MESSAGE_KEY = /^[a-z0-9][a-z0-9_.:-]{0,199}$/i;

export interface LocaleRecord {
  code: string;
  label: string;
  content_enabled: number;
  ui_enabled: number;
  direction: 'ltr' | 'rtl';
  fallback_code: string | null;
  weight: number;
  builtin: number;
  created_at: string;
  updated_at: string;
}

export interface LocaleMessage {
  locale_code: string;
  message_key: string;
  value: string;
  updated_at: string;
}

export function normalizeLocaleCode(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!LOCALE_CODE.test(code)) throw new Error('Locale code must be a valid lowercase BCP 47 language tag');
  return code;
}

export async function listLocales(env: Env): Promise<LocaleRecord[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM locales ORDER BY weight ASC, label COLLATE NOCASE ASC, code ASC',
  ).all<LocaleRecord>();
  recordMetadataReads('locale.read', 'locales', result.results.map(row => row.code));
  return result.results;
}

export async function localeRegistry(env: Env): Promise<{
  locales: LocaleRecord[];
  contentLanguages: string[];
  defaultContentLanguage: string;
  uiLocales: LocaleRecord[];
}> {
  const locales = await listLocales(env);
  const contentLanguages = locales.filter((locale) => locale.content_enabled === 1).map((locale) => locale.code);
  return {
    locales,
    contentLanguages,
    defaultContentLanguage: await loadDefaultContentLanguage(env, locales),
    uiLocales: locales.filter((locale) => locale.ui_enabled === 1),
  };
}

export async function loadDefaultContentLanguage(env: Env, locales?: LocaleRecord[]): Promise<string> {
  const available = locales ?? await listLocales(env);
  const contentLocales = available.filter((locale) => locale.content_enabled === 1);
  const configured = (await getSetting(env, CONTENT_DEFAULT_LANGUAGE_SETTING_KEY))?.trim().toLowerCase();
  return contentLocales.find((locale) => locale.code === configured)?.code
    ?? contentLocales.find((locale) => locale.code === DEFAULT_CONTENT_LANGUAGE)?.code
    ?? contentLocales[0]?.code
    ?? DEFAULT_CONTENT_LANGUAGE;
}

export async function saveDefaultContentLanguage(env: Env, codeValue: unknown): Promise<string> {
  const code = normalizeLocaleCode(codeValue);
  const locale = await env.DB.prepare(
    'SELECT code FROM locales WHERE code = ? AND content_enabled = 1',
  ).bind(code).first<{ code: string }>();
  if (!locale) throw new Error('The default content language must be enabled for content');
  await saveSetting(env, CONTENT_DEFAULT_LANGUAGE_SETTING_KEY, code);
  return code;
}

export async function saveLocale(env: Env, input: Record<string, unknown>, existingCode?: string): Promise<string> {
  const code = normalizeLocaleCode(existingCode ?? input.code);
  const label = String(input.label ?? '').trim().slice(0, 100);
  if (!label) throw new Error('Language label is required');
  const currentDefault = await loadDefaultContentLanguage(env);
  const contentEnabled = code === currentDefault ? 1 : truthy(input.content_enabled);
  const uiEnabled = code === DEFAULT_CONTENT_LANGUAGE ? 0 : truthy(input.ui_enabled);
  const direction = input.direction === 'rtl' ? 'rtl' : 'ltr';
  const fallback = input.fallback_code ? normalizeLocaleCode(input.fallback_code) : null;
  if (fallback === code) throw new Error('A locale cannot fall back to itself');
  const weight = finiteInteger(input.weight);

  if (existingCode && uiEnabled === 0) {
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM locales WHERE ui_enabled = 1 AND code != ?',
    ).bind(code).first<{ total: number }>();
    if ((remaining?.total ?? 0) === 0) throw new Error('At least one CMS interface locale must remain enabled');
  }

  if (existingCode) {
    await env.DB.prepare(
      `UPDATE locales SET label = ?, content_enabled = ?, ui_enabled = ?, direction = ?, fallback_code = ?, weight = ?
       WHERE code = ?`,
    ).bind(label, contentEnabled, uiEnabled, direction, fallback, weight, code).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO locales (code, label, content_enabled, ui_enabled, direction, fallback_code, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(code, label, contentEnabled, uiEnabled, direction, fallback, weight).run();
  }
  return code;
}

export async function deleteLocale(env: Env, codeValue: unknown): Promise<void> {
  const code = normalizeLocaleCode(codeValue);
  if (code === DEFAULT_CONTENT_LANGUAGE) throw new Error('The unspecified content language cannot be deleted');
  if (code === await loadDefaultContentLanguage(env)) throw new Error('The default content language cannot be deleted');
  const row = await env.DB.prepare('SELECT builtin FROM locales WHERE code = ?').bind(code).first<{ builtin: number }>();
  if (row?.builtin) throw new Error('Built-in locales cannot be deleted');
  await env.DB.prepare('DELETE FROM locales WHERE code = ?').bind(code).run();
}

export async function listLocaleMessages(env: Env, localeCode: unknown): Promise<LocaleMessage[]> {
  const code = normalizeLocaleCode(localeCode);
  const result = await env.DB.prepare(
    'SELECT locale_code, message_key, value, updated_at FROM locale_messages WHERE locale_code = ? ORDER BY message_key ASC',
  ).bind(code).all<LocaleMessage>();
  recordMetadataReads('translation.read', 'locale_messages', result.results.map(row => `${row.locale_code}:${row.message_key}`));
  return result.results;
}

export async function saveLocaleMessage(
  env: Env,
  localeCode: unknown,
  keyValue: unknown,
  messageValue: unknown,
  updatedBy?: string,
): Promise<void> {
  const code = normalizeLocaleCode(localeCode);
  const key = String(keyValue ?? '').trim();
  const value = String(messageValue ?? '').trim().slice(0, 4000);
  if (!MESSAGE_KEY.test(key)) throw new Error('Translation key contains unsupported characters');
  if (!value) throw new Error('Translation value is required');
  if (value.includes('{{') || value.includes('{%') || /[<>]/.test(value)) {
    throw new Error('Translation values must be plain text');
  }
  await env.DB.prepare(
    `INSERT INTO locale_messages (locale_code, message_key, value, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(locale_code, message_key) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  ).bind(code, key, value, updatedBy ?? null).run();
}

export async function deleteLocaleMessage(env: Env, localeCode: unknown, keyValue: unknown): Promise<void> {
  const code = normalizeLocaleCode(localeCode);
  const key = String(keyValue ?? '').trim();
  await env.DB.prepare('DELETE FROM locale_messages WHERE locale_code = ? AND message_key = ?').bind(code, key).run();
}

export async function resolveUiLocale(c: Context<any>): Promise<LocaleRecord> {
  const { uiLocales } = await localeRegistry(c.env);
  const fallback = uiLocales.find((locale) => locale.code === DEFAULT_UI_LOCALE) ?? uiLocales[0];
  if (!fallback) throw new Error('At least one UI locale must be enabled');
  const cookie = getCookie(c, UI_LOCALE_COOKIE);
  const requested = [cookie, ...acceptLanguages(c.req.header('Accept-Language'))].filter(Boolean) as string[];
  for (const value of requested) {
    const normalized = value.toLowerCase().replace(/_/g, '-');
    const exact = uiLocales.find((locale) => locale.code === normalized);
    if (exact) return exact;
    const base = normalized.split('-')[0];
    const related = uiLocales.find((locale) => locale.code === base || locale.code.startsWith(`${base}-`));
    if (related) return related;
  }
  return fallback;
}

export function setUiLocaleCookie(c: Context, locale: string): void {
  setCookie(c, UI_LOCALE_COOKIE, locale, {
    path: '/', sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', maxAge: 31_536_000,
  });
}

export async function buildTranslationCatalog(
  env: Env,
  requestedCode: unknown,
  includePluginCatalogs = false,
): Promise<Record<string, string>> {
  const code = normalizeLocaleCode(requestedCode);
  const locales = await listLocales(env);
  const selected = locales.find((locale) => locale.code === code && locale.ui_enabled === 1)
    ?? locales.find((locale) => locale.code === DEFAULT_UI_LOCALE && locale.ui_enabled === 1);
  if (!selected) throw new Error('UI locale is not enabled');

  const chain: string[] = [];
  const visited = new Set<string>();
  let current: LocaleRecord | undefined = selected;
  while (current && !visited.has(current.code)) {
    chain.unshift(current.code);
    visited.add(current.code);
    current = current.fallback_code ? locales.find((locale) => locale.code === current?.fallback_code) : undefined;
  }
  if (!chain.includes(DEFAULT_UI_LOCALE)) chain.unshift(DEFAULT_UI_LOCALE);

  const catalog: Record<string, string> = {};
  for (const localeCode of chain) {
    // Contributed strings go in first so a CMS string, and then a database
    // override, always wins over them.
    if (includePluginCatalogs) {
      Object.assign(catalog, await coreExtensions().localeCatalog?.(env, localeCode) ?? {});
    }
    Object.assign(catalog, await bundledCatalog(env, localeCode));
    const messages = await listLocaleMessages(env, localeCode);
    for (const message of messages) catalog[message.message_key] = message.value;
  }
  return catalog;
}

/** Loads only the strings bundled in a core locale JSON file, without fallbacks or database overrides. */
export async function loadBundledLocaleCatalog(env: Env, localeCode: unknown): Promise<Record<string, string>> {
  return bundledCatalog(env, normalizeLocaleCode(localeCode));
}

/** Looks up a UI string in the merged catalog, falling back to the given English text. */
export type UiTranslator = (key: string, fallback: string) => string;

/**
 * Server-side counterpart of the client `| t` filter, for templates that build
 * HTML strings in the Worker (e.g. the read-only page view) instead of
 * rendering Liquid client-side.
 */
export async function uiTranslator(c: Context<any>): Promise<UiTranslator> {
  const locale = await resolveUiLocale(c);
  const catalog = await buildTranslationCatalog(c.env, locale.code);
  return (key, fallback) => catalog[key] ?? fallback;
}

async function bundledCatalog(env: Env, code: string): Promise<Record<string, string>> {
  const response = await env.VIEWS.fetch(`https://views.local/locales/${encodeURIComponent(code)}.json`);
  if (!response.ok) return {};
  try {
    return flattenMessages(await response.json());
  } catch {
    return {};
  }
}

export function flattenMessages(value: unknown, prefix = '', output: Record<string, string> = {}): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output[path] = child;
    else flattenMessages(child, path, output);
  }
  return output;
}

function truthy(value: unknown): number {
  return value === true || value === '1' || value === 'on' ? 1 : 0;
}

function finiteInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function acceptLanguages(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean);
}
