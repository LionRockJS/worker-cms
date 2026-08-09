// ============================================================
// Plugin registry — resolves active plugins from the `plugins` D1 table
// (URL transport) and fetches/caches their manifests.
//
// Each plugin is a standalone Worker reached over HTTPS at its registered
// base URL: the CMS calls `{url}/__plugin/...`. Plugins are added/enabled
// from the admin UI (plugin:manage) with no CMS redeploy.
// ============================================================

import type { Env } from '../../types';
import type { PluginHookEvent, PluginManifest, ResolvedPlugin, PluginRecord } from './types';
import { listEnabledPlugins } from './store';

/** Reserved prefix every plugin Worker serves its CMS-facing endpoints under. */
export const PLUGIN_PREFIX = '/__plugin';

/** Synthetic origin call sites use; the URL fetcher rewrites it to the real base. */
export const PLUGIN_ORIGIN = 'https://plugin.local';

// Manifests rarely change between deploys; cache per isolate with a short TTL.
const MANIFEST_TTL_MS = 60_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const TENANT_VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const RESERVED_TENANT_VARS = new Set([
  'CMS_URL',
  'PLUGIN_SECRET',
  'SIGN_KEY',
  'PUBLIC_BASE_URL',
  'CMS_TENANT_ID',
  'CMS_TENANT_REF',
  'CMS_TENANT_LEGACY',
  'TENANTS',
]);
const manifestCache = new Map<string, { manifest: PluginManifest; expires: number }>();

// The enabled-plugins list also changes rarely; cache it so we don't hit D1 on
// every request. Invalidated by clearManifestCache() after admin mutations.
const PLUGINS_TTL_MS = 30_000;
let pluginsCache: { records: PluginRecord[]; expires: number } | null = null;

async function activePluginRecords(env: Env): Promise<PluginRecord[]> {
  if (pluginsCache && pluginsCache.expires > Date.now()) return pluginsCache.records;
  if (!env.DB) return [];
  const records = await listEnabledPlugins(env.DB);
  pluginsCache = { records, expires: Date.now() + PLUGINS_TTL_MS };
  return records;
}

/**
 * Fetcher that rewrites synthetic `PLUGIN_ORIGIN` URLs to a plugin's real base
 * URL, so every existing call site (`fetcher.fetch(`${PLUGIN_ORIGIN}/__plugin/...`)`)
 * works unchanged whether the path came from a string, URL, or Request.
 */
function urlFetcher(baseUrl: string): Fetcher {
  const base = baseUrl.replace(/\/+$/, '');
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
    const { pathname, search } = new URL(href);
    // Never follow redirects server-side: the SSRF guard validates the
    // registered URL only, so a redirecting plugin could otherwise bounce the
    // request (and its secret headers) to a host that was never vetted.
    return globalThis.fetch(`${base}${pathname}${search}`, { ...init, redirect: 'manual' });
  };
  return { fetch } as unknown as Fetcher;
}

// Test seam: route specific plugin base URLs to in-process fetchers instead of
// globalThis.fetch. Empty (and zero-cost) in production.
const injectedFetchers = new Map<string, Fetcher>();
function fetcherForUrl(url: string): Fetcher {
  return injectedFetchers.get(url.replace(/\/+$/, '')) ?? urlFetcher(url);
}
/** @internal test-only — map a plugin URL to an in-process fetcher (null clears it). */
export function __injectPluginFetcher(url: string, fetcher: Fetcher | null): void {
  const key = url.replace(/\/+$/, '');
  if (fetcher) injectedFetchers.set(key, fetcher);
  else injectedFetchers.delete(key);
}
/** @internal test-only — clears all injected fetchers. */
export function __clearInjectedFetchers(): void {
  injectedFetchers.clear();
}

