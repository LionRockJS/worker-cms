import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { publishPageToTargets, publishPagesToTargets, publishTagToTargets, publishTagsToTargets, unpublishPageFromTargets, removeTagFromTargets } from '../src/core/publish';
import { auditPublishTransfer } from '../src/core/publish/audit';
import { d1Adapter } from '../src/core/publish/d1';
import { publishFlash } from '../src/routes/admin/pages/lifecycle';
import { pagesApiRoutes } from '../src/features/plugins/api/pages';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache, getPlugins } from '../src/features/plugins/registry';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';
import { signJWT } from './auth-fixtures';
import { FORM_ONCE_FIELD, mintFormOnceToken } from '../src/core/auth/form-once';
import type { Env, Page, Variables } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;
const actor = { userId: '5701', roles: 'admin', sessionSid: null, via: null };
const pluginId = 'outbound-target';
const pluginUrl = 'https://outbound-target.local';
const uuid = 'outbound-story-5700';
let calls: Array<{ path: string; body: string; auditRows: number; headers: Headers }> = [];
let onDelivery: (() => Promise<void>) | undefined;
let cookie: string;
let manifestReads = 0;

function publishEnv(targets = 'd1,r2'): Env {
  return { ...env, PUBLISH_TARGETS: targets, PUBLISH_BUCKET: env.MEDIA_BUCKET } as unknown as Env;
}
async function policy(kind: string, key: string, dataClass: string) {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?) ON CONFLICT (container_kind, container_key) DO UPDATE SET class = excluded.class')
    .bind(kind, key, dataClass).run();
}
async function seedPage(id: number): Promise<Page> {
  return (await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, 'Private patient', ?, 'story', ?) RETURNING *")
    .bind(id, `outbound-story-${id}`, `private-patient-${id}`, JSON.stringify({ body: 'Private clinical body' })).first<Page>())!;
}
async function readExports() {
  return (await env.DB.prepare("SELECT actor_user_id, acting_via, action, data_class, detail, target_id FROM audit_events WHERE event_class = 'export' ORDER BY seq").all()).results;
}
async function post(path: string, body = '{}', method = 'POST') {
  return worker.fetch(new Request(`http://localhost${path}`, { method, body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, redirect: 'manual' }));
}

beforeEach(async () => {
  clearManifestCache(); __clearInjectedFetchers(); calls = []; onDelivery = undefined; manifestReads = 0;
  for (const table of ['plugins', 'plugin_page_type_approvals', 'audit_events', 'data_classes', 'page_tags', 'pages', 'tags', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const table of ['page_tags', 'pages', 'tags']) await env.PUBLISHED_DB.prepare(`DELETE FROM ${table}`).run();
  await env.MEDIA_BUCKET!.delete([`pages/${uuid}.json`, 'pages/outbound-story-5702.json', 'index.json']);
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (5701, 'test:5701', 'Operator', 'operator@example.invalid', 'admin')").run();
  await seedPage(5700);
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (5750, 'Private diagnosis', 'private-diagnosis', 'category')").run();
  await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (5700, 5750)').run();
  await policy('page_type', 'story', 'pii');
  await policy('taxonomy', 'category', 'pii');
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret, config) VALUES ('Target', ?, 1, 'test-secret', ?)")
    .bind(pluginUrl, JSON.stringify({ cmsTrustedUi: true })).run();
  await approvePageTypeAccess(env.DB, pluginId, 'story', 'write', 'test');
  __injectPluginFetcher(pluginUrl, { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') {
      manifestReads++;
      return Response.json({ id: pluginId, name: 'Target', version: '1', publishTarget: true,
        readViews: ['story'], editViews: ['story'], newViews: ['story'], contentTypes: { readTypes: ['story'], writeTypes: ['story'] } });
    }
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_class = 'export'").first<{ n: number }>();
    calls.push({ path, body: String(init?.body ?? ''), auditRows: row?.n ?? 0, headers: new Headers(init?.headers) });
    await onDelivery?.();
    return new Response('ok');
  } } as Fetcher);
  cookie = `access_token=${await signJWT({ sub: '5701', name: 'Operator', email: 'operator@example.invalid', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET)}`;
});
afterEach(() => { clearManifestCache(); __clearInjectedFetchers(); });

