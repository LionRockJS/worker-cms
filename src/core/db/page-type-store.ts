// ============================================================
// Database-defined page types.
//
// A row in `page_types` is the runtime-editable equivalent of a
// plugin content-type fragment: it is converted into the same
// ContributedContentTypes shape and merged into the effective CmsConfig
// by resolveCmsConfig() (src/core/db/content-config.ts).
// ============================================================

import type { BlueprintEntry, CmsConfig } from '../../cms-config';
import type { Env, PageType } from '../../types';
import type { ContributedContentTypes } from '../extensions';
import { getSetting } from './settings';

/** Loads database-defined page types, including retained rows in disabled profiles. */
export async function listDbPageTypes(db: D1DatabaseClient): Promise<PageType[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM page_types ORDER BY weight ASC, name ASC')
      .all<PageType>();
    return results;
  } catch (error) {
    // Fresh profiles without runtime content types omit this table.
    if (error instanceof Error && /no such table: page_types(?:[:\s]|$)/i.test(error.message)) return [];
    throw error;
  }
}

/** Parses a JSON column into the expected shape, or returns the fallback. */
function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * Converts a page_types row into a content-type fragment keyed by its slug,
 * so it can flow through the same mergeContentTypes() path as plugin fragments.
 * Malformed JSON is treated as empty rather than throwing.
 */
export function dbPageTypeToContentTypes(row: PageType): ContributedContentTypes {
  const fragment: ContributedContentTypes = {
    blueprint: { [row.slug]: parseJson<BlueprintEntry[]>(row.blueprint, []) },
  };

  const blockLists = parseJson<string[]>(row.block_lists, []);
  if (blockLists.length > 0) fragment.blockLists = { [row.slug]: blockLists };

  const taxonomyLists = parseJson<string[]>(row.taxonomy_lists, []);
  if (taxonomyLists.length > 0) fragment.taxonomyLists = { [row.slug]: taxonomyLists };

  return fragment;
}

// ── Page-type extensions ──────────────────────────────────────────────────────
// Site-added blocks/taxonomies for read-only (config-file or plugin) page
// types. Stored as one JSON settings row rather than a table so existing
// deployments need no schema change; resolveCmsConfig() unions them into the
// type's blockLists/taxonomyLists on top of every other source.

export const PAGE_TYPE_EXTENSIONS_SETTING_KEY = 'content.page_type_extensions';

export interface PageTypeExtension {
  blocks: string[];
  taxonomies: string[];
}

export type PageTypeExtensions = Record<string, PageTypeExtension>;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function normalizedPageTypeExtension(slug: string, value: unknown): PageTypeExtension | null {
  if (UNSAFE_KEYS.has(slug) || !value || typeof value !== 'object') return null;
  const blocks = stringArray((value as PageTypeExtension).blocks);
  const taxonomies = stringArray((value as PageTypeExtension).taxonomies);
  return blocks.length || taxonomies.length ? { blocks, taxonomies } : null;
}

/** Loads the extensions map, dropping malformed or empty entries. */
export async function loadPageTypeExtensions(env: Env): Promise<PageTypeExtensions> {
  const parsed = parseJson<Record<string, unknown>>(await getSetting(env, PAGE_TYPE_EXTENSIONS_SETTING_KEY), {});
  const extensions: PageTypeExtensions = {};
  for (const [slug, value] of Object.entries(parsed)) {
    const extension = normalizedPageTypeExtension(slug, value);
    if (extension) extensions[slug] = extension;
  }
  return extensions;
}

/** Unions extension entries into the lists of types that exist in the config. */
export function applyPageTypeExtensions(config: CmsConfig, extensions: PageTypeExtensions): void {
  for (const [slug, extension] of Object.entries(extensions)) {
    if (!(slug in config.blueprint)) continue;
    if (extension.blocks.length) config.blockLists[slug] = union(config.blockLists[slug], extension.blocks);
    if (extension.taxonomies.length) config.taxonomyLists[slug] = union(config.taxonomyLists[slug], extension.taxonomies);
  }
}

function union(base: string[] | undefined, extra: string[]): string[] {
  return [...new Set([...(base ?? []), ...extra])];
}
