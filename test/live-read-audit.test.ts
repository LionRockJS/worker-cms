import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { getLiveLect, liveMapForDraftPages, listLiveByTypes } from '../src/core/publish';
import { d1Adapter } from '../src/core/publish/d1';
import { r2Adapter } from '../src/core/publish/r2';
import type { LivePageSnapshot, PublishAdapter, PublishSnapshot } from '../src/core/publish/adapter';
import { coreExtensions, registerCoreExtensions } from '../src/core/extensions';
import { clearConfigCache } from '../src/core/db/content-config';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { signJWT } from './auth-fixtures';
import { approvePageTypeAccess, revokePageTypeAccess } from '../src/features/plugins/page-types';
import type { Env, Page } from '../src/types';

const runtime = (exports as unknown as { default: Fetcher }).default;
const actor = { userId: '9802', roles: 'admin', sessionSid: '9804', via: null };
const originalAdapters = coreExtensions().publishAdapters;
let cookie: string;
let requestNo = 0;

beforeEach(async () => {
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
  await env.DB.prepare('DROP TRIGGER IF EXISTS live_audit_fail').run();
  for (const table of ['pages', 'tags', 'taxonomies', 'plugins', 'data_classes', 'audit_events', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags').run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (9802, 'test:9802', 'Operator', 'operator@example.invalid', 'admin')").run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (9804, 9802, 'live-test-hash', datetime('now', '+7 days'))").run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (9801, 'live-source-page', 'Public draft', 'public-draft', 'article', '{}')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (9801, 'live-source-page', 'Private live', 'private-live', 'chart', ?)").bind(JSON.stringify({ secret: 'private-live-value' })).run();
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret) VALUES ('Live reader', 'https://live-reader.local', 1, 'live-reader-secret')").run();
  __injectPluginFetcher('https://live-reader.local', { fetch: async () => Response.json({ id: 'live-reader', name: 'Reader', version: '1', contentTypes: { blueprint: { article: ['name'] }, readTypes: ['chart'] } }) } as Fetcher);
  await approvePageTypeAccess(env.DB, 'live-reader', 'chart', 'read', 'test');
  const token = await signJWT({ sub: '9802', email: 'operator@example.invalid', name: 'Operator', role: 'admin', sid: '9804', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  cookie = `access_token=${token}`;
});

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS live_audit_fail').run();
  registerCoreExtensions({ publishAdapters: originalAdapters });
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
  for (const object of (await env.MEDIA_BUCKET!.list({ prefix: 'pages/live-' })).objects) await env.MEDIA_BUCKET!.delete(object.key);
  await env.MEDIA_BUCKET!.delete('index.json');
});

async function classify(kind = 'page_type', key = 'chart') {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)').bind(kind, key, 'phi').run();
}

