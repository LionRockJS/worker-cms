import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { deliverHooks } from '../src/features/plugins/hooks';
import { approvePageTypeAccess, revokePageTypeAccess } from '../src/features/plugins/page-types';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from '../src/features/plugins/registry';
import { ingestSubmissions } from '../src/core/db/submission-ingest';
import { createAdvancedSearchBulkActionJob, createPluginAdminActionJob, getAdminJob } from '../src/features/jobs/queue';
import { runCmsAdminJob } from '../src/features/jobs/runner';
import type { JWTPayload } from '../src/types';
import { requestContext } from '../src/core/http/request-context';
import { resolveDataClasses } from '../src/core/db/data-classes';
import { resolveRolePermissions } from '../src/core/auth/roles';

const actor: JWTPayload = { sub: '311', email: 'operator@example.invalid', name: 'Operator', role: 'admin', type: 'access', iat: 1, exp: 9999999999 };
const page = { id: 310, page_type: 'chart', name: 'Private Patient', slug: 'private-patient' };
let deliveries: Array<{ destination: string; auditRows: number; body: string }> = [];
let onDelivery: (() => Promise<void>) | undefined;

beforeEach(async () => {
  clearManifestCache(); __clearInjectedFetchers(); deliveries = []; onDelivery = undefined;
  for (const table of ['plugins', 'admin_jobs', 'audit_events', 'data_classes', 'pages', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags').run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'submissions.ingest.cursor'").run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (311, 'test:311', 'Operator', 'operator@example.invalid', 'admin')").run();
  await env.DB.prepare("INSERT INTO pages (id, name, slug, page_type, lect) VALUES (310, 'Private Patient', 'private-patient', 'chart', '{}')").run();
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')").run();
  const url = 'https://background-reader.local';
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret) VALUES ('Reader', ?, 1, 'test-secret')").bind(url).run();
  await approvePageTypeAccess(env.DB, 'reader', 'chart', 'read', 'test');
  __injectPluginFetcher(url, { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: 'reader', name: 'Reader', version: '1', hooks: ['update', 'submission'], contentTypes: { readTypes: ['chart'] } });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_class IN ('read', 'export')").first<{ n: number }>();
    deliveries.push({ destination: path, auditRows: row?.n ?? 0, body: String(init?.body ?? '') });
    await onDelivery?.();
    return new Response('ok');
  } } as Fetcher);
});
afterEach(() => { clearManifestCache(); __clearInjectedFetchers(); });

it('persists attributable PHI hook intent before the destination receives metadata', async () => {
  await deliverHooks(env, actor, 'update', [page]);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].auditRows).toBeGreaterThan(0);
  const rows = (await env.DB.prepare("SELECT actor_user_id, detail, target_id, event_class FROM audit_events WHERE action = 'page.hook'").all()).results;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_user_id: '311', target_id: '310', event_class: 'export' });
  expect(JSON.parse(String(rows[0].detail))).toMatchObject({ destination: 'reader', operation: 'update', phase: 'intent' });
  expect(JSON.stringify(rows)).not.toContain('Private Patient');
});

