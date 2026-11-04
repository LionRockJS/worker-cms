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
  PluginAuth,
} from './types';
import type { LivePageSnapshot } from '../../../core/publish/adapter';
import type { AppContext } from '../../../core/http/context';
import { authenticatePlugin, forbiddenPageType, forbiddenPageTypeBody } from './auth';
import { recordPageReads, recordRead, recordTagReads } from '../../../core/http/access-log';
import { countPageMetadata } from '../../../core/db/count-metadata';
import { pluginReadActor as apiActor } from './read-audit';
import {
  asFiniteNumber,
  asPositiveSafeInteger,
  coerceLect,
  LISTABLE_PAGE_FIELDS,
  pageTagsByPageId,
  parseApiSearchCriteria,
  requestedSearchPageTypes,
  serializePage,
  serializePartialPage,
  stringList,
  versionAction,
} from './serialize';
import { createPages } from './create';
import type { HookPage } from '../hooks';
import { emitPluginHooks } from './hooks';
import { chineseSearchVariants } from '../../../core/db/chinese';
import { advancedSearchOperator, advancedSearchOrder, advancedSearchSort, performAdvancedSearch } from '../../../core/db/search';
import { blueprintToLect, mergeLects, safeParseLect, stringifyLect } from '../../../core/db/lect';
import { resolveCmsConfig } from '../../../core/db/content-config';
import { withDraftMetadata } from '../../../core/db/page-logic';
import { ensureUniqueDraftSlug } from '../../../core/db/admin-queries';
import { slugify } from '../../../core/http/forms';
import { pageTypeScopeAllows } from '../page-types';
import { liveMapForDraftPages, publishPagesToTargets } from '../../../core/publish';
import { deletePluginPages } from '../page-delete-evidence';
import { duplicatePluginPages } from '../page-duplicate-evidence';
import { notifyPageSaved } from '../../../core/db/page-store';
import { capturePluginPageMutationAuthority, readPluginPageUpdateSources, commitPluginPageUpdates, type PluginPageUpdate, type PluginPageUpdateDenial } from '../page-update-evidence';

const MAX_BATCH = 100;
const MAX_LIST_BATCH_QUERIES = 20;
const MAX_LIST_BATCH_PAGES = 500;
const PAGE_TYPE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
const TAXONOMY_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
// A top-level lect scalar the list route may filter on. Interpolated into the
// JSON path literal, so it must never admit quotes, dots or brackets.
const LECT_FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const NUMERIC_BOUND = /^-?\d+(\.\d+)?$/;

function rangeBound(value: string): string | number {
  return NUMERIC_BOUND.test(value) ? Number(value) : value;
}
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
  field: { key: string; values: string[] } | null;
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

/** Live metadata can belong to a different type than its draft counterpart. */
function liveSourceRefusal(c: AppContext, auth: PluginAuth, liveMap: Map<string, LivePageSnapshot> | null): Response | null {
  for (const page of liveMap?.values() ?? []) {
    if (page.page_type === undefined) return c.json({ error: 'live_source_unavailable' }, 503, { 'Cache-Control': 'no-store' });
    if (!pageTypeScopeAllows(auth.readableTypes, page.page_type ?? 'default')) return c.json({ error: 'forbidden_live_source' }, 403, { 'Cache-Control': 'no-store' });
  }
  return null;
}

/** Announces a read of one known page type. Used where the response may be a
 *  column projection, so the rows cannot be trusted to carry page_type. */
