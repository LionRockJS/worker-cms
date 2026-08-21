// Role administration — create/edit/delete roles and assign permissions.
// Admin-gated (roles:manage). The 'admin' role is all-powerful and locked.

import { Hono } from 'hono';
import { roleFormPage, rolesPage } from '../templates/roles';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../../types';
import type { Env, Variables, Permission } from '../../../types';
import { slugify, str } from '../../../core/http/forms';
import { logAudit } from '../../../core/db/audit';
import { requirePermission } from '../../../core/auth/guards';
import { renderPage } from '../../../core/render/chrome';
import { clearRolePermissionsCache, effectivePermissions, resolveRolePermissions, splitRoles } from '../../../core/auth/roles';
import { coreExtensions } from '../../../core/extensions';
import {
  createCustomRole,
  deleteCustomRole,
  getRoleForEdit,
  listRolesForAdmin,
  saveRolePermissions,
} from '../../../core/auth/role-store';
import type { AppContext } from '../../../core/http/context';

export const rolesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

rolesRoutes.use('/roles', requirePermission('roles:manage'));
rolesRoutes.use('/roles/*', requirePermission('roles:manage'));

async function canManagePermissions(c: AppContext, permissions: Iterable<string>): Promise<boolean> {
  if (splitRoles(c.get('user').role).includes('admin')) return true;
  const actorPermissions = effectivePermissions(await resolveRolePermissions(c.env), c.get('user').role);
  return [...permissions].every((permission) => actorPermissions.has(permission as Permission));
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
  const form = await c.req.formData();
  const label = str(form.get('label'));
  const name = str(form.get('name')) ? slugify(str(form.get('name'))) : slugify(label);

  const error = await createCustomRole(c.env, name, label);
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
  clearRolePermissionsCache();
  logAudit(c, 'role.create', 'role', name, { label });
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
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (role.locked) return c.text('Forbidden: the admin role cannot be edited', 403);

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
  if (!(await canManagePermissions(c, role.permissions)) || !(await canManagePermissions(c, permissions))) {
    return c.text('Forbidden: cannot grant or modify permissions beyond your own', 403);
  }

  await saveRolePermissions(c.env, name, label, permissions);
  clearRolePermissionsCache();
  logAudit(c, 'role.update', 'role', name, { permissions: permissions.length });
  return c.redirect('/admin/roles');
});

rolesRoutes.post('/roles/:name/delete', async (c) => {
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (!(await canManagePermissions(c, role.permissions))) {
    return c.text('Forbidden: cannot remove a more privileged role', 403);
  }
  await deleteCustomRole(c.env, name);
  clearRolePermissionsCache();
  logAudit(c, 'role.delete', 'role', name);
  return c.redirect('/admin/roles');
});
