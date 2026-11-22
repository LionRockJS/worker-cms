import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import type { PluginManifest } from '../src/features/plugins/types';

// Access a plugin records on pages it may read (/__cms/audit/events): written
// into audit_events under a plugin.* action, attributed to the asserted user,
// with no email in the detail; read back only as that plugin's own events, and
// the reading recorded too.

const worker = (exports as unknown as { default: Fetcher }).default;
const PLUGIN_ID = 'enterprise-form';
const SECRET = 'audit-plugin-secret';

async function registerPlugin(id = PLUGIN_ID, secret = SECRET): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind(id, url, secret).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname === '/__plugin/manifest') {
        return Response.json({ id, name: 'Forms', version: '1.0.0', contentTypes: { blueprint: { eform: ['@status'] } } } as unknown as PluginManifest);
      }
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

async function page(pageType = 'eform'): Promise<number> {
  const uuid = crypto.randomUUID();
  return (await env.DB.prepare('INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(uuid, uuid, uuid, pageType, '{}').first<{ id: number }>())!.id;
}

function call(method: 'GET' | 'POST', path: string, body?: unknown, actingUser: string | null = '42', id = PLUGIN_ID, secret = SECRET): Promise<Response> {
  const headers: Record<string, string> = { 'x-plugin-id': id, 'x-plugin-secret': secret, 'content-type': 'application/json' };
  if (actingUser) headers['x-acting-user-id'] = actingUser;
  return worker.fetch(new Request(`http://localhost/__cms${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

const record = (events: unknown[], actingUser: string | null = '42') => call('POST', '/audit/events', { events }, actingUser);
const rows = () => env.DB.prepare("SELECT * FROM audit_events WHERE action LIKE 'plugin.form.%' OR action = 'audit.read' ORDER BY seq").all<Record<string, unknown>>().then((result) => result.results);

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM users WHERE id = 42').run();
  await registerPlugin();
});

describe('POST /__cms/audit/events', () => {
  it('records access to the plugin\'s pages under a plugin action, attributed to the asserted user', async () => {
    const id = await page();
    const response = await record([{ action: 'form.view', page_id: id }, { action: 'form.download', page_id: id, detail: { file: 'passport.pdf', version: 2 } }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: 2, errors: [] });
    const [view, download] = await rows();
    expect(view).toMatchObject({
      action: 'plugin.form.view', event_class: 'read', data_class: 'none', retention_class: 'plugin_access', outcome: 'success',
      actor_user_id: '42', acting_via: PLUGIN_ID, target_type: 'page', target_id: String(id), target_count: 1, container_key: 'eform',
    });
    expect(JSON.parse(String(download.detail))).toEqual({ file: 'passport.pdf', version: 2, plugin_id: PLUGIN_ID, acting_user_verified: false, asserted_user_id: 42 });
  });

  it('records a no-login link open with no user, and keeps a classified page\'s retention', async () => {
    await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'eform', 'pii')").run();
    const id = await page();
    expect((await record([{ action: 'form.link_open', page_id: id, event_class: 'read', detail: { link: 'ab12', kind: 'approval' } }], null)).status).toBe(200);
    const [open] = await rows();
    expect(open).toMatchObject({ actor_user_id: null, data_class: 'pii', retention_class: 'pii_access' });
    expect(JSON.parse(String(open.detail))).toEqual({ link: 'ab12', kind: 'approval', plugin_id: PLUGIN_ID });
  });

  it('refuses emails and malformed events, and skips pages the plugin may not read', async () => {
    const id = await page();
    const other = await page('secret_note');
    const refused = await record([{ action: 'form.view', page_id: id }, { action: 'form.view', page_id: id, detail: { to: 'amy@example.com' } }]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'detail_contains_email', index: 1 });
    for (const bad of [{ action: 'Form View', page_id: id }, { action: 'form.view', page_id: 0 }, { action: 'form.view', page_id: id, event_class: 'mutation' }, { action: 'form.view', page_id: id, detail: { nested: { a: 1 } } }]) {
      expect((await record([bad])).status).toBe(400);
    }
    expect((await call('POST', '/audit/events', { events: [] })).status).toBe(400);
    expect(await rows()).toEqual([]);

    const mixed = await record([{ action: 'form.view', page_id: other }, { action: 'form.view', page_id: 999999 }, { action: 'form.view', page_id: id }]);
    expect(await mixed.json()).toEqual({ recorded: 1, errors: [{ index: 0, error: 'forbidden_page_type' }, { index: 1, error: 'not_found' }] });
    expect((await call('POST', '/audit/events', { events: [{ action: 'form.view', page_id: id }] }, '42', PLUGIN_ID, 'wrong')).status).toBe(403);
  });
});

describe('GET /__cms/audit/events', () => {
  it('returns the plugin\'s own events on a page, newest first, and records the read', async () => {
    const id = await page();
    await record([{ action: 'form.view', page_id: id }, { action: 'form.print', page_id: id }]);
    await record([{ action: 'form.link_open', page_id: id, detail: { link: 'ab12' } }], null);
    // Another plugin's event on the same page, and a host event, are not this plugin's to read.
    await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome, acting_via, target_type, target_id) VALUES (?, ?, 'read', 'none', 'none', 'plugin.form.view', 'success', 'other', 'page', ?)")
      .bind(crypto.randomUUID(), new Date().toISOString(), String(id)).run();

    const response = await call('GET', `/audit/events?page_id=${id}&limit=2`);
    expect(response.status).toBe(200);
    const first = await response.json() as { events: Array<Record<string, unknown>>; next: number | null };
    expect(first.events.map((event) => event.action)).toEqual(['form.link_open', 'form.print']);
    expect(first.events[0]).toMatchObject({ actor_user_id: null, actor_name: null, detail: { link: 'ab12', plugin_id: PLUGIN_ID } });
    expect(first.events[1]).toMatchObject({ actor_user_id: '42', actor_name: null, actor_email: null });
    const second = await (await call('GET', `/audit/events?page_id=${id}&limit=2&before=${first.next}`)).json() as typeof first;
    expect(second.events.map((event) => event.action)).toEqual(['form.view']);
    expect(second.next).toBeNull();

    const reads = (await rows()).filter((row) => row.action === 'audit.read');
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ event_class: 'admin', retention_class: 'admin_config', actor_user_id: '42', acting_via: PLUGIN_ID, target_id: String(id) });
  });

  it('withholds actor names and emails when the plugin has page read access', async () => {
    await env.DB.prepare("INSERT INTO users (id, oauth_id, name, email, role) VALUES (42, 'test:42', 'Alice', 'alice@example.invalid', 'editor')").run();
    const id = await page();
    const written = await record([{ action: 'form.view', page_id: id }]);
    expect(await written.json()).toEqual({ recorded: 1, errors: [] });

    const response = await call('GET', `/audit/events?page_id=${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [{ actor_user_id: '42', actor_name: null, actor_email: null }] });
  });

  it('reads only pages the plugin may read', async () => {
    const other = await page('secret_note');
    expect((await call('GET', `/audit/events?page_id=${other}`)).status).toBe(403);
    expect((await call('GET', '/audit/events?page_id=999999')).status).toBe(404);
    expect((await call('GET', '/audit/events?page_id=x')).status).toBe(400);
  });
});
