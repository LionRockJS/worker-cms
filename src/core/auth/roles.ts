import { requestContext } from '../http/request-context';
import { PERMISSIONS, USER_ROLES, type Env, type Permission, type UserRole } from '../../types';

const VALID_ROLES = new Set<string>(USER_ROLES);

/** Translation key for a built-in role, or blank for a custom role. */
export function builtinRoleTranslationKey(role: string): string {
  const normalized = role.trim().toLowerCase();
  return VALID_ROLES.has(normalized) ? `roles.names.${normalized}` : '';
}

/** Built-in role display labels, shown in the Users/Roles admin. */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  moderator: 'Moderator',
  viewer: 'Viewer',
};

// Least-privilege capability matrix. A user's effective permissions are the
// union over all roles they hold (roles are a comma-separated list).
//   admin     – full control, including destructive/global ops
//   editor    – full content lifecycle, taxonomy, media, import (no purge/plugins)
//   moderator – review/moderation only: publish, soft-delete, restore
//   viewer    – no admin capabilities (also blocked from /admin by editorGuard)
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'content:read', 'content:write', 'content:publish', 'content:delete', 'content:import',
    'trash:restore', 'trash:purge', 'taxonomy:write', 'media:upload', 'plugin:access',
    'plugin:manage', 'menu:manage', 'pagetype:write', 'blocktype:write',
  ],
  editor: [
    'content:read', 'content:write', 'content:publish', 'content:delete', 'content:import',
    'trash:restore', 'tag:write', 'taxonomy:write', 'media:upload',
  ],
  moderator: [
    'content:read', 'content:publish', 'content:delete', 'trash:restore',
  ],
  viewer: [],
};

export function parseRoles(value: string): UserRole[] {
  const roles = value
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter((role): role is UserRole => VALID_ROLES.has(role));

  return [...new Set(roles)];
}

export function normalizeRoles(roles: string[]): string {
  const normalized = parseRoles(roles.join(','));
  return normalized.length > 0 ? normalized.join(',') : 'viewer';
}

/** The union of capabilities granted by every role the user holds. */
export function permissionsFor(value: string): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of parseRoles(value)) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return permissions;
}

export function hasPermission(value: string, permission: Permission): boolean {
  return permissionsFor(value).has(permission);
}

// ── Database-backed role → permission resolution ──────────────────────────────
// The effective permission map layers:
//   • built-in roles (USER_ROLES) → their code default (ROLE_PERMISSIONS)
//   • any role present in the `roles` table → exactly its role_permissions rows
//     (so a customized built-in or a custom role can have an empty set)
//   • 'admin' → always every permission (never editable; avoids lockout)
// Cached only within one HTTP request; role changes take effect on the next request.



/** Splits a comma-separated role value without filtering to built-ins (custom roles allowed). */
export function splitRoles(value: string): string[] {
  return [...new Set(value.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean))];
}

/** One resolver for both ordinary reads and atomic authorization snapshots. */
export function buildRolePermissions(managed: ReadonlyArray<{ name: string }>, grants: ReadonlyArray<{ role: string; permission: string }>): Map<string, Set<Permission>> {
  const map = new Map<string, Set<Permission>>();
  for (const role of USER_ROLES) map.set(role, new Set(ROLE_PERMISSIONS[role]));
  for (const row of managed) map.set(row.name, new Set());
  for (const row of grants) {
    const set = map.get(row.role) ?? new Set<Permission>();
    set.add(row.permission as Permission);
    map.set(row.role, set);
  }
  map.set('admin', new Set(PERMISSIONS));
  return map;
}

/** Resolves the effective role → permission map from the database. */
export async function resolveRolePermissions(env: Env, fresh = false): Promise<Map<string, Set<Permission>>> {
  const context = requestContext.getStore();
  if (!fresh && context?.rolePermissions) return context.rolePermissions;

  const managed = env.DB ? (await env.DB.prepare('SELECT name FROM roles').all<{ name: string }>()).results : [];
  const grants = env.DB ? (await env.DB.prepare('SELECT role, permission FROM role_permissions').all<{ role: string; permission: string }>()).results : [];
  const map = buildRolePermissions(managed, grants);

  if (context) context.rolePermissions = map;
  return map;
}

/** Clears the current request's role-permission cache after a mutation. */
export function clearRolePermissionsCache(): void {
  const context = requestContext.getStore();
  if (context) delete context.rolePermissions;
}

/** Union of permissions granted to a comma-separated role value, per the resolved map. */
export function effectivePermissions(map: Map<string, Set<Permission>>, roleValue: string): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of splitRoles(roleValue)) {
    for (const permission of map.get(role) ?? []) permissions.add(permission);
  }
  return permissions;
}
