import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { PERMISSIONS, type Env } from '../src/types';
import { signJWT } from './auth-fixtures';
import { verifyJWT } from '../src/core/auth/jwt';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { captureAccessAuthorization } from '../src/core/auth/access-authorization';
import { auditEvidence, mutationAuditEvidence, roleRemovalAuditEvidence } from '../src/core/db/audit';
import { deleteCustomRole, readRolePermissionSnapshot, saveRolePermissions } from '../src/core/auth/role-store';
import { Hono } from 'hono';
import type { Variables } from '../src/types';
import { drainAuditMutationOutbox } from '../src/core/db/audit-mutation-outbox';

const actorId = 9901;
const targetId = 9902;
const targetRole = 'care';
let cookie = '';
let counter = 0;
const triggers = ['access_denial_fault', 'access_outbox_fault'];

beforeEach(async () => {
  clearRolePermissionsCache();
  for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['audit_mutation_outbox', 'audit_events', 'data_classes', 'sessions', 'user_oauth_identities', 'users', 'role_permissions', 'roles']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await role('delegated', ['users:manage', 'roles:manage', 'content:read']);
  await role(targetRole, ['content:read']);
  await role('protected', ['plugin:manage']);
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, 'fixture:target', 'private-target@example.invalid', 'Private Target', ?)").bind(targetId, targetRole).run();
  await login('delegated');
});
afterEach(async () => { for (const trigger of triggers) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run(); });

