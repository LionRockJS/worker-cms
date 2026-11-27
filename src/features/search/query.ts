// Advanced-search request parsing and form view models. Only the search
// screen reads these; the query engine and blueprint path specs stay in
// core/db/search because plugins and jobs share them.

import type { Tag, Taxonomy } from '../../types';
import { num, strParam } from '../../core/http/forms';
import type { AdvancedSearchCriterion, AdvancedSearchOperator } from '../../core/db/search';

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

export function advancedSearchPageSize(value: string | null | undefined): number {
  return Math.min(Math.max(num(value, 20), 1), 100);
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
