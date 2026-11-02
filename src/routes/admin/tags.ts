import { saveTag,deleteTag,saveTaxonomy,deleteTaxonomy,updateTagWeights } from '../../core/pages/taxonomy-mutation-evidence';
import { contentMutationUnavailable } from '../../core/pages/mutation-evidence';
import { recordTagReads, recordTaxonomyReads } from '../../core/http/access-log';
// Tag and taxonomy management.

import { Hono } from 'hono';
import { taxonomyFormPage, taxonomiesPage } from '../../core/templates/taxonomies';
import type { TaxonomyFormData } from '../../core/templates/taxonomies';
import { tagFormPage, tagsPage } from '../../core/templates/tags';
import type { TagTaxonomyOption } from '../../core/templates/tags';
import {
  getLectLocalizedValue,
  mergeLects,
  postToLect,
  safeParseLect,
  stringifyLect,
} from '../../core/db/lect';
import type { Env, Variables, Tag, Taxonomy } from '../../types';
import {
  languageFromRequest,
  nullableStr,
  num,
  slugify,
  str,
} from '../../core/http/forms';
import type { FormValue } from '../../core/http/forms';
import { ensureDefaultLectName } from '../../core/db/page-logic';
import { contextActor, logAudit } from '../../core/db/audit';
import { requirePermission } from '../../core/auth/guards';
import { publishTagToTargets, publishTagsToTargets, removeTagFromTargets } from '../../core/publish';
import { renderPage } from '../../core/render/chrome';
import { userCan } from '../../core/auth/permissions';
import { resolveCmsConfig } from '../../core/db/content-config';
import { coreExtensions } from '../../core/extensions';
import { configOnlyTypes } from '../../core/db/type-admin';
import type { AppContext } from '../../core/http/context';

export const tagsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Tag types ─────────────────────────────────────────────────────────────────

tagsRoutes.get('/taxonomies', async (c) => {
  const [dbTaxonomies, contributors, config] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    coreExtensions().contentTypeContributors?.(c.env) ?? [],
    resolveCmsConfig(c.env),
  ]);
  const dbSlugs = new Set(dbTaxonomies.results.map((taxonomy) => taxonomy.slug));
  const configTaxonomies = configOnlyTypes(
    Object.keys(config.taxonomies),
    dbSlugs,
    contributors.map((source) => ({ name: source.name, types: source.contentTypes?.taxonomies })),
  ).map((taxonomy) => ({
    ...taxonomy,
    name: config.taxonomies[taxonomy.slug] ?? taxonomy.name,
  }));

  recordTaxonomyReads('taxonomy.list', [...dbTaxonomies.results, ...configTaxonomies]);
  return renderPage(c, taxonomiesPage, {
    dbTaxonomies: dbTaxonomies.results,
    configTaxonomies,
    canWrite: await userCan(c, 'taxonomy:write'),
  });
});

tagsRoutes.get('/taxonomies/new', async (c) => {
  if (!(await userCan(c, 'taxonomy:write'))) return c.redirect('/admin/taxonomies');
  return taxonomyForm(c);
});

tagsRoutes.get('/taxonomies/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  const config = await resolveCmsConfig(c.env);
  const name = config.taxonomies[slug];
  if (!name) return c.notFound();
  return taxonomyForm(c, { name, slug }, true);
});

tagsRoutes.post('/taxonomies', requirePermission('taxonomy:write'), async (c) => {
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  if (!name || !slug) return c.redirect('/admin/taxonomies/new?error=missing');
  try { await saveTaxonomy(c,{name,slug}); } catch(error) { return contentMutationUnavailable(c,error); }
  return c.redirect('/admin/taxonomies');
});

tagsRoutes.get('/taxonomies/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const taxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!taxonomy) return c.notFound();
  return taxonomyForm(c, taxonomy, !(await userCan(c, 'taxonomy:write')));
});

tagsRoutes.post('/taxonomies/:id', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  if(!name||!slug)return c.redirect(`/admin/taxonomies/${id}/edit?error=missing`);
  const existing = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!existing) return c.notFound();
  let moved:number[];
  try { moved=await saveTaxonomy(c,{name,slug},existing); } catch(error) { return contentMutationUnavailable(c,error); }
  if(moved.length) await publishTagsToTargets(c.env,moved,contextActor(c));
  return c.redirect('/admin/taxonomies');
});

tagsRoutes.post('/taxonomies/:id/delete', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const taxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!taxonomy) return c.notFound();
  let orphaned:number[];
  try { orphaned=await deleteTaxonomy(c,taxonomy); } catch(error) { return contentMutationUnavailable(c,error); }
  if(orphaned.length) await publishTagsToTargets(c.env,orphaned,contextActor(c));
  return c.redirect('/admin/taxonomies');
});

