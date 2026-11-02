import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { readRolePermissionSnapshot, saveRolePermissions } from '../src/core/auth/role-store';
import { auditEvidence } from '../src/core/db/audit';
import { captureAccessAuthorization } from '../src/core/auth/access-authorization';
import { verifyJWT } from '../src/core/auth/jwt';
import { signJWT } from './auth-fixtures';

let cookie: string;
let requestNumber = 0;
let alerts: Array<Record<string, unknown>> = [];
const role = 'w4b-care';

beforeEach(async () => {
  clearRolePermissionsCache(); alerts = [];
  for (const name of ['w4b_audit_fail', 'w4b_grant_fail', 'w4b_user_ignore', 'w4b_role_ignore']) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
  for (const table of ['audit_events', 'data_classes', 'role_permissions', 'roles', 'users']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const old = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/' });
  for (const object of old.objects) await env.AUDIT_OUTAGE_BUCKET!.delete(object.key);
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (8100, 'github:operator', 'operator@example.invalid', 'Synthetic operator', '', 'admin')").run();
  const now = Math.floor(Date.now() / 1000);
  cookie = `access_token=${await signJWT({ sub: '8100', name: 'Synthetic operator', email: 'operator@example.invalid', role: 'admin', type: 'access', iat: now, exp: now + 900 }, env.JWT_SECRET)}`;
});

afterEach(async () => {
  for (const name of ['w4b_audit_fail', 'w4b_grant_fail', 'w4b_user_ignore', 'w4b_role_ignore']) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
  clearRolePermissionsCache();
});

async function classify(table: string, dataClass: 'pii' | 'phi') {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', ?, ?)").bind(table, dataClass).run();
}
async function seedRole(name = role, label = 'Original role', grants = ['content:read']) {
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind(name, label).run();
  for (const grant of grants) await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(name, grant).run();
}
async function seedUser(id: number, value = 'viewer') {
  await env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, `github:synthetic-${id}`, `person-${id}@example.invalid`, `Synthetic ${id}`, '', value).run();
}
async function call(path: string, entries: Array<[string, string]> = [], monitor = false) {
  requestNumber++;
  const body = new URLSearchParams(entries);
  return worker.fetch(new Request(`https://cms.example.com${path}`, { method: 'POST', redirect: 'manual', body,
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Ray': `w4b-role-${requestNumber}`, 'CF-Connecting-IP': `10.82.0.${requestNumber}`, 'User-Agent': 'W4b synthetic role test' },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, CANONICAL_ORIGIN: 'https://cms.example.com',
    ...(monitor ? { AUDIT_OUTAGE_MONITORING: 'true', AUDIT_MONITOR_SOURCE: 'w4b-local-only',
      AUDIT_MONITOR: { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        alerts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(null, { status: 200 });
      } } as Fetcher } : {}),
  }, createExecutionContext());
}
async function records() {
  return (await env.DB.prepare("SELECT event_id, action, data_class, retention_class, outcome, actor_user_id, actor_roles, session_sid, request_id, target_type, target_id, detail FROM audit_events WHERE action IN ('role.create','role.update','role.delete','user.roles','user.delete') ORDER BY seq").all<Record<string, any>>()).results;
}
async function grants(name = role) {
  return (await env.DB.prepare('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission').bind(name).all<{ permission: string }>()).results.map(row => row.permission);
}
async function userRole(id: number) {
  return (await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>())?.role;
}
async function failAudit(action: string, ignored = false) {
  await env.DB.prepare(`CREATE TRIGGER w4b_audit_fail BEFORE INSERT ON audit_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(${ignored ? 'IGNORE' : "ABORT, 'synthetic audit failure'"}); END`).run();
}

it('atomically creates a classified role and attributable audit without its free-text label', async () => {
  await classify('roles', 'pii');
  expect((await call('/admin/roles', [['name', role], ['label', 'Private label person@example.invalid']])).status).toBe(302);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toEqual({ name: role });
  const rows = await records(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'role.create', data_class: 'pii', retention_class: 'admin_config', outcome: 'success',
    actor_user_id: '8100', actor_roles: 'admin', request_id: `w4b-role-${requestNumber}`, target_type: 'role', target_id: role, detail: expect.any(String) });
  expect(rows[0].session_sid).toBeTruthy();
  expect(JSON.stringify(rows)).not.toContain('person@example.invalid');
});

