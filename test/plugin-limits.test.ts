import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { signJWT } from './auth-fixtures';
import {
  declaredLimits,
  limitsSettingKey,
  loadLimitValues,
  saveLimitValues,
} from '../src/features/plugins/limits';
import type { JWTPayload } from '../src/types';
import type { PluginManifest } from '../src/features/plugins/types';

// Plugin quota limits: manifest-declared, admin-configured, host-enforced on
// every create path (/__cms API and the built-in admin editor).

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';

const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  contentTypes: {
    blueprint: {
      event: ['name:text/title'],
      guest: ['@email:email', 'name'],
      mail_list: ['*event'],
    },
  },
  limits: [
    { key: 'send_email_per_second', label: 'Emails per second', scope: 'per_second', default: 1 },
    { key: 'max_events', label: 'Maximum events', page_type: 'event', scope: 'total', default: 2 },
    { key: 'max_guests_per_list', label: 'Max guests per list', page_type: 'guest', scope: 'per_pointer', pointer_key: 'mail_list', default: 3 },
    // No default → unlimited until an admin configures a value.
    { key: 'max_guests', label: 'Maximum guests', page_type: 'guest', scope: 'total' },
    // Not an owned/approved type → must be dropped, or any plugin could
    // quota-block another plugin's pages via a defaulted limit.
    { key: 'sabotage', label: 'Sabotage', page_type: 'contact', scope: 'total', default: 0 },
  ],
} as unknown as PluginManifest;

let ipCounter = 0;

async function registerPlugin(): Promise<string> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Events', url, PLUGIN_SECRET).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') return Response.json(MANIFEST);
      if (path.startsWith('/__plugin/hooks/')) return new Response('ok');
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
  return url;
}

function cmsApi(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

async function authCookie(role = 'admin'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', await authCookie());
  headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
}

async function createGuest(listId: string, name: string): Promise<Response> {
  return cmsApi('POST', '/__cms/pages', {
    page_type: 'guest',
    name,
    lect: { _pointers: { mail_list: listId } },
  });
}

let savedSecret: unknown;
let pluginUrl = '';

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.limits.%'").run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  pluginUrl = await registerPlugin();
});

describe('declaredLimits validation', () => {
  const allowed = new Set(['event', 'guest', 'mail_list']);

  it('keeps valid limits and drops ones on non-owned page types', () => {
    const defs = declaredLimits(MANIFEST, allowed);
    expect(defs.map((def) => def.key)).toEqual(['send_email_per_second', 'max_events', 'max_guests_per_list', 'max_guests']);
    expect(defs.find((def) => def.key === 'sabotage')).toBeUndefined();
  });

  it('normalizes defaults and pointer keys', () => {
    const defs = declaredLimits(MANIFEST, allowed);
    const perList = defs.find((def) => def.key === 'max_guests_per_list')!;
    expect(perList.pointerKey).toBe('mail_list');
    expect(perList.defaultValue).toBe(3);
    const total = defs.find((def) => def.key === 'max_guests')!;
    expect(total.defaultValue).toBeNull();
    const sendRate = defs.find((def) => def.key === 'send_email_per_second')!;
    expect(sendRate).toMatchObject({ pageType: null, scope: 'per_second', defaultValue: 1 });
  });

  it('drops malformed entries: bad scope, missing pointer_key, duplicate keys, bad defaults', () => {
    const manifest = {
      ...MANIFEST,
      limits: [
        { key: 'a', page_type: 'event', scope: 'weird', default: 1 },
        { key: 'b', page_type: 'event', scope: 'per_pointer' },
        { key: 'c', page_type: 'event', scope: 'total', default: 5 },
        { key: 'c', page_type: 'event', scope: 'total', default: 9 },
        { key: 'd', page_type: 'event', scope: 'total', default: -2 },
        { key: 'BAD KEY', page_type: 'event', scope: 'total' },
      ],
    } as unknown as PluginManifest;
    const defs = declaredLimits(manifest, allowed);
    expect(defs.map((def) => def.key)).toEqual(['c', 'd']);
    expect(defs[0].defaultValue).toBe(5);
    expect(defs[1].defaultValue).toBeNull(); // negative default → unlimited
  });
});

describe('limit values storage', () => {
  it('round-trips values including explicit unlimited', async () => {
    await saveLimitValues(env, PLUGIN_ID, { max_events: 7, max_guests_per_list: null });
    const values = await loadLimitValues(env, PLUGIN_ID);
    expect(values).toEqual({ max_events: 7, max_guests_per_list: null });
  });

  it('ignores malformed stored JSON', async () => {
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind(limitsSettingKey(PLUGIN_ID), 'not json').run();
    expect(await loadLimitValues(env, PLUGIN_ID)).toEqual({});
  });
});