it('withholds hook bytes on audit failure outside an HTTP request', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await expect(deliverHooks(env, actor, 'update', [page])).rejects.toThrow(); expect(deliveries).toEqual([]); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('honors destination scope revocation before later hook deliveries', async () => {
  await revokePageTypeAccess(env.DB, 'reader', 'chart', 'read');
  await expect(deliverHooks(env, actor, 'update', [page])).rejects.toThrow('not approved');
  expect(deliveries).toEqual([]);
});

it('attributes contributor-originated hook disclosures to that contributor', async () => {
  await deliverHooks(env, undefined, 'update', [page], { userId: null, roles: null, sessionSid: null, via: 'source-plugin' });
  expect(await env.DB.prepare("SELECT acting_via, actor_user_id FROM audit_events WHERE action = 'page.hook'").first()).toEqual({ acting_via: 'source-plugin', actor_user_id: null });
});

it('fails ingestion before copying or advancing its cursor when PHI read auditing fails', async () => {
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('incoming', 'Private submission', 'incoming', 'chart', '{}')").run();
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    await expect(ingestSubmissions(env)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'incoming'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'submissions.ingest.cursor'").first()).toBeNull();
    expect(deliveries).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('records autonomous ingestion without inventing a user identity', async () => {
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('incoming', 'Private submission', 'incoming', 'chart', '{}')").run();
  expect((await ingestSubmissions(env)).created).toBe(1);
  expect(await env.DB.prepare("SELECT actor_user_id, acting_via FROM audit_events WHERE action = 'submission.ingest-read'").first()).toEqual({ actor_user_id: null, acting_via: 'system:submission-ingest' });
  expect(deliveries[0].auditRows).toBeGreaterThan(1);
});

it('fails a PHI bulk job before changing content if the read event cannot be recorded', async () => {
  const job = await createAdvancedSearchBulkActionJob(env.DB, { action: 'replace_text', scope: 'selected', ids: [310], pageTypes: ['chart'], criteria: [], operator: 'AND', targetTagIds: [], searchText: 'Private', replacementText: 'Replaced', returnTo: '/admin', user: actor });
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await runCmsAdminJob(env, job.id); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect(await env.DB.prepare('SELECT name FROM pages WHERE id = 310').first()).toEqual({ name: 'Private Patient' });
});

it('does not replay a queued plugin request after the user is demoted', async () => {
  const job = await createPluginAdminActionJob(env.DB, { pluginId: 'reader', method: 'POST', path: '/__plugin/admin/export', contentType: 'application/json', body: '{}', user: actor });
  await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = 311").run();
  await runCmsAdminJob(env, job.id);
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect(deliveries).toEqual([]);
});

it('rechecks destination approval between bounded hook chunks', async () => {
  onDelivery = () => revokePageTypeAccess(env.DB, 'reader', 'chart', 'read');
  await expect(deliverHooks(env, actor, 'update', Array.from({ length: 101 }, (_, i) => ({ ...page, id: 1000 + i })))).rejects.toThrow('not approved');
  expect(deliveries).toHaveLength(1);
  expect(JSON.parse(deliveries[0].body).pages).toHaveLength(100);
});

it('refreshes classifications retained by an originating HTTP context', async () => {
  await requestContext.run({ cspNonce: '' }, async () => {
    await env.DB.prepare('DELETE FROM data_classes').run();
    await resolveDataClasses(env);
    await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')").run();
    await revokePageTypeAccess(env.DB, 'reader', 'chart', 'read');
    await expect(deliverHooks(env, actor, 'update', [page])).rejects.toThrow('not approved');
  });
  expect(deliveries).toEqual([]);
});

it('inherits published taxonomy PHI before ingestion or hook disclosure', async () => {
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('taxonomy', 'diagnosis', 'phi')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (410, 'tagged-incoming', 'Private submission', 'incoming', 'chart', '{}')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (411, 'Private diagnosis', 'diagnosis', 'diagnosis')").run();
  await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (410, 411)').run();
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    await expect(ingestSubmissions(env)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'tagged-incoming'").first()).toBeNull();
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  await revokePageTypeAccess(env.DB, 'reader', 'chart', 'read');
  await expect(ingestSubmissions(env)).rejects.toThrow('not approved');
  expect(deliveries).toEqual([]);
  expect(await env.DB.prepare("SELECT data_class, container_key, target_id FROM audit_events WHERE action = 'submission.ingest-read' AND container_key = 'diagnosis'").first())
    .toEqual({ data_class: 'phi', container_key: 'diagnosis', target_id: 'tagged-incoming' });
});

it('withholds PII queued disclosures when their audit cannot be persisted', async () => {
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'admin_jobs', 'pii')").run();
  const job = await createPluginAdminActionJob(env.DB, { pluginId: 'reader', method: 'POST', path: '/__plugin/admin/export', contentType: 'application/json', body: '{}', user: actor });
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await runCmsAdminJob(env, job.id); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect(deliveries).toEqual([]);
});

it('does not run a queued bulk job after its account is deleted', async () => {
  const job = await createAdvancedSearchBulkActionJob(env.DB, { action: 'delete', scope: 'selected', ids: [310], pageTypes: ['chart'], criteria: [], operator: 'AND', targetTagIds: [], searchText: '', replacementText: '', returnTo: '/admin', user: actor });
  await env.DB.prepare('DELETE FROM users WHERE id = 311').run();
  await runCmsAdminJob(env, job.id);
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect(await env.DB.prepare('SELECT id FROM pages WHERE id = 310').first()).not.toBeNull();
});

it('refreshes role policy when a job runs inside its originating request context', async () => {
  const job = await createAdvancedSearchBulkActionJob(env.DB, { action: 'replace_text', scope: 'selected', ids: [310], pageTypes: ['chart'], criteria: [], operator: 'AND', targetTagIds: [], searchText: 'Private', replacementText: 'Replaced', returnTo: '/admin', user: actor });
  await env.DB.prepare("UPDATE users SET role = 'editor' WHERE id = 311").run();
  await requestContext.run({ cspNonce: '' }, async () => {
    await resolveRolePermissions(env);
    await env.DB.prepare("INSERT INTO roles (name, label) VALUES ('editor', 'Editor') ON CONFLICT (name) DO NOTHING").run();
    await env.DB.prepare("DELETE FROM role_permissions WHERE role = 'editor'").run();
    await runCmsAdminJob(env, job.id);
  });
  expect((await getAdminJob(env.DB, job.id))?.status).toBe('failed');
  expect(await env.DB.prepare('SELECT name FROM pages WHERE id = 310').first()).toEqual({ name: 'Private Patient' });
});