// ── Tags ─────────────────────────────────────────────────────────────────────

tagsRoutes.get('/tags', async (c) => {
  const filterTaxonomy = str(c.req.query('filter_taxonomy'));
  const [taxonomies, tags, canSync] = await Promise.all([
    tagTaxonomyOptions(c),
    listTags(c.env.DB, filterTaxonomy),
    userCan(c, 'tag:write'),
  ]);
  recordTagReads('tag.list', tags);
  return renderPage(c, tagsPage, {
    taxonomies,
    tags,
    filterTaxonomy,
    canSync,
    syncedCount: str(c.req.query('synced')),
    syncError: str(c.req.query('error')),
  });
});

tagsRoutes.get('/tags/new', async (c) => tagForm(c));

tagsRoutes.post('/tags/batch-weight', requirePermission('tag:write'), async (c) => {
  const body = await c.req.json<{ updates: { id: number; weight: number }[] }>();
  const { updates } = body;

  if (!Array.isArray(updates)) return c.json({ error: 'Invalid input' }, 400);

  const weights:Array<{id:number;weight:number}>=[];
  for(const update of updates){const id=Number(update?.id);const weight=Number(update?.weight);if(!Number.isSafeInteger(id)||id<=0||!Number.isFinite(weight))return c.json({error:'Invalid input'},400);weights.push({id,weight});}
  if(weights.length>5000||new Set(weights.map(u=>u.id)).size!==weights.length)return c.json({error:'Invalid input'},400);
  let changed:number[];
  try{changed=await updateTagWeights(c,weights);}catch(error){return contentMutationUnavailable(c,error);}
  if(changed.length)await publishTagsToTargets(c.env,changed,contextActor(c));

  return c.json({ success: true });
});

// Backfills the published tag catalogue. A database that published pages before
// the catalogue existed has tag links whose ids resolve to nothing there; edits
// push one tag at a time, this pushes the lot.
tagsRoutes.post('/tags/sync-published', requirePermission('tag:write'), async (c) => {
  const outcome = await publishTagsToTargets(c.env, undefined, contextActor(c));
  logAudit(c, 'tag.sync-published', 'tag', undefined, { count: outcome.count, failures: outcome.failures });
  const error = outcome.refusedReason === 'writes_unavailable' ? 'Publication is unavailable while regulated writes are contained'
    : outcome.refusedReason === 'classification_unavailable' ? 'Tag classification unavailable'
    : outcome.refusedCount ? `${outcome.refusedCount} regulated tags withheld`
    : outcome.failures.join(',');
  const status = error ? `error=${encodeURIComponent(error)}` : `synced=${outcome.count}`;
  return c.redirect(`/admin/tags?${status}`);
});

tagsRoutes.post('/tags', requirePermission('tag:write'), async (c) => {
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const weight = num(form.get('weight'), 5);
  const lect = postToLect(form, language);
  ensureDefaultLectName(lect, name);
  const taxonomySlug = nullableStr(form.get('taxonomy_slug'));
  const parentTagId = optionalNumericId(form.get('parent_tag'));
  let id:number;
  try{id=await saveTag(c,{name,slug,weight,taxonomy_slug:taxonomySlug,parent_tag:parentTagId,lect:stringifyLect(lect)});}catch(error){return contentMutationUnavailable(c,error);}
  await publishTagToTargets(c.env,id,contextActor(c));
  return c.redirect('/admin/tags');
});

tagsRoutes.get('/tags/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tag = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!tag) return c.notFound();
  return tagForm(c, tag);
});

tagsRoutes.post('/tags/:id', requirePermission('tag:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const weight = num(form.get('weight'), 5);
  const existing = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!existing) return c.notFound();
  const lect = mergeLects(safeParseLect(existing.lect), postToLect(form, language));
  ensureDefaultLectName(lect, name);
  const taxonomySlug = nullableStr(form.get('taxonomy_slug'));
  const parentTagId = optionalNumericId(form.get('parent_tag'));
  try{await saveTag(c,{name,slug,weight,taxonomy_slug:taxonomySlug,parent_tag:parentTagId,lect:stringifyLect(lect)},existing);}catch(error){return contentMutationUnavailable(c,error);}
  await publishTagToTargets(c.env,id,contextActor(c));
  return c.redirect('/admin/tags');
});

tagsRoutes.post('/tags/:id/delete', requirePermission('tag:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try{await deleteTag(c,id);}catch(error){return contentMutationUnavailable(c,error);}
  await removeTagFromTargets(c.env,id,contextActor(c));
  return c.redirect('/admin/tags');
});

