// Role administration — create/edit/delete roles and assign permissions.
// Admin-gated (roles:manage). The 'admin' role is all-powerful and locked.

import { Hono } from 'hono';
import { storedIpAllowlist } from '../../../core/auth/ip-access';
import { roleFormPage, rolesPage, type PermissionGroup } from '../templates/roles';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, USER_ROLES } from '../../../types';
import type { Env, Variables, Permission } from '../../../types';
import { slugify, str } from '../../../core/http/forms';
import { mutationAuditEvidence } from '../../../core/db/audit';
import { auditUnavailable, flushReadAudit } from '../../../core/http/access-log';
import { accessMutationClass, accessMutationUnavailable, roleRemovalAuditEvidence, unsafeAccessEvidence, authorizeAccessMutation } from '../mutation-audit';
import { safeRoleAuditValue } from '../../../core/auth/role-mutation-sql';
import { requirePermission } from '../../../core/auth/guards';
import { recordPolicyDenial } from '../../../core/auth/denials';
import { renderPage } from '../../../core/render/chrome';
import { clearRolePermissionsCache, splitRoles } from '../../../core/auth/roles';
import {
  deleteCustomRole,
  getRoleForEdit,
  listRolesForAdmin,
  readRolePermissionSnapshot,
  rolePermissionsRecordable,
} from '../role-store';
import { assignableContributedPermissions, canManagePermissions, createRole, snapshotMatchesRole, stalePolicy, updateRole } from '../role-writes';

export const rolesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

rolesRoutes.use('/roles', requirePermission('roles:manage'));
rolesRoutes.use('/roles/*', requirePermission('roles:manage'));

/** Role editor checkboxes: the CMS's own permissions first, then one group per
 *  contributor (plugin), so unticking a whole group visibly blocks that plugin. */
async function buildPermissionGroups(env: Env, granted: Set<Permission | string>): Promise<PermissionGroup[]> {
  const pluginPerms = await assignableContributedPermissions(env);
  const groups: PermissionGroup[] = [{
    label: '',
    labelKey: 'view_strings.sections_role_form.cms',
    options: PERMISSIONS.map((permission) => ({
      value: permission,
      label: PERMISSION_DESCRIPTIONS[permission],
      checked: granted.has(permission),
    })),
  }];
  const byLabel = new Map<string, PermissionGroup>();
  for (const perm of pluginPerms) {
    const label = perm.group || perm.value.split(':')[0];
    let group = byLabel.get(label);
    if (!group) {
      group = { label, labelKey: '', options: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.options.push({ value: perm.value, label: perm.label, checked: granted.has(perm.value) });
  }
  return groups;
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
    permissionGroups: await buildPermissionGroups(c.env, new Set()),
  });
});

rolesRoutes.post('/roles', async (c) => {
  const form = await c.req.formData();
  const label = str(form.get('label'));
  const name = str(form.get('name')) ? slugify(str(form.get('name'))) : slugify(label);

  const error = await createRole(c, name, label);
  if (error instanceof Response) return error;
  if (error) {
    return renderPage(c, roleFormPage, {
      isNew: true,
      name: str(form.get('name')),
      label,
      builtin: false,
      locked: false,
      error,
      permissionGroups: [],
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
    permissionGroups: await buildPermissionGroups(c.env, granted),
    canManageIp: splitRoles(c.get('user').role).includes('admin'),
    ipAllowlist: storedIpAllowlist((await c.env.DB.prepare('SELECT ip_allowlist FROM roles WHERE name = ?').bind(role.name).first<{ ip_allowlist: string }>())?.ip_allowlist ?? '[]').join('\n'),
  });
});

rolesRoutes.post('/roles/:name', async (c) => {
  const form = await c.req.formData();
  const refused = await updateRole(c, c.req.param('name'), str(form.get('label')), [...new Set(form.getAll('permissions').map(String))]);
  if (refused) return refused;
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
  const classification = await accessMutationClass(c.env, ['roles', 'role_permissions', 'users']);
  if (classification === null) return auditUnavailable(c);
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
      removals: roleRemovalAuditEvidence(c, name, operationId, occurredAt, classification.dataClass),
      deletion: mutationAuditEvidence(c, { action: 'role.delete', entityType: 'role', entityId: name,
        detail: { operation_id: operationId, previous_grants: before.grants } }, classification.dataClass, { requirePreviousChange: true, policy: classification.policy }),
    }, authorization);
  } catch {
    return accessMutationUnavailable(c);
  } finally {
    clearRolePermissionsCache();
  }
  return c.redirect('/admin/roles');
});
