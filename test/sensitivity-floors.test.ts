import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { resolveDataClasses, classFor } from '../src/core/db/data-classes';
import { pageSensitivityFloors } from '../src/core/db/sensitivity';
import { prepareReadAudits } from '../src/core/http/access-log';
import { publishPageToTargets } from '../src/core/publish';
import { getLiveLect } from '../src/core/publish';
import { createAdvancedSearchBulkActionJob, getAdminJob } from '../src/features/jobs/queue';
import { runCmsAdminJob } from '../src/features/jobs/runner';
import { pullPublishedPageToDraft } from '../src/core/db/page-store';
import { ingestSubmissions } from '../src/core/db/submission-ingest';
import { clearConfigCache } from '../src/core/db/content-config';
import { clearManifestCache, __clearInjectedFetchers, __injectPluginFetcher } from './plugin-fixtures';
import { deliverHooks } from '../src/features/plugins/hooks';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';
import type { Env } from '../src/types';
import type { Page } from '../src/types';
import { Hono } from 'hono';
import { requestContext } from '../src/core/http/request-context';
import { accessLog, recordPageReads } from '../src/core/http/access-log';

const worker = (exports as unknown as { default: Fetcher }).default;
const actor = { userId: '7002', roles: 'admin', sessionSid: null, via: null };
let cookie: string;
let requestNo = 0;
let deliveries = 0;

beforeEach(async () => {
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers(); deliveries = 0;
  await env.DB.prepare('DROP TRIGGER IF EXISTS floor_audit_fail').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS floor_copy_fail').run();
  for (const table of ['pages', 'tags', 'taxonomies', 'trash_pages', 'plugins', 'users', 'audit_events', 'data_classes']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'submissions.ingest.cursor'").run();
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags').run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (7002, 'test:7002', 'Operator', 'operator@example.invalid', 'admin')").run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (7000, 'floor-source', 'Private source', 'floor-source', 'article', ?)")
    .bind(JSON.stringify({ secret: 'historic-private-value' })).run();
  await env.DB.prepare("INSERT INTO page_versions (id, page_id, lect, action) VALUES (7001, 7000, ?, 'update')")
    .bind(JSON.stringify({ secret: 'old-private-snapshot' })).run();
  await env.DB.prepare("INSERT INTO taxonomies (id, slug, name) VALUES (7010, 'clinical', 'Clinical')").run();
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (7011, 'Private association', 'private-association', 'clinical')").run();
  const token = await signJWT({ sub: '7002', name: 'Operator', email: 'operator@example.invalid', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  cookie = `access_token=${token}`;
});

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS floor_audit_fail').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS floor_copy_fail').run();
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
});

