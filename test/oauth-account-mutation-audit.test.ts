import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createAuthSession } from '../src/core/auth/sessions';
import { signJWT } from '../src/core/auth/jwt';
import type { Env } from '../src/types';

const id = 8901;
const subject = 'private-provider-subject';
const oauthId = `eventuai:${subject}`;
const providerProfile = { sub: subject, email: 'new-private@example.invalid', name: 'Provider Private Name', preferred_username: 'Provider Private Name',
  picture: 'https://example.invalid/private-avatar', roles: ['admin'] };
let requestNumber = 0;
let profile = { ...providerProfile };
let cookie = '';
const trigger = 'w4b_oauth_account_failure';

beforeEach(async () => {
  vi.unstubAllGlobals(); profile = { ...providerProfile }; cookie = '';
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['sessions', 'user_oauth_identities', 'users', 'audit_events', 'data_classes']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, 'github:original', 'old-private@example.invalid', '', 'old-avatar', 'editor')").bind(id).run();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
});

async function call(path: string, cookies = '', overrides: Partial<Env> = {}) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    headers: { Cookie: cookies, 'CF-Ray': 'w4b-oauth-account', 'CF-Connecting-IP': `10.83.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}`,
      'User-Agent': 'Synthetic OAuth account test' },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function begin(link = false, overrides: Partial<Env> = {}, provider = 'eventuai') {
  const start = await call(`/auth/start?provider=${provider}${link ? '&link=1' : ''}`, cookie, overrides);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const stateCookie = start.headers.get('Set-Cookie')!.match(/(?:__Host-)?oauth_state=([^;]+)/)![1];
  return async (changes: Partial<Env> = {}, callbackCookie = cookie) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (['https://id.eventuai.com/oauth/token', 'https://oauth2.googleapis.com/token'].includes(String(input))) return Response.json({ access_token: 'private-provider-token' });
      if (['https://id.eventuai.com/oauth/userinfo', 'https://www.googleapis.com/oauth2/v3/userinfo'].includes(String(input))) return Response.json(profile);
      throw new Error('Unexpected external call');
    }));
    try {
      return await call(`/auth/callback?code=private-code&state=${encodeURIComponent(state)}`,
        `oauth_state=${stateCookie}; ${callbackCookie}`, { ...overrides, ...changes });
    } finally { vi.unstubAllGlobals(); }
  };
}
async function login(link = false, overrides: Partial<Env> = {}) { return (await begin(link, overrides))(); }
async function seedIdentity(userId = id, provider = 'eventuai') {
  await env.DB.prepare('INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (?, ?, ?, ?)')
    .bind(userId, provider, subject, `${provider}:${subject}`).run();
}
async function session(refresh = false) {
  const issued = await createAuthSession(env, { id, email: 'old-private@example.invalid', name: '', role: 'editor' });
  cookie = `${refresh ? 'refresh_token' : 'access_token'}=${refresh ? issued.refreshToken : issued.accessToken}`;
  return issued;
}
async function events() {
  return (await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('user.oauth-link', 'user.oauth-profile') ORDER BY seq")
    .all<Record<string, unknown>>()).results;
}
async function account() { return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first(); }
async function identities() { return (await env.DB.prepare('SELECT * FROM user_oauth_identities ORDER BY id').all()).results; }
async function refuse(response: Response, sessionCount = 0) {
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Set-Cookie') ?? '').not.toMatch(/(?:access_token|refresh_token)=/);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: sessionCount });
  expect(await events()).toEqual([]);
}
function privateDataAbsent(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [subject, ...Object.values(providerProfile).filter(item => typeof item === 'string'),
    'old-private@example.invalid', 'old-avatar', 'private-provider-token', 'private-code']) expect(text).not.toContain(secret);
}
function batchHook(before: () => Promise<unknown>, failAfterCommit = false) {
  let batches = 0;
  const db = {
    withSession: () => db,
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      batches++;
      await before();
      const results = await env.DB.batch(statements);
      if (failAfterCommit) throw new Error('Synthetic lost commit acknowledgment');
      return results;
    },
  };
  return { DB: db, batchCount: () => batches };
}

