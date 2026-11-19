import type { Env } from '../../types';
import type { AppContext } from '../../core/http/context';
import { classFor, resolveDataClasses, strongestClass } from '../../core/db/data-classes';
import { contextActor, mutationAuditSelect, type AuditActor, type AuditRequest, type AuditRow } from '../../core/db/audit';
import { USER_HAS_ROLE_SQL, USER_WITHOUT_ROLE_SQL } from '../../core/auth/role-mutation-sql';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { captureAccessAuthorization, type AccessAuthorization } from '../../core/auth/access-authorization';
import { recordPolicyDenial } from '../../core/auth/denials';

/** Fresh authority for both the route's decision and the mutation batch. */
export async function authorizeAccessMutation(c: AppContext, permission: 'users:manage' | 'roles:manage'):
Promise<{ authorization: AccessAuthorization; refused?: undefined } | { authorization?: undefined; refused: Response }> {
  let authorization: AccessAuthorization;
  try { authorization = await captureAccessAuthorization(c.env, c.get('user'), permission); }
  catch { return { refused: await accessMutationUnavailable(c) }; }
  if (!authorization.allowed) {
    await recordPolicyDenial(c, 'management_permission_changed');
    return { refused: c.text('Forbidden: access management permission changed', 403) };
  }
  return { authorization };
}

/** The highest classification of the tables whose policy/identifiers change.
 * Null means policy could not be resolved; 'none' is a valid ordinary install. */
export async function accessMutationClass(env: Env, tables: readonly string[]): Promise<{ dataClass: 'none' | 'pii' | 'phi'; policy: import('../../core/db/data-classes').DataClassMap } | null> {
  const policy = await resolveDataClasses(env, true);
  if (!policy.ok) return null;
  const classes = tables.map(table => classFor(policy, 'table', table));
  return { policy, dataClass: strongestClass(classes) };
}

/** The failed statement and commit outcome can be unknown after a transport
 * failure. Report only an incomplete coarse health incident, never success. */
export async function accessMutationUnavailable(c: AppContext): Promise<Response> {
  console.error('access policy transaction failed');
  await recordAuditOutage(c.env, 'health', [], contextActor(c), undefined, { captureIncomplete: true });
  return c.json({ error: 'Access policy change unavailable' }, 503, { 'Cache-Control': 'no-store' });
}

/** Invalid/oversized legacy policy metadata requires review before recording. */
export function unsafeAccessEvidence(c: AppContext): Response {
  return c.json({ error: 'Access policy evidence requires review' }, 409, { 'Cache-Control': 'no-store' });
}

/**
 * Record each user losing a deleted role, from the same D1 transaction as the
 * later user updates. The role-store compares event count and final user roles
 * before committing, so a skipped audit or skipped update cannot look successful.
 */
export interface RoleRemovalAuditEvidence {
  write: D1PreparedStatement;
  actor: AuditActor;
  request: AuditRequest;
  dataClass: AuditRow['dataClass'];
}

export function roleRemovalAuditEvidence(c: AppContext, role: string, operationId: string, occurredAt: string,
  dataClass: AuditRow['dataClass']): RoleRemovalAuditEvidence {
  // Internal ids and role names only; no free-text name/email is copied.
  const { sql, bindings, actor, request } = mutationAuditSelect(c, { action: 'user.roles', entityType: 'user' }, dataClass, occurredAt, {
    targetId: 'CAST(u.id AS TEXT)',
    targetCount: '1',
    detail: {
      sql: `json_object('operation_id', ?, 'role_before', u.role, 'role_after', ${USER_WITHOUT_ROLE_SQL}, 'removed_role', ?)`,
      bindings: [operationId, role, role],
    },
  });
  return {
    write: c.env.DB.prepare(`${sql} FROM users AS u
      WHERE ${USER_HAS_ROLE_SQL} AND EXISTS (SELECT 1 FROM roles WHERE name = ? AND builtin = 0)`)
      .bind(...bindings, role, role),
    actor, request, dataClass,
  };
}
