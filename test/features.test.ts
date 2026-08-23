// Coverage for features advertised in the 0xCMS feature list
// (0xcms/www/features.html) that had no dedicated test yet:
//
//   §01 weak-secret guard, PKCE /auth/start, login provider order,
//       first-login role provisioning
//   §02 admin-role anti-lockout in the roles admin
//   §03 scheduling window & timezone on save
//   §04 server-side validation (422)
//   §05 version revert
//   §13 trash browser counters + scoped empty-trash
//   §14 plugin URL SSRF guard
//   §16 custom 404 page from the views layer

import { env, exports } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import cmsWorker from '../src/index';
import { cmsConfig } from '../src/cms-config';
import { signJWT } from '../src/core/auth/jwt';
import { blueprintToLect, stringifyLect } from '../src/core/db/lect';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

interface RenderPayload {
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

function localizedFixture(base: string): Record<string, string> {
  return Object.fromEntries(cmsConfig.languages.map((language) => [
    language,
    language === cmsConfig.defaultLanguage ? base : `${base} ${language}`,
  ]));
}

/** A default-blueprint lect whose name is localized from `base`. */
function lectWithName(base: string): string {
  const lect = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
  lect.name = localizedFixture(base);
  return stringifyLect(lect);
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  clearRolePermissionsCache();
  await resetData();
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin')
    .run();
});

// ── §01/§17 · Weak-secret guard ───────────────────────────────────────────────

describe('weak JWT secret guard', () => {
  it('refuses to serve outside localhost when JWT_SECRET is missing or short', async () => {
    const ctx = createExecutionContext();
    const weakEnv = { ...env, JWT_SECRET: 'short' };

    const response = await cmsWorker.fetch(
      new IncomingRequest('https://cms.example.com/auth/login'),
      weakEnv,
      ctx,
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Server misconfigured');
    // The refusal still ships the hardening + no-store headers.
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const missing = await cmsWorker.fetch(
      new IncomingRequest('https://cms.example.com/auth/login'),
      { ...env, JWT_SECRET: '' },
      createExecutionContext(),
    );
    expect(missing.status).toBe(500);
  });

  it('still serves localhost so local development is not blocked', async () => {
    const response = await cmsWorker.fetch(
      new IncomingRequest('http://localhost/auth/login'),
      { ...env, JWT_SECRET: 'short' },
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
  });
});

// ── §01 · OAuth 2.1 PKCE start ────────────────────────────────────────────────

describe('OAuth 2.1 PKCE start', () => {
  it('redirects with an S256 code challenge derived from the verifier in the state cookie', async () => {
    const start = await fetchWorker('/auth/start?provider=eventuai');
    expect(start.status).toBe(302);

    const location = new URL(start.headers.get('Location') ?? '');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('response_type')).toBe('code');
    const challenge = location.searchParams.get('code_challenge') ?? '';
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The verifier rides in the signed oauth_state JWT cookie; hashing it must
    // reproduce the challenge sent to the provider (RFC 7636 S256).
    const setCookie = start.headers.get('Set-Cookie') ?? '';
    const stateCookie = cookieValue(setCookie, 'oauth_state');
    const payload = decodeJwtPayload(stateCookie);
    expect(payload.type).toBe('oauth_state');
    expect(payload.provider).toBe('eventuai');
    expect(payload.state).toBe(location.searchParams.get('state'));

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(payload.code_verifier)),
    );
    expect(base64url(digest)).toBe(challenge);

    // Short-lived, HttpOnly state cookie — no server-side session store.
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax'); // http://localhost is not secure
  });

  it('uses a __Host- prefixed SameSite=None state cookie on secure origins', async () => {
    const start = await fetchWorker('/auth/start?provider=eventuai', {
      host: 'https://cms.example.com',
    });

    const setCookie = start.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('__Host-oauth_state=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Max-Age=600');
  });
});

// ── §01 · Login page providers ────────────────────────────────────────────────

