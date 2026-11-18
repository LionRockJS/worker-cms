import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { rotateAuthSession, validateAccessSession, createAuthSession } from '../src/core/auth/sessions';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { auditMutationOutboxHealth, drainAuditMutationOutbox } from '../src/core/db/audit-mutation-outbox';
import { auditDeliveryEvidence } from '../src/core/db/audit';
import type { Env } from '../src/types';

const userId = 9001;
let cookie = '';
let primary = 0;
let secondary = 0;
let requestNumber = 0;
const triggers = ['self_audit_fault', 'self_mutation_fault'];

beforeEach(async () => {
  clearRolePermissionsCache();
  for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['audit_mutation_outbox', 'audit_events', 'data_classes', 'sessions', 'user_oauth_identities', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, 'eventuai:private-subject', 'private@example.invalid', 'Private old name', 'private-avatar', 'viewer')").bind(userId).run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (?, 'eventuai', 'private-subject', 'eventuai:private-subject')").bind(userId).run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (?, 'google', 'private-secondary', 'google:private-secondary')").bind(userId).run();
  const identities = (await links()); primary = Number(identities[0].id); secondary = Number(identities[1].id);
  const issued = await createAuthSession(env, { id: userId, email: 'private@example.invalid', name: 'Private old name', role: 'viewer' });
  cookie = `access_token=${issued.accessToken}`;
});
afterEach(async () => { for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run(); });

