// Advanced-search parsing, blueprint path-spec machinery, and SQL building.
// Shared by the search route and (for path specs) the CSV import/export helpers.

import { cmsConfig } from '../../cms-config';
import type { BlueprintEntry, CmsConfig } from '../../cms-config';
import type { Page, Tag, Taxonomy } from '../../types';
import { num, strParam } from '../http/forms';
import { chineseSearchVariants } from './chinese';
import { countPageMetadata } from './count-metadata';

export type AdvancedSearchOperator = 'AND' | 'OR' | 'NOT';

export interface AdvancedSearchCriterion {
  index: number;
  term: string;
  path: string;
  tags: string[];
}

export interface AdvancedSearchResult {
  results: Page[];
  pagination: {
    total: number;
    totalPages: number;
    currentPage: number;
    limit: number;
  };
}

export interface AdvancedSearchIdRow {
  id: number;
}

export type BlueprintPathKind = 'scalar' | 'localized' | 'pointer';

export interface BlueprintPathSpec {
  path: string;
  kind: BlueprintPathKind;
}

export function parseAdvancedSearchCriteria(url: string): AdvancedSearchCriterion[] {
  const params = new URL(url).searchParams;
  const criteria: AdvancedSearchCriterion[] = [];
  const indexes = new Set<number>();

  for (const key of params.keys()) {
    const match = key.match(/^(?:search|path|tags)(\d+)$/);
    if (match) indexes.add(parseInt(match[1], 10));
  }

  for (const index of [...indexes].sort((left, right) => left - right)) {
    const term = strParam(params.get(`search${index}`));
    const path = strParam(params.get(`path${index}`));
    const tags = params.getAll(`tags${index}`)
      .flatMap((value) => value.split(','))
      .map((tag) => tag.trim())
      .filter((tag) => /^\d+$/.test(tag));

    if (term || tags.length) {
      criteria.push({
        index,
        term,
        path,
        tags: Array.from(new Set(tags)),
      });
    }
  }

  return criteria;
}

export function advancedSearchOperator(value: string | null | undefined): AdvancedSearchOperator {
  const operator = strParam(value).toUpperCase();
  return operator === 'OR' || operator === 'NOT' ? operator : 'AND';
}

export function advancedSearchPageSize(value: string | null | undefined): number {
  return Math.min(Math.max(num(value, 20), 1), 100);
}

export function advancedSearchSort(value: string | null | undefined): string {
  const sort = strParam(value);
  return ['id', 'name', 'slug', 'weight', 'created_at', 'updated_at'].includes(sort) ? sort : 'updated_at';
}

export function advancedSearchOrder(value: string | null | undefined): 'ASC' | 'DESC' {
  return strParam(value).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

export function advancedSearchQueryString(
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
  pageSize: number,
  extras: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  params.set('operator', operator);
  params.set('pagesize', String(pageSize));

  for (const criterion of criteria) {
    params.set(`search${criterion.index}`, criterion.term);
    params.set(`path${criterion.index}`, criterion.path);
    for (const tag of criterion.tags) params.append(`tags${criterion.index}`, tag);
  }

  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined && String(value) !== '') params.set(key, String(value));
  }

  return params.toString();
}

export function advancedSearchPageTypes(config: CmsConfig = cmsConfig): string[] {
  return Object.keys(config.blueprint);
}

export function advancedSearchSelectedPageType(value: string | null | undefined, fallback = 'all', config: CmsConfig = cmsConfig): string {
  const pageTypes = advancedSearchPageTypes(config);
  const requested = strParam(value || fallback);
  return pageTypes.includes(requested) ? requested : 'all';
}

export function advancedSearchTargetPageTypes(selectedPageType: string, config: CmsConfig = cmsConfig): string[] {
  const pageTypes = advancedSearchPageTypes(config);
  return selectedPageType === 'all' ? pageTypes : [selectedPageType];
}

export function blueprintFieldPath(raw: string, prefix = ''): string {
  return raw.replace(prefix, '').split(':')[0].split('__').filter(Boolean).join('.');
}

export function childPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

export function collectBlueprintPathSpecs(entries: BlueprintEntry[], parentPath = ''): BlueprintPathSpec[] {
  const specs: BlueprintPathSpec[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) {
        specs.push({ path: childPath(parentPath, blueprintFieldPath(entry, '@')), kind: 'scalar' });
      } else if (entry.startsWith('*')) {
        specs.push({ path: childPath(parentPath, `_pointers.${blueprintFieldPath(entry, '*')}`), kind: 'pointer' });
      } else {
        specs.push({ path: childPath(parentPath, blueprintFieldPath(entry)), kind: 'localized' });
      }
      continue;
    }

    for (const [itemName, definitions] of Object.entries(entry)) {
      const itemPath = childPath(parentPath, `${itemName}[*]`);
      specs.push(...collectBlueprintPathSpecs(definitions, itemPath));
    }
  }

  return specs;
}

