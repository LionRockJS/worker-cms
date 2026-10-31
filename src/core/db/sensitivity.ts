import type { Env } from '../../types';
import type { DataClass } from './data-classes';
import type { AuditRow } from './audit';

// Presence checks are part of classification admission, including on an
// existing deployment with retained trash tables but the feature disabled.
const coreObjects = ['table:data_class_floors', 'table:page_sensitivity_floors', 'view:sensitivity_page_sources',
  ...['class_insert', 'class_update', 'page_insert', 'page_update', 'link_insert', 'link_update', 'tag_update', 'policy_insert', 'policy_update',
    'retype_guard', 'tag_move_guard', 'taxonomy_rename'].map(name => `trigger:sensitivity_${name}`)];
const trashObjects = ['view:sensitivity_trash_sources',
  ...['page_insert', 'page_update', 'link_insert', 'link_update', 'tag_update', 'policy_insert', 'policy_update'].map(name => `trigger:sensitivity_trash_${name}`)];
const missing = (objects: string[]) => `(SELECT COUNT(*) FROM sqlite_master WHERE type || ':' || name IN (${objects.map(name => `'${name}'`).join(',')})) <> ${objects.length}`;
export const sensitivitySchemaFailureSql = `${missing(coreObjects)} OR
  (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trash_pages') AND ${missing(trashObjects)})`;

/** Durable page identity survives retyping, association changes and trash/restore. */
export async function pageSensitivityFloors(env: Env, ids: string[], source: 'pages' | 'trash_pages' | 'page_versions' | 'uuid' = 'pages'): Promise<Map<string, DataClass>> {
  if (!ids.length) return new Map();
  if (source === 'trash_pages' && !await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trash_pages'").first()) {
    if (env.REGULATED_MODE === 'true' || await env.DB.prepare('SELECT 1 FROM page_sensitivity_floors LIMIT 1').first()) {
      throw new Error('Deleted source requires UUID provenance');
    }
    return new Map();
  }
  const from = source === 'uuid' ? 'page_sensitivity_floors f'
    : source === 'page_versions' ? 'page_versions v JOIN pages p ON p.id = v.page_id JOIN page_sensitivity_floors f ON f.uuid = p.uuid'
      : `${source} p JOIN page_sensitivity_floors f ON f.uuid = p.uuid`;
  const key = source === 'uuid' ? 'f.uuid' : source === 'page_versions' ? 'v.id' : 'p.id';
  const rows = await env.DB.prepare(`SELECT ${key} AS id, f.level FROM ${from} WHERE ${key} IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<{ id: string | number; level: number }>();
  const floors = new Map<string, DataClass>();
  for (const row of rows.results) {
    if (row.level !== 1 && row.level !== 2) throw new Error('Page sensitivity invalid');
    floors.set(String(row.id), row.level === 2 ? 'phi' : 'pii');
  }
  return floors;
}

/** Counts/search probes must not downgrade a container holding floored pages. */
export async function typeSensitivityFloors(env: Env, types: string[], trash = false): Promise<Map<string, DataClass>> {
  if (!types.length) return new Map();
  const rows = await env.DB.prepare(`SELECT COALESCE(p.page_type, 'default') AS key, MAX(f.level) AS level
    FROM ${trash ? 'trash_pages' : 'pages'} p JOIN page_sensitivity_floors f ON f.uuid = p.uuid
    WHERE COALESCE(p.page_type, 'default') IN (SELECT value FROM json_each(?)) GROUP BY COALESCE(p.page_type, 'default')`)
    .bind(JSON.stringify(types)).all<{ key: string; level: number }>();
  return new Map(rows.results.map(row => {
    if (row.level !== 1 && row.level !== 2) throw new Error('Page sensitivity invalid');
    return [row.key, row.level === 2 ? 'phi' : 'pii'];
  }));
}

/** Copy protection is committed with the new page, including new UUIDs. */
export function copySensitivityStatement(db: D1DatabaseClient, sourceUuid: string, targetUuid: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO page_sensitivity_floors (uuid, level)
    SELECT ?, level FROM page_sensitivity_floors WHERE uuid = ?
    ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level)`).bind(targetUuid, sourceUuid);
}

/** Protect an incoming source before it can be materialized under a lower container. */
export function pinSensitivityStatement(db: D1DatabaseClient, uuid: string, dataClass: DataClass): D1PreparedStatement {
  return db.prepare(`INSERT INTO page_sensitivity_floors (uuid, level) VALUES (?, ?)
    ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level)`).bind(uuid, dataClass === 'phi' ? 2 : 1);
}

/** Incoming UUIDs inherit the actual audited source, not a local tag-ID guess. */
export function incomingSensitivityStatements(db: D1DatabaseClient, rows: AuditRow[]): D1PreparedStatement[] {
  const floors = new Map<string, DataClass>();
  for (const row of rows) {
    if (!['published_page', 'live_page'].includes(row.targetType ?? '') || row.dataClass === 'none') continue;
    for (const uuid of row.targetIds ?? (row.targetId ? [row.targetId] : [])) {
      if (row.dataClass === 'phi' || !floors.has(uuid)) floors.set(uuid, row.dataClass);
    }
  }
  return [...floors].map(([uuid, dataClass]) => pinSensitivityStatement(db, uuid, dataClass));
}