async function loadManifest(url: string, fetcher: Fetcher): Promise<PluginManifest | null> {
  const cached = manifestCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.manifest;

  try {
    const response = await fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/manifest`);
    if (!response.ok) {
      console.error(`Plugin ${url} manifest returned ${response.status}`);
      return null;
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      console.error(`Plugin ${url} manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
      return null;
    }
    const text = await readLimitedText(response, MAX_MANIFEST_BYTES);
    const candidate = JSON.parse(text) as unknown;
    if (!isPluginManifest(candidate)) {
      console.error(`Plugin ${url} returned an invalid manifest`);
      return null;
    }
    const manifest = candidate;
    manifestCache.set(url, { manifest, expires: Date.now() + MANIFEST_TTL_MS });
    return manifest;
  } catch (error) {
    console.error(`Plugin ${url} manifest fetch failed:`, error);
    return null;
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel('manifest too large');
      throw new Error(`manifest exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isPluginManifest(value: unknown): value is PluginManifest {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)) return false;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) return false;
  if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 100) return false;
  if (value.i18n !== undefined && typeof value.i18n !== 'boolean') return false;
  if (value.autoTenant !== undefined && typeof value.autoTenant !== 'boolean') return false;
  if (value.auto_tenant !== undefined && typeof value.auto_tenant !== 'boolean') return false;
  for (const key of ['tenantVars', 'tenant_vars']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > 64) return false;
    const vars = value[key] as unknown[];
    if (new Set(vars).size !== vars.length) return false;
    if (vars.some((name) => (
      typeof name !== 'string'
      || !TENANT_VAR_NAME.test(name)
      || RESERVED_TENANT_VARS.has(name)
    ))) return false;
  }

  const arrayFields = [
    'hooks', 'autoPublishTypes', 'nav', 'fieldTypes', 'editViews', 'newViews',
    'readViews', 'permissions', 'assets', 'limits', 'credits',
  ];
  if (arrayFields.some((key) => value[key] !== undefined && !Array.isArray(value[key]))) return false;

  if (value.contentTypes !== undefined) {
    if (!isRecord(value.contentTypes)) return false;
    const contentTypes = value.contentTypes;
    for (const key of ['blueprint', 'blocks', 'blockLists', 'publishLect', 'taxonomies', 'taxonomyLists']) {
      if (contentTypes[key] !== undefined && !isRecord(contentTypes[key])) return false;
    }
    for (const key of ['readTypes', 'writeTypes']) {
      if (contentTypes[key] !== undefined && !Array.isArray(contentTypes[key])) return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Resolves every active plugin (enabled row + manifest reachable). */
export async function getPlugins(env: Env): Promise<ResolvedPlugin[]> {
  const records = await activePluginRecords(env);
  const resolved = await Promise.all(
    records.map(async (record): Promise<ResolvedPlugin | null> => {
      const fetcher = fetcherForUrl(record.url);
      const manifest = await loadManifest(record.url, fetcher);
      if (!manifest) return null;
      // Legacy rows may keep the env fallback for outbound CMS → plugin calls,
      // but inbound /__cms authentication is deliberately per-plugin only.
      const apiSecret = record.secret || '';
      const secret = apiSecret || env.PLUGIN_SECRET || '';
      return { binding: record.url, fetcher, manifest, secret, apiSecret, label: record.label || '' };
    }),
  );
  return resolved.filter((plugin): plugin is ResolvedPlugin => plugin !== null);
}

/** Nav items contributed by all plugins, flattened with their plugin id. */
export async function pluginNav(env: Env): Promise<Array<{ pluginId: string; label: string; href: string; roles?: string[]; group?: 'settings'; i18n: boolean }>> {
  const plugins = await getPlugins(env);
  return plugins.flatMap((plugin) => {
    const items = plugin.manifest.nav ?? [];
    // The admin-entered plugin label (Plugins → edit → Label) overrides the
    // manifest's sidebar text — but only when the plugin contributes a single
    // nav entry: with several entries, one label cannot disambiguate them, so
    // they keep their manifest labels.
    const override = items.length === 1 ? (plugin.label ?? '').trim() : '';
    return items.map((item) => ({
      pluginId: plugin.manifest.id,
      label: override || item.label,
      href: `/admin/plugins/${plugin.manifest.id}/${item.href.replace(/^\/+/, '')}`,
      roles: item.roles,
      group: item.group,
      // Nav labels are only looked up in the translation catalog for plugins
      // that ship one (manifest `i18n: true`); others render their manifest
      // label directly instead of missing a key that can never resolve.
      i18n: plugin.manifest.i18n === true,
    }));
  });
}

/** Finds the plugin that renders the edit view for a given page type, if any. */
export async function pluginForEditView(env: Env, pageType: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => (plugin.manifest.editViews ?? []).includes(pageType)) ?? null;
}

/** Finds the plugin that renders the create/new view for a given page type, if any. */
export async function pluginForNewView(env: Env, pageType: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => (plugin.manifest.newViews ?? []).includes(pageType))
    ?? plugins.find((plugin) => (plugin.manifest.editViews ?? []).includes(pageType))
    ?? null;
}

/** Finds the plugin that renders the read-only view for a given page type, if any. */
export async function pluginForReadView(env: Env, pageType: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => (plugin.manifest.readViews ?? []).includes(pageType)) ?? null;
}

/** True when the plugin that owns a page type requests save-time republishing. */
export async function pluginAutoPublishesPageType(env: Env, pageType: string): Promise<boolean> {
  const plugins = await getPlugins(env);
  return plugins.some((plugin) => (
    Object.hasOwn(plugin.manifest.contentTypes?.blueprint ?? {}, pageType)
    && (plugin.manifest.autoPublishTypes ?? []).includes(pageType)
  ));
}

/** Resolves a plugin by its manifest id (used by the admin proxy). */
export async function pluginById(env: Env, id: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => plugin.manifest.id === id) ?? null;
}

/** Plugins that subscribe to a given lifecycle event. */
export async function pluginsForHook(env: Env, event: PluginHookEvent): Promise<ResolvedPlugin[]> {
  const plugins = await getPlugins(env);
  return plugins.filter((plugin) => (plugin.manifest.hooks ?? []).includes(event));
}

/** All permissions declared by active plugins, deduplicated by value. */
export async function allPluginPermissions(env: Env): Promise<Array<{ value: string; label: string }>> {
  const plugins = await getPlugins(env);
  const seen = new Set<string>();
  const result: Array<{ value: string; label: string }> = [];
  for (const plugin of plugins) {
    for (const perm of plugin.manifest.permissions ?? []) {
      if (!seen.has(perm.value)) {
        seen.add(perm.value);
        result.push(perm);
      }
    }
  }
  return result;
}

/** Clears the per-isolate manifest + plugin-list caches (after admin mutations / in tests). */
export function clearManifestCache(): void {
  manifestCache.clear();
  pluginsCache = null;
}
