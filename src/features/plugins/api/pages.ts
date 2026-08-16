// Page read/write for /__cms: list, search, get, create, update, duplicate,
// publish and delete.
//
// NOTE on ordering: Hono matches in registration order, so the static
// /pages/* paths (batch, children, search, publish, duplicate) must stay ahead
// of the /pages/:id catch-alls for PATCH and DELETE. test/cms-api-routes.test.ts
// pins that.

import { Hono } from 'hono';
import type { Env, Variables, Page } from '../../../types';
import type {
  AdvancedSearchInput,
  ApiPage,
  ApiPageResourceCollection,
  ApiPageResourceTag,
  DuplicateInput,
  PageInput,
  PageListBatchInput,
} from './types';
import type { AppContext } from '../../../core/http/context';
import { authenticatePlugin, forbiddenPageType } from './auth';
import {
  asFiniteNumber,
  asPositiveSafeInteger,
  coerceLect,
  collectionWhere,
  LISTABLE_PAGE_FIELDS,
  pageTagsByPageId,
  parseApiSearchCriteria,
  requestedSearchPageTypes,
  serializePage,
  serializePartialPage,
  stringList,
  versionAction,
} from './serialize';
import {
  actingUserId,
  allocateSlug,
  bulkPageInsertStatements,
  bulkPageUpdateStatements,
  cmsId,
  cmsTimestamp,
  createPages,
  existingSlugSet,
  generatedPageVersionIds,
} from './create';
import type { HookPage } from '../hooks';
import { checkCreateLimits, createCandidate } from '../limits';
import { freeReservation, reservePageCreates } from '../../services';
import { emitPluginHook, emitPluginHooks } from './hooks';
import { chineseSearchVariants } from '../../../core/db/chinese';
import { advancedSearchOperator, advancedSearchOrder, advancedSearchSort, performAdvancedSearch } from '../../../core/db/search';
import { blueprintToLect, mergeLects, safeParseLect, stringifyLect } from '../../../core/db/lect';
import { resolveCmsConfig } from '../../../core/db/content-config';
import { withDraftMetadata } from '../../../core/db/page-logic';
import { ensureUniqueDraftSlug, savePageVersion, trashDraftPage, trashDraftPages } from '../../../core/db/admin-queries';
import { slugify } from '../../../core/http/forms';
import { pageTypeScopeAllows } from '../page-types';
import { liveMapForDraftPages, publishPageToTargets, unpublishPageFromTargets, unpublishPagesFromTargets } from '../../../core/publish';
import { notifyPageSaved, setDraftPageTags } from '../../../core/db/page-store';

const DUPLICATE_BATCH = 100;
const DUPLICATE_MAX_PER_CALL = 1000;
const DELETE_CHILDREN_BATCH = 100;
const DELETE_CHILDREN_MAX_PER_CALL = 1000;

const MAX_BATCH = 100;
const MAX_LIST_BATCH_QUERIES = 20;
const MAX_LIST_BATCH_PAGES = 500;
const PAGE_TYPE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
const TAXONOMY_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
const LIST_BATCH_SORTS = {
  weight: 'weight',
  name: 'name COLLATE NOCASE',
  created_at: 'created_at',
  updated_at: 'updated_at',
  published_at: 'COALESCE(start, created_at)',
} as const;
const LIST_BATCH_OUTER_SORTS = {
  weight: 'p.weight',
  name: 'p.name COLLATE NOCASE',
  created_at: 'p.created_at',
  updated_at: 'p.updated_at',
  published_at: 'COALESCE(p.start, p.created_at)',
} as const;

interface PageListBatchGroupBy {
  tagTaxonomy: string;
  includeUntagged: boolean;
}

interface PageListBatchQuery {
  key: string;
  pageType: string;
  limit: number;
  sort: keyof typeof LIST_BATCH_SORTS;
  order: 'ASC' | 'DESC';
  groupBy: PageListBatchGroupBy | null;
}

interface PageResourceRow extends Page {
  resource_tag_id?: number | null;
  resource_tag_slug?: string | null;
  resource_tag_name?: string | null;
  resource_tag_weight?: number | null;
  resource_tag_taxonomy_slug?: string | null;
  resource_tag_parent_tag?: number | null;
  resource_tag_created_at?: string | null;
  resource_tag_updated_at?: string | null;
  resource_tag_lect?: string | null;
}