it('uses the user-table classification for the attributed role-creation event', async () => {
  await classify('users', 'phi');
  expect((await call('/admin/roles', [['name', role], ['label', 'Synthetic']])).status).toBe(302);
  expect((await records())[0]).toMatchObject({ action: 'role.create', data_class: 'phi', actor_user_id: '8100' });
});

it('rolls back role creation on an audit outage and sends only an incomplete coarse signal', async () => {
  await failAudit('role.create');
  const response = await call('/admin/roles', [['name', role], ['label', 'Synthetic']], true);
  expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await records()).toEqual([]);
  const objects = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/incidents/' });
  expect(objects.objects).toHaveLength(1);
  const incident = await (await env.AUDIT_OUTAGE_BUCKET!.get(objects.objects[0].key))!.json<Record<string, unknown>>();
  expect(incident).toMatchObject({ reason: 'health', eventCount: 0, captureComplete: false });
  expect(alerts).toHaveLength(1); expect(alerts[0]).toMatchObject({ reason: 'health', captureComplete: false });
  expect(JSON.stringify(alerts)).not.toContain(role); expect(JSON.stringify(alerts)).not.toContain('8100');
});

it('refuses role creation that would activate pre-existing orphan permissions', async () => {
  await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(role, 'users:manage').run();
  const response = await call('/admin/roles', [['name', role], ['label', 'Synthetic']]);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Existing permission records');
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await grants()).toEqual(['users:manage']); expect(await records()).toEqual([]);
});

it('rolls back a role creation if the audit insert is silently ignored', async () => {
  await failAudit('role.create', true);
  expect((await call('/admin/roles', [['name', role], ['label', 'Synthetic']])).status).toBe(503);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await records()).toEqual([]);
});

it('rolls back role creation if the role disappears after its audit insert', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'role.create' BEGIN DELETE FROM roles WHERE name = 'w4b-care'; END").run();
  expect((await call('/admin/roles', [['name', role], ['label', 'Synthetic']])).status).toBe(503);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await records()).toEqual([]);
});

it('refuses role creation when classification is invalid', async () => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'roles', 'invalid')").run();
  expect((await call('/admin/roles', [['name', role], ['label', 'Synthetic']])).status).toBe(503);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await records()).toEqual([]);
});

it('atomically replaces grants and records the complete actual PHI-classified grant set', async () => {
  await classify('roles', 'pii'); await classify('role_permissions', 'phi'); await seedRole();
  const response = await call(`/admin/roles/${role}`, [['label', 'Changed private label'], ['permissions', 'content:write'], ['permissions', 'tag:write'], ['permissions', 'content:read']]);
  expect(response.status).toBe(302);
  expect(await grants()).toEqual(['content:read', 'content:write', 'tag:write']);
  expect(await env.DB.prepare('SELECT label FROM roles WHERE name = ?').bind(role).first()).toEqual({ label: 'Changed private label' });
  const rows = await records(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'role.update', data_class: 'phi', actor_user_id: '8100', target_id: role });
  expect(JSON.parse(rows[0].detail)).toEqual({ classification_policy_version: expect.any(Number), permissions: 3, grants: ['content:read', 'content:write', 'tag:write'], previous: { managed: true, grants: ['content:read'] } });
  expect(JSON.stringify(rows)).not.toContain('Changed private label');
});

it('withholds a role change before mutation when its protected-read audit fails', async () => {
  await classify('roles', 'phi'); await seedRole();
  await failAudit('role.labels-read');
  const response = await call(`/admin/roles/${role}`, [['label', 'Changed'], ['permissions', 'content:write']]);
  expect(response.status).toBe(503);
  expect(await grants()).toEqual(['content:read']);
  expect(await env.DB.prepare('SELECT label FROM roles WHERE name = ?').bind(role).first()).toEqual({ label: 'Original role' });
  expect(await records()).toEqual([]);
});

