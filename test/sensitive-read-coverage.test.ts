import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { pullPublishedPageToDraft } from '../src/core/db/page-store';
import type { Env } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;
const actor = { userId: '9701', roles: 'admin', sessionSid: null, via: null };
let cookie: string;
let pluginRowId: number;
let requestNo = 0;

beforeEach(async () => {
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
  await env.DB.prepare('DROP TRIGGER IF EXISTS coverage_audit_fail').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS clone_partial_fail').run();
  for (const table of ['plugins', 'plugin_asset_approvals', 'plugin_file_prefix_approvals', 'plugin_page_type_approvals', 'pages', 'users', 'data_classes', 'audit_events', 'tags', 'taxonomies', 'plugin_sequences', 'credit_subscriptions', 'shared_credit_ledger']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags').run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (9701, 'test:9701', 'Private Operator', 'private@example.invalid', 'admin')").run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (id, user_id, provider, provider_user_id, oauth_id) VALUES (9702, 9701, 'test', 'private-provider-id', 'test:9701')").run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (9703, 'coverage-page', 'Private chart', 'coverage-page', 'chart', ?)")
    .bind(JSON.stringify({ secret: 'stored-private-value' })).run();
  await env.DB.prepare("INSERT INTO credit_ledger (id, user_id, currency, delta, balance_after, action, note) VALUES (9704, 9701, 'credit', 1, 1, 'adjust', 'Private ledger note')").run();
  await env.DB.prepare("INSERT INTO taxonomies (id, slug, name) VALUES (9705, 'diagnosis', 'Diagnosis')").run();
  await env.DB.prepare("INSERT INTO tags (id, slug, name, taxonomy_slug) VALUES (9706, 'private-tag', 'Private diagnosis', 'diagnosis')").run();
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret, config) VALUES ('Coverage', 'https://coverage.local', 1, 'coverage-secret', ?)")
    .bind(JSON.stringify({ token: 'private-config-value' })).run();
  pluginRowId = (await env.DB.prepare("SELECT id FROM plugins WHERE url = 'https://coverage.local'").first<{ id: number }>())!.id;
  __injectPluginFetcher('https://coverage.local', { fetch: async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: 'coverage', name: 'Coverage', version: '1',
      contentTypes: { blueprint: { chart: ['secret', 'name'] } },
      limits: [{ key: 'charts', label: 'Charts', page_type: 'chart', scope: 'total', default: 1000 }],
      credits: [{ key: 'send', label: 'Send', charge: 'metered', default: 0 }, { key: 'storage', label: 'Storage', charge: 'recurring', per: 100, default: 0 }],
    });
    return new Response('nf', { status: 404 });
  } } as Fetcher);
  const token = await signJWT({ sub: '9701', name: 'Private Operator', email: 'private@example.invalid', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  cookie = `access_token=${token}`;
});

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS coverage_audit_fail').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS clone_partial_fail').run();
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
});

async function classify(kind: string, key: string, value = 'phi') {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)').bind(kind, key, value).run();
}