describe('/__cms create enforcement', () => {
  it('enforces a total limit from the manifest default', async () => {
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E1' })).status).toBe(201);
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E2' })).status).toBe(201);

    const blocked = await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E3' });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { error: string; violation: Record<string, unknown> };
    expect(body.error).toBe('limit_exceeded');
    expect(body.violation).toMatchObject({ key: 'max_events', limit: 2, current: 2, attempted: 1 });
  });

  it('honors an admin-configured value over the default', async () => {
    await saveLimitValues(env, PLUGIN_ID, { max_events: 3 });
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E1' })).status).toBe(201);
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E2' })).status).toBe(201);
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E3' })).status).toBe(201);
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E4' })).status).toBe(409);
  });

  it('treats an explicit null as unlimited', async () => {
    await saveLimitValues(env, PLUGIN_ID, { max_events: null });
    for (let i = 0; i < 4; i++) {
      expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: `E${i}` })).status).toBe(201);
    }
  });

  it('scopes a per_pointer limit to each collection independently', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await createGuest('111', `G${i}`)).status).toBe(201);
    }
    const blocked = await createGuest('111', 'G4');
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { violation: Record<string, unknown> };
    expect(body.violation).toMatchObject({ key: 'max_guests_per_list', limit: 3, current: 3 });

    // A different list has its own quota.
    expect((await createGuest('222', 'H1')).status).toBe(201);
  });

  it('rejects a whole batch that would cross a limit, creating nothing', async () => {
    expect((await createGuest('333', 'G1')).status).toBe(201);
    const batch = await cmsApi('POST', '/__cms/pages/batch', {
      pages: ['G2', 'G3', 'G4'].map((name) => ({
        page_type: 'guest',
        name,
        lect: { _pointers: { mail_list: '333' } },
      })),
    });
    expect(batch.status).toBe(409);
    expect((await batch.json() as { error: string }).error).toBe('limit_exceeded');

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'guest'")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('does not enforce a limit declared on a page type the plugin cannot write', async () => {
    // 'sabotage' declared default 0 on 'contact' — dropped, so contact pages
    // (owned elsewhere) are unaffected. Create one directly to verify counting
    // paths never see the dropped def.
    await env.DB.prepare(
      "INSERT INTO pages (name, slug, page_type, lect) VALUES ('C', 'c-limit-test', 'contact', '{}')",
    ).run();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'contact'")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('GET /__cms/limits', () => {
  it('reports declared limits with effective values and usage', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E1' });
    await createGuest('444', 'G1');
    await createGuest('444', 'G2');

    const res = await cmsApi('GET', '/__cms/limits?pointer_value=444');
    expect(res.status).toBe(200);
    const { limits } = await res.json() as { limits: Array<Record<string, unknown>> };

    const keys = limits.map((limit) => limit.key);
    expect(keys).toEqual(['send_email_per_second', 'max_events', 'max_guests_per_list', 'max_guests']);

    const sendRate = limits.find((limit) => limit.key === 'send_email_per_second')!;
    expect(sendRate).toMatchObject({ page_type: null, scope: 'per_second', value: 1, usage: null });

    const events = limits.find((limit) => limit.key === 'max_events')!;
    expect(events).toMatchObject({ value: 2, configured: false, usage: 1, scope: 'total' });

    const perList = limits.find((limit) => limit.key === 'max_guests_per_list')!;
    expect(perList).toMatchObject({ value: 3, usage: 2, pointer_key: 'mail_list' });

    const guests = limits.find((limit) => limit.key === 'max_guests')!;
    expect(guests.value).toBeNull();
  });

  it('reports configured values as configured', async () => {
    await saveLimitValues(env, PLUGIN_ID, { max_events: 9 });
    const res = await cmsApi('GET', '/__cms/limits');
    const { limits } = await res.json() as { limits: Array<Record<string, unknown>> };
    expect(limits.find((limit) => limit.key === 'max_events')).toMatchObject({ value: 9, configured: true });
  });
});

describe('admin editor enforcement', () => {
  it('blocks POST /admin/pages once the limit is reached', async () => {
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E1' })).status).toBe(201);
    expect((await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'E2' })).status).toBe(201);

    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event', page_type: 'event' }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Limit reached');
  });

  it('allows POST /admin/pages under the limit', async () => {
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event-ok', page_type: 'event' }),
    });
    expect(res.status).toBe(302);
  });
});

describe('admin limits page', () => {
  async function pluginRowId(): Promise<number> {
    const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(pluginUrl).first<{ id: number }>();
    return row!.id;
  }

  it('lists declared limits', async () => {
    const res = await adminFetch(`/admin/plugins-manage/${await pluginRowId()}/limits`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Maximum events');
    expect(html).toContain('max_guests_per_list');
    expect(html).not.toContain('sabotage');
  });

  it('saves configured values for declared keys only', async () => {
    const id = await pluginRowId();
    const res = await adminFetch(`/admin/plugins-manage/${id}/limits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        value_max_events: '7',
        unlimited_max_guests_per_list: '1',
        value_sabotage: '0',
        value_not_declared: '1',
      }),
    });
    expect(res.status).toBe(302);
    expect(await loadLimitValues(env, PLUGIN_ID)).toEqual({ max_events: 7, max_guests_per_list: null });
  });
});
