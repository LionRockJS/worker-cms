import { env, exports } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { unpublishPageFromTargets, unpublishPagesFromTargets, removeTagFromTargets } from '../src/core/publish';
import { d1Adapter } from '../src/core/publish/d1';
import { r2Adapter } from '../src/core/publish/r2';
import { trashDraftPage } from '../src/core/db/admin-queries';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache, pluginById } from '../src/features/plugins/registry';
import { enrollPluginTenant, revokePluginTenant } from '../src/features/plugins/enroll';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';
import { signJWT } from './auth-fixtures';
import type { Env, Page } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;
const actor = { userId: '6501', roles: 'admin', sessionSid: null, via: null };
const pluginId = 'managed-target';
const pluginUrl = 'https://managed-target.local';
const uuid = 'withdrawal-6500';
const secret = 'c'.repeat(64);
const privateValue = 'sensitive-tenant-value';
let cookie: string;
let rowId: number;
let calls: Array<{ path: string; body: string; audits: number; headers: Headers }> = [];
let onCall: ((path: string, body: string) => Promise<Response | undefined>) | undefined;

function localEnv(targets = 'd1,r2'): Env {
  return { ...env, PUBLISH_TARGETS: targets, PUBLISH_BUCKET: env.MEDIA_BUCKET } as unknown as Env;
}
async function classify(kind: string, key: string, value = 'phi') {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?) ON CONFLICT (container_kind, container_key) DO UPDATE SET class = excluded.class')
    .bind(kind, key, value).run();
}
async function exportsFor(action: string) {
  return (await env.DB.prepare('SELECT actor_user_id, acting_via, target_id, target_ids, target_count, data_class, outcome, detail FROM audit_events WHERE action = ? ORDER BY seq')
    .bind(action).all()).results;
}
async function resolved() { return (await pluginById(localEnv(), pluginId))!; }
async function request(path: string, body?: BodyInit) {
  return worker.fetch(new Request(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', body,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }) }, redirect: 'manual' }));
}
async function claim(ticket: string) {
  return worker.fetch(new Request('http://localhost/__cms/tenant/claim', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: pluginId, ticket }), redirect: 'manual' }));
}
async function withoutAudit(body: () => Promise<void>) {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await body(); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
}

beforeEach(async () => {
  clearManifestCache(); __clearInjectedFetchers(); calls = []; onCall = undefined;
  for (const table of ['plugins', 'plugin_page_type_approvals', 'settings', 'audit_events', 'data_classes', 'page_tags', 'trash_page_tags', 'page_versions', 'pages', 'trash_pages', 'tags', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const table of ['page_tags', 'pages', 'tags']) await env.PUBLISHED_DB.prepare(`DELETE FROM ${table}`).run();
  await env.MEDIA_BUCKET!.delete([`pages/${uuid}.json`, 'index.json']);
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (6501, 'test:6501', 'Operator', 'operator@example.invalid', 'admin')").run();
  const page = (await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (6500, ?, 'Private record', 'private-record', 'chart', ?) RETURNING *")
    .bind(uuid, JSON.stringify({ body: 'Private clinical body' })).first<Page>())!;
  const snapshot = { page, tags: [], tagCatalogue: [], publishedAt: new Date().toISOString() };
  await d1Adapter(env.PUBLISHED_DB).publish(snapshot);
  await r2Adapter(env.MEDIA_BUCKET!).publish(snapshot);
  await classify('page_type', 'chart');
  rowId = Number((await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret, config) VALUES (?, ?, 1, ?, ?) RETURNING id')
    .bind('Managed', pluginUrl, secret, JSON.stringify({ cmsTrustedUi: true })).first<{ id: number }>())!.id);
  await approvePageTypeAccess(env.DB, pluginId, 'chart', 'write', 'test');
  __injectPluginFetcher(pluginUrl, { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: pluginId, name: 'Managed', version: '1', publishTarget: true,
      autoTenant: true, tenantVars: ['PRIVATE_VALUE'], assets: [{ path: '/assets/app.js', label: 'App' }], contentTypes: { writeTypes: ['chart'] } });
    const audits = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_class = 'export'").first<{ n: number }>().catch(() => null))?.n ?? 0);
    const body = String(init?.body ?? '');
    calls.push({ path, body, audits, headers: new Headers(init?.headers) });
    const overridden = await onCall?.(path, body);
    if (overridden) return overridden;
    if (path === '/__plugin/tenants/config') return Response.json({ vars: { PRIVATE_VALUE: privateValue } });
    if (path === '/assets/app.js') return new Response('console.log("app")');
    return Response.json({ ok: true });
  } } as Fetcher);
  cookie = `access_token=${await signJWT({ sub: '6501', name: 'Operator', email: 'operator@example.invalid', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET)}`;
});
afterEach(() => { clearManifestCache(); __clearInjectedFetchers(); });