export const pagesApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pagesApiRoutes.get('/pages', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const pageType = (c.req.query('page_type') ?? '').trim();
  if (!pageType) return c.json({ error: 'page_type_required' }, 400);
  if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return forbiddenPageType(c, auth, pageType);

  const limit = Math.min(Math.max(asFiniteNumber(c.req.query('limit')) ?? 50, 1), 500);
  const offset = Math.max(asFiniteNumber(c.req.query('offset')) ?? 0, 0);
  const q = (c.req.query('q') ?? '').trim();
  // Optional parent filter: e.g. all `guest` pages belonging to one event.
  const parentId = asFiniteNumber(c.req.query('page_id'));

  // Optional column projection, e.g. fields=id — the same criteria/limit/offset
  // but without reading (or JSON-parsing) lect, which dominates the cost of
  // listing fat rows the caller only needs ids from. Whitelisted column names
  // only, so interpolating them into the SELECT is safe.
  const fieldsParam = (c.req.query('fields') ?? '').trim();
  const includeLiveStatus = c.req.query('include_live_status') === '1';
  let fields: string[] | null = null;
  if (fieldsParam) {
    fields = [...new Set(fieldsParam.split(',').map((field) => field.trim()).filter(Boolean))];
    if (!fields.length || fields.some((field) => !LISTABLE_PAGE_FIELDS.has(field))) {
      return c.json({ error: 'invalid_fields' }, 400);
    }
  }

  // Optional pointer filter: pointer_key=mail_list&pointer_value=123
  // or pointer_key=mail_list&pointer_values=123,456.
  const pointerKey = (c.req.query('pointer_key') ?? '').trim();
  const pointerValue = (c.req.query('pointer_value') ?? '').trim();
  const pointerValuesParam = (c.req.query('pointer_values') ?? '').trim();
  const pointerValues = [
    ...(pointerValue ? [pointerValue] : []),
    ...pointerValuesParam.split(',').map((value) => value.trim()).filter(Boolean),
  ].filter((value, index, values) => values.indexOf(value) === index);
  if ((pointerKey && pointerValues.length === 0) || (!pointerKey && pointerValues.length > 0)) {
    return c.json({ error: 'pointer_key_and_value_required_together' }, 400);
  }
  if (pointerKey && !/^[a-z0-9_-]+$/i.test(pointerKey)) {
    return c.json({ error: 'invalid_pointer_key' }, 400);
  }
  if (pointerValues.length > 500) {
    return c.json({ error: 'too_many_pointer_values' }, 400);
  }

  // Optional direct lookup: ids=1,2&slugs=a,b matches pages whose id OR slug is
  // listed — bulk import target resolution without one GET per row.
  const idsParam = stringList(c.req.query('ids'));
  const slugsParam = stringList(c.req.query('slugs'));
  if (idsParam.length > 500 || slugsParam.length > 500) {
    return c.json({ error: 'too_many_lookup_values' }, 400);
  }
  if (idsParam.some((value) => !/^-?\d+$/.test(value))) {
    return c.json({ error: 'invalid_ids' }, 400);
  }
  const lookupIds = idsParam.map((value) => parseInt(value, 10));

  const params: unknown[] = [pageType];
  let where = 'WHERE page_type = ?';
  if (lookupIds.length || slugsParam.length) {
    // JSON-array binds (not one placeholder per value) keep a 500-entry lookup
    // within D1's 100-bound-parameters-per-query limit.
    const parts: string[] = [];
    if (lookupIds.length) {
      parts.push('id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(lookupIds));
    }
    if (slugsParam.length) {
      parts.push('slug IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(slugsParam));
    }
    where += ` AND (${parts.join(' OR ')})`;
  }
  if (parentId !== null) {
    where += ' AND page_id = ?';
    params.push(parentId);
  }
  if (pointerKey && pointerValues.length > 0) {
    // The JSON path is inlined as a literal (pointerKey is validated to
    // [a-z0-9_-] above): SQLite only uses the expression indexes from the
    // initial schema when the indexed expression appears verbatim in the
    // query — a bound parameter would force a full scan.
    const pointerPath = `'$._pointers.${pointerKey}'`;
    if (pointerValues.length === 1) {
      where += ` AND json_extract(lect, ${pointerPath}) = ?`;
    } else {
      where += ` AND json_extract(lect, ${pointerPath}) IN (${pointerValues.map(() => '?').join(',')})`;
    }
    params.push(...pointerValues);
  }
  if (q) {
    const terms = chineseSearchVariants(q).map((variant) => `%${variant.replaceAll(' ', '%')}%`);
    where += ` AND (${terms.map(() => '(name LIKE ? OR slug LIKE ? OR lect LIKE ?)').join(' OR ')})`;
    for (const term of terms) params.push(term, term, term);
  }

  // count=0 skips the COUNT(*) (a scan of the whole filtered set) — callers
  // paginating with offset only need the total once, on the first page.
  const skipCount = c.req.query('count') === '0';

  const select = fields ? fields.join(', ') : '*';
  const [rows, totalRow] = await Promise.all([
    c.env.DB.prepare(`SELECT ${select} FROM pages ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Page>(),
    skipCount
      ? Promise.resolve(null)
      : c.env.DB.prepare(`SELECT COUNT(*) AS total FROM pages ${where}`)
          .bind(...params)
          .first<{ total: number }>(),
  ]);

  // Checking live state needs a full draft row (its UUID is the stable
  // draft/live join key), so keep fields= projections lean and predictable.
  const liveMap = includeLiveStatus && !fields ? await liveMapForDraftPages(c.env, rows.results) : null;
  const tagsMap = c.req.query('include_tags') === '1' && !fields
    ? await pageTagsByPageId(c.env.DB, rows.results.map((row) => row.id))
    : null;
  return c.json({
    pages: fields
      ? rows.results.map((row) => serializePartialPage(row, fields))
      : rows.results.map((row) => ({
          ...serializePage(row),
          ...(liveMap ? { isPublished: liveMap.has(row.uuid) } : {}),
          ...(tagsMap ? { tags: tagsMap.get(row.id) ?? [] } : {}),
        })),
    total: skipCount ? -1 : (totalRow?.total ?? 0),
    limit,
    offset,
  });
});

// Several independent page-type lists in one authenticated host call and one
// D1 batch. Each SELECT keeps its own ORDER BY/LIMIT so SQLite can use the
// relevant page-type index rather than ranking a combined cross-type result.
pagesApiRoutes.post('/pages/list-batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as PageListBatchInput | null;
  const rawQueries = body && Array.isArray(body.queries) ? body.queries : null;
  if (!rawQueries) return c.json({ error: 'invalid_body' }, 400);
  if (rawQueries.length > MAX_LIST_BATCH_QUERIES) {
    return c.json({ error: 'batch_too_large', max: MAX_LIST_BATCH_QUERIES }, 413);
  }

  const queries: PageListBatchQuery[] = [];
  const keys = new Set<string>();
  let requestedPages = 0;
  for (const raw of rawQueries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'invalid_query' }, 400);
    }
    const input = raw as Record<string, unknown>;
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    const pageType = typeof input.page_type === 'string' ? input.page_type.trim() : '';
    const limit = typeof input.limit === 'number' && Number.isSafeInteger(input.limit) ? input.limit : 0;
    const sort = typeof input.sort === 'string' && input.sort in LIST_BATCH_SORTS
      ? input.sort as keyof typeof LIST_BATCH_SORTS
      : null;
    const orderValue = typeof input.order === 'string' ? input.order.toUpperCase() : '';
    const order = orderValue === 'ASC' || orderValue === 'DESC' ? orderValue : null;
    const rawGroupBy = input.group_by;
    let groupBy: PageListBatchGroupBy | null = null;
    if (rawGroupBy !== undefined) {
      if (!rawGroupBy || typeof rawGroupBy !== 'object' || Array.isArray(rawGroupBy)) {
        return c.json({ error: 'invalid_query' }, 400);
      }
      const groupInput = rawGroupBy as Record<string, unknown>;
      const tagTaxonomy = typeof groupInput.tag_taxonomy === 'string'
        ? groupInput.tag_taxonomy.trim()
        : '';
      const includeUntagged = groupInput.include_untagged === undefined
        ? false
        : groupInput.include_untagged;
      if (!TAXONOMY_TOKEN.test(tagTaxonomy) || typeof includeUntagged !== 'boolean') {
        return c.json({ error: 'invalid_query' }, 400);
      }
      groupBy = { tagTaxonomy, includeUntagged };
    }
    if (!PAGE_TYPE_TOKEN.test(key) || !PAGE_TYPE_TOKEN.test(pageType) || limit < 1 || limit > 500 || !sort || !order) {
      return c.json({ error: 'invalid_query' }, 400);
    }
    if (keys.has(key)) return c.json({ error: 'duplicate_key', key }, 400);
    if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return forbiddenPageType(c, auth, pageType);
    keys.add(key);
    requestedPages += limit;
    queries.push({ key, pageType, limit, sort, order, groupBy });
  }
  if (requestedPages > MAX_LIST_BATCH_PAGES) {
    return c.json({ error: 'batch_too_large', max: MAX_LIST_BATCH_PAGES }, 413);
  }
  if (!queries.length) return c.json({ pages_by_type: {} });

  const results = await c.env.DB.batch<PageResourceRow>(queries.map((query) => {
    const sort = LIST_BATCH_SORTS[query.sort];
    if (!query.groupBy) {
      return c.env.DB.prepare(
        `SELECT * FROM pages WHERE page_type = ? ORDER BY ${sort} ${query.order}, id ${query.order} LIMIT ?`,
      ).bind(query.pageType, query.limit);
    }
    const outerSort = LIST_BATCH_OUTER_SORTS[query.sort];
    return c.env.DB.prepare(
      `WITH selected AS (
         SELECT * FROM pages
         WHERE page_type = ?
         ORDER BY ${sort} ${query.order}, id ${query.order}
         LIMIT ?
       )
       SELECT p.*,
              resource_tag.id AS resource_tag_id,
              resource_tag.slug AS resource_tag_slug,
              resource_tag.name AS resource_tag_name,
              resource_tag.weight AS resource_tag_weight,
              resource_tag.taxonomy_slug AS resource_tag_taxonomy_slug,
              resource_tag.parent_tag AS resource_tag_parent_tag,
              resource_tag.created_at AS resource_tag_created_at,
              resource_tag.updated_at AS resource_tag_updated_at,
              resource_tag.lect AS resource_tag_lect
       FROM selected p
       LEFT JOIN (
         SELECT pt.page_id, t.id, t.slug, t.name, t.weight, t.taxonomy_slug,
                t.parent_tag, t.created_at, t.updated_at, t.lect
         FROM page_tags pt
         JOIN tags t ON t.id = pt.tag_id
         WHERE t.taxonomy_slug = ?
       ) resource_tag ON resource_tag.page_id = p.id
       ORDER BY ${outerSort} ${query.order}, p.id ${query.order},
                resource_tag.weight ASC, resource_tag.name COLLATE NOCASE ASC`,
    ).bind(query.pageType, query.limit, query.groupBy.tagTaxonomy);
  }));

  return c.json({
    pages_by_type: Object.fromEntries(queries.map((query, index) => [
      query.key,
      pageResourceCollection(results[index].results, query),
    ])),
  });
});

function pageResourceCollection(
  rows: PageResourceRow[],
  query: PageListBatchQuery,
): ApiPageResourceCollection {
  const pages = new Map<number, ApiPage>();
  const groupedPageIds = new Map<number, number[]>();
  const tags = new Map<number, ApiPageResourceTag>();
  const untaggedPageIds: number[] = [];

  for (const row of rows) {
    if (!pages.has(row.id)) pages.set(row.id, serializePage(row));
    if (!query.groupBy) continue;
    if (typeof row.resource_tag_id !== 'number') {
      if (query.groupBy.includeUntagged) untaggedPageIds.push(row.id);
      continue;
    }
    const tagId = row.resource_tag_id;
    if (!tags.has(tagId)) {
      tags.set(tagId, {
        id: tagId,
        slug: row.resource_tag_slug ?? '',
        name: row.resource_tag_name ?? '',
        weight: row.resource_tag_weight ?? 0,
        taxonomy_slug: row.resource_tag_taxonomy_slug ?? query.groupBy.tagTaxonomy,
        parent_tag: row.resource_tag_parent_tag ?? null,
        created_at: row.resource_tag_created_at ?? '',
        updated_at: row.resource_tag_updated_at ?? '',
        lect: safeParseLect(row.resource_tag_lect),
      });
    }
    const pageIds = groupedPageIds.get(tagId) ?? [];
    pageIds.push(row.id);
    groupedPageIds.set(tagId, pageIds);
  }

  const sortedTags = [...tags.values()].sort((left, right) =>
    left.weight - right.weight || left.name.localeCompare(right.name) || left.id - right.id);
  const groups: ApiPageResourceCollection['groups'] = sortedTags.map((tag) => ({
    tag,
    pages: (groupedPageIds.get(tag.id) ?? []).flatMap((id) => {
      const page = pages.get(id);
      return page ? [page] : [];
    }),
  }));
  if (query.groupBy?.includeUntagged && untaggedPageIds.length > 0) {
    groups.push({
      tag: null,
      pages: untaggedPageIds.flatMap((id) => {
        const page = pages.get(id);
        return page ? [page] : [];
      }),
    });
  }
  return { pages: [...pages.values()], groups };
}

// Advanced page search for plugins. Unlike GET /pages?q=..., this accepts
// multiple criteria with field paths and tag filters, matching the admin
// advanced-search semantics while staying scoped to the caller's read access.
pagesApiRoutes.post('/pages/search', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as AdvancedSearchInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const criteria = parseApiSearchCriteria(body.criteria);
  if (!criteria) return c.json({ error: 'invalid_criteria' }, 400);

  const config = await resolveCmsConfig(c.env);
  const requestedPageTypes = requestedSearchPageTypes(body);
  const pageTypes = requestedPageTypes.length === 0 || requestedPageTypes.includes('all')
    ? Object.keys(config.blueprint).filter((pageType) => pageTypeScopeAllows(auth.readableTypes, pageType))
    : requestedPageTypes;

  if (!pageTypes.length) return c.json({ error: 'page_type_required' }, 400);
  for (const pageType of pageTypes) {
    if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return forbiddenPageType(c, auth, pageType);
  }

  const limit = Math.min(Math.max(Math.trunc(asFiniteNumber(body.limit ?? body.pagesize) ?? 20), 1), 500);
  const page = Math.max(Math.trunc(asFiniteNumber(body.page) ?? 1), 1);
  const sort = advancedSearchSort(typeof body.sort === 'string' ? body.sort : undefined);
  const order = advancedSearchOrder(typeof body.order === 'string' ? body.order : undefined);
  const operator = advancedSearchOperator(typeof body.operator === 'string' ? body.operator : undefined);

  const result = await performAdvancedSearch(c.env.DB, pageTypes, criteria, operator, {
    limit,
    page,
    sort,
    order,
  });

  const tagsMap = (body as { include_tags?: unknown }).include_tags === true
    ? await pageTagsByPageId(c.env.DB, result.results.map((row) => row.id))
    : null;

  return c.json({
    pages: result.results.map((row) => ({
      ...serializePage(row),
      ...(tagsMap ? { tags: tagsMap.get(row.id) ?? [] } : {}),
    })),
    total: result.pagination.total,
    limit: result.pagination.limit,
    offset: (result.pagination.currentPage - 1) * result.pagination.limit,
    pagination: result.pagination,
    page_types: pageTypes,
  });
});

// Publish draft pages to every configured target. This is intentionally a
// bounded, id-only operation: the caller cannot supply a page type or snapshot
// to smuggle content across its manifest scope, and every id is resolved from
// this tenant's draft DB before the existing publish pipeline builds the live
// snapshot. Registered before /pages/:id so "publish" is never parsed as an id.
pagesApiRoutes.post('/pages/publish', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const rawIds = body && Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds) return c.json({ error: 'invalid_body' }, 400);
  if (rawIds.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const candidates: Array<{ index: number; id: number }> = [];
  const errors: Array<{ index: number; id?: number; error: string; page_type?: string; failed_targets?: string[] }> = [];
  const seenIds = new Set<number>();
  for (let index = 0; index < rawIds.length; index++) {
    const id = asPositiveSafeInteger(rawIds[index]);
    if (id === null) {
      errors.push({ index, error: 'invalid_id' });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ index, id, error: 'duplicate_id' });
      continue;
    }
    seenIds.add(id);
    candidates.push({ index, id });
  }

  const pageById = new Map<number, Page>();
  if (candidates.length) {
    const ids = candidates.map((candidate) => candidate.id);
    const pages = await c.env.DB.prepare(
      `SELECT * FROM pages WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<Page>();
    for (const page of pages.results) pageById.set(page.id, page);
  }

  const publishable: Array<{ index: number; page: Page }> = [];
  for (const candidate of candidates) {
    const page = pageById.get(candidate.id);
    if (!page) {
      errors.push({ index: candidate.index, id: candidate.id, error: 'not_found' });
      continue;
    }
    const pageType = page.page_type ?? '';
    if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) {
      errors.push({ index: candidate.index, id: candidate.id, error: 'forbidden_page_type', page_type: pageType });
      continue;
    }
    publishable.push({ index: candidate.index, page });
  }

  const published: number[] = [];
  const hookPages: HookPage[] = [];
  for (const item of publishable) {
    const outcome = await publishPageToTargets(c.env, item.page.id);
    if (!outcome) {
      errors.push({ index: item.index, id: item.page.id, error: 'not_found' });
      continue;
    }
    if (outcome.refused) {
      errors.push({ index: item.index, id: item.page.id, error: 'submission_publish_refused' });
      continue;
    }
    if (!outcome.targets.length) {
      errors.push({ index: item.index, id: item.page.id, error: 'no_publish_targets' });
      continue;
    }

    // Mirror the admin publish route: a partial target failure is observable
    // through the publish hook/audit, but is still returned as an error so a
    // caller such as EDM delivery cannot mint a link to incomplete live data.
    hookPages.push({
      id: item.page.id,
      uuid: item.page.uuid,
      page_type: item.page.page_type,
      name: item.page.name,
      slug: item.page.slug,
    });
    if (outcome.failures.length) {
      errors.push({
        index: item.index,
        id: item.page.id,
        error: 'publish_failed',
        failed_targets: outcome.failures,
      });
      continue;
    }
    published.push(item.page.id);
  }

  emitPluginHooks(c, 'publish', hookPages, auth.pluginId);
  errors.sort((a, b) => a.index - b.index);
  return c.json({ published, errors, count: published.length });
});

// Read a single page (scoped to the plugin's content types).
pagesApiRoutes.get('/pages/:id', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<Page>();
  if (!page) return c.json({ error: 'not_found' }, 404);
  if (!pageTypeScopeAllows(auth.readableTypes, page.page_type ?? '')) return forbiddenPageType(c, auth, page.page_type ?? '');

  const tags = await c.env.DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?')
    .bind(id)
    .all<{ tag_id: number }>();
  const includeLiveStatus = c.req.query('include_live_status') === '1';
  const liveMap = includeLiveStatus ? await liveMapForDraftPages(c.env, [page]) : null;

  return c.json({
    page: {
      ...serializePage(page),
      tags: tags.results.map((t) => t.tag_id),
      ...(liveMap ? { isPublished: liveMap.has(page.uuid) } : {}),
    },
  });
});

// Create a page.
pagesApiRoutes.post('/pages', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const result = await createPages(c, auth, [body]);
  if (!result.ok) return c.json(result.body, result.status);
  if (result.created.length) return c.json({ page: result.created[0] }, 201);
  const failure = result.errors[0];
  return c.json(
    { error: failure.error, page_type: failure.page_type, message: failure.message },
    failure.status as 400 | 403 | 409,
  );
});