async function classify(kind: string, key: string, value = 'phi') {
  await env.DB.prepare(`INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)
    ON CONFLICT(container_kind, container_key) DO UPDATE SET class = excluded.class`).bind(kind, key, value).run();
}
async function associate() { await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (7000, 7011)').run(); }
async function failAudit() {
  await env.DB.prepare("CREATE TRIGGER floor_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
}
function admin(path: string, body?: URLSearchParams) {
  return worker.fetch(new Request(`http://localhost/admin${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual',
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `10.95.0.${++requestNo}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body?.toString(),
  }));
}
async function floor(uuid = 'floor-source') { return (await pageSensitivityFloors(env, [uuid], 'uuid')).get(uuid); }

it.each(['page_type', 'taxonomy', 'media_prefix', 'plugin', 'table'] as const)('retains the highest %s classification after direct reduction/removal', async kind => {
  const key = kind === 'media_prefix' ? 'protected/' : 'protected';
  await classify(kind, key, 'pii'); await classify(kind, key, 'phi'); await classify(kind, key, 'pii');
  expect(classFor(await resolveDataClasses(env, true), kind, key)).toBe('phi');
  await env.DB.prepare('DELETE FROM data_classes').run();
  expect(classFor(await resolveDataClasses(env, true), kind, key)).toBe('phi');
});

it('does not let a narrower media prefix lower an existing PHI classification', async () => {
  await classify('media_prefix', 'protected/'); await classify('media_prefix', 'protected/narrow/', 'pii');
  expect(classFor(await resolveDataClasses(env, true), 'media_prefix', 'protected/narrow/file')).toBe('phi');
});

it.each(['before', 'after'])('captures taxonomy sensitivity when classification is assigned %s association', async when => {
  if (when === 'before') await classify('taxonomy', 'clinical');
  await associate();
  if (when === 'after') await classify('taxonomy', 'clinical');
  await env.DB.prepare('DELETE FROM page_tags').run();
  expect(await floor()).toBe('phi');
  expect((await publishPageToTargets(env, 7000, actor))?.refused).toBe(true);
  await failAudit();
  const response = await admin('/pages/7000/read');
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('historic-private-value');
});

it.each(['UPDATE tags SET taxonomy_slug = NULL', 'DELETE FROM tags'])('retains history protection after %s', async sql => {
  await associate(); await classify('taxonomy', 'clinical');
  if (sql.startsWith('UPDATE')) await expect(env.DB.prepare(sql).run()).rejects.toThrow('sensitivity_reduction_requires_review');
  else await env.DB.prepare(sql).run();
  const groups = await prepareReadAudits(env, [{ action: 'page.history', kind: 'page_type', key: 'article', targetType: 'page_version', ids: ['7001'], count: 1 }], actor, true);
  expect(groups.flatMap(group => group.rows)).toMatchObject([{ dataClass: 'phi', targetId: '7001' }]);
  expect(await floor()).toBe('phi');
});

it('refuses retyping below the retained class and permits an equally protected type', async () => {
  await env.DB.prepare("UPDATE pages SET page_type = 'chart'").run(); await classify('page_type', 'chart');
  await expect(env.DB.prepare("UPDATE pages SET page_type = 'article' WHERE id = 7000").run()).rejects.toThrow('sensitivity_reduction_requires_review');
  expect((await env.DB.prepare('SELECT page_type FROM pages WHERE id = 7000').first<{ page_type: string }>())?.page_type).toBe('chart');
  await classify('page_type', 'protected-chart');
  await env.DB.prepare("UPDATE pages SET page_type = 'protected-chart' WHERE id = 7000").run();
  expect(await floor()).toBe('phi');
});

it('keeps aggregate and zero-result probes strict after a sensitive association disappears', async () => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  const groups = await prepareReadAudits(env, [{ action: 'page.search', kind: 'page_type', key: 'article', targetType: 'query', ids: [], count: 0 }], actor, true);
  expect(groups).toMatchObject([{ strict: true, rows: [{ dataClass: 'phi', targetCount: 0 }] }]);
});

it('records actual retained sensitivity in the read event after a tag is removed', async () => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  expect((await admin('/pages/7000/read')).status).toBe(200);
  expect(await env.DB.prepare("SELECT data_class, target_id FROM audit_events WHERE action = 'page.read'").first()).toEqual({ data_class: 'phi', target_id: '7000' });
});

it('retains source UUID sensitivity when a loaded record is deleted before the response audit', async () => {
  await associate(); await classify('taxonomy', 'clinical');
  const page = (await env.DB.prepare('SELECT * FROM pages WHERE id = 7000').first<Page>())!;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (_, next) => { await requestContext.run({ cspNonce: '' }, () => next()); });
  app.use('*', accessLog);
  app.get('/', async c => {
    recordPageReads('page.read', [page], { actor });
    await env.DB.prepare('DELETE FROM pages WHERE id = 7000').run();
    await failAudit();
    return c.json({ lect: page.lect });
  });
  const response = await app.request('http://localhost/', {}, env);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('historic-private-value');
});

