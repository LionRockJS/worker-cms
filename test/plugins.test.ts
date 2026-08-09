import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCmsConfig, clearConfigCache } from '../src/core/db/content-config';
import { clearManifestCache, getPlugins, __injectPluginFetcher, __clearInjectedFetchers } from '../src/features/plugins/registry';
import { deliverHook } from '../src/features/plugins/hooks';
import { viewsFor } from '../src/features/plugins/views';
import { cmsConfig } from '../src/cms-config';
import { signJWT } from '../src/core/auth/jwt';
import { CMS_ADMIN_JOB_KIND } from '../src/features/jobs/queue';
import type { CmsAdminJobMessage } from '../src/core/extensions';
import { approveAsset, computeIntegrity } from '../src/features/plugins/assets';
import { mintFormOnceToken } from '../src/core/auth/form-once';
import type { Env, JWTPayload } from '../src/types';

const EVENTS_MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  hooks: ['publish'],
  nav: [{ label: 'Events', href: 'dashboard' }],
  contentTypes: {
    blueprint: { event: ['@date', 'venue'] },
    taxonomies: { audience: 'Audience' },
    taxonomyLists: { event: ['audience'] },
  },
  fieldTypes: [{ type: 'events-map' }],
};

interface FakePlugin {
  fetcher: Fetcher;
  hookCalls: Array<{ event: string; body: Record<string, unknown> | null; headers: Headers }>;
}

interface RenderPayload {
  layoutData: Record<string, unknown>;
  approvedPluginAssets?: Record<string, Array<{ path: string; integrity: string; revision?: string }>>;
  bodyView: null | {
    viewPath: string;
    data: Record<string, unknown>;
    plugin?: boolean;
    viewBasePath?: string;
    viewRevision?: string;
    i18n?: boolean;
  };
}

function renderPayload(html: string): RenderPayload {
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing cms-render-payload script');
  return JSON.parse(match[1]) as RenderPayload;
}

function bodyData(html: string): Record<string, unknown> {
  return renderPayload(html).bodyView?.data ?? {};
}

function makePlugin(manifest: unknown, views: Record<string, string> = {}): FakePlugin {
  const hookCalls: FakePlugin['hookCalls'] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === '/__plugin/manifest') return Response.json(manifest);
    if (path.startsWith('/__plugin/hooks/')) {
      hookCalls.push({
        event: path.split('/').pop() ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });
      return new Response('ok');
    }
    if (path.startsWith('/__plugin/views/')) {
      const viewPath = path.slice('/__plugin/views'.length);
      return viewPath in views ? new Response(views[viewPath]) : new Response('nf', { status: 404 });
    }
    return new Response('nf', { status: 404 });
  };
  return { hookCalls, fetcher: { fetch } as unknown as Fetcher };
}

// Registers a fake plugin in the D1 registry and routes its URL to the in-process
// fetcher — the URL-transport equivalent of the old PLUGINS service binding.
async function envWith(plugin: FakePlugin, extra: Record<string, unknown> = {}): Promise<Env> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
  __injectPluginFetcher(url, plugin.fetcher);
  return { DB: env.DB, ...extra } as unknown as Env;
}

const USER: JWTPayload = {
  sub: '7', email: 'a@b.co', name: 'Ada', role: 'admin', type: 'access', exp: 0, iat: 0,
};

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM admin_jobs').run();
  await env.DB.prepare('DELETE FROM settings').run();
  await env.DB.prepare('DELETE FROM plugin_asset_approvals').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
});

describe('resolveCmsConfig', () => {
  it('rejects malformed manifests', async () => {
    const invalidEnv = await envWith(makePlugin({ id: '__proto__', name: 'Invalid', version: '1' }));
    expect(await getPlugins(invalidEnv)).toEqual([]);
  });

  it('rejects a non-boolean i18n manifest setting', async () => {
    const invalidEnv = await envWith(makePlugin({ ...EVENTS_MANIFEST, i18n: 'yes' }));
    expect(await getPlugins(invalidEnv)).toEqual([]);
  });

  it('accepts manifest-declared tenant environment variables', async () => {
    const pluginEnv = await envWith(makePlugin({
      ...EVENTS_MANIFEST,
      tenantVars: ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_SECRET'],
    }));
    expect((await getPlugins(pluginEnv))[0]?.manifest.tenantVars).toEqual([
      'GITHUB_APP_ID',
      'GITHUB_APP_CLIENT_SECRET',
    ]);
  });

  it.each([
    ['not-an-array', { ...EVENTS_MANIFEST, tenantVars: 'GITHUB_APP_ID' }],
    ['lowercase name', { ...EVENTS_MANIFEST, tenantVars: ['github_app_id'] }],
    ['duplicate name', { ...EVENTS_MANIFEST, tenantVars: ['GITHUB_APP_ID', 'GITHUB_APP_ID'] }],
    ['reserved connection name', { ...EVENTS_MANIFEST, tenantVars: ['PLUGIN_SECRET'] }],
  ])('rejects invalid tenantVars (%s)', async (_label, manifest) => {
    const invalidEnv = await envWith(makePlugin(manifest));
    expect(await getPlugins(invalidEnv)).toEqual([]);
  });

  it.each([
    ['a misleading Content-Length header', new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-length': '1' } })],
    ['a chunked response without Content-Length', new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(256 * 1024 + 1)));
        controller.close();
      },
    }))],
  ])('rejects an oversized manifest delivered through %s', async (_label, response) => {
    const plugin: FakePlugin = {
      hookCalls: [],
      fetcher: { fetch: async () => response.clone() } as unknown as Fetcher,
    };
    expect(await getPlugins(await envWith(plugin))).toEqual([]);
  });

  it('does not allow prototype-mutating manifest keys to alter CMS configuration', async () => {
    const blueprint = JSON.parse('{"event":["name"],"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
    const config = await resolveCmsConfig(await envWith(makePlugin({
      ...EVENTS_MANIFEST,
      contentTypes: { blueprint },
    })));

    expect(config.blueprint.event).toEqual(['name']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(config.blueprint, '__proto__')).toBe(false);
  });

  it('merges plugin blueprints into the base config', async () => {
    const config = await resolveCmsConfig(await envWith(makePlugin(EVENTS_MANIFEST)));
    expect(config.blueprint.event).toEqual(['@date', 'venue']);
    expect(config.taxonomies.audience).toBe('Audience');
    expect(config.taxonomyLists.event).toEqual(['audience']);
    expect(config.blueprint.default).toBeDefined(); // base content types preserved
  });

  it('does not mutate the static base config', async () => {
    await resolveCmsConfig(await envWith(makePlugin(EVENTS_MANIFEST)));
    expect(cmsConfig.blueprint.event).toBeUndefined();
    expect(cmsConfig.taxonomies.audience).toBeUndefined();
  });

  it('returns the base config when no plugins are configured', async () => {
    const config = await resolveCmsConfig({} as Env);
    expect(config.blueprint.event).toBeUndefined();
  });

  it('merges database-defined page types into the config', async () => {
    await env.DB.prepare(
      `INSERT INTO page_types (slug, name, blueprint, taxonomy_lists) VALUES (?, ?, ?, ?)`,
    )
      .bind('dbtype', 'DB Type', JSON.stringify(['name', 'body:text']), JSON.stringify(['years']))
      .run();
    try {
      const config = await resolveCmsConfig({ DB: env.DB } as Env);
      expect(config.blueprint.dbtype).toEqual(['name', 'body:text']);
      expect(config.taxonomyLists.dbtype).toEqual(['years']);
      expect(config.blueprint.default).toBeDefined(); // base content types preserved
      expect(cmsConfig.blueprint.dbtype).toBeUndefined(); // base not mutated
    } finally {
      await env.DB.prepare('DELETE FROM page_types WHERE slug = ?').bind('dbtype').run();
    }
  });

  it('merges database-defined block types into the config blocks', async () => {
    await env.DB.prepare(
      `INSERT INTO block_types (slug, name, blueprint) VALUES (?, ?, ?)`,
    )
      .bind('dbblock', 'DB Block', JSON.stringify(['label', { pictures: ['url'] }]))
      .run();
    try {
      const config = await resolveCmsConfig({ DB: env.DB } as Env);
      expect(config.blocks.dbblock).toEqual(['label', { pictures: ['url'] }]);
      expect(config.blocks.default).toBeDefined(); // base blocks preserved
      expect(cmsConfig.blocks.dbblock).toBeUndefined(); // base not mutated
    } finally {
      await env.DB.prepare('DELETE FROM block_types WHERE slug = ?').bind('dbblock').run();
    }
  });
});

