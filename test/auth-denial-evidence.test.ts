import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import worker from '../src/index';
import { issueAuthTokens, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { authMiddleware, requireAnyPermission, requirePermission } from '../src/core/auth/guards';
import { recordAuthDenial, AuthDenialEvidenceUnavailableError } from '../src/core/auth/denials';
import { drainAuditMutationOutbox } from '../src/core/db/audit-mutation-outbox';
import { hashToken, signJWT } from '../src/core/auth/jwt';
import type { Env, Variables } from '../src/types';

const user = { id: 9801, email: 'denied-person@example.invalid', name: 'Private denied person', role: 'editor' };
const sid = 98001;
let issued: IssuedAuthTokens;
let requestNumber = 0;
const triggers = ['denial_primary_fault', 'denial_outbox_fault'];

beforeEach(async () => {
  clearRolePermissionsCache();
  for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['audit_mutation_outbox', 'audit_events', 'data_classes', 'sessions', 'user_oauth_identities', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, 'fixture:denied-person', ?, ?, ?)")
    .bind(user.id, user.email, user.name, user.role).run();
  issued = await issueAuthTokens(user, env.JWT_SECRET, String(sid));
  await env.DB.prepare("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))")
    .bind(sid, user.id, await hashToken(issued.refreshJti)).run();
});
afterEach(async () => { for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run(); });

async function call(path: string, options: { method?: string; cookie?: string; overrides?: Partial<Env> } = {}) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, { method: options.method ?? 'GET',
    headers: { Cookie: options.cookie ?? '', 'Sec-Fetch-Site': 'same-origin', 'CF-Ray': 'denial-evidence-test',
      'User-Agent': 'denial-test', 'CF-Connecting-IP': `10.86.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...options.overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE outcome = 'denied' ORDER BY seq").all()).results; }
async function pending() { return (await env.DB.prepare('SELECT * FROM audit_mutation_outbox ORDER BY event_id').all()).results; }
async function fault(sql: string, name = triggers[0]) { await env.DB.prepare(`CREATE TRIGGER ${name} ${sql}`).run(); }
async function privateValuesAbsent(value: unknown) {
  for (const secret of [user.email, user.name, 'fixture:denied-person', issued.accessToken, issued.refreshToken, issued.refreshJti,
    await hashToken(issued.refreshJti), 'private-url-secret', 'private-provider-error', 'attempted-user@example.invalid']) expect(JSON.stringify(value)).not.toContain(secret);
}
function hook(throwOn: number) {
  let count = 0;
  const DB = { withSession: () => DB, prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
    count++;
    const result = await env.DB.batch(statements);
    if (count === throwOn) throw new Error('Synthetic lost denial acknowledgment');
    return result;
  } };
  return { DB, count: () => count };
}

it('persists an attributable bounded OAuth refusal before returning its redirect', async () => {
  const response = await call('/auth/callback'); expect(response.headers.get('Location')).toBe('/auth/login?error=missing_params');
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'auth.login', event_class: 'auth', retention_class: 'auth', outcome: 'denied', actor_user_id: null,
    actor_roles: null, session_sid: null, target_id: null, request_id: 'denial-evidence-test', user_agent: 'denial-test' });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ reason: 'missing_params' }); await privateValuesAbsent(rows);
});

it('normalizes provider error text without copying it into evidence or redirect URLs', async () => {
  const response = await call('/auth/callback?error=private-provider-error-attempted-user%40example.invalid');
  expect(response.headers.get('Location')).toBe('/auth/login?error=provider_error');
  expect(JSON.parse(String((await events())[0].detail))).toEqual({ reason: 'provider_error' });
  await privateValuesAbsent({ rows: await events(), headers: [...response.headers] });
});

it('does not record OAuth codes, state, query terms or attempted addresses', async () => {
  const response = await call('/auth/callback?code=private-url-secret&state=attempted-user%40example.invalid');
  expect(response.headers.get('Location')).toBe('/auth/login?error=missing_state');
  expect(JSON.parse(String((await events())[0].detail))).toEqual({ reason: 'missing_state' }); await privateValuesAbsent(await events());
});

it.each(['missing', 'malformed', 'expired', 'revoked'])('durably records a %s explicit refresh refusal without attributing rejected JWT claims', async kind => {
  let token = kind === 'missing' ? '' : kind === 'malformed' ? 'private-url-secret' : issued.refreshToken;
  if (kind === 'expired') token = await signJWT({ ...issued.accessPayload, type: 'refresh', jti: issued.refreshJti, exp: Math.floor(Date.now() / 1000) - 1 }, env.JWT_SECRET);
  if (kind === 'revoked') await env.DB.prepare('DELETE FROM sessions').run();
  const response = await call('/auth/refresh', { method: 'POST', cookie: token ? `refresh_token=${token}` : '' });
  expect(response.status).toBe(401);
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'auth.refresh', actor_user_id: null, actor_roles: null, session_sid: null });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ reason: kind === 'missing' ? 'no_refresh_token' : kind === 'revoked' ? 'session_revoked' : 'invalid_refresh_token' });
  await privateValuesAbsent(rows);
});

it.each(['missing', 'invalid'])('records a %s protected-route authentication refusal once before redirecting', async kind => {
  const response = await call('/admin/profile?search=attempted-user%40example.invalid', { cookie: kind === 'invalid' ? 'access_token=private-url-secret' : '' });
  expect(response.headers.get('Location')).toBe('/auth/login');
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'auth.access', actor_user_id: null, session_sid: null });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ reason: kind === 'missing' ? 'missing_credentials' : 'invalid_credentials' });
  await privateValuesAbsent(rows);
});

it('durably rejects unauthenticated identity-link starts', async () => {
  const response = await call('/auth/start?provider=github&link=1');
  expect(response.headers.get('Location')).toBe('/auth/login?error=link_session_expired');
  expect((await events())[0]).toMatchObject({ action: 'auth.start', actor_user_id: null });
  expect(JSON.parse(String((await events())[0].detail))).toEqual({ reason: 'link_session_expired' });
});

it.each(['/auth/start?provider=github', '/auth/callback', '/auth/refresh'])('records an auth rate-limit refusal at %s', async path => {
  const response = await call(path, { method: path === '/auth/refresh' ? 'POST' : 'GET',
    overrides: { AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } },
  });
  expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0].action).toBe(path.startsWith('/auth/start') ? 'auth.start' : path === '/auth/refresh' ? 'auth.refresh' : 'auth.login');
  expect(JSON.parse(String(rows[0].detail))).toEqual({ reason: 'rate_limited' });
});

it('records the registered permission route pattern without private path parameters', async () => {
  const response = await call('/admin/users/attempted-user%40example.invalid/edit?token=private-url-secret', { cookie: `access_token=${issued.accessToken}` });
  expect(response.status).toBe(403);
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'permission.denied', actor_user_id: String(user.id), actor_roles: 'editor', session_sid: String(sid) });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ permission: 'users:manage', path: '/admin/users/:id/edit' });
  await privateValuesAbsent(rows);
});

it('records an editor admission refusal with the current authenticated actor', async () => {
  await env.DB.prepare("UPDATE users SET role = 'viewer'").run();
  expect((await call('/admin/roles', { cookie: `access_token=${issued.accessToken}` })).status).toBe(302);
  const row = (await events())[0]; expect(row).toMatchObject({ action: 'permission.denied', actor_roles: 'viewer' });
  expect(JSON.parse(String(row.detail))).toEqual({ reason: 'editor_required', path: '/admin/roles' });
});

it('omits unsafe legacy role values without preventing the refusal', async () => {
  await env.DB.prepare("UPDATE users SET role = 'attempted-user@example.invalid'").run();
  expect((await call('/admin/roles', { cookie: `access_token=${issued.accessToken}` })).status).toBe(302);
  const row = (await events())[0]; expect(row).toMatchObject({ actor_user_id: String(user.id), actor_roles: null });
  expect(JSON.parse(String(row.detail))).toMatchObject({ roles_unavailable: true }); await privateValuesAbsent(row);
});

it.each(['none', 'pii', 'phi', 'invalid'])('classifies anonymous denial evidence with %s policy, preserving conservative failure metadata', async dataClass => {
  if (dataClass !== 'none') await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'sessions', ?)").bind(dataClass).run();
  expect((await call('/auth/callback')).status).toBe(302);
  const row = (await events())[0]; expect(row.data_class).toBe('phi');
  expect(JSON.parse(String(row.detail))).toEqual({ reason: 'missing_params', ...(dataClass === 'invalid' ? { classification_unavailable: true } : {}) });
});

it.each([
  ['abort', "BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['ignore', "BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END"],
  ['delete', "AFTER INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END"],
  ['rewrite', "AFTER INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN UPDATE audit_events SET detail = '{\"reason\":\"unapproved\"}' WHERE seq = NEW.seq; END"],
])('persists a complete fallback receipt after primary %s and recovers the same ID', async (_kind, sql) => {
  await fault(sql);
  expect((await call('/auth/callback')).status).toBe(302); expect(await events()).toEqual([]);
  const receipts = await pending(); expect(receipts).toHaveLength(1); expect(receipts[0].attempts).toBe(0);
  await privateValuesAbsent(receipts);
  await env.DB.prepare(`DROP TRIGGER ${triggers[0]}`).run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect(await pending()).toEqual([]); expect(await events()).toHaveLength(1);
  expect((await events())[0].event_id).toBe(receipts[0].event_id);
});

it.each(['/auth/callback', '/auth/refresh', '/admin/profile', '/admin/roles'])('keeps %s refused with durable fallback while the primary audit stream is down', async path => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(ABORT, 'outage'); END");
  const response = await call(path, { method: path === '/auth/refresh' ? 'POST' : 'GET', cookie: path === '/admin/roles' ? `access_token=${issued.accessToken}` : '' });
  expect(response.status).toBe(path === '/auth/refresh' ? 401 : path === '/admin/roles' ? 403 : 302);
  expect(await events()).toEqual([]); expect(await pending()).toHaveLength(1);
  await env.DB.prepare(`DROP TRIGGER ${triggers[0]}`).run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1); expect(await pending()).toEqual([]);
});

it('preserves a JSON authentication refusal with durable fallback', async () => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END");
  const response = await call('/admin/api/private?key=private-url-secret');
  expect(response.status).toBe(401); expect(response.headers.get('X-CMS-Error')).toBe('authentication-required');
  expect(await pending()).toHaveLength(1); await privateValuesAbsent(await pending());
});

it('retains denial evidence while the primary audit table is unavailable', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO unavailable_denial_primary').run();
  try {
    expect((await call('/auth/callback')).status).toBe(302);
    expect(await pending()).toHaveLength(1);
  } finally { await env.DB.prepare('ALTER TABLE unavailable_denial_primary RENAME TO audit_events').run(); }
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1); expect(await pending()).toEqual([]);
});

it.each(['reason', 'actor', 'path'])('retains an unapproved %s fallback envelope for review', async kind => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END");
  await call(kind === 'path' ? '/admin/roles' : '/auth/callback', { cookie: kind === 'path' ? `access_token=${issued.accessToken}` : '' });
  await env.DB.prepare(`DROP TRIGGER ${triggers[0]}`).run();
  const path = kind === 'reason' ? '$.row.detail.reason' : kind === 'actor' ? '$.actor.userId' : '$.row.detail.path';
  await env.DB.prepare('UPDATE audit_mutation_outbox SET envelope = json_set(envelope, ?, ?)')
    .bind(path, kind === 'actor' ? String(user.id) : 'attempted-user@example.invalid').run();
  expect((await drainAuditMutationOutbox(env)).failed).toBe(1);
  expect(await events()).toEqual([]); expect(await pending()).toHaveLength(1);
});

it.each([
  ['abort', "BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['ignore', 'BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END'],
  ['delete', 'AFTER INSERT ON audit_mutation_outbox BEGIN DELETE FROM audit_mutation_outbox WHERE event_id = NEW.event_id; END'],
  ['rewrite', "AFTER INSERT ON audit_mutation_outbox BEGIN UPDATE audit_mutation_outbox SET envelope = json_set(envelope, '$.row.detail.reason', 'unapproved'); END"],
])('returns denied 503 without inventing complete evidence when both stores fail (%s)', async (_kind, sql) => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END");
  await fault(sql, triggers[1]);
  const response = await call('/auth/callback'); expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toEqual({ error: 'authentication_denial_evidence_unavailable' });
  expect(await events()).toEqual([]); expect(await pending()).toEqual([]);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 1 });
});

it('deduplicates a possible committed primary denial when acknowledgment is lost', async () => {
  const uncertain = hook(1);
  expect((await call('/auth/callback', { overrides: { DB: uncertain.DB } })).status).toBe(302);
  expect(uncertain.count()).toBe(2); expect(await events()).toHaveLength(1); expect(await pending()).toHaveLength(1);
  expect((await pending())[0].event_id).toBe((await events())[0].event_id);
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect(await events()).toHaveLength(1); expect(await pending()).toEqual([]);
});

it('does not claim acknowledged evidence when the fallback commit acknowledgment is lost', async () => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(ABORT, 'primary down'); END");
  const uncertain = hook(2);
  expect((await call('/auth/callback', { overrides: { DB: uncertain.DB } })).status).toBe(503);
  expect(uncertain.count()).toBe(2); expect(await pending()).toHaveLength(1); expect(await events()).toEqual([]);
  await env.DB.prepare(`DROP TRIGGER ${triggers[0]}`).run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1); expect(await events()).toHaveLength(1);
});

it('never reaches a protected handler when denial evidence cannot persist', async () => {
  await fault("BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
  await fault('BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END', triggers[1]);
  let reached = false;
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', issued.accessPayload); await next(); });
  app.get('/private/:id', requireAnyPermission('roles:manage', 'users:manage'), c => { reached = true; return c.text('private'); });
  app.onError((error, c) => c.json({ denied: error instanceof AuthDenialEvidenceUnavailableError }, 503));
  const response = await app.request('/private/attempted-user%40example.invalid', undefined, env);
  expect(response.status).toBe(503); expect(reached).toBe(false); expect(await response.json()).toEqual({ denied: true });
});

it('records bounded alternative permissions using the registered route pattern', async () => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', issued.accessPayload); await next(); });
  app.get('/private/:id', requireAnyPermission('roles:manage', 'users:manage'), c => c.text('private'));
  expect((await app.request('/private/attempted-user%40example.invalid', undefined, env)).status).toBe(403);
  expect(JSON.parse(String((await events())[0].detail))).toEqual({ permissions: 'roles:manage,users:manage', path: '/private/:id' });
});

it('does not persist unapproved reason/permission text supplied by a caller', async () => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.get('/reason', async c => { await recordAuthDenial(c, 'auth.login', { reason: 'private-provider-error' }); return c.text('denied', 403); });
  app.use('/permission/*', async (c, next) => { c.set('user', issued.accessPayload); await next(); });
  app.get('/permission/:id', requirePermission('attempted-user@example.invalid'), c => c.text('private'));
  expect((await app.request('/reason', undefined, env)).status).toBe(403);
  expect((await app.request('/permission/abc', undefined, env)).status).toBe(403);
  const rows = await events(); expect(JSON.parse(String(rows[0].detail))).toEqual({ reason: 'unknown' });
  expect(JSON.parse(String(rows[1].detail))).toEqual({ permission: 'unrecordable', path: '/permission/:id' }); await privateValuesAbsent(rows);
});

it('bounds request metadata so an audit-only fallback envelope stays within its storage contract', async () => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END");
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.get('/denied', async c => { await recordAuthDenial(c, 'auth.login', { reason: 'missing_params' }); return c.text('denied', 403); });
  const response = await app.request('/denied', { headers: { 'CF-Ray': 'r'.repeat(20000), 'CF-Connecting-IP': '1'.repeat(20000), 'User-Agent': 'u'.repeat(2000) } }, env);
  expect(response.status).toBe(403);
  const receipt = (await pending())[0]; expect(new TextEncoder().encode(String(receipt.envelope)).length).toBeLessThan(16384);
  const request = JSON.parse(String(receipt.envelope)).request;
  expect(request.requestId).toHaveLength(128); expect(request.sourceIp).toHaveLength(64); expect(request.userAgent).toHaveLength(256);
});

it('reports only a coarse incomplete outage signal if denial persistence is unavailable', async () => {
  const old = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/' });
  for (const object of old.objects) await env.AUDIT_OUTAGE_BUCKET!.delete(object.key);
  await fault("BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END");
  await fault('BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END', triggers[1]);
  const alerts: Record<string, unknown>[] = [];
  const response = await call('/auth/callback?code=private-url-secret', { overrides: { AUDIT_OUTAGE_MONITORING: 'true', AUDIT_MONITOR_SOURCE: 'auth-denial-test',
    AUDIT_MONITOR: { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      alerts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(null, { status: 200 });
    } } as Fetcher,
  } });
  expect(response.status).toBe(503); expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ eventCount: 0, captureComplete: false, reason: 'audit-write' });
  const objects = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/incidents/' }); expect(objects.objects).toHaveLength(1);
  const incident = await (await env.AUDIT_OUTAGE_BUCKET!.get(objects.objects[0].key))!.json();
  expect(incident).toMatchObject({ records: [], captureComplete: false }); await privateValuesAbsent({ incident, alerts });
});


it.each(['text/html', 'application/json'])('shows missing permissions only after authentication (%s)', async accept => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', authMiddleware);
  app.get('/single', requirePermission('users:manage'), c => c.text('private'));
  app.get('/any', requireAnyPermission('roles:manage', 'users:manage'), c => c.text('private'));
  for (const [path, requirement] of [
    ['/single', 'Required permission: users:manage'],
    ['/any', 'Required permission (one of): roles:manage, users:manage'],
  ]) {
    const anonymous = await app.request(path, { headers: { Accept: accept } }, env);
    expect(anonymous.status).toBe(accept === 'application/json' ? 401 : 302);
    expect(await anonymous.text()).not.toContain('manage');
    const denied = await app.request(path, { headers: { Accept: accept, Cookie: `access_token=${issued.accessToken}` } }, env);
    expect(denied.status).toBe(403);
    if (accept === 'application/json') {
      expect(denied.headers.get('X-CMS-Error')).toBe('insufficient-permissions');
      expect(await denied.json()).toEqual({ success: false, error: `Insufficient permissions. ${requirement}` });
    } else {
      expect(await denied.text()).toBe(`Forbidden: Insufficient permissions. ${requirement}`);
    }
  }
});
