import type { AppContext } from '../../core/http/context';

/** Validates a page/block type form submission; returns an error message or
 *  null. `ignoreId` skips the row being edited during the slug-collision check. */
export async function validateTypeForm(
  c: AppContext,
  opts: {
    name: string;
    slug: string;
    blueprint: string;
    table: 'page_types' | 'block_types';
    /** The config-file map the slug must not collide with (blueprint / blocks). */
    configSlugs: Record<string, unknown>;
    ignoreId?: number;
  },
): Promise<string | null> {
  const { name, slug, blueprint, table, configSlugs, ignoreId } = opts;
  if (!name) return 'Name is required.';
  if (!slug) return 'Slug is required.';
  if (slug in configSlugs) return `Slug "${slug}" is already defined in the config file.`;

  const existing = await c.env.DB.prepare(`SELECT id FROM ${table} WHERE slug = ?`)
    .bind(slug)
    .first<{ id: number }>();
  if (existing && existing.id !== ignoreId) return `Slug "${slug}" is already in use.`;

  try {
    const parsed = JSON.parse(blueprint || '[]');
    if (!Array.isArray(parsed)) return 'Blueprint must be a JSON array.';
  } catch {
    return 'Blueprint is not valid JSON.';
  }
  return null;
}