const containedCalls = (['single', 'bulk', 'tag', 'tags'] as const).flatMap(operation => ['true', 'invalid'].map(mode => [operation, mode] as const));

it.each(containedCalls)('contains direct %s publication in %s mode before source/discovery/target work', async (operation, mode) => {
  const page = (await env.DB.prepare('SELECT * FROM pages WHERE id = 5700').first<Page>())!;
  const cfg = { ...publishEnv(), REGULATED_MODE: mode };
  // Early admission must not depend on policy/storage being readable.
  cfg.DB = {
    prepare() { throw new Error('Publication source was queried during containment'); },
    async batch() { throw new Error('Publication wrote during containment'); },
  };
  const outcome = operation === 'single' ? await publishPageToTargets(cfg, 5700, actor)
    : operation === 'bulk' ? await publishPagesToTargets(cfg, [page], actor)
    : operation === 'tag' ? await publishTagToTargets(cfg, 5750, actor)
    : await publishTagsToTargets(cfg, undefined, actor);
  expect(outcome).toMatchObject({ targets: [], failures: [], refusedReason: 'writes_unavailable' });
  if (operation === 'bulk') expect(outcome).toMatchObject({ published: [], refused: [page], refusedRegulated: [] });
  expect(manifestReads).toBe(0); expect(calls).toEqual([]);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages').first()).toBeNull();
  expect(await env.PUBLISHED_DB.prepare('SELECT id FROM tags').first()).toBeNull();
  expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).toBeNull();
  expect(await readExports()).toEqual([]);
});

it('enforces containment for an already-built payload at the transfer audit boundary', async () => {
  const page = (await env.DB.prepare('SELECT * FROM pages WHERE id = 5700').first<Page>())!;
  await expect(auditPublishTransfer({ ...publishEnv(), REGULATED_MODE: 'true' }, d1Adapter(env.PUBLISHED_DB), 'page', [page], [], actor))
    .rejects.toThrow('durable mutation evidence');
  expect(await readExports()).toEqual([]);
});

it('rechecks containment after audit persistence before handing the snapshot to a target', async () => {
  const cfg = publishEnv('d1');
  cfg.DB = {
    prepare: sql => env.DB.prepare(sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      const results = await env.DB.batch<T>(statements);
      cfg.REGULATED_MODE = 'true';
      return results;
    },
  };
  const outcome = await publishPageToTargets(cfg, 5700, actor);
  expect(outcome?.failures).toContain('d1');
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages').first()).toBeNull();
  expect(calls).toEqual([]);
  expect((await readExports()).length).toBeGreaterThan(0);
  // The earlier row is intent only; it is not a successful delivery receipt.
  expect((await readExports()).every(row => JSON.parse(String(row.detail)).phase === 'intent')).toBe(true);
});

it('stops later fallback pages when the invocation becomes contained', async () => {
  const first = (await env.DB.prepare('SELECT * FROM pages WHERE id = 5700').first<Page>())!;
  const second = await seedPage(5702);
  const cfg = publishEnv('');
  onDelivery = async () => { cfg.REGULATED_MODE = 'true'; };
  expect((await publishPagesToTargets(cfg, [first, second], actor)).failures).toEqual([`plugin:${pluginId}`]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].body).page.uuid).toBe(first.uuid);
});

it('stops later tag chunks when the invocation becomes contained', async () => {
  await env.DB.batch(Array.from({ length: 45 }, (_, index) => env.DB.prepare(
    "INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (?, 'Synthetic label', ?, 'category')",
  ).bind(5800 + index, `contained-tag-${index}`)));
  const cfg = publishEnv('');
  onDelivery = async () => { cfg.REGULATED_MODE = 'true'; };
  expect((await publishTagsToTargets(cfg, undefined, actor)).failures).toEqual([`plugin:${pluginId}`]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].body).tags).toHaveLength(45);
});

