import type { Env, JWTPayload, Permission } from '../../types';
import { buildRolePermissions, effectivePermissions, splitRoles } from './roles';
import { safeRoleAuditValue } from './role-mutation-sql';
import { abortIf } from '../db/transaction-guard';
import { requestContext } from '../http/request-context';

/** Prepared from one D1 snapshot; the admission guard must be the first
 * statement in the same batch as the access-management mutation/evidence. */
export interface AccessAuthorization {
  capability: 'users:manage' | 'roles:manage';
  allowed: boolean;
  admin: boolean;
  permissions: Set<Permission>;
  roleMap: Map<string, Set<Permission>>;
  guard(): D1PreparedStatement;
}

export async function captureAccessAuthorization(env: Env, actor: JWTPayload, permission: 'users:manage' | 'roles:manage'): Promise<AccessAuthorization> {
  actor = { ...actor };
  if (!/^\d+$/.test(actor.sub) || !/^\d+$/.test(actor.sid ?? '') || !safeRoleAuditValue(actor.role)) throw new Error('Access authorization unavailable');
  const [users, roles, grants] = await env.DB.batch([
    env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(actor.sub),
    env.DB.prepare('SELECT name, builtin FROM roles ORDER BY name'),
    env.DB.prepare('SELECT role, permission FROM role_permissions ORDER BY role, permission'),
  ]);
  const user = users.results[0] as { role: string } | undefined;
  if (!user || user.role !== actor.role) throw new Error('Access actor changed');
  const managed = roles.results as Array<{ name: string; builtin: number }>;
  const permissions = grants.results as Array<{ role: string; permission: string }>;
  const roleMap = buildRolePermissions(managed, permissions);
  const context = requestContext.getStore();
  if (context) context.rolePermissions = roleMap;
  const effective = effectivePermissions(roleMap, user.role);
  const admin = splitRoles(user.role).includes('admin');
  return {
    capability: permission, allowed: admin || effective.has(permission), admin, permissions: effective, roleMap,
    guard: () => abortIf(env, `NOT EXISTS (SELECT 1 FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE u.id = ? AND u.role IS ? AND s.id = ? AND ? > CAST(strftime('%s', 'now') AS INTEGER)
          AND s.expires_at > CURRENT_TIMESTAMP AND s.created_at > datetime('now', '-30 days'))
      OR (SELECT COUNT(*) FROM roles) <> ?
      OR EXISTS (SELECT name, builtin FROM roles EXCEPT
        SELECT json_extract(value, '$.name'), json_extract(value, '$.builtin') FROM json_each(?))
      OR (SELECT COUNT(*) FROM role_permissions) <> ?
      OR EXISTS (SELECT role, permission FROM role_permissions EXCEPT
        SELECT json_extract(value, '$.role'), json_extract(value, '$.permission') FROM json_each(?))`,
    [actor.sub, actor.role, actor.sid!, actor.exp, managed.length, JSON.stringify(managed), permissions.length, JSON.stringify(permissions)]),
  };
}

export function assertAccessAuthorization(authorization: AccessAuthorization | undefined, capability: 'users:manage' | 'roles:manage' = 'roles:manage'): asserts authorization is AccessAuthorization {
  if (!authorization?.allowed || authorization.capability !== capability || !authorization.guard) throw new Error('Access mutation authorization is required');
}

/** Direct stores enforce the same ceiling as HTTP object-policy checks. */
export function assertDelegatedRolePermissions(authorization: AccessAuthorization, name: string, requested: readonly string[] = []): void {
  if (authorization.admin) return;
  const target = authorization.roleMap.get(name) ?? new Set<Permission>();
  if ([...target, ...requested].some(permission => !authorization.permissions.has(permission as Permission))) {
    throw new Error('Role mutation exceeds delegated authority');
  }
}
