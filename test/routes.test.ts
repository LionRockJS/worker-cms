import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cmsConfig } from '../src/cms-config';
import { hashToken, signJWT } from '../src/core/auth/jwt';
import { blueprintToLect, stringifyLect } from '../src/core/db/lect';
import { clearConfigCache } from '../src/core/db/content-config';
import { __injectPluginFetcher, clearManifestCache } from '../src/features/plugins/registry';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { CMS_ADMIN_JOB_KIND } from '../src/features/jobs/queue';
import { coreExtensions, registerCoreExtensions, type CmsAdminJobMessage } from '../src/core/extensions';
import type { Env as AppEnv, JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher & { queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> } }).default;
let ipCounter = 0;
const appleKeyPair = crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);

interface RouteCase {
  name: string;
  method?: string;
  path: string;
  body?: BodyInit;
  headers?: HeadersInit;
  authenticated?: boolean;
  expectedStatus: number;
  location?: string | RegExp;
  json?: unknown;
}

interface RenderPayload {
  catalogHref?: string;
  layoutData: Record<string, unknown>;
  bodyView: null | {
    viewPath: string;
    data: Record<string, unknown>;
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

function localizedFixture(base: string): Record<string, string> {
  return Object.fromEntries(cmsConfig.languages.map((language) => [
    language,
    language === cmsConfig.defaultLanguage ? base : `${base} ${language}`,
  ]));
}

function defaultLanguageFixture(base: string): Record<string, string> {
  return Object.fromEntries(cmsConfig.languages.map((language) => [
    language,
    language === cmsConfig.defaultLanguage ? base : '',
  ]));
}

const basePageLectObject = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
basePageLectObject.name = localizedFixture('About');
basePageLectObject.body = localizedFixture('About body');
basePageLectObject.link = {
  [cmsConfig.defaultLanguage]: '',
  label: localizedFixture('Click Now'),
  url: defaultLanguageFixture('https://example.com'),
};
const basePageLect = stringifyLect(basePageLectObject);

beforeEach(async () => {
  vi.unstubAllGlobals();
  clearRolePermissionsCache();
  delete (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE;
  await resetData();
  await seedBaseData();
});

describe('app shell routes', () => {
  it.each<RouteCase>([
    { name: 'GET /media/* without bucket', path: '/media/missing.png', expectedStatus: 404 },
    { name: 'GET /login', path: '/login', expectedStatus: 302, location: '/auth/login' },
    { name: 'GET /favicon.ico', path: '/favicon.ico', expectedStatus: 204 },
    { name: 'GET /', path: '/', expectedStatus: 302, location: '/auth/login' },
    { name: 'notFound', path: '/missing', expectedStatus: 404 },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('redirects non-canonical hosts before route handling', async () => {
    const response = await fetchWorker('/admin', { host: 'https://old.example.com' });

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://cms.example.com/admin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('marks auth and admin responses no-store while keeping assets cacheable', async () => {
    const [login, admin, asset] = await Promise.all([
      fetchWorker('/auth/login'),
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/assets/admin.css'),
    ]);

    expect(login.headers.get('Cache-Control')).toBe('no-store');
    expect(admin.headers.get('Cache-Control')).toBe('no-store');
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('includes the session keepalive on admin pages only', async () => {
    const [login, admin] = await Promise.all([
      fetchWorker('/auth/login'),
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
    ]);

    expect(await admin.text()).toContain("fetch('/auth/refresh'");
    expect(await login.text()).not.toContain("fetch('/auth/refresh'");
  });

  it('rejects cross-origin mutations before protected routes run', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Forbidden');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('lets an explicit hostile Origin override a spoofed same-origin fetch hint', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      headers: {
        Cookie: await authCookie(),
        Origin: 'https://evil.example.com',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: form({ name: 'Must not exist', slug: 'must-not-exist', page_type: 'default' }),
    });

    expect(response.status).toBe(403);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE slug = 'must-not-exist'").first()).toBeNull();
  });

  it('rejects mutations with no browser origin signals (fail closed)', async () => {
    // Raw request without Origin, Referer or Sec-Fetch-Site — e.g. a script
    // replaying stolen cookies. Must be rejected even with valid auth.
    const response = await worker.fetch(new IncomingRequest('http://localhost/admin/pages', {
      method: 'POST',
      redirect: 'manual',
      body: form({ name: 'Sneaky', slug: 'sneaky', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    }));

    expect(response.status).toBe(403);
  });

  it('rejects mutations with Sec-Fetch-Site of none and no origin signal (not same-origin)', async () => {
    // 'none' is a top-level navigation, never a legitimate state-changing
    // request; without an Origin/Referer same-origin signal it is rejected.
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Direct', slug: 'direct', page_type: 'default' }),
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'none' },
    });

    expect(response.status).toBe(403);
  });

  it('allows mutations explicitly marked same-origin by Sec-Fetch-Site', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Direct', slug: 'direct', page_type: 'default' }),
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'same-origin' },
    });

    expect(response.status).toBe(302);
  });

  it('rejects mutations marked cross-site by Sec-Fetch-Site', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'cross-site' },
    });

    expect(response.status).toBe(403);
  });

  it('issues __Host- prefixed auth cookies on https', async () => {
    const jti = 'host-cookie-refresh';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      host: 'https://cms.example.com',
      headers: { Cookie: `refresh_token=${token}` },
    });
    const setCookies = response.headers.getSetCookie().join('\n');

    expect(response.status).toBe(200);
    expect(setCookies).toContain('__Host-access_token=');
    expect(setCookies).toContain('__Host-refresh_token=');
    // Legacy unprefixed cookie still accepted (read fallback) but replaced.
    expect(setCookies).toMatch(/(^|\n)access_token=;/);
  });
});