it('records an empty built-in permission override without restoring default grants', async () => {
  expect((await call('/admin/roles/moderator')).status).toBe(302);
  expect(await grants('moderator')).toEqual([]);
  expect(await env.DB.prepare("SELECT builtin FROM roles WHERE name = 'moderator'").first()).toEqual({ builtin: 1 });
  expect(JSON.parse((await records())[0].detail)).toEqual({ classification_policy_version: expect.any(Number), permissions: 0, grants: [], previous: { managed: false, grants: [] } });
});

it.each(['audit', 'ignored-audit', 'deleted-audit', 'rewritten-audit', 'changed-grants-after-update', 'changed-grants-after-audit', 'grant', 'ignored-grant', 'ignored-role-update'])("rolls back the entire role replacement on %s failure", async (failure) => {
  await seedRole();
  if (failure === 'audit') await failAudit('role.update');
  if (failure === 'ignored-audit') await failAudit('role.update', true);
  if (failure === 'deleted-audit') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'role.update' BEGIN DELETE FROM audit_events WHERE seq = NEW.seq; END").run();
  if (failure === 'rewritten-audit') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'role.update' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END").run();
  if (failure === 'changed-grants-after-update') await env.DB.prepare("CREATE TRIGGER w4b_role_ignore AFTER UPDATE ON roles WHEN NEW.name = 'w4b-care' BEGIN DELETE FROM role_permissions WHERE role = NEW.name AND permission = 'content:write'; END").run();
  if (failure === 'changed-grants-after-audit') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'role.update' BEGIN DELETE FROM role_permissions WHERE role = 'w4b-care' AND permission = 'content:write'; END").run();
  if (failure === 'grant') await env.DB.prepare("CREATE TRIGGER w4b_grant_fail BEFORE INSERT ON role_permissions WHEN NEW.role = 'w4b-care' BEGIN SELECT RAISE(ABORT, 'synthetic grant failure'); END").run();
  if (failure === 'ignored-grant') await env.DB.prepare("CREATE TRIGGER w4b_grant_fail BEFORE INSERT ON role_permissions WHEN NEW.role = 'w4b-care' BEGIN SELECT RAISE(IGNORE); END").run();
  if (failure === 'ignored-role-update') await env.DB.prepare("CREATE TRIGGER w4b_role_ignore BEFORE UPDATE ON roles WHEN OLD.name = 'w4b-care' BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await call(`/admin/roles/${role}`, [['label', 'Changed'], ['permissions', 'content:write']])).status).toBe(503);
  expect(await grants()).toEqual(['content:read']);
  expect(await env.DB.prepare('SELECT label FROM roles WHERE name = ?').bind(role).first()).toEqual({ label: 'Original role' });
  expect(await records()).toEqual([]);
});

it('rolls back an ignored audit even if a legacy settings value column is nullable', async () => {
  await seedRole();
  await env.DB.prepare('ALTER TABLE settings RENAME TO w4b_original_settings').run();
  await env.DB.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  try {
    await failAudit('role.update', true);
    expect((await call(`/admin/roles/${role}`, [['label', 'Changed'], ['permissions', 'content:write']])).status).toBe(503);
    expect(await grants()).toEqual(['content:read']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first()).toEqual({ n: 0 });
    expect(await records()).toEqual([]);
  } finally {
    await env.DB.prepare('DROP TABLE settings').run();
    await env.DB.prepare('ALTER TABLE w4b_original_settings RENAME TO settings').run();
  }
});

it('refuses direct unregulated permission persistence without supplied evidence', async () => {
  await seedRole();
  const before = await readRolePermissionSnapshot(env, role);
  await expect(saveRolePermissions(env, role, 'Changed', ['content:write'], before, undefined as unknown as import('../src/core/db/audit').MutationAuditEvidence)).rejects.toThrow('Role mutation evidence is required');
  expect(await grants()).toEqual(['content:read']);
});

it.each(['person@example.invalid', `${'a'.repeat(257)}:read`])('refuses to copy unsafe legacy permission metadata into audit', async (unsafe) => {
  await seedRole(role, 'Original role', [unsafe]);
  expect((await call(`/admin/roles/${role}`, [['label', 'Changed'], ['permissions', 'content:write']])).status).toBe(409);
  expect(await grants()).toEqual([unsafe]); expect(await records()).toEqual([]);
});

it('rejects a stale role/grant snapshot without overwriting newer permissions', async () => {
  await seedRole();
  const before = await readRolePermissionSnapshot(env, role);
  await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(role, 'tag:write').run();
  const audit = auditEvidence(env, { action: 'role.update', eventClass: 'admin', dataClass: 'none', retentionClass: 'admin_config',
    outcome: 'success', targetType: 'role', targetId: role, targetIds: null, targetCount: 1,
    containerKey: null, queryFingerprint: null, detail: null }, { userId: null, roles: null, sessionSid: null, via: null });
  const actor = await verifyJWT(cookie.slice('access_token='.length), env.JWT_SECRET);
  if (!actor) throw new Error('Fixture actor unavailable');
  const authorization = await captureAccessAuthorization(env, actor, 'roles:manage');
  await expect(saveRolePermissions(env, role, 'Changed', ['content:write'], before, audit, authorization)).rejects.toThrow();
  expect(await grants()).toEqual(['content:read', 'tag:write']);
  expect(await env.DB.prepare('SELECT label FROM roles WHERE name = ?').bind(role).first()).toEqual({ label: 'Original role' });
  expect(await records()).toEqual([]);
});

it('deletes a role atomically and records every affected user, preserving exact token boundaries', async () => {
  await classify('roles', 'pii'); await classify('role_permissions', 'phi'); await classify('users', 'pii'); await seedRole();
  await seedUser(8101, `viewer, ${role}, ${role}`); await seedUser(8102, `${role},editor`); await seedUser(8103, `${role}-extra,viewer`);
  expect((await call(`/admin/roles/${role}/delete`)).status).toBe(302);
  expect(await userRole(8101)).toBe('viewer'); expect(await userRole(8102)).toBe('editor');
  expect(await userRole(8103)).toBe(`${role}-extra,viewer`);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull(); expect(await grants()).toEqual([]);
  const rows = await records(); expect(rows.map(row => row.action)).toEqual(['user.roles', 'user.roles', 'role.delete']);
  const removed = rows.filter(row => row.action === 'user.roles');
  expect(removed.map(row => row.target_id).sort()).toEqual(['8101', '8102']);
  const deletion = JSON.parse(rows[2].detail);
  expect(deletion.previous_grants).toEqual(['content:read']);
  const operationId = deletion.operation_id;
  expect(removed.map(row => JSON.parse(row.detail))).toMatchObject([
    { operation_id: operationId, role_before: `viewer, ${role}, ${role}`, role_after: 'viewer', removed_role: role },
    { operation_id: operationId, role_before: `${role},editor`, role_after: 'editor', removed_role: role },
  ]);
  expect(rows.every(row => row.data_class === 'phi' && row.actor_user_id === '8100')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('@example.invalid');
});

it('records every affected user when a role is removed from more than 100 accounts', async () => {
  await seedRole();
  const users = Array.from({ length: 205 }, (_, index) => 9000 + index);
  await env.DB.batch(users.map(id => env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?)')
    .bind(id, `github:bulk-${id}`, `bulk-${id}@example.invalid`, `Synthetic ${id}`, role)));
  expect((await call(`/admin/roles/${role}/delete`)).status).toBe(302);
  const rows = await records();
  const removed = rows.filter(row => row.action === 'user.roles');
  expect(removed).toHaveLength(users.length);
  expect(new Set(removed.map(row => row.target_id))).toEqual(new Set(users.map(String)));
  expect(new Set(removed.map(row => JSON.parse(row.detail).operation_id)).size).toBe(1);
  const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id >= 9000 AND role <> 'viewer'").first<{ n: number }>();
  expect(remaining?.n).toBe(0);
});

it.each(['audit', 'ignored-final-audit', 'ignored-user-audit', 'ignored-user-update', 'ignored-both', 'changed-user-update', 'rewritten-user-before', 'rewritten-user-actor', 'role-recreated-after-audit', 'ignored-role-delete'])("rolls back role removal and all affected-user evidence on %s failure", async (failure) => {
  await seedRole(); await seedUser(8101, `${role},editor`);
  if (failure === 'audit') await failAudit('role.delete');
  if (failure === 'ignored-final-audit') await failAudit('role.delete', true);
  if (failure === 'ignored-user-audit' || failure === 'ignored-both') await failAudit('user.roles', true);
  if (failure === 'ignored-user-update' || failure === 'ignored-both') await env.DB.prepare("CREATE TRIGGER w4b_user_ignore BEFORE UPDATE OF role ON users WHEN OLD.id = 8101 BEGIN SELECT RAISE(IGNORE); END").run();
  if (failure === 'changed-user-update') await env.DB.prepare("CREATE TRIGGER w4b_user_ignore AFTER UPDATE OF role ON users WHEN OLD.id = 8101 BEGIN UPDATE users SET role = 'moderator' WHERE id = OLD.id; END").run();
  if (failure === 'rewritten-user-before') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'user.roles' BEGIN UPDATE audit_events SET detail = json_set(detail, '$.role_before', 'viewer') WHERE seq = NEW.seq; END").run();
  if (failure === 'rewritten-user-actor') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'user.roles' BEGIN UPDATE audit_events SET actor_user_id = 'other' WHERE seq = NEW.seq; END").run();
  if (failure === 'role-recreated-after-audit') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'role.delete' BEGIN INSERT INTO roles (name, label, builtin) VALUES ('w4b-care', 'Recreated', 0); END").run();
  if (failure === 'ignored-role-delete') await env.DB.prepare("CREATE TRIGGER w4b_role_ignore BEFORE DELETE ON roles WHEN OLD.name = 'w4b-care' BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await call(`/admin/roles/${role}/delete`)).status).toBe(503);
  expect(await userRole(8101)).toBe(`${role},editor`); expect(await grants()).toEqual(['content:read']);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toEqual({ name: role });
  expect(await records()).toEqual([]);
});

it('refuses role deletion before copying an email-like legacy role list into audit', async () => {
  await seedRole(); await seedUser(8101, `${role},person@example.invalid`);
  expect((await call(`/admin/roles/${role}/delete`)).status).toBe(503);
  expect(await userRole(8101)).toBe(`${role},person@example.invalid`); expect(await grants()).toEqual(['content:read']);
  expect(await records()).toEqual([]);
});

it('refuses deleting a built-in role without recording a false deletion', async () => {
  expect((await call('/admin/roles/moderator/delete')).status).toBe(403);
  expect(await records()).toEqual([]);
});

it('rolls back creation if the role INSERT is silently ignored', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_role_ignore BEFORE INSERT ON roles WHEN NEW.name = 'w4b-care' BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await call('/admin/roles', [['name', role], ['label', 'Synthetic']])).status).toBe(503);
  expect(await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(role).first()).toBeNull();
  expect(await records()).toEqual([]);
});

