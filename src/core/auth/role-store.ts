// ============================================================
// Role administration helpers (custom roles + permission grants).
// Built-in roles (USER_ROLES) are implicit; the `roles` table stores custom
// roles and any built-in whose permissions have been customized. See roles.ts
// for how these rows feed resolveRolePermissions().
// ============================================================

import { USER_ROLES } from '../../types';
import type { Env, Permission } from '../../types';
import { ROLE_LABELS, resolveRolePermissions } from './roles';
import { recordMetadataReads } from '../http/access-log';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { safeRoleAuditValue, UNSAFE_USER_ROLE_SQL, USER_HAS_ROLE_SQL, USER_WITHOUT_ROLE_SQL } from './role-mutation-sql';
import type { MutationAuditEvidence, RoleRemovalAuditEvidence } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { assertAccessAuthorization, assertDelegatedRolePermissions, type AccessAuthorization } from './access-authorization';

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
  recordMetadataReads('role.labels-read', 'roles', custom.results.map(row => row.name));
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
  recordMetadataReads('role.labels-read', 'roles', custom.results.map(row => row.name));
  recordMetadataReads('role.grants-read', 'role_permissions', [...USER_ROLES, ...custom.results.map(row => row.name)], 'role_permission_set');
  return [...builtin, ...customRoles];
}

/** Resolves a role for the edit form, or null if it doesn't exist. */
export async function getRoleForEdit(env: Env, name: string): Promise<{ name: string; label: string; builtin: boolean; locked: boolean; permissions: Set<Permission> } | null> {
  const map = await resolveRolePermissions(env);
  if (BUILTIN.has(name)) {
    recordMetadataReads('role.state-read', 'roles', [name], 'role_state');
    recordMetadataReads('role.grants-read', 'role_permissions', [name], 'role_permission_set');
    return { name, label: ROLE_LABELS[name as keyof typeof ROLE_LABELS], builtin: true, locked: name === 'admin', permissions: map.get(name) ?? new Set() };
  }
  const row = await env.DB.prepare('SELECT name, label FROM roles WHERE name = ? AND builtin = 0')
    .bind(name)
    .first<{ name: string; label: string }>();
  if (!row) return null;
  recordMetadataReads('role.labels-read', 'roles', [row.name]);
  recordMetadataReads('role.grants-read', 'role_permissions', [row.name], 'role_permission_set');
  return { name: row.name, label: row.label, builtin: false, locked: false, permissions: map.get(row.name) ?? new Set() };
}

export interface RolePermissionSnapshot {
  managed: boolean;
  builtin: number | null;
  grants: string[];
}

/** Read one consistent pre-mutation policy snapshot for audit and conflict
 * detection. Built-ins with managed=false still have code-defined defaults. */
export async function readRolePermissionSnapshot(env: Env, name: string): Promise<RolePermissionSnapshot> {
  const [roles, permissions] = await env.DB.batch([
    env.DB.prepare('SELECT builtin FROM roles WHERE name = ?').bind(name),
    env.DB.prepare('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission').bind(name),
  ]);
  const role = (roles.results as Array<{ builtin: number }>)[0];
  return { managed: !!role, builtin: role?.builtin ?? null,
    grants: (permissions.results as Array<{ permission: string }>).map(row => row.permission) };
}

/** Abort if the observed role/grant snapshot changed before this transaction. */
function roleSnapshotGuard(env: Env, name: string, before: RolePermissionSnapshot): D1PreparedStatement {
  return abortIf(env, `(SELECT COUNT(*) FROM roles WHERE name = ?) <> ?
      OR (? = 1 AND NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = ?))
      OR (SELECT COUNT(*) FROM role_permissions WHERE role = ?) <> ?
      OR EXISTS (SELECT 1 FROM role_permissions WHERE role = ? AND permission NOT IN (SELECT value FROM json_each(?)))`,
    [name, before.managed ? 1 : 0, before.managed ? 1 : 0, name, before.builtin,
      name, before.grants.length, name, JSON.stringify(before.grants)]);
}

/** Never copy malformed, unbounded legacy permission strings into audit. */
export function rolePermissionsRecordable(permissions: readonly string[]): boolean {
  return permissions.every(permission => permission.length <= 256 && PERMISSION_PATTERN.test(permission))
    && new TextEncoder().encode(JSON.stringify(permissions)).length <= 32768;
}

/** The values this store can actually persist, in a canonical evidence order. */
export function storedRolePermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions.filter((permission) => PERMISSION_PATTERN.test(permission)))].sort();
}

/** Replaces a role's permission grants with the supplied audit in one D1
 * transaction. The final update checks the complete grant set before the
 * caller's required-change audit statement is inserted. */