describe('auth routes', () => {
  it.each<RouteCase>([
    { name: 'GET /auth/login', path: '/auth/login', expectedStatus: 200 },
    { name: 'GET /auth/start', path: '/auth/start?provider=eventuai', expectedStatus: 302, location: /^https:\/\/id\.eventuai\.com\/oauth\/authorize/ },
    { name: 'GET /auth/start google', path: '/auth/start?provider=google', expectedStatus: 302, location: /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/ },
    { name: 'GET /auth/start microsoft', path: '/auth/start?provider=microsoft', expectedStatus: 302, location: /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/ },
    { name: 'GET /auth/start apple', path: '/auth/start?provider=apple', expectedStatus: 302, location: /^https:\/\/appleid\.apple\.com\/auth\/authorize/ },
    { name: 'GET /auth/callback missing params', path: '/auth/callback', expectedStatus: 302, location: '/auth/login?error=missing_params' },
    { name: 'POST /auth/logout', method: 'POST', path: '/auth/logout', expectedStatus: 302, location: '/auth/login' },
    { name: 'GET /auth/logout is rejected', path: '/auth/logout', expectedStatus: 405 },
    { name: 'POST /auth/refresh without token', method: 'POST', path: '/auth/refresh', expectedStatus: 401, json: { error: 'no_refresh_token' } },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('loads the selected UI locale catalog on the public login page', async () => {
    const login = await fetchWorker('/auth/login', {
      headers: { Cookie: 'cms_ui_locale=zh-hant' },
    });
    const payload = renderPayload(await login.text());

    expect(payload.layoutData.uiLocale).toBe('zh-hant');
    expect(payload.catalogHref).toBe('/auth/i18n/catalog/zh-hant');

    const catalog = await fetchWorker('/auth/i18n/catalog/zh-hant');
    expect(catalog.status).toBe(200);
    expect((await catalog.json<Record<string, string>>())['view_strings.sections_login.sign_in_to_manage_your_content'])
      .toBe('登入以管理您的內容');
  });

  it('GET /auth/callback exchanges a valid OAuth response, upserts the user, and creates a session', async () => {
    const start = await fetchWorker('/auth/start?provider=eventuai');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state');
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://id.eventuai.com/oauth/token') {
        return Response.json({ access_token: 'provider-token' });
      }
      if (url === 'https://id.eventuai.com/oauth/userinfo') {
        return Response.json({
          sub: 'eventuai-user',
          email: 'eventuai@example.com',
          preferred_username: 'Eventuai User',
          roles: ['editor'],
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state ?? '')}`, {
      headers: { Cookie: `oauth_state=${stateCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(callback.headers.get('Set-Cookie')).toContain('access_token=');
    expect(await env.DB.prepare('SELECT role FROM users WHERE oauth_id = ?')
      .bind('eventuai:eventuai-user')
      .first<{ role: string }>()).toEqual({ role: 'editor' });
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:eventuai-user')
      .first()).toMatchObject({ provider: 'eventuai', provider_user_id: 'eventuai-user' });
    expect((await env.DB.prepare('SELECT id FROM sessions').all()).results).toHaveLength(1);
  });

  it('links another OAuth identity to the currently signed-in user', async () => {
    const accessCookie = await authCookie();
    const start = await fetchWorker('/auth/start?provider=github&link=1', {
      headers: { Cookie: accessCookie },
    });
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state');
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 12345,
          login: 'admin-gh',
          email: 'admin-github@example.com',
          name: 'Admin GitHub',
          avatar_url: 'https://example.com/admin.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state ?? '')}`, {
      headers: { Cookie: `oauth_state=${stateCookie}; ${accessCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('github:12345')
      .first()).toEqual({ user_id: 1, provider: 'github', provider_user_id: '12345' });
    expect(await env.DB.prepare('SELECT email FROM users WHERE id = 1')
      .first()).toEqual({ email: 'admin@example.com' });
  });

  it('signs in through an already linked secondary OAuth identity', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'github', '12345', 'github:12345')
      .run();

    const start = await fetchWorker('/auth/start?provider=github');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 12345,
          login: 'admin-gh',
          email: 'admin-github@example.com',
          name: 'Admin GitHub',
          avatar_url: 'https://example.com/admin.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `oauth_state=${stateCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id FROM sessions').first()).toEqual({ user_id: 1 });
  });

  it('treats login-page OAuth starts as sign-in even when old refresh cookies remain valid', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'github', 'editor-gh', 'github:editor-gh')
      .run();

    const jti = 'still-valid-refresh';
    const [expiredAccessToken, refreshToken] = await Promise.all([
      signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signTestToken({ type: 'refresh', jti, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const start = await fetchWorker('/auth/start?provider=github', {
      headers: { Cookie: `access_token=${expiredAccessToken}; refresh_token=${refreshToken}` },
    });
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 'editor-gh',
          login: 'editor-gh',
          email: 'editor-github@example.com',
          name: 'Editor GitHub',
          avatar_url: 'https://example.com/editor.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: {
        Cookie: `oauth_state=${stateCookie}; access_token=${expiredAccessToken}; refresh_token=${refreshToken}`,
      },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    )
      .bind(2)
      .first()).toEqual({ user_id: 2 });
  });

  it('handles Apple form_post callbacks using the id_token profile', async () => {
    const start = await fetchWorker('/auth/start?provider=apple');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('nonce')).toBe(state);

    const keyPair = await appleKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const idToken = await signedIdToken({
      iss: 'https://appleid.apple.com',
      aud: 'test.apple.client',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: state,
      sub: 'apple-user',
      email: 'apple@example.com',
    }, keyPair.privateKey, 'test-apple-key');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://appleid.apple.com/auth/token') {
        return Response.json({ id_token: idToken });
      }
      if (url === 'https://appleid.apple.com/auth/keys') {
        return Response.json({ keys: [{ ...publicJwk, kid: 'test-apple-key', alg: 'RS256', use: 'sig' }] });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker('/auth/callback', {
      method: 'POST',
      headers: {
        Cookie: `oauth_state=${stateCookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: form({ code: 'abc', state }),
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('apple:apple-user')
      .first()).toMatchObject({ provider: 'apple', provider_user_id: 'apple-user' });
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example.com' }],
    ['wrong audience', { aud: 'another-client' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['missing nonce', { nonce: undefined }],
    ['mismatched nonce', { nonce: 'not-the-oauth-state' }],
  ])('rejects an Apple ID token with %s before creating a session', async (_label, overrides) => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions').first<{ total: number }>();
    const callback = await appleCallback(overrides);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/auth/login?error=invalid_id_token');
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions').first<{ total: number }>()).toEqual(before);
  });

  it('rejects an Apple ID token whose signature does not match its JWK', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions').first<{ total: number }>();
    const callback = await appleCallback({}, true);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/auth/login?error=invalid_id_token');
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions').first<{ total: number }>()).toEqual(before);
  });

  it('purges expired sessions during refresh', async () => {
    const jti = 'hygiene-refresh';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 day'))",
    )
      .bind(1, 'stale-hash')
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${token}` },
    });

    expect(response.status).toBe(200);
    // The purge runs via waitUntil; poll briefly for it to land.
    await expect.poll(async () => {
      const row = await env.DB.prepare('SELECT id FROM sessions WHERE refresh_token_hash = ?')
        .bind('stale-hash')
        .first();
      return row;
    }, { timeout: 2000 }).toBeNull();
  });

  it('caps concurrent sessions per user at login', async () => {
    // Pre-create the user the mocked OAuth login signs in as.
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(50, 'eventuai:eventuai-user', 'eventuai@example.com', 'Eventuai User', '', 'editor')
      .run();
    for (let i = 0; i < 7; i++) {
      await env.DB.prepare(
        "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
      )
        .bind(50, `old-session-${i}`)
        .run();
    }

    const callback = await completeMockedOAuthLogin();
    expect(callback.status).toBe(302);

    await expect.poll(async () => {
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 50').first<{ n: number }>();
      return rows?.n;
    }, { timeout: 2000 }).toBe(5);
  });

  it('rejects new sign-ups outside ALLOWED_EMAIL_DOMAINS', async () => {
    const testEnv = env as unknown as Record<string, unknown>;
    testEnv.ALLOWED_EMAIL_DOMAINS = 'cowise.co';
    try {
      const callback = await completeMockedOAuthLogin();

      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/auth/login?error=email_not_allowed');
      expect(await env.DB.prepare('SELECT id FROM users WHERE oauth_id = ?')
        .bind('eventuai:eventuai-user')
        .first()).toBeNull();
    } finally {
      delete testEnv.ALLOWED_EMAIL_DOMAINS;
    }
  });

  it('lets existing users sign in even when their domain is not allowlisted', async () => {
    await env.DB.prepare(
      'INSERT INTO users (oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('eventuai:eventuai-user', 'eventuai@example.com', 'Eventuai User', '', 'editor')
      .run();
    const testEnv = env as unknown as Record<string, unknown>;
    testEnv.ALLOWED_EMAIL_DOMAINS = 'cowise.co';
    try {
      const callback = await completeMockedOAuthLogin();

      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/admin');
    } finally {
      delete testEnv.ALLOWED_EMAIL_DOMAINS;
    }
  });

  it('POST /auth/refresh rotates a valid refresh token session', async () => {
    const jti = 'refresh-token-id';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${token}` },
    });
    const body = await response.json<{ ok: boolean; expires_in: number }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, expires_in: 900 });
    expect(response.headers.get('Set-Cookie')).toContain('access_token=');
    expect(response.headers.get('Set-Cookie')).toContain('refresh_token=');
  });

  it('retains an admin browser session with a valid refresh token after access expiry', async () => {
    const jti = 'browser-reopen-refresh';
    const [expiredAccessToken, refreshToken] = await Promise.all([
      signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signTestToken({ type: 'refresh', jti, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    const oldRefreshHash = await hashToken(jti);
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, oldRefreshHash)
      .run();

    const response = await fetchWorker('/admin', {
      headers: { Cookie: `access_token=${expiredAccessToken}; refresh_token=${refreshToken}` },
    });
    const setCookies = response.headers.getSetCookie().join('\n');

    expect(response.status).toBe(200);
    expect(setCookies).toContain('access_token=');
    expect(setCookies).toContain('refresh_token=');
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE refresh_token_hash = ?')
      .bind(oldRefreshHash)
      .first()).toBeNull();
  });

  it('keeps concurrent admin requests signed in during refresh-token rotation', async () => {
    const jti = 'concurrent-browser-refresh';
    const [expiredAccessToken, refreshToken] = await Promise.all([
      signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signTestToken({ type: 'refresh', jti, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const cookie = `access_token=${expiredAccessToken}; refresh_token=${refreshToken}`;
    const first = await fetchWorker('/admin', { headers: { Cookie: cookie } });
    const rotatedHash = await env.DB.prepare(
      'SELECT refresh_token_hash FROM sessions WHERE user_id = ?',
    ).bind(1).first<{ refresh_token_hash: string }>();

    // Models a second request that was sent before the first response updated
    // the browser's shared cookie jar.
    const second = await fetchWorker('/admin/profile', { headers: { Cookie: cookie } });
    const afterGraceHash = await env.DB.prepare(
      'SELECT refresh_token_hash FROM sessions WHERE user_id = ?',
    ).bind(1).first<{ refresh_token_hash: string }>();
    const secondSetCookies = second.headers.getSetCookie().join('\n');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondSetCookies).toContain('access_token=');
    expect(secondSetCookies).not.toMatch(/(^|\n)refresh_token=/);
    expect(afterGraceHash?.refresh_token_hash).toBe(rotatedHash?.refresh_token_hash);
  });

  it('rejects a previous refresh token after the rotation grace expires', async () => {
    const jti = 'expired-rotation-grace';
    const refreshToken = await signTestToken({
      type: 'refresh',
      jti,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    expect((await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${refreshToken}` },
    })).status).toBe(200);

    await env.DB.prepare(
      "UPDATE sessions SET rotated_at = datetime('now', '-31 seconds') WHERE user_id = ?",
    ).bind(1).run();

    const replay = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${refreshToken}` },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'session_revoked' });
  });
});

describe('admin routes', () => {
  it.each<RouteCase>([
    { name: 'GET /admin', path: '/admin', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/profile', path: '/admin/profile', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/list/:pageType', path: '/admin/pages/list/default', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/search/:pageType', path: '/admin/pages/search/default?search=About', authenticated: true, expectedStatus: 302, location: '/admin/advanced-search/default?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=About&path1=' },
    { name: 'GET /admin/pages/create_by_type/:pageType', path: '/admin/pages/create_by_type/default', authenticated: true, expectedStatus: 302, location: '/admin/pages/new?page_type=default' },
    { name: 'POST /admin/pages/new_post/:pageType', method: 'POST', path: '/admin/pages/new_post/default', body: form({ name: 'Quick Page', slug: 'quick-page' }), authenticated: true, expectedStatus: 302, location: /^\/admin\/pages\/\d+\/edit$/ },
    { name: 'GET /admin/pages/new', path: '/admin/pages/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/pages', method: 'POST', path: '/admin/pages', body: form({ name: 'Created', slug: 'created', page_type: 'default' }), authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+created+successfully' },
    { name: 'GET /admin/pages/:id/edit', path: '/admin/pages/101/edit', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/:id/read', path: '/admin/pages/101/read', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/:id/read (missing page)', path: '/admin/pages/99999/read', authenticated: true, expectedStatus: 404 },
    { name: 'POST /admin/pages/:id/weight', method: 'POST', path: '/admin/pages/101/weight', body: form({ weight: '9', return_to: '/admin/pages/list/default' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/list/default?flash=Draft+weight+updated' },
    { name: 'POST /admin/pages/:id', method: 'POST', path: '/admin/pages/101', body: form({ name: 'About Updated', slug: 'about-updated', page_type: 'default', weight: '3' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/101/edit?language=mis&flash=Page+updated+successfully' },
    { name: 'POST /admin/pages/:id (publish from editor)', method: 'POST', path: '/admin/pages/101', body: form({ name: 'About', slug: 'about', page_type: 'default', weight: '3', action: 'publish' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/101/edit?language=mis&flash=Page+published+successfully' },
    { name: 'POST /admin/pages/:id/publish', method: 'POST', path: '/admin/pages/101/publish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+published+successfully' },
    { name: 'POST /admin/pages/pull/:uuid', method: 'POST', path: '/admin/pages/pull/page-uuid-101', authenticated: true, expectedStatus: 302, location: '/admin/pages/101/edit?flash=Draft+already+exists' },
    { name: 'POST /admin/pages/:id/unpublish', method: 'POST', path: '/admin/pages/101/unpublish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+unpublished' },
    { name: 'POST /admin/pages/:id/delete', method: 'POST', path: '/admin/pages/101/delete', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+moved+to+trash' },
    { name: 'GET /admin/trash', path: '/admin/trash', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/trash?type= (filtered view)', path: '/admin/trash?type=default', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/trash/:id/restore', method: 'POST', path: '/admin/trash/201/restore', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+restored+to+draft' },
    { name: 'POST /admin/trash/:id/delete', method: 'POST', path: '/admin/trash/201/delete', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+permanently+deleted' },
    { name: 'GET /admin/api/pages/:type', path: '/admin/api/pages/default', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/pages/:type?q=', path: '/admin/api/pages/default?q=about', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/pages/:type?q= (no match)', path: '/admin/api/pages/default?q=zzz', authenticated: true, expectedStatus: 200, json: [] },
    { name: 'GET /admin/api/pages/:type?id=', path: '/admin/api/pages/default?id=101', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/tags/:type', path: '/admin/api/tags/categories', authenticated: true, expectedStatus: 200, json: [{ value: 301, label: 'News' }, { value: 302, label: 'Updates' }] },
    { name: 'POST /admin/api/page/:pageId/tag/:tagId', method: 'POST', path: '/admin/api/page/101/tag/301', authenticated: true, expectedStatus: 200 },
    { name: 'DELETE /admin/api/page/remove/page_tag/:id', method: 'DELETE', path: '/admin/api/page/remove/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'DELETE /admin/api/page_tag/:id', method: 'DELETE', path: '/admin/api/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'POST /admin/upload', method: 'POST', path: '/admin/upload', body: form({ dir: 'uploads' }), authenticated: true, expectedStatus: 200, json: { success: true, files: [], errors: [] } },
    { name: 'GET /admin/taxonomies', path: '/admin/taxonomies', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/new', path: '/admin/taxonomies/new', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/view/:slug (config)', path: '/admin/taxonomies/view/years', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/view/:slug missing', path: '/admin/taxonomies/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'POST /admin/taxonomies', method: 'POST', path: '/admin/taxonomies', body: form({ name: 'Topics', slug: 'topics' }), authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'GET /admin/taxonomies/:id/edit', path: '/admin/taxonomies/300/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/taxonomies/:id', method: 'POST', path: '/admin/taxonomies/300', body: form({ name: 'Categories', slug: 'categories' }), authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'POST /admin/taxonomies/:id/delete', method: 'POST', path: '/admin/taxonomies/300/delete', authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'GET /admin/tags', path: '/admin/tags', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/tags/new', path: '/admin/tags/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags', method: 'POST', path: '/admin/tags', body: form({ name: 'Fresh Tag', slug: 'fresh-tag', taxonomy_slug: 'categories' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'GET /admin/tags/:id/edit', path: '/admin/tags/301/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags/:id', method: 'POST', path: '/admin/tags/301', body: form({ name: 'News Updated', slug: 'news-updated', taxonomy_slug: 'categories' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'POST /admin/tags/:id/delete', method: 'POST', path: '/admin/tags/301/delete', authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'POST /admin/tags/sync-published', method: 'POST', path: '/admin/tags/sync-published', authenticated: true, expectedStatus: 302, location: /^\/admin\/tags\?synced=\d+$/ },
    { name: 'GET /admin/page_types', path: '/admin/page_types', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/page_types/new', path: '/admin/page_types/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/page_types', method: 'POST', path: '/admin/page_types', body: form({ name: 'Press Release', slug: 'press', blueprint: '["@date","name"]' }), authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'GET /admin/page_types/:id/edit', path: '/admin/page_types/700/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/page_types/:id', method: 'POST', path: '/admin/page_types/700', body: form({ name: 'Event', slug: 'event', blueprint: '["@date","name","location"]' }), authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'POST /admin/page_types/:id/delete', method: 'POST', path: '/admin/page_types/700/delete', authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'GET /admin/block_types', path: '/admin/block_types', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/block_types/new', path: '/admin/block_types/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/block_types', method: 'POST', path: '/admin/block_types', body: form({ name: 'Gallery', slug: 'gallery', blueprint: '["label",{"pictures":["url"]}]' }), authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'GET /admin/block_types/:id/edit', path: '/admin/block_types/800/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/block_types/:id', method: 'POST', path: '/admin/block_types/800', body: form({ name: 'Hero Banner', slug: 'hero', blueprint: '["label",{"pictures":["url","alt"]}]' }), authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'POST /admin/block_types/:id/delete', method: 'POST', path: '/admin/block_types/800/delete', authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'GET /admin/page_types/view/:slug (config)', path: '/admin/page_types/view/default', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/page_types/view/:slug missing', path: '/admin/page_types/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'GET /admin/block_types/view/:slug (config)', path: '/admin/block_types/view/logos', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/block_types/view/:slug missing', path: '/admin/block_types/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'GET /admin/users', path: '/admin/users', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/users/:id/edit', path: '/admin/users/2/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/users/:id', method: 'POST', path: '/admin/users/2', body: form({ roles: 'editor' }), authenticated: true, expectedStatus: 302, location: '/admin/users' },
    { name: 'GET /admin/roles', path: '/admin/roles', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/new', path: '/admin/roles/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/roles', method: 'POST', path: '/admin/roles', body: form({ name: 'reviewers', label: 'Reviewers' }), authenticated: true, expectedStatus: 302, location: '/admin/roles/reviewers/edit' },
    { name: 'GET /admin/roles/:name/edit (built-in)', path: '/admin/roles/editor/edit', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/:name/edit (custom)', path: '/admin/roles/authors/edit', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/admin/edit (locked)', path: '/admin/roles/admin/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/roles/:name', method: 'POST', path: '/admin/roles/editor', body: form({ permissions: 'content:write' }), authenticated: true, expectedStatus: 302, location: '/admin/roles' },
    { name: 'POST /admin/roles/admin (locked)', method: 'POST', path: '/admin/roles/admin', body: form({ permissions: 'content:write' }), authenticated: true, expectedStatus: 403 },
    { name: 'POST /admin/roles/:name/delete (custom)', method: 'POST', path: '/admin/roles/authors/delete', authenticated: true, expectedStatus: 302, location: '/admin/roles' },
    { name: 'GET /admin/settings/system', path: '/admin/settings/system', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/settings/credits', path: '/admin/settings/credits', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/settings/menu (legacy redirect)', path: '/admin/settings/menu', authenticated: true, expectedStatus: 302, location: '/admin/settings/system' },
    { name: 'POST /admin/settings/system', method: 'POST', path: '/admin/settings/system', body: form({ visible_items: 'pages' }), authenticated: true, expectedStatus: 302, location: '/admin/settings/system?flash=saved' },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('renders config-only taxonomies in the tag form as slug options', async () => {
    const response = await fetchWorker('/admin/tags/301/edit', { headers: { Cookie: await authCookie() } });
    expect(response.status).toBe(200);
    const data = bodyData(await response.text());

    expect(data.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'categories', name: 'Categories', selected: true }),
      expect.objectContaining({ id: 'years', name: 'Years (config)' }),
      expect.objectContaining({ id: 'topics', name: 'Topics (config)' }),
      expect.objectContaining({ id: 'collections', name: 'Collections (config)' }),
    ]));
  });

  it('merges config taxonomies into the editor tag groups', async () => {
    const response = await fetchWorker('/admin/pages/101/edit', { headers: { Cookie: await authCookie() } });
    expect(response.status).toBe(200);
    const data = bodyData(await response.text());

    // taxonomyLists.default order, with config-defined taxonomies present even
    // though only 'categories' exists as a DB row.
    const groups = data.tagGroups as Array<{ slug: string; hasTags: boolean; tags: unknown[] }>;
    expect(groups.map((group) => group.slug)).toEqual(['years', 'categories', 'topics', 'collections']);
    expect(groups.find((group) => group.slug === 'categories')?.tags).toEqual([
      expect.objectContaining({ id: 301, name: 'News', checked: false }),
      expect.objectContaining({ id: 302, name: 'Updates', checked: true }),
    ]);
    expect(groups.find((group) => group.slug === 'years')).toMatchObject({ hasTags: false });
  });

  it('filters tags by taxonomy slug', async () => {
    const response = await fetchWorker('/admin/tags?filter_taxonomy=categories', { headers: { Cookie: await authCookie() } });
    expect(response.status).toBe(200);
    const data = bodyData(await response.text());

    expect(data.filterOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'categories', selected: true }),
    ]));
    expect((data.tags as Array<{ slug: string }>).map((tag) => tag.slug)).toEqual(['news', 'updates']);
  });

  it('persists tag weights and orders tag lists by weight', async () => {
    const cookie = await authCookie();
    const createResponse = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Featured', slug: 'featured', taxonomy_slug: 'categories', weight: '1' }),
      headers: { Cookie: cookie },
    });
    expect(createResponse.status).toBe(302);

    const updateResponse = await fetchWorker('/admin/tags/301', {
      method: 'POST',
      body: form({ name: 'News', slug: 'news', taxonomy_slug: 'categories', weight: '20' }),
      headers: { Cookie: cookie },
    });
    expect(updateResponse.status).toBe(302);

    const row = await env.DB.prepare('SELECT weight FROM tags WHERE slug = ?')
      .bind('featured')
      .first<{ weight: number }>();
    expect(row?.weight).toBe(1);

    const editData = bodyData(await (await fetchWorker('/admin/tags/301/edit', { headers: { Cookie: cookie } })).text());
    expect(editData.weight).toBe(20);

    const listData = bodyData(await (await fetchWorker('/admin/tags', { headers: { Cookie: cookie } })).text());
    expect((listData.tags as Array<{ slug: string; weight: number }>).map((tag) => [tag.slug, tag.weight])).toEqual([
      ['featured', 1],
      ['updates', 5],
      ['news', 20],
    ]);

    const apiResponse = await fetchWorker('/admin/api/tags/categories', { headers: { Cookie: cookie } });
    expect(apiResponse.status).toBe(200);
    expect((await apiResponse.json() as Array<{ label: string }>).map((tag) => tag.label)).toEqual([
      'Featured',
      'Updates',
      'News',
    ]);
  });

  it('POST /admin/tags/batch-weight updates multiple tag weights', async () => {
    const response = await fetchWorker('/admin/tags/batch-weight', {
      method: 'POST',
      headers: {
        Cookie: await authCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ updates: [{ id: 301, weight: 30 }, { id: 302, weight: 10 }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const rows = await env.DB.prepare('SELECT id, weight FROM tags WHERE id IN (?, ?)')
      .bind(301, 302)
      .all<{ id: number; weight: number }>();
    const weights = Object.fromEntries(rows.results.map((row) => [row.id, row.weight]));
    expect(weights[301]).toBe(30);
    expect(weights[302]).toBe(10);

    const listData = bodyData(await (await fetchWorker('/admin/tags', { headers: { Cookie: await authCookie() } })).text());
    expect((listData.tags as Array<{ id: number }>).map((tag) => tag.id)).toEqual([302, 301]);
  });

  it('POST /admin/tags/batch-weight rejects unauthenticated requests', async () => {
    const response = await fetchWorker('/admin/tags/batch-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: 301, weight: 10 }] }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/auth/login');
  });

  it('POST /admin/tags/batch-weight rejects malformed input', async () => {
    const response = await fetchWorker('/admin/tags/batch-weight', {
      method: 'POST',
      headers: {
        Cookie: await authCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ updates: 'not-an-array' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid input' });
  });

  it('renders the signed-in user profile with connected and available OAuth providers', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'google', 'google-admin', 'google:google-admin')
      .run();

    const response = await fetchWorker('/admin/profile', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());

    expect(data.name).toBe('Admin User');
    expect(data.email).toBe('admin@example.com');
    expect(data.hasIdentities).toBe(true);
    const profileView = await (await env.VIEWS.fetch('https://views.local/sections/profile.liquid')).text();
    expect(profileView).toContain('action="/auth/logout"');
    expect(profileView).toContain('data-theme-toggle');
    expect(data.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'eventuai', label: 'Eventuai' }),
      expect.objectContaining({
        provider: 'google',
        label: 'Google',
        canDisconnect: true,
        disconnectHref: expect.stringMatching(/^\/admin\/profile\/identities\/\d+\/disconnect$/),
      }),
    ]));
    expect(data.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'google', connected: true }),
      expect.objectContaining({ provider: 'microsoft', connected: false, connectHref: '/auth/start?provider=microsoft&link=1' }),
    ]));
  });

  it('persists the selected interface locale and serves its translated profile catalog', async () => {
    const cookie = await authCookie();
    const dashboard = await fetchWorker('/admin?status=live', { headers: { Cookie: cookie } });
    const dashboardPayload = renderPayload(await dashboard.text());
    expect(dashboardPayload.layoutData.uiLocaleOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'en', label: 'English', selected: true }),
      expect.objectContaining({ code: 'zh-hant', label: '繁體中文', selected: false }),
    ]));
    expect(dashboardPayload.layoutData.uiLocaleAction).toBe('/admin/profile/locale');
    expect(dashboardPayload.layoutData.uiLocaleReturnTo).toBe('/admin?status=live');

    const saved = await fetchWorker('/admin/profile/locale', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ locale: 'zh-hant' }),
    });

    expect(saved.status).toBe(303);
    expect(saved.headers.get('Location')).toBe('/admin/profile?flash=profile.language_saved');
    expect(saved.headers.getSetCookie().join('\n')).toContain('cms_ui_locale=zh-hant');

    const savedInPlace = await fetchWorker('/admin/profile/locale', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ locale: 'zh-hant', return_to: '/admin?status=live' }),
    });
    expect(savedInPlace.headers.get('Location')).toBe('/admin?status=live&flash=profile.language_saved');

    const profile = await fetchWorker('/admin/profile', {
      headers: { Cookie: `${cookie}; cms_ui_locale=zh-hant` },
    });
    const payload = renderPayload(await profile.text());
    expect(payload.layoutData.uiLocale).toBe('zh-hant');
    expect(payload.catalogHref).toBe('/admin/i18n/catalog/zh-hant');

    const catalog = await fetchWorker('/admin/i18n/catalog/zh-hant', {
      headers: { Cookie: `${cookie}; cms_ui_locale=zh-hant` },
    });
    expect(catalog.status).toBe(200);
    expect((await catalog.json<Record<string, string>>())['profile.title']).toBe('個人資料');
  });

  it('disconnects a linked OAuth identity from the profile page', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'google', 'google-admin', 'google:google-admin')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('google:google-admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/profile?flash=Sign-in+method+disconnected');
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('google:google-admin')
      .first()).toBeNull();
    expect(await env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
      .bind(1)
      .first()).toEqual({ oauth_id: 'eventuai:admin' });
  });

  it('does not disconnect the final OAuth identity', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/profile?error=At+least+one+sign-in+method+is+required');
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first()).not.toBeNull();
  });

  it('rotates the legacy primary identity before disconnecting it', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'github', 'admin-gh', 'github:admin-gh')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
      .bind(1)
      .first()).toEqual({ oauth_id: 'github:admin-gh' });
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first()).toBeNull();
  });

  it('renders user delete actions for removable users only', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'github', 'editor-gh', 'github:editor-gh')
      .run();

    const response = await fetchWorker('/admin/users', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await response.text());

    expect(data.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        canDelete: false,
        roles: [{ label: 'Admin', labelKey: 'roles.names.admin' }],
        identityProviders: [{ provider: 'eventuai', label: 'Eventuai' }],
      }),
      expect.objectContaining({
        id: 2,
        canDelete: true,
        roles: [{ label: 'Editor', labelKey: 'roles.names.editor' }],
        identityProviders: [
          { provider: 'github', label: 'GitHub' },
          { provider: 'eventuai', label: 'Eventuai' },
        ],
        deleteAction: '/admin/users/2/delete',
      }),
    ]));
  });

  it('removes a user with their OAuth identities and sessions', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'eventuai', 'editor', 'eventuai:editor')
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(2, 'editor-session')
      .run();

    const response = await fetchWorker('/admin/users/2/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?flash=User+removed');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE user_id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT action, entity_type, entity_id FROM audit_log WHERE action = ?')
      .bind('user.delete')
      .first()).toEqual({ action: 'user.delete', entity_type: 'user', entity_id: '2' });
  });

  it('does not let an admin remove their own user', async () => {
    const response = await fetchWorker('/admin/users/1/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?error=You+cannot+remove+your+own+user');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(1).first()).toEqual({ id: 1 });
  });

  it('does not let an admin remove the last administrator', async () => {
    const otherAdminCookie = `access_token=${await signTestToken({
      sub: '2',
      email: 'editor@example.com',
      name: 'Editor User',
      role: 'admin',
    })}`;

    const response = await fetchWorker('/admin/users/1/delete', {
      method: 'POST',
      headers: { Cookie: otherAdminCookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?error=Cannot+remove+the+last+administrator');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(1).first()).toEqual({ id: 1 });
  });

  it('POST /admin/pages/batch-weight updates multiple page weights', async () => {
    const cookie = await authCookie();
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(102, 'page-uuid-102', 'Contact', 'contact', 5, 'default', basePageLect, 1, '1')
      .run();
    const updates = [
      { id: 101, weight: 10 },
      { id: 102, weight: 20 },
    ];

    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 
        Cookie: cookie,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ updates }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const rows = await env.DB.prepare('SELECT id, weight FROM pages WHERE id IN (?, ?)')
      .bind(101, 102)
      .all<{ id: number; weight: number }>();
    
    const weights = rows.results.reduce((acc, row) => {
      acc[row.id] = row.weight;
      return acc;
    }, {} as Record<number, number>);

    expect(weights[101]).toBe(10);
    expect(weights[102]).toBe(20);
  });

  it('POST /admin/pages/batch-weight rejects unauthenticated requests', async () => {
    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: 101, weight: 10 }] }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/auth/login');
  });

  it('POST /admin/pages/batch-weight rejects malformed input', async () => {
    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 
        Cookie: await authCookie(),
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ updates: 'not-an-array' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid input' });
  });

  it('POST /admin/pages/:id/publish writes published content to PUBLISHED_DB only', async () => {
    await env.PUBLISHED_DB.prepare('DELETE FROM page_tags').run();
    await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();

    const response = await fetchWorker('/admin/pages/101/publish', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.PUBLISHED_DB.prepare('SELECT name, slug, page_type FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ name: string; slug: string; page_type: string }>()).toEqual({
        name: 'About',
        slug: 'about',
        page_type: 'default',
      });
    expect(await env.PUBLISHED_DB.prepare(
      `SELECT lpt.tag_id
       FROM page_tags lpt
       JOIN pages lp ON lp.id = lpt.page_id
       WHERE lp.uuid = ?`,
    )
      .bind('page-uuid-101')
      .first<{ tag_id: number }>()).toEqual({ tag_id: 302 });

    const editor = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect(editor).toMatchObject({
      isPublished: true,
      isLiveSynced: true,
      page: expect.objectContaining({ creatorName: 'Admin User', hasCreator: true }),
      unpublishAction: '/admin/pages/101/unpublish?return_to=%2Fadmin%2Fpages%2F101%2Fedit',
    });

    const localizedEditor = await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: `${await authCookie()}; cms_ui_locale=zh-hant` },
    });
    expect(await localizedEditor.text()).toContain('<title>編輯：About - ');

    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?')
      .bind(JSON.stringify({ _type: 'default', name: { mis: 'Updated draft' } }), 101)
      .run();
    const changedEditor = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect(changedEditor).toMatchObject({ isPublished: true, isLiveSynced: false });
  });

  it.each(['event', 'guest', 'mail_list', 'edm'])('saving an already-published %s page republishes its new version', async (pageType) => {
    const pluginUrl = `https://auto-publish-${crypto.randomUUID()}.local`;
    __injectPluginFetcher(pluginUrl, {
      fetch: async () => Response.json({
        id: 'events',
        name: 'Events Suite',
        version: '1.0.0',
        autoPublishTypes: ['event', 'guest', 'mail_list', 'edm'],
        contentTypes: { blueprint: { event: [], guest: [], mail_list: [], edm: [] } },
      }),
    } as unknown as Fetcher);
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', pluginUrl).run();
    clearManifestCache();
    await env.DB.prepare('UPDATE pages SET page_type = ? WHERE id = ?').bind(pageType, 101).run();
    await fetchWorker('/admin/pages/101/publish', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    const response = await fetchWorker('/admin/pages/101', {
      method: 'POST',
      body: form({ name: 'RSVP Fresh', slug: 'rsvp-fresh', page_type: pageType, weight: '3' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('flash=Page+updated+and+published+successfully');
    expect(await env.PUBLISHED_DB.prepare('SELECT name, slug, page_type FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first()).toEqual({ name: 'RSVP Fresh', slug: 'rsvp-fresh', page_type: pageType });
  });

  it('saving a draft-only RSVP page type does not publish it', async () => {
    const pluginUrl = `https://auto-publish-${crypto.randomUUID()}.local`;
    __injectPluginFetcher(pluginUrl, {
      fetch: async () => Response.json({
        id: 'events',
        name: 'Events Suite',
        version: '1.0.0',
        autoPublishTypes: ['guest'],
        contentTypes: { blueprint: { guest: [] } },
      }),
    } as unknown as Fetcher);
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', pluginUrl).run();
    clearManifestCache();
    await env.PUBLISHED_DB.prepare('DELETE FROM pages WHERE uuid = ?').bind('page-uuid-101').run();
    await env.DB.prepare("UPDATE pages SET page_type = 'guest' WHERE id = 101").run();

    const response = await fetchWorker('/admin/pages/101', {
      method: 'POST',
      body: form({ name: 'Still Draft', slug: 'still-draft', page_type: 'guest', weight: '3' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first()).toBeNull();
  });

  it('POST /admin/pages/:id/unpublish removes content from PUBLISHED_DB', async () => {
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).not.toBeNull();

    const response = await fetchWorker('/admin/pages/101/unpublish', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).toBeNull();
  });

  it('POST /admin/advanced-search/:pageType/bulk publishes and unpublishes selected pages', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    await env.PUBLISHED_DB.prepare('DELETE FROM page_tags').run();
    await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
    const query = 'operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=About&path1=';
    const cookie = await authCookie();

    const publishResponse = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: form({
        bulk_action: 'publish',
        scope: 'selected',
        page_ids: '101',
        return_to: `/admin/advanced-search/default?${query}`,
      }),
      headers: { Cookie: cookie },
    });

    expect(publishResponse.status).toBe(302);
    expect(publishResponse.headers.get('Location')).toBe(`/admin/advanced-search/default?${query}&flash=Bulk%20publish%20queued.%20It%20may%20take%20a%20moment%20to%20finish.`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: CMS_ADMIN_JOB_KIND });
    const publishJob = await env.DB.prepare('SELECT type, status, body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ type: string; status: string; body: string }>();
    expect(publishJob).toMatchObject({ type: 'advanced_search_bulk_action', status: 'queued' });
    expect(JSON.parse(publishJob?.body ?? '{}')).toMatchObject({ action: 'publish', scope: 'selected', ids: [101] });
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).toBeNull();

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    expect(await env.PUBLISHED_DB.prepare('SELECT name FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ name: string }>()).toEqual({ name: 'About' });

    const unpublishResponse = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: form({
        bulk_action: 'unpublish',
        scope: 'selected',
        page_ids: '101',
        return_to: `/admin/advanced-search/default?${query}`,
      }),
      headers: { Cookie: cookie },
    });

    expect(unpublishResponse.status).toBe(302);
    expect(unpublishResponse.headers.get('Location')).toBe(`/admin/advanced-search/default?${query}&flash=Bulk%20unpublish%20queued.%20It%20may%20take%20a%20moment%20to%20finish.`);
    expect(sent).toHaveLength(2);

    await worker.queue(queueBatch([sent[1]]), env as unknown as AppEnv);

    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).toBeNull();
  });

  it('POST /admin/advanced-search/:pageType/bulk adds and removes selected tags idempotently', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    const cookie = await authCookie();
    const query = 'dashboard=1&status=draft';
    const returnTo = '/admin/pages/list/default?status=draft';
    const body = (action: 'add_tag' | 'remove_tag') => {
      const input = new URLSearchParams({
        bulk_action: action,
        scope: 'selected',
        page_ids: '101',
        return_to: returnTo,
      });
      input.append('tag_ids', '301');
      input.append('tag_ids', '302');
      return input;
    };

    const response = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: body('add_tag'),
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `${returnTo}&flash=Bulk%20tag%20addition%20queued.%20It%20may%20take%20a%20moment%20to%20finish.`,
    );
    expect(sent).toHaveLength(1);
    const job = await env.DB.prepare('SELECT body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ body: string }>();
    expect(JSON.parse(job?.body ?? '{}')).toMatchObject({ action: 'add_tag', targetTagIds: [301, 302] });

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    const taggedRows = await env.DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ? ORDER BY tag_id')
      .bind(101)
      .all<{ tag_id: number }>();
    expect(taggedRows.results).toEqual([{ tag_id: 301 }, { tag_id: 302 }]);

    const repeat = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: body('add_tag'),
      headers: { Cookie: cookie },
    });
    expect(repeat.status).toBe(302);
    expect(sent).toHaveLength(2);

    await worker.queue(queueBatch([sent[1]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM page_tags WHERE page_id = ?')
      .bind(101)
      .first<{ total: number }>()).toEqual({ total: 2 });
    const repeatJob = await env.DB.prepare('SELECT result_location FROM admin_jobs WHERE id = ?')
      .bind(sent[1].jobId)
      .first<{ result_location: string }>();
    expect(repeatJob?.result_location).toContain('flash=No%20pages%20updated');

    const removeResponse = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: body('remove_tag'),
      headers: { Cookie: cookie },
    });
    expect(removeResponse.status).toBe(302);
    expect(removeResponse.headers.get('Location')).toBe(
      `${returnTo}&flash=Bulk%20tag%20removal%20queued.%20It%20may%20take%20a%20moment%20to%20finish.`,
    );
    expect(sent).toHaveLength(3);
    const removeJob = await env.DB.prepare('SELECT body FROM admin_jobs WHERE id = ?')
      .bind(sent[2].jobId)
      .first<{ body: string }>();
    expect(JSON.parse(removeJob?.body ?? '{}')).toMatchObject({ action: 'remove_tag', targetTagIds: [301, 302] });

    await worker.queue(queueBatch([sent[2]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM page_tags WHERE page_id = ?')
      .bind(101)
      .first<{ total: number }>()).toEqual({ total: 0 });

    const repeatRemove = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: body('remove_tag'),
      headers: { Cookie: cookie },
    });
    expect(repeatRemove.status).toBe(302);
    expect(sent).toHaveLength(4);

    await worker.queue(queueBatch([sent[3]]), env as unknown as AppEnv);

    const repeatRemoveJob = await env.DB.prepare('SELECT result_location FROM admin_jobs WHERE id = ?')
      .bind(sent[3].jobId)
      .first<{ result_location: string }>();
    expect(repeatRemoveJob?.result_location).toContain('flash=No%20pages%20updated');
  });

  it('bulk-replaces literal text in selected draft content and records a version', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    const lect = {
      _type: 'Old-structural-type',
      _pointers: { related: 'Old-pointer-value' },
      name: { en: 'Old title' },
      body: { en: 'Old text, Old text, and old text.' },
      _blocks: [{ _type: 'Old-block-type', body: { en: '<p>Old block text</p>' } }],
    };
    await env.DB.prepare('UPDATE pages SET name = ?, lect = ? WHERE id = ?')
      .bind('Old About', JSON.stringify(lect), 101)
      .run();
    const versionsBefore = await env.DB.prepare('SELECT COUNT(*) AS total FROM page_versions WHERE page_id = ?')
      .bind(101)
      .first<{ total: number }>();

    const previewResponse = await fetchWorker('/admin/advanced-search/default/bulk?dashboard=1', {
      method: 'POST',
      body: form({
        bulk_action: 'replace_text',
        scope: 'selected',
        page_ids: '101',
        search_text: 'Old',
        replacement_text: 'New',
        return_to: '/admin/pages/list/default',
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(previewResponse.status).toBe(200);
    const preview = bodyData(await previewResponse.text());
    expect(preview).toMatchObject({
      pageTitle: 'Preview search and replace',
      targetPageCount: 1,
      affectedPageCount: 1,
      displayedChangeCount: 4,
      canConfirm: true,
      searchText: 'Old',
      replacementText: 'New',
      selectedPageIds: [101],
    });
    expect(preview.changes).toEqual([
      expect.objectContaining({ fieldPath: 'page.name', currentValue: 'Old About', futureValue: 'New About' }),
      expect.objectContaining({ fieldPath: 'name.en', currentValue: 'Old title', futureValue: 'New title' }),
      expect.objectContaining({ fieldPath: 'body.en', currentValue: 'Old text, Old text, and old text.', futureValue: 'New text, New text, and old text.' }),
      expect.objectContaining({ fieldPath: 'blocks[1].body.en', currentValue: '<p>Old block text</p>', futureValue: '<p>New block text</p>' }),
    ]);
    const previewSection = await (await env.VIEWS.fetch('https://views.local/sections/bulk-replace-preview.liquid')).text();
    expect(previewSection).toContain('change.currentValue');
    expect(previewSection).toContain('change.futureValue');
    expect(previewSection).toContain('name="confirmed" value="1"');
    expect(sent).toHaveLength(0);
    expect(await env.DB.prepare('SELECT name, lect FROM pages WHERE id = ?').bind(101).first<{ name: string; lect: string }>())
      .toEqual({ name: 'Old About', lect: JSON.stringify(lect) });

    const response = await fetchWorker('/admin/advanced-search/default/bulk?dashboard=1', {
      method: 'POST',
      body: form({
        confirmed: '1',
        bulk_action: 'replace_text',
        scope: 'selected',
        page_ids: '101',
        search_text: 'Old',
        replacement_text: 'New',
        return_to: '/admin/pages/list/default',
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=Bulk%20text%20replacement%20queued.%20It%20may%20take%20a%20moment%20to%20finish.');
    expect(sent).toHaveLength(1);
    const queued = await env.DB.prepare('SELECT body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ body: string }>();
    expect(JSON.parse(queued?.body ?? '{}')).toMatchObject({
      action: 'replace_text', searchText: 'Old', replacementText: 'New', ids: [101],
    });

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    const page = await env.DB.prepare('SELECT name, slug, lect FROM pages WHERE id = ?')
      .bind(101)
      .first<{ name: string; slug: string; lect: string }>();
    const changed = JSON.parse(page?.lect ?? '{}') as {
      _type: string;
      _pointers: { related: string };
      name: { en: string };
      body: { en: string };
      _blocks: Array<{ _type: string; body: { en: string } }>;
      _modifier?: number;
    };
    expect(page).toMatchObject({ name: 'New About', slug: 'about' });
    expect(changed.name.en).toBe('New title');
    expect(changed.body.en).toBe('New text, New text, and old text.');
    expect(changed._blocks[0].body.en).toBe('<p>New block text</p>');
    expect(changed._type).toBe('Old-structural-type');
    expect(changed._blocks[0]._type).toBe('Old-block-type');
    expect(changed._pointers.related).toBe('Old-pointer-value');
    expect(changed._modifier).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM page_versions WHERE page_id = ?')
      .bind(101)
      .first<{ total: number }>()).toEqual({ total: (versionsBefore?.total ?? 0) + 1 });
    expect(await env.DB.prepare('SELECT action, lect FROM page_versions WHERE page_id = ? ORDER BY rowid DESC LIMIT 1')
      .bind(101)
      .first<{ action: string; lect: string }>()).toMatchObject({ action: 'bulk-replace', lect: page?.lect });
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'page.update' AND entity_id = '101'")
      .first<{ total: number }>()).toEqual({ total: 1 });
  });

  it('rejects bulk text replacement without search text', async () => {
    const response = await fetchWorker('/admin/advanced-search/default/bulk?dashboard=1', {
      method: 'POST',
      body: form({
        bulk_action: 'replace_text',
        scope: 'selected',
        page_ids: '101',
        replacement_text: 'New',
        return_to: '/admin/pages/list/default',
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=Enter%20text%20to%20find');
  });

  it('bulk-replaces inline without the jobs feature and allows an empty replacement', async () => {
    const original = coreExtensions().enqueueBulkAction;
    registerCoreExtensions({ enqueueBulkAction: undefined });
    try {
      await env.DB.prepare('UPDATE pages SET name = ?, lect = ? WHERE id = ?')
        .bind('Remove this name', JSON.stringify({ body: { en: 'remove stays lowercase.' } }), 101)
        .run();

      const response = await fetchWorker('/admin/advanced-search/default/bulk?dashboard=1', {
        method: 'POST',
        body: form({
          confirmed: '1',
          bulk_action: 'replace_text',
          scope: 'selected',
          page_ids: '101',
          search_text: 'Remove ',
          replacement_text: '',
          return_to: '/admin/pages/list/default',
        }),
        headers: { Cookie: await authCookie() },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=1%20page%20had%20text%20replaced');
      const page = await env.DB.prepare('SELECT name, lect FROM pages WHERE id = ?')
        .bind(101)
        .first<{ name: string; lect: string }>();
      expect(page?.name).toBe('this name');
      expect(JSON.parse(page?.lect ?? '{}')).toMatchObject({ body: { en: 'remove stays lowercase.' } });
    } finally {
      registerCoreExtensions({ enqueueBulkAction: original });
    }
  });

  it('POST /admin/advanced-search/:pageType/bulk moves all matching results to trash', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    const firstLect = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
    firstLect.name = localizedFixture('Bulk Match One');
    const secondLect = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
    secondLect.name = localizedFixture('Bulk Match Two');
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(103, 'bulk-match-uuid-103', 'Bulk Match One', 'bulk-match-one', 7, 'default', stringifyLect(firstLect), 1, '1')
      .run();
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(104, 'bulk-match-uuid-104', 'Bulk Match Two', 'bulk-match-two', 8, 'default', stringifyLect(secondLect), 1, '1')
      .run();

    const query = 'operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=Bulk%20Match&path1=name';
    const response = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body: form({
        bulk_action: 'delete',
        scope: 'all',
        page_ids: '101',
        return_to: `/admin/advanced-search/default?${query}`,
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/admin/advanced-search/default?${query}&flash=Bulk%20deletion%20queued.%20It%20may%20take%20a%20moment%20to%20finish.`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: CMS_ADMIN_JOB_KIND });
    const deleteJob = await env.DB.prepare('SELECT type, status, body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ type: string; status: string; body: string }>();
    expect(deleteJob).toMatchObject({ type: 'advanced_search_bulk_action', status: 'queued' });
    expect(JSON.parse(deleteJob?.body ?? '{}')).toMatchObject({
      action: 'delete',
      scope: 'all',
      ids: [],
      pageTypes: ['default'],
      operator: 'AND',
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id IN (?, ?)')
      .bind(103, 104)
      .first<{ total: number }>()).toEqual({ total: 2 });

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id IN (?, ?)')
      .bind(103, 104)
      .first<{ total: number }>()).toEqual({ total: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages WHERE id IN (?, ?)')
      .bind(103, 104)
      .first<{ total: number }>()).toEqual({ total: 2 });
    expect(await env.DB.prepare('SELECT id FROM pages WHERE id = ?')
      .bind(101)
      .first<{ id: number }>()).not.toBeNull();
    // Audit rows are written for every deleted page in one batched insert.
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM audit_log WHERE action = 'page.delete' AND entity_id IN ('103', '104')",
    ).first<{ total: number }>()).toEqual({ total: 2 });
  });

  // The jobs feature is what registers enqueueBulkAction. Dropping it leaves
  // the extension unregistered, and the screen has to apply the action itself
  // rather than silently doing nothing.
  it('applies a bulk action inline when no durable job runner is installed', async () => {
    const original = coreExtensions().enqueueBulkAction;
    registerCoreExtensions({ enqueueBulkAction: undefined });
    try {
      for (const [id, uuid, name, slug] of [
        [601, 'inline-bulk-601', 'Inline Bulk One', 'inline-bulk-one'],
        [602, 'inline-bulk-602', 'Inline Bulk Two', 'inline-bulk-two'],
      ] as Array<[number, string, string, string]>) {
        const lect = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
        lect.name = localizedFixture(name);
        await env.DB.prepare(
          `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, uuid, name, slug, 5, 'default', stringifyLect(lect), 1, '1').run();
      }

      const jobsBefore = await env.DB.prepare('SELECT COUNT(*) AS total FROM admin_jobs')
        .first<{ total: number }>();

      // Two page_ids, so the form helper's single-value map will not do.
      const body = new URLSearchParams({
        bulk_action: 'delete',
        scope: 'selected',
        return_to: '/admin/advanced-search/default',
      });
      body.append('page_ids', '601');
      body.append('page_ids', '602');

      const response = await fetchWorker('/admin/advanced-search/default/bulk', {
        method: 'POST',
        body,
        headers: { Cookie: await authCookie() },
      });

      expect(response.status).toBe(302);
      // The flash reports what was actually done, not that it was queued.
      expect(response.headers.get('Location'))
        .toBe('/admin/advanced-search/default?flash=2%20pages%20moved%20to%20trash');

      expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id IN (?, ?)')
        .bind(601, 602)
        .first<{ total: number }>()).toEqual({ total: 0 });
      expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages WHERE id IN (?, ?)')
        .bind(601, 602)
        .first<{ total: number }>()).toEqual({ total: 2 });
      // Nothing durable was recorded — there was nowhere to record it.
      expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM admin_jobs')
        .first<{ total: number }>()).toEqual(jobsBefore);
    } finally {
      registerCoreExtensions({ enqueueBulkAction: original });
    }
  });

  it('continues advanced-search bulk jobs across queue invocations', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    await seedDraftPages('default', 125, 3000, 'Chunked Bulk');
    const query = 'operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=Chunked&path1=';
    const body = new URLSearchParams({
      bulk_action: 'delete',
      scope: 'selected',
      return_to: `/admin/advanced-search/default?${query}`,
    });
    for (let id = 3001; id <= 3125; id += 1) body.append('page_ids', String(id));

    const response = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(sent).toHaveLength(1);

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    expect(sent).toHaveLength(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id BETWEEN ? AND ?')
      .bind(3001, 3125)
      .first<{ total: number }>()).toEqual({ total: 25 });
    const partialJob = await env.DB.prepare('SELECT status, body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ status: string; body: string }>();
    expect(partialJob?.status).toBe('queued');
    expect(JSON.parse(partialJob?.body ?? '{}')).toMatchObject({ cursor: 100, updated: 100 });

    await worker.queue(queueBatch([sent[1]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id BETWEEN ? AND ?')
      .bind(3001, 3125)
      .first<{ total: number }>()).toEqual({ total: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages WHERE id BETWEEN ? AND ?')
      .bind(3001, 3125)
      .first<{ total: number }>()).toEqual({ total: 125 });
    const doneJob = await env.DB.prepare('SELECT status, result_location FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ status: string; result_location: string }>();
    expect(doneJob).toEqual({
      status: 'done',
      result_location: `/admin/advanced-search/default?${query}&flash=125%20pages%20moved%20to%20trash`,
    });
  });

  it('resolves all-result jobs even when the initial payload includes visible selected ids', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    await seedDraftPages('default', 25, 4000, 'All Scope');
    const matchLect = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
    matchLect.name = localizedFixture('All Scope');
    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id BETWEEN ? AND ?')
      .bind(stringifyLect(matchLect), 4001, 4025)
      .run();
    const query = 'operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=All%20Scope&path1=';
    const body = new URLSearchParams({
      bulk_action: 'delete',
      scope: 'all',
      return_to: `/admin/advanced-search/default?${query}`,
    });
    for (let id = 4001; id <= 4020; id += 1) body.append('page_ids', String(id));

    const response = await fetchWorker(`/admin/advanced-search/default/bulk?${query}`, {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(sent).toHaveLength(1);

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id BETWEEN ? AND ?')
      .bind(4001, 4025)
      .first<{ total: number }>()).toEqual({ total: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages WHERE id BETWEEN ? AND ?')
      .bind(4001, 4025)
      .first<{ total: number }>()).toEqual({ total: 25 });
  });

  it('GET /admin/advanced-search renders bulk controls for results', async () => {
    const response = await fetchWorker('/admin/advanced-search/default?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=About&path1=', {
      headers: { Cookie: await authCookie() },
    });
    const html = await response.text();
    const data = bodyData(html);
    const section = await (await env.VIEWS.fetch('https://views.local/sections/advanced-search.liquid')).text();

    expect(data.bulkAction).toBe('/admin/advanced-search/default/bulk?operator=AND&pagesize=20&search1=About&path1=&sort=updated_at&order=DESC');
    expect(data.currentHref).toBe('/admin/advanced-search/default?operator=AND&pagesize=20&search1=About&path1=&sort=updated_at&order=DESC&page=1');
    expect(section).toContain('data-bulk-form aria-hidden="true"');
    expect(section).toContain('mb-3 hidden rounded-xl');
  });

  it('POST /admin/pages/pull/:uuid recreates a missing draft from published content', async () => {
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(920, 'live-only-uuid', 'Live Only', 'live-only', 12, 'default', basePageLect, 1, '1')
      .run();
    await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (id, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
      .bind(921, 920, 301, 4)
      .run();

    const response = await fetchWorker('/admin/pages/pull/live-only-uuid', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(/^\/admin\/pages\/\d+\/edit\?flash=Published\+page\+pulled\+to\+draft$/);
    const draft = await env.DB.prepare(
      'SELECT id, uuid, name, slug, weight, page_type FROM pages WHERE uuid = ?',
    )
      .bind('live-only-uuid')
      .first<{ id: number; uuid: string; name: string; slug: string; weight: number; page_type: string }>();
    if (!draft) throw new Error('Expected pulled draft page');
    expect(draft).toMatchObject({
      uuid: 'live-only-uuid',
      name: 'Live Only',
      slug: 'live-only',
      weight: 12,
      page_type: 'default',
    });
    expect(await env.DB.prepare('SELECT tag_id, weight FROM page_tags WHERE page_id = ?')
      .bind(draft.id)
      .first<{ tag_id: number; weight: number }>()).toEqual({ tag_id: 301, weight: 4 });
    // The pull is recorded as the page's first (and so newest) snapshot.
    expect(await env.DB.prepare(
      'SELECT lect, action FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
      .bind(draft.id)
      .first<{ lect: string; action: string }>()).toEqual({ lect: basePageLect, action: 'pull-published' });
  });

  it('renders a solid sidebar initial when the user has no avatar image', async () => {
    const response = await fetchWorker('/admin', {
      headers: { Cookie: await authCookie() },
    });
    const payload = renderPayload(await response.text());

    expect(payload.layoutData.hasUserAvatar).toBe(false);
    expect(payload.layoutData.userInitial).toBe('A');
  });

  it('CMS DB migration does not create the runtime presence table', async () => {
    // The published schema's tables are now named exactly like the CMS's
    // (`pages`, `page_tags`) — deliberately, so a published database can be the
    // next host's working set. No table name distinguishes the two databases
    // any more, so "did the published schema land here?" is asserted by the
    // exact table set in migration-contract.test.ts instead. What is still
    // uniquely wrong here is a runtime table: presence lives in a Durable
    // Object, never in D1.
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'presence'`,
    ).all<{ name: string }>();

    expect(tables.results).toEqual([]);
  });




  it('preserves the page id and version history across a delete → restore cycle', async () => {
    const cookie = await authCookie();

    const deleteResponse = await fetchWorker('/admin/pages/101/delete', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(deleteResponse.status).toBe(302);

    // Trash keeps the original id, the lect, and the history.
    const trashed = await env.DB.prepare('SELECT id, lect FROM trash_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number; lect: string }>();
    expect(trashed).toMatchObject({ id: 101, lect: basePageLect });
    const trashVersion = await env.DB.prepare('SELECT id, page_id FROM trash_page_versions WHERE id = ?')
      .bind(501)
      .first<{ id: number; page_id: number }>();
    expect(trashVersion).toMatchObject({ id: 501, page_id: 101 });
    // The draft copy and its versions are gone while it sits in trash.
    expect(await env.DB.prepare('SELECT id FROM pages WHERE id = ?').bind(101).first()).toBeNull();

    const restoreResponse = await fetchWorker('/admin/trash/101/restore', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(restoreResponse.status).toBe(302);

    // Restore brings back the same id, the same lect, and the history.
    const restored = await env.DB.prepare('SELECT id, lect FROM pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number; lect: string }>();
    expect(restored).toMatchObject({ id: 101, lect: basePageLect });
    const restoredVersion = await env.DB.prepare('SELECT id, page_id, action FROM page_versions WHERE id = ?')
      .bind(501)
      .first<{ id: number; page_id: number; action: string }>();
    expect(restoredVersion).toMatchObject({ id: 501, page_id: 101, action: 'create' });
    // Trash is emptied for this page.
    expect(await env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?').bind('page-uuid-101').first()).toBeNull();
  });

  it('leaves a child page in place when its parent is deleted', async () => {
    // pages.page_id carries no foreign key (it mirrors pages), so a
    // parent delete no longer cascades. That cascade destroyed children
    // outright — trashDraftPage copies only the page it is given, so a child
    // was hard-deleted with its history and never reached trash.
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(150, 'parent-uuid-150', 'Parent', 'parent-150', 5, 'default', basePageLect, 1).run();
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, page_id, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(151, 'child-uuid-151', 'Child', 'child-151', 5, 'default', basePageLect, 150, 1).run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(551, 151, basePageLect, 'create').run();

    const response = await fetchWorker('/admin/pages/150/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const child = await env.DB.prepare('SELECT id, page_id FROM pages WHERE id = ?')
      .bind(151).first<{ id: number; page_id: number }>();
    // The child survives, still pointing at the id its parent had. Readers
    // resolve that to "no parent" rather than treating it as an error.
    expect(child).toMatchObject({ id: 151, page_id: 150 });
    expect(await env.DB.prepare('SELECT id FROM page_versions WHERE id = ?').bind(551).first())
      .toMatchObject({ id: 551 });

    // The parent's own rows still cascade-clean: page_versions and
    // page_tags keep their foreign keys, only the self-reference went.
    expect(await env.DB.prepare('SELECT id FROM pages WHERE id = ?').bind(150).first()).toBeNull();

    // The orphan renders as parentless instead of erroring.
    const editor = await fetchWorker('/admin/pages/151/edit', {
      headers: { Cookie: await authCookie() },
    });
    expect(editor.status).toBe(200);
    expect(bodyData(await editor.text()).parentOptions).toEqual([]);
  });






  it('hides CSV import and export buttons when the import-export plugin is absent', async () => {
    const [dashboard, pageTypeList] = await Promise.all([
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin/pages/list/default', { headers: { Cookie: await authCookie() } }),
    ]);

    const dashboardData = bodyData(await dashboard.text());
    const pageTypeListData = bodyData(await pageTypeList.text());

    expect(dashboardData.importHref).toBe('');
    expect(dashboardData.hasImportHref).toBe(false);
    expect(pageTypeListData.importHref).toBe('');
    expect(pageTypeListData.exportHref).toBe('');
  });

  it('GET /admin filters pages by draft or live status', async () => {
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(901, 'draft-only-uuid', 'Draft Only', 'draft-only', 6, 'default', basePageLect, 1, '1')
      .run();

    const [draftResponse, liveResponse] = await Promise.all([
      fetchWorker('/admin?status=draft', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } }),
    ]);
    const draftData = bodyData(await draftResponse.text());
    const liveData = bodyData(await liveResponse.text());

    expect(draftResponse.status).toBe(200);
    expect(liveResponse.status).toBe(200);
    expect(draftData.pageCountLabel).toBe('Showing 1-1 of 1 draft page');
    expect(JSON.stringify(draftData.pages)).toContain('Draft Only');
    expect(JSON.stringify(draftData.pages)).not.toContain('About');
    expect(liveData.pageCountLabel).toBe('Showing 1-1 of 1 live page');
    expect(JSON.stringify(liveData.pages)).toContain('About');
    expect(JSON.stringify(liveData.pages)).not.toContain('Draft Only');
    expect(draftData.statusFilters).toContainEqual({ label: 'Draft', translationKey: 'pages.status.draft', href: '/admin?status=draft', isActive: true });
    expect(liveData.statusFilters).toContainEqual({ label: 'Live', translationKey: 'pages.status.live', href: '/admin?status=live', isActive: true });
  });

  it('shows five page tags and a more badge in page-list rows', async () => {
    await env.DB.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(101).run();
    for (let index = 1; index <= 6; index++) {
      await env.DB.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)')
        .bind(1200 + index, `Page tag ${index}`, `page-tag-${index}`)
        .run();
      await env.DB.prepare('INSERT INTO page_tags (id, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
        .bind(4200 + index, 101, 1200 + index, index)
        .run();
    }

    const response = await fetchWorker('/admin/pages/list', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());
    const page = (data.pages as Array<Record<string, unknown>>).find((entry) => entry.name === 'About');
    const section = await (await env.VIEWS.fetch('https://views.local/sections/dashboard.liquid')).text();

    expect(response.status).toBe(200);
    expect(page?.tags).toEqual([
      { name: 'Page tag 1' },
      { name: 'Page tag 2' },
      { name: 'Page tag 3' },
      { name: 'Page tag 4' },
      { name: 'Page tag 5' },
    ]);
    expect(page?.hasMoreTags).toBe(true);
    expect(section).toContain('view_strings.sections_dashboard.more');
    expect(section.indexOf('{% if page.hasTags %}')).toBeGreaterThan(section.indexOf("page.publicationStatus == 'live'"));
  });

  it('translates the page-list header and count summary', async () => {
    const response = await fetchWorker('/admin/pages/list/default?status=live', {
      headers: { Cookie: `${await authCookie()}; cms_ui_locale=zh-hant` },
    });
    const data = bodyData(await response.text());

    expect(response.status).toBe(200);
    expect(data.pageTitle).toBe('頁面: default');
    expect(data.pageCountLabel).toBe('顯示 1-1 項，共 1 個已發佈頁面');
  });

  it('GET /admin classifies published pages by their schedule window', async () => {
    const now = Date.now();
    const dateTime = (offsetMs: number) => new Date(now + offsetMs).toISOString().slice(0, 16);
    const hour = 60 * 60 * 1000;
    const rows = [
      [940, 'dashboard-scheduled-uuid', 'Dashboard Scheduled', 'dashboard-scheduled', dateTime(hour), dateTime(3 * hour)],
      [941, 'dashboard-live-uuid', 'Dashboard Live', 'dashboard-live', dateTime(-hour), dateTime(hour)],
      [942, 'dashboard-ended-uuid', 'Dashboard Ended', 'dashboard-ended', dateTime(-3 * hour), dateTime(-hour)],
    ] as const;
    for (const [id, uuid, name, slug, start, end] of rows) {
      await env.PUBLISHED_DB.prepare(
        `INSERT INTO pages (id, uuid, name, slug, weight, start, end, timezone, page_type, lect, creator, editors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, uuid, name, slug, id - 930, start, end, '+0000', 'default', basePageLect, 1, '1').run();
    }

    const [scheduledResponse, liveResponse, endedResponse] = await Promise.all([
      fetchWorker('/admin?status=scheduled', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin?status=ended', { headers: { Cookie: await authCookie() } }),
    ]);
    const [scheduledData, liveData, endedData] = await Promise.all([
      scheduledResponse.text().then(bodyData),
      liveResponse.text().then(bodyData),
      endedResponse.text().then(bodyData),
    ]);
    const names = (data: Record<string, unknown>) => (data.pages as Array<Record<string, unknown>>).map((page) => page.name);

    expect(scheduledResponse.status).toBe(200);
    expect(liveResponse.status).toBe(200);
    expect(endedResponse.status).toBe(200);
    expect(names(scheduledData)).toContain('Dashboard Scheduled');
    expect(names(scheduledData)).not.toContain('Dashboard Live');
    expect(names(scheduledData)).not.toContain('Dashboard Ended');
    expect(names(liveData)).toContain('Dashboard Live');
    expect(names(liveData)).not.toContain('Dashboard Scheduled');
    expect(names(liveData)).not.toContain('Dashboard Ended');
    expect(names(endedData)).toContain('Dashboard Ended');
    expect(names(endedData)).not.toContain('Dashboard Scheduled');
    expect(endedData.statusFilters).toContainEqual({ label: 'Ended', translationKey: 'pages.status.ended', href: '/admin?status=ended', isActive: true });
    expect((scheduledData.pages as Array<Record<string, unknown>>).find((page) => page.name === 'Dashboard Scheduled'))
      .toMatchObject({ publicationStatus: 'scheduled', isPublished: true });
    expect((endedData.pages as Array<Record<string, unknown>>).find((page) => page.name === 'Dashboard Ended'))
      .toMatchObject({ publicationStatus: 'ended', isPublished: true });
  });

  it('adds a re-publish action when the draft differs from its published copy', async () => {
    const changedLect = stringifyLect({ ...basePageLectObject, name: localizedFixture('About changed') });
    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?').bind(changedLect, 101).run();

    const response = await fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());
    const page = (data.pages as Array<Record<string, unknown>>).find((entry) => entry.name === 'About');

    expect(response.status).toBe(200);
    expect(page).toMatchObject({
      hasLiveLectDrift: true,
      publishAction: '/admin/pages/101/publish?return_to=%2Fadmin%3Fpage%3D1%26pagesize%3D100%26status%3Dlive',
    });
  });

  it('marks a page-list weight drift and exposes the publish action to sync it', async () => {
    await env.PUBLISHED_DB.prepare('UPDATE pages SET weight = ? WHERE uuid = ?')
      .bind(9, 'page-uuid-101')
      .run();

    const response = await fetchWorker('/admin/pages/list?status=live', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());
    const page = (data.pages as Array<Record<string, unknown>>).find((entry) => entry.name === 'About');

    expect(response.status).toBe(200);
    expect(page).toMatchObject({
      weight: 5,
      liveWeight: 9,
      hasLiveWeightDrift: true,
      publishAction: '/admin/pages/101/publish?return_to=%2Fadmin%2Fpages%2Flist%3Fpage%3D1%26pagesize%3D100%26status%3Dlive',
    });
  });

  it('GET /admin?status=live shows published pages missing from drafts with a pull action', async () => {
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(930, 'dashboard-live-only-uuid', 'Dashboard Live Only', 'dashboard-live-only', 8, 'default', basePageLect, 1, '1')
      .run();
    await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (id, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
      .bind(931, 930, 301, 4)
      .run();

    const response = await fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());
    const pages = data.pages as Array<Record<string, unknown>>;
    const liveOnly = pages.find((page) => page.name === 'Dashboard Live Only');

    expect(response.status).toBe(200);
    expect(data.pageCountLabel).toBe('Showing 1-2 of 2 live pages');
    expect(liveOnly).toMatchObject({
      isDraftMissing: true,
      isPublished: true,
      editHref: '',
      pullAction: '/admin/pages/pull/dashboard-live-only-uuid',
      tags: [{ name: 'News' }],
    });
  });

  it('keeps the page list available when /admin is configured for another home', async () => {
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(931, 'page-list-submission-uuid', 'Page List Submission', 'page-list-submission', 8, 'default', basePageLect, 1, '1')
      .run();
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('admin.home', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify({ href: '/admin/plugins/events/dashboard' })).run();

    const [home, list] = await Promise.all([
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin/pages/list?status=live', { headers: { Cookie: await authCookie() } }),
    ]);
    const data = bodyData(await list.text());
    const submission = (data.pages as Array<Record<string, unknown>>)
      .find((page) => page.name === 'Page List Submission');

    expect(home.status).toBe(302);
    expect(home.headers.get('Location')).toBe('/admin/plugins/events/dashboard');
    expect(list.status).toBe(200);
    expect(data.statusFilters).toContainEqual({
      label: 'Live', translationKey: 'pages.status.live', href: '/admin/pages/list?status=live', isActive: true,
    });
    expect(submission).toMatchObject({
      isDraftMissing: true,
      pullAction: '/admin/pages/pull/page-list-submission-uuid',
    });
  });

  it('GET /admin paginates draft pages', async () => {
    await seedDraftPages('default', 105, 1000, 'Bulk Default');

    const firstPage = await fetchWorker('/admin', { headers: { Cookie: await authCookie() } });
    const firstData = bodyData(await firstPage.text());

    expect(firstPage.status).toBe(200);
    expect(firstData.pageCountLabel).toBe('Showing 1-100 of 106 pages in draft');
    expect(firstData.currentPage).toBe(1);
    expect(firstData.totalPages).toBe(2);
    expect(firstData.nextHref).toBe('/admin?page=2&pagesize=100');
    expect(JSON.stringify(firstData.pages)).not.toContain('Bulk Default 105');

    const secondPage = await fetchWorker('/admin?page=2', { headers: { Cookie: await authCookie() } });
    const secondData = bodyData(await secondPage.text());

    expect(secondPage.status).toBe(200);
    expect(secondData.pageCountLabel).toBe('Showing 101-106 of 106 pages in draft');
    expect(JSON.stringify(secondData.pages)).toContain('Bulk Default 105');
    expect(secondData.previousHref).toBe('/admin?page=1&pagesize=100');
  });

  it('GET /admin/pages/list/:pageType paginates one page type', async () => {
    await seedDraftPages('company', 105, 2000, 'Company Bulk');

    const response = await fetchWorker('/admin/pages/list/company?page=2&pagesize=25', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await response.text());

    expect(response.status).toBe(200);
    expect(data.pageCountLabel).toBe('Showing 26-50 of 105 pages in draft');
    expect(data.currentPage).toBe(2);
    expect(data.totalPages).toBe(5);
    expect(JSON.stringify(data.pages)).toContain('Company Bulk 026');
    expect(JSON.stringify(data.pages)).toContain('Company Bulk 050');
    expect(JSON.stringify(data.pages)).not.toContain('Company Bulk 001');
    expect(data.previousHref).toBe('/admin/pages/list/company?page=1&pagesize=25');
    expect(data.nextHref).toBe('/admin/pages/list/company?page=3&pagesize=25');
  });

  it('GET /admin/pages/list renders bulk page actions', async () => {
    const response = await fetchWorker('/admin/pages/list', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await response.text());
    const section = await (await env.VIEWS.fetch('https://views.local/sections/dashboard.liquid')).text();

    expect(response.status).toBe(200);
    expect(data.bulkAction).toBe('/admin/advanced-search/bulk?dashboard=1');
    expect(data.hasSelectablePages).toBe(true);
    expect(data.pages).toContainEqual(expect.objectContaining({
      name: 'About',
      isSelectable: true,
    }));
    expect(section).toContain('id="dashboard-bulk-form"');
    expect(section).toContain('class="mb-3 hidden rounded-xl');
    expect(section).toContain('data-dashboard-bulk-confirm-template=');
    expect(section).toContain('aria-hidden="true"');
    expect(section).toContain('data-dashboard-bulk-select-all');
    expect(section).toContain('data-dashboard-bulk-checkbox');
    expect(section).toContain('<option value="publish">');
    expect(section).toContain('<option value="unpublish">');
    expect(section).toContain('<option value="delete">');
    expect(section).toContain('<option value="add_tag">');
    expect(section).toContain('<option value="remove_tag">');
    expect(section).toContain('<option value="replace_text">');
    expect(section).toContain('data-dashboard-bulk-tag-label-remove');
    expect(section).toContain('data-dashboard-bulk-tag-option');
    expect(section).toContain('data-dashboard-bulk-scope');
    expect(section).toContain('data-dashboard-bulk-replacement');
    expect(section).toContain('name="search_text"');
    expect(section).toContain('name="replacement_text"');
    expect(section).toContain("if (action?.value === 'replace_text') return;");
    expect(section).toContain('<option value="all">');
    expect(data.bulkTagGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Categories',
        tags: expect.arrayContaining([
          expect.objectContaining({ id: 301, name: 'News' }),
          expect.objectContaining({ id: 302, name: 'Updates' }),
        ]),
      }),
    ]));
  });

  it('bulk-selects matching dashboard pages outside the current pagination page', async () => {
    const { queue, sent } = queueStub<CmsAdminJobMessage>();
    (env as unknown as { ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage> }).ADMIN_JOBS_QUEUE = queue;
    await seedDraftPages('company', 3, 6000, 'Across Pagination');

    const response = await fetchWorker('/admin/advanced-search/company/bulk?dashboard=1&status=draft', {
      method: 'POST',
      body: form({
        bulk_action: 'delete',
        scope: 'all',
        page_ids: '6000',
        return_to: '/admin/pages/list/company?status=draft&page=1&pagesize=1',
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(sent).toHaveLength(1);
    const job = await env.DB.prepare('SELECT body FROM admin_jobs WHERE id = ?')
      .bind(sent[0].jobId)
      .first<{ body: string }>();
    expect(JSON.parse(job?.body ?? '{}')).toMatchObject({
      scope: 'all',
      pageTypes: ['company'],
      criteria: [],
      status: 'draft',
    });

    await worker.queue(queueBatch([sent[0]]), env as unknown as AppEnv);

    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM pages WHERE id BETWEEN 6000 AND 6002')
      .first<{ total: number }>()).toEqual({ total: 0 });
    expect(await env.DB.prepare('SELECT id FROM pages WHERE id = 101').first()).not.toBeNull();
  });

  it('redirects anonymous admin requests to login', async () => {
    const response = await fetchWorker('/admin');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/auth/login');
  });

  it('returns JSON for unauthenticated upload requests', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('X-CMS-Error')).toBe('authentication-required');
    expect(await response.json()).toEqual({ success: false, error: 'Authentication required' });
  });

  it('returns JSON for upload requests rejected by origin checks', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Origin: 'https://evil.example.com',
      },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('origin-is-not-allowed');
    expect(await response.json()).toEqual({ success: false, error: 'Origin is not allowed' });
  });

  it('returns JSON for forbidden upload requests', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: await authCookie('viewer'),
      },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('editor-role-required');
    expect(await response.json()).toEqual({ success: false, error: 'Editor role required' });
  });

  it('records page mutations in the audit log', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Audited Page', slug: 'audited-page', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    await expect.poll(async () => {
      return env.DB.prepare("SELECT user_email, action, entity_type FROM audit_log WHERE action = 'page.create' ORDER BY id DESC LIMIT 1")
        .first<{ user_email: string; action: string; entity_type: string }>();
    }, { timeout: 2000 }).toMatchObject({
      user_email: 'admin@example.com',
      action: 'page.create',
      entity_type: 'page',
    });
  });


  it('POST /admin/api/presence/:pageId stores sanitized presence in the page Durable Object', async () => {
    const response = await fetchWorker('/admin/api/presence/101', {
      method: 'POST',
      body: JSON.stringify({ lastActive: 'not-a-date', userAvatar: `javascript:${'x'.repeat(600)}` }),
      headers: { Cookie: await authCookie(), 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const presenceResponse = await fetchWorker('/admin/api/presence/101', {
      headers: { Cookie: await authCookie() },
    });
    const rows = await presenceResponse.json() as Array<{
      user_id: string;
      user_name: string;
      user_avatar: string | null;
      last_seen: string;
      last_active: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: '1',
      user_name: 'Admin User',
      user_avatar: null,
    });
    expect(Number.isFinite(Date.parse(rows[0].last_active))).toBe(true);
  });

  it('loads one Yjs runtime only in an existing page editor document', async () => {
    const response = await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    });
    const html = await response.text();
    const clientAssets = renderPayload(html).layoutData.clientAssets as string[];
    const bootstrapAssets = [...html.matchAll(/<script src="([^"?]+)/g)].map((match) => match[1]);

    expect(clientAssets.filter((asset) => asset === '/assets/yjs.js')).toEqual(['/assets/yjs.js']);
    expect(clientAssets.filter((asset) => asset === '/assets/editor-sync.js')).toEqual(['/assets/editor-sync.js']);
    expect(bootstrapAssets).not.toContain('/assets/yjs.js');
    expect(bootstrapAssets).not.toContain('/assets/editor-sync.js');
  });

  it('POST /admin/api/page/:pageId/tag/:tagId reports duplicate tag links', async () => {
    await env.DB.prepare('INSERT INTO page_tags (id, page_id, tag_id) VALUES (?, ?, ?)')
      .bind(402, 101, 301)
      .run();

    const response = await fetchWorker('/admin/api/page/101/tag/301', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 'ADD_PAGE_TAG',
      payload: { success: false, message: 'tag exist', id: 402 },
    });
  });

  it('POST /admin/upload stores media in R2 and records metadata', async () => {
    const body = new FormData();
    body.append('dir', 'pictures');
    body.append('file', new File([pngBytes()], 'avatar.png', { type: 'image/png' }));

    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });
    const payload = await response.json<{ success: boolean; files: string[] }>();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatch(/^\/media\/pictures\/\d{4}\/\d{1,2}\/\d{1,2}\/.+-avatar\.png$/);

    const media = await env.DB.prepare('SELECT key, url, filename, content_type, size FROM media_files WHERE url = ?')
      .bind(payload.files[0])
      .first<{ key: string; url: string; filename: string; content_type: string; size: number }>();
    expect(media).toMatchObject({
      url: payload.files[0],
      filename: 'avatar.png',
      content_type: 'image/png',
      size: 10,
    });
  });

  it('GET /media-preview/* serves a resized thumbnail for editor previews', async () => {
    const body = new FormData();
    body.append('dir', 'pictures');
    body.append('file', new File([decodablePngBytes()], 'avatar.png', { type: 'image/png' }));

    const upload = await fetchWorker('/admin/upload', {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });
    const payload = await upload.json<{ files: string[] }>();
    const previewPath = payload.files[0].replace(/^\/media\//, '/media-preview/');

    const response = await fetchWorker(previewPath);

    expect(response.status).toBe(200);
    // The Images binding re-encodes to webp; the untransformed original is png.
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(decodablePngBytes());
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  it('GET /media-preview/* falls back to the original for non-image objects', async () => {
    const body = new FormData();
    body.append('dir', 'docs');
    body.append('file', new File(['id,name\n1,a\n'], 'guests.csv', { type: 'text/csv' }));

    const upload = await fetchWorker('/admin/upload', {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });
    const payload = await upload.json<{ files: string[] }>();
    const previewPath = payload.files[0].replace(/^\/media\//, '/media-preview/');

    const response = await fetchWorker(previewPath);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv');
    expect(await response.text()).toBe('id,name\n1,a\n');
  });
});

describe('capability enforcement', () => {
  it('lets a moderator publish but not create or edit content', async () => {
    const edit = await fetchWorker('/admin/pages/101/edit?language=mis&version=502&return_to=%2Fadmin%2Fpages', {
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(edit.status).toBe(302);
    expect(edit.headers.get('Location')).toBe('/admin/pages/101/read?language=mis&version=502&return_to=%2Fadmin%2Fpages');

    const publish = await fetchWorker('/admin/pages/101/publish', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(publish.status).toBe(302);

    const create = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Page', slug: 'mod-page', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(create.status).toBe(403);
  });

  it('lets a moderator move to trash and restore but not purge', async () => {
    await env.DB.prepare("UPDATE trash_pages SET created_at = datetime('now') WHERE id = ?").bind(201).run();

    const trashList = await fetchWorker('/admin/trash', {
      headers: { Cookie: await authCookie('moderator') },
    });
    const trashHtml = await trashList.text();
    const trashData = bodyData(trashHtml);
    expect(trashData.canPurgeTrash).toBe(false);
    expect(trashData.hasRecent).toBe(true);

    const restore = await fetchWorker('/admin/trash/201/restore', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(restore.status).toBe(302);

    const purge = await fetchWorker('/admin/trash/201/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(purge.status).toBe(403);
  });

  it('lets an editor create content but not purge trash or reach plugins', async () => {
    const create = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Editor Page', slug: 'editor-page', page_type: 'default' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(302);

    const purge = await fetchWorker('/admin/trash/201/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie('editor') },
    });
    expect(purge.status).toBe(403);

    const plugin = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(plugin.status).toBe(403);
  });

  it('lets viewers reach a safe dashboard and profile without exposing pages', async () => {
    const cookie = await authCookie('viewer');
    const dashboard = await fetchWorker('/admin', { headers: { Cookie: cookie } });
    expect(dashboard.status).toBe(200);
    const payload = renderPayload(await dashboard.text());
    expect(payload.bodyView?.viewPath).toBe('/templates/viewer-home.json');
    expect(payload.layoutData.showSidebarPages).toBe(false);

    const profile = await fetchWorker('/admin/profile', { headers: { Cookie: cookie } });
    expect(profile.status).toBe(200);

    const list = await fetchWorker('/admin/pages/list', { headers: { Cookie: cookie } });
    expect(list.status).toBe(302);
    expect(list.headers.get('Location')).toBe('/auth/login?error=forbidden');
    const read = await fetchWorker('/admin/pages/101/read', { headers: { Cookie: cookie } });
    expect(read.status).toBe(302);
    expect(read.headers.get('Location')).toBe('/auth/login?error=forbidden');
    const edit = await fetchWorker('/admin/pages/101/edit', { headers: { Cookie: cookie } });
    expect(edit.status).toBe(302);
    expect(edit.headers.get('Location')).toBe('/auth/login?error=forbidden');
  });

  it('keeps plugin admin pages admin-only even when a custom role has plugin:access', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('pluginviewer', 'Plugin Viewer').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('pluginviewer', 'plugin:access').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('pluginviewer') },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBeNull();
    expect(await response.text()).toBe('Forbidden: admin role required');
  });

  it('lets a custom role reach a plugin that declares the permission it was granted, but not other plugins', async () => {
    const pluginUrl = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: 'checkin',
      name: 'Check-in',
      version: '1.0.0',
      permissions: [{ value: 'checkin:door', label: 'Check-in door access' }],
    };
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const path = new URL(url).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    } as unknown as Fetcher);
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Checkin', pluginUrl).run();
    clearManifestCache();

    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('door-staff', 'Door Staff').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('door-staff', 'checkin:door').run();
    clearRolePermissionsCache();

    const allowed = await fetchWorker('/admin/plugins/checkin/dashboard', {
      headers: { Cookie: await authCookie('door-staff') },
    });
    expect(allowed.status).toBe(200);

    // The granted permission is namespaced to the checkin plugin — it must not
    // unlock a different (unregistered, in this test) plugin id.
    const other = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('door-staff') },
    });
    expect(other.status).toBe(403);
  });

  it('lets an editor view page types but not create them (admin only)', async () => {
    const view = await fetchWorker('/admin/page_types', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(view.status).toBe(200);

    const create = await fetchWorker('/admin/page_types', {
      method: 'POST',
      body: form({ name: 'Nope', slug: 'nope', blueprint: '["name"]' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(403);
  });

  it('lets an editor view block types but not create them (admin only)', async () => {
    const view = await fetchWorker('/admin/block_types', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(view.status).toBe(200);

    const create = await fetchWorker('/admin/block_types', {
      method: 'POST',
      body: form({ name: 'Nope', slug: 'nope-block', blueprint: '["label"]' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(403);
  });

  it('blocks editors from the users and roles admin (admin only)', async () => {
    expect((await fetchWorker('/admin/users', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
    expect((await fetchWorker('/admin/roles', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
  });

  it('applies role permission changes to the permission gate', async () => {
    // A moderator cannot write content by default.
    const before = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Draft', slug: 'mod-draft', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(before.status).toBe(403);

    // An admin grants the moderator role content:write.
    const grant = await fetchWorker('/admin/roles/moderator', {
      method: 'POST',
      body: form({ permissions: 'content:write' }),
      headers: { Cookie: await authCookie() },
    });
    expect(grant.status).toBe(302);

    // Now the moderator can write content.
    const after = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Draft', slug: 'mod-draft', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(after.status).toBe(302);
  });

  it('returns JSON 403 with insufficient-permissions for moderator uploads', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: await authCookie('moderator') },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('insufficient-permissions');
    expect(await response.json()).toEqual({ success: false, error: 'Insufficient permissions' });
  });

  it('lets editors manage tags but blocks moderators', async () => {
    // Editors hold tag:write.
    const tag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Editor Tag', slug: 'editor-tag', taxonomy_slug: 'categories' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(tag.status).toBe(302);

    // Moderators do not.
    const modTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Mod Tag', slug: 'mod-tag', taxonomy_slug: 'categories' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(modTag.status).toBe(403);
  });

  it('separates tag:write from taxonomy:write', async () => {
    // A role granted only tag:write can manage tags but not taxonomies.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('tagger', 'Tagger').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('tagger', 'tag:write').run();
    // A role granted only taxonomy:write can manage taxonomies but not tags.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('taxer', 'Taxer').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('taxer', 'taxonomy:write').run();
    clearRolePermissionsCache();

    const taggerTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'T1', slug: 't1', taxonomy_slug: 'categories' }),
      headers: { Cookie: await authCookie('tagger') },
    });
    expect(taggerTag.status).toBe(302);

    const taggerTaxonomy = await fetchWorker('/admin/taxonomies', {
      method: 'POST',
      body: form({ name: 'Topics', slug: 'topics' }),
      headers: { Cookie: await authCookie('tagger') },
    });
    expect(taggerTaxonomy.status).toBe(403);

    const taxerTaxonomy = await fetchWorker('/admin/taxonomies', {
      method: 'POST',
      body: form({ name: 'Topics', slug: 'topics' }),
      headers: { Cookie: await authCookie('taxer') },
    });
    expect(taxerTaxonomy.status).toBe(302);

    const taxerTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'T2', slug: 't2', taxonomy_slug: 'categories' }),
      headers: { Cookie: await authCookie('taxer') },
    });
    expect(taxerTag.status).toBe(403);
  });

  it('requires content:read for draft page lookup APIs', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('tagger', 'Tagger').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('tagger', 'tag:write').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/api/pages/default', {
      headers: { Cookie: await authCookie('tagger') },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('insufficient-permissions');
    expect(await response.json()).toEqual({ success: false, error: 'Insufficient permissions' });
  });

  it('requires content:read for draft page lists and search', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('tagger', 'Tagger').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('tagger', 'tag:write').run();
    clearRolePermissionsCache();

    const cookie = await authCookie('tagger');
    const [pages, search, trash, tags] = await Promise.all([
      fetchWorker('/admin/pages/list', { headers: { Cookie: cookie } }),
      fetchWorker('/admin/advanced-search', { headers: { Cookie: cookie } }),
      fetchWorker('/admin/trash', { headers: { Cookie: cookie } }),
      fetchWorker('/admin/tags', { headers: { Cookie: cookie } }),
    ]);

    expect(pages.status).toBe(403);
    expect(search.status).toBe(403);
    expect(trash.status).toBe(403);
    expect(tags.status).toBe(200);
  });

  it('prevents a delegated user manager from assigning itself a more privileged role', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('user-manager', 'User Manager').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('user-manager', 'users:manage').run();
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(3, 'eventuai:manager', 'manager@example.com', 'Manager', '', 'user-manager').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/users/3', {
      method: 'POST',
      body: form({ roles: 'admin' }),
      headers: { Cookie: `access_token=${await signTestToken({ sub: '3', email: 'manager@example.com', role: 'user-manager' })}` },
    });

    expect(response.status).toBe(403);
    const user = await env.DB.prepare('SELECT role FROM users WHERE id = 3').first<{ role: string }>();
    expect(user?.role).toBe('user-manager');
  });

  it('prevents a delegated role manager from granting permissions it does not hold', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('role-manager', 'Role Manager').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('role-manager', 'roles:manage').run();
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(3, 'eventuai:role-manager', 'roles@example.com', 'Role Manager', '', 'role-manager').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/roles/role-manager', {
      method: 'POST',
      body: form({ permissions: 'users:manage' }),
      headers: { Cookie: `access_token=${await signTestToken({ sub: '3', email: 'roles@example.com', role: 'role-manager' })}` },
    });

    expect(response.status).toBe(403);
    const grants = await env.DB.prepare('SELECT permission FROM role_permissions WHERE role = ?')
      .bind('role-manager').all<{ permission: string }>();
    expect(grants.results.map((row) => row.permission)).toEqual(['roles:manage']);
  });

  it('requires content permissions and an existing page for sync and presence', async () => {
    const readPresence = await fetchWorker('/admin/api/presence/999999', {
      headers: { Cookie: await authCookie() },
    });
    expect(readPresence.status).toBe(404);
    expect(await readPresence.json()).toEqual({ error: 'page_not_found' });

    const moderatorReadPresence = await fetchWorker('/admin/api/presence/101', {
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(moderatorReadPresence.status).toBe(200);

    const writePresence = await fetchWorker('/admin/api/presence/101', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { Cookie: await authCookie('moderator'), 'Content-Type': 'application/json' },
    });
    expect(writePresence.status).toBe(403);
    expect(writePresence.headers.get('X-CMS-Error')).toBe('insufficient-permissions');

    const sync = await fetchWorker('/admin/api/sync/999999', {
      headers: { Cookie: await authCookie(), Upgrade: 'websocket' },
    });
    expect(sync.status).toBe(404);
    expect(await sync.text()).toBe('Page not found');
  });

  it('allows HTTPS plugin URLs and only localhost for HTTP plugin URLs', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();

    const localhost = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Local', url: 'http://localhost:8787', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(localhost.status).toBe(302);

    const loopbackIp = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Loopback', url: 'http://127.0.0.1:8787', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(loopbackIp.status).toBe(200);
    expect(await loopbackIp.text()).toContain('URL must be HTTPS (http is allowed only for localhost).');

    const https = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Remote', url: 'https://plugins.example.com', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(https.status).toBe(302);
  });
});

