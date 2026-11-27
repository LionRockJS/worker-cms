import type { Tag } from '../../../types';
import { exportTree } from '../../../core/config-export';
import {
  ConfigTransferItemError, isRecord, planChange, skipItem,
  type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../../core/config-transfer';
import { contextActor } from '../../../core/db/audit';
import { normalizeLect, safeParseLect, stringifyLect, type Lect } from '../../../core/db/lect';
import { saveTag, TagParentCycleError } from '../../../core/evidence/taxonomy-mutation-evidence';
import { recordTagReads } from '../../../core/http/access-log';
import { slugify } from '../../../core/http/forms';
import { publication } from '../../../features/services';

interface TagTransferItem { slug: string; name: string; weight: number; taxonomy: string | null; parent: string | null; lect: Lect }

/** The comparable, storable form of a tag; parents are named by slug so ids never cross CMSes. */
function tagTransferItem(tag: Tag, parent: string | null): TagTransferItem {
  return {
    slug: tag.slug, name: tag.name, weight: tag.weight, taxonomy: tag.taxonomy_slug,
    parent, lect: safeParseLect(tag.lect),
  };
}

/** The imported tag, or an error message. */
function parsedTagItem(item: unknown): TagTransferItem | string {
  if (!isRecord(item)) return 'Invalid tag.';
  const slug = typeof item.slug === 'string' ? item.slug : '';
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const slugOrNull = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' && value && slugify(value) === value ? value : undefined;
  const taxonomy = slugOrNull(item.taxonomy);
  const parent = slugOrNull(item.parent);
  if (!slug || slugify(slug) !== slug) return 'Invalid slug.';
  if (!name) return 'Name is required.';
  if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight))) return 'Invalid weight.';
  if (taxonomy === undefined) return 'Invalid taxonomy.';
  if (parent === undefined) return 'Invalid parent tag.';
  if (parent === slug) return 'A tag cannot be its own parent.';
  if (item.lect !== undefined && item.lect !== null && !isRecord(item.lect)) return 'Invalid translations.';
  return { slug, name, weight: typeof item.weight === 'number' ? item.weight : 5, taxonomy, parent, lect: normalizeLect(item.lect ?? {}) };
}

/** Bundle tags ordered parents first, so a parent created in this import exists before its children.
 *  A depth of -1 marks a tag whose parent chain loops back on itself. */
function parentsFirst<T extends { item: TagTransferItem | string }>(entries: readonly T[], parents = new Map<string, string | null>()): Array<T & { depth: number }> {
  for (const { item } of entries) if (typeof item !== 'string') parents.set(item.slug, item.parent);
  const depth = (item: TagTransferItem): number => {
    const seen = new Set([item.slug]);
    let n = 0;
    for (let parent = item.parent; parent && parents.has(parent); parent = parents.get(parent) ?? null, n++) {
      if (seen.has(parent)) return -1;
      seen.add(parent);
    }
    return n;
  };
  return entries.map((entry) => ({ ...entry, depth: typeof entry.item === 'string' ? 0 : depth(entry.item) }))
    .sort((a, b) => a.depth - b.depth);
}

export const tagsSection: ConfigTransferSection = {
  id: 'tags',
  labelKey: 'settings.transfer.sections.tags',
  order: 25,
  permission: 'tag:write',
  exportRecords(c, after) {
    return exportTree<Tag & { parentSlug: string | null }>(c, 'tags', after, row => {
      recordTagReads('config.export-read', [row]);
      return { key: String(row.id), label: row.slug, item: tagTransferItem(row, row.parentSlug) };
    });
  },
  async plan(c, items) {
    const { results } = await c.env.DB.prepare('SELECT * FROM tags').all<Tag>();
    recordTagReads('config.import-read', results);
    const slugById = new Map(results.map((tag) => [tag.id, tag.slug]));
    const existing = new Map(results.map((tag) => [tag.slug, tag]));
    const parsed = items.map((raw) => ({
      label: isRecord(raw) && typeof raw.slug === 'string' && raw.slug ? raw.slug : '?',
      item: parsedTagItem(raw),
    }));
    const inBundle = new Set(parsed.flatMap(({ item }) => typeof item === 'string' ? [] : [item.slug]));
    const parents = new Map(results.map((tag) => [tag.slug, tag.parent_tag === null ? null : slugById.get(tag.parent_tag) ?? null]));
    return parentsFirst(parsed, parents).map(({ label, item, depth }): ConfigTransferPlanItem => {
      if (typeof item === 'string') return skipItem(label, item);
      if (depth < 0) return skipItem(label, TagParentCycleError.messageText);
      if (item.parent && !existing.has(item.parent) && !inBundle.has(item.parent)) return skipItem(label, `Parent tag ${item.parent} is not on this CMS or in the file.`);
      const before = existing.get(item.slug);
      return planChange(label, before && tagTransferItem(before, before.parent_tag === null ? null : slugById.get(before.parent_tag) ?? null), item, async () => {
        // Re-read at apply time: a parent this import created moments ago now has an id.
        const [current, parent] = await Promise.all([
          c.env.DB.prepare('SELECT * FROM tags WHERE slug = ?').bind(item.slug).first<Tag>(),
          item.parent ? c.env.DB.prepare('SELECT id FROM tags WHERE slug = ?').bind(item.parent).first<{ id: number }>() : null,
        ]);
        if (item.parent && !parent) throw new ConfigTransferItemError(`Parent tag ${item.parent} was not imported.`);
        const id = await saveTag(c, {
          name: item.name, slug: item.slug, weight: item.weight, taxonomy_slug: item.taxonomy,
          parent_tag: parent?.id ?? null, lect: stringifyLect(item.lect),
        }, current ?? undefined);
        await publication()?.publishTagToTargets(c.env, id, contextActor(c));
      });
    });
  },
};