describe('login page providers', () => {
  it('shows one button per provider in ENABLED_PROVIDERS order', async () => {
    // Test env: ENABLED_PROVIDERS = eventuai,github,google,microsoft,apple
    const html = await (await fetchWorker('/auth/login')).text();

    const positions = ['eventuai', 'github', 'google', 'microsoft', 'apple']
      .map((provider) => html.indexOf(`/auth/start?provider=${provider}`));

    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// ── §01 · First-login role provisioning ───────────────────────────────────────

describe('first-login role provisioning', () => {
  it('defaults new accounts to viewer and never overwrites it on later logins', async () => {
    const first = await completeMockedLogin({
      sub: 'newbie',
      email: 'newbie@example.com',
      preferred_username: 'Newbie',
      roles: ['admin'],
    });
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe('/admin');

    const created = await env.DB.prepare(
      "SELECT role, name FROM users WHERE oauth_id = 'eventuai:newbie'",
    ).first<{ role: string; name: string }>();
    expect(created).toMatchObject({ role: 'viewer', name: 'Newbie' });

    // An admin promotes the user in the Users admin…
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE oauth_id = 'eventuai:newbie'").run();

    // …and a later login refreshes profile fields but keeps the CMS role,
    // even though the IdP now reports a weaker role.
    const second = await completeMockedLogin({
      sub: 'newbie',
      email: 'newbie@example.com',
      preferred_username: 'Newbie Renamed',
      roles: ['viewer'],
    });
    expect(second.status).toBe(302);

    const after = await env.DB.prepare(
      "SELECT role, name FROM users WHERE oauth_id = 'eventuai:newbie'",
    ).first<{ role: string; name: string }>();
    expect(after).toMatchObject({ role: 'admin', name: 'Newbie Renamed' });
  });
});

// ── §02 · Roles admin anti-lockout ────────────────────────────────────────────

describe('roles admin anti-lockout', () => {
  it('shows the admin role as locked in the edit form', async () => {
    const response = await fetchWorker('/admin/roles/admin/edit', {
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(200);
    const data = bodyData(await response.text());
    expect(data.name).toBe('admin');
    expect(data.locked).toBe(true);
  });

  it('rejects any attempt to edit the admin role permission set', async () => {
    const response = await fetchWorker('/admin/roles/admin', {
      method: 'POST',
      body: form({ label: 'Admin', permissions: 'content:read' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('the admin role cannot be edited');
  });
});

// ── §03 · Scheduling window & timezone ────────────────────────────────────────

describe('page scheduling window and timezone', () => {
  it('stores start, end, and timezone on create', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({
        name: 'Scheduled Page',
        slug: 'scheduled-page',
        page_type: 'default',
        start: '2026-07-01T10:00',
        end: '2026-07-02T18:00',
        timezone: 'Asia/Hong_Kong',
      }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT start, end, timezone FROM pages WHERE slug = 'scheduled-page'",
    ).first<{ start: string; end: string; timezone: string }>();
    expect(row).toEqual({
      start: '2026-07-01T10:00',
      end: '2026-07-02T18:00',
      timezone: 'Asia/Hong_Kong',
    });
  });

  it('falls back to DEFAULT_TIMEZONE when no timezone is submitted', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'No TZ', slug: 'no-tz', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT timezone FROM pages WHERE slug = 'no-tz'",
    ).first<{ timezone: string }>();
    expect(row?.timezone).toBe('+0800'); // wrangler.toml DEFAULT_TIMEZONE
  });
});

// ── §04 · Server-side validation ──────────────────────────────────────────────

describe('editor server-side validation', () => {
  it('re-renders the form with 422 and the full error list', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: '', slug: 'Bad Slug!', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(422);
    const data = bodyData(await response.text());
    expect(data.errors).toEqual(expect.arrayContaining([
      'Page name is required.',
      'Slug may only contain lowercase letters, numbers and hyphens.',
    ]));
    // The re-rendered form still posts back to the create endpoint.
    expect(data.action).toBe('/admin/pages');
  });
});

// ── §05 · Version revert ──────────────────────────────────────────────────────

describe('version revert', () => {
  it('rolls the draft back to a prior version and keeps the full history', async () => {
    const lectV1 = lectWithName('Original');
    const lectV2 = lectWithName('Changed');
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(111, 'revert-uuid-111', 'Changed', 'revert-page', 5, 'default', lectV2, 1, '1')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(511, 111, lectV1, 'create')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(512, 111, lectV2, 'update')
      .run();

    const response = await fetchWorker('/admin/pages/111', {
      method: 'POST',
      body: form({ action: 'revert:511', name: 'Changed', slug: 'revert-page' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/111/edit?flash=Version+restored');

    const page = await env.DB.prepare(
      'SELECT lect FROM pages WHERE id = 111',
    ).first<{ lect: string }>();
    const lect = JSON.parse(page?.lect ?? '{}') as { name?: Record<string, string> };
    expect(lect.name?.[cmsConfig.defaultLanguage]).toBe('Original');

    // A restore is an ordinary edit: the two existing snapshots are untouched
    // (so the pre-revert content is still recoverable) and the restore is
    // appended as the newest one.
    const versions = await env.DB.prepare(
      'SELECT id, action, lect FROM page_versions WHERE page_id = 111 ORDER BY id',
    ).all<{ id: number; action: string; lect: string }>();
    expect(versions.results.map(({ id, action }) => ({ id, action }))).toEqual([
      { id: 511, action: 'create' },
      { id: 512, action: 'update' },
      { id: expect.any(Number), action: 'restore' },
    ]);
    // The newest snapshot mirrors the working copy, which is the invariant the
    // editor relies on now that there is no current-version pointer.
    expect(versions.results[2].lect).toBe(page?.lect);
  });

  it('404s a revert to a version belonging to another page', async () => {
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(112, 'revert-uuid-112', 'Other', 'other-page', 5, 'default', lectWithName('Other'), 1, '1')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(513, 112, lectWithName('Other'), 'create')
      .run();
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(113, 'revert-uuid-113', 'Mine', 'mine-page', 5, 'default', lectWithName('Mine'), 1, '1')
      .run();

    const response = await fetchWorker('/admin/pages/113', {
      method: 'POST',
      body: form({ action: 'revert:513', name: 'Mine', slug: 'mine-page' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(404);
  });

  it('removes one saved version without changing the working copy', async () => {
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(114, 'version-delete-uuid-114', 'Changed', 'version-delete-page', 5, 'default', lectWithName('Changed'), 1, '1')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(521, 114, lectWithName('Original'), 'create')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(522, 114, lectWithName('Changed'), 'update')
      .run();

    const editor = await fetchWorker('/admin/pages/114/edit', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await editor.text());
    expect(data.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ removeAction: 'delete-version:522' }),
    ]));
    expect(data).toMatchObject({ hasVersions: true });

    const response = await fetchWorker('/admin/pages/114', {
      method: 'POST',
      body: form({ action: 'delete-version:522', name: 'Changed', slug: 'version-delete-page' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/114/edit?flash=Version+removed');

    // Deleting the newest snapshot must not roll the page back to the older
    // one: `lect` is the working copy, and history is only a backup log.
    const page = await env.DB.prepare(
      'SELECT lect FROM pages WHERE id = 114',
    ).first<{ lect: string }>();
    expect(page?.lect).toBe(lectWithName('Changed'));

    const versions = await env.DB.prepare(
      'SELECT id FROM page_versions WHERE page_id = 114 ORDER BY id',
    ).all<{ id: number }>();
    expect(versions.results).toEqual([{ id: 521 }]);
  });

  it('cleans all saved versions and leaves the working copy intact', async () => {
    await env.DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(115, 'versions-clean-uuid-115', 'Clean Me', 'versions-clean-page', 5, 'default', lectWithName('Clean Me'), 1, '1')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(531, 115, lectWithName('Original'), 'create')
      .run();
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(532, 115, lectWithName('Clean Me'), 'update')
      .run();

    const response = await fetchWorker('/admin/pages/115', {
      method: 'POST',
      body: form({ action: 'delete-versions', name: 'Clean Me', slug: 'versions-clean-page' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/115/edit?flash=Versions+cleaned');

    const page = await env.DB.prepare(
      'SELECT lect FROM pages WHERE id = 115',
    ).first<{ lect: string }>();
    expect(page?.lect).toBe(lectWithName('Clean Me'));

    const versions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM page_versions WHERE page_id = 115',
    ).first<{ count: number }>();
    expect(versions?.count).toBe(0);
  });
});

// ── §13 · Trash browser counters + scoped empty ───────────────────────────────

describe('trash browser and scoped empty', () => {
  async function seedTrash(): Promise<void> {
    // One old default page (trashed 2 hours ago), one fresh default, one fresh event.
    await env.DB.prepare(
      `INSERT INTO trash_pages (id, uuid, created_at, name, slug, page_type, lect)
       VALUES (?, ?, datetime('now', '-2 hours'), ?, ?, ?, ?)`,
    )
      .bind(9001, 'trash-old-default', 'Old Default', 'old-default', 'default', lectWithName('Old Default'))
      .run();
    await env.DB.prepare(
      'INSERT INTO trash_pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(9002, 'trash-new-default', 'New Default', 'new-default', 'default', lectWithName('New Default'))
      .run();
    await env.DB.prepare(
      'INSERT INTO trash_pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(9003, 'trash-new-event', 'New Event', 'new-event', 'event', lectWithName('New Event'))
      .run();
  }

  async function trashCount(): Promise<number> {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages').first<{ total: number }>();
    return row?.total ?? 0;
  }

  it('lists the type breakdown, the last-hour counter, and a per-type filter', async () => {
    await seedTrash();

    const all = await fetchWorker('/admin/trash', { headers: { Cookie: await authCookie() } });
    expect(all.status).toBe(200);
    const data = bodyData(await all.text());
    expect(data.grandTotal).toBe(3);
    expect(data.recentCount).toBe(2);
    expect(data.typeCounts).toEqual(expect.arrayContaining([
      { pageType: 'default', count: 2 },
      { pageType: 'event', count: 1 },
    ]));

    const filtered = await fetchWorker('/admin/trash?type=default', {
      headers: { Cookie: await authCookie() },
    });
    const filteredData = bodyData(await filtered.text());
    expect(filteredData.total).toBe(2);
    // The dropdown breakdown stays global even while a filter is active.
    expect(filteredData.grandTotal).toBe(3);
  });

  it('empties the trash for one page type only', async () => {
    await seedTrash();

    const response = await fetchWorker('/admin/trash/empty', {
      method: 'POST',
      body: form({ type: 'event' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/trash?flash=event+pages+emptied');
    await expect(trashCount()).resolves.toBe(2);
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM trash_pages WHERE page_type = 'event'",
    ).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it('empties only pages trashed within the last hour when scoped', async () => {
    await seedTrash();

    const response = await fetchWorker('/admin/trash/empty', {
      method: 'POST',
      body: form({ action: '1h' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/trash?flash=Trash+from+last+hour+emptied');
    const survivors = await env.DB.prepare('SELECT id FROM trash_pages ORDER BY id').all<{ id: number }>();
    expect(survivors.results).toEqual([{ id: 9001 }]); // only the 2-hour-old row survives
  });
});

// ── §14 · Plugin URL SSRF guard ───────────────────────────────────────────────

describe('plugin URL SSRF guard', () => {
  it.each([
    ['cloud metadata', 'https://169.254.169.254'],
    ['RFC1918 10.x', 'https://10.0.0.5'],
    ['RFC1918 192.168.x', 'https://192.168.1.7'],
    ['RFC1918 172.16-31.x', 'https://172.20.3.4'],
    ['CGNAT 100.64/10', 'https://100.64.9.9'],
    ['.internal suffix', 'https://metadata.internal'],
    ['IPv6 ULA', 'https://[fd00::1]'],
    ['IPv6 loopback', 'https://[::1]'],
    ['decimal IPv4 loopback', 'https://2130706433'],
    ['hexadecimal IPv4 loopback', 'https://0x7f000001'],
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]'],
  ])('rejects a %s plugin URL', async (_label, url) => {
    const response = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Sneaky', url, sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain(
      'URL must not point to a private, loopback, or internal host.',
    );
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM plugins').first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it('accepts a public HTTPS plugin URL', async () => {
    const response = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Remote', url: 'https://plugins.example.com', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
  });
});

// ── §16 · Custom error pages ──────────────────────────────────────────────────

describe('custom error pages', () => {
  it('renders the branded 404 page from the views layer', async () => {
    const response = await fetchWorker('/definitely-not-a-route');

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('Page Not Found');
    expect(html).toContain('0xCMS');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWorker(
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const host = init.host ?? 'http://localhost';
  // Mirror real browsers so the fail-closed cross-origin guard sees a
  // same-origin signal unless a test overrides it.
  const headers = new Headers(init.headers);
  if (!headers.has('Sec-Fetch-Site') && !headers.has('Origin')) {
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  // Unique client IP per request so the rate limiter never throttles tests.
  if (!headers.has('CF-Connecting-IP')) {
    ipCounter += 1;
    headers.set('CF-Connecting-IP', `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  }
  const request = new IncomingRequest(new URL(path, host), {
    redirect: 'manual',
    ...init,
    headers,
  });
  return worker.fetch(request);
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

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function cookieValue(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? '';
}

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

/** Runs the full PKCE flow against a mocked eventuai IdP with the given userinfo. */
async function completeMockedLogin(userinfo: Record<string, unknown>): Promise<Response> {
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
      return Response.json(userinfo);
    }
    return new Response('Unexpected fetch', { status: 500 });
  }));
  try {
    return await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `oauth_state=${stateCookie}` },
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

async function resetData(): Promise<void> {
  const adminTables = [
    'page_tags',
    'trash_page_tags',
    'page_versions',
    'pages',
    'trash_pages',
    'plugins',
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
}
