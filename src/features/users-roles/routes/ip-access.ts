import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { recordPolicyDenial } from '../../../core/auth/denials';
import { permissionsFor, splitRoles } from '../../../core/auth/roles';
import { getRoleForEdit } from '../../../core/auth/role-store';
import { storedIpAllowlist, connectingIp, ipMatchesRoleAllowlists, parseIpAllowlist } from '../../../core/auth/ip-access';
import { mutationAuditEvidence } from '../../../core/db/audit';
import { abortIf } from '../../../core/db/transaction-guard';
import { auditUnavailable, flushReadAudit } from '../../../core/http/access-log';
import { authorizeAccessMutation, accessMutationClass, accessMutationUnavailable } from '../mutation-audit';
import type { AppContext } from '../../../core/http/context';

export const ipAccessRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function adminAuthorization(c: AppContext, permission: 'roles:manage' | 'users:manage') {
  const result = await authorizeAccessMutation(c, permission);
  if (result.refused) return result;
  if (!result.authorization.admin) {
    await recordPolicyDenial(c, 'grant_exceeds_authority');
    return { refused: c.text('Forbidden: only administrators can change IP access', 403) };
  }
  return result;
}

ipAccessRoutes.post('/roles/:name/ip-access', requirePermission('roles:manage'), async c => {
  const { authorization, refused } = await adminAuthorization(c, 'roles:manage');
  if (refused) return refused;
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  const form = await c.req.formData();
  let entries: string[];
  try { entries = parseIpAllowlist(String(form.get('ip_allowlist') ?? '')); }
  catch { return c.text('Enter up to 100 valid IPv4/IPv6 addresses or CIDR ranges', 400); }
  const actor = await c.env.DB.prepare('SELECT role, ip_unrestricted FROM users WHERE id = ?').bind(c.get('user').sub)
    .first<{ role: string; ip_unrestricted: number }>();
  if (!actor) return c.notFound();
  if (!actor.ip_unrestricted && splitRoles(actor.role).includes(name)) {
    const otherPolicies = await c.env.DB.prepare('SELECT ip_allowlist FROM roles WHERE name != ? AND name IN (SELECT value FROM json_each(?))')
      .bind(name, JSON.stringify(splitRoles(actor.role))).all<{ ip_allowlist: string }>();
    const proposed = [...otherPolicies.results.map(row => storedIpAllowlist(row.ip_allowlist)), entries];
    if (!ipMatchesRoleAllowlists(connectingIp(c.req.raw.headers), proposed)) {
      return c.text('Your combined role IP lists must allow your current IP to avoid locking yourself out', 400);
    }
  }
  const before = await c.env.DB.prepare('SELECT ip_allowlist FROM roles WHERE name = ?').bind(name).first<{ ip_allowlist: string }>();
  const classification = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (!classification) return auditUnavailable(c);
  const readRefusal = await flushReadAudit(c);
  if (readRefusal) return readRefusal;
  const value = JSON.stringify(entries);
  try {
    const evidence = mutationAuditEvidence(c, { action: 'role.update', entityType: 'role', entityId: name,
      detail: { ip_allowlist: entries, previous_ip_allowlist: storedIpAllowlist(before?.ip_allowlist ?? '[]') } }, classification.dataClass, { requirePreviousChange: true, policy: classification.policy });
    await c.env.DB.batch([
      authorization!.guard(),
      abortIf(c.env, before ? 'NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND ip_allowlist = ?)' : 'EXISTS (SELECT 1 FROM roles WHERE name = ?)', before ? [name, before.ip_allowlist] : [name]),
      ...(!before && role.builtin ? [...permissionsFor(name)].map(permission =>
        c.env.DB.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)').bind(name, permission)) : []),
      // Built-in roles are implicit until a permission or IP override is saved.
      c.env.DB.prepare('INSERT OR IGNORE INTO roles (name, label, builtin) VALUES (?, ?, ?)').bind(name, role.label, role.builtin ? 1 : 0),
      c.env.DB.prepare('UPDATE roles SET ip_allowlist = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?').bind(value, name),
      evidence.write, evidence.guard,
      abortIf(c.env, 'NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND ip_allowlist = ?)', [name, value]),
    ]);
  } catch { return accessMutationUnavailable(c); }
  return c.redirect(`/admin/roles/${encodeURIComponent(name)}/edit`);
});

ipAccessRoutes.post('/users/:id/ip-access', requirePermission('users:manage'), async c => {
  const { authorization, refused } = await adminAuthorization(c, 'users:manage');
  if (refused) return refused;
  const id = c.req.param('id');
  const before = await c.env.DB.prepare('SELECT role, ip_unrestricted FROM users WHERE id = ?').bind(id)
    .first<{ role: string; ip_unrestricted: number }>();
  if (!before) return c.notFound();
  const form = await c.req.formData();
  const unrestricted = form.get('ip_unrestricted') === '1' ? 1 : 0;
  // Evaluate the inherited policy before removing one's own exemption.
  if (id === c.get('user').sub && !unrestricted) {
    const policies = await c.env.DB.prepare('SELECT ip_allowlist FROM roles WHERE name IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(splitRoles(before.role))).all<{ ip_allowlist: string }>();
    if (!ipMatchesRoleAllowlists(connectingIp(c.req.raw.headers), policies.results.map(row => storedIpAllowlist(row.ip_allowlist)))) {
      return c.text('Your current IP must match your role policies before removing your exemption', 400);
    }
  }
  const classification = await accessMutationClass(c.env, ['users', 'roles']);
  if (!classification) return auditUnavailable(c);
  const readRefusal = await flushReadAudit(c);
  if (readRefusal) return readRefusal;
  try {
    const evidence = mutationAuditEvidence(c, { action: 'user.roles', entityType: 'user', entityId: id,
      detail: { ip_unrestricted: !!unrestricted, previous_ip_unrestricted: !!before.ip_unrestricted } }, classification.dataClass,
      { requirePreviousChange: true, policy: classification.policy });
    await c.env.DB.batch([
      authorization!.guard(),
      c.env.DB.prepare('UPDATE users SET ip_unrestricted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ip_unrestricted = ? AND role = ?')
        .bind(unrestricted, id, before.ip_unrestricted, before.role),
      evidence.write, evidence.guard,
      abortIf(c.env, 'NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND ip_unrestricted = ?)', [id, unrestricted]),
    ]);
  } catch { return accessMutationUnavailable(c); }
  return c.redirect(`/admin/users/${id}/edit`);
});
