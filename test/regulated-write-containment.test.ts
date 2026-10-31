import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { regulatedRequestWriteBlocked, assertRegulatedWritesAllowed } from '../src/core/http/regulated-writes';
import { coreExtensions, registerCoreExtensions } from '../src/core/extensions';
import { clearConfigCache } from '../src/core/db/content-config';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache, getPlugins } from '../src/features/plugins/registry';
import { createAdvancedSearchBulkActionJob, createPluginAdminActionJob, getAdminJob } from '../src/features/jobs/queue';
import { runCmsAdminJob } from '../src/features/jobs/runner';
import { ingestSubmissions } from '../src/core/db/submission-ingest';
import { pullPublishedPageToDraft } from '../src/core/db/page-store';
import { applyBulkPageAction } from '../src/core/pages/bulk-action';
import { sweepCreditSubscriptions } from '../src/features/credits/subscriptions';
import { signJWT } from './auth-fixtures';
import type { JWTPayload } from '../src/types';

const user: JWTPayload = { sub: '8250', email: 'operator@example.invalid', name: 'Operator', role: 'admin', type: 'access', iat: 1, exp: 9999999999 };
const actor = { userId: user.sub, roles: user.role, sessionSid: null, via: null };
const originalQueueHandler = coreExtensions().handleQueueMessage;
let cookie: string;
let requests = 0;
let deliveries = 0;

function configured() {
  const inventory = [
    { kind: 'page_type', key: 'chart', class: 'phi' },
    { kind: 'plugin', key: 'containment', class: 'public' },
    ...['users', 'settings', 'locales', 'page_types', 'block_types', 'roles', 'role_permissions', 'plugins', 'plugin_identity_approvals',
      'plugin_asset_approvals', 'plugin_file_prefix_approvals', 'plugin_page_type_approvals', 'audit_events', 'data_classes', 'pages', 'trash_pages']
      .map(key => ({ kind: 'table', key, class: 'public' })),
  ];
  return { ...env, REGULATED_MODE: 'true', REGULATED_INVENTORY: JSON.stringify(inventory), CANONICAL_ORIGIN: 'https://cms.example.com' };
}

beforeEach(async () => {
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers(); deliveries = 0;
  await env.DB.prepare('DROP TRIGGER IF EXISTS containment_audit_fail').run();
  for (const table of ['audit_seals', 'audit_events', 'admin_jobs', 'credit_subscriptions', 'plugins', 'pages', 'taxonomies', 'data_classes', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8251, 'contained-chart', 'Private chart', 'contained-chart', 'chart', '{}')").run();
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')").run();
  await env.DB.prepare("INSERT INTO plugins (id, label, url, enabled, secret) VALUES (8252, 'Containment', 'https://containment.local', 1, 'containment-secret')").run();
  await env.DB.prepare("INSERT INTO plugin_identity_approvals (plugin_row_id, manifest_id) VALUES (8252, 'containment')").run();
  await env.DB.prepare("INSERT OR REPLACE INTO plugin_page_type_approvals (plugin_id, page_type, access, approved_by) VALUES ('containment', 'chart', 'write', 'test')").run();
  __injectPluginFetcher('https://containment.local', { fetch: async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: 'containment', name: 'Containment', version: '1', contentTypes: { blueprint: { chart: ['name'] } } });
    deliveries++;
    return new Response('ok');
  } } as Fetcher);
  cookie = `access_token=${await signJWT(user, env.JWT_SECRET)}`;
});
afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS containment_audit_fail').run();
  registerCoreExtensions({ handleQueueMessage: originalQueueHandler });
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
});

function http(method: string, path: string, body?: unknown, extraHeaders?: HeadersInit) {
  return worker.fetch(new Request(`https://cms.example.com${path}`, { method, headers: {
    Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `10.96.0.${++requests}`,
    'x-plugin-id': 'containment', 'x-plugin-secret': 'containment-secret', 'content-type': 'application/json',
    ...extraHeaders,
  }, body: body === undefined ? undefined : JSON.stringify(body) }), configured(), createExecutionContext());
}