async function failAudit() {
  await env.DB.prepare("CREATE TRIGGER live_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
}

function admin(path: string) {
  return runtime.fetch(new Request(`http://localhost/admin${path.replace(/^\/(?=\?|$)/, '')}`, { headers: { Cookie: cookie, 'CF-Connecting-IP': `10.92.0.${++requestNo}` } }));
}

async function sourceTag(orphan = false) {
  await env.PUBLISHED_DB.prepare("UPDATE pages SET page_type = 'article'").run();
  if (!orphan) await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (9803, 'Private diagnosis', 'private-diagnosis', 'diagnosis')").run();
  await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (9801, 9803)').run();
}

function r2Env(): Env { return { ...env, PUBLISH_TARGETS: 'r2', PUBLISH_BUCKET: env.MEDIA_BUCKET }; }

async function r2Source(tags: unknown[], pageType: string | null = 'article') {
  await env.MEDIA_BUCKET!.put('pages/live-source-page.json', JSON.stringify({ uuid: 'live-source-page', page_type: pageType, lect: { secret: 'private-r2-value' }, tags, weight: 5 }));
}

it.each(['/pages/9801/edit?native=1', '/', '/?status=live', '/?status=draft'])('withholds %s when only the live type is PHI and audit writes fail', async path => {
  await classify(); await failAudit();
  const response = await admin(path);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-live-value');
});

it('records the actual live type and HTTP session/source IP rather than the draft type', async () => {
  await classify();
  expect((await admin('/pages/9801/edit?native=1')).status).toBe(200);
  const row = await env.DB.prepare("SELECT data_class, container_key, target_id, actor_user_id, session_sid, source_ip, detail FROM audit_events WHERE action = 'page.live-read'").first();
  expect(row).toMatchObject({ data_class: 'phi', container_key: 'chart', target_id: 'live-source-page', actor_user_id: '9802', session_sid: '9804' });
  expect(String(row?.source_ip)).toMatch(/^10\.92\.0\./);
  expect(JSON.parse(String(row?.detail))).toEqual({ source: 'd1' });
  expect(JSON.stringify(row)).not.toContain('private-live-value');
});

it('attributes a live-status-only API disclosure to its authenticated contributor', async () => {
  await classify();
  const response = await runtime.fetch(new Request('http://localhost/__cms/pages/9801?include_live_status=1', {
    headers: { 'x-plugin-id': 'live-reader', 'x-plugin-secret': 'live-reader-secret', 'x-acting-user-id': '9802' },
  }));
  expect(response.status).toBe(200);
  expect(await env.DB.prepare("SELECT acting_via, actor_user_id, container_key FROM audit_events WHERE action = 'page.live-read'").first()).toEqual({ acting_via: 'live-reader', actor_user_id: '9802', container_key: 'chart' });
  await failAudit();
  expect((await runtime.fetch(new Request('http://localhost/__cms/pages/9801?include_live_status=1', { headers: { 'x-plugin-id': 'live-reader', 'x-plugin-secret': 'live-reader-secret' } }))).status).toBe(503);
});

it.each(['/pages/9801?include_live_status=1', '/pages?page_type=article&include_live_status=1'])('requires actual live-source approval at %s', async path => {
  await classify();
  await revokePageTypeAccess(env.DB, 'live-reader', 'chart', 'read');
  const response = await runtime.fetch(new Request(`http://localhost/__cms${path}`, { headers: { 'x-plugin-id': 'live-reader', 'x-plugin-secret': 'live-reader-secret' } }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'forbidden_live_source' });
});

it('inherits the actual published catalogue independently of host tag IDs', async () => {
  await sourceTag(); await classify('taxonomy', 'diagnosis');
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (9803, 'Public tag', 'public-tag', 'public-labels')").run();
  expect(await getLiveLect(env, 'live-source-page', actor)).toContain('private-live-value');
  expect(await env.DB.prepare("SELECT container_key, target_id, actor_user_id FROM audit_events WHERE action = 'page.live-read'").first()).toEqual({ container_key: 'diagnosis', target_id: 'live-source-page', actor_user_id: '9802' });
  await failAudit();
  await expect(listLiveByTypes(env, ['article'], actor)).rejects.toThrow('Sensitive read audit unavailable');
});

it('counts a published record once when multiple source tags share a classified taxonomy', async () => {
  await sourceTag(); await classify('taxonomy', 'diagnosis');
  await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (9805, 'Another private diagnosis', 'another-diagnosis', 'diagnosis')").run();
  await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (9801, 9805)').run();
  expect((await admin('/?status=live')).status).toBe(200);
  const rows = (await env.DB.prepare("SELECT target_id, target_count FROM audit_events WHERE action = 'page.live-status' AND container_key = 'diagnosis'").all()).results;
  expect(rows).toEqual([{ target_id: 'live-source-page', target_count: 1 }]);
});

it.each(['adapter', 'dashboard'])('refuses orphan source tag provenance through %s', async path => {
  await sourceTag(true); await classify('taxonomy', 'diagnosis');
  if (path === 'adapter') await expect(getLiveLect(env, 'live-source-page', actor)).rejects.toThrow();
  else expect((await admin('/?status=live')).status).toBe(503);
});

it('carries explicit taxonomy provenance in newly published R2 objects', async () => {
  const page = (await env.DB.prepare('SELECT * FROM pages WHERE id = 9801').first<Page>())!;
  const snapshot: PublishSnapshot = { page, publishedAt: new Date().toISOString(),
    tags: [{ uuid: 'link', tag_id: 9803, weight: 5, name: 'Private diagnosis', slug: 'diagnosis' }],
    tagCatalogue: [{ id: 9803, uuid: 'tag', name: 'Private diagnosis', slug: 'diagnosis', weight: 5, taxonomy_slug: 'diagnosis', parent_tag: null, lect: null }],
  };
  await r2Adapter(env.MEDIA_BUCKET!).publish(snapshot);
  const source = (await r2Adapter(env.MEDIA_BUCKET!).liveMap!([page.uuid])).get(page.uuid);
  expect(source).toMatchObject({ page_type: 'article', taxonomy_slugs: ['diagnosis'] });
  await classify('taxonomy', 'diagnosis'); await failAudit();
  await expect(getLiveLect(r2Env(), page.uuid, actor)).rejects.toThrow();
});

it('audits R2 source taxonomy without consulting an unrelated published D1 catalogue', async () => {
  await classify('taxonomy', 'diagnosis');
  await r2Source([{ tag_id: 9803, taxonomy_slug: 'diagnosis' }]);
  expect(await getLiveLect(r2Env(), 'live-source-page', actor)).toContain('private-r2-value');
  expect(await env.DB.prepare("SELECT container_key, detail FROM audit_events WHERE action = 'page.live-read'").first()).toMatchObject({ container_key: 'diagnosis', detail: JSON.stringify({ source: 'r2' }) });
});

it('refuses legacy R2 tag provenance when taxonomy policies exist, while accepting an explicit empty tag set', async () => {
  await classify('taxonomy', 'diagnosis');
  await r2Source([{ tag_id: 9803 }]);
  await expect(getLiveLect(r2Env(), 'live-source-page', actor)).rejects.toThrow();
  await r2Source([]);
  expect(await getLiveLect(r2Env(), 'live-source-page', actor)).toContain('private-r2-value');
});

it('withholds real R2 HTTP responses when required provenance cannot be verified', async () => {
  await classify('taxonomy', 'diagnosis'); await r2Source([{ tag_id: 9803 }]);
  const response = await worker.fetch(new Request('http://localhost/admin/pages/9801/edit?native=1', { headers: { Cookie: cookie } }), r2Env(), createExecutionContext());
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).not.toContain('private-r2-value');
});

