// Temporary assessment probes: these assertions demonstrate current weaknesses,
// not desired behavior. Synthetic data and local Cloudflare bindings only.
import { env, exports } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from '../src/features/plugins/registry';
import { approveFilePrefix } from '../src/features/plugins/file-prefixes';
import { signJWT } from '../src/core/auth/jwt';
import { clearRolePermissionsCache } from '../src/core/auth/roles';

const worker = (exports as unknown as { default: Fetcher }).default;
const pluginId = 'assessment-plugin';
const secret = 'synthetic-assessment-plugin-secret';
const url = 'https://assessment-plugin.local';
let blueprint: Record<string, unknown>;
const prefix = 'assessment-private/';
let userId: number;
let pageId: number;

beforeEach(async () => {
  clearManifestCache();
  clearRolePermissionsCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  blueprint = { assessment: {} };
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind('Assessment', url, secret).run();
  __injectPluginFetcher(url, { fetch: async () => Response.json({
    id: pluginId, name: 'Assessment', version: '1',
    contentTypes: { blueprint }, filePrefixes: [prefix],
  }) } as unknown as Fetcher);
  const suffix = crypto.randomUUID();
  const user = await env.DB.prepare('INSERT INTO users (oauth_id, email, name, role) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(suffix, `${suffix}@example.invalid`, 'Assessment', 'admin').first<{ id: number }>();
  userId = user!.id;
  const page = await env.DB.prepare('INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, ?, ?) RETURNING id')
    .bind('Private synthetic content', suffix, 'default', '{"private":"synthetic-marker"}').first<{ id: number }>();
  pageId = page!.id;
});

afterEach(async () => {
  await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.MEDIA_BUCKET.delete(`${prefix}internal.txt`);
  clearManifestCache();
  clearRolePermissionsCache();
  __clearInjectedFetchers();
});

async function cookie(): Promise<string> {
  const token = await signJWT({ sub: String(userId), email: 'assessment@example.invalid', name: 'Assessment',
    role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  return `__Host-access_token=${token}`;
}
function api(path: string, method = 'GET', body?: string) {
  return worker.fetch(`https://cms.example.com/__cms${path}`, {
    method, headers: { 'x-plugin-id': pluginId, 'x-plugin-secret': secret, 'content-type': 'text/plain' }, body,
  });
}

it('demonstrates anonymous reads of a file written through the authenticated plugin API', async () => {
  await approveFilePrefix(env.DB, pluginId, prefix, 'assessment');
  const key = `${prefix}internal.txt`;
  expect((await api(`/files?key=${key}`, 'PUT', 'synthetic-private-marker')).status).toBe(200);
  const anonymousApi = await worker.fetch(`https://cms.example.com/__cms/files?key=${key}`);
  expect(anonymousApi.status).not.toBe(200);
  for (const route of ['media', 'media-preview']) {
    const response = await worker.fetch(`https://cms.example.com/${route}/${key}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('synthetic-private-marker');
    expect(response.headers.get('cache-control')).toContain('public');
  }
});

it('demonstrates a manifest adding another page type without delegated approval', async () => {
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  blueprint = { assessment: {}, default: {} };
  clearManifestCache();
  const response = await api(`/pages/${pageId}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('synthetic-marker');
});

it('demonstrates a manifest granting itself wildcard page access', async () => {
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  blueprint = { assessment: {}, '*': {} };
  clearManifestCache();
  expect((await api(`/pages/${pageId}`)).status).toBe(200);
});

it('demonstrates a demoted account retaining an admin-only route with its old token', async () => {
  const headers = { Cookie: await cookie(), Accept: 'application/json' };
  await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").bind(userId).run();
  expect((await worker.fetch('https://cms.example.com/admin/users', { headers })).status).toBe(200);
});

it('demonstrates a deleted account retaining an admin-only route with its old token', async () => {
  const headers = { Cookie: await cookie(), Accept: 'application/json' };
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  expect((await worker.fetch('https://cms.example.com/admin/users', { headers })).status).toBe(200);
});

it('demonstrates the WebSocket handshake accepting a sibling-site Origin', async () => {
  const response = await worker.fetch(`https://cms.example.com/admin/api/sync/${pageId}`, {
    headers: { Cookie: await cookie(), Upgrade: 'websocket', Origin: 'https://untrusted.example.com' },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  response.webSocket!.close(1000);
});
