import type { Env } from '../../types';
import { CONTAINER_KINDS, resolveDataClasses, type ContainerKind, type DataClassMap } from '../db/data-classes';

export interface InventoryEntry { kind: ContainerKind; key: string; class: 'public' | 'pii' | 'phi' }

/** Deployment-owned inventory; an empty/malformed profile never means public. */
export function regulatedInventory(env: Env): InventoryEntry[] | null {
  if (env.REGULATED_MODE !== 'true') return env.REGULATED_MODE && env.REGULATED_MODE !== 'false' ? null : [];
  try {
    const entries: unknown = JSON.parse(env.REGULATED_INVENTORY ?? '');
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000) return null;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !CONTAINER_KINDS.includes(entry.kind)
          || typeof entry.key !== 'string' || !entry.key.trim() || entry.key !== entry.key.trim()
          || !['public', 'pii', 'phi'].includes(entry.class)) return null;
      const id = `${entry.kind}:${entry.key}`;
      if (seen.has(id)) return null;
      seen.add(id);
    }
    return entries as InventoryEntry[];
  } catch { return null; }
}

export function inventoried(env: Env, kind: ContainerKind, key: string): boolean {
  if (!env.REGULATED_MODE || env.REGULATED_MODE === 'false') return true;
  const entries = regulatedInventory(env);
  return !!entries?.some(entry => entry.kind === kind
    && (kind === 'media_prefix' ? key.startsWith(entry.key) : key === entry.key));
}

/** Checked on every dynamic request/job; no stale readiness cache across policy changes. */
export async function assertRegulatedReady(env: Env, auditInstalled: boolean): Promise<void> {
  const inventory = regulatedInventory(env);
  if (!inventory) throw new Error('Regulated inventory invalid');
  if (env.REGULATED_MODE !== 'true') return;
  if (!auditInstalled || !env.AUDIT_BUCKET || !env.DB || !env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error('Regulated profile requires audit feature, archive binding, database and strong signing secret');
  }
  const origin = new URL(env.CANONICAL_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.origin !== env.CANONICAL_ORIGIN) throw new Error('Regulated canonical origin invalid');
  const classes: DataClassMap = await resolveDataClasses(env);
  if (!classes.ok) throw new Error('Regulated classification unavailable');
  // Every deployment declaration agrees with the live policy, and every live
  // policy appears in the inventory. Public declarations never override PHI.
  const declared = new Map(inventory.map(e => [`${e.kind}:${e.key}`, e.class]));
  const actual = new Map(classes.exact);
  for (const p of classes.prefixes) actual.set(`media_prefix:${p.key}`, p.class);
  for (const [key, value] of actual) if (declared.get(key) !== value) throw new Error('Regulated inventory disagrees with policy');
  for (const [key, value] of declared) if (value === 'public' ? actual.has(key) : actual.get(key) !== value) {
    throw new Error('Regulated inventory disagrees with policy');
  }
  // Detect existing page/taxonomy containers omitted from the deployment inventory.
  for (const [sql, kind] of [
    ["SELECT DISTINCT COALESCE(page_type, 'default') AS key FROM pages", 'page_type'],
    ['SELECT slug AS key FROM taxonomies', 'taxonomy'],
  ] as const) {
    const rows = await env.DB.prepare(sql).all<{ key: string }>();
    if (rows.results.some(row => !declared.has(`${kind}:${row.key}`))) throw new Error('Regulated container inventory incomplete');
  }
  // Verify the schema columns actually used by recording and archiving.
  await env.DB.prepare('SELECT event_id, occurred_at, data_class, actor_user_id, acting_via, target_ids, retention_class FROM audit_events LIMIT 0').all();
  await env.DB.prepare('SELECT last_seq, rolling_hash, r2_key FROM audit_seals LIMIT 0').all();
}