async function call(path: string, body = new URLSearchParams(), overrides: Partial<Env> = {}, authenticated = true) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, { method: 'POST', body,
    headers: { Cookie: authenticated ? cookie : '', 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin',
      'CF-Ray': 'self-profile-mutation', 'CF-Connecting-IP': `10.84.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
const edit = (overrides: Partial<Env> = {}) => call('/admin/profile', new URLSearchParams({ name: 'New private name', id: '2', role: 'admin' }), overrides);
const disconnect = (identity = primary, overrides: Partial<Env> = {}) => call(`/admin/profile/identities/${identity}/disconnect`, undefined, overrides);
async function account() { return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first(); }
async function links() { return (await env.DB.prepare('SELECT * FROM user_oauth_identities ORDER BY id').all()).results; }
async function outbox() { return (await env.DB.prepare('SELECT * FROM audit_mutation_outbox ORDER BY event_id').all()).results; }
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('profile.update', 'user.oauth-disconnect') ORDER BY seq").all()).results; }
async function classify(table: string, dataClass = 'phi') {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', ?, ?)").bind(table, dataClass).run();
}
async function fault(sql: string, name = triggers[0]) { await env.DB.prepare(`CREATE TRIGGER ${name} ${sql}`).run(); }
async function pending() {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.action = 'user.oauth-disconnect' BEGIN SELECT RAISE(ABORT, 'primary audit unavailable'); END");
  expect((await disconnect()).status).toBe(302);
  const item = (await outbox())[0]; expect(item).toBeTruthy();
  return item;
}
function privateValuesAbsent(value: unknown) {
  for (const privateValue of ['private@example.invalid', 'Private old name', 'New private name', 'private-avatar', 'private-subject', 'private-secondary']) {
    expect(JSON.stringify(value)).not.toContain(privateValue);
  }
}
function hook(before: () => Promise<unknown>, lostAcknowledgment = false) {
  let count = 0;
  const DB = { withSession: () => DB, prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
    count++;
    if (count === 1) await before();
    const result = await env.DB.batch(statements);
    if (count === 1 && lostAcknowledgment) throw new Error('Synthetic lost commit acknowledgment');
    return result;
  } };
  return { DB, count: () => count };
}

it.each(['none', 'pii', 'phi'])('atomically edits only the display name with %s evidence and no profile values', async dataClass => {
  if (dataClass !== 'none') await classify('users', dataClass);
  expect((await edit()).status).toBe(303);
  expect(await account()).toMatchObject({ name: 'New private name', role: 'viewer', email: 'private@example.invalid' });
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'profile.update', target_id: String(userId), actor_user_id: String(userId), actor_roles: 'viewer',
    data_class: dataClass, event_class: 'admin', retention_class: 'admin_config', request_id: 'self-profile-mutation' });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ classification_policy_version: expect.any(Number), fields: ['name'] });
  privateValuesAbsent(rows);
});

it('does not write another profile event for an unchanged submitted name', async () => {
  await edit(); const before = await events();
  await fault('BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, \'no update expected\'); END');
  expect((await edit()).status).toBe(303); expect(await events()).toEqual(before);
});

it.each([
  ['audit-abort', "BEFORE INSERT ON audit_events WHEN NEW.action = 'profile.update' BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['audit-ignore', "BEFORE INSERT ON audit_events WHEN NEW.action = 'profile.update' BEGIN SELECT RAISE(IGNORE); END"],
  ['audit-delete', "AFTER INSERT ON audit_events WHEN NEW.action = 'profile.update' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END"],
  ['audit-rewrite', "AFTER INSERT ON audit_events WHEN NEW.action = 'profile.update' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END"],
  ['update-ignore', 'BEFORE UPDATE ON users BEGIN SELECT RAISE(IGNORE); END'],
  ['after-audit-state-change', "AFTER INSERT ON audit_events WHEN NEW.action = 'profile.update' BEGIN UPDATE users SET role = 'admin'; END"],
])('rolls back a profile edit on %s', async (_failure, sql) => {
  const before = await account(); await fault(sql);
  const response = await edit(); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await account()).toEqual(before); expect(await events()).toEqual([]);
});

it.each(['invalid-class', 'unsafe-role'])('refuses a profile edit under %s', async mode => {
  if (mode === 'invalid-class') await classify('users', 'invalid');
  else await env.DB.prepare("UPDATE users SET role = 'person@example.invalid' WHERE id = ?").bind(userId).run();
  const before = await account(); expect((await edit()).status).toBe(503);
  expect(await account()).toEqual(before); expect(await events()).toEqual([]);
});

it.each(['role', 'session'])('refuses a profile edit if its %s changes before commit', async mode => {
  const changed = hook(() => env.DB.prepare(mode === 'role' ? "UPDATE users SET role = 'editor' WHERE id = ?" : 'DELETE FROM sessions WHERE user_id = ?').bind(userId).run());
  expect((await edit({ DB: changed.DB })).status).toBe(503);
  expect(await account()).toMatchObject({ name: 'Private old name' }); expect(await events()).toEqual([]);
});

it('does not allow anonymous profile edits or identity removal', async () => {
  const before = await account(); const identities = await links();
  expect((await call('/admin/profile', new URLSearchParams({ name: 'Intruder' }), {}, false)).headers.get('Location')).toBe('/auth/login');
  expect((await call(`/admin/profile/identities/${primary}/disconnect`, undefined, {}, false)).headers.get('Location')).toBe('/auth/login');
  expect(await account()).toEqual(before); expect(await links()).toEqual(identities);
});

it.each([true, false])('atomically removes an identity, primary=%s, with exact private evidence', async removePrimary => {
  await classify('user_oauth_identities');
  const identity = removePrimary ? primary : secondary;
  expect((await disconnect(identity)).status).toBe(302);
  expect((await links()).map(row => row.id)).toEqual([removePrimary ? secondary : primary]);
  expect(await account()).toMatchObject({ oauth_id: removePrimary ? 'google:private-secondary' : 'eventuai:private-subject' });
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'user.oauth-disconnect', target_id: String(identity), actor_user_id: String(userId), actor_roles: 'viewer', data_class: 'phi' });
  expect(JSON.parse(String(rows[0].detail))).toEqual({ user_id: String(userId), primary_replaced: removePrimary,
    replacement_identity_id: removePrimary ? secondary : null, classification_unavailable: false, roles_unavailable: false });
  expect(await outbox()).toEqual([]); privateValuesAbsent(rows);
});

it('preserves revocation when the primary audit stream is unavailable and later drains the exact event', async () => {
  const item = await pending();
  expect((await links()).map(row => row.id)).toEqual([secondary]);
  expect(await account()).toMatchObject({ oauth_id: 'google:private-secondary' });
  expect(await events()).toEqual([]); privateValuesAbsent(item);
  expect(item.attempts).toBe(1);
  await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  const result = await drainAuditMutationOutbox(env);
  expect(result).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
  expect(await outbox()).toEqual([]);
  expect((await events())[0]).toMatchObject({ event_id: item.event_id });
  expect((await drainAuditMutationOutbox(env)).attempted).toBe(0);
});

it.each(['invalid-class', 'unsafe-role'])('keeps conservative revocation evidence under %s', async mode => {
  if (mode === 'invalid-class') await classify('users', 'invalid');
  else await env.DB.prepare("UPDATE users SET role = 'person@example.invalid' WHERE id = ?").bind(userId).run();
  expect((await disconnect()).status).toBe(302);
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ data_class: 'phi', actor_roles: mode === 'unsafe-role' ? null : 'viewer' });
  expect(JSON.parse(String(rows[0].detail))[mode === 'invalid-class' ? 'classification_unavailable' : 'roles_unavailable']).toBe(true);
  privateValuesAbsent(rows); expect(JSON.stringify(rows)).not.toContain('person@example.invalid');
});

it.each([
  ['outbox-abort', "BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(ABORT, 'outage'); END"],
  ['outbox-ignore', 'BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END'],
  ['outbox-delete', 'AFTER INSERT ON audit_mutation_outbox BEGIN DELETE FROM audit_mutation_outbox WHERE event_id = NEW.event_id; END'],
  ['outbox-rewrite', "AFTER INSERT ON audit_mutation_outbox BEGIN UPDATE audit_mutation_outbox SET envelope = json_set(envelope, '$.actor.userId', 'other') WHERE event_id = NEW.event_id; END"],
  ['delete-ignore', 'BEFORE DELETE ON user_oauth_identities BEGIN SELECT RAISE(IGNORE); END'],
  ['primary-update-ignore', 'BEFORE UPDATE ON users BEGIN SELECT RAISE(IGNORE); END'],
  ['remaining-identity-delete', 'AFTER INSERT ON audit_mutation_outbox BEGIN DELETE FROM user_oauth_identities; END'],
  ['session-revoked', 'AFTER INSERT ON audit_mutation_outbox BEGIN DELETE FROM sessions; END'],
])('rolls back both primary rotation and disconnection on %s', async (_failure, sql) => {
  const before = await account(); const identities = await links(); await fault(sql);
  expect((await disconnect()).status).toBe(503);
  expect(await account()).toEqual(before); expect(await links()).toEqual(identities); expect(await outbox()).toEqual([]); expect(await events()).toEqual([]);
});

it('preserves the final sign-in method and refuses identities owned by another user', async () => {
  await env.DB.prepare('DELETE FROM user_oauth_identities WHERE id = ?').bind(secondary).run();
  expect((await disconnect()).headers.get('Location')).toContain('At+least+one');
  expect((await disconnect(secondary)).headers.get('Location')).toContain('Identity+not+found');
  expect((await links()).map(row => row.id)).toEqual([primary]); expect(await events()).toEqual([]);
});

it('refuses a stale disconnection snapshot if another method is removed concurrently', async () => {
  const changed = hook(() => env.DB.prepare('DELETE FROM user_oauth_identities WHERE id = ?').bind(secondary).run());
  expect((await disconnect(primary, { DB: changed.DB })).status).toBe(503);
  expect((await links()).map(row => row.id)).toEqual([primary]); expect(await account()).toMatchObject({ oauth_id: 'eventuai:private-subject' });
  expect(await events()).toEqual([]);
});

it('recovers an uncertain committed disconnection without replaying the removal', async () => {
  const uncertain = hook(async () => {}, true);
  expect((await disconnect(primary, { DB: uncertain.DB })).status).toBe(503);
  expect(uncertain.count()).toBe(1); expect((await links()).map(row => row.id)).toEqual([secondary]);
  const saved = (await outbox())[0]; expect(saved).toBeTruthy();
  expect((await disconnect()).headers.get('Location')).toContain('Identity+not+found');
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect((await events())[0].event_id).toBe(saved.event_id); expect(await events()).toHaveLength(1);
});

it('uses backoff and retains exhausted evidence for operator reconciliation', async () => {
  const item = await pending();
  expect((await drainAuditMutationOutbox(env)).attempted).toBe(0);
  for (let attempt = 1; attempt < 8; attempt++) {
    await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
    expect((await drainAuditMutationOutbox(env)).failed).toBe(1);
  }
  expect(await auditMutationOutboxHealth(env)).toMatchObject({ pending: 1, exhausted: 1 });
  expect((await drainAuditMutationOutbox(env)).attempted).toBe(0);
  expect((await outbox())[0]).toMatchObject({ event_id: item.event_id, attempts: 8 });
});

it('does not discard outbox evidence when the same event ID has conflicting primary contents', async () => {
  const item = await pending();
  await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome) VALUES (?, '2000-01-01', 'admin', 'none', 'admin_config', 'conflict', 'success')").bind(item.event_id).run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).failed).toBe(1);
  expect(await outbox()).toHaveLength(1); expect(await events()).toEqual([]);
});

it.each(['action', 'detail', 'request'])('retains malformed %s evidence for review without delivering it', async field => {
  await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  const path = field === 'action' ? '$.row.action' : field === 'detail' ? '$.row.detail.unapproved' : '$.request.unapproved';
  await env.DB.prepare('UPDATE audit_mutation_outbox SET envelope = json_set(envelope, ?, ?), next_attempt_at = 0')
    .bind(path, 'unapproved-value').run();
  expect((await drainAuditMutationOutbox(env)).failed).toBe(1);
  expect(await outbox()).toHaveLength(1); expect(await events()).toEqual([]);
});

it('finishes delivery when the exact primary receipt already exists', async () => {
  const item = await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await auditDeliveryEvidence(env, JSON.parse(String(item.envelope))).write.run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect(await outbox()).toEqual([]); expect(await events()).toHaveLength(1);
});

it('delivers at most 50 pending events in one sweep', async () => {
  const item = await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  const original = JSON.parse(String(item.envelope));
  for (let index = 0; index < 50; index++) {
    const envelope = { ...original, row: { ...original.row, eventId: crypto.randomUUID() } };
    await env.DB.prepare('INSERT INTO audit_mutation_outbox (event_id, envelope) VALUES (?, ?)').bind(envelope.row.eventId, JSON.stringify(envelope)).run();
  }
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(50);
  expect(await auditMutationOutboxHealth(env)).toMatchObject({ pending: 1 });
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
});

it('retries audit delivery during scheduled maintenance before regulated admission', async () => {
  await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  const ctx = createExecutionContext();
  await expect(worker.scheduled({} as ScheduledController, { ...env, REGULATED_MODE: 'true', REGULATED_INVENTORY: '' }, ctx)).rejects.toThrow();
  await waitOnExecutionContext(ctx);
  expect(await outbox()).toEqual([]); expect(await events()).toHaveLength(1);
});

it('drains concurrently without duplicate primary events or lost evidence', async () => {
  await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  await Promise.all([drainAuditMutationOutbox(env), drainAuditMutationOutbox(env)]);
  expect(await events()).toHaveLength(1); expect(await outbox()).toEqual([]);
});

it('rolls back delivery if an outbox-delete trigger corrupts the primary receipt', async () => {
  await pending(); await env.DB.prepare('DROP TRIGGER self_audit_fault').run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  await fault("AFTER DELETE ON audit_mutation_outbox BEGIN DELETE FROM audit_events WHERE event_id = OLD.event_id; END");
  expect((await drainAuditMutationOutbox(env)).failed).toBe(1);
  expect(await outbox()).toHaveLength(1); expect(await events()).toEqual([]);
});

it('applies the existing-installation outbox upgrade idempotently without altering accounts', async () => {
  const before = await account(); const identities = await links();
  await env.DB.prepare('DROP TABLE audit_mutation_outbox').run();
  expect(env.TEST_AUDIT_OUTBOX_UPGRADE).toHaveLength(1);
  await applyD1Migrations(env.DB, env.TEST_AUDIT_OUTBOX_UPGRADE);
  await applyD1Migrations(env.DB, env.TEST_AUDIT_OUTBOX_UPGRADE.map(migration => ({ ...migration, name: `again-${migration.name}` })));
  expect(await auditMutationOutboxHealth(env)).toMatchObject({ pending: 0, exhausted: 0 });
  expect(await account()).toEqual(before); expect(await links()).toEqual(identities);
});

const ownAvatar = 'data:image/png;base64,iVBORw0KGgo=';
const setAvatar = (avatar: string) => call('/admin/profile/avatar', new URLSearchParams({ avatar }));
it('saves, audits and removes a user-chosen profile picture', async () => {
  expect((await setAvatar(ownAvatar)).headers.get('Location')).toBe('/admin/profile?flash=profile.avatar_saved');
  expect((await account())!.avatar_url).toBe(ownAvatar);
  const saved = await events();
  expect(saved).toHaveLength(1);
  expect(JSON.parse(String(saved[0].detail)).fields).toEqual(['avatar_url']);
  expect(String(saved[0].detail)).not.toContain('iVBOR');
  expect((await setAvatar('')).headers.get('Location')).toBe('/admin/profile?flash=profile.avatar_removed');
  expect((await account())!.avatar_url).toBe('');
});
it.each(['https://example.invalid/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(64 * 1024)}`])(
  'refuses a profile picture that is not a small inline PNG/JPEG', async avatar => {
    expect((await setAvatar(avatar)).headers.get('Location')).toBe('/admin/profile?error=profile.invalid_avatar');
    expect((await account())!.avatar_url).toBe('private-avatar');
    expect(await events()).toEqual([]);
  });

