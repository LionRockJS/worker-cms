import type { Env } from '../../types';
import type { AppContext } from '../http/context';
import type { AuthDbUser } from './sessions';
import { safeRoleAuditValue } from './role-mutation-sql';
import { classFor, resolveDataClasses } from '../db/data-classes';
import { sessionAuditEnvelope } from '../db/audit';
import { auditOutboxEvidence, drainAuditMutationOutbox } from '../db/audit-mutation-outbox';
import { recordAuditOutage } from '../db/audit-outages';
import { abortIf } from '../db/transaction-guard';

export class SessionEvidenceUnavailableError extends Error {
  constructor() { super('Session lifecycle evidence unavailable'); }
}

export async function sessionOperation<T>(env: Env, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof SessionEvidenceUnavailableError) throw error;
    await recordAuditOutage(env, 'health', [], undefined, undefined, { captureIncomplete: true });
    throw new SessionEvidenceUnavailableError();
  }
}

export async function sessionPolicy(env: Env, revocation = false) {
  const policy = await resolveDataClasses(env, true);
  if (!policy.ok) {
    if (!revocation) throw new Error('Session classification unavailable');
    return { dataClass: 'phi' as const, unavailable: true };
  }
  const classes = ['users', 'sessions', 'roles', 'role_permissions', 'user_oauth_identities'].map(table => classFor(policy, 'table', table));
  // Containment must survive unavailable/changing policy. Always retain PHI
  // evidence for revocations, even if a lower class was observed before the batch.
  return { policy, dataClass: classes.includes('phi') || revocation ? 'phi' as const
    : classes.includes('pii') ? 'pii' as const : 'none' as const, unavailable: false };
}

export function sessionUserGuard(env: Env, user: AuthDbUser) {
  return abortIf(env, `NOT EXISTS (SELECT 1 FROM users WHERE disabled_at IS NULL AND id = ? AND email IS ? AND name IS ? AND role IS ?)`,
    [user.id, user.email, user.name, user.role]);
}

export interface SessionSnapshot {
  id: number; user_id: number; refresh_token_hash: string; previous_refresh_token_hash: string | null;
  expires_at: string; created_at: string; rotated_at: string | null; role: string | null;
}

export const SESSION_SNAPSHOT_COLUMNS = 's.id, s.user_id, s.refresh_token_hash, s.previous_refresh_token_hash, s.expires_at, s.created_at, s.rotated_at, u.role';

export function sessionSnapshotCondition(session: SessionSnapshot) {
  return { sql: `id = ? AND user_id = ? AND refresh_token_hash IS ? AND previous_refresh_token_hash IS ?
    AND expires_at IS ? AND created_at IS ? AND rotated_at IS ?`,
  bindings: [session.id, session.user_id, session.refresh_token_hash, session.previous_refresh_token_hash,
    session.expires_at, session.created_at, session.rotated_at] };
}

export type SessionRemovalReason = 'logout' | 'explicit-revocation' | 'session-cap' | 'expired';

/** The bounded selected set and all per-session receipts commit together.
 * Never replay a business operation from its delivery receipt. */
export async function removeSessionSnapshots(env: Env, sessions: SessionSnapshot[], reason: SessionRemovalReason,
  predicate: string, bindings: Array<string | number> = [], c?: AppContext): Promise<number> {
  if (!sessions.length) return 0;
  const policy = await sessionPolicy(env, true);
  const statements: D1PreparedStatement[] = [];
  const eventIds: string[] = [];
  for (const session of sessions) {
    // A rotation must not defeat an already authenticated logout. Cleanup
    // instead rechecks full activity state so it cannot remove a fresh session.
    const maintenance = reason === 'expired' || reason === 'session-cap';
    const snapshot = maintenance ? sessionSnapshotCondition(session)
      : { sql: 'id = ? AND user_id = ?', bindings: [session.id, session.user_id] };
    const rolesUnavailable = session.role === null || !safeRoleAuditValue(session.role);
    const envelope = sessionAuditEnvelope(c, reason === 'logout' ? 'auth.logout' : `auth.session.${reason === 'session-cap' ? 'cap' : reason === 'expired' ? 'expire' : 'revoke'}`,
      session.user_id, rolesUnavailable ? null : session.role, session.id, policy.dataClass,
      { reason, user_id: String(session.user_id), classification_unavailable: policy.unavailable, roles_unavailable: rolesUnavailable },
      maintenance ? 'system:session-maintenance' : null);
    if (maintenance) {
      envelope.actor.userId = null;
      envelope.actor.roles = null;
      envelope.actor.sessionSid = null;
    }
    const evidence = auditOutboxEvidence(env, envelope);
    eventIds.push(envelope.row.eventId!);
    statements.push(
      abortIf(env, '(SELECT role FROM users WHERE id = ?) IS NOT ?', [session.user_id, session.role]),
      env.DB.prepare(`DELETE FROM sessions WHERE ${snapshot.sql} AND (${predicate})`).bind(...snapshot.bindings, ...bindings),
      evidence.write, evidence.guard,
      abortIf(env, 'EXISTS (SELECT 1 FROM sessions WHERE id = ?)', [session.id]),
    );
  }
  await env.DB.batch(statements);
  // Cleanup can enqueue 50 receipts using one D1 batch. Leave delivery to the
  // core sweeper to preserve request query budgets. User revocations attempt
  // only their own (at most two) receipts, never drain an unrelated backlog.
  if (reason === 'logout' || reason === 'explicit-revocation') {
    for (const eventId of eventIds) await drainAuditMutationOutbox(env, eventId);
  }
  return sessions.length;
}
