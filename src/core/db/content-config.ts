// ============================================================
// Effective CMS config = static base (cms-config.ts) merged with
// content types contributed by active plugins.
//
// Plugins extend content types; the database locale registry extends the
// content-language list and supplies the persisted site-level default.
// ============================================================

import { cmsConfig } from '../../cms-config';
import type { CmsConfig } from '../../cms-config';
import { coreExtensions } from '../extensions';
import {
  applyPageTypeExtensions,
  dbPageTypeToContentTypes,
  listDbPageTypes,
  loadPageTypeExtensions,
} from './page-type-store';
import { dbBlockTypeToContentTypes, listDbBlockTypes } from './block-type-store';
import type { Env } from '../../types';
import type { ContributedContentTypes as PluginContentTypes } from '../extensions';
import { CONTENT_DEFAULT_LANGUAGE_SETTING_KEY, localeRegistry } from '../i18n';
import { recordContributorReads, recordMetadataReads } from '../http/access-log';
import { PAGE_TYPE_EXTENSIONS_SETTING_KEY } from './page-type-store';

const CONFIG_TTL_MS = 60_000;
interface ConfigSnapshot {
  config: CmsConfig;
  expires: number;
  sources: { table: string; ids: (string | number)[] }[];
  contributors: string[];
}
let cached: ConfigSnapshot | null = null;

function announceSnapshot(snapshot: ConfigSnapshot): void {
  for (const source of snapshot.sources) {
    if (!source.ids.length) continue;
    const action = source.table === 'settings' ? 'settings.read' : source.table === 'locales' ? 'locale.read' : 'schema.config-read';
    recordMetadataReads(action, source.table, source.ids);
  }
  recordContributorReads('plugin.config-metadata-read', snapshot.contributors);
}

function mergeContentTypes(base: CmsConfig, fragment: PluginContentTypes | undefined): void {
  if (!fragment) return;
  safeAssign(base.blueprint, fragment.blueprint);
  safeAssign(base.blocks, fragment.blocks);
  safeAssign(base.blockLists, fragment.blockLists);
  safeAssign(base.taxonomies, fragment.taxonomies);
  safeAssign(base.taxonomyLists, fragment.taxonomyLists);
}

function safeAssign<T>(target: Record<string, T>, source: Record<string, T> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    target[key] = value;
  }
}

/**
 * Returns the CmsConfig with plugin- and database-contributed content types
 * merged in, layered base → plugins → database (so a DB page type can override
 * a plugin or config type). Falls back to the static base when neither source
 * contributes anything, keeping the zero-config path unchanged. Cached per
 * isolate with a short TTL.
 */
export async function resolveCmsConfig(env: Env): Promise<CmsConfig> {
  if (cached && cached.expires > Date.now()) { announceSnapshot(cached); return cached.config; }

  const contributed = await coreExtensions().contentTypes?.(env) ?? [];
  const [dbPageTypes, dbBlockTypes, registry, extensions] = env.DB
    ? await Promise.all([
        listDbPageTypes(env.DB),
        listDbBlockTypes(env.DB),
        localeRegistry(env),
        loadPageTypeExtensions(env),
      ])
    : [[], [], { contentLanguages: cmsConfig.languages, defaultContentLanguage: cmsConfig.defaultLanguage }, {}];

  // Shallow-clone the mutable record fields so we never mutate the base.
  const merged: CmsConfig = {
    defaultLanguage: registry.defaultContentLanguage,
    languages: registry.contentLanguages.length ? registry.contentLanguages : cmsConfig.languages,
    blueprint: { ...cmsConfig.blueprint },
    blocks: { ...cmsConfig.blocks },
    blockLists: { ...cmsConfig.blockLists },
    taxonomies: { ...cmsConfig.taxonomies },
    taxonomyLists: { ...cmsConfig.taxonomyLists },
  };

  for (const fragment of contributed) {
    mergeContentTypes(merged, fragment);
  }

  for (const pageType of dbPageTypes) {
    mergeContentTypes(merged, dbPageTypeToContentTypes(pageType));
  }

  for (const blockType of dbBlockTypes) {
    mergeContentTypes(merged, dbBlockTypeToContentTypes(blockType));
  }

  // Last: extensions ADD to (never replace) whatever the layers above produced.
  applyPageTypeExtensions(merged, extensions);

  cached = { config: merged, expires: Date.now() + CONFIG_TTL_MS,
    sources: [
      { table: 'page_types', ids: dbPageTypes.map(row => row.id) },
      { table: 'block_types', ids: dbBlockTypes.map(row => row.id) },
      { table: 'locales', ids: 'locales' in registry ? registry.locales.map(row => row.code) : [] },
      { table: 'settings', ids: [CONTENT_DEFAULT_LANGUAGE_SETTING_KEY, PAGE_TYPE_EXTENSIONS_SETTING_KEY] },
    ],
    contributors: contributed.flatMap(fragment => fragment.auditContributorId ? [fragment.auditContributorId] : []),
  };
  announceSnapshot(cached);
  return merged;
}

/** Test/dev helper — clears the per-isolate merged-config cache. */
export function clearConfigCache(): void {
  cached = null;
}