function announceTypeRead(
  c: AppContext,
  pluginId: string,
  pageType: string,
  rows: ReadonlyArray<{ id?: number; uuid?: string }>,
): void {
  recordRead({
    action: 'page.read',
    kind: 'page_type',
    key: pageType,
    targetType: 'page',
    ids: rows.map((row) => row.id).filter((id): id is number => typeof id === 'number').map(String),
    count: rows.length,
    actor: apiActor(c, pluginId),
    uuidById: Object.fromEntries(rows.filter(row => row.id !== undefined && row.uuid).map(row => [String(row.id), row.uuid!])),
  });
}

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

  // Optional top-level scalar filter: field_key=status&field_value=issued
  // or field_key=status&field_values=issued,acknowledged. Values compare as
  // text, which is how editor and Plugin API writes store lect attributes.
  const fieldKey = (c.req.query('field_key') ?? '').trim();
  const fieldValue = (c.req.query('field_value') ?? '').trim();
  const fieldValues = [
    ...(fieldValue ? [fieldValue] : []),
    ...stringList(c.req.query('field_values')),
  ].filter((value, index, values) => values.indexOf(value) === index);
  if ((fieldKey && fieldValues.length === 0) || (!fieldKey && fieldValues.length > 0)) {
    return c.json({ error: 'field_key_and_value_required_together' }, 400);
  }
  if (fieldKey && !LECT_FIELD_KEY.test(fieldKey)) {
    return c.json({ error: 'invalid_field_key' }, 400);
  }
  if (fieldValues.length > 50) {
    return c.json({ error: 'too_many_field_values' }, 400);
  }

  // Optional inclusive range on one top-level scalar:
  // range_key=deadline&range_from=2026-01-01&range_to=2026-12-31. Numeric
  // bounds bind as numbers so they compare with numeric lect values; anything
  // else (ISO dates) compares as text.
  const rangeKey = (c.req.query('range_key') ?? '').trim();
  const rangeFrom = (c.req.query('range_from') ?? '').trim();
  const rangeTo = (c.req.query('range_to') ?? '').trim();
  if ((rangeKey && !rangeFrom && !rangeTo) || (!rangeKey && (rangeFrom || rangeTo))) {
    return c.json({ error: 'range_key_and_bound_required_together' }, 400);
  }
  if (rangeKey && !LECT_FIELD_KEY.test(rangeKey)) {
    return c.json({ error: 'invalid_range_key' }, 400);
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
  if (fieldKey) {
    // Inlined like the pointer path above, so a deployment that adds an
    // expression index on this field gets it used.
    const fieldPath = `'$.${fieldKey}'`;
    where += ` AND json_extract(lect, ${fieldPath}) IN (SELECT value FROM json_each(?))`;
    params.push(JSON.stringify(fieldValues));
  }
  if (rangeKey) {
    const rangePath = `'$.${rangeKey}'`;
    if (rangeFrom) {
      where += ` AND json_extract(lect, ${rangePath}) >= ?`;
      params.push(rangeBound(rangeFrom));
    }
    if (rangeTo) {
      where += ` AND json_extract(lect, ${rangePath}) <= ?`;
      params.push(rangeBound(rangeTo));
    }
  }
  if (q) {
    const terms = chineseSearchVariants(q).map((variant) => `%${variant.replaceAll(' ', '%')}%`);
    where += ` AND (${terms.map(() => '(name LIKE ? OR slug LIKE ? OR lect LIKE ?)').join(' OR ')})`;
    for (const term of terms) params.push(term, term, term);
  }

  // count=0 skips the COUNT(*) (a scan of the whole filtered set) — callers
  // paginating with offset only need the total once, on the first page.
  const skipCount = c.req.query('count') === '0';

  const select = fields ? [...new Set(['id', 'uuid', ...fields])].join(', ') : '*';
  const [rows, totalRow] = await Promise.all([
    c.env.DB.prepare(`SELECT ${select} FROM pages ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Page>(),
    skipCount
      ? Promise.resolve(null)
      : countPageMetadata(c.env.DB, where.replace(/^WHERE\s+/, ''), params, { types: [pageType] }),
  ]);

  // Checking live state needs a full draft row (its UUID is the stable
  // draft/live join key), so keep fields= projections lean and predictable.
  const liveMap = includeLiveStatus && !fields ? await liveMapForDraftPages(c.env, rows.results, apiActor(c, auth.pluginId)) : null;
  const liveRefusal = liveSourceRefusal(c, auth, liveMap);
  if (liveRefusal) return liveRefusal;
  const tagsMap = c.req.query('include_tags') === '1' && !fields
    ? await pageTagsByPageId(c.env.DB, rows.results.map((row) => row.id))
    : null;
  if (tagsMap) recordTagReads('tag.plugin-list', [...tagsMap.values()].flat(), apiActor(c, auth.pluginId));
  announceTypeRead(c, auth.pluginId, pageType, rows.results);
  return c.json({
    pages: fields
      ? rows.results.map((row) => serializePartialPage(row, fields))
      : rows.results.map((row) => ({
          ...serializePage(row),
          ...(liveMap ? { isPublished: liveMap.has(row.uuid) } : {}),
          ...(tagsMap ? { tags: tagsMap.get(row.id) ?? [] } : {}),
        })),
    total: skipCount ? -1 : (totalRow ?? 0),
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
    // Optional top-level scalar filter, same semantics as GET /pages
    // field_key/field_values: values compare as text.
    let field: PageListBatchQuery['field'] = null;
    if (input.field_key !== undefined || input.field_values !== undefined) {
      const fieldKey = typeof input.field_key === 'string' ? input.field_key.trim() : '';
      const fieldValues = Array.isArray(input.field_values) ? input.field_values : null;
      if (!LECT_FIELD_KEY.test(fieldKey) || !fieldValues || fieldValues.length === 0
        || fieldValues.length > 50 || fieldValues.some((value) => typeof value !== 'string')) {
        return c.json({ error: 'invalid_query' }, 400);
      }
      field = { key: fieldKey, values: [...new Set(fieldValues as string[])] };
    }
    if (keys.has(key)) return c.json({ error: 'duplicate_key', key }, 400);
    if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return forbiddenPageType(c, auth, pageType);
    keys.add(key);
    requestedPages += limit;
    queries.push({ key, pageType, limit, sort, order, groupBy, field });
  }
  if (requestedPages > MAX_LIST_BATCH_PAGES) {
    return c.json({ error: 'batch_too_large', max: MAX_LIST_BATCH_PAGES }, 413);
  }
  if (!queries.length) return c.json({ pages_by_type: {} });

  const results = await c.env.DB.batch<PageResourceRow>(queries.map((query) => {
    const sort = LIST_BATCH_SORTS[query.sort];
    // The field path is inlined (key validated by LECT_FIELD_KEY) so an
    // expression index on it can be used, as in GET /pages.
    const where = query.field
      ? `page_type = ? AND json_extract(lect, '$.${query.field.key}') IN (SELECT value FROM json_each(?))`
      : 'page_type = ?';
    const whereParams = query.field ? [query.pageType, JSON.stringify(query.field.values)] : [query.pageType];
    if (!query.groupBy) {
      return c.env.DB.prepare(
        `SELECT * FROM pages WHERE ${where} ORDER BY ${sort} ${query.order}, id ${query.order} LIMIT ?`,
      ).bind(...whereParams, query.limit);
    }
    const outerSort = LIST_BATCH_OUTER_SORTS[query.sort];
    return c.env.DB.prepare(
      `WITH selected AS (
         SELECT * FROM pages
         WHERE ${where}
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
    ).bind(...whereParams, query.limit, query.groupBy.tagTaxonomy);
  }));

  queries.forEach((query, index) => {
    if (!query.groupBy) return;
    recordTagReads('tag.plugin-group', results[index].results.flatMap(row => typeof row.resource_tag_id === 'number'
      ? [{ id: row.resource_tag_id, taxonomy_slug: row.resource_tag_taxonomy_slug ?? query.groupBy!.tagTaxonomy }] : []), apiActor(c, auth.pluginId));
  });
  queries.forEach((query, index) => announceTypeRead(c, auth.pluginId, query.pageType, results[index].results));
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

  recordPageReads('page.search', result.results, { actor: apiActor(c, auth.pluginId) });

  const tagsMap = (body as { include_tags?: unknown }).include_tags === true
    ? await pageTagsByPageId(c.env.DB, result.results.map((row) => row.id))
    : null;

  if (tagsMap) recordTagReads('tag.plugin-search', [...tagsMap.values()].flat(), apiActor(c, auth.pluginId));
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

  // One batched fan-out for the whole request rather than a publish per id: the
  // per-page helper costs about six round trips each, which a MAX_BATCH request
  // multiplies straight into the subrequest budget. Per-id outcomes are still
  // reported — the batched call hands back which pages it refused, and target
  // failures apply to the slice.
  const outcome = await publishPagesToTargets(c.env, publishable.map((item) => item.page), apiActor(c, auth.pluginId));
  if (outcome.refusedReason === 'writes_unavailable') {
    return c.json({ error: 'regulated_writes_unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
  const refusedIds = new Set(outcome.refused.map((page) => page.id));
  const regulatedIds = new Set(outcome.refusedRegulated.map((page) => page.id));

  const published: number[] = [];
  const hookPages: HookPage[] = [];
  for (const item of publishable) {
    if (refusedIds.has(item.page.id)) {
      errors.push({
        index: item.index,
        id: item.page.id,
        error: regulatedIds.has(item.page.id) ? 'regulated_publish_refused' : 'submission_publish_refused',
      });
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
  recordPageReads('page.read', [page], { actor: apiActor(c, auth.pluginId) });

  const tags = await c.env.DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?')
    .bind(id)
    .all<{ tag_id: number }>();
  const includeLiveStatus = c.req.query('include_live_status') === '1';
  const liveMap = includeLiveStatus ? await liveMapForDraftPages(c.env, [page], apiActor(c, auth.pluginId)) : null;
  const liveRefusal = liveSourceRefusal(c, auth, liveMap);
  if (liveRefusal) return liveRefusal;

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

  const authority = await capturePluginPageMutationAuthority(c, auth, 'create');
  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const result = await createPages(c, auth, authority, [body]);
  if (!result.ok) return c.json(result.body, result.status);
  recordPageReads('page.create-result', result.created, { actor: authority.actor });
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

  const authority = await capturePluginPageMutationAuthority(c, auth, 'create');
  const body = await c.req.json().catch(() => null) as { pages?: unknown } | null;
  const items = body && Array.isArray(body.pages) ? body.pages : null;
  if (!items) return c.json({ error: 'invalid_body' }, 400);
  if (items.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const result = await createPages(c, auth, authority, items.map((item) => (item ?? {}) as PageInput));
  if (!result.ok) return c.json(result.body, result.status);
  recordPageReads('page.create-result', result.created, { actor: authority.actor });
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
// Each request freezes at most 1,000 original sources and commits copies in
// guarded chunks of 100,
// and returns `next_cursor` (the last source id copied) when more remain. The
// caller re-POSTs with that cursor until `done` — so an arbitrarily large list
// duplicates across several bounded requests instead of one that times out.
pagesApiRoutes.post('/pages/duplicate', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const authority = await capturePluginPageMutationAuthority(c, auth, 'duplicate');
  const body = await c.req.json().catch(() => null) as DuplicateInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);
  return duplicatePluginPages(c, auth, authority, body);
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
  const authority = await capturePluginPageMutationAuthority(c, auth);
  const body = await c.req.json().catch(() => null) as { pages?: unknown } | null;
  const items = body && Array.isArray(body.pages) ? body.pages : null;
  if (!items) return c.json({ error: 'invalid_body' }, 400);
  if (items.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);
  const candidates: Array<{ index: number; id: number; input: PageInput }> = [];
  const errors: Array<{ index: number; error: string }> = [];
  const seenIds = new Set<number>();
  for (let index = 0; index < items.length; index++) {
    const raw = items[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push({ index, error: 'invalid_item' }); continue; }
    const input = raw as PageInput, id = asPositiveSafeInteger(input.id);
    if (id === null) { errors.push({ index, error: 'invalid_id' }); continue; }
    if (seenIds.has(id)) { errors.push({ index, error: 'duplicate_id' }); continue; }
    seenIds.add(id);
    if (!Object.hasOwn(input, 'lect') || !input.lect || typeof input.lect !== 'object' || Array.isArray(input.lect)) { errors.push({ index, error: 'invalid_lect' }); continue; }
    candidates.push({ index, id, input });
  }
  if (!candidates.length) return c.json({ updated: [], errors, count: 0 });
  const source = await readPluginPageUpdateSources(c, authority, candidates.map(row => row.id));
  const config = await resolveCmsConfig(c.env);
  const changes: PluginPageUpdate[] = [], denied: PluginPageUpdateDenial[] = [];
  for (const candidate of candidates) {
    const page = source.pages.find(row => row.id === candidate.id);
    if (!page) { errors.push({ index: candidate.index, error: 'not_found' }); continue; }
    if (!pageTypeScopeAllows(authority.allowed, page.page_type ?? '')) {
      errors.push({ index: candidate.index, error: 'forbidden_page_type' }); denied.push({ page, reason: 'forbidden_page_type' }); continue;
    }
    const merged = mergeLects(mergeLects(blueprintToLect(page.page_type ?? 'default', config.blueprint, config.defaultLanguage), safeParseLect(page.lect)), coerceLect(candidate.input.lect));
    changes.push({ before: page, next: { ...page, lect: stringifyLect(withDraftMetadata(merged, 0)) }, action: versionAction(candidate.input.version_action, 'update') });
  }
  const saved = await commitPluginPageUpdates(c, authority, source, changes, denied);
  emitPluginHooks(c, 'update', saved.map(page => ({ id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug })), auth.pluginId, { evidenceCommitted: true, actor: authority.actor });
  recordPageReads('page.update-result', saved, { actor: authority.actor });
  errors.sort((a,b) => a.index-b.index);
  return c.json({ updated: saved.map(serializePage), errors, count: saved.length });
});

// Update a page (PUT/PATCH are equivalent here — both partial-merge).
pagesApiRoutes.put('/pages/:id', (c) => updatePage(c));
pagesApiRoutes.patch('/pages/:id', (c) => updatePage(c));

async function updatePage(c: AppContext): Promise<Response> {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const authority = await capturePluginPageMutationAuthority(c, auth);
  const id = asPositiveSafeInteger(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const source = await readPluginPageUpdateSources(c, authority, [id]);
  const page = source.pages[0];
  if (!page) {
    await commitPluginPageUpdates(c, authority, source, []);
    return c.json({ error: 'not_found' }, 404);
  }
  if (!pageTypeScopeAllows(authority.allowed, page.page_type ?? '')) {
    await commitPluginPageUpdates(c, authority, source, [], [{ page, reason: 'forbidden_page_type' }]);
    return c.json(forbiddenPageTypeBody(auth, page.page_type ?? ''), 403);
  }
  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_body' }, 400);
  if (Object.hasOwn(body, 'if_lect')) {
    if (!body.if_lect || typeof body.if_lect !== 'object' || Array.isArray(body.if_lect)) return c.json({ error: 'invalid_if_lect' }, 400);
    if (page.lect !== stringifyLect(coerceLect(body.if_lect))) {
      await commitPluginPageUpdates(c, authority, source, [], [{ page, reason: 'version_precondition' }]);
      return c.json({ error: 'version_conflict' }, 409);
    }
  }
  let tags: number[] | undefined;
  if (Array.isArray(body.tags)) {
    tags = [...new Set(body.tags.map(Number).filter(Number.isFinite))];
    if (tags.length > 5000 || tags.some(tag => !Number.isSafeInteger(tag) || tag <= 0)) return c.json({ error: 'invalid_tags' }, 400);
  }
  const parentId = 'page_id' in body ? asFiniteNumber(body.page_id) : page.page_id;
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) return c.json({ error: 'invalid_page_id' }, 400);
  const config = await resolveCmsConfig(c.env);
  const pageType = page.page_type ?? 'default';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : page.name;
  const slug = typeof body.slug === 'string' && body.slug.trim() ? await ensureUniqueDraftSlug(c.env.DB, slugify(body.slug), id) : page.slug;
  const merged = 'lect' in body ? mergeLects(mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), safeParseLect(page.lect)), coerceLect(body.lect)) : safeParseLect(page.lect);
  const next: Page = { ...page, name, slug, lect: stringifyLect(withDraftMetadata(merged, 0)), weight: asFiniteNumber(body.weight) ?? page.weight,
    start: 'start' in body ? (typeof body.start === 'string' ? body.start : null) : page.start,
    end: 'end' in body ? (typeof body.end === 'string' ? body.end : null) : page.end,
    timezone: 'timezone' in body ? (typeof body.timezone === 'string' ? body.timezone : null) : page.timezone, page_id: parentId };
  const [saved] = await commitPluginPageUpdates(c, authority, source, [{ before: page, next, tags, action: versionAction(body.version_action, 'update') }]);
  await notifyPageSaved(c.env, id);
  emitPluginHooks(c, 'update', [{ id, uuid: page.uuid, page_type: pageType, name, slug }], auth.pluginId, { evidenceCommitted: true, actor: authority.actor });
  recordPageReads('page.update-result', [saved], { actor: authority.actor });
  return c.json({ page: serializePage(saved) });
}

// Static deletion routes must precede the single-ID catch-all.
for (const mode of ['batch','children'] as const) {
  pagesApiRoutes.delete(`/pages/${mode}`, async c => {
    const auth=await authenticatePlugin(c);if(auth instanceof Response)return auth;
    const authority=await capturePluginPageMutationAuthority(c,auth,'delete');
    const body=await c.req.json().catch(()=>null);
    return deletePluginPages(c,auth,authority,mode,body);
  });
}

// Pull live-only pages (published DB → draft pages) now instead of waiting
// for the next cron tick. A caller opts into this generic contract by declaring
// the `submission` hook in its manifest; no wildcard page-write scope is

pagesApiRoutes.delete('/pages/:id', async c => {
  const auth=await authenticatePlugin(c);if(auth instanceof Response)return auth;
  const authority=await capturePluginPageMutationAuthority(c,auth,'delete');
  return deletePluginPages(c,auth,authority,'single',c.req.param('id'));
});