export async function saveRolePermissions(env: Env, name: string, label: string, permissions: string[],
  before: RolePermissionSnapshot, audit: MutationAuditEvidence, authorization: AccessAuthorization): Promise<void> {
  assertRegulatedWritesAllowed(env);
  if (!audit?.write || !audit.guard) throw new Error('Role mutation evidence is required');
  assertAccessAuthorization(authorization);
  if (name.trim().toLowerCase() === 'admin') throw new Error('The admin role cannot be edited');
  const valid = storedRolePermissions(permissions);
  if (!safeRoleAuditValue(name) || !rolePermissionsRecordable(before.grants) || !rolePermissionsRecordable(valid)) throw new Error('Role evidence is unsafe');
  assertDelegatedRolePermissions(authorization, name, valid);
  const builtin = BUILTIN.has(name) ? 1 : 0;
  const exists = 'EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = ?)';
  const statements: D1PreparedStatement[] = [authorization.guard(), roleSnapshotGuard(env, name, before)];
  // Built-in roles may be implicit until the first permission override.
  if (builtin) statements.push(env.DB.prepare('INSERT OR IGNORE INTO roles (name, label, builtin) VALUES (?, ?, 1)').bind(name, label));
  statements.push(env.DB.prepare(`DELETE FROM role_permissions WHERE role = ? AND ${exists}`).bind(name, name, builtin));
  for (const permission of valid) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO role_permissions (role, permission) SELECT ?, ? WHERE ${exists}`)
      .bind(name, permission, name, builtin));
  }
  statements.push(env.DB.prepare(
    `UPDATE roles SET label = ?, updated_at = CURRENT_TIMESTAMP
     WHERE name = ? AND builtin = ?
       AND (SELECT COUNT(*) FROM role_permissions WHERE role = ?) = ?
       AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = ? AND permission NOT IN (SELECT value FROM json_each(?)))`,
  ).bind(label, name, builtin, name, valid.length, name, JSON.stringify(valid)));
  statements.push(audit.write, audit.guard);
  // A later trigger must not alter the role/grants after the evidence snapshot.
  statements.push(abortIf(env, `NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND label = ? AND builtin = ?)
      OR (SELECT COUNT(*) FROM role_permissions WHERE role = ?) <> ?
      OR EXISTS (SELECT 1 FROM role_permissions WHERE role = ? AND permission NOT IN (SELECT value FROM json_each(?)))`,
    [name, label, builtin, name, valid.length, name, JSON.stringify(valid)]));
  await env.DB.batch(statements);
}

/** Creates a custom role and its audit together. Returns a validation error. */
export async function createCustomRole(env: Env, name: string, label: string,
  audit: MutationAuditEvidence, authorization: AccessAuthorization): Promise<string | null> {
  assertRegulatedWritesAllowed(env);
  if (!audit?.write || !audit.guard) throw new Error('Role mutation evidence is required');
  assertAccessAuthorization(authorization);
  if (!safeRoleAuditValue(name)) throw new Error('Role evidence is unsafe');
  if (!name) return 'Slug is required.';
  if (!label) return 'Name is required.';
  if (BUILTIN.has(name.trim().toLowerCase())) return `"${name}" is a built-in role.`;
  const existing = await env.DB.prepare('SELECT name FROM roles WHERE name = ?').bind(name).first();
  if (existing) return `Role "${name}" already exists.`;
  const orphan = await env.DB.prepare('SELECT 1 FROM role_permissions WHERE role = ? LIMIT 1').bind(name).first();
  if (orphan) return 'Existing permission records for this role require review.';
  await env.DB.batch([
    authorization.guard(),
    // Creating a role must not silently activate pre-existing orphan grants.
    abortIf(env, 'EXISTS (SELECT 1 FROM role_permissions WHERE role = ?)', [name]),
    env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind(name, label),
    audit.write,
    audit.guard,
    abortIf(env, 'NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND label = ? AND builtin = 0)', [name, label]),
  ]);
  return null;
}

export interface RoleDeletionEvidence {
  /** One audit INSERT...SELECT records every affected user, inside the batch. */
  removals: RoleRemovalAuditEvidence;
  /** The final audit requires the immediately preceding role DELETE to succeed. */
  deletion: MutationAuditEvidence;
  operationId: string;
  occurredAt: string;
  before: RolePermissionSnapshot;
}

/** Deletes a custom role, removes it from users and persists complete per-user
 * evidence in one transaction. A guard compares the number and final values of
 * updated users with their audit rows, aborting on ignored/partial operations. */
export async function deleteCustomRole(env: Env, name: string, evidence: RoleDeletionEvidence, authorization: AccessAuthorization): Promise<void> {
  assertRegulatedWritesAllowed(env);
  if (!evidence?.removals?.write || !evidence.deletion?.write || !evidence.deletion.guard) throw new Error('Role mutation evidence is required');
  assertAccessAuthorization(authorization);
  if (BUILTIN.has(name.trim().toLowerCase())) return;
  if (!safeRoleAuditValue(name) || !rolePermissionsRecordable(evidence.before.grants)) throw new Error('Role evidence is unsafe');
  assertDelegatedRolePermissions(authorization, name);
  const { actor, request, dataClass } = evidence.removals;
  const eventFilter = `a.occurred_at = ? AND a.action = 'user.roles' AND json_extract(a.detail, '$.operation_id') = ?`;
  const countEvidence = `SELECT COUNT(*) FROM audit_events AS a WHERE ${eventFilter}`;
  const invalidBefore = `SELECT 1 FROM audit_events AS a WHERE ${eventFilter}
    AND NOT EXISTS (SELECT 1 FROM users AS u WHERE u.id = CAST(a.target_id AS INTEGER) AND CAST(u.id AS TEXT) = a.target_id
      AND u.role IS json_extract(a.detail, '$.role_before')
      AND json_extract(a.detail, '$.removed_role') IS ? AND ${USER_HAS_ROLE_SQL})`;
  const missingBefore = `SELECT 1 FROM users AS u WHERE ${USER_HAS_ROLE_SQL}
    AND EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = 0)
    AND NOT EXISTS (SELECT 1 FROM audit_events AS a WHERE ${eventFilter}
      AND a.target_type = 'user' AND a.target_id = CAST(u.id AS TEXT) AND u.role IS json_extract(a.detail, '$.role_before')
      AND json_extract(a.detail, '$.removed_role') IS ?)`;
  const inconsistentEvidence = `SELECT 1 FROM audit_events AS a WHERE ${eventFilter} AND (
      a.event_class IS NOT 'admin' OR a.data_class IS NOT ? OR a.retention_class IS NOT 'admin_config'
      OR a.outcome IS NOT 'success' OR a.actor_user_id IS NOT ? OR a.actor_roles IS NOT ?
      OR a.acting_via IS NOT ? OR a.session_sid IS NOT ? OR a.request_id IS NOT ?
      OR a.source_ip IS NOT ? OR a.user_agent IS NOT ? OR a.target_type IS NOT 'user'
      OR a.target_count IS NOT 1 OR a.target_ids IS NOT NULL OR a.container_key IS NOT NULL
      OR a.query_fingerprint IS NOT NULL OR json_extract(a.detail, '$.removed_role') IS NOT ?
      OR NOT EXISTS (SELECT 1 FROM users AS u WHERE u.id = CAST(a.target_id AS INTEGER)
        AND CAST(u.id AS TEXT) = a.target_id AND u.role = json_extract(a.detail, '$.role_after')))`;
  const inconsistentParams = [evidence.occurredAt, evidence.operationId, dataClass, actor.userId, actor.roles,
    actor.via, actor.sessionSid, request.requestId, request.sourceIp, request.userAgent, name];
  await env.DB.batch([
    authorization.guard(),
    roleSnapshotGuard(env, name, evidence.before),
    // Legacy role lists can contain identifying free text; fail before copying
    // any such value into an audit row, including on a concurrent change.
    abortIf(env, `EXISTS (SELECT 1 FROM users AS u WHERE ${USER_HAS_ROLE_SQL} AND ${UNSAFE_USER_ROLE_SQL})`, [name]),
    evidence.removals.write,
    // Match each event to its actual user and pre-update role; no event can be
    // invented or omitted before applying the corresponding role revocations.
    abortIf(env, `EXISTS (${invalidBefore}) OR EXISTS (${missingBefore})`,
      [evidence.occurredAt, evidence.operationId, name, name,
        name, name, evidence.occurredAt, evidence.operationId, name]),
    env.DB.prepare(`UPDATE users AS u SET role = ${USER_WITHOUT_ROLE_SQL}
      WHERE ${USER_HAS_ROLE_SQL} AND EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = 0)`)
      .bind(name, name, name),
    // Compare the UPDATE's affected-row count and the linked evidence before
    // deleting the role. Any mismatch aborts every change in the D1 batch.
    abortIf(env, `changes() <> (${countEvidence}) OR EXISTS (${inconsistentEvidence})
        OR EXISTS (SELECT 1 FROM users AS u WHERE ${USER_HAS_ROLE_SQL})`,
      [evidence.occurredAt, evidence.operationId, ...inconsistentParams, name]),
    env.DB.prepare('DELETE FROM role_permissions WHERE role = ? AND EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = 0)').bind(name, name),
    env.DB.prepare('DELETE FROM roles WHERE name = ? AND builtin = 0').bind(name),
    evidence.deletion.write,
    evidence.deletion.guard,
    abortIf(env, `EXISTS (SELECT 1 FROM roles WHERE name = ?)
        OR EXISTS (SELECT 1 FROM role_permissions WHERE role = ?)
        OR EXISTS (SELECT 1 FROM users AS u WHERE ${USER_HAS_ROLE_SQL})
        OR EXISTS (${inconsistentEvidence})`, [name, name, name, ...inconsistentParams]),
  ]);
}