it.each([
  ['POST', '/__cms/pages'], ['POST', '/__cms/pages/batch'], ['PATCH', '/__cms/pages/8251'], ['PUT', '/__cms/pages/8251'],
  ['DELETE', '/__cms/pages/8251'], ['POST', '/__cms/pages/duplicate'], ['PUT', '/__cms/files?key=records/test'],
  ['PUT', '/__cms/state/key'], ['DELETE', '/__cms/state/key'], ['POST', '/__cms/sequences/key/next'],
  ['POST', '/__cms/ingest/submissions'], ['POST', '/__cms/credits/usage'], ['POST', '/__cms/tenant/claim'],
  ['POST', '/admin/pages/8251'], ['POST', '/admin/pages/8251/publish'], ['POST', '/admin/pages/8251/delete'],
  ['POST', '/admin/audit/classes'], ['POST', '/admin/plugins-manage/8252/connect'], ['POST', '/admin/users/8250'],
  ['POST', '/admin/plugins/containment/action'], ['POST', '/__cms/future-write?read_only=true'],
])('withholds %s %s before content/configuration work', async (method, path) => {
  const response = await http(method, path, { page_type: 'chart', name: 'Must not be written' }, { 'x-http-method-override': 'GET' });
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toEqual({ error: 'regulated_writes_unavailable' });
  expect((await env.DB.prepare('SELECT name FROM pages WHERE id = 8251').first())?.name).toBe('Private chart');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pages').first())?.n).toBe(1);
  expect(deliveries).toBe(0);
});

it.each([
  ['POST', '/auth/callback'], ['POST', '/auth/refresh'], ['POST', '/auth/logout'], ['POST', '/admin/profile/locale'],
  ['POST', '/admin/pages/8251/unpublish'], ['POST', '/admin/plugins-manage/8252/disconnect'],
  ['POST', '/admin/plugins-manage/8252/assets/revoke'], ['POST', '/admin/plugins-manage/8252/files/revoke'],
  ['POST', '/admin/plugins-manage/8252/page-types/revoke'], ['POST', '/admin/profile/identities/9/disconnect'],
  ['POST', '/admin/audit/outages/incident/reconcile'],
])('leaves %s %s to its existing authorization/containment guard', (method, path) => {
  expect(regulatedRequestWriteBlocked(configured(), new Request(`https://cms.example.com${path}`, { method }))).toBe(false);
  expect(regulatedRequestWriteBlocked(configured(), new Request(`https://cms.example.com${path}/extra`, { method }))).toBe(true);
});

it('keeps protected GET and both explicit POST read APIs available with audit evidence', async () => {
  expect((await http('GET', '/__cms/pages?page_type=chart')).status).toBe(200);
  expect((await http('POST', '/__cms/pages/search', { page_types: ['chart'], criteria: [] })).status).toBe(200);
  expect((await http('POST', '/__cms/pages/list-batch', { queries: [{ key: 'charts', page_type: 'chart', limit: 10, sort: 'name', order: 'ASC' }] })).status).toBe(200);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE data_class = 'phi'").first())?.n).toBeGreaterThan(0);
  // A read exception cannot override credentials or evidence persistence.
  expect((await http('POST', '/__cms/pages/search', { page_types: ['chart'], criteria: [] }, { 'x-plugin-secret': 'wrong' })).status).toBe(403);
  await env.DB.prepare("CREATE TRIGGER containment_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
  const denied = await http('POST', '/__cms/pages/search', { page_types: ['chart'], criteria: [] });
  expect(denied.status).toBe(503);
  expect(await denied.text()).not.toContain('Private chart');
});

it('preserves authenticated withdrawal and capability revocation', async () => {
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('contained-chart', 'Private old copy', 'old-copy', 'chart', '{}')").run();
  expect((await http('POST', '/admin/pages/8251/unpublish')).status).toBe(302);
  expect(await env.PUBLISHED_DB.prepare("SELECT uuid FROM pages WHERE uuid = 'contained-chart'").first()).toBeNull();
  const revoke = await worker.fetch(new Request('https://cms.example.com/admin/plugins-manage/8252/page-types/revoke', {
    method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ page_type: 'chart', access: 'write' }),
  }), configured(), createExecutionContext());
  expect(revoke.status).toBe(302);
  expect(await env.DB.prepare("SELECT id FROM plugin_page_type_approvals WHERE plugin_id = 'containment' AND page_type = 'chart' AND access = 'write'").first()).toBeNull();
});

it('does not bypass authorization for a containment exception', async () => {
  const response = await worker.fetch(new Request('https://cms.example.com/admin/pages/8251/unpublish', {
    method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' },
  }), configured(), createExecutionContext());
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toContain('/auth/login');
});

it('keeps logout able to revoke the current session during containment', async () => {
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 8250').first())?.n).toBeGreaterThan(0);
  const response = await http('POST', '/auth/logout');
  expect(response.status).toBe(302);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 8250').first())?.n).toBe(0);
});

