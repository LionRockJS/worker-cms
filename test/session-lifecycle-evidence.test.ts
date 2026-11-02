import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { createAuthSession, rotateAuthSession, revokeRefreshSession, capUserSessions, purgeExpiredSessions,
  issueAuthTokens, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { maintainSessionHygiene, validateAccessSession } from '../src/core/auth/sessions';
import { SessionEvidenceUnavailableError } from '../src/core/auth/session-evidence';
import { drainAuditMutationOutbox } from '../src/core/db/audit-mutation-outbox';
import { hashToken, signJWT } from '../src/core/auth/jwt';
import { signJWT as signFixtureJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { Env } from '../src/types';

const user = { id: 9501, email: 'private-session@example.invalid', name: 'Private session user', role: 'editor' };
const sid = 95001;
let issued: IssuedAuthTokens;
let requestNumber = 0;
const trigger = 'session_lifecycle_fault';

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['audit_mutation_outbox', 'audit_events', 'data_classes', 'sessions', 'user_oauth_identities', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, 'fixture:private-session', ?, ?, ?)")
    .bind(user.id, user.email, user.name, user.role).run();
  issued = await issueAuthTokens(user, env.JWT_SECRET, String(sid));
  // Privileged fixture setup intentionally bypasses application mutations.
  await env.DB.prepare("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+7 days'))")
    .bind(sid, user.id, await hashToken(issued.refreshJti)).run();
});
afterEach(async () => { await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run(); });

