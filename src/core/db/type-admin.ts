// Shared listing helpers for configuration- and plugin-defined content types and taxonomies.

export interface ConfigTypeRow {
  slug: string;
  name: string;
  source: 'plugin' | 'config';
  pluginName: string;
}

/**
 * One contributor's claim over a set of type slugs. Structural on purpose:
 * core must not know what a plugin is, so the caller projects whatever it has
 * (today, resolved plugin manifests) down to a display name and the slug map
 * this listing is about.
 */
export interface ContentTypeContributor {
  /** Shown in the listing's source column. */
  name: string;
  /** The manifest map being listed — blueprint, blocks or taxonomies. */
  types?: Record<string, unknown>;
}

/**
 * Read-only rows for the type listings: everything in the resolved config that
 * isn't a DB row — static config-file entries plus those contributed by active
 * plugins. Contributors are merged in order, so the last declaration is the
 * effective source when two of them define the same slug.
 */
export function configOnlyTypes(
  resolvedSlugs: string[],
  dbSlugs: Set<string>,
  contributors: readonly ContentTypeContributor[],
): ConfigTypeRow[] {
  const pluginNameBySlug = new Map<string, string>();
  for (const contributor of contributors) {
    for (const slug of Object.keys(contributor.types ?? {})) {
      pluginNameBySlug.set(slug, contributor.name);
    }
  }
  return resolvedSlugs
    .filter((slug) => !dbSlugs.has(slug))
    .map((slug) => {
      const pluginName = pluginNameBySlug.get(slug) ?? '';
      return { slug, name: slug, source: pluginName ? 'plugin' : 'config', pluginName };
    });
}
