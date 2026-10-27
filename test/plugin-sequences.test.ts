import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import type { PluginManifest } from '../src/features/plugins/types';

// Host-owned atomic counters (/__cms/sequences). What matters: numbers never
// repeat, even under concurrency, and a plugin only ever advances its own.

const worker = (exports as unknown as { default: Fetcher }).default;

const PLUGIN_ID = 'invoicing';
const PLUGIN_SECRET = 'invoicing-sequence-secret';
const OTHER_PLUGIN_ID = 'events';
const OTHER_PLUGIN_SECRET = 'events-sequence-secret';

async function registerPlugin(id: string, secret: string): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind(id, url, secret)
    .run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname === '/__plugin/manifest') {
        return Response.json({ id, name: id, version: '1.0.0' } as unknown as PluginManifest);
      }
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

function sequencesApi(
  method: string,
  path: string,
  { id = PLUGIN_ID, secret = PLUGIN_SECRET }: { id?: string; secret?: string } = {},
): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'x-plugin-id': id, 'x-plugin-secret': secret },
  }));
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_sequences').run();
  await registerPlugin(PLUGIN_ID, PLUGIN_SECRET);
  await registerPlugin(OTHER_PLUGIN_ID, OTHER_PLUGIN_SECRET);
});

describe('Plugin sequences API', () => {
  it('starts at 0 and advances by one per call', async () => {
    expect(await (await sequencesApi('GET', '/__cms/sequences/po.2026')).json()).toEqual({ key: 'po.2026', value: 0 });
    expect(await (await sequencesApi('POST', '/__cms/sequences/po.2026/next')).json()).toEqual({ key: 'po.2026', value: 1 });
    expect(await (await sequencesApi('POST', '/__cms/sequences/po.2026/next')).json()).toEqual({ key: 'po.2026', value: 2 });
    expect(await (await sequencesApi('GET', '/__cms/sequences/po.2026')).json()).toEqual({ key: 'po.2026', value: 2 });
  });

  it('never hands out the same number to concurrent callers', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => sequencesApi('POST', '/__cms/sequences/rfq.2026/next')),
    );
    const values = await Promise.all(responses.map(async (res) => (await res.json() as { value: number }).value));
    expect(values.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('scopes counters to the calling plugin', async () => {
    await sequencesApi('POST', '/__cms/sequences/po.2026/next');
    await sequencesApi('POST', '/__cms/sequences/po.2026/next');
    const other = await sequencesApi('POST', '/__cms/sequences/po.2026/next', { id: OTHER_PLUGIN_ID, secret: OTHER_PLUGIN_SECRET });
    expect(await other.json()).toEqual({ key: 'po.2026', value: 1 });
  });

  it('rejects invalid keys and unauthenticated callers', async () => {
    expect((await sequencesApi('POST', '/__cms/sequences/PO%202026/next')).status).toBe(400);
    expect((await sequencesApi('POST', '/__cms/sequences/po.2026/next', { secret: 'wrong' })).status).toBe(403);
  });
});