it.each(['none', 'pii', 'phi'] as const)('atomically links an identity with classified %s evidence and the authorizing CMS session', async dataClass => {
  const issued = await session(); const before = await account();
  if (dataClass !== 'none') await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'user_oauth_identities', ?)").bind(dataClass).run();
  expect((await login(true)).headers.get('Location')).toBe('/admin');
  expect(await account()).toEqual(before);
  const rows = await events(); expect(rows).toHaveLength(1);
  const identity = (await identities())[0];
  expect(rows[0]).toMatchObject({ action: 'user.oauth-link', target_type: 'user_oauth_identity', target_id: String(identity.id), target_count: 1,
    actor_user_id: String(id), actor_roles: 'editor', acting_via: 'oauth:eventuai', data_class: dataClass,
    event_class: 'admin', retention_class: 'admin_config', outcome: 'success', request_id: 'w4b-oauth-account', user_agent: 'Synthetic OAuth account test' });
  expect(rows[0].session_sid).toBe(issued.accessPayload.sid);
  expect(JSON.parse(String(rows[0].detail))).toEqual({ classification_policy_version: expect.any(Number), provider: 'eventuai', user_id: String(id) });
  privateDataAbsent(rows);
});

it.each(['none', 'pii', 'phi'] as const)('atomically refreshes the profile with classified %s evidence and no profile values', async dataClass => {
  await seedIdentity();
  if (dataClass !== 'none') await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'users', ?)").bind(dataClass).run();
  expect((await login()).headers.get('Location')).toBe('/admin');
  expect(await account()).toMatchObject({ email: profile.email, name: profile.preferred_username, avatar_url: '', role: 'editor' });
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'user.oauth-profile', target_type: 'user', target_id: String(id), actor_user_id: String(id),
    actor_roles: 'editor', session_sid: null, acting_via: 'oauth:eventuai', data_class: dataClass, retention_class: 'admin_config' });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ classification_policy_version: expect.any(Number), provider: 'eventuai', fields: ['email', 'name', 'avatar_url'] });
  privateDataAbsent(rows);
});

it.each(['users', 'user_oauth_identities', 'roles', 'role_permissions', 'sessions'])('uses the highest %s classification for both OAuth mutation paths', async table => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', ?, 'phi')").bind(table).run();
  await session(); expect((await login(true)).status).toBe(302);
  expect((await login()).status).toBe(302);
  expect((await events()).map(row => row.data_class)).toEqual(['phi', 'phi']);
});

it('preserves the CMS name, roles and another account owning the provider email', async () => {
  await seedIdentity();
  await env.DB.prepare("UPDATE users SET name = 'CMS chosen name' WHERE id = ?").bind(id).run();
  await env.DB.prepare("INSERT INTO users (oauth_id, email, role) VALUES ('github:other', ?, 'viewer')").bind(profile.email).run();
  expect((await login()).headers.get('Location')).toBe('/admin');
  expect(await account()).toMatchObject({ name: 'CMS chosen name', role: 'editor', email: 'old-private@example.invalid', avatar_url: '' });
  expect(JSON.parse(String((await events())[0].detail))).toEqual({ classification_policy_version: expect.any(Number), provider: 'eventuai', fields: ['avatar_url'] });
});

it('refreshes a Google avatar and missing display name without retaining their values in the evidence', async () => {
  await seedIdentity(id, 'google');
  const callback = await begin(false, {}, 'google');
  expect((await callback()).headers.get('Location')).toBe('/admin');
  expect(await account()).toMatchObject({ name: profile.name, avatar_url: profile.picture, email: profile.email });
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0].detail))).toEqual({ classification_policy_version: expect.any(Number), provider: 'google', fields: ['email', 'name', 'avatar_url'] });
  privateDataAbsent(rows);
});

it('allows an owned legacy primary identity without silently creating a link', async () => {
  await env.DB.prepare('UPDATE users SET oauth_id = ? WHERE id = ?').bind(oauthId, id).run();
  expect((await login()).headers.get('Location')).toBe('/admin');
  expect(await identities()).toEqual([]);
  expect((await events())[0].action).toBe('user.oauth-profile');
});