it('records actor, all destinations and PHI context before withdrawing bytes', async () => {
  const outcome = await unpublishPageFromTargets(localEnv(), uuid, false, actor);
  expect(outcome).toMatchObject({ failures: [] }); expect(outcome.auditFailures).toBeUndefined();
  const rows = await exportsFor('publish.withdrawal-intent');
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map(row => JSON.parse(String(row.detail)).destination))).toEqual(new Set(['d1', 'r2', `plugin:${pluginId}`]));
  expect(rows.every(row => row.actor_user_id === actor.userId && row.target_id === uuid)).toBe(true);
  expect(rows.every(row => JSON.parse(String(row.detail)).containment === true)).toBe(true);
  expect((await exportsFor('page.withdrawal')).every(row => row.data_class === 'phi')).toBe(true);
  expect(calls).toHaveLength(1); expect(calls[0].audits).toBeGreaterThan(0);
  expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).toBeNull();
  expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).toBeNull();
  expect(JSON.stringify(rows)).not.toMatch(/Private record|Private clinical body/);
});

it('preserves containment and returns explicit per-target audit degradation', async () => {
  await withoutAudit(async () => {
    const outcome = await unpublishPageFromTargets(localEnv(), uuid, false, actor);
    expect(outcome.failures).toEqual([]);
    expect(outcome.auditFailures).toEqual(['d1', 'r2', `plugin:${pluginId}`]);
    expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).toBeNull();
    expect(await env.MEDIA_BUCKET!.head(`pages/${uuid}.json`)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

it('records degraded classification without calling unknown policy public', async () => {
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
  try {
    expect((await unpublishPageFromTargets(localEnv(), uuid, false, actor)).auditFailures).toHaveLength(3);
    const rows = await exportsFor('publish.withdrawal-intent');
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.outcome === 'error' && JSON.parse(String(row.detail)).classification === 'unavailable')).toBe(true);
  } finally { await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run(); }
});

it('keeps taxonomy classification after a page is moved to trash', async () => {
  await env.DB.prepare('DELETE FROM data_classes').run();
  await classify('taxonomy', 'diagnosis');
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (6550, 'Private diagnosis', 'diagnosis', 'diagnosis')").run();
  await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (6500, 6550)').run();
  await trashDraftPage(env.DB, 6500);
  await unpublishPageFromTargets(localEnv(), uuid, false, actor);
  const rows = await exportsFor('page.trash-withdrawal');
  expect(rows.length).toBeGreaterThan(0); expect(rows.every(row => row.data_class === 'phi')).toBe(true);
});

it('uses published-only classification and records orphan withdrawals as degraded', async () => {
  await env.DB.prepare('DELETE FROM pages WHERE id = 6500').run();
  expect((await unpublishPageFromTargets(localEnv(), uuid, false, actor)).auditFailures).toBeUndefined();
  expect((await exportsFor('page.withdrawal')).some(row => row.target_id === uuid && row.data_class === 'phi')).toBe(true);
  expect((await unpublishPageFromTargets(localEnv(), 'unknown-uuid', false, actor)).auditFailures).toHaveLength(3);
  expect((await exportsFor('publish.withdrawal-intent')).some(row => row.target_id === 'unknown-uuid' && row.outcome === 'error')).toBe(true);
});

it('retains every UUID in bounded bulk withdrawal rows', async () => {
  const pages = Array.from({ length: 120 }, (_, index) => ({ uuid: `bulk-withdraw-${index}` }));
  await env.DB.batch(pages.map((page, index) => env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type) VALUES (?, ?, 'Private record', ?, 'chart')")
    .bind(6600 + index, page.uuid, `bulk-${index}`)));
  await unpublishPagesFromTargets(localEnv('d1'), pages, actor);
  const rows = (await exportsFor('publish.withdrawal-intent')).filter(row => JSON.parse(String(row.detail)).destination === 'd1');
  expect(rows.map(row => row.target_count)).toEqual([100, 20]);
  expect(new Set(rows.flatMap(row => JSON.parse(String(row.target_ids)))).size).toBe(120);
  const pluginRows = (await exportsFor('page.withdrawal')).filter(row => JSON.parse(String(row.detail)).destination === `plugin:${pluginId}`);
  expect(pluginRows).toHaveLength(120);
  expect(pluginRows.every(row => row.data_class === 'phi')).toBe(true);
});

it('does not disclose submission mirror identifiers to withdrawal targets', async () => {
  const outcome = await unpublishPagesFromTargets(localEnv(), [{ uuid, submission_origin: true }], actor);
  expect(outcome.refusedCount).toBe(1); expect(calls).toEqual([]);
  expect(await exportsFor('publish.withdrawal-intent')).toEqual([]);
});

it('audits PHI tag withdrawal before catalogue removal', async () => {
  await classify('taxonomy', 'diagnosis');
  await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (6550, 'Private diagnosis', 'diagnosis', 'diagnosis')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (6550, 'Private diagnosis', 'diagnosis', 'diagnosis')").run();
  expect((await removeTagFromTargets(localEnv(), 6550, actor)).auditFailures).toBeUndefined();
  expect((await exportsFor('tag.withdrawal')).every(row => row.data_class === 'phi' && row.actor_user_id === '6501')).toBe(true);
  expect(await env.PUBLISHED_DB.prepare('SELECT id FROM tags WHERE id = 6550').first()).toBeNull();
  expect(calls[0].audits).toBeGreaterThan(0);
});

it('preserves the authenticated user and warning on an HTTP containment withdrawal', async () => {
  await withoutAudit(async () => {
    const response = await request('/admin/pages/6500/unpublish', new URLSearchParams());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('audit%20evidence%20incomplete');
    await response.text();
    expect(await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?').bind(uuid).first()).toBeNull();
  });
});

it('retains the source plugin and delegated user on delete-triggered withdrawal', async () => {
  const response = await worker.fetch(new Request('http://localhost/__cms/pages/6500', { method: 'DELETE',
    headers: { 'x-plugin-id': pluginId, 'x-plugin-secret': secret, 'x-acting-user-id': '6501' }, redirect: 'manual' }));
  expect(response.status).toBe(200); await response.text();
  const rows = await exportsFor('publish.withdrawal-intent');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.actor_user_id === '6501' && row.acting_via === pluginId)).toBe(true);
});

