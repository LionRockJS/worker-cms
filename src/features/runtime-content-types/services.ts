import { exportRows } from '../../core/config-export';
import type { FeatureServiceEntry } from '../services';
import type { AppContext } from '../../core/http/context';
import {
  ConfigTransferItemError, isRecord, planChange, skipItem,
  type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../core/config-transfer';
import { cmsConfig } from '../../cms-config';
import { listDbPageTypes, loadPageTypeExtensions, normalizedPageTypeExtension, PAGE_TYPE_EXTENSIONS_SETTING_KEY } from '../../core/db/page-type-store';
import { listDbBlockTypes } from '../../core/db/block-type-store';
import { clearConfigCache, resolveCmsConfig } from '../../core/db/content-config';
import { recordMetadataReads, recordTableReads } from '../../core/http/access-log';
import { prepareRuntimeTypeMutation } from './mutation-evidence';
import { validateTypeForm } from './validation';
import { savePageTypeExtension } from './extension';

type Table = 'page_types' | 'block_types';

interface TypeItem {
  slug: string;
  name: string;
  blueprint: unknown[];
  weight: number;
  blockLists?: string[];
  taxonomyLists?: string[];
}

const TYPE_SLUG = /^[a-z0-9_-]+$/;

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : null;
}

function storedList(value: string | null | undefined): string[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

function storedBlueprint(value: string): unknown {
  try { return JSON.parse(value || '[]'); } catch { return value; }
}

function typeItem(table: Table, raw: unknown): TypeItem | string {
  if (!isRecord(raw) || typeof raw.slug !== 'string' || !TYPE_SLUG.test(raw.slug)) return 'Invalid slug.';
  if (typeof raw.name !== 'string' || !raw.name.trim()) return 'Name is required.';
  if (!Array.isArray(raw.blueprint)) return 'Blueprint must be a JSON array.';
  if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight)) return 'Weight must be a number.';
  const item: TypeItem = { slug: raw.slug, name: raw.name.trim(), blueprint: raw.blueprint, weight: raw.weight };
  if (table === 'page_types') {
    const blockLists = stringList(raw.blockLists);
    const taxonomyLists = stringList(raw.taxonomyLists);
    if (!blockLists || !taxonomyLists) return 'Block and taxonomy lists must be lists of slugs.';
    item.blockLists = blockLists;
    item.taxonomyLists = taxonomyLists;
  }
  return item;
}

function typeSection(table: Table, order: number): ConfigTransferSection {
  const page = table === 'page_types';
  const rows = async (c: AppContext) => {
    const list = page ? await listDbPageTypes(c.env.DB) : await listDbBlockTypes(c.env.DB);
    recordTableReads('config.export-read', table, list.map((row) => row.id));
    return list as Array<{ id: number; slug: string; name: string; blueprint: string; weight: number; block_lists?: string | null; taxonomy_lists?: string | null }>;
  };
  const exported = (row: Awaited<ReturnType<typeof rows>>[number]): TypeItem => ({
    slug: row.slug,
    name: row.name,
    blueprint: storedBlueprint(row.blueprint) as unknown[],
    weight: row.weight,
    ...(page ? { blockLists: storedList(row.block_lists), taxonomyLists: storedList(row.taxonomy_lists) } : {}),
  });
  return {
    id: table,
    labelKey: page ? 'settings.transfer.sections.page_types' : 'settings.transfer.sections.block_types',
    order,
    permission: page ? 'pagetype:write' : 'blocktype:write',
    exportRecords(c, after) {
      return exportRows<Parameters<typeof exported>[0]>(c,
        `SELECT * FROM ${table} WHERE slug > ? ORDER BY slug LIMIT ?`, after, row => {
          recordTableReads('config.export-read', table, [row.id]);
          return { key: row.slug, label: row.slug, item: exported(row) };
        });
    },
    async plan(c, items) {
      const existing = new Map((await rows(c)).map((row) => [row.slug, row]));
      const plans: ConfigTransferPlanItem[] = [];
      for (const raw of items) {
        const item = typeItem(table, raw);
        const label = isRecord(raw) && typeof raw.slug === 'string' ? raw.slug : '?';
        if (typeof item === 'string') { plans.push(skipItem(label, item)); continue; }
        const before = existing.get(item.slug);
        const blueprint = JSON.stringify(item.blueprint, null, 2);
        const error = await validateTypeForm(c, {
          name: item.name, slug: item.slug, blueprint, table,
          configSlugs: page ? cmsConfig.blueprint : cmsConfig.blocks, ignoreId: before?.id,
        });
        if (error) { plans.push(skipItem(item.slug, error)); continue; }
        plans.push(planChange(item.slug, before && exported(before), item, async () => {
          const mutation = await prepareRuntimeTypeMutation(c, table);
          if (before && !mutation.row(before.id)) throw new ConfigTransferItemError(`${item.slug} changed during import.`);
          const lists: Record<string, string | null> = page ? {
            block_lists: item.blockLists!.length ? JSON.stringify(item.blockLists) : null,
            taxonomy_lists: item.taxonomyLists!.length ? JSON.stringify(item.taxonomyLists) : null,
          } : {};
          await mutation.save({ slug: item.slug, name: item.name, blueprint, ...lists, weight: item.weight }, before?.id);
        }));
      }
      return plans;
    },
  };
}

