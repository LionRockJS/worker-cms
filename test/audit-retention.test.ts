import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneExpiredAuditEvents, pruneWithoutArchive } from '../src/core/db/audit-retention';

const DAY = 86400_000;

async function seed(retentionClass: string, daysAgo: number, action = `${retentionClass}.${daysAgo}`): Promise<void> {
  await env.DB.prepare(`INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome)
    VALUES (?, ?, 'admin', 'none', ?, ?, 'success')`)
    .bind(crypto.randomUUID(), new Date(Date.now() - daysAgo * DAY).toISOString(), retentionClass, action).run();
}
async function actions(): Promise<string[]> {
  return (await env.DB.prepare('SELECT action FROM audit_events ORDER BY seq').all<{ action: string }>()).results.map(row => row.action);
}

beforeEach(async () => { await env.DB.prepare('DELETE FROM audit_events').run(); });

describe('archive-free audit pruning', () => {
  it('prunes each class past its own window and keeps the rest', async () => {
    await seed('auth', 91);
    await seed('auth', 89);
    await seed('admin_config', 200);
    await seed('admin_config', 366);
    await seed('unlisted_class', 1000);
    expect(await pruneWithoutArchive(env, false)).toBe(2);
    // Unlisted classes are never swept, matching the archive sweep.
    expect(await actions()).toEqual(['auth.89', 'admin_config.200', 'unlisted_class.1000']);
  });

  it('leaves pruning to the archive sweep when the audit feature is installed', async () => {
    await seed('auth', 200);
    expect(await pruneWithoutArchive(env, true)).toBe(0);
    expect(await actions()).toEqual(['auth.200']);
  });

  it('never prunes unarchived rows in a regulated profile', async () => {
    await seed('auth', 200);
    expect(await pruneWithoutArchive({ ...env, REGULATED_MODE: 'true' }, false)).toBe(0);
    expect(await actions()).toEqual(['auth.200']);
  });

  it('bounds one run and drains the backlog over later runs', async () => {
    const insert = env.DB.prepare(`INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome)
      VALUES (?, ?, 'admin', 'none', 'auth', 'old', 'success')`);
    const old = new Date(Date.now() - 200 * DAY).toISOString();
    await env.DB.batch(Array.from({ length: 2100 }, () => insert.bind(crypto.randomUUID(), old)));
    expect(await pruneWithoutArchive(env, false)).toBe(2000);
    expect(await pruneWithoutArchive(env, false)).toBe(100);
    expect(await actions()).toEqual([]);
  });

  it('keeps rows above the ceiling the archive sweep passes', async () => {
    await seed('auth', 200, 'first');
    await seed('auth', 200, 'second');
    const { seq } = (await env.DB.prepare("SELECT seq FROM audit_events WHERE action = 'first'").first<{ seq: number }>())!;
    expect(await pruneExpiredAuditEvents(env, seq)).toBe(1);
    expect(await actions()).toEqual(['second']);
  });
});