it.each([
  ['GET', 'edit'], ['POST', 'tenant-config'], ['GET', 'assets'], ['POST', 'assets/approve'],
])('withholds management %s %s before the exchange on audit failure', async (method, suffix) => {
  await withoutAudit(async () => {
    const response = await request(`/admin/plugins-manage/${rowId}/${suffix}`, method === 'POST' ? new URLSearchParams({ tenant_var_PRIVATE_VALUE: privateValue, path: '/assets/app.js' }) : undefined);
    expect(response.status).toBe(503); await response.text(); expect(calls).toEqual([]);
  });
});

it('audits configuration exchange without copying values, secrets or email', async () => {
  await classify('plugin', pluginId, 'pii');
  await classify('table', 'plugins', 'pii');
  const response = await request(`/admin/plugins-manage/${rowId}/tenant-config`, new URLSearchParams({ tenant_var_PRIVATE_VALUE: privateValue }));
  expect(response.status).toBe(302); await response.text();
  expect(calls).toHaveLength(1); expect(calls[0].audits).toBeGreaterThan(0);
  expect(calls[0].body).toContain(privateValue);
  const rows = await exportsFor('plugin.management-intent');
  expect(rows).toHaveLength(1); expect(rows[0].actor_user_id).toBe('6501');
  expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${privateValue}|${secret}|operator@example`));
  expect((await exportsFor('plugin.management-disclosure')).some(row => row.target_id === String(rowId))).toBe(true);
});

it('withholds a new enrollment before minting a ticket when auditing fails', async () => {
  const plugin = await resolved();
  await withoutAudit(async () => {
    expect(await enrollPluginTenant(localEnv(), plugin, actor)).toEqual({ ok: false, code: 'audit-unavailable' });
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'plugin.enrollment.managed-target'").first()).toBeNull();
    expect(calls).toEqual([]);
  });
});

it('does not issue a management secret or ticket during classification failure', async () => {
  const plugin = await resolved();
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
  try {
    expect(await enrollPluginTenant(localEnv(), plugin, actor)).toEqual({ ok: false, code: 'audit-unavailable' });
    const response = await request(`/admin/plugins-manage/${rowId}/tenant-config`, new URLSearchParams({ tenant_var_PRIVATE_VALUE: privateValue }));
    expect(response.status).toBe(503); await response.text(); expect(calls).toEqual([]);
  } finally { await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run(); }
});

it('persists separate enrollment and credential-claim intent with the initiating actor', async () => {
  onCall = async (path, body) => {
    if (path !== '/__plugin/tenants/enroll') return;
    const payload = JSON.parse(body);
    const response = await claim(payload.ticket);
    expect(response.status).toBe(200);
    expect((await response.json() as { secret: string }).secret).toBe(secret);
    return Response.json({ ok: true });
  };
  expect((await enrollPluginTenant(localEnv(), await resolved(), actor)).ok).toBe(true);
  const rows = await exportsFor('plugin.management-intent');
  expect(rows).toHaveLength(2);
  expect(rows.map(row => JSON.parse(String(row.detail)).operation)).toEqual(['enroll', 'credential-claim']);
  expect(rows.map(row => row.acting_via)).toEqual([null, pluginId]);
  expect(rows.every(row => row.actor_user_id === '6501')).toBe(true);
  const ticket = JSON.parse(calls[0].body).ticket;
  expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${ticket}|${secret}|operator@example`));
});