const disable = (overrides: Partial<Env> = {}) => call('/admin/profile/disable', new URLSearchParams({ confirm: 'disable', id: '2' }), overrides);

it('disables only the current account, releases every identity and revokes every session', async () => {
  const before = await account();
  const issued = await createAuthSession(env, { id: userId, email: 'private@example.invalid', name: 'Private old name', role: 'viewer' });
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email) VALUES (9002, 'google:other', 'other@example.invalid')").run();
  const response = await disable();
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('/auth/login');
  expect(response.headers.get('Set-Cookie')).toContain('access_token=;');
  expect(await account()).toMatchObject({ email: before!.email, name: before!.name, role: before!.role, disabled_at: expect.any(String) });
  expect((await account())!.oauth_id).not.toBe(before!.oauth_id);
  expect(await links()).toEqual([]);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(userId).first()).toEqual({ n: 0 });
  expect(await validateAccessSession(env.DB, issued.accessPayload, 86400)).toBeNull();
  expect((await rotateAuthSession(env, issued.refreshToken)).ok).toBe(false);
  await expect(createAuthSession(env, { id: userId, email: 'private@example.invalid', name: 'Private old name', role: 'viewer' })).rejects.toThrow();
  expect(await env.DB.prepare('SELECT disabled_at FROM users WHERE id = 9002').first()).toEqual({ disabled_at: null });
  const audit = await env.DB.prepare("SELECT * FROM audit_events WHERE action = 'user.disable'").first();
  expect(audit).toMatchObject({ target_id: String(userId), actor_user_id: String(userId), data_class: 'phi' });
  privateValuesAbsent(audit);
});

