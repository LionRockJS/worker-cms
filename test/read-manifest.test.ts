import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditBackgroundReads, type PendingRead } from '../src/core/http/access-log';
import type { Env } from '../src/types';

const actor = { userId: 'manifest-user', roles: 'operator', sessionSid: null, via: 'manifest-source' };
const otherActor = { userId: null, roles: null, sessionSid: null, via: 'autonomous-source' };
const testEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS manifest_audit_fail').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'person', 'pii')"),
    env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')"),
  ]);
});
afterEach(async () => { await env.DB.prepare('DROP TRIGGER IF EXISTS manifest_audit_fail').run(); });

function read(key: string, count: number, overrides: Partial<PendingRead> = {}): PendingRead {
  return { action: 'page.manifest-export', kind: 'page_type', key, targetType: 'page', ids: Array.from({ length: count }, (_, i) => `${key}-${i}`), count,
    eventClass: 'export', detail: { destination: 'approved-test-destination', phase: 'intent' }, ...overrides };
}

it('retains complete linked PII/PHI identifier sets with per-event actors and bounded rows', async () => {
  await auditBackgroundReads(testEnv, [read('person', 205), read('chart', 110, { actor: otherActor })], actor);
  const rows = (await env.DB.prepare("SELECT data_class, target_ids, target_count, actor_user_id, acting_via, detail FROM audit_events ORDER BY seq")
    .all<{ data_class: string; target_ids: string; target_count: number; actor_user_id: string | null; acting_via: string; detail: string }>()).results;
  const manifests = new Set<string>();
  for (const [key, dataClass, count, via, user] of [['person', 'pii', 205, actor.via, actor.userId], ['chart', 'phi', 110, otherActor.via, null]] as const) {
    const group = rows.filter(row => row.data_class === dataClass);
    const details = group.map(row => JSON.parse(row.detail));
    const ids = group.flatMap(row => JSON.parse(row.target_ids) as string[]);
    expect(ids).toEqual(Array.from({ length: count }, (_, i) => `${key}-${i}`));
    expect(group.every(row => JSON.parse(row.target_ids).length <= 100 && row.actor_user_id === user && row.acting_via === via)).toBe(true);
    expect(group.reduce((sum, row) => sum + row.target_count, 0)).toBe(count);
    expect(new Set(details.map(detail => detail.manifest_id)).size).toBe(1);
    expect(details.map(detail => detail.manifest_part)).toEqual(group.map((_, i) => i + 1));
    expect(details.every(detail => detail.manifest_parts === group.length && detail.manifest_id_count === count
      && detail.manifest_target_count === count && detail.manifest_complete === true && detail.phase === 'intent')).toBe(true);
    manifests.add(details[0].manifest_id);
  }
  expect(manifests.size).toBe(2);
});

it('marks an incomplete announcement explicitly rather than inventing missing identifiers', async () => {
  await auditBackgroundReads(testEnv, [read('person', 120, { count: 125, eventClass: 'read' })], actor);
  const rows = (await env.DB.prepare('SELECT target_ids, target_count, detail FROM audit_events ORDER BY seq')
    .all<{ target_ids: string; target_count: number; detail: string }>()).results;
  expect(rows.map(row => row.target_count)).toEqual([100, 25]);
  expect(rows.flatMap(row => JSON.parse(row.target_ids))).toHaveLength(120);
  expect(rows.every(row => JSON.parse(row.detail).manifest_complete === false && JSON.parse(row.detail).manifest_target_count === 125)).toBe(true);
});

it('refuses a large PII export when its manifest cannot persist', async () => {
  await env.DB.prepare("CREATE TRIGGER manifest_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
  await expect(auditBackgroundReads(testEnv, [read('person', 205)], actor)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first<{ n: number }>())?.n).toBe(0);
});

it.each([[120, 125], [120, 115], [0, 1]])('refuses a classified export with %s IDs for %s declared records', async (ids, count) => {
  await expect(auditBackgroundReads(testEnv, [read('person', ids, { count })], actor)).rejects.toThrow('Export identifier manifest incomplete');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first<{ n: number }>())?.n).toBe(0);
});
