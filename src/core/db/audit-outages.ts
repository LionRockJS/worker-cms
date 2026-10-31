import type { Env } from '../../types';
import type { AuditActor, AuditRow } from './audit';

export const OUTAGE_PREFIX = 'audit-outages/';
export type OutageReason = 'audit-write' | 'classification' | 'health' | 'archive';
export interface AuditOutage {
  version: 1; id: string; observedAt: string; reason: OutageReason;
  source?: string | null;
  actor: { userId: string | null; via: string | null };
  eventCount: number; captureComplete: boolean;
  // Private diagnostic metadata, never sent to the alert receiver.
  records: Array<Record<string, unknown>>;
  checks?: AuditHealthChecks;
}
export interface AuditHealthChecks {
  primaryWritable: boolean; classificationAvailable: boolean; journalWritable: boolean;
  archiveHealthy: boolean; admissionReady: boolean; alertDeliveryHealthy: boolean; monitorConfigured: boolean; monitorReachable: boolean;
}
export interface AlertState { deliveredAt?: string; attempts: number; nextAttemptAt?: string }
export const outageEnabled = (env: Env) => env.AUDIT_OUTAGE_MONITORING === 'true';
export const monitorSource = (env: Env) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(env.AUDIT_MONITOR_SOURCE ?? '') ? env.AUDIT_MONITOR_SOURCE! : null;
export const incidentKey = (id: string) => `${OUTAGE_PREFIX}incidents/${id}.json`;
export const reviewKey = (id: string) => `${OUTAGE_PREFIX}reviews/${id}.json`;
const alertKey = (id: string) => `${OUTAGE_PREFIX}alerts/${id}.json`;

/** Failure reporting must not indefinitely delay a containment operation. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Outage journal deadline exceeded')), 1000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** The receiver must deduplicate Idempotency-Key. Only coarse operational
 * facts leave the CMS; no actors, record IDs, container keys or payloads. */
export async function deliverOutageAlert(env: Env, incident: AuditOutage, journalRecorded = true): Promise<boolean> {
  const candidate = incident.source ?? monitorSource(env);
  const source = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate ?? '') ? candidate : null;
  if (!env.AUDIT_MONITOR || !source) return false;
  let state: AlertState = { attempts: 0 };
  try {
    const object = env.AUDIT_OUTAGE_BUCKET ? await bounded(env.AUDIT_OUTAGE_BUCKET.get(alertKey(incident.id))) : null;
    const stored = object ? await bounded(object.json<AlertState>()) : null;
    if (stored && Number.isSafeInteger(stored.attempts) && stored.attempts >= 0
        && (!stored.deliveredAt || Number.isFinite(Date.parse(stored.deliveredAt)))
        && (!stored.nextAttemptAt || Number.isFinite(Date.parse(stored.nextAttemptAt)))) state = stored;
    if (state.deliveredAt) return true;
    if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) return false;
  } catch { /* A journal outage must not suppress independent notification. */ }
  const attempts = state.attempts + 1;
  let deliveredAt: string | undefined;
  try {
    const response = await env.AUDIT_MONITOR.fetch('https://audit-monitor.internal/incidents', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': incident.id },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ version: 1, kind: 'audit-outage', source, incidentId: incident.id,
        observedAt: new Date(incident.observedAt).toISOString(), reason: incident.reason,
        eventCount: Number.isSafeInteger(incident.eventCount) ? incident.eventCount : 0,
        journalRecorded, captureComplete: incident.captureComplete === true }),
    });
    if (response.ok) deliveredAt = new Date().toISOString();
    await bounded(response.body?.cancel() ?? Promise.resolve());
  } catch { /* Persist the retry state below. Never change the primary failure. */ }
  const next: AlertState = deliveredAt ? { attempts, deliveredAt }
    : { attempts, nextAttemptAt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(attempts - 1, 6)) * 1000).toISOString() };
  try { if (env.AUDIT_OUTAGE_BUCKET) await bounded(env.AUDIT_OUTAGE_BUCKET.put(alertKey(incident.id), JSON.stringify(next))); }
  catch { console.error(JSON.stringify({ event: 'audit.alert-state-unavailable', incidentId: incident.id })); }
  if (!deliveredAt) console.error(JSON.stringify({ event: 'audit.alert-delivery-failed', incidentId: incident.id }));
  return !!deliveredAt;
}

/** A second storage path for failure evidence. No error strings, raw detail,
 * names, bodies, URLs, credentials, IPs or email are copied into the journal.
 * Identifiers may themselves be regulated: AUDIT_OUTAGE_BUCKET must remain private. */
export async function recordAuditOutage(env: Env, reason: OutageReason,
  rows: readonly AuditRow[] = [], actor?: AuditActor,
  checks?: AuditHealthChecks,
): Promise<string | null> {
  if (!outageEnabled(env)) return null;
  const actorId = (value: string | null | undefined) => value && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null;
  const incident: AuditOutage = { version: 1, id: crypto.randomUUID(), observedAt: new Date().toISOString(), reason,
    source: monitorSource(env),
    actor: { userId: actorId(actor?.userId), via: actorId(actor?.via) },
    eventCount: rows.length, captureComplete: rows.length <= 50, records: [],
    ...(checks ? { checks } : {}),
  };
  if (actor && (incident.actor.userId !== actor.userId || incident.actor.via !== actor.via)) incident.captureComplete = false;
  try {
    let recordBytes = 0;
    for (const row of rows.slice(0, 50)) {
      let complete = true;
      const text = (value: string | null) => {
        if (value == null) return null;
        if (value.includes('://') || value.includes('@')) { complete = false; return '[redacted-identifier]'; }
        if (value.length > 1024) complete = false;
        return value.slice(0, 1024);
      };
      const ids = row.targetIds?.slice(0, 100).map(text) ?? null;
      if (row.targetIds && row.targetIds.length > 100) complete = false;
      if (row.targetCount != null && row.targetCount > (row.targetId ? 1 : row.targetIds?.length ?? 0)) complete = false;
      const record = { action: text(row.action), eventClass: row.eventClass, dataClass: row.dataClass,
        attemptedOutcome: row.outcome, targetType: text(row.targetType), targetId: text(row.targetId),
        targetIds: ids, targetCount: row.targetCount, containerKey: text(row.containerKey),
        queryFingerprint: text(row.queryFingerprint) };
      recordBytes += new TextEncoder().encode(JSON.stringify(record)).length;
      if (recordBytes > 240 * 1024) { incident.captureComplete = false; break; }
      incident.records.push(record);
      incident.captureComplete &&= complete;
    }
    let journalRecorded = false;
    try {
      if (env.AUDIT_OUTAGE_BUCKET) {
        await bounded(env.AUDIT_OUTAGE_BUCKET.put(incidentKey(incident.id), JSON.stringify(incident), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { observedAt: incident.observedAt, reason },
        }));
        journalRecorded = true;
      }
    } catch { /* The receiver and structured logs are independent fallbacks. */ }
    console.error(JSON.stringify({ event: 'audit.outage', incidentId: incident.id, reason,
      eventCount: incident.eventCount, journalRecorded }));
    await deliverOutageAlert(env, incident, journalRecorded);
    return incident.id;
  } catch {
    console.error(JSON.stringify({ event: 'audit.outage-report-failed', incidentId: incident.id, reason }));
    return null;
  }
}
