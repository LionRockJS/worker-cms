import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __clearInjectedFetchers, __injectPluginFetcher } from './plugin-fixtures';
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
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
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


describe('classified private file audit', () => {
  async function classify(prefix = FILE_PREFIX, dataClass = 'phi') {
    await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)')
      .bind('media_prefix', prefix, dataClass).run();
  }

  it('attributes GET, HEAD and delimiter listings to the authenticated plugin', async () => {
    await classify();
    const key = `${FILE_PREFIX}charts/patient.txt`;
    await api('PUT', `?key=${encodeURIComponent(key)}`, 'private chart');
    const read = await api('GET', `?key=${encodeURIComponent(key)}`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('private chart');
    expect((await api('HEAD', `?key=${encodeURIComponent(key)}`)).status).toBe(200);
    const list = await api('GET', `?prefix=${encodeURIComponent(FILE_PREFIX)}&delimiter=/`);
    expect(list.status).toBe(200);
    expect((await list.json()).delimited_prefixes).toContain(`${FILE_PREFIX}charts/`);
    const rows = (await env.DB.prepare("SELECT action, data_class, acting_via, actor_user_id, target_count FROM audit_events WHERE event_class = 'read' ORDER BY seq").all()).results;
    expect(rows).toEqual(['media.read', 'media.head', 'media.list'].map(action => ({
      action, data_class: 'phi', acting_via: PLUGIN_ID, actor_user_id: null, target_count: 1,
    })));
  });

  it('classifies nested objects even when their parent listing prefix is unclassified', async () => {
    await classify(`${FILE_PREFIX}charts/`);
    await api('PUT', `?key=${encodeURIComponent(`${FILE_PREFIX}charts/private.txt`)}`, 'secret');
    await api('PUT', `?key=${encodeURIComponent(`${FILE_PREFIX}public.txt`)}`, 'public');
    expect((await api('GET', `?prefix=${encodeURIComponent(FILE_PREFIX)}`)).status).toBe(200);
    expect((await env.DB.prepare("SELECT target_count, container_key FROM audit_events WHERE event_class = 'read'").all()).results)
      .toEqual([{ target_count: 1, container_key: `${FILE_PREFIX}charts/` }]);
  });

  it('does not disclose bytes or metadata during audit sink failure', async () => {
    await classify();
    const key = `${FILE_PREFIX}private.txt`;
    await api('PUT', `?key=${encodeURIComponent(key)}`, 'must not leave');
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      for (const [method, query] of [['GET', `?key=${encodeURIComponent(key)}`], ['HEAD', `?key=${encodeURIComponent(key)}`], ['GET', `?prefix=${encodeURIComponent(FILE_PREFIX)}`]]) {
        const response = await api(method, query);
        expect(response.status).toBe(503);
        expect(response.headers.get('etag')).toBeNull();
        expect(await response.text()).not.toContain('must not leave');
      }
    } finally {
      await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run();
    }
  });

  it('refuses reads/listings when classification is unavailable, even with no results', async () => {
    const key = `${FILE_PREFIX}private.txt`;
    await api('PUT', `?key=${encodeURIComponent(key)}`, 'must not leave');
    await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
    try {
      for (const query of [`?key=${encodeURIComponent(key)}`, `?prefix=${encodeURIComponent(FILE_PREFIX)}`, `?prefix=${encodeURIComponent(FILE_PREFIX+'empty/')}`]) {
        const response = await api('GET', query);
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toContain('must not leave');
      }
    } finally {
      await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run();
    }
  });

  it('audits plugin-wide classification even when file prefixes are unclassified', async () => {
    await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)')
      .bind('plugin', PLUGIN_ID, 'phi').run();
    const key = `${FILE_PREFIX}service.txt`;
    await api('PUT', `?key=${encodeURIComponent(key)}`, 'service secret');
    const response = await worker.fetch(new Request(`http://localhost/__cms/files?key=${encodeURIComponent(key)}`, {
      headers: { 'x-plugin-id': PLUGIN_ID, 'x-plugin-secret': PLUGIN_SECRET, 'x-acting-user-id': '42' },
    }));
    expect(response.status).toBe(200);
    expect((await env.DB.prepare("SELECT actor_user_id, acting_via, data_class, container_key FROM audit_events WHERE event_class = 'read'").all()).results)
      .toEqual([{ actor_user_id: '42', acting_via: PLUGIN_ID, data_class: 'phi', container_key: PLUGIN_ID }]);
  });

  it('records nothing for unclassified files and refuses revoked prefix access', async () => {
    const key = `${FILE_PREFIX}ordinary.txt`;
    await api('PUT', `?key=${encodeURIComponent(key)}`, 'ordinary');
    expect((await api('GET', `?key=${encodeURIComponent(key)}`)).status).toBe(200);
    expect((await env.DB.prepare("SELECT seq FROM audit_events WHERE event_class = 'read'").all()).results).toEqual([]);
    await revokeFilePrefix(env.DB, PLUGIN_ID, FILE_PREFIX);
    expect((await api('GET', `?key=${encodeURIComponent(key)}`)).status).toBe(403);
  });
});
