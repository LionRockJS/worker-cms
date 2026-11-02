import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const triggers = ['w4b_registration_fail', 'w4b_registration_side_effect'];
let requestNumber = 0;
const profile = { sub: 'w4b-new-user', email: 'private-person@example.invalid', name: 'Private Person',
  picture: 'https://example.invalid/private-avatar', roles: ['admin'] };

beforeEach(async () => {
  for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['sessions', 'user_oauth_identities', 'users', 'audit_events', 'data_classes']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
});

async function call(path: string, cookie = '', overrides: Partial<Env> = {}) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    headers: { Cookie: cookie, 'CF-Ray': 'w4b-registration', 'CF-Connecting-IP': `10.81.0.${requestNumber}`, 'User-Agent': 'Synthetic registration test' },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function login(overrides: Partial<Env> = {}) {
  const start = await call('/auth/start?provider=eventuai', '', overrides);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const cookie = start.headers.get('Set-Cookie')!.match(/(?:__Host-)?oauth_state=([^;]+)/)![1];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === 'https://id.eventuai.com/oauth/token') return Response.json({ access_token: 'synthetic-provider-token' });
    if (String(input) === 'https://id.eventuai.com/oauth/userinfo') return Response.json(profile);
    throw new Error('Unexpected external call');
  }));
  try {
    return await call(`/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, `oauth_state=${cookie}`, overrides);
  } finally { vi.unstubAllGlobals(); }
}
async function creationEvents() {
  return (await env.DB.prepare("SELECT * FROM audit_events WHERE action = 'user.create'").all<Record<string, unknown>>()).results;
}
async function expectNoAccount(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Set-Cookie') ?? '').not.toMatch(/(?:access_token|refresh_token)=/);
  for (const table of ['users', 'user_oauth_identities', 'sessions']) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
  }
  expect(await creationEvents()).toEqual([]);
}

it.each(['none', 'pii', 'phi'] as const)('commits account, viewer role, identity and attributable %s evidence before issuing a session', async (dataClass) => {
  if (dataClass !== 'none') await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'user_oauth_identities', ?)").bind(dataClass).run();
  const response = await login();
  expect(response.status).toBe(302); expect(response.headers.get('Location')).toBe('/admin');
  const user = await env.DB.prepare('SELECT id, role FROM users').first<{ id: number; role: string }>();
  expect(user!.role).toBe('viewer');
  expect(await env.DB.prepare('SELECT user_id, provider FROM user_oauth_identities').first()).toEqual({ user_id: user!.id, provider: 'eventuai' });
  const events = await creationEvents(); expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ target_id: String(user!.id), target_type: 'user', target_count: 1,
    actor_user_id: String(user!.id), actor_roles: 'viewer', acting_via: 'oauth:eventuai', session_sid: null,
    event_class: 'admin', data_class: dataClass, retention_class: 'admin_config', outcome: 'success',
    request_id: 'w4b-registration', source_ip: `10.81.0.${requestNumber}`, user_agent: 'Synthetic registration test' });
  expect(JSON.parse(String(events[0].detail))).toEqual({ classification_policy_version: expect.any(Number), provider: 'eventuai', role_after: 'viewer' });
  for (const value of [...Object.values(profile).filter(value => typeof value === 'string'), 'synthetic-provider-token', 'synthetic-code']) {
    expect(JSON.stringify(events)).not.toContain(value);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 1 });
});

it.each(['users', 'roles', 'role_permissions'])('inherits the %s source classification', async (table) => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', ?, 'phi')").bind(table).run();
  expect((await login()).status).toBe(302);
  expect((await creationEvents())[0].data_class).toBe('phi');
});

it.each([
  ['audit-abort', "BEFORE INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"],
  ['audit-ignore', "BEFORE INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN SELECT RAISE(IGNORE); END"],
  ['audit-delete', "AFTER INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END"],
  ['audit-rewrite', "AFTER INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END"],
  ['user-ignore', 'BEFORE INSERT ON users BEGIN SELECT RAISE(IGNORE); END'],
  ['identity-abort', "BEFORE INSERT ON user_oauth_identities BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"],
  ['identity-ignore', 'BEFORE INSERT ON user_oauth_identities BEGIN SELECT RAISE(IGNORE); END'],
  ['identity-delete', 'AFTER INSERT ON user_oauth_identities BEGIN DELETE FROM user_oauth_identities WHERE id = NEW.id; END'],
  ['role-rewrite', "AFTER INSERT ON user_oauth_identities BEGIN UPDATE users SET role = 'admin' WHERE id = NEW.user_id; END"],
  ['identity-delete-after-audit', "AFTER INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN DELETE FROM user_oauth_identities; END"],
  ['profile-rewrite-after-audit', "AFTER INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN UPDATE users SET name = 'unexpected'; END"],
])('rolls back registration and issues no session on %s', async (_name, sql) => {
  await env.DB.prepare(`CREATE TRIGGER w4b_registration_fail ${sql}`).run();
  await expectNoAccount(await login());
});

it('refuses registration if classification is invalid', async () => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'users', 'invalid')").run();
  await expectNoAccount(await login());
});

it('does not create another account or creation event when an existing user signs in', async () => {
  expect((await login()).status).toBe(302);
  await env.DB.prepare("UPDATE users SET role = 'editor', name = 'CMS name'").run();
  expect((await login()).status).toBe(302);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 1 });
  expect(await env.DB.prepare('SELECT role, name FROM users').first()).toEqual({ role: 'editor', name: 'CMS name' });
  expect(await creationEvents()).toHaveLength(1);
});

it('retains registration allowlist refusal without creating an account or event', async () => {
  const response = await login({ ALLOWED_EMAIL_DOMAINS: 'approved.invalid' });
  expect(response.headers.get('Location')).toBe('/auth/login?error=email_not_allowed');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });
  expect(await creationEvents()).toEqual([]);
});

it('refuses to adopt an existing identity under a different OAuth key', async () => {
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, role) VALUES (8800, 'legacy:owner', 'owner@example.invalid', 'editor')").run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (8800, 'eventuai', 'w4b-new-user', 'legacy:identity')").run();
  const response = await login();
  expect(response.status).toBe(503);
  expect(await env.DB.prepare('SELECT id, role FROM users').all()).toMatchObject({ results: [{ id: 8800, role: 'editor' }] });
  expect(await env.DB.prepare('SELECT user_id FROM user_oauth_identities').all()).toMatchObject({ results: [{ user_id: 8800 }] });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
  expect(await creationEvents()).toEqual([]);
});

it('reports post-commit uncertainty without replay or session issuance; a later sign-in reuses the account', async () => {
  let batches = 0;
  const uncertainDb = {
    withSession: () => uncertainDb,
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      batches++;
      await env.DB.batch(statements);
      throw new Error('Synthetic connection loss after commit');
    },
  } as Env['DB'];
  const response = await login({ DB: uncertainDb });
  expect(response.status).toBe(503); expect(batches).toBe(1);
  expect(response.headers.get('Set-Cookie') ?? '').not.toMatch(/(?:access_token|refresh_token)=/);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 1 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM user_oauth_identities').first()).toEqual({ n: 1 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
  expect(await creationEvents()).toHaveLength(1);
  expect((await login()).headers.get('Location')).toBe('/admin');
  expect(await creationEvents()).toHaveLength(1);
});

it('sends only a coarse incomplete health incident when registration evidence fails', async () => {
  const old = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/' });
  for (const object of old.objects) await env.AUDIT_OUTAGE_BUCKET!.delete(object.key);
  await env.DB.prepare("CREATE TRIGGER w4b_registration_fail BEFORE INSERT ON audit_events WHEN NEW.action = 'user.create' BEGIN SELECT RAISE(IGNORE); END").run();
  const alerts: Record<string, unknown>[] = [];
  await expectNoAccount(await login({ AUDIT_OUTAGE_MONITORING: 'true', AUDIT_MONITOR_SOURCE: 'registration-test',
    AUDIT_MONITOR: { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      alerts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    } } as Fetcher,
  }));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ reason: 'health', captureComplete: false, eventCount: 0 });
  const incidents = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/incidents/' });
  expect(incidents.objects).toHaveLength(1);
  const incident = await (await env.AUDIT_OUTAGE_BUCKET!.get(incidents.objects[0].key))!.json();
  expect(incident).toMatchObject({ reason: 'health', captureComplete: false, eventCount: 0, records: [] });
  for (const value of Object.values(profile).filter(value => typeof value === 'string')) {
    expect(JSON.stringify({ incident, alerts })).not.toContain(value);
  }
});