it('refuses a user role change rather than copying an email-like legacy role into audit', async () => {
  await seedUser(8101, 'viewer,person@example.invalid');
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(409);
  expect(await userRole(8101)).toBe('viewer,person@example.invalid'); expect(await records()).toEqual([]);
});

it('atomically records a user role change with its actual before/after values', async () => {
  await classify('users', 'pii'); await seedUser(8101, 'viewer');
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(302);
  expect(await userRole(8101)).toBe('editor');
  const rows = await records(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'user.roles', data_class: 'pii', actor_user_id: '8100', target_id: '8101' });
  expect(JSON.parse(rows[0].detail)).toEqual({ classification_policy_version: expect.any(Number), role_before: 'viewer', role: 'editor' });
});

it.each(['update', 'audit'])('rolls back when the final user role differs after the %s', async (phase) => {
  await seedUser(8101, 'viewer');
  if (phase === 'update') await env.DB.prepare("CREATE TRIGGER w4b_user_ignore AFTER UPDATE OF role ON users WHEN OLD.id = 8101 BEGIN UPDATE users SET role = 'moderator' WHERE id = OLD.id; END").run();
  if (phase === 'audit') await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'user.roles' BEGIN UPDATE users SET role = 'moderator' WHERE id = 8101; END").run();
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(503);
  expect(await userRole(8101)).toBe('viewer'); expect(await records()).toEqual([]);
});

