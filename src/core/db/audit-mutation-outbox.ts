import type { Env } from '../../types';
import type { AuditEnvelope, MutationAuditEvidence } from './audit';
import { auditDeliveryEvidence } from './audit';
import { abortIf } from './transaction-guard';
import { recordAuditOutage } from './audit-outages';
import { safeRoleAuditValue } from '../auth/role-mutation-sql';
import { validDenialDetail } from '../auth/denial-contract';

export const AUDIT_OUTBOX_MAX_ATTEMPTS = 8;

/** Batch immediately after a single D1 revocation. Audit-only denials explicitly
 * omit the previous-business-change assertion; receipt verification stays strict. */
export function auditOutboxEvidence(env: Env, envelope: AuditEnvelope, options: { requirePreviousChange?: boolean } = {}): MutationAuditEvidence {
  const payload = JSON.stringify(envelope);
  const id = envelope.row.eventId;
  if (!id || !envelope.row.occurredAt || new TextEncoder().encode(payload).length > 16384) throw new Error('Invalid outbox evidence');
  return {
    write: env.DB.prepare(`INSERT INTO audit_mutation_outbox (event_id, envelope)
      VALUES (?, ${options.requirePreviousChange === false ? '?' : "CASE WHEN changes() = 1 THEN ? ELSE json('{') END"})`).bind(id, payload),
    guard: abortIf(env, 'changes() <> 1 OR NOT EXISTS (SELECT 1 FROM audit_mutation_outbox WHERE event_id = ? AND envelope = ? AND attempts = 0 AND next_attempt_at = 0)', [id, payload]),
  };
}

// Identity/session revocations and bounded authentication denials are approved producers. Unknown or
// malformed envelopes stay pending for review; never silently drop evidence.
function readEnvelope(id: string, payload: string): AuditEnvelope {
  const envelope = JSON.parse(payload) as AuditEnvelope;
  const { row, actor, request } = envelope;
  const keysMatch = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!row || !actor || !request || row.eventId !== id || !Number.isFinite(Date.parse(row.occurredAt ?? ''))
    || !keysMatch(envelope, ['row', 'actor', 'request'])
    || !keysMatch(row, ['eventId', 'occurredAt', 'action', 'eventClass', 'retentionClass', 'outcome', 'dataClass',
      'targetType', 'targetId', 'targetIds', 'targetCount', 'containerKey', 'queryFingerprint', 'detail'])
    || !keysMatch(actor, ['userId', 'roles', 'sessionSid', 'via']) || !keysMatch(request, ['requestId', 'sourceIp', 'userAgent'])
    || !['none', 'pii', 'phi'].includes(row.dataClass)
    || row.targetIds !== null || row.containerKey !== null || row.queryFingerprint !== null
    || (actor.userId !== null && (typeof actor.userId !== 'string' || !/^\d+$/.test(actor.userId))) || (actor.roles !== null && !safeRoleAuditValue(actor.roles))
    || (actor.sessionSid !== null && (typeof actor.sessionSid !== 'string' || !/^\d+$/.test(actor.sessionSid)))
    || !row.detail
    || Object.values(request).some(value => value !== null && typeof value !== 'string')) throw new Error('Outbox evidence requires review');
  if (row.outcome === 'denied') {
    const permission = row.action === 'permission.denied';
    if (row.eventClass !== 'auth' || row.retentionClass !== 'auth' || row.targetType !== null || row.targetId !== null || row.targetCount !== null
      || actor.via !== null || !validDenialDetail(row.action, row.detail)
      || (permission ? actor.userId === null || actor.sessionSid === null
        : actor.userId !== null || actor.roles !== null || actor.sessionSid !== null)) throw new Error('Outbox denial evidence requires review');
    return envelope;
  }
  if (row.outcome !== 'success' || !/^\d+$/.test(row.targetId ?? '') || row.targetCount !== 1
    || typeof row.detail.classification_unavailable !== 'boolean' || typeof row.detail.roles_unavailable !== 'boolean') throw new Error('Outbox evidence requires review');
  if (row.action === 'user.oauth-disconnect') {
    if (row.eventClass !== 'admin' || row.retentionClass !== 'admin_config' || row.targetType !== 'user_oauth_identity' || actor.via !== null
      || actor.userId === null || actor.sessionSid === null
      || row.detail.user_id !== actor.userId || typeof row.detail.primary_replaced !== 'boolean'
      || !(row.detail.replacement_identity_id === null || (typeof row.detail.replacement_identity_id === 'number' && Number.isSafeInteger(row.detail.replacement_identity_id)))
      || !keysMatch(row.detail, ['user_id', 'primary_replaced', 'replacement_identity_id', 'classification_unavailable', 'roles_unavailable'])) throw new Error('Outbox evidence requires review');
  } else if (row.action === 'user.disable') {
    if (row.eventClass !== 'admin' || row.retentionClass !== 'admin_config' || row.targetType !== 'user'
      || actor.via !== null || actor.userId !== row.targetId || actor.sessionSid === null
      || !keysMatch(row.detail, ['classification_unavailable', 'roles_unavailable'])) throw new Error('Outbox evidence requires review');
  } else {
    const reasons: Record<string, string> = { 'auth.logout': 'logout', 'auth.session.revoke': 'explicit-revocation', 'auth.session.cap': 'session-cap', 'auth.session.expire': 'expired' };
    const reason = reasons[row.action];
    const maintenance = reason === 'session-cap' || reason === 'expired';
    if (!reason || row.eventClass !== 'auth' || row.retentionClass !== 'auth' || row.targetType !== 'session'
      || !/^\d+$/.test(String(row.detail.user_id ?? '')) || row.detail.reason !== reason
      || !keysMatch(row.detail, ['reason', 'user_id', 'classification_unavailable', 'roles_unavailable'])
      || (maintenance ? actor.userId !== null || actor.roles !== null || actor.sessionSid !== null || actor.via !== 'system:session-maintenance'
        : actor.userId !== row.detail.user_id || actor.sessionSid !== row.targetId || actor.via !== null)) throw new Error('Outbox evidence requires review');
  }
  return envelope;
}