it.each(['link', 'profile'])('does not repeat a %s mutation or its evidence on a no-op login', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  expect((await login(operation === 'link')).status).toBe(302);
  const before = await events(); expect(before).toHaveLength(1);
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE ${operation === 'link' ? 'INSERT ON user_oauth_identities' : 'UPDATE ON users'} BEGIN SELECT RAISE(ABORT, 'no mutation expected'); END`).run();
  expect((await login(operation === 'link')).headers.get('Location')).toBe('/admin');
  expect(await events()).toEqual(before);
});

it.each(['link', 'profile'])('refuses the %s operation when classification is invalid', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  const callback = await begin(operation === 'link');
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'users', 'invalid')").run();
  const before = await account(); const links = await identities();
  await refuse(await callback(), operation === 'link' ? 1 : 0);
  expect(await account()).toEqual(before); expect(await identities()).toEqual(links);
});

it.each(['   ', '\u00a0', '\t'])('preserves SQLite missing-name behavior for %j', async name => {
  await seedIdentity();
  await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, id).run();
  expect((await login()).headers.get('Location')).toBe('/admin');
  expect(await account()).toMatchObject({ name: name === '   ' ? profile.preferred_username : name });
});

it('requires the same account session at the linking callback', async () => {
  await session(); const callback = await begin(true);
  const response = await callback({}, '');
  expect(response.headers.get('Location')).toBe('/auth/login?error=link_session_mismatch');
  expect(await identities()).toEqual([]); expect(await events()).toEqual([]);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 1 });
});

it('does not relink an identity already owned by another account', async () => {
  await session();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email) VALUES (8902, 'github:other', 'other@example.invalid')").run();
  await seedIdentity(8902); const before = await identities();
  const response = await login(true);
  expect(response.headers.get('Location')).toBe('/auth/login?error=identity_already_linked');
  expect(await identities()).toEqual(before); expect(await events()).toEqual([]);
});

it.each(['link', 'profile'])('refuses to copy identifying legacy roles into %s evidence', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  const callback = await begin(operation === 'link');
  await env.DB.prepare("UPDATE users SET role = 'person@example.invalid' WHERE id = ?").bind(id).run();
  await refuse(await callback(), operation === 'link' ? 1 : 0);
});

for (const operation of ['link', 'profile'] as const) {
  const action = operation === 'link' ? 'user.oauth-link' : 'user.oauth-profile';
  it.each([
    ['audit-abort', `BEFORE INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`],
    ['audit-ignore', `BEFORE INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(IGNORE); END`],
    ['audit-delete', `AFTER INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END`],
    ['audit-rewrite', `AFTER INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END`],
    ['mutation-ignore', operation === 'link' ? 'BEFORE INSERT ON user_oauth_identities BEGIN SELECT RAISE(IGNORE); END' : 'BEFORE UPDATE ON users BEGIN SELECT RAISE(IGNORE); END'],
    ['mutation-rewrite', operation === 'link' ? 'AFTER INSERT ON user_oauth_identities BEGIN UPDATE user_oauth_identities SET provider_user_id = \'other\' WHERE id = NEW.id; END' : 'AFTER UPDATE ON users BEGIN UPDATE users SET name = \'unexpected\' WHERE id = NEW.id; END'],
    ['state-change-after-audit', `AFTER INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN UPDATE users SET role = 'admin' WHERE id = ${id}; END`],
    ['identity-delete-after-audit', `AFTER INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN DELETE FROM user_oauth_identities; END`],
  ])(`rolls back ${operation} and issues no new session on %s`, async (_failure, sql) => {
    if (operation === 'link') await session(); else await seedIdentity();
    const before = await account(); const links = await identities();
    await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run();
    await refuse(await login(operation === 'link'), operation === 'link' ? 1 : 0);
    expect(await account()).toEqual(before); expect(await identities()).toEqual(links);
  });
}

it('refuses a link after the authorizing session is revoked during provider authentication', async () => {
  await session(); const callback = await begin(true);
  await env.DB.prepare('DELETE FROM sessions').run();
  const response = await callback();
  expect(response.headers.get('Location')).toBe('/auth/login?error=link_session_mismatch');
  expect(await identities()).toEqual([]); expect(await events()).toEqual([]);
});

it.each(['revoked', 'expired', 'absolute-expired'])('rechecks an %s session immediately before the linking batch', async state => {
  await session(); const callback = await begin(true);
  const hook = batchHook(async () => {
    await env.DB.prepare(state === 'revoked' ? 'DELETE FROM sessions' : state === 'expired'
      ? "UPDATE sessions SET expires_at = datetime('now', '-1 second')" : "UPDATE sessions SET created_at = datetime('now', '-31 days')").run();
  });
  await refuse(await callback({ DB: hook.DB }), state === 'revoked' ? 0 : 1);
  expect(await identities()).toEqual([]);
});

it('rolls back a link if its audit trigger revokes the authorizing session', async () => {
  await session();
  await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON audit_events WHEN NEW.action = 'user.oauth-link' BEGIN DELETE FROM sessions; END`).run();
  await refuse(await login(true), 1); expect(await identities()).toEqual([]);
});

