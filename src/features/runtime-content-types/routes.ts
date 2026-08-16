// Database-defined type management (full CRUD) for the two parallel type
// tables: page_types and block_types. Config-file entries are shown read-only
// alongside the editable database rows; the merge into the effective CmsConfig
// happens in resolveCmsConfig() — see page-type-store.ts / block-type-store.ts.
//
// The two entities share one route factory (list / new / create / view / edit
// / update / delete); each spec contributes only what differs — table, copy,
// extra columns, and the form-option decoration.

import { Hono } from 'hono';
import { typeFormPage, typeListPage } from './template';
import type { TypeAdminCopy, TypeFormModel, TypeFormOption } from './template';
import { cmsConfig, type CmsConfig } from '../../cms-config';
import type { Env, Variables, Permission } from '../../types';
import { coreExtensions, type ContentTypeContributorInfo } from '../../core/extensions';
import { num, str } from '../../core/http/forms';
import { logAudit } from '../../core/db/audit';
import { requirePermission } from '../../core/auth/guards';
import { renderPage } from '../../core/render/chrome';
import { userCan } from '../../core/auth/permissions';
import { clearConfigCache, resolveCmsConfig } from '../../core/db/content-config';
import {
  listDbPageTypes,
  loadPageTypeExtensions,
  savePageTypeExtension,
} from '../../core/db/page-type-store';
import { listDbBlockTypes } from '../../core/db/block-type-store';
import { configOnlyTypes, validateTypeForm } from '../../core/db/type-admin';
import type { AppContext } from '../../core/http/context';

interface DbTypeRow {
  id: number;
  name: string;
  slug: string;
  blueprint: string;
  weight: number;
}

interface BaseTypeFormValues {
  name: string;
  slug: string;
  blueprint: string;
  weight: string;
}

interface TypeCrudSpec<Row extends DbTypeRow, Values extends BaseTypeFormValues> {
  /** URL segment and table name, e.g. 'page_types'. */
  table: 'page_types' | 'block_types';
  permission: Permission;
  /** Audit action prefix and entity type, e.g. 'page_type'. */
  audit: string;
  copy: TypeAdminCopy;
  /** Static config map the slug must not collide with. */
  configSlugs: Record<string, unknown>;
  /** Slugs in the resolved config (DB + config + plugins) for the read-only list. */
  resolvedSlugs: (config: CmsConfig) => string[];
  /** Where a contributor declares this kind of type. */
  manifestTypes: (source: ContentTypeContributorInfo) => Record<string, unknown> | undefined;
  listRows: (db: D1DatabaseClient) => Promise<Row[]>;
  formValues: (form: FormData) => Values;
  /** Columns beyond slug/name/blueprint/weight, with their binds. */
  extraColumns: string[];
  extraBinds: (values: Values) => unknown[];
  modelFromValues: (mode: 'new' | 'edit', values: Values, error: string) => TypeFormModel;
  modelFromRow: (mode: 'edit' | 'view', row: Row) => TypeFormModel;
  /** Read-only model for a config/plugin-defined slug, or null → 404. */
  modelFromConfig: (config: CmsConfig, slug: string) => TypeFormModel | null;
  /** Turns stored selections into form options (page types); identity for block types. */
  decorate: (c: AppContext, model: TypeFormModel) => Promise<TypeFormModel & {
    blockOptions?: TypeFormOption[];
    taxonomyOptions?: TypeFormOption[];
  }>;
  /** Page types only — read-only (config/plugin) types accept extra block/taxonomy selections. */
  extension?: {
    decorateViewModel: (c: AppContext, config: CmsConfig, slug: string, model: TypeFormModel) => Promise<TypeFormModel>;
    save: (c: AppContext, config: CmsConfig, slug: string, values: Values) => Promise<void>;
  };
}