// Batch-create pages (bulk import / bulk add-to-list). Each entry may carry its
// own page_type; all must be within the plugin's scope.
pagesApiRoutes.post('/pages/batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { pages?: unknown } | null;
  const items = body && Array.isArray(body.pages) ? body.pages : null;
  if (!items) return c.json({ error: 'invalid_body' }, 400);
  if (items.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const result = await createPages(c, auth, items.map((item) => (item ?? {}) as PageInput));
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    created: result.created,
    // Per-item errors keep the wire shape bulk callers already parse.
    errors: result.errors.map(({ index, error }) => ({ index, error })),
    count: result.created.length,
  });
});

// Server-side bulk clone of a parent's child pages.
//
// Built for "duplicate a guest list / event with all its guests" without the
// plugin streaming every child page out and back: the clone reads the source
// rows here (where D1 is local) and writes copies in the same Worker, applying
// one uniform lect transform — drop occurrence-specific blocks, then merge
// overrides (e.g. reset `status`, repoint `_pointers` at the new event/list).
//
// To bound work per request (and stay within the plugin's free-plan subrequest
// cap) it processes at most DUPLICATE_MAX_PER_CALL children, in DB.batch chunks,
// and returns `next_cursor` (the last source id copied) when more remain. The
// caller re-POSTs with that cursor until `done` — so an arbitrarily large list
// duplicates across several bounded requests instead of one that times out.
pagesApiRoutes.post('/pages/duplicate', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as DuplicateInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const pageType = typeof body.source_page_type === 'string' ? body.source_page_type.trim() : '';
  if (!pageType) return c.json({ error: 'source_page_type_required' }, 400);
  // Cloning creates pages of this type, so it needs write scope, not just read.
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return forbiddenPageType(c, auth, pageType);

  // Select the source pages by lect pointer (how guests etc. group) or parent id.
  const selector = collectionWhere(
    asFiniteNumber(body.source_page_id),
    typeof body.source_pointer_key === 'string' ? body.source_pointer_key.trim() : '',
    typeof body.source_pointer_value === 'string' ? body.source_pointer_value : '',
  );
  if (!selector.ok) return c.json({ error: selector.error }, 400);

  const targetParentId = asFiniteNumber(body.target_page_id);
  const overrideLect = coerceLect(body.lect);
  const dropKeys = Array.isArray(body.drop_lect)
    ? body.drop_lect.filter((key): key is string => typeof key === 'string')
    : [];

  const config = await resolveCmsConfig(c.env);
  const seed = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const usedIds = new Set<number>();

  let cursor = Math.max(asFiniteNumber(body.cursor) ?? 0, 0);

  // Quota pre-check for everything this request could still clone. All clones
  // share the target parent and any pointer overrides, so one candidate shape
  // covers the set. Per-pointer limits are only checkable when the override
  // lect repoints the pointer (the normal "duplicate into a new list" flow);
  // clones that inherit per-row source pointers are not gated here.
  const remainingRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM pages WHERE ${selector.sql} AND page_type = ? AND id > ?`,
  ).bind(...selector.params, pageType, cursor).first<{ total: number }>();
  const remaining = Math.min(remainingRow?.total ?? 0, DUPLICATE_MAX_PER_CALL);
  if (remaining > 0) {
    const candidate = createCandidate(pageType, targetParentId, overrideLect);
    const violation = await checkCreateLimits(c.env, Array.from({ length: remaining }, () => candidate));
    if (violation) return c.json({ error: 'limit_exceeded', violation }, 409);
  }

  // Charge for every clone this call will make; if the loop clones fewer
  // (failure mid-way, or sources trashed concurrently) the difference is
  // refunded below.
  const payer = actingUserId(c);
  const cloneCharge = remaining > 0
    ? await reservePageCreates(c.env, {
      pageTypes: [{ pageType, count: remaining }],
      payerUserId: payer,
      contributorId: auth.pluginId,
    })
    : freeReservation();
  if (!cloneCharge.ok) {
    return c.json(
      {
        error: cloneCharge.code,
        ...(cloneCharge.details ?? {}),
      },
      cloneCharge.status as 400 | 402,
    );
  }
  // Charged up front for `remaining` clones; whatever is not written is
  // refunded below as that fraction of the charge, in every currency it took.
  const chargedClones = cloneCharge.charged > 0 ? remaining : 0;
  let copied = 0;
  let done = false;
  try {
  // Loop internally in DB.batch chunks up to the per-request cap. Each chunk
  // commits on its own, so a copied row is never lost if a later chunk fails.
  while (copied < DUPLICATE_MAX_PER_CALL) {
    const take = Math.min(DUPLICATE_BATCH, DUPLICATE_MAX_PER_CALL - copied);
    // Fetch one row past the chunk to detect whether more sources remain.
    const sources = await c.env.DB.prepare(
      `SELECT * FROM pages WHERE ${selector.sql} AND page_type = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).bind(...selector.params, pageType, cursor, take + 1).all<Page>();

    const rows = sources.results;
    if (!rows.length) { done = true; break; }
    const hasMore = rows.length > take;
    const chunk = hasMore ? rows.slice(0, take) : rows;

    // Clones keep the SOURCE slug family, not a name-derived one: some types
    // (events-plugin guests) deliberately carry pseudonymous slugs so the
    // person's name never becomes a public identifier — re-deriving from the
    // name here would undo that.
    const usedSlugs = await existingSlugSet(c.env.DB, chunk.map((row) => slugify(row.slug) || slugify(row.name) || pageType));
    const statements: D1PreparedStatement[] = [];
    const hookPages: HookPage[] = [];
    const createdAt = cmsTimestamp();

    for (const row of chunk) {
      // Mirror createPage's lect pipeline, sourced from the existing page:
      // blueprint seed ← (source lect minus dropped keys) ← overrides.
      const source = safeParseLect(row.lect);
      for (const key of dropKeys) delete (source as Record<string, unknown>)[key];
      const merged = withDraftMetadata(mergeLects(seed, mergeLects(source, overrideLect)), 0);
      const lect = stringifyLect(merged);

      const id = cmsId(usedIds);
      const uuid = crypto.randomUUID();
      const slug = allocateSlug(slugify(row.slug) || slugify(row.name) || pageType, usedSlugs);

      statements.push(...bulkPageInsertStatements(c.env.DB, {
        id, uuid, createdAt, name: row.name, slug, weight: row.weight ?? 5, start: row.start,
        end: row.end, timezone: row.timezone, pageType, versionId: cmsId(usedIds),
        lect, parentId: targetParentId,
      }));

      hookPages.push({ id, uuid, page_type: pageType, name: row.name, slug });
    }

    await c.env.DB.batch(statements);
    emitPluginHooks(c, 'create', hookPages, auth.pluginId);

    copied += chunk.length;
    cursor = chunk[chunk.length - 1].id;
    if (!hasMore) { done = true; break; }
  }
  } catch (error) {
    if (chargedClones > copied) await cloneCharge.refund((chargedClones - copied) / chargedClones);
    throw error;
  }

  // Sources trashed concurrently → fewer clones than were charged for.
  if (chargedClones > copied) await cloneCharge.refund((chargedClones - copied) / chargedClones);

  return c.json({ count: copied, next_cursor: done ? null : cursor, done });
});