async function taxonomyForm(c: AppContext, taxonomy?: TaxonomyFormData, readOnly = false) {
  if (taxonomy) recordTaxonomyReads('taxonomy.read', [taxonomy]);
  return renderPage(c, taxonomyFormPage, {
    taxonomy,
    readOnly,
  });
}

interface TagSchema {
  hasTaxonomySlug: boolean;
  hasWeight: boolean;
}

async function tagSchema(db: D1DatabaseClient): Promise<TagSchema> {
  const columns = await db.prepare('PRAGMA table_info(tags)').all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  return {
    hasTaxonomySlug: names.has('taxonomy_slug'),
    hasWeight: names.has('weight'),
  };
}

async function listTags(db: D1DatabaseClient, filterTaxonomy = ''): Promise<Tag[]> {
  const schema = await tagSchema(db);
  const weightExpr = schema.hasWeight ? 'tags.weight' : '5';
  const taxonomyExpr = schema.hasTaxonomySlug ? 'tags.taxonomy_slug' : 'taxonomies.slug';
  const taxonomyJoin = schema.hasTaxonomySlug ? '' : ' LEFT JOIN taxonomies ON taxonomies.id = tags.taxonomy_id';
  const select = `SELECT tags.id, tags.uuid, tags.created_at, tags.updated_at, tags.name, tags.slug,
    ${weightExpr} AS weight, ${taxonomyExpr} AS taxonomy_slug, tags.parent_tag, tags.lect
    FROM tags${taxonomyJoin}`;

  if (filterTaxonomy) {
    return (await db.prepare(`${select} WHERE ${taxonomyExpr} = ? ORDER BY weight ASC, name ASC`)
      .bind(filterTaxonomy)
      .all<Tag>()).results;
  }
  return (await db.prepare(`${select} ORDER BY weight ASC, name ASC`).all<Tag>()).results;
}

function optionalNumericId(value: FormValue): number | null {
  const raw = nullableStr(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = num(raw, 0);
  return id > 0 ? id : null;
}

async function tagTaxonomyOptions(c: AppContext): Promise<TagTaxonomyOption[]> {
  const [dbTaxonomies, contributors, config] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    coreExtensions().contentTypeContributors?.(c.env) ?? [],
    resolveCmsConfig(c.env),
  ]);
  const dbSlugs = new Set(dbTaxonomies.results.map((taxonomy) => taxonomy.slug));
  const configTaxonomies = configOnlyTypes(
    Object.keys(config.taxonomies),
    dbSlugs,
    contributors.map((source) => ({ name: source.name, types: source.contentTypes?.taxonomies })),
  ).map((taxonomy) => ({
    id: taxonomy.slug,
    name: config.taxonomies[taxonomy.slug] ?? taxonomy.name,
    sourceLabel: taxonomy.source === 'plugin'
      ? `plugin${taxonomy.pluginName ? `: ${taxonomy.pluginName}` : ''}`
      : 'config',
  }));

  recordTaxonomyReads('taxonomy.options', [...dbTaxonomies.results, ...configTaxonomies.map(row => ({ slug: row.id }))]);
  return [
    ...dbTaxonomies.results.map((taxonomy) => ({
      id: taxonomy.slug,
      name: taxonomy.name,
    })),
    ...configTaxonomies,
  ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function tagForm(c: AppContext, tag?: Tag) {
  const [taxonomies, config] = await Promise.all([
    tagTaxonomyOptions(c),
    resolveCmsConfig(c.env),
  ]);
  const language = languageFromRequest(c, undefined, config);
  if (tag) recordTagReads('tag.read', [tag]);
  const lect = safeParseLect(tag?.lect);
  const rawTranslatedName = getLectLocalizedValue(lect, 'name', language);
  const translatedName = language === config.defaultLanguage ? rawTranslatedName || tag?.name || '' : rawTranslatedName;
  const defaultTranslatedName = getLectLocalizedValue(lect, 'name', config.defaultLanguage) || tag?.name || '';
  const translatedPlaceholder = language === config.defaultLanguage ? '' : defaultTranslatedName;
  const selectedParent = { id: '', label: '' };
  if (tag?.parent_tag) {
    const parent = await c.env.DB.prepare('SELECT id, name, lect, taxonomy_slug FROM tags WHERE id = ?')
      .bind(tag.parent_tag)
      .first<Tag>();
    if (parent) {
      recordTagReads('tag.parent-option', [parent]);
      selectedParent.id = String(parent.id);
      selectedParent.label = getLectLocalizedValue(safeParseLect(parent.lect), 'name', config.defaultLanguage) || parent.name;
    }
  }
  return renderPage(c, tagFormPage, {
    tag,
    language,
    languages: config.languages,
    translatedName,
    translatedPlaceholder,
    taxonomies,
    selectedParent,
  });
}
