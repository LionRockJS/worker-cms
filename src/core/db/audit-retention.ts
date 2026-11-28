import type { Env } from '../../types';
import { regulatedWritesBlocked } from '../http/regulated-writes';

/**
 * Days each retention class stays queryable in D1. The archive keeps its own,
 * longer horizon; this is only how long the hot copy lives.
 *
 * HIPAA pulls retention up and GDPR's storage limitation pulls it down, which
 * is why this is per class rather than one number.
 */
export const HOT_DAYS: Record<string, number> = {
  phi_access: 90,
  phi_mutation: 365,
  content_mutation: 365,
  pii_access: 90,
  auth: 90,
  admin_config: 365,
  // Access a plugin recorded on an unclassified page (/__cms/audit/events).
  plugin_access: 365,
  none: 90,
};

/** Anything unrecognised keeps the most conservative horizon rather than the
 *  shortest, so a new class added without touching this file is not swept away. */
const DEFAULT_HOT_DAYS = 365;

/** Rows a single run may prune, so a long backlog drains over several ticks
 *  instead of timing out on one. */
const PRUNE_LIMIT = 2000;

/** Unrecognised retention classes keep the conservative horizon. */
export function hotDaysFor(retentionClass: string): number {
  return HOT_DAYS[retentionClass] ?? DEFAULT_HOT_DAYS;
}

/**
 * Deletes rows past their class's hot window, at most PRUNE_LIMIT per run.
 * `ceiling` limits it to `seq <= ceiling`; the archive sweep passes its last
 * verified seal so an unarchived row is never deleted.
 */
export async function pruneExpiredAuditEvents(env: Pick<Env, 'DB'>, ceiling = Number.MAX_SAFE_INTEGER): Promise<number> {
  // One statement per class: SQLite has no per-row window function here, and
  // each class has its own cutoff. The subselect bounds the work per run.
  let pruned = 0;
  for (const [retentionClass, days] of Object.entries(HOT_DAYS)) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const result = await env.DB.prepare(
      `DELETE FROM audit_events WHERE seq IN (
         SELECT seq FROM audit_events
          WHERE seq <= ? AND retention_class = ? AND occurred_at < ?
          LIMIT ?
       )`,
    ).bind(ceiling, retentionClass, cutoff, PRUNE_LIMIT).run();
    pruned += result.meta.changes ?? 0;
    if (pruned >= PRUNE_LIMIT) break;
  }
  return pruned;
}

/**
 * Without the audit feature there is no archive sweep, so nothing else trims
 * audit_events. Prune by the same windows, unarchived. A regulated profile
 * keeps every row for its archive (and requires the audit feature anyway).
 */
export async function pruneWithoutArchive(env: Pick<Env, 'DB' | 'REGULATED_MODE'>, auditInstalled: boolean): Promise<number> {
  if (auditInstalled || regulatedWritesBlocked(env)) return 0;
  return pruneExpiredAuditEvents(env);
}