/** Extra selections saved on config- or plugin-defined page types. */
const pageTypeExtensionSection: ConfigTransferSection = {
  id: 'page_type_extensions',
  labelKey: 'settings.transfer.sections.page_type_extensions',
  order: 45,
  permission: 'pagetype:write',
  async *exportRecords(c, after) {
    // Storage is one JSON settings row. Project only the next keys into the Worker.
    const sql = `SELECT e.key AS slug, e.value FROM settings s,
      json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '{}' END) e
      WHERE s.key='${PAGE_TYPE_EXTENSIONS_SETTING_KEY}' AND e.type='object' AND e.key>?
      ORDER BY e.key LIMIT ?`;
    for await (const row of exportRows<{ slug: string; value: string }>(c, sql, after, ({ slug, value }) => {
      recordMetadataReads('settings.read', 'settings', [PAGE_TYPE_EXTENSIONS_SETTING_KEY]);
      const extension = normalizedPageTypeExtension(slug, JSON.parse(value));
      return { key: slug, label: slug, item: extension && { slug, ...extension } };
    })) {
      if (row.item) yield row;
    }
  },
  async plan(c, items) {
    clearConfigCache();
    const [config, current] = await Promise.all([resolveCmsConfig(c.env), loadPageTypeExtensions(c.env)]);
    return items.map((raw) => {
      const slug = isRecord(raw) && typeof raw.slug === 'string' ? raw.slug : '';
      const blocks = isRecord(raw) ? stringList(raw.blocks) : null;
      const taxonomies = isRecord(raw) ? stringList(raw.taxonomies) : null;
      if (!slug || !blocks || !taxonomies) return skipItem(slug || '?', 'Invalid page type extension.');
      if (!Object.hasOwn(config.blueprint, slug)) return skipItem(slug, 'This page type is not available on this CMS.');
      const before = current[slug] ?? { blocks: [], taxonomies: [] };
      const next = { blocks, taxonomies };
      return planChange(slug, before.blocks.length || before.taxonomies.length ? before : undefined, next, async () => {
        if (!(await savePageTypeExtension(c, slug, blocks, taxonomies))) {
          throw new ConfigTransferItemError(`${slug} is not available on this CMS.`);
        }
      });
    });
  },
};

export const runtimeContentTypesServices: FeatureServiceEntry = {
  id: 'runtime-content-types',
  configTransferSections: [typeSection('block_types', 30), typeSection('page_types', 40), pageTypeExtensionSection],
};
