// Role administration — create/edit/delete roles and assign permissions.
// Admin-gated (roles:manage). The 'admin' role is all-powerful and locked.

import { Hono } from 'hono';
import { roleFormPage, rolesPage } from '../templates/roles';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, USER_ROLES } from '../../../types';
import type { Env, Variables, Permission } from '../../../types';
import { slugify, str } from '../../../core/http/forms';
import { mutationAuditEvidence, roleRemovalAuditEvidence } from '../../../core/db/audit';
import { auditUnavailable, flushReadAudit } from '../../../core/http/access-log';
import { accessMutationClass, accessMutationUnavailable, unsafeAccessEvidence, authorizeAccessMutation } from '../mutation-audit';
import { safeRoleAuditValue } from '../../../core/auth/role-mutation-sql';
import { requirePermission } from '../../../core/auth/guards';
import { recordPolicyDenial } from '../../../core/auth/denials';
import type { AccessAuthorization } from '../../../core/auth/access-authorization';
import { renderPage } from '../../../core/render/chrome';
import { clearRolePermissionsCache, permissionsFor } from '../../../core/auth/roles';
import { coreExtensions } from '../../../core/extensions';
import {
  createCustomRole,
  deleteCustomRole,
  getRoleForEdit,
  listRolesForAdmin,
  saveRolePermissions,
  readRolePermissionSnapshot,
  rolePermissionsRecordable,
  storedRolePermissions,
  type RolePermissionSnapshot,
} from '../../../core/auth/role-store';
import type { AppContext } from '../../../core/http/context';

export const rolesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

rolesRoutes.use('/roles', requirePermission('roles:manage'));
rolesRoutes.use('/roles/*', requirePermission('roles:manage'));

function canManagePermissions(authorization: AccessAuthorization, permissions: Iterable<string>): boolean {
  return authorization.admin || [...permissions].every(permission => authorization.permissions.has(permission as Permission));
}

/** Reject a policy changed after it was read for the authority check. An
 * unmanaged built-in combines code defaults with any legacy stored grants. */
function snapshotMatchesRole(name: string, builtin: boolean, permissions: Set<Permission>, snapshot: RolePermissionSnapshot): boolean {
  if ((!builtin && !snapshot.managed) || (snapshot.managed && snapshot.builtin !== (builtin ? 1 : 0))) return false;
  const defaults = builtin && !snapshot.managed ? [...permissionsFor(name)] : [];
  const actual = [...new Set([...defaults, ...snapshot.grants])].sort();
  const observed = [...permissions].sort();
  return actual.length === observed.length && actual.every((value, index) => value === observed[index]);
}

