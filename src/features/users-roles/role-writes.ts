// Role create/update with their authorization and audit checks. Shared by the
// role editor and settings import, and kept out of routes/ so services can use
// it without importing the routers.

import { PERMISSIONS } from '../../types';
import type { Env, Permission } from '../../types';
import { mutationAuditEvidence } from '../../core/db/audit';
import { auditUnavailable, flushReadAudit } from '../../core/http/access-log';
import { accessMutationClass, accessMutationUnavailable, unsafeAccessEvidence, authorizeAccessMutation } from './mutation-audit';
import { safeRoleAuditValue } from '../../core/auth/role-mutation-sql';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { AccessAuthorization } from '../../core/auth/access-authorization';
import { clearRolePermissionsCache, permissionsFor } from '../../core/auth/roles';
import { coreExtensions, type ContributedPermission } from '../../core/extensions';
import {
  createCustomRole,
  getRoleForEdit,
  saveRolePermissions,
  readRolePermissionSnapshot,
  rolePermissionsRecordable,
  storedRolePermissions,
  type RolePermissionSnapshot,
} from './role-store';
import type { AppContext } from '../../core/http/context';

export function canManagePermissions(authorization: AccessAuthorization, permissions: Iterable<string>): boolean {
  return authorization.admin || [...permissions].every(permission => authorization.permissions.has(permission as Permission));
}

/** Reject a policy changed after it was read for the authority check. An
 * unmanaged built-in combines code defaults with any legacy stored grants. */
export function snapshotMatchesRole(name: string, builtin: boolean, permissions: Set<Permission>, snapshot: RolePermissionSnapshot): boolean {
  if ((!builtin && !snapshot.managed) || (snapshot.managed && snapshot.builtin !== (builtin ? 1 : 0))) return false;
  const defaults = builtin && !snapshot.managed ? [...permissionsFor(name)] : [];
  const actual = [...new Set([...defaults, ...snapshot.grants])].sort();
  const observed = [...permissions].sort();
  return actual.length === observed.length && actual.every((value, index) => value === observed[index]);
}

export function stalePolicy(c: AppContext): Response {
  return c.json({ error: 'Role policy changed; reload and try again' }, 409, { 'Cache-Control': 'no-store' });
}

const BUILTIN_PERMISSIONS = new Set<string>(PERMISSIONS);

/**
 * Contributed permissions that may be offered in the role editor.
 *
 * A contributor names its own permissions, so the value it hands back is not
 * trusted here: a value colliding with a built-in would render a *second*
 * checkbox for, say, `content:write` carrying the contributor's own label, and
 * an admin ticking that friendly label would grant the real thing. The plugin
 * platform already namespaces values to the declaring plugin; this drops any
 * collision that gets past a contributor, and any duplicate value, so one row
 * cannot silently relabel another.
 */
export async function assignableContributedPermissions(env: Env): Promise<ContributedPermission[]> {
  const contributed = await (coreExtensions().contributedPermissions?.(env) ?? []);
  const seen = new Set<string>();
  return contributed.filter((permission) => {
    if (BUILTIN_PERMISSIONS.has(permission.value) || seen.has(permission.value)) return false;
    seen.add(permission.value);
    return true;
  });
}

/** Creates a custom role. Resolves to a validation message, a refusal to send
 *  back as-is, or null once the role exists. */
export async function createRole(c: AppContext, name: string, label: string, permissions: string[] = []): Promise<string | Response | null> {
  const { authorization, refused } = await authorizeAccessMutation(c, 'roles:manage');
  if (refused) return refused;
  if (!safeRoleAuditValue(name)) return unsafeAccessEvidence(c);
  if (permissions.length) {
    const assignable = new Set<string>([...PERMISSIONS, ...(await assignableContributedPermissions(c.env)).map(p => p.value)]);
    if (permissions.some(permission => !assignable.has(permission))) return 'Invalid permission';
    if (!canManagePermissions(authorization, permissions)) {
      await recordPolicyDenial(c, 'grant_exceeds_authority');
      return c.text('Forbidden: cannot grant permissions beyond your own', 403);
    }
  }
  const grants = storedRolePermissions(permissions);
  const classification = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (classification === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  try {
    return await createCustomRole(c.env, name, label, mutationAuditEvidence(c,
      { action: 'role.create', entityType: 'role', entityId: name, detail: { grants } },
      classification.dataClass, { policy: classification.policy }), authorization, grants);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
}

/** Replaces a role's permission grants (and a custom role's label). Resolves to
 *  a refusal to send back as-is, or null once saved. */
export async function updateRole(c: AppContext, name: string, requestedLabel: string, permissions: string[]): Promise<Response | null> {
  const { authorization, refused } = await authorizeAccessMutation(c, 'roles:manage');
  if (refused) return refused;
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (role.locked || name.trim().toLowerCase() === 'admin') {
    await recordPolicyDenial(c, 'locked_role');
    return c.text('Forbidden: the admin role cannot be edited', 403);
  }

  const label = role.builtin ? role.label : (requestedLabel || role.label);
  const assignable = new Set<string>([
    ...PERMISSIONS,
    ...(await assignableContributedPermissions(c.env)).map((permission) => permission.value),
  ]);
  if (permissions.some((permission) => !assignable.has(permission))) {
    return c.text('Invalid permission', 400);
  }
  if (!canManagePermissions(authorization, role.permissions) || !canManagePermissions(authorization, permissions)) {
    await recordPolicyDenial(c, 'grant_exceeds_authority');
    return c.text('Forbidden: cannot grant or modify permissions beyond your own', 403);
  }

  if (!safeRoleAuditValue(name)) return unsafeAccessEvidence(c);
  const classification = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (classification === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  const grants = storedRolePermissions(permissions);
  try {
    const before = await readRolePermissionSnapshot(c.env, name);
    if (!rolePermissionsRecordable(before.grants) || !rolePermissionsRecordable(grants)) return unsafeAccessEvidence(c);
    if (!snapshotMatchesRole(name, role.builtin, role.permissions, before)) return stalePolicy(c);
    await saveRolePermissions(c.env, name, label, grants, before, mutationAuditEvidence(c,
      { action: 'role.update', entityType: 'role', entityId: name,
        detail: { permissions: grants.length, grants, previous: { managed: before.managed, grants: before.grants } } },
      classification.dataClass, { requirePreviousChange: true, policy: classification.policy }), authorization);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
  return null;
}
