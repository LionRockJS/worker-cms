// Regression tests for the independently reproduced security findings.
// Synthetic data and local Cloudflare bindings only; no fixture auto-approvals.
import { env, exports } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from '../src/features/plugins/registry';
import { approveFilePrefix } from '../src/features/plugins/file-prefixes';
import { createAuthSession, revokeRefreshSession } from '../src/core/auth/sessions';
import { approvePageTypeAccess, revokePageTypeAccess } from '../src/features/plugins/page-types';
import { projectLect } from '../src/core/publish/projection';
import { limitedBytes } from '../src/core/http/body-limit';
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
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals WHERE plugin_id = ?').bind(pluginId).run();
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
  await env.DB.prepare('DELETE FROM media_files WHERE key = ?').bind(`${prefix}internal.txt`).run();
  clearManifestCache();
  clearRolePermissionsCache();
  __clearInjectedFetchers();
});

async function credentials() {
  return createAuthSession(env.DB, { id: userId, email: 'assessment@example.invalid', name: 'Assessment', role: 'admin' }, env.JWT_SECRET);
}
async function cookie(): Promise<string> {
  return `__Host-access_token=${(await credentials()).accessToken}`;
}
function api(path: string, method = 'GET', body?: string) {
  return worker.fetch(`https://cms.example.com/__cms${path}`, {
    method, headers: { 'x-plugin-id': pluginId, 'x-plugin-secret': secret, 'content-type': 'text/plain' }, body,
  });
}

it('denies anonymous access to plugin files on both public routes', async () => {
  await approveFilePrefix(env.DB, pluginId, prefix, 'assessment');
  const key = `${prefix}internal.txt`;
  expect((await api(`/files?key=${key}`, 'PUT', 'synthetic-private-marker')).status).toBe(200);
  const anonymousApi = await worker.fetch(`https://cms.example.com/__cms/files?key=${key}`);
  expect(anonymousApi.status).not.toBe(200);
  for (const route of ['media', 'media-preview']) {
    const response = await worker.fetch(`https://cms.example.com/${route}/${key}`);
    expect(response.status).toBe(404);
  }
});

it('rejects manifest access expansion without host approval', async () => {
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  blueprint = { assessment: {}, default: {} };
  clearManifestCache();
  const response = await api(`/pages/${pageId}`);
  expect(response.status).toBe(403);
});

it('rejects wildcard blueprint declarations', async () => {
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  blueprint = { assessment: {}, '*': {} };
  clearManifestCache();
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
});

it('denies a demoted account using its old administrator token', async () => {
  const headers = { Cookie: await cookie(), Accept: 'application/json' };
  await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").bind(userId).run();
  expect((await worker.fetch('https://cms.example.com/admin/users', { headers })).status).toBe(403);
});

it('denies a deleted account using its old administrator token', async () => {
  const headers = { Cookie: await cookie(), Accept: 'application/json' };
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  expect((await worker.fetch('https://cms.example.com/admin/users', { headers })).status).toBe(401);
});

it('rejects a WebSocket handshake from a sibling origin', async () => {
  const response = await worker.fetch(`https://cms.example.com/admin/api/sync/${pageId}`, {
    headers: { Cookie: await cookie(), Upgrade: 'websocket', Origin: 'https://untrusted.example.com' },
  });
  expect(response.status).toBe(403);
});


it('allows a host-approved type and immediately honors revocation', async () => {
  blueprint = { assessment: {} };
  await env.DB.prepare("UPDATE pages SET page_type = 'assessment' WHERE id = ?").bind(pageId).run();
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  await approvePageTypeAccess(env.DB, pluginId, 'assessment', 'write', 'operator');
  expect((await api(`/pages/${pageId}`)).status).toBe(200);
  expect((await api(`/pages/${pageId}`, 'PUT', JSON.stringify({ name: 'Approved update' }))).status).toBe(200);
  await revokePageTypeAccess(env.DB, pluginId, 'assessment', 'write');
  expect((await api(`/pages/${pageId}`)).status).toBe(403);
  expect((await api(`/pages/${pageId}`, 'PUT', JSON.stringify({ name: 'Forbidden update' }))).status).toBe(403);
});