function stalePolicy(c: AppContext): Response {
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
async function assignableContributedPermissions(env: Env): Promise<Array<{ value: string; label: string }>> {
  const contributed = await (coreExtensions().contributedPermissions?.(env) ?? []);
  const seen = new Set<string>();
  return contributed.filter((permission) => {
    if (BUILTIN_PERMISSIONS.has(permission.value) || seen.has(permission.value)) return false;
    seen.add(permission.value);
    return true;
  });
}

async function buildPermissionOptions(env: Env, granted: Set<Permission | string>): Promise<Array<{ value: string; label: string; checked: boolean }>> {
  const pluginPerms = await assignableContributedPermissions(env);
  return [
    ...PERMISSIONS.map((permission) => ({
      value: permission,
      label: PERMISSION_DESCRIPTIONS[permission],
      checked: granted.has(permission),
    })),
    ...pluginPerms.map((perm) => ({
      value: perm.value,
      label: perm.label,
      checked: granted.has(perm.value),
    })),
  ];
}

rolesRoutes.get('/roles', async (c) => {
  const [roles, pluginPerms] = await Promise.all([
    listRolesForAdmin(c.env),
    assignableContributedPermissions(c.env),
  ]);
  const totalPermCount = PERMISSIONS.length + pluginPerms.length;
  return renderPage(c, rolesPage, {
    roles: roles.map((role) => ({
      name: role.name,
      label: role.label,
      labelKey: role.builtin ? `roles.names.${role.name}` : '',
      badge: role.builtin ? (role.locked ? 'admin' : 'built-in') : 'custom',
      badgeKey: role.builtin ? (role.locked ? 'roles.types.admin' : 'roles.types.builtin') : 'roles.types.custom',
      permissionCount: role.locked ? totalPermCount : role.permissionCount,
      editHref: `/admin/roles/${encodeURIComponent(role.name)}/edit`,
      deleteAction: `/admin/roles/${encodeURIComponent(role.name)}/delete`,
      canDelete: !role.builtin,
    })),
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

rolesRoutes.get('/roles/new', async (c) => {
  return renderPage(c, roleFormPage, {
    isNew: true,
    name: '',
    label: '',
    builtin: false,
    locked: false,
    permissionOptions: await buildPermissionOptions(c.env, new Set()),
  });
});

rolesRoutes.post('/roles', async (c) => {
  const { authorization, refused } = await authorizeAccessMutation(c, 'roles:manage');
  if (refused) return refused;
  const form = await c.req.formData();
  const label = str(form.get('label'));
  const name = str(form.get('name')) ? slugify(str(form.get('name'))) : slugify(label);

  if (!safeRoleAuditValue(name)) return unsafeAccessEvidence(c);
  const dataClass = await accessMutationClass(c.env, ['roles', 'users']);
  if (dataClass === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  let error: string | null;
  try {
    error = await createCustomRole(c.env, name, label, mutationAuditEvidence(c,
      { action: 'role.create', entityType: 'role', entityId: name }, dataClass, { requirePreviousChange: true }), authorization);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
  if (error) {
    return renderPage(c, roleFormPage, {
      isNew: true,
      name: str(form.get('name')),
      label,
      builtin: false,
      locked: false,
      error,
      permissionOptions: [],
    });
  }
  return c.redirect(`/admin/roles/${encodeURIComponent(name)}/edit`);
});

// ── Edit ────────────────────────────────────────────────────────────────────

rolesRoutes.get('/roles/:name/edit', async (c) => {
  const role = await getRoleForEdit(c.env, c.req.param('name'));
  if (!role) return c.notFound();
  const granted: Set<Permission | string> = role.locked
    ? new Set([...PERMISSIONS, ...(await assignableContributedPermissions(c.env)).map((p) => p.value)])
    : role.permissions;
  return renderPage(c, roleFormPage, {
    isNew: false,
    name: role.name,
    label: role.label,
    builtin: role.builtin,
    locked: role.locked,
    permissionOptions: await buildPermissionOptions(c.env, granted),
  });
});

rolesRoutes.post('/roles/:name', async (c) => {
  const { authorization, refused } = await authorizeAccessMutation(c, 'roles:manage');
  if (refused) return refused;
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (role.locked || name.trim().toLowerCase() === 'admin') {
    await recordPolicyDenial(c, 'locked_role');
    return c.text('Forbidden: the admin role cannot be edited', 403);
  }

  const form = await c.req.formData();
  const label = role.builtin ? role.label : (str(form.get('label')) || role.label);
  const permissions = [...new Set(form.getAll('permissions').map(String))];
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
  const dataClass = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (dataClass === null) return auditUnavailable(c);
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
      dataClass, { requirePreviousChange: true }), authorization);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
  return c.redirect('/admin/roles');
});

rolesRoutes.post('/roles/:name/delete', async (c) => {
  const { authorization, refused } = await authorizeAccessMutation(c, 'roles:manage');
  if (refused) return refused;
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (role.builtin || (USER_ROLES as readonly string[]).includes(name.trim().toLowerCase())) {
    await recordPolicyDenial(c, 'builtin_role');
    return c.text('Forbidden: built-in roles cannot be deleted', 403);
  }
  if (!canManagePermissions(authorization, role.permissions)) {
    await recordPolicyDenial(c, 'grant_exceeds_authority');
    return c.text('Forbidden: cannot remove a more privileged role', 403);
  }
  if (!safeRoleAuditValue(name)) return unsafeAccessEvidence(c);
  const dataClass = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (dataClass === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  const operationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  try {
    const before = await readRolePermissionSnapshot(c.env, name);
    if (!rolePermissionsRecordable(before.grants)) return unsafeAccessEvidence(c);
    if (!snapshotMatchesRole(name, role.builtin, role.permissions, before)) return stalePolicy(c);
    await deleteCustomRole(c.env, name, {
      operationId, occurredAt, before,
      removals: roleRemovalAuditEvidence(c, name, operationId, occurredAt, dataClass),
      deletion: mutationAuditEvidence(c, { action: 'role.delete', entityType: 'role', entityId: name,
        detail: { operation_id: operationId, previous_grants: before.grants } }, dataClass, { requirePreviousChange: true }),
    }, authorization);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
  return c.redirect('/admin/roles');
});
