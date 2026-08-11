// ============================================================
// Role administration helpers (custom roles + permission grants).
// Built-in roles (USER_ROLES) are implicit; the `roles` table stores custom
// roles and any built-in whose permissions have been customized. See roles.ts
// for how these rows feed resolveRolePermissions().
// ============================================================

import { USER_ROLES } from '../../types';
import type { Env, Permission } from '../../types';
import { ROLE_LABELS, resolveRolePermissions } from './roles';

export interface RoleSummary {
  name: string;
  label: string;
  builtin: boolean;
  permissionCount: number;
  /** Admin is all-powerful and not editable. */
  locked: boolean;
}

const BUILTIN = new Set<string>(USER_ROLES);
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/** All assignable roles (built-in + custom) as { name, label } for pickers. */
export async function allRoleOptions(env: Env): Promise<Array<{ name: string; label: string }>> {
  const custom = await env.DB.prepare('SELECT name, label FROM roles WHERE builtin = 0 ORDER BY label ASC')
    .all<{ name: string; label: string }>();
  return [
    ...USER_ROLES.map((name) => ({ name, label: ROLE_LABELS[name] })),
    ...custom.results,
  ];
}

/** Role summaries for the Roles list, with effective permission counts. */
export async function listRolesForAdmin(env: Env): Promise<RoleSummary[]> {
  const [map, custom] = await Promise.all([
    resolveRolePermissions(env),
    env.DB.prepare('SELECT name, label FROM roles WHERE builtin = 0 ORDER BY label ASC').all<{ name: string; label: string }>(),
  ]);
  const builtin = USER_ROLES.map((name) => ({
    name,
    label: ROLE_LABELS[name],
    builtin: true,
    permissionCount: map.get(name)?.size ?? 0,
    locked: name === 'admin',
  }));
  const customRoles = custom.results.map((row) => ({
    name: row.name,
    label: row.label,
    builtin: false,
    permissionCount: map.get(row.name)?.size ?? 0,
    locked: false,
  }));
  return [...builtin, ...customRoles];
}

/** Resolves a role for the edit form, or null if it doesn't exist. */
export async function getRoleForEdit(env: Env, name: string): Promise<{ name: string; label: string; builtin: boolean; locked: boolean; permissions: Set<Permission> } | null> {
  const map = await resolveRolePermissions(env);
  if (BUILTIN.has(name)) {
    return { name, label: ROLE_LABELS[name as keyof typeof ROLE_LABELS], builtin: true, locked: name === 'admin', permissions: map.get(name) ?? new Set() };
  }
  const row = await env.DB.prepare('SELECT name, label FROM roles WHERE name = ? AND builtin = 0')
    .bind(name)
    .first<{ name: string; label: string }>();
  if (!row) return null;
  return { name: row.name, label: row.label, builtin: false, locked: false, permissions: map.get(row.name) ?? new Set() };
}

/** Replaces a role's permission grants. Marks the role as managed so a built-in
 *  override (including an empty set) overrides its code default. Accepts both
 *  built-in permissions and plugin-declared permissions (namespaced strings). */
export async function saveRolePermissions(env: Env, name: string, label: string, permissions: string[]): Promise<void> {
  const valid = [...new Set(permissions.filter((permission) => PERMISSION_PATTERN.test(permission)))];
  const builtin = BUILTIN.has(name) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO roles (name, label, builtin) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET label = excluded.label, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(name, label, builtin)
    .run();
  await env.DB.prepare('DELETE FROM role_permissions WHERE role = ?').bind(name).run();
  for (const permission of valid) {
    await env.DB.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)')
      .bind(name, permission)
      .run();
  }
}

/** Creates a custom role. Returns an error message or null. */
export async function createCustomRole(env: Env, name: string, label: string): Promise<string | null> {
  if (!name) return 'Slug is required.';
  if (!label) return 'Name is required.';
  if (BUILTIN.has(name)) return `"${name}" is a built-in role.`;
  const existing = await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(name).first();
  if (existing) return `Role "${name}" already exists.`;
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind(name, label).run();
  return null;
}

/** Deletes a custom role and strips it from any users that hold it. */
export async function deleteCustomRole(env: Env, name: string): Promise<void> {
  if (BUILTIN.has(name)) return;
  await env.DB.prepare('DELETE FROM role_permissions WHERE role = ?').bind(name).run();
  await env.DB.prepare('DELETE FROM roles WHERE name = ? AND builtin = 0').bind(name).run();
  // Strip the role from any user that holds it (role is a comma-separated list).
  const users = await env.DB.prepare("SELECT id, role FROM users WHERE role LIKE ?")
    .bind(`%${name}%`)
    .all<{ id: number; role: string }>();
  for (const user of users.results) {
    const roles = user.role.split(',').map((r) => r.trim()).filter((r) => r && r !== name);
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?')
      .bind(roles.length ? roles.join(',') : 'viewer', user.id)
      .run();
  }
}
