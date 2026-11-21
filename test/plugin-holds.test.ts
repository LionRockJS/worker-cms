import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import type { PluginManifest } from '../src/features/plugins/types';

// Retention holds a plugin places on its own pages (/__cms/holds): each ends by
// itself on its keep-until date, is only ever lengthened by its plugin, and
// leaves holds placed by people (or other plugins) alone.

const worker = (exports as unknown as { default: Fetcher }).default;
const PLUGIN_ID = 'enterprise-form';
const SECRET = 'holds-plugin-secret';

async function registerPlugin(): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind(PLUGIN_ID, url, SECRET).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname === '/__plugin/manifest') {
        return Response.json({ id: PLUGIN_ID, name: 'Forms', version: '1.0.0', contentTypes: { blueprint: { eform: ['@status'] } } } as unknown as PluginManifest);
      }
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

async function page(uuid: string, pageType = 'eform'): Promise<number> {
  return (await env.DB.prepare('INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(uuid, uuid, uuid, pageType, '{}').first<{ id: number }>())!.id;
}

async function place(holds: unknown[]): Promise<Response> {
  return worker.fetch(new Request('http://localhost/__cms/holds', {
    method: 'POST',
    headers: { 'x-plugin-id': PLUGIN_ID, 'x-plugin-secret': SECRET, 'content-type': 'application/json', 'x-acting-user-id': '42' },
    body: JSON.stringify({ holds }),
  }));
}

const holdOf = (uuid: string) => env.DB.prepare('SELECT placed_by, placed_by_plugin, keep_until, reason, released_at FROM record_holds WHERE page_uuid = ? ORDER BY id DESC').bind(uuid).first();

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM record_holds').run();
  await env.DB.prepare('DELETE FROM pages').run();
  await registerPlugin();
});

describe('Plugin holds API', () => {
  it('places, lengthens and never shortens the plugin\'s holds on its own pages', async () => {
    const id = await page('form-1');
    const placed = await place([{ page_id: id, keep_until: '2033-06-30', reason: 'Completed form: 7-year retention' }]);
    expect(placed.status).toBe(200);
    expect(await placed.json()).toEqual({ holds: [{ page_id: id, status: 'placed', keep_until: '2033-06-30' }] });
    expect(await holdOf('form-1')).toMatchObject({ placed_by: 42, placed_by_plugin: PLUGIN_ID, keep_until: '2033-06-30', released_at: null });

    expect((await (await place([{ page_id: id, keep_until: '2030-01-01', reason: 'Shorter' }])).json() as any).holds[0]).toMatchObject({ status: 'unchanged', keep_until: '2033-06-30' });
    expect((await (await place([{ page_id: id, keep_until: '2035-01-01', reason: 'Longer' }])).json() as any).holds[0]).toMatchObject({ status: 'extended', keep_until: '2035-01-01' });
    expect(await holdOf('form-1')).toMatchObject({ keep_until: '2035-01-01', reason: 'Longer' });
    const events = await env.DB.prepare("SELECT action FROM audit_events WHERE action LIKE 'hold.%' ORDER BY rowid").all<{ action: string }>();
    expect(events.results.map((event) => event.action)).toEqual(['hold.place', 'hold.extend']);
  });

  it('leaves other holds alone and refuses pages that are not the plugin\'s', async () => {
    const held = await page('form-held');
    await env.DB.prepare("INSERT INTO record_holds (page_uuid, reason, placed_by) VALUES ('form-held', 'Litigation', 1)").run();
    const other = await page('article-1', 'article');
    const result = await (await place([
      { page_id: held, keep_until: '2033-06-30', reason: 'Retention' },
      { page_id: other, keep_until: '2033-06-30', reason: 'Retention' },
      { page_id: 999999, keep_until: '2033-06-30', reason: 'Retention' },
    ])).json() as any;
    expect(result.holds.map((hold: { status: string }) => hold.status)).toEqual(['held_by_other', 'forbidden_page_type', 'not_found']);
    expect(await holdOf('form-held')).toMatchObject({ reason: 'Litigation', placed_by_plugin: null });
    expect(await holdOf('article-1')).toBeNull();
  });

  it('replaces an expired hold', async () => {
    const id = await page('form-old');
    await env.DB.prepare("INSERT INTO record_holds (page_uuid, reason, placed_by, placed_by_plugin, keep_until) VALUES ('form-old', 'Old', 0, ?, '2001-01-01')").bind(PLUGIN_ID).run();
    expect((await (await place([{ page_id: id, keep_until: '2040-01-01', reason: 'Renewed' }])).json() as any).holds[0].status).toBe('placed');
    const rows = await env.DB.prepare('SELECT keep_until, released_at FROM record_holds WHERE page_uuid = ? ORDER BY id').bind('form-old').all();
    expect(rows.results).toEqual([{ keep_until: '2001-01-01', released_at: '2001-01-02' }, { keep_until: '2040-01-01', released_at: null }]);
  });

  it('rejects malformed requests', async () => {
    expect((await place([])).status).toBe(400);
    expect((await place([{ page_id: 1, keep_until: '31/12/2030', reason: 'x' }])).status).toBe(400);
    expect((await place([{ page_id: 1, keep_until: '2030-12-31', reason: '' }])).status).toBe(400);
    expect((await place(Array.from({ length: 101 }, (_, n) => ({ page_id: n + 1, keep_until: '2030-12-31', reason: 'x' })))).status).toBe(400);
    expect((await worker.fetch(new Request('http://localhost/__cms/holds', { method: 'POST', body: '{}' }))).status).toBe(400);
    const wrongSecret = await worker.fetch(new Request('http://localhost/__cms/holds', { method: 'POST', headers: { 'x-plugin-id': PLUGIN_ID, 'x-plugin-secret': 'wrong' }, body: JSON.stringify({ holds: [{ page_id: 1, keep_until: '2030-12-31', reason: 'x' }] }) }));
    expect(wrongSecret.status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM record_holds').first<{ n: number }>())?.n).toBe(0);
  });
});