it('accepts refresh-token authority and its immediate rotation grace without renewing the old session', async () => {
  await session(true);
  await env.DB.prepare("UPDATE sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = 'rotated-hash', rotated_at = CURRENT_TIMESTAMP").run();
  const before = await env.DB.prepare('SELECT * FROM sessions').first();
  expect((await login(true)).headers.get('Location')).toBe('/admin');
  expect(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(before!.id).first()).toEqual(before);
  expect((await events())[0].session_sid).toBe(String(before!.id));
});

it.each(['idle', 'outside-grace', 'rotated-again'])('rechecks refresh-token %s refusal at transaction execution', async state => {
  await session(true); const callback = await begin(true);
  const hook = batchHook(async () => {
    await env.DB.prepare(state === 'idle' ? "UPDATE sessions SET created_at = datetime('now', '-2 days'), rotated_at = datetime('now', '-2 days')"
      : state === 'outside-grace' ? "UPDATE sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = 'next', rotated_at = datetime('now', '-31 seconds')"
        : "UPDATE sessions SET refresh_token_hash = 'next', previous_refresh_token_hash = NULL").run();
  });
  await refuse(await callback({ DB: hook.DB }), 1); expect(await identities()).toEqual([]);
});

it('refuses a refresh JWT whose subject does not own its session', async () => {
  const issued = await session(true);
  cookie = `refresh_token=${await signJWT({ sub: '9999', email: '', name: '', role: 'editor', type: 'refresh', jti: issued.refreshJti,
    exp: Math.floor(Date.now() / 1000) + 3600 }, env.JWT_SECRET)}`;
  expect((await call('/auth/start?provider=eventuai&link=1', cookie)).headers.get('Location')).toBe('/auth/login?error=link_session_expired');
  expect(await identities()).toEqual([]);
});

it.each(['link', 'profile'])('refuses stale %s snapshots after a concurrent role change', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  const callback = await begin(operation === 'link');
  const hook = batchHook(() => env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").bind(id).run());
  await refuse(await callback({ DB: hook.DB }), operation === 'link' ? 1 : 0);
  expect(await account()).toMatchObject({ role: 'viewer', email: 'old-private@example.invalid', avatar_url: 'old-avatar' });
});

it('refuses a profile update after the identity is reassigned concurrently', async () => {
  await seedIdentity();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email) VALUES (8902, 'github:other', 'other@example.invalid')").run();
  const before = await account();
  const hook = batchHook(() => env.DB.prepare('UPDATE user_oauth_identities SET user_id = 8902').run());
  await refuse(await login(false, { DB: hook.DB })); expect(await account()).toEqual(before);
});

it('refuses a profile update after another account concurrently claims the new email', async () => {
  await seedIdentity(); const before = await account();
  const hook = batchHook(() => env.DB.prepare("INSERT INTO users (oauth_id, email) VALUES ('github:other', ?)").bind(profile.email).run());
  await refuse(await login(false, { DB: hook.DB })); expect(await account()).toEqual(before);
});

