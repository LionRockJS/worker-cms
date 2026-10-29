// ============================================================
// Container classification.
//
// Which containers hold regulated data, and therefore which reads are recorded.
// Classification is per *container* — a page type, an R2 key prefix, a
// contributor, a table — never per row: a row-level test fails the moment a
// container that was clean starts holding regulated data, and it gives no
// defensible answer to "which systems contain ePHI?".
//
// Core owns this even though `runtime-content-types` is where database page
// types live, because that feature is optional and the compiled base types in
// content-config.ts exist without it. Classification has to work in either
// profile.
//
// Resolved once per request and cached alongside the role map. An empty table
// means every lookup misses, which is exactly what an install with no
// regulated data should pay for read logging: one query, no rows written.
// ============================================================

import type { Env } from '../../types';
import { requestContext } from '../http/request-context';

export type ContainerKind = 'page_type' | 'taxonomy' | 'media_prefix' | 'plugin' | 'table';
export type DataClass = 'pii' | 'phi';

export const CONTAINER_KINDS: readonly ContainerKind[] = [
  'page_type', 'taxonomy', 'media_prefix', 'plugin', 'table',
];
export const DATA_CLASSES: readonly DataClass[] = ['pii', 'phi'];

export interface DataClassRow {
  id: number;
  container_kind: string;
  container_key: string;
  class: string;
  note: string | null;
  created_at: string;
}

/** Exact matches keyed `kind:key`, plus the prefix entries kept in order so the
 *  longest (most specific) prefix wins. */
export interface DataClassMap {
  exact: Map<string, DataClass>;
  prefixes: Array<{ key: string; class: DataClass }>;
  size: number;
}

const EMPTY: DataClassMap = { exact: new Map(), prefixes: [], size: 0 };

function isDataClass(value: string): value is DataClass {
  return value === 'pii' || value === 'phi';
}

/** Resolves the classification map, cached for the rest of this request. */
export async function resolveDataClasses(env: Env): Promise<DataClassMap> {
  const context = requestContext.getStore();
  if (context?.dataClasses) return context.dataClasses;
  if (!env.DB) return EMPTY;

  const rows = await env.DB.prepare('SELECT container_kind, container_key, class FROM data_classes')
    .all<{ container_kind: string; container_key: string; class: string }>()
    // A database that has not run the data_classes migration must not take
    // every read surface down with it; it simply classifies nothing.
    .catch((error) => {
      console.error('data_classes lookup failed', error);
      return { results: [] as Array<{ container_kind: string; container_key: string; class: string }> };
    });

  const map: DataClassMap = { exact: new Map(), prefixes: [], size: 0 };
  for (const row of rows.results) {
    if (!isDataClass(row.class)) continue;
    map.size += 1;
    if (row.container_kind === 'media_prefix') {
      map.prefixes.push({ key: row.container_key, class: row.class });
    } else {
      map.exact.set(`${row.container_kind}:${row.container_key}`, row.class);
    }
  }
  // Longest prefix first, so 'upload/records/private/' beats 'upload/'.
  map.prefixes.sort((a, b) => b.key.length - a.key.length);

  if (context) context.dataClasses = map;
  return map;
}

/** Clears this request's classification cache after a mutation. */
export function clearDataClassCache(): void {
  const context = requestContext.getStore();
  if (context) delete context.dataClasses;
}

/** The class of one container, or null when it is not classified. */
export function classFor(map: DataClassMap, kind: ContainerKind, key: string): DataClass | null {
  if (kind === 'media_prefix') {
    return map.prefixes.find((entry) => key.startsWith(entry.key))?.class ?? null;
  }
  return map.exact.get(`${kind}:${key}`) ?? null;
}

/** Retention bucket a recorded read belongs to. */
export function retentionClassFor(dataClass: DataClass): string {
  return dataClass === 'phi' ? 'phi_access' : 'pii_access';
}

/**
 * True when a failed audit write has to fail the request. For ePHI it does:
 * serving a record we could not account for is the failure mode the audit
 * control exists to prevent (NIST AU-5). Ordinary PII keeps the cheaper
 * after-response write.
 */
export function failsClosed(dataClass: DataClass): boolean {
  return dataClass === 'phi';
}