async function failAudit() {
  // Reads still work; only persistence fails, which tests withholding after a successful query.
  await env.DB.prepare("CREATE TRIGGER coverage_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
}

function api(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`http://localhost/__cms${path}`, { method,
    headers: { 'x-plugin-id': 'coverage', 'x-plugin-secret': 'coverage-secret', 'x-acting-user-id': '9701', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function admin(path: string) {
  requestNo++;
  return worker.fetch(new Request(`http://localhost/admin${path}`, { headers: { Cookie: cookie, 'CF-Connecting-IP': `10.91.0.${requestNo % 250 + 1}` } }));
}

it.each([
  ['POST', '/pages', { page_type: 'chart', name: 'New chart' }, 'page.create-result'],
  ['POST', '/pages/batch', { pages: [{ page_type: 'chart', name: 'New chart' }] }, 'page.create-result'],
  ['PATCH', '/pages/9703', { lect: { name: 'Updated' } }, 'page.update-result'],
  ['PUT', '/pages/9703', { lect: { name: 'Updated' } }, 'page.update-result'],
  ['PATCH', '/pages/batch', { pages: [{ id: 9703, lect: { name: 'Updated' } }] }, 'page.update-result'],
])('audits full mutation responses through %s %s', async (method, path, body, action) => {
  await classify('page_type', 'chart');
  const response = await api(method, path, body);
  expect(response.status).toBeLessThan(300);
  const row = await env.DB.prepare('SELECT actor_user_id, acting_via, data_class, target_count, detail FROM audit_events WHERE action = ?').bind(action).first();
  expect(row).toMatchObject({ actor_user_id: '9701', acting_via: 'coverage', data_class: 'phi', target_count: 1, detail: null });
  if (method !== 'POST') expect(await response.text()).toContain('stored-private-value');
});

it('withholds an update response containing previously stored fields when its audit fails', async () => {
  await classify('page_type', 'chart'); await failAudit();
  const response = await api('PATCH', '/pages/9703', { lect: { name: 'Updated' } });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('stored-private-value');
  // This is response protection, not an atomic mutation receipt (W4b).
  expect((await env.DB.prepare('SELECT lect FROM pages WHERE id = 9703').first<{ lect: string }>())?.lect).toContain('Updated');
});

it('covers ensured existing tag values without duplicating a publication transfer', async () => {
  await classify('taxonomy', 'diagnosis');
  const response = await api('POST', '/tags/ensure', { tags: [{ taxonomy: 'diagnosis', name: 'Private diagnosis' }] });
  expect(response.status).toBe(200);
  expect(await env.DB.prepare("SELECT target_id, actor_user_id, acting_via FROM audit_events WHERE action = 'tag.ensure-result'").first())
    .toEqual({ target_id: '9706', actor_user_id: '9701', acting_via: 'coverage' });
});

it.each(['GET', 'POST'])('withholds contributor-scoped sequence values on %s audit failure', async method => {
  await classify('plugin', 'coverage'); await failAudit();
  const response = await api(method, method === 'GET' ? '/sequences/chart-number' : '/sequences/chart-number/next');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('"value"');
});

it('audits classified quota aggregates with the contributor actor and no filter values', async () => {
  await classify('page_type', 'chart');
  expect((await api('GET', '/limits?pointer_value=private-search-value')).status).toBe(200);
  const row = await env.DB.prepare("SELECT actor_user_id, acting_via, target_count, query_fingerprint, detail FROM audit_events WHERE action = 'page.limit-usage'").first();
  expect(row).toMatchObject({ actor_user_id: '9701', acting_via: 'coverage', target_count: 1, detail: null });
  expect(String(row?.query_fingerprint)).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(row)).not.toContain('private-search-value');
});

it('audits the clone estimate with captured sensitivity and a private selector fingerprint', async () => {
  await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = 9703')
    .bind(JSON.stringify({ _pointers: { source: 'private-source-selector' } })).run();
  await classify('page_type', 'chart');
  expect((await api('POST', '/pages/duplicate', { source_page_type: 'chart', source_pointer_key: 'source', source_pointer_value: 'private-source-selector' })).status).toBe(200);
  const row = await env.DB.prepare("SELECT target_count, actor_user_id, acting_via, query_fingerprint, detail FROM audit_events WHERE action = 'page.duplicate-count'").first();
  expect(row).toMatchObject({ target_count: 1, actor_user_id: '9701', acting_via: 'coverage', detail: null });
  expect(row?.query_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(row)).not.toContain('private-source-selector');
});

it.each(['/credits', '/credits/quote?key=send'])('withholds classified balances at %s on audit failure', async path => {
  await classify('table', 'credit_wallets'); await failAudit();
  expect((await api('GET', path)).status).toBe(503);
});

it('covers subscription result and list records with their actual IDs', async () => {
  await classify('table', 'credit_subscriptions');
  expect((await api('POST', '/credits/usage', { key: 'storage', quantity: 10, user_id: 9701 })).status).toBe(200);
  expect((await api('GET', '/credits/subscriptions')).status).toBe(200);
  const subscription = await env.DB.prepare('SELECT id FROM credit_subscriptions').first<{ id: number }>();
  const rows = (await env.DB.prepare("SELECT target_id, actor_user_id, acting_via FROM audit_events WHERE action = 'credit.subscription-read'").all()).results;
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.target_id === String(subscription?.id) && row.actor_user_id === '9701' && row.acting_via === 'coverage')).toBe(true);
});

it.each(['users', 'user_oauth_identities', 'credit_ledger', 'credit_wallets', 'shared_credits'])('withholds the profile when its %s read cannot be audited', async table => {
  await classify('table', table); await failAudit();
  const response = await admin('/profile');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('Private');
});

it('records linked identities and ledger IDs without copying their values to evidence', async () => {
  await classify('table', 'user_oauth_identities'); await classify('table', 'credit_ledger');
  expect((await admin('/profile')).status).toBe(200);
  const rows = (await env.DB.prepare("SELECT target_id, detail FROM audit_events WHERE action IN ('identity.profile-read', 'credit.ledger-read')").all()).results;
  expect(rows).toEqual(expect.arrayContaining([{ target_id: '9702', detail: null }, { target_id: '9704', detail: null }]));
});

it('covers local disabled plugin secrets even when no tenant request is sent', async () => {
  await env.DB.prepare('UPDATE plugins SET enabled = 0').run(); clearManifestCache();
  await classify('table', 'plugins'); await failAudit();
  const response = await admin(`/plugins-manage/${pluginRowId}/edit`);
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).not.toContain('coverage-secret'); expect(text).not.toContain('private-config-value');
});