export function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

export function advancedSearchPathSpecs(pageTypes: string[], config: CmsConfig = cmsConfig): BlueprintPathSpec[] {
  const specs = pageTypes.flatMap((pageType) => collectBlueprintPathSpecs(config.blueprint[pageType] ?? []));
  const byPath = new Map<string, BlueprintPathSpec>();
  for (const spec of specs) byPath.set(spec.path, spec);
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export function advancedSearchPathOptions(pageTypes: string[], config: CmsConfig = cmsConfig): string[] {
  return advancedSearchPathSpecs(pageTypes, config).map((spec) => spec.path);
}

export function advancedSearchPathOptionsByPageType(config: CmsConfig = cmsConfig): Record<string, string[]> {
  const pageTypeOptions = Object.fromEntries(
    advancedSearchPageTypes(config).map((pageType) => [pageType, advancedSearchPathOptions([pageType], config)]),
  );
  return {
    all: uniqueSorted(Object.values(pageTypeOptions).flat()),
    ...pageTypeOptions,
  };
}

export function wildcardJsonPathParts(path: string): { beforePath: string; afterPath: string } | null {
  const wildcardMatch = path.match(/(.+?)\[\*\](.+)/i);
  if (!wildcardMatch) return null;

  return {
    beforePath: wildcardMatch[1].replace(/^\./, ''),
    afterPath: wildcardMatch[2].replace(/^\./, ''),
  };
}

export function sqliteJsonPath(path: string): string {
  const normalized = path.replace(/^\$?\.?/, '');
  if (!normalized) return '$';

  return `$${normalized.split('.').filter(Boolean).map((segment) => {
    const match = segment.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[\d+])?$/);
    if (match) return `.${match[1]}${match[2] ?? ''}`;
    return `.${JSON.stringify(segment)}`;
  }).join('')}`;
}

export function getPathValue(source: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current = source as Record<string, unknown> | undefined;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[segment] as Record<string, unknown> | undefined;
  }
  return current;
}

export function advancedSearchCondition(
  criterion: AdvancedSearchCriterion,
  pageAlias: string,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (criterion.term) {
    // A Chinese term also matches its Simplified/Traditional variants, so we OR
    // a LIKE per variant. Non-Chinese terms yield a single variant.
    const searchTerms = chineseSearchVariants(criterion.term)
      .map((variant) => `%${variant.replaceAll(' ', '%')}%`);
    const orGroup = (clause: string) =>
      searchTerms.length > 1 ? `(${searchTerms.map(() => clause).join(' OR ')})` : clause;

    if (criterion.path) {
      const wildcardParts = wildcardJsonPathParts(criterion.path);
      if (wildcardParts) {
        const beforePath = sqliteJsonPath(wildcardParts.beforePath);
        const afterPath = sqliteJsonPath(wildcardParts.afterPath);
        conditions.push(orGroup(`EXISTS (
          SELECT 1 FROM json_each(json_extract(${pageAlias}.lect, ?))
          WHERE json_extract(value, ?) LIKE ?
        )`));
        for (const term of searchTerms) params.push(beforePath, afterPath, term);
      } else {
        const path = sqliteJsonPath(criterion.path);
        conditions.push(orGroup(`json_extract(${pageAlias}.lect, ?) LIKE ?`));
        for (const term of searchTerms) params.push(path, term);
      }
    } else {
      conditions.push(orGroup(`(${pageAlias}.name LIKE ? OR ${pageAlias}.lect LIKE ?)`));
      for (const term of searchTerms) params.push(term, term);
    }
  }

  if (criterion.tags.length > 0) {
    const placeholders = criterion.tags.map(() => '?').join(',');
    conditions.push(`${pageAlias}.id IN (
      SELECT page_id FROM page_tags
      WHERE tag_id IN (${placeholders})
      GROUP BY page_id
      HAVING COUNT(DISTINCT tag_id) = ?
    )`);
    params.push(...criterion.tags, criterion.tags.length);
  }

  return { conditions, params };
}