it('captures classification assigned to trash-only content and preserves it through restore and purge', async () => {
  await env.DB.prepare("INSERT INTO trash_pages (id, uuid, name, slug, page_type, lect) VALUES (7020, 'trash-only-floor', 'Private trash', 'trash-only-floor', 'article', '{}')").run();
  await env.DB.prepare('INSERT INTO trash_page_tags (page_id, tag_id) VALUES (7020, 7011)').run();
  await classify('taxonomy', 'clinical');
  expect(await floor('trash-only-floor')).toBe('phi');
  await env.DB.prepare('DELETE FROM trash_page_tags').run();
  expect((await admin('/trash/7020/restore', new URLSearchParams())).status).toBe(302);
  expect(await floor('trash-only-floor')).toBe('phi');
  await env.DB.prepare("DELETE FROM pages WHERE uuid = 'trash-only-floor'").run();
  expect(await floor('trash-only-floor')).toBe('phi');
});

it.each(['pull', 'ingest'])('preserves actual published-only taxonomy sensitivity during %s', async operation => {
  await env.DB.prepare("UPDATE tags SET taxonomy_slug = 'public-labels'").run();
  await classify('taxonomy', 'clinical');
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (7030, 'incoming-floor', 'Incoming private', 'incoming-floor', 'article', '{}')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (7011, 'Private association', 'private-association', 'clinical')").run();
  await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (7030, 7011)').run();
  if (operation === 'pull') expect((await pullPublishedPageToDraft(env as Env, 'incoming-floor', actor))?.created).toBe(true);
  else expect((await ingestSubmissions(env)).created).toBe(1);
  expect(await floor('incoming-floor')).toBe('phi');
  const page = await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'incoming-floor'").first<{ id: number }>();
  expect((await publishPageToTargets(env, page!.id, actor))?.refused).toBe(true);
});

async function registerCopyPlugin() {
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret) VALUES ('Floor copy', 'https://floor-copy.local', 1, 'floor-copy-secret')").run();
  __injectPluginFetcher('https://floor-copy.local', { fetch: async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: 'floor-copy', name: 'Copy', version: '1', hooks: ['delete'], contentTypes: { blueprint: { article: ['secret'] } } });
    deliveries++; return new Response('ok');
  } } as Fetcher);
}
function clone() { return worker.fetch(new Request('http://localhost/__cms/pages/duplicate', { method: 'POST',
  headers: { 'x-plugin-id': 'floor-copy', 'x-plugin-secret': 'floor-copy-secret', 'x-acting-user-id': '7002', 'Content-Type': 'application/json' },
  body: JSON.stringify({ source_page_type: 'article', source_page_id: 7090, target_page_id: 7091 }),
})); }

it.each(['success', 'floor-write-failure'])('propagates a new UUID floor atomically with a clone: %s', async failure => {
  await registerCopyPlugin(); await associate(); await classify('taxonomy', 'clinical');
  await env.DB.prepare('UPDATE pages SET page_id = 7090 WHERE id = 7000').run();
  if (failure !== 'success') await env.DB.prepare(`CREATE TRIGGER floor_copy_fail BEFORE INSERT ON page_sensitivity_floors WHEN NEW.uuid <> 'floor-source' BEGIN SELECT RAISE(ABORT, 'floor storage unavailable'); END`).run();
  const response = await clone();
  const copied = await env.DB.prepare('SELECT id, uuid FROM pages WHERE page_id = 7091').first<{ id: number; uuid: string }>();
  if (failure === 'success') {
    expect(response.status).toBe(200); expect(copied).not.toBeNull(); expect(await floor(copied!.uuid)).toBe('phi');
    expect((await publishPageToTargets(env, copied!.id, actor))?.refused).toBe(true);
  } else { expect(response.status).toBe(500); expect(copied).toBeNull(); }
});

it('keeps a deleted draft metadata hook protected through its original UUID', async () => {
  await registerCopyPlugin(); await approvePageTypeAccess(env.DB, 'floor-copy', 'article', 'read', 'test');
  await associate(); await classify('taxonomy', 'clinical');
  await env.DB.prepare('DELETE FROM pages WHERE id = 7000').run();
  await failAudit();
  await expect(deliverHooks(env, undefined, 'delete', [{ id: 7000, uuid: 'floor-source', page_type: 'article' }], actor)).rejects.toThrow();
  expect(deliveries).toBe(0);
});