it('preserves direct page and tag withdrawal during containment, including incomplete inventory', async () => {
  expect((await publishPageToTargets(publishEnv(), 5700, actor))?.failures).toEqual([]);
  calls = [];
  const cfg = { ...publishEnv(), REGULATED_MODE: 'true', REGULATED_INVENTORY: '[]' };
  const page = await unpublishPageFromTargets(cfg, uuid, false, actor);
  const tag = await removeTagFromTargets(cfg, 5750, actor);
  expect(page.failures).toEqual([]); expect(tag.failures).toEqual([]);
  expect(page.auditFailures?.length).toBeGreaterThan(0);
  expect(calls.map(call => call.path)).toEqual(['/__plugin/publish/remove', '/__plugin/publish/remove-tag']);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages').first()).toBeNull();
  expect(await env.PUBLISHED_DB.prepare('SELECT id FROM tags WHERE id = 5750').first()).toBeNull();
  expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).toBeNull();
});

it('reports write containment without mislabelling a public page as a submission mirror', () => {
  const message = decodeURIComponent(publishFlash({ targets: [], failures: [], refused: true, refusedReason: 'writes_unavailable' }));
  expect(message).toContain('regulated writes are contained');
  expect(message).not.toContain('Submission');
});

it('returns containment correctly when the contributor router is mounted without the outer HTTP guard', async () => {
  await getPlugins(publishEnv()); // Prepare the reviewed identity before containment.
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.route('/__cms', pagesApiRoutes);
  const response = await app.request('https://cms.example.com/__cms/pages/publish', {
    method: 'POST', headers: { 'x-plugin-id': pluginId, 'x-plugin-secret': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [5700] }),
  }, { ...publishEnv(), REGULATED_MODE: 'true' });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'regulated_writes_unavailable' });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(calls).toEqual([]);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages').first()).toBeNull();
});

it('persists PII intent for D1, R2 and plugin publication before delivery', async () => {
  const outcome = await publishPageToTargets(publishEnv(), 5700, actor);
  expect(outcome).toMatchObject({ targets: ['d1', 'r2', `plugin:${pluginId}`], failures: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0].auditRows).toBeGreaterThan(0);
  const rows = await readExports();
  expect(new Set(rows.map(row => JSON.parse(String(row.detail)).destination))).toEqual(new Set(['d1', 'r2', `plugin:${pluginId}`]));
  expect(rows.every(row => row.actor_user_id === actor.userId && row.acting_via === null)).toBe(true);
  expect(rows.every(row => JSON.parse(String(row.detail)).phase === 'intent')).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/Private patient|Private clinical body|Private diagnosis/);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).not.toBeNull();
  expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).not.toBeNull();
});

it('withholds every publish destination when PII intent cannot be persisted', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    expect((await publishPageToTargets(publishEnv(), 5700, actor))?.failures).toEqual(['d1', 'r2', `plugin:${pluginId}`]);
    expect(calls).toEqual([]);
    expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).toBeNull();
    expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).toBeNull();
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('withholds PHI catalogue rows while syncing public tags', async () => {
  await policy('taxonomy', 'category', 'phi');
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (5751, 'Public label', 'public-label', 'public')").run();
  const outcome = await publishTagsToTargets(publishEnv(), [5750, 5751], actor);
  expect(outcome).toMatchObject({ count: 1, refusedCount: 1, failures: [] });
  expect((await env.PUBLISHED_DB.prepare('SELECT id FROM tags ORDER BY id').all()).results).toEqual([{ id: 5751 }]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].body).tags.map((tag: { id: number }) => tag.id)).toEqual([5751]);
  expect(calls[0].body).not.toContain('Private diagnosis');
});

it('audits classified tag-only sync before any catalogue receives it', async () => {
  await publishTagsToTargets(publishEnv(), [5750], actor);
  expect(calls[0].auditRows).toBeGreaterThan(0);
  const rows = await readExports();
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.action === 'tag.publish-disclosure' && row.target_id === '5750')).toBe(true);
});