it.each([
  ['assets', 'plugin_asset_approvals', 'plugin.asset-approvals-read', 'coverage:/private.js', "INSERT INTO plugin_asset_approvals (plugin_id, path, integrity, approved_by) VALUES ('coverage', '/private.js', 'sha256-private', 'private-approver')"],
  ['files', 'plugin_file_prefix_approvals', 'plugin.file-approvals-read', 'coverage:private/', "INSERT INTO plugin_file_prefix_approvals (plugin_id, prefix, approved_by) VALUES ('coverage', 'private/', 'private-approver')"],
  ['page-types', 'plugin_page_type_approvals', 'plugin.type-approvals-read', 'coverage:chart:read', "INSERT INTO plugin_page_type_approvals (plugin_id, page_type, access, approved_by) VALUES ('coverage', 'chart', 'read', 'private-approver')"],
])('protects %s approval metadata by its own policy and source identity', async (path, table, action, target, insert) => {
  await env.DB.prepare(insert).run();
  await classify('table', table);
  expect((await admin(`/plugins-manage/${pluginRowId}/${path}`)).status).toBe(200);
  const event = await env.DB.prepare('SELECT target_id, target_ids, actor_user_id, detail FROM audit_events WHERE action = ?').bind(action)
    .first<{ target_id: string; target_ids: string; actor_user_id: string; detail: string | null }>();
  expect(event).toMatchObject({ actor_user_id: '9701', detail: null });
  expect([event?.target_id, ...JSON.parse(event?.target_ids ?? '[]')]).toContain(target);
  await failAudit();
  expect((await admin(`/plugins-manage/${pluginRowId}/${path}`)).status).toBe(503);
});

it('protects a pinned identity even when its plugin is disabled', async () => {
  await env.DB.prepare("INSERT INTO plugin_identity_approvals (plugin_row_id, manifest_id) VALUES (?, 'coverage')").bind(pluginRowId).run();
  await env.DB.prepare('UPDATE plugins SET enabled = 0').run(); clearManifestCache();
  await classify('table', 'plugin_identity_approvals');
  expect((await admin(`/plugins-manage/${pluginRowId}/edit`)).status).toBe(200);
  expect(await env.DB.prepare("SELECT target_id FROM audit_events WHERE action = 'plugin.identity-read'").first()).toEqual({ target_id: String(pluginRowId) });
  await failAudit();
  expect((await admin(`/plugins-manage/${pluginRowId}/edit`)).status).toBe(503);
});

it('attributes cold and cached contributed schema metadata to the current authenticated API caller', async () => {
  await classify('plugin', 'coverage');
  for (const userId of ['9701', '9709']) {
    const response = await worker.fetch(new Request('http://localhost/__cms/content-meta', { headers: {
      'x-plugin-id': 'coverage', 'x-plugin-secret': 'coverage-secret', 'x-acting-user-id': userId,
    } }));
    expect(response.status).toBe(200);
  }
  const rows = (await env.DB.prepare("SELECT actor_user_id, acting_via, target_id FROM audit_events WHERE action = 'plugin.config-metadata-read' ORDER BY seq").all()).results;
  expect(rows).toEqual(['9701', '9709'].map(actor_user_id => ({ actor_user_id, acting_via: 'coverage', target_id: 'coverage' })));
  await failAudit();
  expect((await api('GET', '/content-meta')).status).toBe(503);
});

it('covers joined audit actor labels by the users policy', async () => {
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, retention_class, action, outcome, actor_user_id) VALUES ('joined-actor', ?, 'read', 'admin_config', 'public.read', 'success', '9701')").bind(new Date().toISOString()).run();
  await classify('table', 'users');
  expect((await admin('/audit')).status).toBe(200);
  expect(await env.DB.prepare("SELECT target_id FROM audit_events WHERE action = 'user.audit-actor-read'").first()).toEqual({ target_id: '9701' });
  await failAudit();
  const response = await admin('/audit');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('Private Operator');
});

it('withholds nested taxonomy options on a new schema form when their evidence cannot persist', async () => {
  await classify('taxonomy', 'diagnosis'); await failAudit();
  expect((await admin('/page_types/new')).status).toBe(503);
});

