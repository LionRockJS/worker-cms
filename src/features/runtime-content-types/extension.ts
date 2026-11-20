// Extra block/taxonomy selections layered on config- and plugin-defined page
// types. Shared by the page type screen and settings import; kept out of
// routes.ts so services can use it without importing the routers.

import { prepareRuntimeTypeMutation } from './mutation-evidence';
import { clearConfigCache, resolveCmsConfig } from '../../core/db/content-config';
import type { CmsConfig } from '../../cms-config';
import type { AppContext } from '../../core/http/context';

export function availableTaxonomies(config: CmsConfig, dbTaxonomies: Array<{ slug: string; name: string }>): Array<{ slug: string; name: string }> {
  const bySlug = new Map(Object.entries(config.taxonomies).map(([slug, name]) => [slug, { slug, name }]));
  for (const taxonomy of dbTaxonomies) bySlug.set(taxonomy.slug, taxonomy);
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

/** Saves extra block/taxonomy selections on a config- or plugin-defined page
 *  type. False when this CMS has no such page type. */
export async function savePageTypeExtension(c: AppContext, slug: string, blockLists: string[], taxonomyLists: string[]): Promise<boolean> {
  const mutation = await prepareRuntimeTypeMutation(c, 'page_types');
  const extensions = await mutation.extensions();
  clearConfigCache();
  const config = await resolveCmsConfig(c.env);
  if (!Object.hasOwn(config.blueprint,slug)) return false;
  const taxonomies = mutation.taxonomies;
  const current = extensions[slug] ?? { blocks: [], taxonomies: [] };
  const knownBlocks = new Set(Object.keys(config.blocks));
  const knownTaxonomies = new Set(availableTaxonomies(config, taxonomies).map((taxonomy) => taxonomy.slug));
  // Config/plugin-owned entries never enter the extension, so unchecking
  // them (or replaying a stale form) cannot shrink the base lists.
  const lockedBlocks = new Set((config.blockLists[slug] ?? []).filter((entry) => !current.blocks.includes(entry)));
  const lockedTaxonomies = new Set((config.taxonomyLists[slug] ?? []).filter((entry) => !current.taxonomies.includes(entry)));
  const extension = {
    blocks: [...new Set(blockLists)].filter((entry) => knownBlocks.has(entry) && !lockedBlocks.has(entry)),
    taxonomies: [...new Set(taxonomyLists)].filter((entry) => knownTaxonomies.has(entry) && !lockedTaxonomies.has(entry)),
  };
  await mutation.extend(slug, extension);
  return true;
}
