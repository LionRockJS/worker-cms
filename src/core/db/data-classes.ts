// ============================================================
// Container classification.
//
// Which containers hold regulated data, and therefore which reads are recorded.
// Classification is per container. Persistent container floors retain the
// highest assigned class; derived UUID floors preserve it when records move
// or lose associations. They are retention safeguards, not row-by-row labels.
//
// Core owns this even though `runtime-content-types` is where database page
// types live, because that feature is optional and the compiled base types in
// content-config.ts exist without it. Classification has to work in either
// profile.
//
// Resolved once per request and cached alongside the role map. Empty policy
// and floor tables keep an unclassified install inert: one query, no audit rows.
// ============================================================

import type { Env } from '../../types';
import { requestContext } from '../http/request-context';
import { recordAuditOutage } from './audit-outages';
import { sensitivitySchemaFailureSql } from './sensitivity';

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

/** Exact matches keyed `kind:key`, plus retained media prefixes. */
export interface DataClassMap {
  exact: Map<string, DataClass>;
  prefixes: Array<{ key: string; class: DataClass }>;
  size: number;
  /**
   * False when the lookup could not be answered or contains invalid policy.
   * Consumers must withhold sensitive reads/publication rather than treating
   * unknown policy as unclassified.
   */
  ok: boolean;
}

const EMPTY: DataClassMap = { exact: new Map(), prefixes: [], size: 0, ok: false };

function isDataClass(value: string): value is DataClass {
  return value === 'pii' || value === 'phi';
}

/** Resolves the classification map, cached for the rest of this request. */
export async function resolveDataClasses(env: Env, fresh = false, reportFailure = true): Promise<DataClassMap> {
  const context = requestContext.getStore();
  if (!fresh && context?.dataClasses) return context.dataClasses;
  if (!env.DB) return EMPTY;

  let ok = true;
  const rows = await env.DB.prepare(`SELECT container_kind, container_key, class FROM data_classes
    UNION ALL SELECT container_kind, container_key, CASE level WHEN 2 THEN 'phi' WHEN 1 THEN 'pii' ELSE 'invalid' END AS class FROM data_class_floors
    UNION ALL SELECT 'table', 'sensitivity_schema', 'invalid' WHERE ${sensitivitySchemaFailureSql}`)
    .all<{ container_kind: string; container_key: string; class: string }>()
    // Preserve the failure state so reads and publication can fail closed.
    .catch((error) => {
      console.error('data_classes lookup failed', error);
      ok = false;
      return { results: [] as Array<{ container_kind: string; container_key: string; class: string }> };
    });

  const map: DataClassMap = { exact: new Map(), prefixes: [], size: 0, ok };
  const effective = new Map<string, { kind: ContainerKind; key: string; class: DataClass }>();
  for (const row of rows.results) {
    if (!isDataClass(row.class) || !CONTAINER_KINDS.includes(row.container_kind as ContainerKind) || !row.container_key.trim()) {
      map.ok = false;
      continue;
    }
    const id = `${row.container_kind}:${row.container_key}`;
    const previous = effective.get(id);
    if (!previous || row.class === 'phi') effective.set(id, { kind: row.container_kind as ContainerKind, key: row.container_key, class: row.class });
  }
  for (const row of effective.values()) {
    map.size++;
    if (row.kind === 'media_prefix') {
      map.prefixes.push({ key: row.key, class: row.class });
    } else {
      map.exact.set(`${row.kind}:${row.key}`, row.class);
    }
  }
  // Stable specificity order for grouped evidence; protection uses the highest
  // matching class so a narrower prefix cannot lower an older PHI boundary.
  map.prefixes.sort((a, b) => b.key.length - a.key.length);

  if (!map.ok && reportFailure) await recordAuditOutage(env, 'classification');

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
    const matches = map.prefixes.filter(entry => key.startsWith(entry.key));
    return matches.some(entry => entry.class === 'phi') ? 'phi' : matches.length ? 'pii' : null;
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