async function api(path: '/auth/refresh' | '/auth/logout', cookies = `refresh_token=${issued.refreshToken}`, overrides: Partial<Env> = {}) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, { method: 'POST',
    headers: { Cookie: cookies, 'Sec-Fetch-Site': 'same-origin', 'CF-Ray': 'session-lifecycle-test',
      'CF-Connecting-IP': `10.85.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function rows() { return (await env.DB.prepare('SELECT * FROM sessions ORDER BY id').all()).results; }
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE event_class = 'auth' AND outcome = 'success' ORDER BY seq").all()).results; }
async function pending() { return (await env.DB.prepare('SELECT * FROM audit_mutation_outbox ORDER BY event_id').all()).results; }
async function fault(sql: string) { await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run(); }
async function classify(value = 'phi', table = 'sessions') {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', ?, ?)").bind(table, value).run();
}
function hook(before: () => Promise<unknown>, uncertain = false) {
  let count = 0;
  const DB = { withSession: () => DB, prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
    count++; if (count === 1) await before();
    const result = await env.DB.batch(statements);
    if (count === 1 && uncertain) throw new Error('Synthetic lost commit acknowledgment');
    return result;
  } };
  return { DB, count: () => count };
}
async function privateEvidence() {
  const evidence = JSON.stringify({ events: await events(), pending: await pending() });
  for (const value of [user.email, user.name, 'fixture:private-session', issued.accessToken, issued.refreshToken, issued.refreshJti,
    await hashToken(issued.refreshJti), ...(await rows()).map(row => String(row.refresh_token_hash))]) expect(evidence).not.toContain(value);
}
async function unavailable(response: Response) {
  expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Set-Cookie') ?? '').not.toMatch(/(?:access_token|refresh_token)=[^;]/);
}

it.each(['none', 'pii', 'phi'])('commits session creation and %s sign-in evidence before returning tokens', async dataClass => {
  if (dataClass !== 'none') await classify(dataClass);
  const result = await createAuthSession(env, user);
  expect(await rows()).toHaveLength(2);
  const audit = await events(); expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'auth.login', target_type: 'session', target_id: result.accessPayload.sid,
    session_sid: result.accessPayload.sid, actor_user_id: String(user.id), actor_roles: 'editor', data_class: dataClass,
    event_class: 'auth', retention_class: 'auth', outcome: 'success' });
  expect(JSON.parse(String(audit[0].detail))).toEqual({ source: 'internal' });
  await privateEvidence(); expect(JSON.stringify(audit)).not.toContain(result.refreshJti);
});

it.each([
  ['audit-abort', "BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['audit-ignore', "BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN SELECT RAISE(IGNORE); END"],
  ['audit-delete', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END"],
  ['audit-rewrite', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN UPDATE audit_events SET session_sid = 'other' WHERE seq = NEW.seq; END"],
  ['insert-ignore', 'BEFORE INSERT ON sessions BEGIN SELECT RAISE(IGNORE); END'],
  ['overlong-lifetime', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN UPDATE sessions SET expires_at = datetime('now', '+99 days'); END"],
  ['role-change', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.login' BEGIN UPDATE users SET role = 'admin'; END"],
])('rolls back session creation on %s', async (_failure, sql) => {
  const before = await rows(); await fault(sql);
  await expect(createAuthSession(env, user)).rejects.toBeInstanceOf(SessionEvidenceUnavailableError);
  expect(await rows()).toEqual(before); expect(await events()).toEqual([]);
});

it('records an uncertain creation commit without returning or replaying its tokens', async () => {
  const uncertain = hook(async () => {}, true);
  await expect(createAuthSession({ ...env, DB: uncertain.DB }, user)).rejects.toBeInstanceOf(SessionEvidenceUnavailableError);
  expect(uncertain.count()).toBe(1); expect(await rows()).toHaveLength(2); expect(await events()).toHaveLength(1);
});

it('rechecks verified OAuth identity ownership before session creation', async () => {
  const identity = { provider: 'google', providerUserId: 'private-provider-subject', oauthId: 'google:private-provider-subject' };
  await env.DB.prepare('INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (?, ?, ?, ?)')
    .bind(user.id, identity.provider, identity.providerUserId, identity.oauthId).run();
  const changed = hook(() => env.DB.prepare('DELETE FROM user_oauth_identities').run());
  await expect(createAuthSession({ ...env, DB: changed.DB }, user, undefined, identity)).rejects.toBeInstanceOf(SessionEvidenceUnavailableError);
  expect(await rows()).toHaveLength(1); expect(await events()).toEqual([]);
});

it.each(['users', 'sessions', 'roles', 'role_permissions', 'user_oauth_identities'])('inherits %s classification on creation, rotation and revocation', async table => {
  await classify('phi', table);
  await createAuthSession(env, user);
  expect((await api('/auth/refresh')).status).toBe(200);
  expect((await api('/auth/logout')).status).toBe(302);
  expect((await events()).map(event => event.data_class)).toEqual(['phi', 'phi', 'phi']); await privateEvidence();
});

it('records a classified rotation with request attribution and no token material', async () => {
  await classify(); const before = await rows();
  const response = await api('/auth/refresh'); expect(response.status).toBe(200);
  const after = await rows(); expect(after[0].refresh_token_hash).not.toBe(before[0].refresh_token_hash);
  const audit = await events(); expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'auth.session.rotate', target_id: String(sid), actor_user_id: String(user.id), actor_roles: 'editor',
    session_sid: String(sid), data_class: 'phi', request_id: 'session-lifecycle-test', retention_class: 'auth' });
  expect(JSON.parse(String(audit[0].detail))).toEqual({ source: 'explicit-refresh' }); await privateEvidence();
});

it('uses durable rotation evidence for silent middleware refresh', async () => {
  const expired = await signJWT({ ...issued.accessPayload, exp: Math.floor(Date.now() / 1000) - 1 }, env.JWT_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://cms.example.com/admin/profile', {
    headers: { Cookie: `access_token=${expired}; refresh_token=${issued.refreshToken}`, 'CF-Ray': 'silent-refresh-test' },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx); expect(response.status).toBe(200);
  const audit = await events(); expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'auth.session.rotate', request_id: 'silent-refresh-test' });
  expect(JSON.parse(String(audit[0].detail))).toEqual({ source: 'silent-refresh' });
});

it.each([
  ['audit-abort', "BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['audit-ignore', "BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN SELECT RAISE(IGNORE); END"],
  ['audit-delete', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END"],
  ['audit-rewrite', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END"],
  ['update-ignore', 'BEFORE UPDATE ON sessions BEGIN SELECT RAISE(IGNORE); END'],
  ['bad-previous-token', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN UPDATE sessions SET previous_refresh_token_hash = 'other'; END"],
  ['overlong-lifetime', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN UPDATE sessions SET expires_at = datetime('now', '+99 days'); END"],
  ['role-change', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN UPDATE users SET role = 'admin'; END"],
  ['session-delete', "AFTER INSERT ON audit_events WHEN NEW.action = 'auth.session.rotate' BEGIN DELETE FROM sessions; END"],
])('refuses rotation without tokens and rolls back on %s', async (_failure, sql) => {
  const before = await rows(); await fault(sql);
  await unavailable(await api('/auth/refresh')); expect(await rows()).toEqual(before); expect(await events()).toEqual([]);
});

it.each(['revoked', 'expired', 'idle', 'absolute', 'role'])('does not revive a %s session changed before rotation executes', async state => {
  const changed = hook(() => env.DB.prepare(state === 'revoked' ? 'DELETE FROM sessions' : state === 'expired'
    ? "UPDATE sessions SET expires_at = datetime('now', '-1 second')" : state === 'idle'
      ? "UPDATE sessions SET created_at = datetime('now', '-2 days'), rotated_at = datetime('now', '-2 days')" : state === 'absolute'
        ? "UPDATE sessions SET created_at = datetime('now', '-31 days')" : "UPDATE users SET role = 'viewer'").run());
  await unavailable(await api('/auth/refresh', undefined, { DB: changed.DB }));
  expect(await events()).toEqual([]);
  if (state === 'revoked') expect(await rows()).toEqual([]);
});

it('supports a concurrent winner with separately audited access-only grace', async () => {
  const changed = hook(() => rotateAuthSession(env, issued.refreshToken));
  const response = await api('/auth/refresh', undefined, { DB: changed.DB });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie().join('\n')).not.toMatch(/(?:^|\n)(?:__Host-)?refresh_token=/);
  expect((await events()).map(row => row.action)).toEqual(['auth.session.rotate', 'auth.session.grace']);
});

it('keeps true parallel refreshes attributable without duplicate rotations', async () => {
  const results = await Promise.all([rotateAuthSession(env, issued.refreshToken), rotateAuthSession(env, issued.refreshToken)]);
  expect(results.every(result => result.ok)).toBe(true);
  expect(results.filter(result => result.ok && result.refreshToken)).toHaveLength(1);
  expect((await events()).map(row => row.action).sort()).toEqual(['auth.session.grace', 'auth.session.rotate']);
});

it('refuses grace access during an audit outage without extending the session', async () => {
  expect((await rotateAuthSession(env, issued.refreshToken)).ok).toBe(true);
  const before = await rows();
  await fault("BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.session.grace' BEGIN SELECT RAISE(IGNORE); END");
  await unavailable(await api('/auth/refresh')); expect(await rows()).toEqual(before);
  expect((await events()).map(row => row.action)).toEqual(['auth.session.rotate']);
});

it('does not reissue tokens on a lost acknowledgment of its own committed rotation', async () => {
  const uncertain = hook(async () => {}, true);
  await unavailable(await api('/auth/refresh', undefined, { DB: uncertain.DB }));
  expect(uncertain.count()).toBe(1); expect((await events()).map(row => row.action)).toEqual(['auth.session.rotate']);
  const response = await api('/auth/refresh'); expect(response.status).toBe(200);
  expect((await events()).map(row => row.action)).toEqual(['auth.session.rotate', 'auth.session.grace']);
});

it('enforces the refresh JWT subject during both rotation and revocation', async () => {
  const token = await signJWT({ ...issued.accessPayload, sub: '9999', type: 'refresh', jti: issued.refreshJti }, env.JWT_SECRET);
  expect((await api('/auth/refresh', `refresh_token=${token}`)).status).toBe(401);
  await revokeRefreshSession(env, token);
  expect(await rows()).toHaveLength(1); expect(await events()).toEqual([]);
});

it.each(['access', 'refresh', 'both'])('durably logs out using %s cookies, including refresh-only logout', async mode => {
  const cookies = [mode !== 'refresh' ? `access_token=${issued.accessToken}` : '', mode !== 'access' ? `refresh_token=${issued.refreshToken}` : ''].filter(Boolean).join('; ');
  const response = await api('/auth/logout', cookies); expect(response.status).toBe(302);
  expect(response.headers.getSetCookie().join('\n')).toContain('Max-Age=0'); expect(await rows()).toEqual([]);
  const audit = await events(); expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'auth.logout', actor_user_id: String(user.id), session_sid: String(sid), target_id: String(sid), request_id: 'session-lifecycle-test' });
  expect(await pending()).toEqual([]); await privateEvidence();
  expect((await api('/auth/logout', cookies)).status).toBe(302); expect(await events()).toHaveLength(1);
});

it('retains logout during a primary audit outage and recovers its original receipt later', async () => {
  await fault("BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'primary down'); END");
  expect((await api('/auth/logout')).status).toBe(302); expect(await rows()).toEqual([]);
  const evidence = await pending(); expect(evidence).toHaveLength(1); expect(await events()).toEqual([]); await privateEvidence();
  await env.DB.prepare(`DROP TRIGGER ${trigger}`).run(); await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect((await events())[0].event_id).toBe(evidence[0].event_id); expect(await pending()).toEqual([]);
});

it('preserves exact authenticated logout during regulated inventory/audit failure without admitting suffixes', async () => {
  await classify('pii');
  await fault("BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'primary down'); END");
  const overrides = { REGULATED_MODE: 'true', REGULATED_INVENTORY: '' };
  const ctx = createExecutionContext();
  const suffix = await worker.fetch(new Request('https://cms.example.com/auth/logout/extra', { method: 'POST',
    headers: { Cookie: `refresh_token=${issued.refreshToken}`, 'Sec-Fetch-Site': 'same-origin' },
  }), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); expect(suffix.status).toBe(503); expect(await rows()).toHaveLength(1);
  expect((await api('/auth/logout', undefined, overrides)).status).toBe(302);
  expect(await rows()).toEqual([]);
  const evidence = await pending(); expect(evidence).toHaveLength(1);
  expect(JSON.parse(String(evidence[0].envelope)).row).toMatchObject({ action: 'auth.logout', dataClass: 'phi' });
});

it('retains a durable regulated logout receipt when the primary audit table is unavailable', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO unavailable_primary_audit').run();
  try {
    const response = await api('/auth/logout', undefined, { REGULATED_MODE: 'true', REGULATED_INVENTORY: '' });
    expect(response.status).toBe(302); expect(await rows()).toEqual([]);
    const evidence = await pending(); expect(evidence).toHaveLength(1); expect(evidence[0].attempts).toBe(1);
  } finally { await env.DB.prepare('ALTER TABLE unavailable_primary_audit RENAME TO audit_events').run(); }
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect((await events())[0]).toMatchObject({ action: 'auth.logout', data_class: 'phi' });
});

it('revokes the stable session even if a concurrent refresh rotates its hash after logout authentication', async () => {
  let winner: Awaited<ReturnType<typeof rotateAuthSession>>;
  const changed = hook(async () => { winner = await rotateAuthSession(env, issued.refreshToken); });
  expect((await api('/auth/logout', undefined, { DB: changed.DB })).status).toBe(302);
  expect(await rows()).toEqual([]);
  expect((await events()).map(row => row.action)).toEqual(['auth.session.rotate', 'auth.logout']);
  if (!winner!.ok) throw new Error('Concurrent refresh did not win');
  expect(await validateAccessSession(env.DB, winner!.accessPayload)).toBeNull();
});

it.each(['invalid-class', 'unsafe-role'])('preserves conservative logout evidence under %s', async mode => {
  if (mode === 'invalid-class') await classify('invalid');
  else await env.DB.prepare("UPDATE users SET role = 'private-role@example.invalid'").run();
  expect((await api('/auth/logout')).status).toBe(302); expect(await rows()).toEqual([]);
  const audit = (await events())[0];
  expect(audit).toMatchObject({ data_class: mode === 'invalid-class' ? 'phi' : 'none', actor_roles: mode === 'unsafe-role' ? null : 'editor' });
  expect(JSON.parse(String(audit.detail))[mode === 'invalid-class' ? 'classification_unavailable' : 'roles_unavailable']).toBe(true);
  expect(JSON.stringify(audit)).not.toContain('private-role@example.invalid');
});

it.each(['create', 'rotate'])('denies %s on invalid classification without changing session state', async operation => {
  await classify('invalid'); const before = await rows();
  await expect(operation === 'create' ? createAuthSession(env, user) : rotateAuthSession(env, issued.refreshToken)).rejects.toBeInstanceOf(SessionEvidenceUnavailableError);
  expect(await rows()).toEqual(before); expect(await events()).toEqual([]);
});

it.each([
  ['outbox-ignore', 'BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END'],
  ['outbox-delete', 'AFTER INSERT ON audit_mutation_outbox BEGIN DELETE FROM audit_mutation_outbox WHERE event_id = NEW.event_id; END'],
  ['delete-ignore', 'BEFORE DELETE ON sessions BEGIN SELECT RAISE(IGNORE); END'],
  ['session-reappears', `AFTER INSERT ON audit_mutation_outbox BEGIN INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (${sid}, ${user.id}, 'unexpected', datetime('now', '+1 day')); END`],
])('does not commit an unrecorded logout on %s; local cookies still clear', async (_failure, sql) => {
  const before = await rows(); await fault(sql);
  const response = await api('/auth/logout'); await unavailable(response);
  expect(response.headers.getSetCookie().join('\n')).toContain('Max-Age=0');
  expect(await rows()).toEqual(before); expect(await events()).toEqual([]); expect(await pending()).toEqual([]);
});

it('retains the outbox receipt after an uncertain committed logout without replay', async () => {
  const uncertain = hook(async () => {}, true);
  await unavailable(await api('/auth/logout', undefined, { DB: uncertain.DB }));
  expect(uncertain.count()).toBe(1); expect(await rows()).toEqual([]); expect(await pending()).toHaveLength(1);
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect((await api('/auth/logout')).status).toBe(302); expect(await events()).toHaveLength(1);
});

it('records every session removed by the concurrency cap', async () => {
  for (let index = 0; index < 7; index++) await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").bind(user.id, `synthetic-cap-${index}`).run();
  expect(await capUserSessions(env, user.id)).toBe(3);
  expect(await rows()).toHaveLength(5);
  expect(await pending()).toHaveLength(3);
  await drainAuditMutationOutbox(env);
  const audit = await events(); expect(audit).toHaveLength(3);
  expect(audit.every(row => row.action === 'auth.session.cap' && row.acting_via === 'system:session-maintenance' && row.actor_user_id === null && row.session_sid === null)).toBe(true);
  expect(new Set(audit.map(row => row.target_id)).size).toBe(3); await privateEvidence();
});

it('purges at most 50 expired sessions per sweep and retains each receipt during an audit outage', async () => {
  for (let index = 0; index < 51; index++) await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 day'))").bind(user.id, `synthetic-expired-${index}`).run();
  await fault("BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'primary down'); END");
  expect(await purgeExpiredSessions(env)).toBe(50); expect(await rows()).toHaveLength(2); expect(await pending()).toHaveLength(50);
  expect(await purgeExpiredSessions(env)).toBe(1); expect(await rows()).toHaveLength(1); expect(await pending()).toHaveLength(51);
  expect((await pending()).every(row => JSON.parse(String(row.envelope)).row.action === 'auth.session.expire')).toBe(true);
});

it('does not purge a concurrently refreshed session from a stale expiry snapshot', async () => {
  await env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 second')").run();
  const changed = hook(() => env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '+1 day'), rotated_at = CURRENT_TIMESTAMP").run());
  await expect(purgeExpiredSessions({ ...env, DB: changed.DB })).rejects.toBeInstanceOf(SessionEvidenceUnavailableError);
  expect(await rows()).toHaveLength(1); expect(await events()).toEqual([]);
});

it('revisits bounded over-limit account backlog during later hygiene ticks', async () => {
  for (let index = 0; index < 56; index++) await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .bind(user.id, `synthetic-cap-backlog-${index}`).run();
  await maintainSessionHygiene(env); expect(await rows()).toHaveLength(7);
  await maintainSessionHygiene(env); expect(await rows()).toHaveLength(5);
  expect(await pending()).toHaveLength(52);
});

it('records the complete session revocation set inside atomic user deletion evidence', async () => {
  await classify();
  const access = await signFixtureJWT({ sub: '9700', email: 'operator@example.invalid', name: 'Operator', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com/admin/users/${user.id}/delete`, { method: 'POST',
    headers: { Cookie: `access_token=${access}`, 'Sec-Fetch-Site': 'same-origin' },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx); expect(response.status).toBe(302);
  expect(await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(user.id).all()).toMatchObject({ results: [] });
  const event = await env.DB.prepare("SELECT detail, data_class FROM audit_events WHERE action = 'user.delete'").first();
  expect(event?.data_class).toBe('phi'); expect(JSON.parse(String(event?.detail))).toEqual({ role_before: 'editor', revoked_session_ids: [sid] });
});
