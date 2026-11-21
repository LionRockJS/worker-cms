// Settings export/import screen (/admin/settings/transfer). Core contributes
// the system settings and taxonomy sections; installed features contribute
// the rest through features/services. See core/config-transfer.ts.

import { Hono } from 'hono';
import type { Env, Tag, Variables } from '../../types';
import type { AppContext } from '../../core/http/context';
import { requirePermission } from '../../core/auth/guards';
import { userCan } from '../../core/auth/permissions';
import { renderPage } from '../../core/render/chrome';
import { flushReadAudit, recordTagReads, recordTaxonomyReads } from '../../core/http/access-log';
import { contextActor } from '../../core/db/audit';
import { slugify } from '../../core/http/forms';
import {
  CONFIG_TRANSFER_FORMAT, CONFIG_TRANSFER_VERSION, MAX_CONFIG_BUNDLE_BYTES,
  ConfigTransferItemError, isRecord, parseConfigBundle, planChange, skipItem,
  type ConfigTransferBundle, type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../core/config-transfer';
import {
  ADMIN_HOME_SETTING_KEY, APP_BRANDING_SETTING_KEY, CUSTOM_ICON_SPRITE_SETTING_KEY, SHOW_CREDITS_SETTING_KEY,
  SIDEBAR_MENU_SETTING_KEY, SYSTEM_TIMEZONE_SETTING_KEY,
  customIconSpriteFromRaw, getSetting, normalizeAdminHomeSettings, normalizeAppBrandingSettings, normalizeSystemTimezone,
} from '../../core/db/settings';
import { prepareHostSettingsMutation } from '../../core/evidence/settings-mutation-evidence';
import { MAX_ICON_SPRITE_BYTES, parseIconSprite } from '../../core/render/icon-sprite';
import { saveTag, saveTaxonomy } from '../../core/evidence/taxonomy-mutation-evidence';
import { normalizeLect, safeParseLect, stringifyLect, type Lect } from '../../core/db/lect';
import { featureConfigTransferSections, publication } from '../../features/services';
import {
  configTransferPage,
  type ConfigTransferPreviewSection,
  type ConfigTransferResult,
} from '../../core/templates/config-transfer';

/** Changes applied per request; D1 calls per change are bounded, the total is not. */
export const MAX_CHANGES_PER_REQUEST = 25;

// The sprite comes first so branding can refer to an imported custom icon.
const SETTING_KEYS = [
  CUSTOM_ICON_SPRITE_SETTING_KEY, APP_BRANDING_SETTING_KEY, ADMIN_HOME_SETTING_KEY,
  SYSTEM_TIMEZONE_SETTING_KEY, SHOW_CREDITS_SETTING_KEY, SIDEBAR_MENU_SETTING_KEY,
] as const;
type SettingKey = typeof SETTING_KEYS[number];

function parsedJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

/** The value to store for an imported setting, or an error message. */
function normalizedSetting(c: AppContext, key: SettingKey, value: string, customIcons: ReadonlySet<string>): string | { error: string } {
  switch (key) {
    case CUSTOM_ICON_SPRITE_SETTING_KEY: {
      const sprite = customIconSpriteFromRaw(value);
      if (!sprite || new TextEncoder().encode(sprite.svg).length > MAX_ICON_SPRITE_BYTES) return { error: 'Invalid icon sprite.' };
      try { return JSON.stringify(parseIconSprite(sprite.svg)); } catch { return { error: 'Invalid icon sprite.' }; }
    }
    case APP_BRANDING_SETTING_KEY: {
      const saved = parsedJson(value);
      if (!isRecord(saved)) return { error: 'Invalid branding.' };
      return JSON.stringify(normalizeAppBrandingSettings({
        appName: saved.appName, appIcon: saved.appIcon, primaryColor: saved.primaryColor, appFont: saved.appFont,
      }, c.env.SITE_TITLE ?? '0xCMS', customIcons));
    }
    case ADMIN_HOME_SETTING_KEY: {
      const saved = parsedJson(value);
      return isRecord(saved) ? JSON.stringify(normalizeAdminHomeSettings({ href: saved.href })) : { error: 'Invalid home page.' };
    }
    case SYSTEM_TIMEZONE_SETTING_KEY:
      return normalizeSystemTimezone(value) ?? { error: 'Invalid timezone.' };
    case SHOW_CREDITS_SETTING_KEY:
      return value === 'true' || value === 'false' ? value : { error: 'Invalid value.' };
    case SIDEBAR_MENU_SETTING_KEY:
      // The menu loader ignores unknown or malformed entries, so any object is safe to store.
      return isRecord(parsedJson(value)) ? value : { error: 'Invalid menu settings.' };
  }
}

const systemSettingsSection: ConfigTransferSection = {
  id: 'system_settings',
  labelKey: 'settings.transfer.sections.system_settings',
  order: 70,
  permission: 'menu:manage',
  async exportItems(c) {
    const items = [];
    for (const key of SETTING_KEYS) {
      const value = await getSetting(c.env, key);
      if (value !== null) items.push({ key, value });
    }
    return items;
  },
  async plan(c, items) {
    const current = new Map<string, string | null>();
    for (const key of SETTING_KEYS) current.set(key, await getSetting(c.env, key));
    const bundleSprite = items.find((item) => isRecord(item) && item.key === CUSTOM_ICON_SPRITE_SETTING_KEY);
    const customIcons = new Set([
      ...(customIconSpriteFromRaw(current.get(CUSTOM_ICON_SPRITE_SETTING_KEY) ?? null)?.icons ?? []),
      ...(isRecord(bundleSprite) && typeof bundleSprite.value === 'string' ? customIconSpriteFromRaw(bundleSprite.value)?.icons ?? [] : []),
    ]);
    const ordered = [...items].sort((a, b) => SETTING_KEYS.indexOf((isRecord(a) ? a.key : '') as SettingKey)
      - SETTING_KEYS.indexOf((isRecord(b) ? b.key : '') as SettingKey));
    return ordered.map((item): ConfigTransferPlanItem => {
      const key = isRecord(item) && typeof item.key === 'string' ? item.key : '?';
      if (!isRecord(item) || !SETTING_KEYS.includes(key as SettingKey) || typeof item.value !== 'string') {
        return skipItem(key, 'This setting cannot be imported.');
      }
      const value = normalizedSetting(c, key as SettingKey, item.value, customIcons);
      if (typeof value !== 'string') return skipItem(key, value.error);
      const before = current.get(key);
      const comparable = (raw: string) => parsedJson(raw) ?? raw;
      return planChange(key, before === null || before === undefined ? undefined : comparable(before), comparable(value), async () => {
        const mutation = await prepareHostSettingsMutation(c, [key as SettingKey]);
        await mutation.commit([{ key: key as SettingKey, value }]);
      });
    });
  },
};

const taxonomiesSection: ConfigTransferSection = {
  id: 'taxonomies',
  labelKey: 'settings.transfer.sections.taxonomies',
  order: 20,
  permission: 'taxonomy:write',
  async exportItems(c) {
    const { results } = await c.env.DB.prepare('SELECT slug, name FROM taxonomies ORDER BY name, slug').all<{ slug: string; name: string }>();
    recordTaxonomyReads('config.export-read', results);
    return results.map((row) => ({ slug: row.slug, name: row.name }));
  },
  async plan(c, items) {
    const { results } = await c.env.DB.prepare('SELECT * FROM taxonomies').all<import('../../types').Taxonomy>();
    recordTaxonomyReads('config.import-read', results);
    return items.map((item) => {
      const slug = isRecord(item) && typeof item.slug === 'string' ? item.slug : '';
      const name = isRecord(item) && typeof item.name === 'string' ? item.name.trim() : '';
      if (!slug || slugify(slug) !== slug) return skipItem(slug || '?', 'Invalid slug.');
      if (!name) return skipItem(slug, 'Name is required.');
      const before = results.find((row) => row.slug === slug);
      return planChange(slug, before?.name, name, async () => {
        const moved = await saveTaxonomy(c, { name, slug }, before);
        if (moved.length) await publication()?.publishTagsToTargets(c.env, moved, contextActor(c));
      });
    });
  },
};

interface TagTransferItem { slug: string; name: string; weight: number; taxonomy: string | null; parent: string | null; lect: Lect }

/** The comparable, storable form of a tag; parents are named by slug so ids never cross CMSes. */
function tagTransferItem(tag: Tag, slugById: ReadonlyMap<number, string>): TagTransferItem {
  return {
    slug: tag.slug, name: tag.name, weight: tag.weight, taxonomy: tag.taxonomy_slug,
    parent: tag.parent_tag === null ? null : slugById.get(tag.parent_tag) ?? null, lect: safeParseLect(tag.lect),
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
function parentsFirst<T extends { item: TagTransferItem | string }>(entries: readonly T[]): Array<T & { depth: number }> {
  const bySlug = new Map<string, TagTransferItem>();
  for (const { item } of entries) if (typeof item !== 'string') bySlug.set(item.slug, item);
  const depth = (item: TagTransferItem): number => {
    const seen = new Set([item.slug]);
    let n = 0;
    for (let parent = item.parent; parent && bySlug.has(parent); parent = bySlug.get(parent)!.parent, n++) {
      if (seen.has(parent)) return -1;
      seen.add(parent);
    }
    return n;
  };
  return entries.map((entry) => ({ ...entry, depth: typeof entry.item === 'string' ? 0 : depth(entry.item) }))
    .sort((a, b) => a.depth - b.depth);
}

const tagsSection: ConfigTransferSection = {
  id: 'tags',
  labelKey: 'settings.transfer.sections.tags',
  order: 25,
  permission: 'tag:write',
  async exportItems(c) {
    const { results } = await c.env.DB.prepare('SELECT * FROM tags ORDER BY taxonomy_slug, weight, name, slug').all<Tag>();
    recordTagReads('config.export-read', results);
    const slugById = new Map(results.map((tag) => [tag.id, tag.slug]));
    return parentsFirst(results.map((tag) => ({ item: tagTransferItem(tag, slugById) }))).map(({ item }) => item);
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
    return parentsFirst(parsed).map(({ label, item, depth }): ConfigTransferPlanItem => {
      if (typeof item === 'string') return skipItem(label, item);
      if (depth < 0) return skipItem(label, 'Its parent tags form a loop.');
      if (item.parent && !existing.has(item.parent) && !inBundle.has(item.parent)) return skipItem(label, `Parent tag ${item.parent} is not on this CMS or in the file.`);
      const before = existing.get(item.slug);
      return planChange(label, before && tagTransferItem(before, slugById), item, async () => {
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

/** Every section this CMS can export or import, in apply order. */
export function configTransferSections(): ConfigTransferSection[] {
  return [systemSettingsSection, taxonomiesSection, tagsSection, ...featureConfigTransferSections()].sort((a, b) => a.order - b.order);
}

async function permittedSections(c: AppContext): Promise<ConfigTransferSection[]> {
  const sections = configTransferSections();
  const allowed = await Promise.all(sections.map((section) => userCan(c, section.permission)));
  return sections.filter((_, index) => allowed[index]);
}

const ACTION_KEYS: Record<ConfigTransferPlanItem['action'], string> = {
  create: 'settings.transfer.actions.create',
  update: 'settings.transfer.actions.update',
  unchanged: 'settings.transfer.actions.unchanged',
  skip: 'settings.transfer.actions.skip',
};

async function previewSections(c: AppContext, bundle: ConfigTransferBundle): Promise<ConfigTransferPreviewSection[]> {
  const all = configTransferSections();
  const permitted = new Set((await permittedSections(c)).map((section) => section.id));
  const known = all.filter((section) => Object.hasOwn(bundle.sections, section.id));
  const unknown = Object.keys(bundle.sections).filter((id) => !all.some((section) => section.id === id));
  const rows: ConfigTransferPreviewSection[] = [];
  for (const section of known) {
    const items = bundle.sections[section.id];
    const empty = { create: 0, update: 0, unchanged: 0, skip: 0 };
    if (!permitted.has(section.id)) {
      rows.push({ id: section.id, labelKey: section.labelKey, unavailableKey: 'settings.transfer.unavailable.no_permission',
        noteKey: '', changes: 0, counts: empty, items: [] });
      continue;
    }
    const plans = await section.plan(c, items);
    const counts = { ...empty };
    for (const plan of plans) counts[plan.action] += 1;
    rows.push({
      id: section.id, labelKey: section.labelKey, unavailableKey: '', noteKey: section.noteKey ?? '',
      changes: counts.create + counts.update, counts,
      items: plans.map((plan) => ({ label: plan.label, action: plan.action, actionKey: ACTION_KEYS[plan.action], note: plan.note ?? '' })),
    });
  }
  for (const id of unknown) {
    rows.push({ id, labelKey: '', unavailableKey: 'settings.transfer.unavailable.not_installed', noteKey: '', changes: 0,
      counts: { create: 0, update: 0, unchanged: 0, skip: 0 }, items: [] });
  }
  return rows;
}

/** Applies planned changes section by section, re-planning each section after
 *  the previous one so later sections see what earlier ones created. */
export async function applyConfigBundle(c: AppContext, bundle: ConfigTransferBundle, selected: ReadonlySet<string>,
  budget = MAX_CHANGES_PER_REQUEST): Promise<ConfigTransferResult> {
  const result: ConfigTransferResult = { applied: 0, remaining: 0, failed: [], stopped: '' };
  for (const section of await permittedSections(c)) {
    if (!selected.has(section.id) || !Object.hasOwn(bundle.sections, section.id)) continue;
    const plans = (await section.plan(c, bundle.sections[section.id])).filter((plan) => plan.apply);
    for (const plan of plans) {
      if (result.stopped || result.applied >= budget) { result.remaining += 1; continue; }
      try {
        await plan.apply!();
        result.applied += 1;
      } catch (error) {
        if (error instanceof ConfigTransferItemError) {
          result.failed.push({ sectionLabelKey: section.labelKey, label: plan.label, message: error.message });
        } else {
          // Audit or policy outages refuse every later write too; stop rather than retry each.
          console.error('[cms] settings import stopped', error);
          result.stopped = `${plan.label}: this change could not be saved.`;
          result.remaining += 1;
        }
      }
    }
  }
  return result;
}

async function readBundle(form: FormData): Promise<ConfigTransferBundle | null> {
  const upload = form.get('bundle');
  let text = typeof form.get('bundle_json') === 'string' ? String(form.get('bundle_json')) : '';
  if (upload instanceof File && upload.size) {
    if (upload.size > MAX_CONFIG_BUNDLE_BYTES) return null;
    text = await upload.text();
  }
  if (!text || new TextEncoder().encode(text).length > MAX_CONFIG_BUNDLE_BYTES) return null;
  return parseConfigBundle(text);
}

export const configTransferRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

configTransferRoutes.use('/settings/transfer', requirePermission('menu:manage'));
configTransferRoutes.use('/settings/transfer/*', requirePermission('menu:manage'));

async function renderTransfer(c: AppContext, extra: Omit<Parameters<typeof configTransferPage>[1], keyof import('../../core/render/layout').BaseTemplateProps | 'exportSections'>, status?: 400) {
  const exportSections = (await permittedSections(c)).map((section) => ({ id: section.id, labelKey: section.labelKey }));
  return renderPage(c, configTransferPage, { exportSections, ...extra }, c.env.VIEWS, status);
}

configTransferRoutes.get('/settings/transfer', (c) => renderTransfer(c, {}));

configTransferRoutes.post('/settings/transfer/export', async (c) => {
  const form = await c.req.formData();
  const chosen = new Set(form.getAll('sections').map(String));
  const sections: Record<string, unknown[]> = {};
  for (const section of await permittedSections(c)) {
    if (chosen.has(section.id)) sections[section.id] = await section.exportItems(c);
  }
  // The download is a disclosure: record the reads above as an export first.
  const refused = await flushReadAudit(c, { destination: 'download', operation: 'config.export' });
  if (refused) return refused;
  const bundle: ConfigTransferBundle = {
    format: CONFIG_TRANSFER_FORMAT,
    version: CONFIG_TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    source: c.env.CANONICAL_ORIGIN || new URL(c.req.url).origin,
    sections,
  };
  const day = bundle.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cms-settings-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  });
});

configTransferRoutes.post('/settings/transfer/preview', async (c) => {
  const bundle = await readBundle(await c.req.formData());
  if (!bundle) return renderTransfer(c, { errorKey: 'settings.transfer.invalid_file' }, 400);
  return renderTransfer(c, { preview: { source: bundle.source, exportedAt: bundle.exportedAt, bundleJson: JSON.stringify(bundle),
    sections: await previewSections(c, bundle) } });
});

configTransferRoutes.post('/settings/transfer/apply', async (c) => {
  const form = await c.req.formData();
  const bundle = await readBundle(form);
  if (!bundle) return renderTransfer(c, { errorKey: 'settings.transfer.invalid_file' }, 400);
  const selected = form.getAll('sections').map(String);
  const result = await applyConfigBundle(c, bundle, new Set(selected));
  return renderTransfer(c, {
    result,
    selected,
    preview: { source: bundle.source, exportedAt: bundle.exportedAt, bundleJson: JSON.stringify(bundle), sections: await previewSections(c, bundle) },
  });
});
