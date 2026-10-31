import type { Env } from '../../types';
import { writeBackgroundAuditRows, type AuditActor, type AuditRow } from '../db/audit';
import { prepareReadAudits, type PendingRead } from './access-log';

/** Administrative exchanges need intent evidence even without a PII/PHI
 * declaration. Containment may continue with explicit degraded evidence. */
export async function auditOutboundIntent(env: Env, input: {
  action: string; destination: string; operation: string; targetType: string;
  ids: string[]; actor: AuditActor; containment?: boolean;
  reads: PendingRead[] | (() => Promise<PendingRead[]>);
}): Promise<boolean> {
  const detail = { destination: input.destination, operation: input.operation,
    delivery_id: crypto.randomUUID(), phase: 'intent', containment: !!input.containment };
  let classified: AuditRow[] = [];
  let classificationAvailable = true;
  try {
    const reads = typeof input.reads === 'function' ? await input.reads() : input.reads;
    const groups = await prepareReadAudits(env, reads.map(read => ({ ...read,
      actor: input.actor, detail, eventClass: 'export',
    })), input.actor, true);
    classified = groups.flatMap(group => group.rows);
  } catch (error) {
    if (!input.containment) {
      console.error('Outbound classification unavailable', { action: input.action, destination: input.destination, operation: input.operation });
      throw error;
    }
    classificationAvailable = false;
  }
  // The administrative envelope retains every identifier, including when a
  // record was already deleted or policy cannot be resolved. `none` here is
  // not a public-data assertion; classified supplemental rows carry policy.
  const rows: AuditRow[] = [];
  for (let offset = 0; offset < input.ids.length; offset += 100) {
    const ids = input.ids.slice(offset, offset + 100);
    rows.push({ action: input.action, eventClass: 'export', dataClass: 'none',
      retentionClass: 'admin_config', outcome: classificationAvailable ? 'success' : 'error',
      targetType: input.targetType, targetId: ids.length === 1 ? ids[0] : null,
      targetIds: ids.length === 1 ? null : ids, targetCount: ids.length,
      containerKey: null, queryFingerprint: null,
      detail: { ...detail, classification: classificationAvailable ? 'resolved' : 'unavailable' },
    });
  }
  try { await writeBackgroundAuditRows(env, [...rows, ...classified], input.actor, true); }
  catch (error) {
    if (!input.containment) {
      console.error('Outbound audit unavailable', { action: input.action, destination: input.destination, operation: input.operation });
      throw error;
    }
    console.error('Containment audit unavailable', { action: input.action, destination: input.destination });
    return false;
  }
  if (!classificationAvailable) console.error('Containment classification unavailable', { action: input.action, destination: input.destination });
  return classificationAvailable;
}