describe('deliverHook', () => {
  it('delivers to plugins subscribed to the event with the page + user payload', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin, { PLUGIN_SECRET: 's' }), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls).toHaveLength(1);
    expect(plugin.hookCalls[0].event).toBe('publish');
    expect(plugin.hookCalls[0].headers.get('x-plugin-secret')).toBe('s');
    expect(plugin.hookCalls[0].body?.page).toMatchObject({ id: 5, slug: 'x' });
    expect(plugin.hookCalls[0].body?.user).toMatchObject({ id: '7', role: 'admin' });
  });

  it('sends x-cms-tenant (the canonical origin) alongside the secret', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(
      await envWith(plugin, { PLUGIN_SECRET: 's', CANONICAL_ORIGIN: 'https://cms1.example.com/' }),
      USER,
      'publish',
      { id: 5, slug: 'x' },
    );
    expect(plugin.hookCalls[0].headers.get('x-cms-tenant')).toBe('https://cms1.example.com');
  });

  it('omits x-cms-tenant when CANONICAL_ORIGIN is unset', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin, { PLUGIN_SECRET: 's' }), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls[0].headers.get('x-cms-tenant')).toBeNull();
  });

  it('does not deliver subscribed hooks when PLUGIN_SECRET is missing', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls).toHaveLength(0);
  });

  it('does not deliver events the plugin did not subscribe to', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin), undefined, 'delete', { id: 1 });
    expect(plugin.hookCalls).toHaveLength(0);
  });
});

describe('viewsFor', () => {
  const snippetPath = '/snippets/pagefield/events-map/basic.liquid';

  it('falls back to a plugin view when the primary assets 404', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const pluginEnv = await envWith(plugin, { VIEWS: { fetch: async () => new Response('nf', { status: 404 }) } });
    const res = await viewsFor(pluginEnv).fetch(`https://views.local${snippetPath}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cms-view-source')).toBe('plugin');
    expect(await res.text()).toBe('PLUGIN_SNIPPET');
  });

  it('serves primary views without consulting plugins', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const pluginEnv = await envWith(plugin, { VIEWS: { fetch: async () => new Response('CORE') } });
    const res = await viewsFor(pluginEnv).fetch('https://views.local/layout/default.liquid');
    expect(res.headers.get('x-cms-view-source')).toBe('core');
    expect(await res.text()).toBe('CORE');
  });
});

describe('plugin tenant configuration management', () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  const testEnv = env as unknown as Record<string, unknown>;

  async function adminCookie(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    return `access_token=${token}`;
  }

  it('reads and writes declared tenant vars through the authenticated plugin API', async () => {
    const url = `https://plugin-tenant-config-${crypto.randomUUID()}.local`;
    const secret = 'server-secret';
    const manifest = {
      id: 'theme-editor',
      name: 'Theme Editor',
      version: '1.0.0',
      tenantVars: ['GITHUB_APP_ID', 'GITHUB_APP_SECRET'],
    };
    const requests: Array<{ path: string; headers: Headers; body: unknown }> = [];
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
      .bind('Theme Editor', url, secret)
      .run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const requestUrl = new URL(href);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: requestUrl.pathname, headers: new Headers(init?.headers), body });
        if (requestUrl.pathname === '/__plugin/manifest') return Response.json(manifest);
        if (requestUrl.pathname === '/__plugin/tenants/config') {
          if (new Headers(init?.headers).get('x-plugin-secret') !== secret) return new Response('forbidden', { status: 403 });
          if (init?.method === 'PUT') return Response.json({ ok: true, vars: body?.vars ?? {} });
          return Response.json({ ok: true, vars: { GITHUB_APP_ID: '123456', GITHUB_APP_SECRET: 'old-secret' } });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const previousOrigin = testEnv.CANONICAL_ORIGIN;
    testEnv.CANONICAL_ORIGIN = 'https://cms.example.com';
    try {
      const headers = { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' };
      const edit = await worker.fetch(new Request(
        `http://localhost/admin/plugins-manage/${await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(url).first<{ id: number }>().then((row) => row!.id)}/edit`,
        { headers },
      ));
      expect(edit.status).toBe(200);
      const editData = bodyData(await edit.text());
      expect(editData.tenantConfigAvailable).toBe(true);
      expect(editData.tenantVars).toEqual([
        { name: 'GITHUB_APP_ID', value: '123456' },
        { name: 'GITHUB_APP_SECRET', value: 'old-secret' },
      ]);

      const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(url).first<{ id: number }>();
      const saved = await worker.fetch(new Request(`http://localhost/admin/plugins-manage/${row!.id}/tenant-config`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          tenant_var_GITHUB_APP_ID: '987654',
          tenant_var_GITHUB_APP_SECRET: '',
        }),
        redirect: 'manual',
      }));
      expect(saved.status).toBe(302);
      expect(saved.headers.get('location')).toBe(`/admin/plugins-manage/${row!.id}/edit?flash=tenant-config-saved`);
      const update = requests.find((request) => request.path === '/__plugin/tenants/config' && request.body !== null);
      expect(update?.headers.get('x-plugin-secret')).toBe(secret);
      expect(update?.headers.get('x-cms-tenant')).toBe('https://cms.example.com');
      expect(update?.body).toEqual({ vars: { GITHUB_APP_ID: '987654', GITHUB_APP_SECRET: null } });
    } finally {
      if (previousOrigin === undefined) delete testEnv.CANONICAL_ORIGIN;
      else testEnv.CANONICAL_ORIGIN = previousOrigin;
    }
  });
});