function dbTypeRoutes<Row extends DbTypeRow, Values extends BaseTypeFormValues>(
  spec: TypeCrudSpec<Row, Values>,
): Hono<{ Bindings: Env; Variables: Variables }> {
  const routes = new Hono<{ Bindings: Env; Variables: Variables }>();
  const base = `/${spec.table}`;
  const columns = ['slug', 'name', 'blueprint', ...spec.extraColumns, 'weight'];

  const renderForm = async (c: AppContext, model: TypeFormModel): Promise<Response> =>
    renderPage(c, typeFormPage, { copy: spec.copy, ...(await spec.decorate(c, model)) });

  const fetchRow = (db: D1DatabaseClient, id: number) =>
    db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first<Row>();

  const binds = (values: Values, slug: string) =>
    [slug, values.name, values.blueprint || '[]', ...spec.extraBinds(values), num(values.weight)];

  routes.get(base, async (c) => {
    const [dbRows, contributors] = await Promise.all([
      spec.listRows(c.env.DB),
      coreExtensions().contentTypeContributors?.(c.env) ?? [],
    ]);
    const resolved = await resolveCmsConfig(c.env);
    const dbSlugs = new Set(dbRows.map((row) => row.slug));
    const configRows = configOnlyTypes(
      spec.resolvedSlugs(resolved),
      dbSlugs,
      contributors.map((source) => ({ name: source.name, types: spec.manifestTypes(source) })),
    );
    return renderPage(c, typeListPage, {
      copy: spec.copy,
      dbRows,
      configRows,
      canWrite: await userCan(c, spec.permission),
    });
  });

  routes.get(`${base}/new`, async (c) => {
    if (!(await userCan(c, spec.permission))) return c.redirect(spec.copy.routeBase);
    const empty = spec.modelFromValues('new', spec.formValues(new FormData()), '');
    return renderForm(c, { ...empty, weight: '5', blueprint: '[]' });
  });

  routes.post(base, requirePermission(spec.permission), async (c) => {
    const form = await c.req.formData();
    const values = spec.formValues(form);
    const slug = values.slug ? typeSlugify(values.slug) : typeSlugify(values.name);

    const error = await validate(c, spec, values, slug);
    if (error) return renderForm(c, spec.modelFromValues('new', values, error));

    const result = await c.env.DB.prepare(
      `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
      .bind(...binds(values, slug))
      .run();
    clearConfigCache();
    logAudit(c, `${spec.audit}.create`, spec.audit, result.meta.last_row_id, { slug, name: values.name });
    return c.redirect(spec.copy.routeBase);
  });

  // View of a config-file or plugin-contributed definition: the definition
  // itself is read-only, but specs with an `extension` let permitted users
  // add extra selections (blocks/taxonomies) on top of it.
  routes.get(`${base}/view/:slug`, async (c) => {
    const config = await resolveCmsConfig(c.env);
    const slug = c.req.param('slug');
    let model = spec.modelFromConfig(config, slug);
    if (!model) return c.notFound();
    if (spec.extension) model = await spec.extension.decorateViewModel(c, config, slug, model);
    return renderForm(c, model);
  });

  const extension = spec.extension;
  if (extension) {
    routes.post(`${base}/view/:slug`, requirePermission(spec.permission), async (c) => {
      const config = await resolveCmsConfig(c.env);
      const slug = c.req.param('slug');
      if (!spec.modelFromConfig(config, slug)) return c.notFound();
      await extension.save(c, config, slug, spec.formValues(await c.req.formData()));
      clearConfigCache();
      return c.redirect(`${spec.copy.routeBase}/view/${encodeURIComponent(slug)}`);
    });
  }

  routes.get(`${base}/:id/edit`, async (c) => {
    const row = await fetchRow(c.env.DB, parseInt(c.req.param('id'), 10));
    if (!row) return c.notFound();
    const mode = (await userCan(c, spec.permission)) ? 'edit' : 'view';
    return renderForm(c, spec.modelFromRow(mode, row));
  });

  routes.post(`${base}/:id`, requirePermission(spec.permission), async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const existing = await fetchRow(c.env.DB, id);
    if (!existing) return c.notFound();

    const form = await c.req.formData();
    const values = spec.formValues(form);
    const slug = values.slug ? typeSlugify(values.slug) : typeSlugify(values.name);

    const error = await validate(c, spec, values, slug, id);
    if (error) return renderForm(c, { ...spec.modelFromValues('edit', values, error), id });

    await c.env.DB.prepare(
      `UPDATE ${spec.table}
          SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
      .bind(...binds(values, slug), id)
      .run();
    clearConfigCache();
    logAudit(c, `${spec.audit}.update`, spec.audit, id, { slug, name: values.name });
    return c.redirect(spec.copy.routeBase);
  });

  routes.post(`${base}/:id/delete`, requirePermission(spec.permission), async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    await c.env.DB.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).bind(id).run();
    clearConfigCache();
    logAudit(c, `${spec.audit}.delete`, spec.audit, id);
    return c.redirect(spec.copy.routeBase);
  });

  return routes;
}

function validate<Row extends DbTypeRow, Values extends BaseTypeFormValues>(
  c: AppContext,
  spec: TypeCrudSpec<Row, Values>,
  values: Values,
  slug: string,
  ignoreId?: number,
): Promise<string | null> {
  return validateTypeForm(c, {
    name: values.name,
    slug,
    blueprint: values.blueprint,
    table: spec.table,
    configSlugs: spec.configSlugs,
    ignoreId,
  });
}

