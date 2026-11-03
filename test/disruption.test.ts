// W11 security during disruption (A.5.29). While the private database is
// unreachable the CMS cannot check a session, a role or a classification, so
// every route that needs one must refuse rather than fall back to what the
// token alone claims. These cases take D1 away after a session is issued and
// check that nothing is served, changed or re-issued until it comes back.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { createAuthSession, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { clearRolePermissionsCache } from '../src/core/auth/roles';

const user = { id: 9911, email: 'disruption@example.invalid', name: 'Disruption drill', role: 'admin' };
let issued: IssuedAuthTokens;
let requestNumber = 0;

/** A D1 binding whose every query fails, the way an outage surfaces: on execution. */
function unreachableDatabase(): D1Database {
  const outage = () => Promise.reject(new Error('D1_ERROR: Network connection lost.'));
  const statement: Record<string, unknown> = {};
  Object.assign(statement, { bind: () => statement, first: outage, all: outage, run: outage, raw: outage });
  const database: Record<string, unknown> = {};
  Object.assign(database, {
    prepare: () => statement,
    batch: outage,
    exec: outage,
    dump: outage,
    withSession: () => database,
  });
  return database as unknown as D1Database;
}

async function request(path: string, cookie: string, init: RequestInit = {}, database = unreachableDatabase()) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    ...init,
    headers: { Cookie: cookie, Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://cms.example.com',
      'CF-Connecting-IP': `10.98.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}`, ...init.headers },
  }), { ...env, DB: database, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare(`INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, 'fixture:disruption', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET role = excluded.role`).bind(user.id, user.email, user.name, user.role).run();
  issued = await createAuthSession(env, user);
});

const mediaKey = 'uploads/2026/11/disruption.png';

async function seedMedia() {
  await env.MEDIA_BUCKET.put(mediaKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare('INSERT OR IGNORE INTO media_files (key, url, filename, content_type, size) VALUES (?, ?, ?, ?, 4)')
    .bind(mediaKey, `/media/${mediaKey}`, 'disruption.png', 'image/png').run();
}

describe('private database reachable (baseline)', () => {
  it('serves the admin read and the media object the cases below refuse', async () => {
    expect((await request('/admin/users', `__Host-access_token=${issued.accessToken}`, {}, env.DB)).status).toBe(200);
    await seedMedia();
    expect((await request(`/media/${mediaKey}`, '', {}, env.DB)).status).toBe(200);
  });
});

describe('private database unreachable', () => {
  it('refuses an admin read with a valid access token', async () => {
    const response = await request('/admin/users', `__Host-access_token=${issued.accessToken}`);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain(user.email);
  });

  it('refuses an admin change with a valid access token', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, oauth_id, email, name, role) VALUES (9912, 'fixture:disruption-target', 'disruption-target@example.invalid', 'Target', 'editor')`).run();
    const response = await request('/admin/users/9912/delete', `__Host-access_token=${issued.accessToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = 9912').first()).not.toBeNull();
  });

  it('issues no new tokens from a refresh token', async () => {
    const response = await request('/admin/users', `__Host-refresh_token=${issued.refreshToken}`);
    expect(response.status).not.toBe(200);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-access_token=') && !cookie.startsWith('__Host-access_token=;'))).toBe(false);
  });

  it('serves no media while classification and the media index are unreadable', async () => {
    await seedMedia();
    const response = await request(`/media/${mediaKey}`, '');
    expect([404, 503]).toContain(response.status);
    expect(response.headers.get('Content-Type') ?? '').not.toContain('image/png');
  });
});
