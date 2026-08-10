import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __clearInjectedFetchers, __injectPluginFetcher } from '../src/features/plugins/registry';
import { approveFilePrefix, revokeFilePrefix } from '../src/features/plugins/file-prefixes';

const worker = (exports as unknown as { default: Fetcher }).default;
const PLUGIN_ID = 'file-plugin';
const PLUGIN_SECRET = 'file-api-test-secret';
const FILE_PREFIX = `plugin-data/${crypto.randomUUID()}/`;

async function api(method: string, query: string, body?: BodyInit, secret = PLUGIN_SECRET): Promise<Response> {
  return worker.fetch(new Request(`http://localhost/__cms/files${query}`, {
    method,
    headers: {
      'x-plugin-id': PLUGIN_ID,
      'x-plugin-secret': secret,
      ...(body === undefined ? {} : { 'content-type': 'text/plain' }),
    },
    body,
  }));
}

beforeEach(async () => {
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  const url = `https://file-api-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind('File API', url, PLUGIN_SECRET)
    .run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(href).pathname === '/__plugin/manifest'
        ? Response.json({
          id: PLUGIN_ID,
          name: 'File API',
          version: '1.0.0',
          filePrefixes: [FILE_PREFIX, 'shared-assets/'],
        })
        : new Response('not found', { status: 404 });
    },
  } as unknown as Fetcher);
  await approveFilePrefix(env.DB, PLUGIN_ID, FILE_PREFIX, 'admin@example.com');
});

afterEach(async () => {
  clearManifestCache();
  __clearInjectedFetchers();
  const listed = await env.MEDIA_BUCKET.list({ prefix: FILE_PREFIX });
  if (listed.objects.length) await env.MEDIA_BUCKET.delete(listed.objects.map((object) => object.key));
  await env.DB.prepare('DELETE FROM plugins').run();
});

describe('/__cms/files', () => {
  it('authenticates and reads, lists, and writes host-owned generic files', async () => {
    const key = `${FILE_PREFIX}documents/example.txt`;
    const put = await api('PUT', `?key=${encodeURIComponent(key)}`, 'hello');
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, key, size: 5 });

    const read = await api('GET', `?key=${encodeURIComponent(key)}`);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toContain('text/plain');
    expect(await read.text()).toBe('hello');

    const head = await api('HEAD', `?key=${encodeURIComponent(key)}`);
    expect(head.status).toBe(200);

    const list = await api('GET', `?prefix=${encodeURIComponent(`${FILE_PREFIX}documents/`)}`);
    expect(list.status).toBe(200);
    expect((await list.json()).objects).toEqual(expect.arrayContaining([expect.objectContaining({ key })]));
  });

  it('requires approval for each declared prefix and rejects undeclared and unsafe keys', async () => {
    const sharedKey = `shared-assets/${crypto.randomUUID()}.bin`;
    const beforeApproval = await api('PUT', `?key=${encodeURIComponent(sharedKey)}`, 'x');
    expect(beforeApproval.status).toBe(400);
    expect(await beforeApproval.json()).toEqual({ error: 'invalid_key' });

    await approveFilePrefix(env.DB, PLUGIN_ID, 'shared-assets/', 'admin@example.com');
    expect((await api('PUT', `?key=${encodeURIComponent(sharedKey)}`, 'x')).status).toBe(200);
    await env.MEDIA_BUCKET.delete(sharedKey);

    expect((await api('PUT', `?key=${encodeURIComponent('pictures/not-allowed.txt')}`, 'x')).status).toBe(400);
    expect((await api('PUT', `?key=${encodeURIComponent(`${FILE_PREFIX}../escape.txt`)}`, 'x')).status).toBe(400);

    await revokeFilePrefix(env.DB, PLUGIN_ID, FILE_PREFIX);
    await revokeFilePrefix(env.DB, PLUGIN_ID, 'shared-assets/');
    const afterRevoke = await api('PUT', `?key=${encodeURIComponent(`${FILE_PREFIX}revoked.txt`)}`, 'x');
    expect(afterRevoke.status).toBe(403);
    expect(await afterRevoke.json()).toEqual({ error: 'file_storage_not_approved' });

    expect((await api('GET', `?key=${encodeURIComponent(`${FILE_PREFIX}missing.txt`)}`, undefined, 'wrong')).status)
      .toBe(403);
  });
});