/** Type slugs support underscores; page/tag/media slugs keep the stricter shared normalizer. */
function typeSlugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Page types ────────────────────────────────────────────────────────────────

interface PageTypeFormValues extends BaseTypeFormValues {
  blockLists: string[];
  taxonomyLists: string[];
}

/** Parses a stored JSON string array, tolerating null/malformed values. */
function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function nullableJsonArray(values: string[]): string | null {
  return values.length ? JSON.stringify(values) : null;
}

function availableTaxonomies(config: CmsConfig, dbTaxonomies: Array<{ slug: string; name: string }>): Array<{ slug: string; name: string }> {
  const bySlug = new Map(Object.entries(config.taxonomies).map(([slug, name]) => [slug, { slug, name }]));
  for (const taxonomy of dbTaxonomies) bySlug.set(taxonomy.slug, taxonomy);
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export const pageTypesRoutes = dbTypeRoutes<DbTypeRow & { block_lists: string | null; taxonomy_lists: string | null }, PageTypeFormValues>({
  table: 'page_types',
  permission: 'pagetype:write',
  audit: 'page_type',
  copy: {
    routeBase: '/admin/page_types',
    title: 'Page Types',
    singular: 'Page Type',
    translationKey: 'page_types',
    description: 'Database page types are editable here; config-file and plugin page types are read-only.',
    formTemplate: '/templates/page-type-form.json',
  },
  configSlugs: cmsConfig.blueprint,
  resolvedSlugs: (config) => Object.keys(config.blueprint),
  manifestTypes: (source) => source.contentTypes?.blueprint,
  listRows: listDbPageTypes,
  formValues: (form) => ({
    name: str(form.get('name')),
    slug: str(form.get('slug')),
    blueprint: str(form.get('blueprint')),
    blockLists: form.getAll('block_lists').map(String),
    taxonomyLists: form.getAll('taxonomy_lists').map(String),
    weight: str(form.get('weight')),
  }),
  extraColumns: ['block_lists', 'taxonomy_lists'],
  extraBinds: (values) => [nullableJsonArray(values.blockLists), nullableJsonArray(values.taxonomyLists)],
  modelFromValues: (mode, values, error) => ({
    mode,
    error: error || undefined,
    name: values.name,
    slug: values.slug,
    weight: values.weight,
    blueprint: values.blueprint,
    selectedBlocks: values.blockLists,
    selectedTaxonomies: values.taxonomyLists,
  }),
  modelFromRow: (mode, row) => ({
    mode,
    id: row.id,
    name: row.name,
    slug: row.slug,
    weight: String(row.weight),
    blueprint: row.blueprint,
    selectedBlocks: parseStringArray(row.block_lists),
    selectedTaxonomies: parseStringArray(row.taxonomy_lists),
  }),
  modelFromConfig: (config, slug) => {
    const blueprint = config.blueprint[slug];
    if (!blueprint) return null;
    return {
      mode: 'view',
      name: slug,
      slug,
      weight: '',
      blueprint: JSON.stringify(blueprint, null, 2),
      selectedBlocks: config.blockLists[slug] ?? [],
      selectedTaxonomies: config.taxonomyLists[slug] ?? [],
    };
  },
  decorate: async (c, model) => {
    const [config, taxonomies] = await Promise.all([
      resolveCmsConfig(c.env),
      c.env.DB.prepare('SELECT slug, name FROM taxonomies ORDER BY name ASC').all<{ slug: string; name: string }>(),
    ]);
    const selectedBlocks = new Set(model.selectedBlocks ?? []);
    const selectedTaxonomies = new Set(model.selectedTaxonomies ?? []);
    const available = availableTaxonomies(config, taxonomies.results);

    // In view mode the config/plugin-owned entries stay disabled; with extend
    // permission the remaining checkboxes become editable additions.
    const lockAll = model.mode === 'view' && !model.canExtend;
    const lockedBlocks = new Set(model.lockedBlocks ?? []);
    const lockedTaxonomies = new Set(model.lockedTaxonomies ?? []);

    // Union available with selected so a stored value still shows even if its
    // definition is missing from the current config.
    const blockSlugs = [...new Set([...Object.keys(config.blocks), ...selectedBlocks])];
    const taxonomyBySlug = new Map(available.map((taxonomy) => [taxonomy.slug, taxonomy.name]));
    const taxonomySlugs = [...new Set([...available.map((taxonomy) => taxonomy.slug), ...selectedTaxonomies])];

    return {
      ...model,
      blockOptions: blockSlugs.map((slug) => ({
        value: slug,
        label: slug,
        checked: selectedBlocks.has(slug),
        disabled: lockAll || lockedBlocks.has(slug),
      })),
      taxonomyOptions: taxonomySlugs.map((slug) => ({
        value: slug,
        label: taxonomyBySlug.get(slug) || slug,
        checked: selectedTaxonomies.has(slug),
        disabled: lockAll || lockedTaxonomies.has(slug),
      })),
    };
  },
  extension: {
    decorateViewModel: async (c, config, slug, model) => {
      if (!(await userCan(c, 'pagetype:write'))) return model;
      const current = (await loadPageTypeExtensions(c.env))[slug] ?? { blocks: [], taxonomies: [] };
      const extensionBlocks = new Set(current.blocks);
      const extensionTaxonomies = new Set(current.taxonomies);
      return {
        ...model,
        canExtend: true,
        lockedBlocks: (config.blockLists[slug] ?? []).filter((entry) => !extensionBlocks.has(entry)),
        lockedTaxonomies: (config.taxonomyLists[slug] ?? []).filter((entry) => !extensionTaxonomies.has(entry)),
      };
    },
    save: async (c, config, slug, values) => {
      const [extensions, taxonomies] = await Promise.all([
        loadPageTypeExtensions(c.env),
        c.env.DB.prepare('SELECT slug, name FROM taxonomies ORDER BY name ASC').all<{ slug: string; name: string }>(),
      ]);
      const current = extensions[slug] ?? { blocks: [], taxonomies: [] };
      const knownBlocks = new Set(Object.keys(config.blocks));
      const knownTaxonomies = new Set(availableTaxonomies(config, taxonomies.results).map((taxonomy) => taxonomy.slug));
      // Config/plugin-owned entries never enter the extension, so unchecking
      // them (or replaying a stale form) cannot shrink the base lists.
      const lockedBlocks = new Set((config.blockLists[slug] ?? []).filter((entry) => !current.blocks.includes(entry)));
      const lockedTaxonomies = new Set((config.taxonomyLists[slug] ?? []).filter((entry) => !current.taxonomies.includes(entry)));
      const extension = {
        blocks: [...new Set(values.blockLists)].filter((entry) => knownBlocks.has(entry) && !lockedBlocks.has(entry)),
        taxonomies: [...new Set(values.taxonomyLists)].filter((entry) => knownTaxonomies.has(entry) && !lockedTaxonomies.has(entry)),
      };
      await savePageTypeExtension(c.env, slug, extension);
      logAudit(c, 'page_type.extend', 'page_type', slug, { blocks: extension.blocks, taxonomies: extension.taxonomies });
    },
  },
});

// ── Block types ───────────────────────────────────────────────────────────────

export const blockTypesRoutes = dbTypeRoutes<DbTypeRow, BaseTypeFormValues>({
  table: 'block_types',
  permission: 'blocktype:write',
  audit: 'block_type',
  copy: {
    routeBase: '/admin/block_types',
    title: 'Block Types',
    singular: 'Block Type',
    translationKey: 'block_types',
    description: 'Reusable block definitions. Database blocks are editable here; config-file and plugin blocks are read-only.',
    formTemplate: '/templates/block-type-form.json',
  },
  configSlugs: cmsConfig.blocks,
  resolvedSlugs: (config) => Object.keys(config.blocks),
  manifestTypes: (source) => source.contentTypes?.blocks,
  listRows: listDbBlockTypes,
  formValues: (form) => ({
    name: str(form.get('name')),
    slug: str(form.get('slug')),
    blueprint: str(form.get('blueprint')),
    weight: str(form.get('weight')),
  }),
  extraColumns: [],
  extraBinds: () => [],
  modelFromValues: (mode, values, error) => ({
    mode,
    error: error || undefined,
    name: values.name,
    slug: values.slug,
    weight: values.weight,
    blueprint: values.blueprint,
  }),
  modelFromRow: (mode, row) => ({
    mode,
    id: row.id,
    name: row.name,
    slug: row.slug,
    weight: String(row.weight),
    blueprint: row.blueprint,
  }),
  modelFromConfig: (config, slug) => {
    const blueprint = config.blocks[slug];
    if (!blueprint) return null;
    return {
      mode: 'view',
      name: slug,
      slug,
      weight: '',
      blueprint: JSON.stringify(blueprint, null, 2),
    };
  },
  decorate: async (_c, model) => model,
});