it('does not claim a user role change if the user UPDATE is silently ignored', async () => {
  await seedUser(8101, 'viewer');
  await env.DB.prepare("CREATE TRIGGER w4b_user_ignore BEFORE UPDATE OF role ON users WHEN OLD.id = 8101 BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(503);
  expect(await userRole(8101)).toBe('viewer'); expect(await records()).toEqual([]);
});

it('rolls back a user role change when its audit insert is silently ignored', async () => {
  await seedUser(8101, 'viewer'); await failAudit('user.roles', true);
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(503);
  expect(await userRole(8101)).toBe('viewer'); expect(await records()).toEqual([]);
});

it('rolls back a user role change when its audit write fails', async () => {
  await seedUser(8101, 'viewer'); await failAudit('user.roles');
  expect((await call('/admin/users/8101', [['roles', 'editor']])).status).toBe(503);
  expect(await userRole(8101)).toBe('viewer'); expect(await records()).toEqual([]);
});

it('rolls back session, identity and user deletion when its audit write fails', async () => {
  await seedUser(8101, 'editor');
  await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (8101, 'synthetic-session', datetime('now', '+1 day'))").run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (8101, 'github', 'synthetic', 'github:synthetic-id')").run();
  await failAudit('user.delete');
  expect((await call('/admin/users/8101/delete')).status).toBe(503);
  expect(await userRole(8101)).toBe('editor');
  expect(await env.DB.prepare("SELECT user_id FROM sessions WHERE refresh_token_hash = 'synthetic-session'").first()).toEqual({ user_id: 8101 });
  expect(await env.DB.prepare("SELECT user_id FROM user_oauth_identities WHERE oauth_id = 'github:synthetic-id'").first()).toEqual({ user_id: 8101 });
  expect(await records()).toEqual([]);
});