it('withholds PII catalogue sync on audit failure', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    expect((await publishTagsToTargets(publishEnv(), [5750], actor)).failures).toEqual(['d1', `plugin:${pluginId}`]);
    expect(calls).toEqual([]);
    expect((await env.PUBLISHED_DB.prepare('SELECT id FROM tags').all()).results).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('uses contributor classification even when published content is unclassified', async () => {
  // Build a never-classified source using privileged fixture reset, rather
  // than treating policy-row removal as application declassification.
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM data_class_floors').run();
  await env.DB.prepare('DELETE FROM page_sensitivity_floors').run();
  await seedPage(5700);
  await policy('plugin', pluginId, 'pii');
  await publishPageToTargets(publishEnv(''), 5700);
  expect(calls[0].auditRows).toBe(1);
  expect(await readExports()).toMatchObject([{ action: 'plugin.publish-disclosure', actor_user_id: null, acting_via: 'system:publish' }]);
});

it('refuses tag sync on classification outage', async () => {
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
  try {
    expect(await publishTagsToTargets(publishEnv(), [5750], actor)).toMatchObject({ refusedReason: 'classification_unavailable', count: 0 });
    expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run(); }
});

it('does not treat a legacy tag schema as a public taxonomy when taxonomy policy exists', async () => {
  await env.DB.prepare('ALTER TABLE tags RENAME COLUMN taxonomy_slug TO legacy_taxonomy_slug').run();
  try {
    expect(await publishTagsToTargets(publishEnv(), [5750], actor)).toMatchObject({ refusedReason: 'classification_unavailable', count: 0 });
    expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE tags RENAME COLUMN legacy_taxonomy_slug TO taxonomy_slug').run(); }
});

it('refuses tag transfer under write containment before resolving inventory', async () => {
  expect(await publishTagsToTargets({ ...publishEnv(), REGULATED_MODE: 'true', REGULATED_INVENTORY: '[]' }, [5750], actor))
    .toMatchObject({ refusedReason: 'writes_unavailable', count: 0 });
  expect(calls).toEqual([]);
});

it('applies the default page-type PHI policy to null page types', async () => {
  await policy('page_type', 'default', 'phi');
  await env.DB.prepare('UPDATE pages SET page_type = NULL WHERE id = 5700').run();
  expect(await publishPageToTargets(publishEnv(), 5700, actor)).toMatchObject({ refusedReason: 'regulated' });
  expect(calls).toEqual([]);
});

it('withholds a public child snapshot that would expose a PHI parent identifier', async () => {
  await seedPage(5702);
  await policy('page_type', 'patient', 'phi');
  await env.DB.prepare("UPDATE pages SET page_type = 'patient' WHERE id = 5702").run();
  await env.DB.prepare('UPDATE pages SET page_id = 5702 WHERE id = 5700').run();
  await policy('page_type', 'patient', 'phi');
  expect((await publishPageToTargets(publishEnv(), 5700, actor))?.failures).toEqual(['d1', 'r2', `plugin:${pluginId}`]);
  expect(calls).toEqual([]);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).toBeNull();
});

it('withholds a public tag catalogue row that references a PHI parent tag', async () => {
  await policy('taxonomy', 'category', 'phi');
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug, parent_tag) VALUES (5751, 'Public child', 'public-child', 'public', 5750)").run();
  expect((await publishTagsToTargets(publishEnv(), [5751], actor)).failures).toEqual(['d1', `plugin:${pluginId}`]);
  expect(calls).toEqual([]);
  expect((await env.PUBLISHED_DB.prepare('SELECT id FROM tags').all()).results).toEqual([]);
});

it('rechecks classification before each fallback plugin publish', async () => {
  const second = await seedPage(5702);
  const first = (await env.DB.prepare('SELECT * FROM pages WHERE id = 5700').first<Page>())!;
  onDelivery = () => policy('page_type', 'story', 'phi');
  expect((await publishPagesToTargets(publishEnv(''), [first, second], actor)).failures).toEqual([`plugin:${pluginId}`]);
  expect(calls).toHaveLength(1);
});