it('denies a replayed access token after its refresh session is revoked', async () => {
  const issued = await credentials();
  await revokeRefreshSession(env.DB, env.JWT_SECRET, issued.refreshToken);
  expect((await worker.fetch('https://cms.example.com/admin/users', {
    headers: { Cookie: `__Host-access_token=${issued.accessToken}`, Accept: 'application/json' },
  })).status).toBe(401);
});

it('upgrades a same-origin socket and rejects messages after revocation', async () => {
  const issued = await credentials();
  const response = await worker.fetch(`https://cms.example.com/admin/api/sync/${pageId}`, {
    headers: { Cookie: `__Host-access_token=${issued.accessToken}`, Upgrade: 'websocket', Origin: 'https://cms.example.com' },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  await revokeRefreshSession(env.DB, env.JWT_SECRET, issued.refreshToken);
  const closed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket did not close')), 3000);
    ws.addEventListener('close', (event) => { clearTimeout(timer); resolve(event.code); }, { once: true });
  });
  ws.send(JSON.stringify({ type: 'sync' }));
  expect(await closed).toBe(1008);
});

it('does not trust a remote UI declaration without host approval, even through a direct frame URL', async () => {
  const response = await worker.fetch(`https://cms.example.com/admin/plugins/${pluginId}?__cms_sandbox=1`, {
    headers: { Cookie: await cookie() },
  });
  expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
});

it('preserves no user data for an empty publication allowlist and excludes private metadata', () => {
  const lect = JSON.stringify({ _type: 'event', _private: 'secret', name: 'Public', private: 'secret' });
  expect(JSON.parse(projectLect(lect, { keep: [] })!)).toEqual({ _type: 'event' });
  expect(JSON.parse(projectLect(lect, { keep: ['name'] })!)).toEqual({ _type: 'event', name: 'Public' });
});

it('cancels oversized responses without trusting Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  });
  await expect(limitedBytes(new Response(body, { headers: { 'content-length': '1' } }), 1500)).rejects.toThrow();
  expect(cancelled).toBe(true);
});


it('blocks private files before looking up a warmed public preview cache', async () => {
  const key = `${prefix}internal.txt`;
  await env.DB.prepare('INSERT INTO media_files (key, url, filename) VALUES (?, ?, ?)')
    .bind(key, `/media/${key}`, 'internal.txt').run();
  const preview = `https://cms.example.com/media-preview/${key}`;
  await caches.default.put(new Request(preview + '?__media_policy=2'), new Response('old-public-copy'));
  await approveFilePrefix(env.DB, pluginId, prefix, 'operator');
  expect((await api(`/files?key=${key}`, 'PUT', 'private-marker')).status).toBe(200);
  expect((await worker.fetch(preview)).status).toBe(404);
  expect((await worker.fetch(`https://cms.example.com/media/${key}`)).status).toBe(404);
});

it('revokes an access-only logout request and denies replay', async () => {
  const issued = await credentials();
  const headers = { Cookie: `__Host-access_token=${issued.accessToken}`, Origin: 'https://cms.example.com', Accept: 'application/json' };
  expect((await worker.fetch('https://cms.example.com/auth/logout', { method: 'POST', headers, redirect: 'manual' })).status).toBe(302);
  expect((await worker.fetch('https://cms.example.com/admin/users', { headers })).status).toBe(401);
});

it('lets an administrator review and approve a newly declared concrete page type', async () => {
  const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(url).first<{ id: number }>();
  const headers = { Cookie: await cookie(), Origin: 'https://cms.example.com', 'content-type': 'application/x-www-form-urlencoded' };
  const review = await worker.fetch(`https://cms.example.com/admin/plugins-manage/${row!.id}/page-types`, { headers });
  expect(await review.text()).toContain('assessment');
  const response = await worker.fetch(`https://cms.example.com/admin/plugins-manage/${row!.id}/page-types/approve`, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ page_type: 'assessment', access: 'write' }),
  });
  expect(response.status).toBe(302);
  await env.DB.prepare("UPDATE pages SET page_type = 'assessment' WHERE id = ?").bind(pageId).run();
  expect((await api(`/pages/${pageId}`)).status).toBe(200);
});