export async function performAdvancedSearch(
  db: D1DatabaseClient,
  pageTypes: string[],
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
  options: {
    limit: number;
    page: number;
    sort: string;
    order: 'ASC' | 'DESC';
  },
): Promise<AdvancedSearchResult> {
  const { whereSql, baseParams } = advancedSearchWhere(pageTypes, criteria, operator);
  const total = await countPageMetadata(db, whereSql, baseParams, { types: pageTypes });
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  const currentPage = Math.min(options.page, totalPages);
  const currentOffset = (currentPage - 1) * options.limit;

  const pages = await db.prepare(
    `SELECT * FROM pages p
     WHERE ${whereSql}
     ORDER BY ${options.sort} ${options.order}, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, options.limit, currentOffset)
    .all<Page>();

  return {
    results: pages.results,
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: options.limit,
    },
  };
}

export function advancedSearchWhere(
  pageTypes: string[],
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
): { whereSql: string; baseParams: unknown[] } {
  // Bulk actions from ordinary page lists intentionally have no search
  // criteria: in that context an empty query means every page of the selected
  // type(s), including records outside the current pagination page.
  let searchCondition = criteria.length === 0 ? '1=1' : '1=0';
  let searchParams: unknown[] = [];
  const pageTypePlaceholders = pageTypes.map(() => '?').join(',');

  if (criteria.length > 0 && operator === 'NOT') {
    const base = advancedSearchCondition(criteria[0], 'p');
    const baseCondition = base.conditions.length ? `(${base.conditions.join(' AND ')})` : '1=1';
    const excludeConditions: string[] = [];
    const excludeParams: unknown[] = [];

    for (const criterion of criteria.slice(1)) {
      const exclusion = advancedSearchCondition(criterion, 'excluded');
      if (!exclusion.conditions.length) continue;
      excludeConditions.push(`(${exclusion.conditions.join(' AND ')})`);
      excludeParams.push(...exclusion.params);
    }

    searchCondition = baseCondition;
    searchParams = base.params;
    if (excludeConditions.length) {
      searchCondition += ` AND p.id NOT IN (
        SELECT excluded.id FROM pages excluded
        WHERE excluded.page_type IN (${pageTypePlaceholders}) AND (${excludeConditions.join(' OR ')})
      )`;
      searchParams.push(...pageTypes, ...excludeParams);
    }
  } else if (criteria.length > 0) {
    const criterionConditions: string[] = [];
    for (const criterion of criteria) {
      const condition = advancedSearchCondition(criterion, 'p');
      if (!condition.conditions.length) continue;
      criterionConditions.push(`(${condition.conditions.join(' AND ')})`);
      searchParams.push(...condition.params);
    }
    searchCondition = criterionConditions.length ? `(${criterionConditions.join(` ${operator} `)})` : '1=0';
  }

  const whereSql = `p.page_type IN (${pageTypePlaceholders}) AND ${searchCondition}`;
  const baseParams = [...pageTypes, ...searchParams];

  return { whereSql, baseParams };
}

export async function advancedSearchMatchingPageIds(
  db: D1DatabaseClient,
  pageTypes: string[],
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
): Promise<number[]> {
  const { whereSql, baseParams } = advancedSearchWhere(pageTypes, criteria, operator);
  const rows = await db.prepare(
    `SELECT p.id FROM pages p
     WHERE ${whereSql}
     ORDER BY p.id ASC`,
  )
    .bind(...baseParams)
    .all<AdvancedSearchIdRow>();

  return rows.results.map((row) => row.id);
}

export function advancedSearchFormCriteria(criteria: AdvancedSearchCriterion[], taxonomies: Taxonomy[], tags: Tag[]) {
  const formCriteria = criteria.length ? criteria : [{ index: 1, term: '', path: '', tags: [] }];

  return formCriteria.map((criterion) => ({
    ...criterion,
    tagGroups: taxonomies.map((taxonomy) => ({
      name: taxonomy.name,
      tags: tags
        .filter((tag) => tag.taxonomy_slug === taxonomy.slug)
        .map((tag) => ({
          id: tag.id,
          idString: String(tag.id),
          name: tag.name,
          selected: criterion.tags.includes(String(tag.id)),
        })),
    })).filter((group) => group.tags.length > 0),
  }));
}

export function advancedSearchTagGroups(taxonomies: Taxonomy[], tags: Tag[]) {
  return taxonomies.map((taxonomy) => ({
    name: taxonomy.name,
    tags: tags
      .filter((tag) => tag.taxonomy_slug === taxonomy.slug)
      .map((tag) => ({
        id: tag.id,
        idString: String(tag.id),
        name: tag.name,
      })),
  })).filter((group) => group.tags.length > 0);
}
