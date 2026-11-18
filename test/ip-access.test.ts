import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { createAuthSession } from '../src/core/auth/sessions';
import { accountIpAllowed, connectingIp, ipMatchesAllowlist, ipMatchesRoleAllowlists, parseIpAllowlist } from '../src/core/auth/ip-access';
import { resolveRolePermissions } from '../src/core/auth/roles';

let cookie: string;
beforeEach(async () => {
  for (const table of ['audit_events', 'audit_mutation_outbox', 'data_classes', 'sessions', 'user_oauth_identities', 'users', 'role_permissions', 'roles']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie = `access_token=${await signJWT({ sub: '98001', email: 'ip-admin@example.invalid', name: 'IP admin', role: 'admin', type: 'access', exp: Math.floor(Date.now()/1000)+900 }, env.JWT_SECRET)}`;
});
async function request(path: string, body?: Record<string, string>, ip: string | null = '192.0.2.10') {
  const ctx = createExecutionContext();
  const headers: Record<string,string> = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'CF-Ray': 'ip-policy-test' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? new URLSearchParams(body) : undefined }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
it('validates bounded literal lists and rejects ambiguous or malformed addresses', () => {
  expect(parseIpAllowlist('192.0.2.1, 2001:DB8::/32\n192.0.2.1')).toEqual(['192.0.2.1','2001:db8::/32']);
  for (const input of ['localhost','127.1','012.0.0.1','256.0.0.1','192.0.2.1:80','2001::db8::1','fe80::1%eth0','1.2.3.4/33','::/129','1.2.3.4/-1']) expect(() => parseIpAllowlist(input)).toThrow();
  expect(() => parseIpAllowlist(Array.from({length:101},(_,n)=>`192.0.2.${n}`).join('\n'))).toThrow();
});
it('matches exact IPv4/IPv6 and CIDR boundaries, including mapped IPv4', () => {
  expect(ipMatchesAllowlist('192.0.2.255',['192.0.2.0/24'])).toBe(true);
  expect(ipMatchesAllowlist('192.0.3.0',['192.0.2.0/24'])).toBe(false);
  expect(ipMatchesAllowlist('2001:db8:abcd::1',['2001:db8::/32'])).toBe(true);
  expect(ipMatchesAllowlist('2001:db9::1',['2001:db8::/32'])).toBe(false);
  expect(ipMatchesAllowlist('2001:0db8:0:0:0:0:0:1',['2001:db8::1'])).toBe(true);
  expect(ipMatchesAllowlist('::ffff:192.0.2.10',['192.0.2.0/24'])).toBe(true);
  expect(ipMatchesAllowlist('192.0.2.10',['::ffff:192.0.2.0/120'])).toBe(true);
  expect(() => parseIpAllowlist('::ffff:192.0.2.0/24')).toThrow();
  expect(ipMatchesAllowlist('::1',['0.0.0.0/0'])).toBe(false);
  expect(ipMatchesAllowlist(null,['0.0.0.0/0'])).toBe(false);
  expect(ipMatchesAllowlist(null,[])).toBe(true);
  expect(connectingIp(new Headers({'X-Forwarded-For':'192.0.2.10'}))).toBe(null);
  expect(connectingIp(new Headers({'CF-Connecting-IP':'198.51.100.1','CF-Connecting-IPv6':'2001:db8::1'}))).toBe('198.51.100.1');
});
it('saves and audits role lists without removing implicit built-in grants', async () => {
  const before = (await resolveRolePermissions(env)).get('editor');
  expect((await request('/admin/roles/editor/ip-access',{ip_allowlist:'192.0.2.0/24\n2001:db8::/32'})).status).toBe(302);
  expect((await resolveRolePermissions(env)).get('editor')).toEqual(before);
  expect(await env.DB.prepare("SELECT ip_allowlist FROM roles WHERE name='editor'").first('ip_allowlist')).toBe('["192.0.2.0/24","2001:db8::/32"]');
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='role.update'").first('n')).toBe(1);
});
it('enforces fresh role policies on existing sessions and allows account exemptions', async () => {
  await request('/admin/roles/admin/ip-access',{ip_allowlist:'192.0.2.10'});
  expect((await request('/admin/profile',undefined,'198.51.100.1')).status).toBe(403);
  expect((await request('/admin/profile',undefined,null)).status).toBe(403);
  expect((await request('/admin/users/98001/ip-access',{ip_unrestricted:'1'})).status).toBe(302);
  expect(await accountIpAllowed(env,98001,'198.51.100.1')).toBe(true);
  expect((await request('/admin/profile',undefined,'198.51.100.1')).status).toBe(200);
  expect((await request('/admin/users/98001/ip-access',{},'198.51.100.1')).status).toBe(400);
});
it('combines A and B while unrestricted C adds no bypass, across access and mutation authorization', async () => {
  await env.DB.prepare(`INSERT INTO roles(name,label,ip_allowlist) VALUES
    ('editor','A','["192.0.2.10","192.0.2.11"]'),
    ('moderator','B','["192.0.2.11","192.0.2.12"]'),('viewer','C','[]')`).run();
  await env.DB.prepare("UPDATE users SET role='admin,editor,moderator,viewer' WHERE id=98001").run();
  for (const ip of ['192.0.2.10','192.0.2.11','192.0.2.12']) {
    expect(await accountIpAllowed(env,98001,ip)).toBe(true);
    expect((await request('/admin/profile',undefined,ip)).status).toBe(200);
  }
  expect(await accountIpAllowed(env,98001,'192.0.2.13')).toBe(false);
  expect(await accountIpAllowed(env,98001,null)).toBe(false);
  expect((await request('/admin/profile',undefined,'192.0.2.13')).status).toBe(403);
  // IP3 matches B only: allow exemption changes and an edit to A via B's list.
  expect((await request('/admin/users/98001/ip-access',{ip_unrestricted:'1'},'192.0.2.12')).status).toBe(302);
  expect((await request('/admin/users/98001/ip-access',{},'192.0.2.12')).status).toBe(302);
  expect((await request('/admin/roles/editor/ip-access',{ip_allowlist:'198.51.100.1'},'192.0.2.12')).status).toBe(302);
  // Removing the last matching list would leave A restricting this IP.
  expect((await request('/admin/roles/moderator/ip-access',{ip_allowlist:''},'192.0.2.12')).status).toBe(400);
  await env.DB.prepare("UPDATE roles SET ip_allowlist='bad' WHERE name='editor'").run();
  await expect(accountIpAllowed(env,98001,'192.0.2.12')).rejects.toThrow();
});
it('allows any IP only when all role lists are empty, including implicit roles', async () => {
  expect(ipMatchesRoleAllowlists(null,[])).toBe(true);
  expect(ipMatchesRoleAllowlists(null,[[],[]])).toBe(true);
  expect(ipMatchesRoleAllowlists('192.0.2.10',[[],['198.51.100.1']])).toBe(false);
  expect(ipMatchesRoleAllowlists('2001:db8::1',[['192.0.2.0/24'],[],['2001:db8::/32']])).toBe(true);
  expect(await accountIpAllowed(env,98001,null)).toBe(true);
  await env.DB.prepare("INSERT INTO roles(name,label,ip_allowlist) VALUES('admin','Admin','[]')").run();
  expect(await accountIpAllowed(env,98001,'198.51.100.1')).toBe(true);
});
it('rejects invalid lists, delegated policy changes, and self-lockout', async () => {
  expect((await request('/admin/roles/editor/ip-access',{ip_allowlist:'invalid'})).status).toBe(400);
  expect((await request('/admin/roles/admin/ip-access',{ip_allowlist:'198.51.100.0/24'})).status).toBe(400);
  await env.DB.prepare("INSERT INTO roles(name,label) VALUES('delegated','Delegated')").run();
  await env.DB.prepare("INSERT INTO role_permissions(role,permission) VALUES('delegated','roles:manage'),('delegated','users:manage')").run();
  await env.DB.prepare("UPDATE users SET role='delegated' WHERE id=98001").run();
  expect((await request('/admin/roles/editor/ip-access',{ip_allowlist:''})).status).toBe(403);
  expect((await request('/admin/users/98001/ip-access',{ip_unrestricted:'1'})).status).toBe(403);
});

it('blocks explicit refresh before rotating tokens and reports unavailable policies without serving data', async () => {
  const issued = await createAuthSession(env, { id: 98001, email: 'ip-admin@example.invalid', name: 'IP admin', role: 'admin' });
  await request('/admin/roles/admin/ip-access',{ip_allowlist:'192.0.2.10'});
  await env.DB.prepare(`INSERT INTO roles(name,label,ip_allowlist) VALUES('editor','Editor','["192.0.2.12"]')`).run();
  await env.DB.prepare("UPDATE users SET role='admin,editor,viewer' WHERE id=98001").run();
  cookie = `refresh_token=${issued.refreshToken}`;
  const denied = await request('/auth/refresh',{},'198.51.100.1');
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({error:'ip_not_allowed'});
  expect(denied.headers.get('Set-Cookie')).toBeNull();
  expect((await request('/auth/refresh',{},'192.0.2.12')).status).toBe(200);
  cookie = `access_token=${issued.accessToken}`;
  await env.DB.prepare("UPDATE roles SET ip_allowlist='bad' WHERE name='admin'").run();
  const unavailable = await request('/admin/profile');
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get('Cache-Control')).toContain('no-store');
});

it('rolls back a new built-in policy and its seeded grants if audit persistence fails', async () => {
  await env.DB.exec("CREATE TRIGGER ip_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action='role.update' BEGIN SELECT RAISE(ABORT, 'ip audit fault'); END;");
  try {
    expect((await request('/admin/roles/editor/ip-access',{ip_allowlist:'192.0.2.0/24'})).status).toBe(503);
    expect(await env.DB.prepare("SELECT name FROM roles WHERE name='editor'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM role_permissions WHERE role='editor'").first('n')).toBe(0);
  } finally {
    await env.DB.exec('DROP TRIGGER IF EXISTS ip_audit_fault');
  }
});