it.each([
  { uuid: 'live-source-page', lect: 'private-legacy-value', weight: 5 },
  { uuid: 'live-source-page', lect: 'private-legacy-value', weight: 5, page_type: 'article' },
])('refuses an unverifiable custom reader under the regulated profile', async source => {
  const legacy: PublishAdapter = { id: 'legacy', publish: async () => {}, unpublish: async () => {},
    liveMap: async () => new Map([[source.uuid, source]]), listLiveByTypes: async () => [source] };
  registerCoreExtensions({ publishAdapters: async () => [legacy] });
  await expect(getLiveLect({ ...env, PUBLISH_TARGETS: '', REGULATED_MODE: 'true' }, source.uuid, actor)).rejects.toThrow();
});

it('retains ordinary unclassified custom-reader compatibility and supplies honest autonomous attribution', async () => {
  const source: LivePageSnapshot = { uuid: 'live-source-page', lect: 'ordinary-value', weight: 5 };
  registerCoreExtensions({ publishAdapters: async () => [{ id: 'legacy', publish: async () => {}, unpublish: async () => {}, liveMap: async () => new Map([[source.uuid, source]]), listLiveByTypes: async () => [source] }] });
  expect(await getLiveLect({ ...env, PUBLISH_TARGETS: '' }, source.uuid)).toBe('ordinary-value');
  await classify();
  expect(await getLiveLect(env, source.uuid)).toContain('private-live-value');
  expect(await env.DB.prepare("SELECT actor_user_id, acting_via FROM audit_events WHERE action = 'page.live-read'").first()).toEqual({ actor_user_id: null, acting_via: 'system:live-reader' });
});

it('retains every PHI source UUID with bounded database round trips', async () => {
  await classify();
  const pages: Page[] = [];
  const draft = (await env.DB.prepare('SELECT * FROM pages WHERE id = 9801').first<Page>())!;
  for (let i = 0; i < 110; i++) {
    const uuid = `live-bulk-${i}`;
    await env.PUBLISHED_DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, 'Private', ?, 'chart', '{}')").bind(10000 + i, uuid, uuid).run();
    pages.push({ ...draft, id: 10000 + i, uuid });
  }
  let reads = 0;
  const published = new Proxy(env.PUBLISHED_DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { reads++; return target.prepare(sql); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await liveMapForDraftPages({ ...env, PUBLISHED_DB: published }, pages, actor);
  expect(result.size).toBe(110); expect(reads).toBe(2);
  const events = (await env.DB.prepare("SELECT target_ids, target_count FROM audit_events WHERE action = 'page.live-read' ORDER BY seq").all<{ target_ids: string; target_count: number }>()).results;
  expect(events.map(row => row.target_count)).toEqual([100, 10]);
  expect(new Set(events.flatMap(row => JSON.parse(row.target_ids))).size).toBe(110);
});

it('withholds source reads when classification storage is unavailable', async () => {
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO live_classes_away').run();
  try { await expect(getLiveLect(env, 'live-source-page', actor)).rejects.toThrow(); }
  finally { await env.DB.prepare('ALTER TABLE live_classes_away RENAME TO data_classes').run(); }
});
