import { env, exports } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from '../src/features/plugins/registry';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';
import { signJWT } from './auth-fixtures';

const worker = (exports as unknown as { default: Fetcher }).default;
const pluginId = 'sensitive-reader';
let upstreamReads = 0;
let cookie: string;

beforeEach(async () => {
  clearManifestCache(); __clearInjectedFetchers(); upstreamReads = 0;
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8510, 'sensitive-reader-page', 'Private record', 'private-record', 'chart', '{}')").run();
  const token = await signJWT({ sub: '8511', name: 'Admin', email: 'admin@example.invalid', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  cookie = `access_token=${token}`;
  const url = 'https://sensitive-reader.local';
  await env.DB.prepare("INSERT INTO plugins (label, url, enabled, secret, config) VALUES ('Reader', ?, 1, 'reader-secret', ?)").bind(url, JSON.stringify({ cmsTrustedUi: true })).run();
  await approvePageTypeAccess(env.DB, pluginId, 'chart', 'read', 'test');
  __injectPluginFetcher(url, { fetch: async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === '/__plugin/manifest') return Response.json({ id: pluginId, name: 'Reader', version: '1', readViews: ['chart'], contentTypes: { readTypes: ['chart'] } });
    if (path === '/__plugin/read' || path.startsWith('/__plugin/admin')) {
      upstreamReads++;
      return new Response('Private plugin response', { headers: { 'content-type': 'text/html' } });
    }
    return new Response('nf', { status: 404 });
  } } as Fetcher);
});
afterEach(() => { clearManifestCache(); __clearInjectedFetchers(); });

async function fetchPage(path: string) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }));
}

it('persists a PHI page event before forwarding a custom read view', async () => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', 'phi')").run();
  expect((await fetchPage('/admin/pages/8510/read')).status).toBe(200);
  expect(upstreamReads).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'page.read'").first<{ n: number }>())?.n).toBe(1);
});

it.each([
  ['/admin/pages/8510/read', 'page_type', 'chart'],
  [`/admin/plugins/${pluginId}/export`, 'plugin', pluginId],
])('refuses disclosure before upstream fetch on audit failure at %s', async (path, kind, key) => {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)').bind(kind, key, 'phi').run();
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    const response = await fetchPage(path);
    expect(response.status).toBe(503);
    expect(upstreamReads).toBe(0);
    expect(await response.text()).not.toContain('Private plugin response');
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it.each(['pii', 'phi'])('retains all %s IDs for projected plugin lists without exposing internal IDs in the response', async dataClass => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'chart', ?)").bind(dataClass).run();
  await env.DB.batch(Array.from({ length: 110 }, (_, index) => env.DB.prepare(
    "INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, 'Projected chart', ?, 'chart', '{}')",
  ).bind(8600 + index, `projection-${index}`, `projection-${index}`)));
  const response = await worker.fetch(new Request('http://localhost/__cms/pages?page_type=chart&fields=name&limit=500', {
    headers: { 'x-plugin-id': pluginId, 'x-plugin-secret': 'reader-secret' },
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { pages: Array<{ name: string; id?: number }> };
  expect(body.pages).toHaveLength(111);
  expect(body.pages.every(page => !('id' in page))).toBe(true);
  const rows = (await env.DB.prepare("SELECT target_ids, target_count, acting_via FROM audit_events WHERE action = 'page.read' ORDER BY seq").all<{ target_ids: string; target_count: number; acting_via: string }>()).results;
  expect(rows.map(row => row.target_count)).toEqual([100, 11]);
  expect(new Set(rows.flatMap(row => JSON.parse(row.target_ids))).size).toBe(111);
  expect(rows.every(row => row.acting_via === pluginId)).toBe(true);
  await expect.poll(async () => env.DB.prepare("SELECT target_count, acting_via FROM audit_events WHERE action = 'page.count'").first())
    .toEqual({ target_count: 111, acting_via: pluginId });
});