it('rolls back user deletion when its audit insert is silently ignored', async () => {
  await seedUser(8101, 'editor'); await failAudit('user.delete', true);
  expect((await call('/admin/users/8101/delete')).status).toBe(503);
  expect(await userRole(8101)).toBe('editor'); expect(await records()).toEqual([]);
});

it('restores session and identity deletion if the user DELETE is silently ignored', async () => {
  await seedUser(8101, 'editor');
  await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (8101, 'synthetic-session', datetime('now', '+1 day'))").run();
  await env.DB.prepare("INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (8101, 'github', 'synthetic', 'github:synthetic-id')").run();
  await env.DB.prepare("CREATE TRIGGER w4b_user_ignore BEFORE DELETE ON users WHEN OLD.id = 8101 BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await call('/admin/users/8101/delete')).status).toBe(503);
  expect(await userRole(8101)).toBe('editor');
  expect(await env.DB.prepare("SELECT user_id FROM sessions WHERE refresh_token_hash = 'synthetic-session'").first()).toEqual({ user_id: 8101 });
  expect(await env.DB.prepare("SELECT user_id FROM user_oauth_identities WHERE oauth_id = 'github:synthetic-id'").first()).toEqual({ user_id: 8101 });
  expect(await records()).toEqual([]);
});

it('rolls back user deletion if the user reappears after its audit insert', async () => {
  await seedUser(8101, 'editor');
  await env.DB.prepare("CREATE TRIGGER w4b_audit_fail AFTER INSERT ON audit_events WHEN NEW.action = 'user.delete' BEGIN INSERT INTO users (id, oauth_id, email, name, role) VALUES (8101, 'github:recreated', 'recreated@example.invalid', 'Synthetic', 'viewer'); END").run();
  expect((await call('/admin/users/8101/delete')).status).toBe(503);
  expect(await userRole(8101)).toBe('editor'); expect(await records()).toEqual([]);
});

it('records user deletion without copying the email into durable evidence', async () => {
  await classify('users', 'pii'); await seedUser(8101, 'editor');
  expect((await call('/admin/users/8101/delete')).status).toBe(302);
  expect(await userRole(8101)).toBeUndefined();
  const rows = await records(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'user.delete', data_class: 'pii', target_id: '8101' });
  expect(JSON.parse(rows[0].detail)).toEqual({ classification_policy_version: expect.any(Number), role_before: 'editor' });
  expect(JSON.stringify(rows)).not.toContain('@example.invalid');
});