it('audits the published source before manual copying and preserves the actual actor', async () => {
  await classify('page_type', 'chart');
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('manual-pull', 'Private incoming', 'manual-pull', 'chart', '{}')").run();
  await failAudit();
  await expect(pullPublishedPageToDraft(env as unknown as Env, 'manual-pull', actor)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id FROM pages WHERE uuid = 'manual-pull'").first()).toBeNull();
  await env.DB.prepare('DROP TRIGGER coverage_audit_fail').run();
  expect((await pullPublishedPageToDraft(env as unknown as Env, 'manual-pull', actor))?.created).toBe(true);
  expect(await env.DB.prepare("SELECT target_id, actor_user_id FROM audit_events WHERE action = 'page.pull-read'").first()).toEqual({ target_id: 'manual-pull', actor_user_id: '9701' });
});

it('does not silently read an existing draft during manual pull on an audit outage', async () => {
  await classify('page_type', 'chart'); await failAudit();
  await expect(pullPublishedPageToDraft(env as unknown as Env, 'coverage-page', actor)).rejects.toThrow();
});

it('retains PHI sensitivity when reading the audit trail despite a lower table policy', async () => {
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome, target_id) VALUES ('sensitive-evidence', ?, 'read', 'phi', 'phi_access', 'page.read', 'success', 'private-target')").bind(new Date().toISOString()).run();
  await classify('table', 'audit_events', 'pii');
  expect((await admin('/audit')).status).toBe(200);
  expect(await env.DB.prepare("SELECT data_class, target_id FROM audit_events WHERE action = 'audit.events-read'").first()).toEqual({ data_class: 'phi', target_id: 'sensitive-evidence' });
  await failAudit();
  const response = await admin('/audit');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-target');
});

it('withholds PHI review aggregates when only audit writes fail', async () => {
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome, container_key, target_count, actor_user_id) VALUES ('sensitive-signal', ?, 'read', 'phi', 'phi_access', 'page.read', 'success', 'private-container', 501, '9701')").bind(new Date().toISOString()).run();
  await failAudit();
  const response = await admin('/audit/review');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-container');
});

it.each(['pii', 'phi'])('refuses %s inline clones before copying when source-read persistence fails', async dataClass => {
  await env.DB.prepare('UPDATE pages SET page_id = 9799 WHERE id = 9703').run();
  await classify('page_type', 'chart', dataClass); await failAudit();
  const response = await api('POST', '/pages/duplicate', { source_page_type: 'chart', source_page_id: 9799, target_page_id: 9798 });
  expect(response.status).toBe(503);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pages WHERE page_id = 9798').first<{ n: number }>())?.n).toBe(0);
});

it('preserves attributable source-read intent before an inline clone', async () => {
  await env.DB.prepare('UPDATE pages SET page_id = 9799 WHERE id = 9703').run();
  await classify('page_type', 'chart');
  const response = await api('POST', '/pages/duplicate', { source_page_type: 'chart', source_page_id: 9799, target_page_id: 9798 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ count: 1, done: true });
  const row = await env.DB.prepare("SELECT target_id, actor_user_id, acting_via, detail FROM audit_events WHERE action = 'page.duplicate-read'").first();
  expect(row).toMatchObject({ target_id: '9703', actor_user_id: '9701', acting_via: 'coverage' });
  expect(JSON.parse(String(row?.detail))).toMatchObject({ operation: 'duplicate', phase: 'intent' });
  expect(String(row?.detail)).not.toContain('stored-private-value');
});

it('stops later clone chunks without replaying an already committed chunk', async () => {
  await env.DB.prepare('UPDATE pages SET page_id = 9799 WHERE id = 9703').run();
  await env.DB.batch(Array.from({ length: 110 }, (_, i) => env.DB.prepare(
    "INSERT INTO pages (id, uuid, name, slug, page_type, page_id, lect) VALUES (?, ?, 'Private source', ?, 'chart', 9799, '{}')",
  ).bind(10000 + i, `clone-source-${i}`, `clone-source-${i}`)));
  await classify('page_type', 'chart');
  await env.DB.prepare(`CREATE TRIGGER clone_partial_fail BEFORE INSERT ON audit_events
    WHEN NEW.action = 'page.duplicate-read' AND (SELECT COUNT(*) FROM audit_events WHERE action = 'page.duplicate-read') >= 2
    BEGIN SELECT RAISE(ABORT, 'later chunk audit unavailable'); END`).run();
  const response = await api('POST', '/pages/duplicate', { source_page_type: 'chart', source_page_id: 9799, target_page_id: 9798 });
  expect(response.status).toBe(503);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pages WHERE page_id = 9798').first<{ n: number }>())?.n).toBe(100);
  const evidence = (await env.DB.prepare("SELECT target_count, detail FROM audit_events WHERE action = 'page.duplicate-read' ORDER BY seq").all<{ target_count: number; detail: string }>()).results;
  expect(evidence.map(row => row.target_count)).toEqual([100, 1]);
  expect(new Set(evidence.map(row => JSON.parse(row.detail).manifest_id)).size).toBe(1);
});