export async function auditMutationOutboxHealth(env: Env) {
  return env.DB.prepare(`SELECT COUNT(*) AS pending,
    COALESCE(SUM(attempts >= ?), 0) AS exhausted, MIN(created_at) AS oldest
    FROM audit_mutation_outbox`).bind(AUDIT_OUTBOX_MAX_ATTEMPTS)
    .first<{ pending: number; exhausted: number; oldest: string | null }>();
}

/** Bounded delivery, safe under concurrent/repeated calls and lost commit
 * acknowledgments. Pending rows are removed only with an exact primary event
 * in the same D1 batch. Backoff/exhausted evidence never expires automatically. */
export async function drainAuditMutationOutbox(env: Env, eventId?: string, limit = 50) {
  const result = { attempted: 0, delivered: 0, failed: 0, unavailable: false };
  try {
    const now = Math.floor(Date.now() / 1000);
    const pending = await env.DB.prepare(`SELECT event_id, envelope, attempts FROM audit_mutation_outbox
      WHERE attempts < ? AND next_attempt_at <= ? AND (? IS NULL OR event_id = ?)
      ORDER BY next_attempt_at, created_at, event_id LIMIT ?`)
      .bind(AUDIT_OUTBOX_MAX_ATTEMPTS, now, eventId ?? null, eventId ?? null, Math.min(50, Math.max(1, Math.trunc(limit))))
      .all<{ event_id: string; envelope: string; attempts: number }>();
    for (const item of pending.results) {
      result.attempted++;
      try {
        const evidence = auditDeliveryEvidence(env, readEnvelope(item.event_id, item.envelope));
        await env.DB.batch([
          evidence.write, evidence.guard,
          env.DB.prepare('DELETE FROM audit_mutation_outbox WHERE event_id = ? AND envelope = ?').bind(item.event_id, item.envelope),
          abortIf(env, 'EXISTS (SELECT 1 FROM audit_mutation_outbox WHERE event_id = ?)', [item.event_id]),
          evidence.guard,
        ]);
        result.delivered++;
      } catch {
        result.failed++;
        await env.DB.prepare(`UPDATE audit_mutation_outbox SET attempts = attempts + 1, next_attempt_at = ?
          WHERE event_id = ? AND envelope = ? AND attempts = ? AND attempts < ?`)
          .bind(now + Math.min(3600, 60 * 2 ** item.attempts), item.event_id, item.envelope, item.attempts, AUDIT_OUTBOX_MAX_ATTEMPTS).run();
      }
    }
    const health = await auditMutationOutboxHealth(env);
    if (result.failed || health?.exhausted) await recordAuditOutage(env, 'audit-write', [], undefined, undefined, { captureIncomplete: true });
    if (health?.pending || result.attempted) console.log(JSON.stringify({ event: 'audit.mutation-outbox', ...result, ...health }));
  } catch {
    result.unavailable = true;
    console.error(JSON.stringify({ event: 'audit.mutation-outbox-unavailable' }));
    await recordAuditOutage(env, 'health', [], undefined, undefined, { captureIncomplete: true });
  }
  return result;
}
