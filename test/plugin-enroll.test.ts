import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers, getPlugins } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import { cmsTenantRoutes } from '../src/features/plugins/api/tenant';
import { claimEnrollmentTicket, enrollPluginTenant, revokePluginTenant } from '../src/features/plugins/enroll';
import { getSetting } from '../src/core/db/settings';
import { signJWT } from '../src/core/auth/jwt';
import type { Env } from '../src/types';

const CMS_ORIGIN = 'https://cms.example.com';

const MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  autoTenant: true,
};

/** The CMS worker's /__cms surface, mounted the way index.ts mounts it. */
function cmsApp(testEnv: Env) {
  const app = new Hono();
  app.route('/__cms', cmsTenantRoutes);
  return (request: Request) => app.fetch(request, testEnv);
}

interface FakePlugin {
  fetcher: Fetcher;
  /** Tenant records the plugin stored, keyed by tenant id. */
  tenants: Map<string, { cmsUrl: string; secret: string }>;
  enrollCalls: Array<Record<string, unknown>>;
  revokeHeaders: Headers[];
}

/**
 * A plugin Worker that implements the enrollment contract: it redeems the
 * ticket against the origin the request NAMED, using the in-process CMS app.
 */
function makePlugin(options: {
  manifest?: Record<string, unknown>;
  /** Origin the plugin dials instead of the one it was told (attack simulation). */
  claimOrigin?: string;
  cms: (request: Request) => Promise<Response>;
  /** Test seam for connection-state changes made during enrollment. */
  afterEnroll?: () => void;
}): FakePlugin {
  const tenants = new Map<string, { cmsUrl: string; secret: string }>();
  const enrollCalls: Array<Record<string, unknown>> = [];
  const revokeHeaders: Headers[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === '/__plugin/manifest') return Response.json(options.manifest ?? MANIFEST);

    if (path === '/__plugin/tenants/enroll') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      enrollCalls.push(body);
      const origin = options.claimOrigin ?? String(body.tenant);
      const claim = await options.cms(new Request(`${origin}/__cms/tenant/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: body.ticket, plugin_id: body.plugin_id }),
      }));
      if (!claim.ok) return new Response('enrollment_rejected', { status: 403 });
      const granted = await claim.json() as { tenant: string; cms_url: string; secret: string };
      tenants.set(granted.tenant, { cmsUrl: granted.cms_url, secret: granted.secret });
      options.afterEnroll?.();
      return Response.json({ ok: true, tenant: granted.tenant });
    }

    if (path === '/__plugin/tenants/revoke') {
      const headers = new Headers(init?.headers);
      revokeHeaders.push(headers);
      const id = headers.get('x-cms-tenant') ?? '';
      const stored = tenants.get(id);
      if (!stored || stored.secret !== headers.get('x-plugin-secret')) {
        return new Response('forbidden', { status: 403 });
      }
      tenants.delete(id);
      return Response.json({ ok: true });
    }

    return new Response('nf', { status: 404 });
  };

  return { fetcher: { fetch } as unknown as Fetcher, tenants, enrollCalls, revokeHeaders };
}

/** Registers the fake plugin in D1 with a dedicated secret and routes its URL. */
async function register(plugin: FakePlugin, secret = 'a'.repeat(64)): Promise<{ testEnv: Env; url: string }> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind('Test', url, secret)
    .run();
  __injectPluginFetcher(url, plugin.fetcher);
  return { testEnv: { DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env, url };
}

async function resolvedPlugin(testEnv: Env, url: string) {
  const found = (await getPlugins(testEnv)).find((candidate) => candidate.binding === url);
  if (!found) throw new Error('plugin did not resolve');
  return found;
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM settings').run();
});

describe('plugin tenant enrollment', () => {
  it('hands the secret over only through the plugin-initiated claim', async () => {
    const plugin = makePlugin({ cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env) });
    const { testEnv, url } = await register(plugin);
    const resolved = await resolvedPlugin(testEnv, url);

    const result = await enrollPluginTenant(testEnv, resolved, 'admin@example.com');

    expect(result).toEqual({ ok: true, code: 'connected' });
    expect(plugin.tenants.get(CMS_ORIGIN)).toEqual({ cmsUrl: CMS_ORIGIN, secret: resolved.apiSecret });
    // The enroll leg itself never carries the secret.
    expect(JSON.stringify(plugin.enrollCalls[0])).not.toContain(resolved.apiSecret);
  });

  it('forwards manifest-declared tenant vars with the enrollment request', async () => {
    const plugin = makePlugin({
      manifest: {
        ...MANIFEST,
        tenantVars: ['GITHUB_APP_ID', 'GITHUB_APP_SECRET'],
        tenant_vars: ['GITHUB_APP_SECRET', 'GITHUB_APP_SLUG'],
      },
      cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env),
    });
    const { testEnv, url } = await register(plugin);

    const result = await enrollPluginTenant(testEnv, await resolvedPlugin(testEnv, url), 'admin@example.com');

    expect(result.ok).toBe(true);
    expect(plugin.enrollCalls[0]?.tenant_vars).toEqual([
      'GITHUB_APP_ID',
      'GITHUB_APP_SECRET',
      'GITHUB_APP_SLUG',
    ]);
  });

  it('leaves no redeemable ticket behind after the handshake', async () => {
    const plugin = makePlugin({ cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env) });
    const { testEnv, url } = await register(plugin);
    await enrollPluginTenant(testEnv, await resolvedPlugin(testEnv, url), 'admin@example.com');

    expect(await getSetting(testEnv, 'plugin.enrollment.events')).toBeNull();
  });

  it('revalidates cached plugin state after a successful Connect action', async () => {
    const manifest = { ...MANIFEST };
    let manifestFetches = 0;
    const plugin = makePlugin({
      manifest,
      cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env),
      afterEnroll: () => { manifest.version = '2.0.0'; },
    });
    const originalFetch = plugin.fetcher.fetch.bind(plugin.fetcher);
    plugin.fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') manifestFetches += 1;
        return originalFetch(input, init);
      },
    } as unknown as Fetcher;
    const { testEnv, url } = await register(plugin);
    const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(url).first<{ id: number }>();
    expect(row).not.toBeNull();

    // Prime the manifest/registry cache with the pre-enrollment state.
    expect((await getPlugins(testEnv))[0]?.manifest.version).toBe('1.0.0');
    expect(manifestFetches).toBe(1);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
      type: 'access',
      exp: now + 900,
      iat: now,
    }, env.JWT_SECRET);
    const worker = (exports as unknown as { default: Fetcher }).default;
    const response = await worker.fetch(new Request(
      `http://localhost/admin/plugins-manage/${row!.id}/connect`,
      {
        method: 'POST',
        headers: {
          Cookie: `access_token=${token}`,
          'Sec-Fetch-Site': 'same-origin',
        },
        redirect: 'manual',
      },
    ));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('flash=connect-ok');
    expect(manifestFetches).toBe(2);
    expect((await getPlugins(testEnv))[0]?.manifest.version).toBe('2.0.0');
    expect(manifestFetches).toBe(2);
  });

  it('refuses a ticket that is replayed', async () => {
    const claims: string[] = [];
    const cms = cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env);
    const plugin = makePlugin({
      cms: async (request) => {
        claims.push(await request.clone().text());
        return cms(request);
      },
    });
    const { testEnv, url } = await register(plugin);
    await enrollPluginTenant(testEnv, await resolvedPlugin(testEnv, url), 'admin@example.com');

    const replay = await cms(new Request(`${CMS_ORIGIN}/__cms/tenant/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: claims[0],
    }));

    expect(replay.status).toBe(403);
  });

  it('does not hand a secret to a plugin that redeems at a different origin', async () => {
    // The plugin dials somewhere else; the ticket lives only at our origin, so
    // nothing is granted. (Modelled here as an origin that 404s.)
    const plugin = makePlugin({
      claimOrigin: 'https://attacker.example.com',
      cms: async () => new Response('not found', { status: 404 }),
    });
    const { testEnv, url } = await register(plugin);

    const result = await enrollPluginTenant(testEnv, await resolvedPlugin(testEnv, url), 'admin@example.com');

    expect(result.ok).toBe(false);
    expect(plugin.tenants.size).toBe(0);
  });

  it('rejects a claim naming another plugin id', async () => {
    const cms = cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env);
    const plugin = makePlugin({ cms });
    const { testEnv, url } = await register(plugin);
    const resolved = await resolvedPlugin(testEnv, url);
    await enrollPluginTenant(testEnv, resolved, 'admin@example.com');

    const response = await cms(new Request(`${CMS_ORIGIN}/__cms/tenant/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'f'.repeat(64), plugin_id: 'not-registered' }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'unknown_plugin' });
  });

  it('rejects malformed claim bodies before touching the database', async () => {
    const cms = cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env);
    for (const body of [{}, { ticket: 'short', plugin_id: 'events' }, { ticket: 'f'.repeat(64), plugin_id: 'Bad Id' }]) {
      const response = await cms(new Request(`${CMS_ORIGIN}/__cms/tenant/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
    }
  });

  it('does not burn a pending ticket on a wrong guess', async () => {
    const plugin = makePlugin({ cms: async () => new Response('nf', { status: 404 }) });
    const { testEnv, url } = await register(plugin);
    const resolved = await resolvedPlugin(testEnv, url);

    // Mint a ticket by hand so it outlives the (failed) handshake.
    const ticket = 'e'.repeat(64);
    const { saveSetting } = await import('../src/core/db/settings');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await saveSetting(testEnv, 'plugin.enrollment.events', JSON.stringify({
      hash, url: resolved.binding, exp: Date.now() + 60_000, by: 'admin@example.com',
    }));

    expect(await claimEnrollmentTicket(testEnv, 'events', 'd'.repeat(64))).toBeNull();
    expect(await claimEnrollmentTicket(testEnv, 'events', ticket)).toEqual({ url: resolved.binding });
    expect(await claimEnrollmentTicket(testEnv, 'events', ticket)).toBeNull(); // single use
  });

  it('refuses to enroll when the manifest does not opt in', async () => {
    const plugin = makePlugin({
      manifest: { ...MANIFEST, autoTenant: false },
      cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env),
    });
    const { testEnv, url } = await register(plugin);

    const result = await enrollPluginTenant(testEnv, await resolvedPlugin(testEnv, url), 'admin@example.com');

    expect(result).toEqual({ ok: false, code: 'not-supported' });
    expect(plugin.enrollCalls).toEqual([]);
  });

  it('refuses to enroll without a canonical origin to be verified against', async () => {
    const plugin = makePlugin({ cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env) });
    const { testEnv, url } = await register(plugin);
    const resolved = await resolvedPlugin(testEnv, url);

    const result = await enrollPluginTenant({ DB: env.DB } as unknown as Env, resolved, 'admin@example.com');

    expect(result).toEqual({ ok: false, code: 'no-canonical-origin' });
    expect(plugin.enrollCalls).toEqual([]);
  });

  it('is reachable on the deployed worker, past the cross-origin guard', async () => {
    // /__cms is mounted twice (write-back API + this router); prove the claim
    // path is not shadowed and that a browser-shaped POST is not blocked by
    // the CSRF guard the /__cms prefix exempts.
    const worker = (exports as unknown as { default: Fetcher }).default;
    const response = await worker.fetch(new Request('https://cms.example.com/__cms/tenant/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ ticket: 'nope', plugin_id: 'events' }),
    }));

    expect(response.status).toBe(400); // our handler's shape check, not a 404/403
    expect(await response.json()).toEqual({ error: 'bad_request' });
  });

  it('revokes with the pairwise secret and leaves other tenants alone', async () => {
    const plugin = makePlugin({ cms: cmsApp({ DB: env.DB, CANONICAL_ORIGIN: CMS_ORIGIN } as unknown as Env) });
    const { testEnv, url } = await register(plugin);
    const resolved = await resolvedPlugin(testEnv, url);
    await enrollPluginTenant(testEnv, resolved, 'admin@example.com');
    plugin.tenants.set('https://other.example.com', { cmsUrl: 'https://other.example.com', secret: 'other' });

    const result = await revokePluginTenant(testEnv, resolved);

    expect(result.ok).toBe(true);
    expect(plugin.tenants.has(CMS_ORIGIN)).toBe(false);
    expect(plugin.tenants.has('https://other.example.com')).toBe(true);
    expect(plugin.revokeHeaders[0].get('x-plugin-secret')).toBe(resolved.apiSecret);
  });
});