it('retains ordinary sparse delete hooks on a core/plugins deployment without trash', async () => {
  await registerCopyPlugin();
  const saved = (await env.DB.prepare("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'trash_%' OR name LIKE 'idx_trash_%' OR name LIKE 'sensitivity_trash_%')")
    .all<{ type: string; sql: string }>()).results;
  const objects = (await env.DB.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'sensitivity_trash_%' AND type IN ('trigger', 'view')").all<{ type: string; name: string }>()).results;
  for (const type of ['trigger', 'view']) for (const object of objects.filter(object => object.type === type)) await env.DB.prepare(`DROP ${type} ${object.name}`).run();
  for (const table of ['trash_page_versions', 'trash_page_tags', 'trash_pages']) await env.DB.prepare(`DROP TABLE ${table}`).run();
  try {
    await deliverHooks(env, undefined, 'delete', [{ id: 7099, page_type: 'article' }], actor);
    expect(deliveries).toBe(1);
  } finally {
    for (const type of ['table', 'index', 'view', 'trigger']) for (const object of saved.filter(object => object.type === type)) await env.DB.prepare(object.sql).run();
  }
});

it('refuses floor storage outages before disclosing or publishing retained private content', async () => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  await env.DB.prepare('ALTER TABLE page_sensitivity_floors RENAME TO sensitivity_floor_away').run();
  try {
    expect((await admin('/pages/7000/read')).status).toBe(503);
    expect((await publishPageToTargets(env, 7000, actor))?.refusedReason).toBe('classification_unavailable');
  } finally { await env.DB.prepare('ALTER TABLE sensitivity_floor_away RENAME TO page_sensitivity_floors').run(); }
});

it.each(['sensitivity_link_insert', 'sensitivity_trash_policy_insert'])('fails classification admission when capture trigger %s is missing', async name => {
  const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").bind(name).first<{ sql: string }>();
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    expect((await resolveDataClasses(env, true)).ok).toBe(false);
    expect((await admin('/pages/7000/read')).status).toBe(503);
  } finally { await env.DB.prepare(trigger!.sql).run(); }
});

it('refuses UI reduction/removal of a retained classification', async () => {
  await classify('page_type', 'article');
  const row = await env.DB.prepare("SELECT id FROM data_classes WHERE container_key = 'article'").first<{ id: number }>();
  expect((await admin('/audit/classes', new URLSearchParams({ container_kind: 'page_type', container_key: 'article', class: 'pii' }))).status).toBe(409);
  expect((await admin(`/audit/classes/${row!.id}/delete`, new URLSearchParams())).status).toBe(409);
  expect(classFor(await resolveDataClasses(env, true), 'page_type', 'article')).toBe('phi');
});

it('preserves a floor when a UUID is changed after its classified tags are removed', async () => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  await env.DB.prepare("UPDATE pages SET uuid = 'changed-floor-uuid' WHERE id = 7000").run();
  expect(await floor('changed-floor-uuid')).toBe('phi'); expect(await floor('floor-source')).toBe('phi');
});

it('retains taxonomy classification through a rename and protects newly associated records', async () => {
  await classify('taxonomy', 'clinical');
  await env.DB.prepare("UPDATE taxonomies SET slug = 'renamed-clinical' WHERE id = 7010").run();
  await env.DB.prepare("UPDATE tags SET taxonomy_slug = 'renamed-clinical' WHERE id = 7011").run();
  await associate();
  expect(classFor(await resolveDataClasses(env, true), 'taxonomy', 'renamed-clinical')).toBe('phi');
  expect(await floor()).toBe('phi');
  const screen = await admin('/audit/classes');
  expect(screen.status).toBe(200); expect(await screen.text()).toContain('renamed-clinical');
});