// Batch-update page lect (up to MAX_BATCH). This is the generic bulk mutation
// path for plugin jobs: authenticate/configure once, merge each partial lect,
// then commit every page + distinct version pair in one D1 transaction. Valid
// rows are applied while malformed, missing, duplicate, or forbidden rows are
// reported by input index, matching POST /pages/batch semantics.
//
// Page Sync notifications are intentionally omitted. They are a best-effort
// live-editor overlay and would turn a 100-page server-side batch back into 100
// Durable Object subrequests. Version history, audit, and hooks are preserved.
pagesApiRoutes.patch('/pages/batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { pages?: unknown } | null;
  const items = body && Array.isArray(body.pages) ? body.pages : null;
  if (!items) return c.json({ error: 'invalid_body' }, 400);
  if (items.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const candidates: Array<{ index: number; id: number; input: PageInput }> = [];
  const errors: Array<{ index: number; error: string }> = [];
  const seenIds = new Set<number>();
  for (let index = 0; index < items.length; index++) {
    const raw = items[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, error: 'invalid_item' });
      continue;
    }
    const input = raw as PageInput;
    const id = asPositiveSafeInteger(input.id);
    if (id === null) {
      errors.push({ index, error: 'invalid_id' });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ index, error: 'duplicate_id' });
      continue;
    }
    seenIds.add(id);
    if (!Object.hasOwn(input, 'lect') || !input.lect || typeof input.lect !== 'object' || Array.isArray(input.lect)) {
      errors.push({ index, error: 'invalid_lect' });
      continue;
    }
    candidates.push({ index, id, input });
  }

  if (!candidates.length) return c.json({ updated: [], errors, count: 0 });

  const ids = candidates.map((candidate) => candidate.id);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM pages WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<Page>();
  const pageById = new Map(rows.results.map((page) => [page.id, page]));
  const writable: Array<{ index: number; input: PageInput; page: Page }> = [];
  for (const candidate of candidates) {
    const page = pageById.get(candidate.id);
    if (!page) {
      errors.push({ index: candidate.index, error: 'not_found' });
      continue;
    }
    if (!pageTypeScopeAllows(auth.allowedTypes, page.page_type ?? '')) {
      errors.push({ index: candidate.index, error: 'forbidden_page_type' });
      continue;
    }
    writable.push({ index: candidate.index, input: candidate.input, page });
  }

  if (!writable.length) {
    errors.sort((a, b) => a.index - b.index);
    return c.json({ updated: [], errors, count: 0 });
  }

  const config = await resolveCmsConfig(c.env);
  const versionIds = await generatedPageVersionIds(c.env.DB, writable.length);
  const updatedAt = cmsTimestamp();
  const statements: D1PreparedStatement[] = [];
  const updated: ApiPage[] = [];
  const hookPages: HookPage[] = [];

  for (let index = 0; index < writable.length; index++) {
    const { input, page } = writable[index];
    const pageType = page.page_type ?? 'default';
    const mergedLect = mergeLects(
      mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), safeParseLect(page.lect)),
      coerceLect(input.lect),
    );
    const lect = stringifyLect(withDraftMetadata(mergedLect, 0));
    statements.push(...bulkPageUpdateStatements(c.env.DB, {
      id: page.id,
      versionId: versionIds[index],
      updatedAt,
      lect,
      action: versionAction(input.version_action, 'update'),
    }));
    updated.push(serializePage({ ...page, lect, updated_at: updatedAt }));
    hookPages.push({ id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug });
  }

  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    console.error('Plugin API batch update failed', error);
    return c.json({ error: 'update_failed' }, 500);
  }
  emitPluginHooks(c, 'update', hookPages, auth.pluginId);
  errors.sort((a, b) => a.index - b.index);
  return c.json({ updated, errors, count: updated.length });
});

