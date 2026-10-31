import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import worker from '../src/index';
import { createExecutionContext } from 'cloudflare:test';
import { assertRegulatedReady, inventoried } from '../src/core/http/regulated-profile';
import { accessLog, recordRead } from '../src/core/http/access-log';
import { requestContext } from '../src/core/http/request-context';
import type { Env } from '../src/types';

const inventory = [
  { kind: 'page_type', key: 'chart', class: 'phi' },
  { kind: 'page_type', key: 'article', class: 'public' },
  { kind: 'media_prefix', key: 'records/', class: 'phi' },
];
function profile(overrides: Partial<Env> = {}): Env {
  return { ...env, REGULATED_MODE: 'true', REGULATED_INVENTORY: JSON.stringify(inventory),
    CANONICAL_ORIGIN: 'https://cms.example.com', ...overrides };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare('DELETE FROM taxonomies').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')"),
    env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('media_prefix', 'records/', 'phi')"),
  ]);
});

describe('regulated deployment readiness', () => {
  it('guards real HTTP requests before route work and recovers after inventory repair', async () => {
    const configured = { ...env, REGULATED_MODE: 'true', REGULATED_INVENTORY: JSON.stringify(inventory), CANONICAL_ORIGIN: 'https://cms.example.com' };
    const request = new Request('https://cms.example.com/');
    const denied = await worker.fetch(request, { ...configured, REGULATED_INVENTORY: '[]' }, createExecutionContext());
    expect(denied.status).toBe(503);
    expect(await denied.json()).toEqual({ error: 'regulated_profile_unavailable' });
    const ready = await worker.fetch(request, configured, createExecutionContext());
    expect(ready.status).toBe(302);
  });

  it('accepts a complete inventory and the required schema/bindings', async () => {
    await expect(assertRegulatedReady(profile(), true)).resolves.toBeUndefined();
    expect(inventoried(profile(), 'media_prefix', 'records/scan.pdf')).toBe(true);
    expect(inventoried(profile(), 'media_prefix', 'other/scan.pdf')).toBe(false);
  });

  it('preserves ordinary deployments without requiring regulated capabilities', async () => {
    await expect(assertRegulatedReady(profile({ REGULATED_MODE: undefined, AUDIT_BUCKET: undefined }), false)).resolves.toBeUndefined();
  });

  it.each([
    { REGULATED_MODE: 'yes' }, { REGULATED_INVENTORY: '' }, { REGULATED_INVENTORY: '[]' },
    { REGULATED_INVENTORY: JSON.stringify([...inventory, inventory[0]]) },
    { AUDIT_BUCKET: undefined }, { JWT_SECRET: 'short' }, { CANONICAL_ORIGIN: 'http://cms.example.com' },
    { REGULATED_INVENTORY: JSON.stringify(inventory.map(row => ({ ...row, class: 'public' }))) },
  ])('rejects invalid/unready configuration %j', async (overrides) => {
    await expect(assertRegulatedReady(profile(overrides), true)).rejects.toThrow();
  });

  it('rejects a build without the audit feature', async () => {
    await expect(assertRegulatedReady(profile(), false)).rejects.toThrow();
  });

  it('rejects existing uninventoried page types', async () => {
    await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (77, 'profile-77', 'Hidden', 'profile-77', 'unknown', '{}')").run();
    await expect(assertRegulatedReady(profile(), true)).rejects.toThrow('inventory incomplete');
  });

  it('checks schema on each invocation and recovers after repair', async () => {
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try { await expect(assertRegulatedReady(profile(), true)).rejects.toThrow(); }
    finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
    await expect(assertRegulatedReady(profile(), true)).resolves.toBeUndefined();
  });

  it('never serves an unknown read as implicitly public', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (_, next) => { await requestContext.run({ cspNonce: '' }, () => next()); });
    app.use('*', accessLog);
    app.get('/', c => {
      recordRead({ action: 'test.read', kind: 'page_type', key: 'unknown', targetType: 'page', ids: ['77'], count: 1 });
      return c.text('private body');
    });
    const response = await app.request('http://localhost/', {}, profile());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private body');
  });
});