it('shows retained policy-only entries and withholds them when their classified read cannot persist', async () => {
  await classify('page_type', 'retained-private-type');
  await classify('table', 'data_class_floors');
  await env.DB.prepare('DELETE FROM data_classes').run();
  const screen = await admin('/audit/classes');
  expect(screen.status).toBe(200); expect(await screen.text()).toContain('retained-private-type');
  await failAudit();
  const refused = await admin('/audit/classes');
  expect(refused.status).toBe(503); expect(await refused.text()).not.toContain('retained-private-type');
});

it('withholds a UI retype before it changes a protected record', async () => {
  await associate(); await classify('taxonomy', 'clinical');
  const response = await admin('/pages/7000', new URLSearchParams({ name: 'Private source', slug: 'floor-source', page_type: 'public-article', language: 'en' }));
  expect(response.status).toBe(409);
  expect((await env.DB.prepare('SELECT page_type FROM pages WHERE id = 7000').first<{ page_type: string }>())?.page_type).toBe('article');
});

it.each(['d1', 'r2'])('keeps %s live snapshots private after their source association disappears', async source => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('floor-source', 'Live', 'floor-source', 'article', '{}')").run();
  await env.MEDIA_BUCKET!.put('pages/floor-source.json', JSON.stringify({ page_type: 'article', lect: { secret: 'private-live' }, tags: [] }));
  await failAudit();
  await expect(getLiveLect({ ...env, PUBLISH_TARGETS: source, PUBLISH_BUCKET: env.MEDIA_BUCKET }, 'floor-source', actor)).rejects.toThrow();
  await env.MEDIA_BUCKET!.delete('pages/floor-source.json');
});

it('stops a queued bulk mutation when its retained private read cannot persist', async () => {
  await associate(); await classify('taxonomy', 'clinical'); await env.DB.prepare('DELETE FROM page_tags').run();
  const job = await createAdvancedSearchBulkActionJob(env.DB, { action: 'replace_text', scope: 'selected', ids: [7000], pageTypes: ['article'], criteria: [], operator: 'AND', targetTagIds: [],
    searchText: 'historic', replacementText: 'Changed', returnTo: '/admin', user: { sub: '7002', name: 'Operator', email: 'operator@example.invalid', role: 'admin', type: 'access', exp: 9999999999 } });
  await failAudit(); await runCmsAdminJob(env, job.id);
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect((await env.DB.prepare('SELECT lect FROM pages WHERE id = 7000').first<{ lect: string }>())?.lect).toContain('historic-private-value');
});

it('backfills an existing core/trash deployment from current policy and applies upgrades idempotently', async () => {
  await associate(); await classify('taxonomy', 'clinical');
  await env.DB.prepare("INSERT INTO trash_pages (id, uuid, name, slug, page_type) VALUES (7020, 'old-trash', 'Old trash', 'old-trash', 'article')").run();
  await env.DB.prepare('INSERT INTO trash_page_tags (page_id, tag_id) VALUES (7020, 7011)').run();
  const objects = (await env.DB.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') AND name LIKE 'sensitivity_%'").all<{ type: string; name: string }>()).results;
  for (const type of ['trigger', 'view']) for (const object of objects.filter(object => object.type === type)) await env.DB.prepare(`DROP ${type} ${object.name}`).run();
  await env.DB.prepare('DROP TABLE page_sensitivity_floors').run(); await env.DB.prepare('DROP TABLE data_class_floors').run();
  const migrations = env.TEST_SENSITIVITY_UPGRADE;
  expect(migrations).toHaveLength(2);
  await applyD1Migrations(env.DB, migrations);
  expect(await floor()).toBe('phi'); expect(await floor('old-trash')).toBe('phi');
  // Different receipt names force an actual second execution of every idempotent statement.
  await applyD1Migrations(env.DB, migrations.map(migration => ({ ...migration, name: `again-${migration.name}` })));
  expect(await floor()).toBe('phi');
});
