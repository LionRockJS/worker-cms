import type { AppContext } from '../http/context';
import { routePath } from 'hono/route';
import { authDenialEnvelope, auditDeliveryEvidence, contextActor, type AuditActor } from '../db/audit';
import { auditOutboxEvidence } from '../db/audit-mutation-outbox';
import { recordAuditOutage } from '../db/audit-outages';
import { sessionPolicy } from './session-evidence';
import { safeRoleAuditValue } from './role-mutation-sql';
import { denialPermission, denialReason, denialRoute, permissionDenialReason, validDenialDetail, type AuthDenialAction, type PermissionDenialReason } from './denial-contract';

export class AuthDenialEvidenceUnavailableError extends Error {
  constructor() { super('Authentication denial evidence unavailable'); }
}

async function unavailable(c: AppContext): Promise<never> {
  await recordAuditOutage(c.env, 'audit-write', [], undefined, undefined, { captureIncomplete: true });
  throw new AuthDenialEvidenceUnavailableError();
}

/** Await before returning a refusal. Primary failure falls back to a complete
 * durable outbox receipt using the same ID; failure of both stores remains a
 * denied 503, never permission to continue into the protected handler. */
export async function recordAuthDenial(c: AppContext, action: AuthDenialAction, input: Record<string, string>): Promise<void> {
  const actor: AuditActor = action === 'permission.denied' ? contextActor(c) : { userId: null, roles: null, sessionSid: null, via: null };
  const detail: Record<string, unknown> = {};
  if (action === 'permission.denied') {
    if (!/^\d+$/.test(actor.userId ?? '') || !/^\d+$/.test(actor.sessionSid ?? '')) return unavailable(c);
    if (input.permission) detail.permission = denialPermission(input.permission) ? input.permission : 'unrecordable';
    else if (input.permissions) detail.permissions = input.permissions.length <= 8192 && input.permissions.split(',').length <= 32
      && input.permissions.split(',').every(denialPermission) ? input.permissions : 'unrecordable';
    else detail.reason = permissionDenialReason(input.reason ?? 'unknown');
    detail.path = denialRoute(input.path ?? '') ? input.path : '/admin/*';
    if (actor.roles !== null && !safeRoleAuditValue(actor.roles)) { actor.roles = null; detail.roles_unavailable = true; }
  } else detail.reason = denialReason(action, input.reason ?? 'unknown');
  const policy = await sessionPolicy(c.env, true).catch(() => ({ dataClass: 'phi' as const, unavailable: true }));
  if (policy.unavailable) detail.classification_unavailable = true;
  if (!validDenialDetail(action, detail)) return unavailable(c);
  const envelope = authDenialEnvelope(c, action, policy.dataClass, detail, actor);
  envelope.request = { ...envelope.request,
    requestId: envelope.request.requestId?.slice(0, 128) ?? null,
    sourceIp: envelope.request.sourceIp?.slice(0, 64) ?? null };
  try {
    const evidence = auditDeliveryEvidence(c.env, envelope);
    await c.env.DB.batch([evidence.write, evidence.guard]);
    return;
  } catch { /* The same ID also reconciles a possible lost primary commit acknowledgment. */ }
  try {
    const fallback = auditOutboxEvidence(c.env, envelope, { requirePreviousChange: false });
    await c.env.DB.batch([fallback.write, fallback.guard]);
  } catch {
    return unavailable(c);
  }
  await recordAuditOutage(c.env, 'audit-write', [], undefined, undefined, { captureIncomplete: true });
}

/** Route-level policy refusals use the same durable/private denial contract. */
export function recordPolicyDenial(c: AppContext, reason: PermissionDenialReason): Promise<void> {
  return recordAuthDenial(c, 'permission.denied', { reason, path: routePath(c, -1) });
}