// Update a page (PUT/PATCH are equivalent here — both partial-merge).
pagesApiRoutes.put('/pages/:id', (c) => updatePage(c));
pagesApiRoutes.patch('/pages/:id', (c) => updatePage(c));

async function updatePage(c: AppContext): Promise<Response> {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<Page>();
  if (!page) return c.json({ error: 'not_found' }, 404);
  if (!pageTypeScopeAllows(auth.allowedTypes, page.page_type ?? '')) return forbiddenPageType(c, auth, page.page_type ?? '');

  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  let expectedLect: string | null = null;
  if (Object.hasOwn(body, 'if_lect')) {
    if (!body.if_lect || typeof body.if_lect !== 'object' || Array.isArray(body.if_lect)) {
      return c.json({ error: 'invalid_if_lect' }, 400);
    }
    expectedLect = stringifyLect(coerceLect(body.if_lect));
  }

  const config = await resolveCmsConfig(c.env);
  const pageType = page.page_type ?? 'default';

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : page.name;
  const slug = typeof body.slug === 'string' && body.slug.trim()
    ? await ensureUniqueDraftSlug(c.env.DB, slugify(body.slug), id)
    : page.slug;

  // Merge: blueprint defaults ← stored lect ← incoming partial lect, so callers
  // can send just the fields they changed.
  const mergedLect = 'lect' in body
    ? mergeLects(
        mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), safeParseLect(page.lect)),
        coerceLect(body.lect),
      )
    : safeParseLect(page.lect);
  const lectVal = stringifyLect(withDraftMetadata(mergedLect, 0));

  const weight = asFiniteNumber(body.weight) ?? page.weight;
  const start = 'start' in body ? (typeof body.start === 'string' ? body.start : null) : page.start;
  const end = 'end' in body ? (typeof body.end === 'string' ? body.end : null) : page.end;
  const timezone = 'timezone' in body ? (typeof body.timezone === 'string' ? body.timezone : null) : page.timezone;
  const parentId = 'page_id' in body ? asFiniteNumber(body.page_id) : page.page_id;

  const update = expectedLect === null
    ? c.env.DB.prepare(
        'UPDATE pages SET name=?, slug=?, weight=?, start=?, end=?, timezone=?, lect=?, page_id=? WHERE id=?',
      ).bind(name, slug, weight, start, end, timezone, lectVal, parentId, id)
    : c.env.DB.prepare(
        'UPDATE pages SET name=?, slug=?, weight=?, start=?, end=?, timezone=?, lect=?, page_id=? WHERE id=? AND lect=?',
      ).bind(name, slug, weight, start, end, timezone, lectVal, parentId, id, expectedLect);
  const updateResult = await update.run();
  // Zero rows written is the conflict; more than one is not. `changes` counts
  // more than the row this statement names: the `pages_updated_at` trigger
  // performs its own UPDATE on the same row, and production D1 additionally
  // counts internal index writes (the same reason chargeCredits detects
  // success via RETURNING). Asserting exactly 1 therefore reported a spurious
  // conflict for an update that had already been written — and, because the
  // trigger only fires `WHEN old.updated_at < CURRENT_TIMESTAMP`, it did so
  // for every update except a second one landing inside the same second.
  if ((updateResult.meta?.changes ?? 0) < 1) {
    return c.json({ error: 'version_conflict' }, 409);
  }

  await savePageVersion(c.env.DB, id, lectVal, versionAction(body.version_action, 'update'));
  if ('tags' in body) await setDraftPageTags(c.env.DB, id, body.tags, true);

  await notifyPageSaved(c.env, id);

  const updated = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<Page>();
  emitPluginHook(c, 'update', { id, uuid: page.uuid, page_type: pageType, name, slug }, auth.pluginId);
  return c.json({ page: serializePage(updated!) });
}