it('holds existing bulk and opaque plugin jobs before claim, including calls outside the queue entrypoint', async () => {
  const jobs = [await createAdvancedSearchBulkActionJob(env.DB, { action: 'replace_text', scope: 'selected', ids: [8251], pageTypes: ['chart'],
    criteria: [], operator: 'AND', targetTagIds: [], searchText: 'Private', replacementText: 'Changed', returnTo: '/admin', user }),
  await createPluginAdminActionJob(env.DB, { pluginId: 'containment', method: 'POST', path: '/__plugin/admin/action', contentType: 'application/json', body: '{}', user })];
  for (const job of jobs) {
    await expect(runCmsAdminJob(configured(), job.id)).rejects.toThrow('durable mutation evidence');
    expect(await getAdminJob(env.DB, job.id)).toMatchObject({ status: 'queued', attempts: 0 });
  }
  expect(deliveries).toBe(0);
});

it('rejects queue batches before dispatch even when no job handler is installed', async () => {
  let dispatched = 0;
  const batch = { messages: [], queue: 'cms-jobs', ackAll() {}, retryAll() {} };
  for (const handler of [async () => { dispatched++; return true; }, undefined]) {
    registerCoreExtensions({ handleQueueMessage: handler });
    await expect(worker.queue(batch, configured())).rejects.toThrow('durable mutation evidence');
  }
  expect(dispatched).toBe(0);
});

it('stops direct ingestion, pull, billing and bulk mutation without changing source state', async () => {
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('incoming-contained', 'Incoming', 'incoming', 'chart', '{}')").run();
  await expect(ingestSubmissions(configured())).rejects.toThrow('durable mutation evidence');
  await expect(pullPublishedPageToDraft(configured(), 'incoming-contained', actor)).rejects.toThrow('durable mutation evidence');
  await expect(sweepCreditSubscriptions(configured())).rejects.toThrow('durable mutation evidence');
  await expect(applyBulkPageAction(configured(), user, 'replace_text', [8251], { searchText: 'Private', replacementText: 'Changed' }))
    .rejects.toThrow('durable mutation evidence');
  expect(await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'incoming-contained'").first()).toBeNull();
  expect((await env.DB.prepare('SELECT name FROM pages WHERE id = 8251').first())?.name).toBe('Private chart');
});

it('keeps audit archival running while cron ingestion and billing are held', async () => {
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('incoming-contained', 'Incoming', 'incoming', 'chart', '{}')").run();
  await env.DB.prepare("INSERT INTO credit_subscriptions (user_id, plugin_id, credit_key, quantity, peak_quantity, status, next_charge_at) VALUES (8250, 'containment', 'storage', 1, 1, 'active', '2000-01-01 00:00:00')").run();
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, retention_class, action, outcome) VALUES ('contained-evidence', ?, 'admin', 'admin_config', 'test.evidence', 'success')").bind(new Date().toISOString()).run();
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} }, configured(), createExecutionContext());
  expect(await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'incoming-contained'").first()).toBeNull();
  expect((await env.DB.prepare("SELECT status, next_charge_at FROM credit_subscriptions WHERE user_id = 8250").first()))
    .toEqual({ status: 'active', next_charge_at: '2000-01-01 00:00:00' });
  const seal = await env.DB.prepare('SELECT r2_key FROM audit_seals').first<{ r2_key: string }>();
  expect(seal?.r2_key).toBeTruthy();
  expect(await env.AUDIT_BUCKET!.head(seal!.r2_key)).not.toBeNull();
});

it('requires an existing pinned identity when resolving plugins during containment', async () => {
  await env.DB.prepare('DELETE FROM plugin_identity_approvals WHERE plugin_row_id = 8252').run();
  expect(await getPlugins(configured())).toEqual([]);
  expect(await env.DB.prepare('SELECT manifest_id FROM plugin_identity_approvals WHERE plugin_row_id = 8252').first()).toBeNull();
  // Ordinary operation retains trust-on-first-use; containment does not alter its contract.
  expect(await getPlugins({ ...configured(), REGULATED_MODE: 'false' })).toHaveLength(1);
});

it('leaves ordinary writes available and treats malformed nonempty modes as contained', async () => {
  const cfg = { ...configured(), REGULATED_MODE: 'false' };
  const response = await worker.fetch(new Request('https://cms.example.com/__cms/pages', {
    method: 'POST', headers: { 'x-plugin-id': 'containment', 'x-plugin-secret': 'containment-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ page_type: 'chart', name: 'Ordinary write' }),
  }), cfg, createExecutionContext());
  expect(response.status).toBe(201);
  expect(() => assertRegulatedWritesAllowed({ REGULATED_MODE: undefined })).not.toThrow();
  expect(() => assertRegulatedWritesAllowed({ REGULATED_MODE: 'yes' })).toThrow('durable mutation evidence');
  expect(regulatedRequestWriteBlocked(configured(), new Request('https://cms.example.com/admin/api/sync/8251', { headers: { Upgrade: 'websocket' } }))).toBe(true);
});