it('does not reuse a disabled plugin destination in a bulk publish', async () => {
  const second = await seedPage(5702);
  const first = (await env.DB.prepare('SELECT * FROM pages WHERE id = 5700').first<Page>())!;
  onDelivery = async () => { await env.DB.prepare('UPDATE plugins SET enabled = 0 WHERE url = ?').bind(pluginUrl).run(); };
  expect((await publishPagesToTargets(publishEnv(''), [first, second], actor)).failures).toEqual([`plugin:${pluginId}`]);
  expect(calls).toHaveLength(1);
});

it('retains the initiating HTTP user on publication intent', async () => {
  const response = await post('/admin/pages/5700/publish');
  expect(response.status).toBe(302); await response.text();
  const rows = (await readExports()).filter(row => row.action === 'page.publish-disclosure');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.actor_user_id === '5701' && row.acting_via === null)).toBe(true);
  expect(calls).toHaveLength(1);
});

it('keeps source plugin attribution separate from the publish destination', async () => {
  const response = await worker.fetch(new Request('http://localhost/__cms/pages/publish', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-plugin-id': pluginId, 'x-plugin-secret': 'test-secret', 'x-acting-user-id': '5701' }, body: JSON.stringify({ ids: [5700] }) }));
  expect(response.status).toBe(200); await response.text();
  const rows = (await readExports()).filter(row => row.action === 'page.publish-disclosure');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.actor_user_id === '5701' && row.acting_via === pluginId)).toBe(true);
});

it('persists synchronous plugin POST disclosure without copying the request body', async () => {
  await policy('plugin', pluginId, 'pii');
  await policy('table', 'users', 'pii');
  const response = await post(`/admin/plugins/${pluginId}/export`, JSON.stringify({ value: 'Private clinical body' }));
  expect(response.status).toBe(200); await response.text();
  expect(calls).toHaveLength(1); expect(calls[0].auditRows).toBe(2);
  expect(JSON.stringify(await readExports())).not.toContain('Private clinical body');
});

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('withholds synchronous %s before upstream on PII audit failure', async method => {
  await policy('plugin', pluginId, 'pii');
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    const response = await post(`/admin/plugins/${pluginId}/export`, '{}', method);
    expect(response.status).toBe(503); await response.text();
    expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('audits forwarded user metadata even when the destination is not classified', async () => {
  await policy('table', 'users', 'pii');
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    const response = await post(`/admin/plugins/${pluginId}/export`);
    expect(response.status).toBe(503); await response.text(); expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it.each([
  '/admin/pages/5700/read', '/admin/pages/5700/edit', '/admin/pages/new?page_type=story',
  `/admin/plugins/${pluginId}/views/sections/private.liquid`,
])('withholds forwarded user metadata at %s on audit failure', async path => {
  await env.DB.prepare('DELETE FROM data_classes').run();
  await policy('table', 'users', 'pii');
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie }, redirect: 'manual' }));
    expect(response.status).toBe(503); await response.text(); expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('records PII renderer context as destination-attributed intent before dispatch', async () => {
  const response = await worker.fetch(new Request('http://localhost/admin/pages/5700/read', { headers: { Cookie: cookie }, redirect: 'manual' }));
  expect(response.status).toBe(200); await response.text();
  const row = (await readExports()).find(row => row.action === 'page.read');
  expect(row).toBeDefined();
  expect(JSON.parse(String(row!.detail))).toMatchObject({ destination: pluginId, operation: 'read', phase: 'intent' });
  expect(calls.some(call => call.path === '/__plugin/read' && call.auditRows > 0)).toBe(true);
});

it('releases the single-submit claim after an audit refusal so the form can retry', async () => {
  await policy('plugin', pluginId, 'pii');
  const token = `${await mintFormOnceToken(env.JWT_SECRET)}:export`;
  const request = () => worker.fetch(new Request(`http://localhost/admin/plugins/${pluginId}/export`, { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams({ [FORM_ONCE_FIELD]: token }), redirect: 'manual' }));
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { const response = await request(); expect(response.status).toBe(503); await response.text(); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  const response = await request(); expect(response.status).toBe(200); await response.text();
  expect(calls).toHaveLength(1);
});