// Batch soft-delete pages to trash. Accepts { ids: number[] } (up to MAX_BATCH).
// Pages not found are silently skipped. Returns the count actually trashed.
// Must be registered BEFORE DELETE /pages/:id so "batch" isn't matched as an id.
pagesApiRoutes.delete('/pages/batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const rawIds = body && Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds) return c.json({ error: 'invalid_body' }, 400);

  const ids = rawIds.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  if (!ids.length) return c.json({ ok: true, trashed: 0 });
  if (ids.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  // Enforce scope: all requested ids must be allowed page types.
  const ph = ids.map(() => '?').join(',');
  const { results: types } = await c.env.DB.prepare(
    `SELECT id, page_type FROM pages WHERE id IN (${ph})`,
  ).bind(...ids).all<{ id: number; page_type: string | null }>();

  for (const row of types) {
    if (!pageTypeScopeAllows(auth.allowedTypes, row.page_type ?? '')) return forbiddenPageType(c, auth, row.page_type ?? '');
  }

  const pages = await trashDraftPages(c.env.DB, ids);

  // Bulk unpublish: one round-trip per target per chunk, instead of a
  // 100-wide per-page fanout that made big batch deletes hang mid-way.
  await unpublishPagesFromTargets(c.env, pages).catch(() => {});
  emitPluginHooks(c, 'delete', pages, auth.pluginId);

  return c.json({ ok: true, trashed: pages.length });
});