describe('permission-aware admin UI', () => {
  it('shows Users/Roles/System nav links only to users who can manage them', async () => {
    const adminPayload = renderPayload(await (await fetchWorker('/admin', { headers: { Cookie: await authCookie() } })).text());
    expect(adminPayload.layoutData.canManageUsers).toBe(true);
    expect(adminPayload.layoutData.canManageRoles).toBe(true);
    expect(adminPayload.layoutData.canManageMenu).toBe(true);
    expect(adminPayload.layoutData.userRoleItems).toEqual([
      { label: 'admin', labelKey: 'roles.names.admin' },
    ]);
    expect(adminPayload.layoutData.sidebarSettingsNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Users & Credits' }),
      expect.objectContaining({ label: 'Roles' }),
      expect.objectContaining({ label: 'Credit Summary', href: '/admin/settings/credits' }),
      expect.objectContaining({ label: 'System' }),
    ]));

    const editorPayload = renderPayload(await (await fetchWorker('/admin', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(editorPayload.layoutData.canManageUsers).toBe(false);
    expect(editorPayload.layoutData.canManageRoles).toBe(false);
    expect(editorPayload.layoutData.canManageMenu).toBe(false);
    // The credit summary is a read-only view open to every admin user, so an
    // editor still sees its nav link even without plugin:manage.
    expect(editorPayload.layoutData.sidebarSettingsNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Credit Summary', href: '/admin/settings/credits' }),
    ]));
    expect(editorPayload.layoutData.sidebarSettingsNav).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'System' }),
    ]));
  });

  it('persists system branding, sidebar visibility, and weight settings', async () => {
    const response = await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: new URLSearchParams([
        ['app_name', 'Control Room'],
        ['app_icon', 'settings'],
        ['admin_home_path', '/admin/plugins/events/dashboard'],
        ['system_timezone', '+0800'],
        ['visible_items', 'pages'],
        ['visible_items', 'trash'],
        ['weight_pages', '50'],
        ['weight_trash', '5'],
      ]),
      headers: { Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const redirectedHome = await fetchWorker('/admin', { headers: { Cookie: await authCookie() } });
    expect(redirectedHome.status).toBe(302);
    expect(redirectedHome.headers.get('Location')).toBe('/admin/plugins/events/dashboard');

    const dashboardPayload = renderPayload(await (await fetchWorker('/admin?pagesize=100', { headers: { Cookie: await authCookie() } })).text());
    const pageTypeDashboard = renderPayload(await (await fetchWorker('/admin/pages/list/default', { headers: { Cookie: await authCookie() } })).text());
    expect(dashboardPayload.layoutData.showSidebarPages).toBe(true);
    expect(dashboardPayload.layoutData.showSidebarTrash).toBe(true);
    expect(dashboardPayload.layoutData.showSidebarTags).toBe(false);
    expect(dashboardPayload.layoutData.showSidebarUsers).toBe(false);
    expect(dashboardPayload.layoutData.showSidebarMenu).toBe(true);
    expect(dashboardPayload.layoutData.siteTitle).toBe('Control Room');
    expect(pageTypeDashboard.layoutData.siteTitle).toBe('Control Room');
    expect(dashboardPayload.layoutData.appIcon).toBe('settings');
    expect(dashboardPayload.layoutData.systemTimezone).toBe('+0800');
    expect((dashboardPayload.layoutData.sidebarNav as Array<{ label: string }>).map((item) => item.label)).toEqual([
      'Trash',
      'Settings',
      'Pages',
    ]);

    const loginPayload = renderPayload(await (await fetchWorker('/auth/login')).text());
    expect(loginPayload.layoutData.siteTitle).toBe('Control Room');
    expect(loginPayload.layoutData.appIcon).toBe('settings');
    expect(loginPayload.bodyView?.data.siteTitle).toBe('Control Room');
    expect(loginPayload.bodyView?.data.appIcon).toBe('settings');

    const settingsData = bodyData(await (await fetchWorker('/admin/settings/system', { headers: { Cookie: await authCookie() } })).text());
    expect(settingsData.appName).toBe('Control Room');
    expect(settingsData.appIcon).toBe('settings');
    expect(settingsData.adminHomePath).toBe('/admin/plugins/events/dashboard');
    expect(settingsData.systemTimezone).toBe('+0800');
    expect(settingsData.timezoneOptions).toEqual(expect.arrayContaining([
      { value: '+0800', label: 'UTC+08:00 (+0800)', selected: true },
      expect.objectContaining({ value: '+0000', selected: false }),
    ]));
    expect(settingsData.iconOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'settings', selected: true }),
      expect.objectContaining({ value: 'calendar' }),
      expect.objectContaining({ value: 'contact-card' }),
      expect.objectContaining({ value: 'mail-check' }),
    ]));
    expect(settingsData.iconOptions).toHaveLength(48);
    expect(settingsData.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'pages', checked: true, weight: 50 }),
      expect.objectContaining({ value: 'tags', checked: false }),
      expect.objectContaining({ value: 'system', checked: true, locked: true }),
      expect.objectContaining({ value: 'trash', checked: true, weight: 5 }),
    ]));
    expect((settingsData.mainSidebarOptions as Array<{ labelKey: string; weightName: string }>).map((option) => option.weightName)).toEqual([
      'weight_trash',
      'weight_tags',
      'settings_group_weight',
      'weight_pages',
    ]);
  });

  it('falls back to the page dashboard for unsafe admin home paths', async () => {
    const response = await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: form({ admin_home_path: 'https://evil.example/admin' }),
      headers: { Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const settingsData = bodyData(await (await fetchWorker('/admin/settings/system', { headers: { Cookie: await authCookie() } })).text());
    expect(settingsData.adminHomePath).toBe('/admin');

    const dashboard = await fetchWorker('/admin', { headers: { Cookie: await authCookie() } });
    expect(dashboard.status).toBe(200);
  });

  it('rejects an invalid system timezone without replacing the saved value', async () => {
    const response = await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: form({ system_timezone: 'Not/A_Timezone' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/settings/system?error=invalid-timezone');
    const data = bodyData(await (await fetchWorker('/admin/settings/system', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect(data.systemTimezone).toBe('+0000');
  });

  it('requires menu:manage for the system settings page', async () => {
    expect((await fetchWorker('/admin/settings/system', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
    expect((await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: form({ visible_items: 'pages' }),
      headers: { Cookie: await authCookie('editor') },
    })).status).toBe(403);
  });

  it('lists bucket media with links to the draft pages that reference it', async () => {
    const linkedKey = 'content-list-test/linked-image.png';
    const orphanedKey = 'content-list-test/orphaned-image.png';
    await env.MEDIA_BUCKET.put(linkedKey, pngBytes());
    await env.MEDIA_BUCKET.put(orphanedKey, pngBytes());
    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?')
      .bind(JSON.stringify({ image: { en: `/media/${linkedKey}` } }), 101)
      .run();

    try {
      const response = await fetchWorker('/admin/settings/content', { headers: { Cookie: await authCookie() } });
      const data = bodyData(await response.text());
      const media = data.media as Array<{
        key: string;
        linkedPageCount: number;
        linkedPages: Array<{ name: string; editHref: string }>;
      }>;

      expect(response.status).toBe(200);
      expect(media).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: linkedKey,
          linkedPageCount: 1,
          linkedPages: [expect.objectContaining({ name: 'About', editHref: '/admin/pages/101/edit' })],
        }),
        expect.objectContaining({ key: orphanedKey, linkedPageCount: 0, linkedPages: [] }),
      ]));
    } finally {
      await env.MEDIA_BUCKET.delete([linkedKey, orphanedKey]);
    }
  });

  it('paginates the content list with the bucket cursor', async () => {
    const keys = Array.from({ length: 51 }, (_, index) => `content-list-page-test/${String(index).padStart(3, '0')}.png`);
    await Promise.all(keys.map((key) => env.MEDIA_BUCKET.put(key, pngBytes())));

    try {
      const first = bodyData(await (await fetchWorker('/admin/settings/content', { headers: { Cookie: await authCookie() } })).text());
      expect(first.hasNextPage).toBe(true);
      expect(first.nextHref).toMatch(/^\/admin\/settings\/content\?cursor=/);

      const next = bodyData(await (await fetchWorker(String(first.nextHref), { headers: { Cookie: await authCookie() } })).text());
      expect(next.media).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: keys[50] }),
      ]));
    } finally {
      await env.MEDIA_BUCKET.delete(keys);
    }
  });

  it('deletes a media file from the bucket and its metadata record', async () => {
    const key = 'content-list-delete-test/remove-me.png';
    await env.MEDIA_BUCKET.put(key, pngBytes());
    await env.DB.prepare('INSERT INTO media_files (key, url, filename, content_type, size) VALUES (?, ?, ?, ?, ?)')
      .bind(key, `/media/${key}`, 'remove-me.png', 'image/png', 10)
      .run();

    const response = await fetchWorker('/admin/settings/content/delete', {
      method: 'POST',
      body: form({ key }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/settings/content');
    expect(await env.MEDIA_BUCKET.get(key)).toBeNull();
    expect(await env.DB.prepare('SELECT key FROM media_files WHERE key = ?').bind(key).first()).toBeNull();
  });

  it('requires menu:manage for the content list', async () => {
    expect((await fetchWorker('/admin/settings/content', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
    expect((await fetchWorker('/admin/settings/content/delete', {
      method: 'POST',
      body: form({ key: 'anything.png' }),
      headers: { Cookie: await authCookie('editor') },
    })).status).toBe(403);
  });

  it('renders page types read-only for users without pagetype:write', async () => {
    // Editors lack pagetype:write.
    const list = bodyData(await (await fetchWorker('/admin/page_types', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(list.canWrite).toBe(false);
    expect(list.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ editHref: '/admin/page_types/700/edit' }),
    ]));

    // The "new" form is not reachable.
    const newForm = await fetchWorker('/admin/page_types/new', { headers: { Cookie: await authCookie('editor') } });
    expect(newForm.status).toBe(302);
    expect(newForm.headers.get('Location')).toBe('/admin/page_types');

    // The edit route renders read-only (no Save button).
    const editForm = bodyData(await (await fetchWorker('/admin/page_types/700/edit', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(editForm.readOnly).toBe(true);
  });

  it('keeps page types editable for admins', async () => {
    const list = bodyData(await (await fetchWorker('/admin/page_types', { headers: { Cookie: await authCookie() } })).text());
    expect(list.canWrite).toBe(true);
    const editForm = bodyData(await (await fetchWorker('/admin/page_types/700/edit', { headers: { Cookie: await authCookie() } })).text());
    expect(editForm.readOnly).toBe(false);
  });
});

describe('draft page slug uniqueness on save', () => {
  async function createPage(name: string, slug: string): Promise<void> {
    await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name, slug, page_type: 'default', weight: '5' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
  }

  it('appends a numeric suffix when the slug already exists', async () => {
    // seedBaseData already created a page with slug 'about'.
    await createPage('About Two', 'about');
    await createPage('About Three', 'about');

    const slugs = await env.DB.prepare("SELECT slug FROM pages WHERE slug LIKE 'about%' ORDER BY slug ASC")
      .all<{ slug: string }>();
    expect(slugs.results.map((row) => row.slug)).toEqual(['about', 'about-2', 'about-3']);
  });

  it('keeps a page\'s own slug unchanged on update', async () => {
    const response = await fetchWorker('/admin/pages/101', {
      method: 'POST',
      body: form({ name: 'About Renamed', slug: 'about', page_type: 'default', weight: '5' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);
    const row = await env.DB.prepare('SELECT slug FROM pages WHERE id = ?')
      .bind(101)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('about');
  });
});

describe('page type block/taxonomy multi-select', () => {
  it('preserves underscores in page and block type slugs on create and update', async () => {
    const pageResponse = await fetchWorker('/admin/page_types', {
      method: 'POST',
      body: form({ name: 'RSVP Response', slug: 'RSVP_Response', blueprint: '["name"]' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(pageResponse.status).toBe(302);

    const page = await env.DB.prepare('SELECT id, slug FROM page_types WHERE name = ?')
      .bind('RSVP Response')
      .first<{ id: number; slug: string }>();
    expect(page).toEqual({ id: expect.any(Number), slug: 'rsvp_response' });

    const updateResponse = await fetchWorker(`/admin/page_types/${page!.id}`, {
      method: 'POST',
      body: form({ name: 'RSVP Response', slug: 'RSVP_Response_V2', blueprint: '["name"]' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(updateResponse.status).toBe(302);
    await expect(env.DB.prepare('SELECT slug FROM page_types WHERE id = ?').bind(page!.id).first())
      .resolves.toEqual({ slug: 'rsvp_response_v2' });

    const blockResponse = await fetchWorker('/admin/block_types', {
      method: 'POST',
      body: form({ name: 'Mail Preview', slug: 'mail_preview', blueprint: '["subject"]' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(blockResponse.status).toBe(302);
    await expect(env.DB.prepare('SELECT slug FROM block_types WHERE name = ?').bind('Mail Preview').first())
      .resolves.toEqual({ slug: 'mail_preview' });
  });

  it('stores checked blocks and taxonomies as JSON arrays', async () => {
    // seedBaseData provides config blocks (logos, paragraphs) and taxonomy 'categories'.
    const body = new URLSearchParams([
      ['name', 'Landing'],
      ['slug', 'landing'],
      ['weight', '5'],
      ['blueprint', '["name"]'],
      ['block_lists', 'logos'],
      ['block_lists', 'paragraphs'],
      ['taxonomy_lists', 'categories'],
    ]);
    const response = await fetchWorker('/admin/page_types', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const row = await env.DB.prepare('SELECT block_lists, taxonomy_lists FROM page_types WHERE slug = ?')
      .bind('landing')
      .first<{ block_lists: string; taxonomy_lists: string }>();
    expect(JSON.parse(row!.block_lists)).toEqual(['logos', 'paragraphs']);
    expect(JSON.parse(row!.taxonomy_lists)).toEqual(['categories']);

    const editData = bodyData(await (await fetchWorker(
      `/admin/page_types/${(await env.DB.prepare('SELECT id FROM page_types WHERE slug = ?').bind('landing').first<{ id: number }>())!.id}/edit`,
      { headers: { Cookie: await authCookie() } },
    )).text());
    // The stored selections render as checked checkboxes.
    expect(editData.blockOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'logos', checked: true }),
    ]));
    expect(editData.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'categories', checked: true }),
    ]));
  });
});

describe('database page type with a scalar @name field', () => {
  it('renders the scalar name field instead of [object Object] when the lect drifted to a localized value', async () => {
    await env.DB.prepare('INSERT INTO page_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
      .bind(900, 'menu', 'Menu', JSON.stringify(['@name', { links: ['label', 'url'] }]))
      .run();
    clearConfigCache(); // the row was inserted directly, bypassing the admin route's cache bust

    // Simulates the editor form being rendered for one blueprint (localized `.name|en`)
    // while the page_type is submitted as `menu` (which declares a scalar `@name`).
    await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Main Menu', slug: 'main-menu', page_type: 'menu', weight: '5', '.name|en': 'Main Menu', '.links[0].label|en': 'Home', '.links[0].url|en': '/home' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    const row = await env.DB.prepare('SELECT id FROM pages WHERE slug = ?')
      .bind('main-menu')
      .first<{ id: number }>();

    const editData = bodyData(await (await fetchWorker(`/admin/pages/${row!.id}/edit`, {
      headers: { Cookie: await authCookie() },
    })).text());
    const structuredModel = editData.structuredModel as { settingsFields: Array<{ inputName: string; value: string }> };
    expect(structuredModel.settingsFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputName: '@name', value: 'Main Menu' }),
    ]));
    expect(JSON.stringify(editData)).not.toContain('[object Object]');
  });
});

describe('structured editor weights', () => {
  it('provides drag handles that reorder root and block item weights before saving', async () => {
    const response = await env.VIEWS.fetch('https://views.local/assets/client-render.js');
    expect(response.ok).toBe(true);
    const source = await response.text();
    const item = await (await env.VIEWS.fetch('https://views.local/snippets/structured-item.liquid')).text();

    expect(source).toContain('data-weight-sortable');
    expect(source).toContain('data-weight-sortable-handle');
    expect(source).toContain('data-weight-sortable-row');
    expect(item).toContain('data-weight-sortable-input');
    expect(source).toContain('function syncWeights(scope)');
    expect(source).toContain("input.value = String(index)");
  });

  it('renders item and block weights as compact header controls', async () => {
    const lect = JSON.parse(basePageLect) as Record<string, unknown>;
    const items = lect.items as Array<Record<string, unknown>>;
    items[0]._weight = 4;
    lect._blocks = [{ _type: 'label', _weight: 7, subject: { en: 'Featured' } }];
    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?')
      .bind(JSON.stringify(lect), 101)
      .run();

    const singleItemData = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    let structuredModel = singleItemData.structuredModel as {
      itemGroups: Array<{ rows: Array<{ deleteAction: string; showDelete: boolean }> }>;
    };
    expect(structuredModel.itemGroups[0].rows[0]).toMatchObject({ deleteAction: 'item-delete:items|0', showDelete: false });

    items.push({ _weight: 8, name: { en: 'Second item' } });
    await env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?')
      .bind(JSON.stringify(lect), 101)
      .run();

    const editData = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    structuredModel = editData.structuredModel as {
      itemGroups: Array<{ rows: Array<{ weightInputName: string; weight: number; deleteAction: string; showDelete: boolean }> }>;
      blocks: Array<{ weightInputName: string; weight: number; deleteAction: string }>;
    };
    expect(structuredModel.itemGroups[0].rows).toEqual([
      expect.objectContaining({ weightInputName: '.items[0]@_weight', weight: 4, deleteAction: 'item-delete:items|0', showDelete: true }),
      expect.objectContaining({ weightInputName: '.items[1]@_weight', weight: 8, deleteAction: 'item-delete:items|1', showDelete: true }),
    ]);
    expect(structuredModel.blocks).toEqual([
      expect.objectContaining({ weightInputName: '#0@_weight', weight: 7, deleteAction: 'block-delete:0' }),
    ]);
  });
});

describe('Lect JSON version diff', () => {
  it('shows version timestamps in the CMS default timezone', async () => {
    const changed = stringifyLect({ ...basePageLectObject, name: localizedFixture('About TZ') });
    await env.DB.prepare(
      `INSERT INTO page_versions (id, created_at, updated_at, page_id, lect, action)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(502, '2026-01-01 23:15:00', '2026-01-01 23:15:00', 101, changed, 'update')
      .run();

    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit?version=502', {
      headers: { Cookie: await authCookie() },
    })).text());

    expect(data.selectedVersion).toMatchObject({ date: '2026-01-02 07:15:00 +0800' });
    expect(data.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: '2026-01-02 07:15:00 +0800' }),
    ]));
  });

  it('shows a colour-coded diff against the current draft when previewing a version', async () => {
    // A second version of page 101 whose lect differs from the current draft.
    const changed = stringifyLect({ ...basePageLectObject, name: localizedFixture('About — REVISED') });
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(502, 101, changed, 'update').run();

    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit?version=502', {
      headers: { Cookie: await authCookie() },
    })).text());

    // The raw-metadata panel renders the diff instead of the editable textarea.
    expect(data.hasLectDiff).toBe(true);
    expect(data.lectDiffHtml).toContain('bg-emerald-50');    // a line only in this version
    expect(data.lectDiffHtml).toContain('bg-rose-50');        // a line only in the current draft
    expect(data.lectDiffHtml).toContain('About — REVISED');   // the version's value, highlighted
  });

  it('keeps the editable Lect JSON textarea when not previewing a version', async () => {
    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect(data.hasLectDiff).toBe(false);
    expect((data.page as { lect: string }).lect).toContain('"name"');
  });
});

describe('Add-block picker scope', () => {
  it('offers every block type when the page type defines no block list', async () => {
    // Page type 'event' (seeded type 700) has no block list of its own.
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(105, 'page-uuid-105', 'Gala', 'gala', 5, 'event', stringifyLect({ _type: 'event' }), 1, '1').run();

    const data = bodyData(await (await fetchWorker('/admin/pages/105/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    // 'hero' is a database block type, absent from the config default list — it
    // appears only because the 'event' type falls back to every block type.
    expect((data.structuredModel as { blockOptions: Array<{ value: string }> }).blockOptions).toEqual(expect.arrayContaining([
      { value: 'hero' },
    ]));
  });

  it("limits the picker to the page type's own block list when it defines one", async () => {
    // Page type 'default' has a config block list (default/label/logos/paragraphs), no 'hero'.
    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect((data.structuredModel as { blockOptions: Array<{ value: string }> }).blockOptions).not.toEqual(expect.arrayContaining([
      { value: 'hero' },
    ]));
  });
});

async function expectRoute(route: RouteCase): Promise<Response> {
  const headers = new Headers(route.headers);
  if (route.authenticated) headers.set('Cookie', await authCookie());
  const response = await fetchWorker(route.path, {
    method: route.method,
    body: route.body,
    headers,
  });

  expect(response.status).toBe(route.expectedStatus);
  if (route.location) {
    const location = response.headers.get('Location');
    if (typeof route.location === 'string') expect(location).toBe(route.location);
    else expect(location).toMatch(route.location);
  }
  if (route.json !== undefined) {
    expect(await response.json()).toEqual(route.json);
  }
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  return response;
}

async function fetchWorker(
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const host = init.host ?? 'http://localhost';
  // Real browsers always send Sec-Fetch-Site; mirror that so the fail-closed
  // cross-site check sees a same-origin signal unless a test overrides it.
  const headers = new Headers(init.headers);
  if (!headers.has('Sec-Fetch-Site') && !headers.has('Origin')) {
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  // Unique client IP per request so the (real, miniflare-simulated) rate
  // limiter never throttles unrelated tests.
  if (!headers.has('CF-Connecting-IP')) {
    ipCounter += 1;
    headers.set('CF-Connecting-IP', `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  }
  const request = new IncomingRequest(new URL(path, host), {
    redirect: 'manual',
    ...init,
    headers,
  });
  return worker.fetch(request);
}

async function authCookie(role = 'admin'): Promise<string> {
  return `access_token=${await signTestToken({ role })}`;
}

async function signTestToken(overrides: Partial<JWTPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
    ...overrides,
  }, env.JWT_SECRET);
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

/** 10 bytes: the PNG signature plus two filler bytes. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
}

/** A complete 1×1 PNG for tests that exercise the Images decoder. */
function decodablePngBytes(): Uint8Array {
  const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cookieValue(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? '';
}

async function signedIdToken(payload: Record<string, unknown>, key: CryptoKey, kid: string): Promise<string> {
  const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(payload)}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  const encodedSignature = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${encodedSignature}`;
}

async function appleCallback(overrides: Record<string, unknown>, corruptSignature = false): Promise<Response> {
  const start = await fetchWorker('/auth/start?provider=apple');
  const location = new URL(start.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');
  const keyPair = await appleKeyPair;
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  let idToken = await signedIdToken({
    iss: 'https://appleid.apple.com',
    aud: 'test.apple.client',
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: state,
    sub: `apple-negative-${crypto.randomUUID()}`,
    email: 'apple-negative@example.com',
    ...overrides,
  }, keyPair.privateKey, 'test-apple-key');
  if (corruptSignature) {
    const [header, claims, signature] = idToken.split('.');
    idToken = `${header}.${claims}.${'A'.repeat(signature.length)}`;
  }

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === 'https://appleid.apple.com/auth/token') return Response.json({ id_token: idToken });
    if (url === 'https://appleid.apple.com/auth/keys') {
      return Response.json({ keys: [{ ...publicJwk, kid: 'test-apple-key', alg: 'RS256', use: 'sig' }] });
    }
    return new Response('Unexpected fetch', { status: 500 });
  }));

  return fetchWorker('/auth/callback', {
    method: 'POST',
    headers: {
      Cookie: `oauth_state=${stateCookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'cross-site',
    },
    body: form({ code: 'abc', state }),
  });
}

/** Runs the full PKCE flow against a mocked eventuai provider and returns the callback response. */
async function completeMockedOAuthLogin(): Promise<Response> {
  const start = await fetchWorker('/auth/start?provider=eventuai');
  const location = new URL(start.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === 'https://id.eventuai.com/oauth/token') {
      return Response.json({ access_token: 'provider-token' });
    }
    if (url === 'https://id.eventuai.com/oauth/userinfo') {
      return Response.json({
        sub: 'eventuai-user',
        email: 'eventuai@example.com',
        preferred_username: 'Eventuai User',
        roles: ['editor'],
      });
    }
    return new Response('Unexpected fetch', { status: 500 });
  }));

  return fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: `oauth_state=${stateCookie}` },
  });
}

async function resetData(): Promise<void> {
  const adminTables = [
    'page_tags',
    'trash_page_tags',
    'page_versions',
    'media_files',
    'pages',
    'trash_pages',
    'tags',
    'taxonomies',
    'page_types',
    'block_types',
    'settings',
    'roles',
    'role_permissions',
    'sessions',
    'user_oauth_identities',
    'users',
    'audit_log',
  ];
  for (const table of adminTables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  const publishedTables = [
    'page_tags',
    'pages',
  ];
  for (const table of publishedTables) {
    await env.PUBLISHED_DB.prepare(`DELETE FROM ${table}`).run();
  }
}

async function seedBaseData(): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin')
    .run();
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor')
    .run();
  // A custom role for the roles-admin route tests.
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)')
    .bind('authors', 'Authors')
    .run();

  await env.DB.prepare('INSERT INTO taxonomies (id, name, slug) VALUES (?, ?, ?)')
    .bind(300, 'Categories', 'categories')
    .run();

  await env.DB.prepare('INSERT INTO page_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
    .bind(700, 'event', 'Event', JSON.stringify(['@date', 'name', 'venue']))
    .run();
  await env.DB.prepare('INSERT INTO block_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
    .bind(800, 'hero', 'Hero', JSON.stringify(['label', { pictures: ['url'] }]))
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, taxonomy_slug, lect) VALUES (?, ?, ?, ?, ?)')
    .bind(301, 'News', 'news', 'categories', JSON.stringify({ name: { en: 'News' } }))
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, taxonomy_slug, lect) VALUES (?, ?, ?, ?, ?)')
    .bind(302, 'Updates', 'updates', 'categories', JSON.stringify({ name: { en: 'Updates' } }))
    .run();

  await env.DB.prepare(
    `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(101, 'page-uuid-101', 'About', 'about', 5, 'default', basePageLect, 1, '1')
    .run();
  await env.DB.prepare(
    'INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)',
  )
    .bind(501, 101, basePageLect, 'create')
    .run();
  await env.PUBLISHED_DB.prepare(
    `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(102, 'page-uuid-101', 'About', 'about', 5, 'default', basePageLect, 1, '1')
    .run();
  await env.DB.prepare(
    `INSERT INTO trash_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(201, 'trash-uuid-201', 'Old Page', 'old-page', 5, 'default', basePageLect, 1, '1')
    .run();
  await env.DB.prepare('INSERT INTO page_tags (id, page_id, tag_id) VALUES (?, ?, ?)')
    .bind(401, 101, 302)
    .run();
}

async function seedDraftPages(pageType: string, count: number, idStart: number, namePrefix: string): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const padded = String(index).padStart(3, '0');
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        idStart + index,
        `${pageType}-bulk-uuid-${padded}`,
        `${namePrefix} ${padded}`,
        `${pageType}-bulk-${padded}`,
        10,
        pageType,
        basePageLect,
        1,
        '1',
      )
      .run();
  }
}