async function role(name: string, grants: string[]) {
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind(name, `Private label ${name}`).run();
  for (const permission of grants) await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(name, permission).run();
}
async function login(value: string) {
  cookie = `access_token=${await signJWT({ sub: String(actorId), email: 'private-operator@example.invalid', name: 'Private Operator', role: value,
    type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET)}`;
}
async function call(path: string, body: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  counter++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, { method: 'POST', body: new URLSearchParams(body),
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin',
      'CF-Ray': 'access-authority-test', 'CF-Connecting-IP': `10.87.${Math.floor(counter / 250)}.${counter % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function successes() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('user.roles', 'user.delete', 'role.create', 'role.update', 'role.delete') AND outcome = 'success'").all()).results; }
async function denials() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE action = 'permission.denied' AND outcome = 'denied'").all()).results; }
async function target() { return env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(targetId).first(); }
async function grants(name = targetRole) { return (await env.DB.prepare('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission').bind(name).all()).results; }
async function pending() { return (await env.DB.prepare('SELECT * FROM audit_mutation_outbox').all()).results; }
function privateValuesAbsent(value: unknown) {
  for (const marker of ['private-target@example.invalid', 'Private Target', 'private-operator@example.invalid', 'Private Operator', 'Private label', 'Private submitted label']) expect(JSON.stringify(value)).not.toContain(marker);
}

const operations = {
  'user.roles': () => call(`/admin/users/${targetId}`, { roles: 'viewer' }),
  'user.delete': () => call(`/admin/users/${targetId}/delete`),
  'role.create': () => call('/admin/roles', { name: 'new-care', label: 'Private submitted label' }),
  'role.update': () => call(`/admin/roles/${targetRole}`, { label: 'Private submitted label', permissions: 'content:read' }),
  'role.delete': () => call(`/admin/roles/${targetRole}/delete`),
};
type Operation = keyof typeof operations;
const invoke = (operation: Operation, overrides: Partial<Env>) => operation === 'user.roles' ? call(`/admin/users/${targetId}`, { roles: 'viewer' }, overrides)
  : operation === 'user.delete' ? call(`/admin/users/${targetId}/delete`, {}, overrides)
    : operation === 'role.create' ? call('/admin/roles', { name: 'new-care', label: 'Private submitted label' }, overrides)
      : operation === 'role.update' ? call(`/admin/roles/${targetRole}`, { label: 'Private submitted label', permissions: 'content:read' }, overrides)
        : call(`/admin/roles/${targetRole}/delete`, {}, overrides);

/** Track only SQL supplied by the application. Inject changes at the exact
 * write batch, not its earlier snapshot or protected-read evidence batches. */
function inject(beforeWrite: () => Promise<unknown>, beforeSnapshot?: () => Promise<unknown>) {
  const statements = new WeakMap<D1PreparedStatement, { sql: string; actual: D1PreparedStatement }>();
  let injected = false;
  let captured = false;
  function track(actual: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(actual, { get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => track(actual.bind(...values), sql);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    statements.set(proxy, { sql, actual }); return proxy;
  }
  const DB = { withSession: () => DB, prepare: (sql: string) => track(env.DB.prepare(sql), sql), batch: async (items: D1PreparedStatement[]) => {
    const sql = items.map(item => statements.get(item)?.sql ?? '');
    if (!captured && sql.some(value => value === 'SELECT name, builtin, ip_allowlist FROM roles ORDER BY name')) { captured = true; if (beforeSnapshot) await beforeSnapshot(); }
    if (!injected && sql.some(value => /^(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM) (?:users|roles|role_permissions)\b/.test(value))) { injected = true; await beforeWrite(); }
    return env.DB.batch(items.map(item => statements.get(item)?.actual ?? item));
  } };
  return { DB, injected: () => injected };
}

it.each(Object.keys(operations) as Operation[])('permits %s under a current delegated authority snapshot with durable evidence', async operation => {
  expect((await operations[operation]()).status).toBe(302);
  expect((await successes()).some(row => row.action === operation)).toBe(true);
});

for (const operation of Object.keys(operations) as Operation[]) {
  it.each(['grant-revoked', 'actor-demoted', 'session-revoked', 'ip-policy-changed', 'same-count-policy-swap'])(`refuses ${operation} if %s changes before the write batch`, async change => {
    const before = await target(); const beforeGrants = await grants();
    const capability = operation.startsWith('user.') ? 'users:manage' : 'roles:manage';
    const changed = inject(async () => {
      if (change === 'grant-revoked') await env.DB.prepare('DELETE FROM role_permissions WHERE role = ? AND permission = ?').bind('delegated', capability).run();
      else if (change === 'actor-demoted') await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").bind(actorId).run();
      else if (change === 'session-revoked') await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(actorId).run();
      else if (change === 'ip-policy-changed') await env.DB.prepare("UPDATE roles SET ip_allowlist = '[\"203.0.113.1\"]' WHERE name = 'delegated'").run();
      else await env.DB.prepare("UPDATE role_permissions SET permission = 'plugin:manage' WHERE role = 'delegated' AND permission = ?").bind(capability).run();
    });
    expect((await invoke(operation, { DB: changed.DB })).status).toBe(503); expect(changed.injected()).toBe(true);
    expect(await successes()).toEqual([]); expect(await target()).toEqual(before); expect(await grants()).toEqual(beforeGrants);
    expect(await env.DB.prepare("SELECT name FROM roles WHERE name = 'new-care'").first()).toBeNull();
  });
}

it.each(['user.roles', 'role.create'] as Operation[])('records a permission removed before the fresh %s snapshot as an explicit refusal', async operation => {
  const capability = operation.startsWith('user.') ? 'users:manage' : 'roles:manage';
  const changed = inject(async () => {}, () => env.DB.prepare('DELETE FROM role_permissions WHERE role = ? AND permission = ?').bind('delegated', capability).run());
  expect((await invoke(operation, { DB: changed.DB })).status).toBe(403); expect(changed.injected()).toBe(false);
  expect(await successes()).toEqual([]);
  expect(JSON.parse(String((await denials())[0].detail)).reason).toBe('management_permission_changed');
});

it.each(['expires_at', 'created_at'])('refuses access mutation after the authorizing session %s expires', async field => {
  const changed = inject(() => env.DB.prepare(`UPDATE sessions SET ${field} = datetime('now', '${field === 'expires_at' ? '-1 second' : '-31 days'}') WHERE user_id = ?`).bind(actorId).run());
  expect((await invoke('role.create', { DB: changed.DB })).status).toBe(503); expect(await successes()).toEqual([]);
});

it('refuses stale delegated authority when the target role gains a stronger permission', async () => {
  const changed = inject(() => env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES ('care', 'plugin:manage')").run());
  expect((await invoke('user.roles', { DB: changed.DB })).status).toBe(503);
  expect(await target()).toEqual({ role: targetRole }); expect(await successes()).toEqual([]);
});

it('refuses a snapshot when a previously implicit built-in becomes managed', async () => {
  const changed = inject(() => env.DB.prepare("INSERT INTO roles (name, label, builtin) VALUES ('viewer', 'Viewer', 1)").run());
  expect((await invoke('user.roles', { DB: changed.DB })).status).toBe(503); expect(await successes()).toEqual([]);
});

it('uses freshly captured target grants rather than the initial permission-cache snapshot', async () => {
  const changed = inject(async () => {}, () => env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES ('care', 'plugin:manage')").run());
  expect((await invoke('role.update', { DB: changed.DB })).status).toBe(403);
  expect(changed.injected()).toBe(false); expect(await successes()).toEqual([]);
  expect(JSON.parse(String((await denials())[0].detail)).reason).toBe('grant_exceeds_authority');
});

it('does not deny an authorized reduction because an earlier cached target had more grants', async () => {
  const changed = inject(async () => {}, () => env.DB.prepare("DELETE FROM role_permissions WHERE permission = 'content:read' AND role IN ('delegated', 'care')").run());
  expect((await call('/admin/roles/care', { label: 'Reduced role' }, { DB: changed.DB })).status).toBe(302);
  expect(await grants()).toEqual([]); expect((await successes())[0].action).toBe('role.update');
});

it('permits an authorized self-demotion while retaining the pre-mutation actor in evidence', async () => {
  await login('admin');
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, role) VALUES (9903, 'fixture:other-admin', 'other-admin@example.invalid', 'admin')").run();
  expect((await call(`/admin/users/${actorId}`, { roles: 'viewer' })).status).toBe(302);
  expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(actorId).first()).toEqual({ role: 'viewer' });
  expect((await successes())[0]).toMatchObject({ action: 'user.roles', actor_roles: 'admin' });
});

it('permits reducing the actor role grants and applies the reduction on the next request', async () => {
  expect((await call('/admin/roles/delegated', { permissions: 'content:read' })).status).toBe(302);
  expect(await grants('delegated')).toEqual([{ permission: 'content:read' }]);
  expect((await call('/admin/roles', { name: 'not-authorized', label: 'Not authorized' })).status).toBe(403);
  expect(await env.DB.prepare("SELECT name FROM roles WHERE name = 'not-authorized'").first()).toBeNull();
});

it.each([
  ['target-role', 'target_role_exceeds_authority'], ['requested-role', 'requested_role_exceeds_authority'],
  ['target-delete', 'target_role_exceeds_authority'], ['target-grants', 'grant_exceeds_authority'],
  ['requested-grants', 'grant_exceeds_authority'], ['role-delete', 'grant_exceeds_authority'],
  ['locked', 'locked_role'], ['builtin', 'builtin_role'], ['self', 'self_deletion'],
])('durably records the %s object-policy refusal without private role/form metadata', async (kind, reason) => {
  let response: Response;
  if (kind === 'target-role' || kind === 'target-delete') {
    await env.DB.prepare("UPDATE users SET role = 'protected' WHERE id = ?").bind(targetId).run();
    response = await call(`/admin/users/${targetId}${kind === 'target-delete' ? '/delete' : ''}`, { roles: 'viewer' });
  } else if (kind === 'requested-role') response = await call(`/admin/users/${targetId}`, { roles: 'admin' });
  else if (kind === 'target-grants' || kind === 'role-delete') response = await call(`/admin/roles/protected${kind === 'role-delete' ? '/delete' : ''}`, { permissions: 'content:read' });
  else if (kind === 'requested-grants') response = await call('/admin/roles/care', { permissions: 'plugin:manage' });
  else if (kind === 'locked') response = await call('/admin/roles/admin', { permissions: 'content:read' });
  else if (kind === 'builtin') response = await call('/admin/roles/viewer/delete');
  else response = await call(`/admin/users/${actorId}/delete`);
  expect([302, 403]).toContain(response.status);
  const records = await denials(); expect(records).toHaveLength(1);
  expect(JSON.parse(String(records[0].detail)).reason).toBe(reason); expect(records[0].actor_user_id).toBe(String(actorId));
  expect(await successes()).toEqual([]); privateValuesAbsent(records);
});

it('records last-administrator protection before rendering its refusal', async () => {
  await login('admin');
  const response = await call(`/admin/users/${actorId}`, { roles: 'viewer' }); expect(response.status).toBe(200);
  expect(JSON.parse(String((await denials())[0].detail)).reason).toBe('last_administrator');
  expect(await successes()).toEqual([]); expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(actorId).first()).toEqual({ role: 'admin' });
});

it.each(['assign', 'delete'])('protects case-insensitive administrator roles during delegated %s', async operation => {
  for (const permission of PERMISSIONS) await env.DB.prepare("INSERT OR IGNORE INTO role_permissions (role, permission) VALUES ('delegated', ?)").bind(permission).run();
  await env.DB.prepare("UPDATE users SET role = ' AdMiN ' WHERE id = ?").bind(targetId).run();
  expect((await call(`/admin/users/${targetId}${operation === 'delete' ? '/delete' : ''}`, { roles: 'viewer' })).status).toBe(403);
  expect(await target()).toEqual({ role: ' AdMiN ' }); expect(await successes()).toEqual([]);
});

it.each(['edit', 'delete'])('protects a legacy uppercase reserved role during %s', async operation => {
  await role('ADMIN', ['content:read']);
  expect((await call(`/admin/roles/ADMIN${operation === 'delete' ? '/delete' : ''}`, { permissions: 'content:read' })).status).toBe(403);
  expect(await successes()).toEqual([]);
  expect(JSON.parse(String((await denials())[0].detail)).reason).toBe(operation === 'delete' ? 'builtin_role' : 'locked_role');
});

it('retains object-policy refusal evidence during primary outage and recovers it later', async () => {
  await env.DB.prepare(`CREATE TRIGGER access_denial_fault BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END`).run();
  expect((await call(`/admin/users/${targetId}`, { roles: 'admin' })).status).toBe(403);
  expect(await successes()).toEqual([]); expect(await denials()).toEqual([]); expect(await pending()).toHaveLength(1); privateValuesAbsent(await pending());
  await env.DB.prepare('DROP TRIGGER access_denial_fault').run();
  expect((await drainAuditMutationOutbox(env)).delivered).toBe(1);
  expect(JSON.parse(String((await denials())[0].detail)).reason).toBe('requested_role_exceeds_authority');
});

it('keeps the mutation refused if neither denial store can persist its receipt', async () => {
  await env.DB.prepare(`CREATE TRIGGER access_denial_fault BEFORE INSERT ON audit_events WHEN NEW.outcome = 'denied' BEGIN SELECT RAISE(IGNORE); END`).run();
  await env.DB.prepare('CREATE TRIGGER access_outbox_fault BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(IGNORE); END').run();
  expect((await call(`/admin/users/${targetId}`, { roles: 'admin' })).status).toBe(503);
  expect(await successes()).toEqual([]); expect(await target()).toEqual({ role: targetRole }); expect(await pending()).toEqual([]);
});

it('requires a matching roles-management proof for direct permission persistence', async () => {
  const actor = await verifyJWT(cookie.slice('access_token='.length), env.JWT_SECRET); if (!actor) throw new Error('Fixture actor missing');
  const before = await readRolePermissionSnapshot(env, targetRole);
  const evidence = auditEvidence(env, { action: 'role.update', eventClass: 'admin', retentionClass: 'admin_config', outcome: 'success', dataClass: 'none',
    targetType: 'role', targetId: targetRole, targetCount: 1, targetIds: null, containerKey: null, queryFingerprint: null, detail: null },
  { userId: actor.sub, roles: actor.role, sessionSid: actor.sid ?? null, via: null });
  await expect(saveRolePermissions(env, targetRole, 'Changed', ['content:read'], before, evidence, undefined!)).rejects.toThrow('Access mutation authorization is required');
  const wrong = await captureAccessAuthorization(env, actor, 'users:manage');
  await expect(saveRolePermissions(env, targetRole, 'Changed', ['content:read'], before, evidence, wrong)).rejects.toThrow('Access mutation authorization is required');
  expect(await successes()).toEqual([]);
});

it.each(['requested', 'existing'])('enforces the %s grant ceiling in direct role permission persistence', async source => {
  const actor = await verifyJWT(cookie.slice('access_token='.length), env.JWT_SECRET); if (!actor) throw new Error('Fixture actor missing');
  const name = source === 'existing' ? 'protected' : targetRole;
  const authorization = await captureAccessAuthorization(env, actor, 'roles:manage');
  const before = await readRolePermissionSnapshot(env, name); const unchanged = await grants(name);
  const evidence = auditEvidence(env, { action: 'role.update', eventClass: 'admin', retentionClass: 'admin_config', outcome: 'success', dataClass: 'none',
    targetType: 'role', targetId: name, targetCount: 1, targetIds: null, containerKey: null, queryFingerprint: null, detail: null },
  { userId: actor.sub, roles: actor.role, sessionSid: actor.sid ?? null, via: null });
  await expect(saveRolePermissions(env, name, 'Changed', [source === 'requested' ? 'plugin:manage' : 'content:read'], before, evidence, authorization))
    .rejects.toThrow('Role mutation exceeds delegated authority');
  expect(await grants(name)).toEqual(unchanged); expect(await successes()).toEqual([]);
});

it('enforces the existing-grant ceiling in direct role deletion', async () => {
  const actor = await verifyJWT(cookie.slice('access_token='.length), env.JWT_SECRET); if (!actor) throw new Error('Fixture actor missing');
  const authorization = await captureAccessAuthorization(env, actor, 'roles:manage');
  const before = await readRolePermissionSnapshot(env, 'protected');
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.post('/', async c => {
    c.set('user', actor);
    const operationId = crypto.randomUUID(); const occurredAt = new Date().toISOString();
    await expect(deleteCustomRole(c.env, 'protected', { operationId, occurredAt, before,
      removals: roleRemovalAuditEvidence(c, 'protected', operationId, occurredAt, 'none'),
      deletion: mutationAuditEvidence(c, { action: 'role.delete', entityType: 'role', entityId: 'protected' }, 'none', { requirePreviousChange: true }),
    }, authorization)).rejects.toThrow('Role mutation exceeds delegated authority');
    return c.text('refused');
  });
  expect((await app.request('/', { method: 'POST' }, env)).status).toBe(200);
  expect(await env.DB.prepare("SELECT name FROM roles WHERE name = 'protected'").first()).toEqual({ name: 'protected' });
  expect(await successes()).toEqual([]);
});