describe('plugin admin proxy', () => {
  const worker = (exports as unknown as {
    default: Fetcher & { queue(batch: MessageBatch<unknown>, env: Env): Promise<void> };
  }).default;
  const testEnv = env as unknown as Record<string, unknown>;
  let savedBindings: Record<string, unknown>;

  beforeEach(() => {
    savedBindings = {
      PLUGINS: testEnv.PLUGINS,
      PLUGIN_TEST: testEnv.PLUGIN_TEST,
      PLUGIN_SECRET: testEnv.PLUGIN_SECRET,
      ADMIN_JOBS_QUEUE: testEnv.ADMIN_JOBS_QUEUE,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedBindings)) {
      if (value === undefined) delete testEnv[key];
      else testEnv[key] = value;
    }
  });

  function queueStub<T>(): { queue: Queue<T>; sent: T[] } {
    const sent: T[] = [];
    const queue = {
      send: async (body: T) => { sent.push(body); },
      sendBatch: async (messages: Array<{ body: T }>) => {
        for (const message of messages) sent.push(message.body);
      },
    } as unknown as Queue<T>;
    return { queue, sent };
  }

  function queueBatch<T>(bodies: T[]): MessageBatch<T> {
    return {
      queue: 'test',
      messages: bodies.map((body) => ({ body, ack: () => undefined, retry: () => undefined })),
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<T>;
  }

  it('never forwards client cookies or smuggled trust headers to the plugin', async () => {
    const captured: Array<{ url: string; headers: Headers }> = [];
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-proxy.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        captured.push({ url, headers: new Headers(init?.headers) });
        return new Response('plugin ok');
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: {
        Cookie: `access_token=${token}`,
        'Sec-Fetch-Site': 'same-origin',
        'x-plugin-secret': 'attacker-value',
        'x-cms-user': '{"id":"999","role":"admin"}',
      },
    }));

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    const forwarded = captured[0].headers;
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('x-plugin-secret')).toBe('server-secret');
    // x-cms-user must be the server-derived identity, not the client header.
    expect(JSON.parse(forwarded.get('x-cms-user') ?? '{}')).toMatchObject({ id: '1', email: 'admin@example.com' });
  });

  it('passes plugin redirects back to the browser instead of following them internally', async () => {
    let capturedInit: RequestInit | undefined;
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-redirect.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        capturedInit = init;
        return new Response(null, {
          status: 302,
          headers: { Location: '/admin/plugins/events/events/21862006647168' },
        });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/rsvp/new?event_id=21862006647168', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'event_id=21862006647168&name=Staff+Badge+%28Green%29&allow_checkin=yes',
      redirect: 'manual',
    }));

    expect(capturedInit?.redirect).toBe('manual');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events/21862006647168');
  });

  it('forwards the first _cms_once submission and bounces the replay without re-forwarding', async () => {
    let forwarded = 0;
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-once.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        forwarded += 1;
        return new Response('plugin ok');
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const onceToken = `${await mintFormOnceToken(env.JWT_SECRET)}:aabb1122`;
    const submit = () => worker.fetch(new Request('http://localhost/admin/plugins/events/guests/new', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
        Referer: 'http://localhost/admin/plugins/events/guests?flash=old',
      },
      body: `name=Guest&_cms_once=${encodeURIComponent(onceToken)}`,
      redirect: 'manual',
    }));

    const first = await submit();
    expect(first.status).toBe(200);
    expect(forwarded).toBe(1);

    const replay = await submit();
    expect(forwarded).toBe(1); // duplicate never reaches the plugin
    expect(replay.status).toBe(302);
    const location = replay.headers.get('location') ?? '';
    expect(location).toContain('/admin/plugins/events/guests');
    expect(location).toContain('flash=Already');
    expect(location).not.toContain('flash=old');
  });

  it('releases the _cms_once claim when the plugin fails so a retry is forwarded', async () => {
    let forwarded = 0;
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-once-retry.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        forwarded += 1;
        return forwarded === 1
          ? new Response('boom', { status: 500 })
          : new Response('plugin ok');
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const onceToken = `${await mintFormOnceToken(env.JWT_SECRET)}:ccdd3344`;
    const submit = () => worker.fetch(new Request('http://localhost/admin/plugins/events/guests/new', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: `name=Guest&_cms_once=${encodeURIComponent(onceToken)}`,
      redirect: 'manual',
    }));

    const failed = await submit();
    expect(failed.status).toBe(500);
    const retry = await submit();
    expect(retry.status).toBe(200);
    expect(forwarded).toBe(2); // the retry after a 500 was forwarded, not deduped
  });

  it('queues long events plugin duplicate posts in the CMS admin_jobs table', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    testEnv.ADMIN_JOBS_QUEUE = queue;
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-events-queue.local';
    let pluginActionCalls = 0;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        pluginActionCalls += 1;
        return new Response('should not run inline', { status: 500 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/events/21864157243758/duplicate', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'scope=guests',
      redirect: 'manual',
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/events/events?flash=Event%20duplication%20queued.%20It%20may%20take%20a%20moment%20to%20finish.');
    expect(pluginActionCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: CMS_ADMIN_JOB_KIND });
    const job = await env.DB.prepare('SELECT * FROM admin_jobs WHERE id = ?').bind(sent[0].jobId).first<{
      type: string; status: string; plugin_id: string; method: string; path: string; body: string; content_type: string; user_json: string;
    }>();
    expect(job).toMatchObject({
      type: 'plugin_admin_action',
      status: 'queued',
      plugin_id: 'events',
      method: 'POST',
      path: '/__plugin/admin/events/21864157243758/duplicate',
      body: 'scope=guests',
    });
    expect(job?.content_type).toContain('application/x-www-form-urlencoded');
    expect(JSON.parse(job?.user_json ?? '{}')).toMatchObject({ sub: '1', email: 'admin@example.com' });
  });

  it('runs queued plugin admin jobs with the background-job header', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    testEnv.ADMIN_JOBS_QUEUE = queue;
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-events-job.local';
    const captured: Array<{ url: string; method?: string; body?: BodyInit | null; headers: Headers }> = [];
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        captured.push({ url, method: init?.method, body: init?.body, headers: new Headers(init?.headers) });
        return new Response(null, { status: 302, headers: { Location: '/admin/plugins/events/events/999' } });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    await worker.fetch(new Request('http://localhost/admin/plugins/events/events/21864157243758/duplicate', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'scope=lists',
      redirect: 'manual',
    }));

    await worker.queue(queueBatch(sent), env as unknown as Env);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://plugin.local/__plugin/admin/events/21864157243758/duplicate');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toBe('scope=lists');
    expect(captured[0].headers.get('x-plugin-secret')).toBe('server-secret');
    expect(captured[0].headers.get('x-cms-background-job')).toBe('1');
    expect(JSON.parse(captured[0].headers.get('x-cms-user') ?? '{}')).toMatchObject({ id: '1', email: 'admin@example.com' });
    const job = await env.DB.prepare('SELECT status, attempts, result_status, result_location FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ status: string; attempts: number; result_status: number; result_location: string }>();
    expect(job).toEqual({
      status: 'done',
      attempts: 1,
      result_status: 302,
      result_location: '/admin/plugins/events/events/999',
    });
  });

  it('fails closed when a plugin has no secret and no PLUGIN_SECRET fallback', async () => {
    delete testEnv.PLUGIN_SECRET;
    // A registered, reachable plugin (manifest resolves) but with no row secret
    // and no env fallback must not be proxied to unauthenticated.
    const url = 'https://plugin-nosecret.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('unexpected plugin call', { status: 500 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: {
        Cookie: `access_token=${token}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('X-CMS-Error')).toBe('plugin-secret-required');
  });

  it('wraps an x-cms-chrome fragment in the CMS admin layout', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-chrome.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        // A body fragment opting into the CMS chrome, with a non-ASCII title.
        return new Response('<div class="ev-wrap">FRAGMENT_MARKER</div>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-cms-chrome': '1',
            'x-cms-title': encodeURIComponent('Gala 晚宴'),
          },
        });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    const payload = renderPayload(body);
    expect(body).toContain('FRAGMENT_MARKER');                 // the plugin's content
    expect(body).toContain('/assets/admin.css');               // CMS layout chrome
    expect(payload.layoutData.admin).toBe(true);               // CMS sidebar/layout data
    expect(payload.layoutData.userName).toBe('Admin User');
    expect(body).toContain('Gala 晚宴');                        // decoded unicode title
    // Wrapped pages get the CMS strict nonce CSP, not the relaxed plugin policy.
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
    // Default admin pages stay un-frameable.
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('strips scripts and scriptable attributes from chrome-wrapped plugin fragments', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-fragment-sanitize.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response(
          '<div onclick="PLUGIN_CLICK()">SAFE</div><a href="javascript:PLUGIN_LINK()">bad</a><script>PLUGIN_SCRIPT()</script>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-cms-chrome': '1',
            },
          },
        );
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    const body = await response.text();

    expect(body).toContain('SAFE');
    expect(body).not.toContain('PLUGIN_SCRIPT');
    expect(body).not.toContain('onclick');
    expect(body).not.toContain('javascript:PLUGIN_LINK');
  });

  it('wraps structured plugin client views without rendering plugin HTML on the Worker', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-client-view.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return Response.json(
          { marker: 'CLIENT_VIEW_MARKER' },
          {
            headers: {
              'x-cms-chrome': '1',
              'x-cms-client-view': '1',
              'x-cms-view-path': '/templates/plugin-dashboard.json',
              'x-cms-title': encodeURIComponent('Client View'),
            },
          },
        );
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    const body = await response.text();
    const payload = renderPayload(body);

    expect(response.status).toBe(200);
    expect(payload.bodyView).toMatchObject({
      viewPath: '/templates/plugin-dashboard.json',
      viewBasePath: '/admin/plugins/events/views',
      plugin: true,
      data: { marker: 'CLIENT_VIEW_MARKER' },
      // EVENTS_MANIFEST does not declare `i18n`, so the client must not probe
      // this plugin's locale catalogs (that request would 404 on every view).
      i18n: false,
    });
    expect(payload.layoutData.body).toBe('');
    expect(body).toContain('Client View');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
  });

  it('flags plugin client views for locale loading only when the manifest opts into i18n', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-client-view-i18n.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json({ ...EVENTS_MANIFEST, i18n: true });
        return Response.json(
          { marker: 'CLIENT_VIEW_MARKER' },
          {
            headers: {
              'x-cms-chrome': '1',
              'x-cms-client-view': '1',
              'x-cms-view-path': '/templates/plugin-dashboard.json',
              'x-cms-title': encodeURIComponent('Client View'),
            },
          },
        );
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    expect(renderPayload(await response.text()).bodyView).toMatchObject({
      viewBasePath: '/admin/plugins/events/views',
      i18n: true,
    });
  });

  it('lets a plugin full-document response opt into same-origin framing', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-frame.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        // A full document (no x-cms-chrome) opting into same-origin framing.
        return new Response('<!doctype html><title>Preview</title><body><a href="javascript:BAD()">EMAIL</a><script>BAD()</script></body>', {
          headers: { 'content-type': 'text/html; charset=utf-8', 'x-cms-frame': '1' },
        });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/edm/5/preview', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    // The CMS turns the opt-in into same-origin framing instead of the global DENY.
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(scriptSrc).toContain("script-src 'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // The internal opt-in header isn't leaked to the browser.
    expect(response.headers.get('x-cms-frame')).toBeNull();
    const body = await response.text();
    expect(body).toContain('EMAIL');
    expect(body).not.toContain('BAD()');
    expect(body).not.toContain('javascript:BAD');
  });

  it('renders plugin nav items in the admin sidebar, preferring the admin-entered plugin label', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-nav.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Ticketing', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    const payload = renderPayload(body);
    // The plugin's nav entry (EVENTS_MANIFEST.nav) must reach the rendered
    // sidebar, displaying the admin-entered row label ('Ticketing') instead of
    // the manifest label ('Events') — the plugin has a single nav item, so the
    // override is unambiguous. (The group:settings test below pins the
    // multi-item case, where manifest labels are kept.)
    // EVENTS_MANIFEST does not declare `i18n`, so the entry carries no
    // translation key: the client would only warn about a key the plugin can
    // never supply.
    expect(payload.layoutData.pluginNav).toEqual(expect.arrayContaining([
      { label: 'Ticketing', href: '/admin/plugins/events/dashboard' },
    ]));
  });

  it('includes plugin navigation translations in the admin catalog on core pages', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-nav-locale.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        if (path === '/__plugin/manifest') return Response.json({ ...EVENTS_MANIFEST, i18n: true });
        if (path === '/__plugin/views/locales/en.json') {
          return Response.json({ plugins: { events: { nav: { dashboard: 'Events' } } } });
        }
        if (path === '/__plugin/views/locales/zh-hant.json') {
          return Response.json({ plugins: { events: { nav: { dashboard: '活動' } } } });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const headers = { Cookie: `access_token=${token}; cms_ui_locale=zh-hant`, 'Sec-Fetch-Site': 'same-origin' };
    const page = await worker.fetch(new Request('http://localhost/admin/pages/list', { headers }));

    expect(page.status).toBe(200);
    const payload = renderPayload(await page.text());
    expect(payload.layoutData.sidebarNav).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Events',
        translationKey: 'plugins.events.nav.dashboard',
        href: '/admin/plugins/events/dashboard',
      }),
    ]));

    const catalog = await worker.fetch(new Request('http://localhost/admin/i18n/catalog/zh-hant', { headers }));
    expect(catalog.status).toBe(200);
    expect((await catalog.json<Record<string, string>>())['plugins.events.nav.dashboard']).toBe('活動');
  });

  it('does not request locale catalogs unless the plugin opts into i18n', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-without-locales.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Contacts', url).run();
    const requestedPaths: string[] = [];
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        requestedPaths.push(path);
        if (path === '/__plugin/manifest') return Response.json({ ...EVENTS_MANIFEST, id: 'contacts', name: 'Contacts' });
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/i18n/catalog/zh-hant', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    expect(requestedPaths).toEqual(['/__plugin/manifest']);
  });

  it('renders an event page edit view from the plugin and falls back when it declines', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-editview.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const manifest = { ...EVENTS_MANIFEST, editViews: ['event'] };
    let serveEditView = true;
    const captured: Array<{ body: unknown; headers: Headers }> = [];
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(u).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/edit') {
          captured.push({ body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
          if (!serveEditView) return new Response('nf', { status: 404 });
          return new Response('<form onclick="PLUGIN_EDIT_CLICK()">PLUGIN_EDIT_MARKER<script>PLUGIN_EDIT_SCRIPT()</script></form>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-cms-chrome': '1',
              'x-cms-title': encodeURIComponent('Edit event'),
            },
          });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const insert = await env.DB.prepare(
      'INSERT INTO pages (name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?)',
    ).bind('Gala', 'gala', 5, 'event', '{}').run();
    const row = await env.DB.prepare('SELECT id FROM pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id).first<{ id: number }>();
    const pageId = row!.id;

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const request = (query = '') => new Request(`http://localhost/admin/pages/${pageId}/edit${query}`, {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    });

    try {
      const served = await worker.fetch(request());
      expect(served.status).toBe(200);
      const servedBody = await served.text();
      const servedPayload = renderPayload(servedBody);
      expect(servedBody).toContain('PLUGIN_EDIT_MARKER');   // plugin-rendered form
      expect(servedBody).not.toContain('PLUGIN_EDIT_SCRIPT');
      expect(servedBody).not.toContain('PLUGIN_EDIT_CLICK');
      expect(servedBody).toContain('/assets/admin.css');    // wrapped in CMS chrome
      expect(servedPayload.layoutData.title).toBe('Edit event'); // decoded title
      expect(servedPayload.layoutData.editorSync).toBe(true);
      expect(servedPayload.layoutData.body).toContain('id="presence-bar"');
      expect(servedPayload.layoutData.body).toContain(`data-page-id="${pageId}"`);
      // The CMS hands the plugin the editor context + trusted user, with the
      // form action pointing back at the CMS save handler.
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.get('x-plugin-secret')).toBe('server-secret');
      expect(captured[0].body).toMatchObject({
        mode: 'edit',
        action: `/admin/pages/${pageId}`,
        pageType: 'event',
        page: { id: pageId, name: 'Gala', slug: 'gala' },
      });

      // ?native=1 forces the built-in editor without consulting the plugin.
      const native = await worker.fetch(request('?native=1'));
      expect(native.status).toBe(200);
      const nativeBody = await native.text();
      const nativeData = bodyData(nativeBody);
      expect(nativeBody).not.toContain('PLUGIN_EDIT_MARKER');
      expect(nativeData.page).toMatchObject({ id: pageId, name: 'Gala', slug: 'gala' });
      expect(nativeData.action).toBe(`/admin/pages/${pageId}?native=1`); // flag carried into the form
      expect(captured).toHaveLength(1); // plugin /__plugin/edit was not called again

      // When the plugin declines (404), the CMS renders its built-in editor.
      clearManifestCache();
      serveEditView = false;
      const fallback = await worker.fetch(request());
      expect(fallback.status).toBe(200);
      const fallbackBody = await fallback.text();
      const fallbackData = bodyData(fallbackBody);
      expect(fallbackBody).not.toContain('PLUGIN_EDIT_MARKER');
      expect(fallbackData.page).toMatchObject({ id: pageId, name: 'Gala', slug: 'gala' });
    } finally {
      await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
    }
  });

  it('lets plugins override a page create view without overriding edit', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-newview.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const manifest = { ...EVENTS_MANIFEST, newViews: ['event'] };
    const captured: Array<{ body: unknown; headers: Headers }> = [];
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(u).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/edit') {
          captured.push({ body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
          return new Response('<form>PLUGIN_NEW_MARKER</form>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-cms-chrome': '1',
              'x-cms-title': encodeURIComponent('New event'),
            },
          });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const insert = await env.DB.prepare(
      'INSERT INTO pages (name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?)',
    ).bind('Gala', 'gala', 5, 'event', '{}').run();
    const row = await env.DB.prepare('SELECT id FROM pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id).first<{ id: number }>();
    const pageId = row!.id;

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const headers = { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' };

    try {
      const newResponse = await worker.fetch(new Request('http://localhost/admin/pages/new?page_type=event', { headers }));
      expect(newResponse.status).toBe(200);
      const newBody = await newResponse.text();
      expect(newBody).toContain('PLUGIN_NEW_MARKER');
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.get('x-plugin-secret')).toBe('server-secret');
      expect(captured[0].body).toMatchObject({
        mode: 'new',
        action: '/admin/pages',
        pageType: 'event',
        page: { id: '', pageType: 'event', weight: 5 },
      });

      const editResponse = await worker.fetch(new Request(`http://localhost/admin/pages/${pageId}/edit`, { headers }));
      expect(editResponse.status).toBe(200);
      const editBody = await editResponse.text();
      expect(editBody).not.toContain('PLUGIN_NEW_MARKER');
      expect(bodyData(editBody).page).toMatchObject({ id: pageId, name: 'Gala', slug: 'gala' });
      expect(captured).toHaveLength(1);
    } finally {
      await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
    }
  });

  it('injects editor sync data into plugin client edit views', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-client-editview.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const manifest = {
      ...EVENTS_MANIFEST,
      editViews: ['event'],
      assets: [{ path: '/assets/event-new.js', label: 'New event auto slug' }],
    };
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log("event-new")').buffer);
    await approveAsset(env.DB, 'events', '/assets/event-new.js', integrity, 'admin@example.com');
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(u).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/edit') {
          return Response.json(
            { marker: 'client-edit' },
            {
              headers: {
                'x-cms-chrome': '1',
                'x-cms-client-view': '1',
                'x-cms-view-path': '/templates/editor.json',
                'x-cms-title': encodeURIComponent('Edit event'),
              },
            },
          );
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const insert = await env.DB.prepare(
      'INSERT INTO pages (name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?)',
    ).bind('Gala', 'gala', 5, 'event', '{}').run();
    const row = await env.DB.prepare('SELECT id FROM pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id).first<{ id: number }>();
    const pageId = row!.id;

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    try {
      const response = await worker.fetch(new Request(`http://localhost/admin/pages/${pageId}/edit`, {
        headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
      }));
      expect(response.status).toBe(200);
      const payload = renderPayload(await response.text());
      expect(payload.layoutData.editorSync).toBe(true);
      expect(payload.approvedPluginAssets?.events?.[0]).toMatchObject({
        path: '/assets/event-new.js',
        integrity,
        revision: integrity,
      });
      expect(payload.bodyView?.data).toMatchObject({
        marker: 'client-edit',
        cmsEditPresence: {
          pageId: String(pageId),
          currentUserId: '1',
          userAvatar: '',
        },
      });
    } finally {
      await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
    }
  });

  it('renders an event page read view from the plugin and falls back when it declines', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-readview.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const manifest = { ...EVENTS_MANIFEST, readViews: ['event'] };
    let serveReadView = true;
    const captured: Array<{ body: unknown; headers: Headers }> = [];
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(u).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/read') {
          captured.push({ body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
          if (!serveReadView) return new Response('nf', { status: 404 });
          return new Response('<div onclick="PLUGIN_READ_CLICK()">PLUGIN_READ_MARKER<script>PLUGIN_READ_SCRIPT()</script></div>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-cms-chrome': '1',
              'x-cms-title': encodeURIComponent('View event'),
            },
          });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const insert = await env.DB.prepare(
      'INSERT INTO pages (name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?)',
    ).bind('Gala', 'gala', 5, 'event', '{}').run();
    const row = await env.DB.prepare('SELECT id FROM pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id).first<{ id: number }>();
    const pageId = row!.id;

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const request = (query = '') => new Request(`http://localhost/admin/pages/${pageId}/read${query}`, {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    });

    try {
      const served = await worker.fetch(request());
      expect(served.status).toBe(200);
      const servedBody = await served.text();
      const servedPayload = renderPayload(servedBody);
      expect(servedBody).toContain('PLUGIN_READ_MARKER');    // plugin-rendered view
      expect(servedBody).not.toContain('PLUGIN_READ_SCRIPT'); // inline script stripped
      expect(servedBody).not.toContain('PLUGIN_READ_CLICK');  // on* handler stripped
      expect(servedBody).toContain('/assets/admin.css');      // wrapped in CMS chrome
      expect(servedPayload.layoutData.title).toBe('View event'); // decoded title
      // The CMS hands the plugin the read context + trusted user, with a link
      // back to the CMS editor.
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.get('x-plugin-secret')).toBe('server-secret');
      expect(captured[0].body).toMatchObject({
        editHref: `/admin/pages/${pageId}/edit`,
        pageType: 'event',
        page: { id: pageId, name: 'Gala', slug: 'gala' },
      });

      // ?native=1 forces the built-in read view without consulting the plugin.
      const native = await worker.fetch(request('?native=1'));
      expect(native.status).toBe(200);
      const nativeBody = await native.text();
      expect(nativeBody).not.toContain('PLUGIN_READ_MARKER');
      expect(nativeBody).toContain('Read-only'); // built-in read view badge
      expect(captured).toHaveLength(1); // plugin /__plugin/read was not called again

      // When the plugin declines (404), the CMS renders its built-in read view.
      clearManifestCache();
      serveReadView = false;
      const fallback = await worker.fetch(request());
      expect(fallback.status).toBe(200);
      const fallbackBody = await fallback.text();
      expect(fallbackBody).not.toContain('PLUGIN_READ_MARKER');
      expect(fallbackBody).toContain('Read-only');
    } finally {
      await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
    }
  });

  it('shows the contributing plugin name beside its page types', async () => {
    const url = 'https://plugin-page-types.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Event tools', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const data = bodyData(await response.text());
    expect(data.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'event', source: 'plugin', pluginName: 'Events' }),
    ]));

    const pluginsResponse = await worker.fetch(new Request('http://localhost/admin/plugins-manage', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(pluginsResponse.status).toBe(200);
    const pluginsData = bodyData(await pluginsResponse.text());
    expect(pluginsData.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ hasPageTypes: true }),
    ]));
  });

  it('shows asset approval and update requirements on the plugin list', async () => {
    const url = 'https://plugin-asset-status.local';
    const manifest = {
      id: 'asset-status',
      name: 'Asset status',
      version: '1.0.0',
      assets: [
        { path: '/assets/new.js', label: 'New asset' },
        { path: '/assets/changed.js', label: 'Changed asset' },
      ],
    };
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Asset status', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/assets/new.js') return new Response('console.log("new")');
        if (path === '/assets/changed.js') return new Response('console.log("changed")');
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);
    const changedIntegrity = await computeIntegrity(new TextEncoder().encode('console.log("old")').buffer);
    await approveAsset(env.DB, 'asset-status', '/assets/changed.js', changedIntegrity, 'admin@example.com');

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/plugins-manage', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const data = bodyData(await response.text());
    expect(data.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetNeedsApproval: true,
        assetNeedsUpdate: true,
        assetStatusError: false,
      }),
    ]));
  });

  it('shows plugin-contributed taxonomies and offers them on page types', async () => {
    const url = 'https://plugin-taxonomies.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Event tools', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const headers = { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' };

    const listResponse = await worker.fetch(new Request('http://localhost/admin/taxonomies', { headers }));
    expect(listResponse.status).toBe(200);
    const listData = bodyData(await listResponse.text());
    expect(listData.taxonomies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Audience', slug: 'audience', source: 'plugin', pluginName: 'Events', isDb: false }),
    ]));

    const formResponse = await worker.fetch(new Request('http://localhost/admin/page_types/new', { headers }));
    expect(formResponse.status).toBe(200);
    const formData = bodyData(await formResponse.text());
    expect(formData.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'audience', label: 'Audience' }),
    ]));

    const tagResponse = await worker.fetch(new Request('http://localhost/admin/tags/new', { headers }));
    expect(tagResponse.status).toBe(200);
    const tagData = bodyData(await tagResponse.text());
    expect(tagData.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'audience', name: 'Audience (plugin: Events)' }),
    ]));

    const createTag = await worker.fetch(new Request('http://localhost/admin/tags', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({ name: 'VIP', slug: 'vip', taxonomy_slug: 'audience' }),
    }));
    expect(createTag.status).toBe(302);

    const apiResponse = await worker.fetch(new Request('http://localhost/admin/api/tags/audience', { headers }));
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual([
      expect.objectContaining({ label: 'VIP' }),
    ]);
  });

  it('lists plugin-contributed block types with the contributing plugin name', async () => {
    const url = 'https://plugin-block-types.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Event tools', url).run();
    const manifest = { id: 'events', name: 'Events', version: '1.0.0', contentTypes: { blocks: { hero: ['label'] } } };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/block_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const data = bodyData(await response.text());
    expect(data.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'hero', source: 'plugin', pluginName: 'Events' }),
    ]));
  });

  it('manages delegated plugin page-type approvals', async () => {
    const url = 'https://plugin-page-type-approvals.local';
    await env.DB.prepare('INSERT INTO plugins (id, label, url, enabled) VALUES (?, ?, ?, 1)').bind(44, 'Check-in', url).run();
    const manifest = {
      id: 'checkin',
      name: 'Check-in',
      version: '1.0.0',
      contentTypes: {
        blueprint: { checkin_session: ['event', 'starts_at'] },
        taxonomies: { checkin_status: 'Check-in status' },
        readTypes: ['event', 'mail_list'],
        writeTypes: ['guest'],
      },
    };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const cookie = `access_token=${token}`;

    const listResponse = await worker.fetch(new Request('http://localhost/admin/plugins-manage', {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(listResponse.status).toBe(200);
    const listData = bodyData(await listResponse.text());
    expect(listData.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageTypesHref: '/admin/plugins-manage/44/page-types' }),
    ]));

    const pageResponse = await worker.fetch(new Request('http://localhost/admin/plugins-manage/44/page-types', {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(pageResponse.status).toBe(200);
    const pageData = bodyData(await pageResponse.text());
    expect(pageData.definedPageTypes).toEqual([
      expect.objectContaining({
        slug: 'checkin_session',
        fieldCount: 2,
        viewHref: '/admin/page_types/view/checkin_session',
      }),
    ]);
    expect(pageData.definedTaxonomies).toEqual([
      expect.objectContaining({
        slug: 'checkin_status',
        name: 'Check-in status',
        viewHref: '/admin/taxonomies/view/checkin_status',
      }),
    ]);
    expect(pageData.pageTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageType: 'guest', writeDeclared: true, writeApproved: false }),
      expect.objectContaining({ pageType: 'event', readDeclared: true, readApproved: false }),
    ]));

    const approveResponse = await worker.fetch(new Request('http://localhost/admin/plugins-manage/44/page-types/approve', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ page_type: 'guest', access: 'write' }),
      redirect: 'manual',
    }));
    expect(approveResponse.status).toBe(302);
    expect(approveResponse.headers.get('location')).toBe('/admin/plugins-manage/44/page-types?flash=approved');

    const approved = await env.DB.prepare(
      'SELECT approved_by FROM plugin_page_type_approvals WHERE plugin_id = ? AND page_type = ? AND access = ?',
    ).bind('checkin', 'guest', 'write').first<{ approved_by: string }>();
    expect(approved?.approved_by).toBe('admin@example.com');
  });

  it('places a group:settings nav item inside the Settings group, not the top level', async () => {
    const url = 'https://plugin-settings-nav.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    const manifest = {
      id: 'events', name: 'Events', version: '1.0.0', i18n: true,
      nav: [
        { label: 'Events', href: 'dashboard', roles: ['admin', 'editor'] },
        { label: 'Mail Settings', href: 'mail-settings', group: 'settings', roles: ['admin', 'editor'] },
      ],
    };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind('admin.sidebar_menu.hidden_items', JSON.stringify({
        hidden: [],
        groupWeights: { settings: 5 },
        pluginWeights: {
          'plugin:events:main:/admin/plugins/events/dashboard': 1,
          'plugin:events:settings:/admin/plugins/events/mail-settings': 1,
        },
      }))
      .run();

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const payload = renderPayload(await response.text());
    expect(payload.layoutData.pluginSettingsNav).toEqual([
      {
        label: 'Mail Settings',
        translationKey: 'plugins.events.nav.mail.settings',
        href: '/admin/plugins/events/mail-settings',
      },
    ]);
    expect(payload.layoutData.pluginNav).toEqual([
      { label: 'Events', translationKey: 'plugins.events.nav.dashboard', href: '/admin/plugins/events/dashboard' },
    ]);
    expect(payload.layoutData.sidebarNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Events', href: '/admin/plugins/events/dashboard' }),
      expect.objectContaining({ label: 'Settings', isSettingsGroup: true }),
    ]));
    expect((payload.layoutData.sidebarNav as Array<{ label: string }>).slice(0, 2).map((item) => item.label)).toEqual([
      'Events',
      'Settings',
    ]);
    expect((payload.layoutData.sidebarSettingsNav as Array<{ label: string }>).slice(0, 2).map((item) => item.label)).toEqual([
      'Mail Settings',
      'Taxonomies',
    ]);

    const settingsResponse = await worker.fetch(new Request('http://localhost/admin/settings/system', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(settingsResponse.status).toBe(200);
    const settingsData = bodyData(await settingsResponse.text());
    expect(settingsData.settingsGroupWeight).toBe(5);
    expect(settingsData.pluginOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Events', groupLabel: 'Main', checked: true, weight: 1, icon: 'beaker' }),
      expect.objectContaining({ label: 'Mail Settings', groupLabel: 'Settings', checked: true, weight: 1 }),
    ]));

    const mainPluginKey = 'plugin:events:main:/admin/plugins/events/dashboard';
    const settingsPluginKey = 'plugin:events:settings:/admin/plugins/events/mail-settings';
    const saveResponse = await worker.fetch(new Request('http://localhost/admin/settings/system', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: `access_token=${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams([
        ['app_name', '0xCMS'],
        ['app_icon', 'document'],
        ...['pages', 'tags', 'taxonomies', 'pageTypes', 'blockTypes', 'users', 'roles', 'plugins', 'system', 'trash']
          .map((key) => ['visible_items', key] as [string, string]),
        ['settings_group_weight', '5'],
        [`plugin_weight_${encodeURIComponent(mainPluginKey)}`, '1'],
        [`plugin_weight_${encodeURIComponent(settingsPluginKey)}`, '1'],
        [`plugin_icon_${encodeURIComponent(mainPluginKey)}`, 'document'],
        ['plugin_visible_items', mainPluginKey],
      ]),
    }));
    expect(saveResponse.status).toBe(302);

    const afterHide = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    const afterPayload = renderPayload(await afterHide.text());
    expect(afterPayload.layoutData.sidebarNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Events', href: '/admin/plugins/events/dashboard', icon: 'document' }),
    ]));
    expect(afterPayload.layoutData.sidebarSettingsNav).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Mail Settings' }),
    ]));
  });
});

describe('plugin asset proxy', () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  const testEnv = env as unknown as Record<string, unknown>;
  let savedPluginSecret: unknown;

  const ASSET_MANIFEST = {
    id: 'checkin',
    name: 'Check-in',
    version: '1.0.0',
    assets: [{ path: '/assets/js/kiosk.js', label: 'Kiosk scanner' }],
  };

  beforeEach(() => {
    savedPluginSecret = testEnv.PLUGIN_SECRET;
    testEnv.PLUGIN_SECRET = 'server-secret';
  });

  afterEach(() => {
    if (savedPluginSecret === undefined) delete testEnv.PLUGIN_SECRET;
    else testEnv.PLUGIN_SECRET = savedPluginSecret;
  });

  function registerAssetPlugin(assetBody: string, manifest: unknown = ASSET_MANIFEST) {
    const url = `https://plugin-asset-${crypto.randomUUID()}.local`;
    return env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Check-in', url).run().then(() => {
      __injectPluginFetcher(url, {
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const path = new URL(href).pathname;
          if (path === '/__plugin/manifest') return Response.json(manifest);
          if (path === '/assets/js/kiosk.js') return new Response(assetBody, { headers: { 'content-type': 'text/javascript' } });
          return new Response('nf', { status: 404 });
        },
      } as unknown as Fetcher);
      return url;
    });
  }

  function registerViewPlugin(viewBody: string, manifest: unknown = ASSET_MANIFEST) {
    const url = `https://plugin-view-${crypto.randomUUID()}.local`;
    return env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Check-in', url).run().then(() => {
      __injectPluginFetcher(url, {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const requestUrl = new URL(href);
          if (requestUrl.pathname === '/__plugin/manifest') return Response.json(manifest);
          if (requestUrl.pathname === '/__plugin/admin/views/templates/kiosk-search.json') {
            expect(new Headers(init?.headers).get('x-plugin-secret')).toBe('server-secret');
            return new Response(viewBody, { headers: { 'content-type': 'application/json' } });
          }
          if (requestUrl.pathname === '/__plugin/admin/views/sections/kiosk-search.liquid') {
            expect(new Headers(init?.headers).get('x-plugin-secret')).toBe('server-secret');
            return new Response('<div>Search</div>', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
          }
          return new Response('nf', { status: 404 });
        },
      } as unknown as Fetcher);
      return url;
    });
  }

  async function adminCookie(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    return `access_token=${token}`;
  }

  it('404s an asset that has never been approved', async () => {
    await registerAssetPlugin('console.log(1)');
    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/assets/js/kiosk.js', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(404);
  });

  it('serves an approved asset with its pinned integrity verified', async () => {
    await registerAssetPlugin('console.log("kiosk")');
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log("kiosk")').buffer);
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', integrity, 'admin@example.com');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/assets/js/kiosk.js', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log("kiosk")');
    expect(response.headers.get('content-type')).toContain('text/javascript');
    // Unrevisioned request stays uncached so integrity is re-checked each time.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('caches an approved asset immutably when the request is revisioned (?r=)', async () => {
    await registerAssetPlugin('console.log("kiosk")');
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log("kiosk")').buffer);
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', integrity, 'admin@example.com');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/assets/js/kiosk.js?r=deploy-123', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('keeps unrevisioned plugin view files uncached', async () => {
    await registerViewPlugin('{"sections":{"main":{"type":"kiosk-search"}}}');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/views/templates/kiosk-search.json', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('caches revisioned plugin view files immutably', async () => {
    await registerViewPlugin('{"sections":{"main":{"type":"kiosk-search"}}}');

    const json = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/views/templates/kiosk-search.json?r=deploy-123', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(json.status).toBe(200);
    expect(json.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const liquid = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/views/sections/kiosk-search.liquid?r=deploy-123', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(liquid.status).toBe(200);
    expect(liquid.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(liquid.headers.get('content-type')).toContain('text/plain');
  });

  it('passes the plugin Worker version as the approved asset revision for chrome-wrapped pages', async () => {
    const manifest = {
      ...ASSET_MANIFEST,
      worker_version_id: 'plugin-worker-version-123',
    };
    const url = `https://plugin-asset-${crypto.randomUUID()}.local`;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Check-in', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(href).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/admin/kiosk') {
          return Response.json(
            {},
            {
              headers: {
                'x-cms-chrome': '1',
                'x-cms-client-view': '1',
                'x-cms-view-path': '/templates/kiosk.json',
              },
            },
          );
        }
        if (path === '/assets/js/kiosk.js') return new Response('console.log("kiosk")');
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log("kiosk")').buffer);
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', integrity, 'admin@example.com');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/kiosk', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    const payload = renderPayload(await response.text());

    expect(response.status).toBe(200);
    expect(payload.approvedPluginAssets?.checkin?.[0]).toMatchObject({
      path: '/assets/js/kiosk.js',
      integrity,
      revision: 'plugin-worker-version-123',
    });
    expect(payload.bodyView?.viewRevision).toBe('plugin-worker-version-123');
  });

  it('passes the pinned asset sha as the plugin asset revision when no Worker version is exposed', async () => {
    const url = `https://plugin-asset-${crypto.randomUUID()}.local`;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Check-in', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(href).pathname;
        if (path === '/__plugin/manifest') return Response.json(ASSET_MANIFEST);
        if (path === '/__plugin/admin/kiosk') {
          return Response.json(
            {},
            {
              headers: {
                'x-cms-chrome': '1',
                'x-cms-client-view': '1',
                'x-cms-view-path': '/templates/kiosk.json',
              },
            },
          );
        }
        if (path === '/assets/js/kiosk.js') return new Response('console.log("kiosk")');
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log("kiosk")').buffer);
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', integrity, 'admin@example.com');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/kiosk', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    const payload = renderPayload(await response.text());

    expect(response.status).toBe(200);
    expect(payload.approvedPluginAssets?.checkin?.[0]).toMatchObject({
      path: '/assets/js/kiosk.js',
      integrity,
      revision: integrity,
    });
    expect(payload.bodyView?.viewRevision).toBe('1.0.0');
  });

  it('fails closed when the plugin file changed since approval', async () => {
    await registerAssetPlugin('console.log("changed")');
    // Approve a hash that doesn't match the file the plugin now serves.
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-stale-hash', 'admin@example.com');

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/assets/js/kiosk.js', {
      headers: { Cookie: await adminCookie(), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(409);
  });

  it('applies the same admin-or-declared-permission gate as the plugin admin proxy', async () => {
    await registerAssetPlugin('console.log(1)');
    const integrity = await computeIntegrity(new TextEncoder().encode('console.log(1)').buffer);
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', integrity, 'admin@example.com');

    const now = Math.floor(Date.now() / 1000);
    // moderator passes editorGuard (has some permissions) but the manifest
    // declares no permissions of its own, so it still can't reach this plugin.
    const moderatorToken = await signJWT({
      sub: '2', email: 'mod@example.com', name: 'Mod', role: 'moderator',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/checkin/assets/js/kiosk.js', {
      headers: { Cookie: `access_token=${moderatorToken}`, 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(403);
  });
});