// Server-side bulk soft-delete of a related collection of pages.
//
// Counterpart to POST /pages/duplicate, for "delete an event with all its
// guests" without the plugin first reading every child id and then deleting it
// in ≤MAX_BATCH chunks. The host finds the pages itself — by lect pointer (how
// guests group: `_pointers.mail_list`) or by parent page id — and trashes them
// in DB.batch chunks; trashDraftPages copies any number of rows to trash in a
// single batch, so each chunk is a couple of subrequests regardless of size.
//
// Bounded to DELETE_CHILDREN_MAX_PER_CALL per request: since trashed rows leave
// pages, a follow-up call simply picks up whatever remains, so the caller
// repeats while `done` is false. Registered BEFORE DELETE /pages/:id so
// "children" is not matched as an id.
//
// Unlike DELETE /pages/:id and /pages/batch this does NOT unpublish each child
// from publish targets — that per-page work is what makes a bulk delete slow,
// and child collections this targets (e.g. event guests) are not published.
pagesApiRoutes.delete('/pages/children', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    parent_page_id?: unknown; pointer_key?: unknown; pointer_value?: unknown; page_type?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const pageType = typeof body.page_type === 'string' ? body.page_type.trim() : '';
  if (!pageType) return c.json({ error: 'page_type_required' }, 400);
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return forbiddenPageType(c, auth, pageType);

  // Select the pages by lect pointer (how guests group) or parent page id.
  const selector = collectionWhere(
    asFiniteNumber(body.parent_page_id),
    typeof body.pointer_key === 'string' ? body.pointer_key.trim() : '',
    typeof body.pointer_value === 'string' ? body.pointer_value : '',
  );
  if (!selector.ok) return c.json({ error: selector.error }, 400);

  let trashed = 0;
  let done = false;
  const hookPages: HookPage[] = [];
  while (trashed < DELETE_CHILDREN_MAX_PER_CALL) {
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM pages WHERE ${selector.sql} AND page_type = ? ORDER BY id ASC LIMIT ?`,
    ).bind(...selector.params, pageType, DELETE_CHILDREN_BATCH).all<{ id: number }>();

    if (!results.length) { done = true; break; }
    const pages = await trashDraftPages(c.env.DB, results.map((row) => row.id));
    hookPages.push(...pages);
    trashed += results.length;
    if (results.length < DELETE_CHILDREN_BATCH) { done = true; break; }
  }

  // Audit + delete hooks run detached (waitUntil), so they never block the
  // response — the same best-effort path the per-id batch delete uses.
  emitPluginHooks(c, 'delete', hookPages, auth.pluginId);

  return c.json({ trashed, done });
});

// Pull live-only pages (published DB → draft pages) now instead of waiting
// for the next cron tick. A caller opts into this generic contract by declaring
// the `submission` hook in its manifest; no wildcard page-write scope is

pagesApiRoutes.delete('/pages/:id', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  // Read first so we can enforce scope before trashing.
  const existing = await c.env.DB.prepare('SELECT page_type FROM pages WHERE id = ?')
    .bind(id)
    .first<{ page_type: string | null }>();
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (!pageTypeScopeAllows(auth.allowedTypes, existing.page_type ?? '')) return forbiddenPageType(c, auth, existing.page_type ?? '');

  const page = await trashDraftPage(c.env.DB, id);
  if (!page) return c.json({ error: 'not_found' }, 404);

  await unpublishPageFromTargets(c.env, page.uuid, !!page.submission_origin);
  emitPluginHook(
    c,
    'delete',
    { id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug },
    auth.pluginId,
  );

  return c.json({ ok: true, id: page.id });
});