it('does not take an identity concurrently linked to another account', async () => {
  await session();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email) VALUES (8902, 'github:other', 'other@example.invalid')").run();
  const hook = batchHook(() => seedIdentity(8902));
  await refuse(await login(true, { DB: hook.DB }), 1);
  expect((await identities())[0].user_id).toBe(8902);
});

it('rejects malformed identity metadata instead of using legacy primary-key fallback', async () => {
  await seedIdentity();
  await env.DB.prepare("UPDATE users SET oauth_id = ? WHERE id = ?").bind(oauthId, id).run();
  await env.DB.prepare("UPDATE user_oauth_identities SET provider = 'github'").run();
  const before = await account(); await refuse(await login()); expect(await account()).toEqual(before);
});

it.each(['link', 'profile'])('does not replay an uncertain committed %s operation or issue a new session', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  const hook = batchHook(async () => {}, true);
  const response = await login(operation === 'link', { DB: hook.DB });
  expect(response.status).toBe(503); expect(hook.batchCount()).toBe(1);
  expect(response.headers.get('Set-Cookie') ?? '').not.toMatch(/(?:access_token|refresh_token)=/);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: operation === 'link' ? 1 : 0 });
  const recorded = await events(); expect(recorded).toHaveLength(1);
  expect((await login(operation === 'link')).headers.get('Location')).toBe('/admin');
  expect(await events()).toEqual(recorded);
});

it.each(['link', 'profile'])('reports only a coarse incomplete incident after %s evidence fails', async operation => {
  if (operation === 'link') await session(); else await seedIdentity();
  const old = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/' });
  for (const object of old.objects) await env.AUDIT_OUTAGE_BUCKET!.delete(object.key);
  const action = operation === 'link' ? 'user.oauth-link' : 'user.oauth-profile';
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(IGNORE); END`).run();
  const alerts: Record<string, unknown>[] = [];
  await refuse(await login(operation === 'link', { AUDIT_OUTAGE_MONITORING: 'true', AUDIT_MONITOR_SOURCE: 'oauth-account-test',
    AUDIT_MONITOR: { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      alerts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(null, { status: 200 });
    } } as Fetcher,
  }), operation === 'link' ? 1 : 0);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ reason: 'health', captureComplete: false, eventCount: 0 });
  const incidents = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/incidents/' });
  expect(incidents.objects).toHaveLength(1);
  const incident = await (await env.AUDIT_OUTAGE_BUCKET!.get(incidents.objects[0].key))!.json();
  expect(incident).toMatchObject({ reason: 'health', captureComplete: false, eventCount: 0, records: [] });
  privateDataAbsent({ alerts, incident });
});

it.each([false, true])('links a released identity to another account after disabling (legacy primary: %s)', async legacy => {
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, role) VALUES (8902, ?, 'retained@example.invalid', 'admin')")
    .bind(legacy ? oauthId : 'github:retired-primary').run();
  if (!legacy) await seedIdentity(8902);
  const old = await createAuthSession(env, { id: 8902, email: 'retained@example.invalid', name: '', role: 'admin' });
  const ctx = createExecutionContext();
  const disabled = await worker.fetch(new Request('https://cms.example.com/admin/profile/disable', {
    method: 'POST', headers: { Cookie: `access_token=${old.accessToken}`, 'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/x-www-form-urlencoded' }, body: 'confirm=disable',
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  expect(disabled.status).toBe(303);
  await session();
  expect((await login(true)).headers.get('Location')).toBe('/admin');
  expect(await identities()).toMatchObject([{ user_id: id, oauth_id: oauthId }]);
  expect(await env.DB.prepare('SELECT disabled_at, role FROM users WHERE id = 8902').first())
    .toEqual({ disabled_at: expect.any(String), role: 'admin' });
});

it('refuses a pending linking flow after its account is disabled', async () => {
  await session(); const callback = await begin(true);
  await env.DB.prepare('UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?').bind(id).run();
  expect((await callback()).headers.get('Location')).toBe('/auth/login?error=link_session_mismatch');
  expect(await identities()).toEqual([]);
});
