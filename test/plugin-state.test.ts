import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { MAX_STATE_VALUE_BYTES } from '../src/features/plugins/state';
import type { PluginManifest } from '../src/features/plugins/types';

// Host-owned per-plugin state (/__cms/state). The point of this store is that
// the HOST owns records describing one host's relationship with the outside
// world, so the tests that matter most are the boundary ones: a plugin may
// only ever address its own keys, and unregistering a plugin takes its state
// with it.

const worker = (exports as unknown as { default: Fetcher }).default;

const PLUGIN_ID = 'theme-editor';
const PLUGIN_SECRET = 'theme-editor-state-secret';
const OTHER_PLUGIN_ID = 'events';
const OTHER_PLUGIN_SECRET = 'events-state-secret';

function manifest(id: string, name: string): PluginManifest {
  return { id, name, version: '1.0.0' } as unknown as PluginManifest;
}

async function registerPlugin(id: string, secret: string): Promise<string> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind(id, url, secret)
    .run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest(id, id));
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
  return url;
}

function stateApi(
  method: string,
  path: string,
  body?: unknown,
  { id = PLUGIN_ID, secret = PLUGIN_SECRET }: { id?: string; secret?: string } = {},
): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-id': id,
      'x-plugin-secret': secret,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_state').run();
  await registerPlugin(PLUGIN_ID, PLUGIN_SECRET);
});

describe('plugin state API', () => {
  it('round-trips a value and reports it as JSON', async () => {
    const connection = { installationId: 42, accountLogin: 'acme' };
    const put = await stateApi('PUT', '/__cms/state/github.connection', { value: connection });
    expect(put.status).toBe(200);

    const get = await stateApi('GET', '/__cms/state/github.connection');
    expect(get.status).toBe(200);
    const body = await get.json() as { key: string; value: string };
    expect(body.key).toBe('github.connection');
    expect(JSON.parse(body.value)).toEqual(connection);
  });

  it('distinguishes a never-written key from an empty one', async () => {
    expect((await stateApi('GET', '/__cms/state/never.written')).status).toBe(404);

    await stateApi('PUT', '/__cms/state/written.empty', { value: null });
    const get = await stateApi('GET', '/__cms/state/written.empty');
    expect(get.status).toBe(200);
    expect((await get.json() as { value: string }).value).toBe('null');
  });

  it('overwrites in place rather than accumulating rows', async () => {
    await stateApi('PUT', '/__cms/state/counter', { value: 1 });
    await stateApi('PUT', '/__cms/state/counter', { value: 2 });

    const list = await stateApi('GET', '/__cms/state');
    const { state } = await list.json() as { state: Array<{ key: string; value: string }> };
    expect(state).toHaveLength(1);
    expect(state[0].value).toBe('2');
  });

  it('scopes every key to the calling plugin', async () => {
    await registerPlugin(OTHER_PLUGIN_ID, OTHER_PLUGIN_SECRET);
    await stateApi('PUT', '/__cms/state/github.connection', { value: 'theme-editor-value' });
    await stateApi(
      'PUT',
      '/__cms/state/github.connection',
      { value: 'events-value' },
      { id: OTHER_PLUGIN_ID, secret: OTHER_PLUGIN_SECRET },
    );

    // Same key name, two plugins: neither may observe the other's value.
    const mine = await stateApi('GET', '/__cms/state/github.connection');
    expect(JSON.parse((await mine.json() as { value: string }).value)).toBe('theme-editor-value');

    const theirs = await stateApi(
      'GET',
      '/__cms/state/github.connection',
      undefined,
      { id: OTHER_PLUGIN_ID, secret: OTHER_PLUGIN_SECRET },
    );
    expect(JSON.parse((await theirs.json() as { value: string }).value)).toBe('events-value');

    const list = await stateApi('GET', '/__cms/state');
    const { state } = await list.json() as { state: Array<{ key: string }> };
    expect(state).toHaveLength(1);
  });

  it('rejects a caller presenting another plugin\'s secret', async () => {
    await registerPlugin(OTHER_PLUGIN_ID, OTHER_PLUGIN_SECRET);
    const response = await stateApi(
      'GET',
      '/__cms/state',
      undefined,
      { id: PLUGIN_ID, secret: OTHER_PLUGIN_SECRET },
    );
    expect(response.status).toBe(403);
  });

  it('narrows a listing by prefix', async () => {
    await stateApi('PUT', '/__cms/state/github.connection', { value: 1 });
    await stateApi('PUT', '/__cms/state/github.repo', { value: 2 });
    await stateApi('PUT', '/__cms/state/theme.active', { value: 3 });

    const response = await stateApi('GET', '/__cms/state?prefix=github.');
    const { state } = await response.json() as { state: Array<{ key: string }> };
    expect(state.map((entry) => entry.key)).toEqual(['github.connection', 'github.repo']);
  });

  it('refuses malformed keys and oversize values', async () => {
    expect((await stateApi('PUT', '/__cms/state/Not Valid', { value: 1 })).status).toBe(400);
    expect((await stateApi('GET', '/__cms/state/Not Valid')).status).toBe(400);

    const oversize = 'x'.repeat(MAX_STATE_VALUE_BYTES + 1);
    const response = await stateApi('PUT', '/__cms/state/big', { value: oversize });
    expect(response.status).toBe(413);
    expect((await stateApi('GET', '/__cms/state/big')).status).toBe(404);
  });

  it('requires a value field rather than treating its absence as null', async () => {
    expect((await stateApi('PUT', '/__cms/state/missing', {})).status).toBe(400);
  });

  it('treats deleting an absent key as success', async () => {
    const response = await stateApi('DELETE', '/__cms/state/never.written');
    expect(response.status).toBe(200);
  });

  it('clears state when the plugin is unregistered', async () => {
    await stateApi('PUT', '/__cms/state/github.connection', { value: 'connected' });

    // Deleting the registry row must take the manifest-keyed rows with it,
    // or the next plugin registered under this id inherits them.
    const { deleteAllPluginState } = await import('../src/features/plugins/state');
    await deleteAllPluginState(env.DB, PLUGIN_ID);

    const rows = await env.DB.prepare('SELECT COUNT(*) AS total FROM plugin_state WHERE plugin_id = ?')
      .bind(PLUGIN_ID)
      .first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });
});