it('never releases the secret if the claim audit fails after the ticket was sent', async () => {
  onCall = async (path, body) => {
    if (path !== '/__plugin/tenants/enroll') return;
    const ticket = JSON.parse(body).ticket;
    await withoutAudit(async () => {
      const response = await claim(ticket);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(secret);
    });
    const replay = await claim(ticket); expect(replay.status).toBe(403); await replay.text();
    return new Response('declined', { status: 403 });
  };
  expect((await enrollPluginTenant(localEnv(), await resolved(), actor)).ok).toBe(false);
  expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'plugin.enrollment.managed-target'").first()).toBeNull();
});

it('does not copy a plugin error body into enrollment or revocation failure records', async () => {
  onCall = async () => new Response(`${secret} ${privateValue}`, { status: 500 });
  const plugin = await resolved();
  expect(await enrollPluginTenant(localEnv(), plugin, actor)).toEqual({ ok: false, code: 'rejected', detail: '500' });
  expect(await revokePluginTenant(localEnv(), plugin, actor)).toEqual({ ok: false, code: 'rejected', detail: '500' });
  expect(JSON.stringify(await exportsFor('plugin.management-intent'))).not.toContain(privateValue);
});

it('retains tenant revocation during an audit outage with an explicit warning', async () => {
  const plugin = await resolved();
  await withoutAudit(async () => {
    expect(await revokePluginTenant(localEnv(), plugin, actor)).toEqual({ ok: true, code: 'connected', auditUnavailable: true });
  });
});