it('requires an authenticated session and explicit acknowledgment to disable', async () => {
  const before = await account();
  expect((await call('/admin/profile/disable')).status).toBe(303);
  expect((await call('/admin/profile/disable', new URLSearchParams({ confirm: 'disable' }), {}, false)).status).toBe(302);
  expect(await account()).toEqual(before);
});

it('commits disabling during a primary audit outage with durable pending evidence', async () => {
  await fault("BEFORE INSERT ON audit_events WHEN NEW.action = 'user.disable' BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
  expect((await disable()).status).toBe(303);
  expect((await account())!.disabled_at).toEqual(expect.any(String));
  expect(await outbox()).toHaveLength(1);
  await env.DB.prepare(`DROP TRIGGER ${triggers[0]}`).run();
  await env.DB.prepare('UPDATE audit_mutation_outbox SET next_attempt_at = 0').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
});

it.each([
  'BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END',
  'BEFORE DELETE ON user_oauth_identities BEGIN SELECT RAISE(IGNORE); END',
  'BEFORE DELETE ON sessions BEGIN SELECT RAISE(IGNORE); END',
  'BEFORE UPDATE ON users BEGIN SELECT RAISE(IGNORE); END',
])('rolls back disabling when a required mutation or receipt is ignored: %s', async sql => {
  const before = await account(); const identities = await links();
  await fault(sql);
  expect((await disable()).status).toBe(503);
  expect(await account()).toEqual(before); expect(await links()).toEqual(identities);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(userId).first()).toEqual({ n: 1 });
});

it('rejects disabled accounts even if a legacy session row remains', async () => {
  const issued = await createAuthSession(env, { id: userId, email: 'private@example.invalid', name: 'Private old name', role: 'viewer' });
  await env.DB.prepare('UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?').bind(userId).run();
  expect(await validateAccessSession(env.DB, issued.accessPayload, 86400)).toBeNull();
  expect((await rotateAuthSession(env, issued.refreshToken)).ok).toBe(false);
  expect((await disable()).status).toBe(302);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(userId).first()).toEqual({ n: 2 });
});
