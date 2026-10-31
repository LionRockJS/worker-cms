import type { Env } from '../../types';
import { auditStatement, type AuditActor, type AuditRow } from '../../core/db/audit';
import { resolveDataClasses } from '../../core/db/data-classes';
import { deliverOutageAlert, incidentKey, monitorSource, outageEnabled, OUTAGE_PREFIX, recordAuditOutage, reviewKey,
  type AuditOutage, type AlertState } from '../../core/db/audit-outages';
import { archiveHealth } from './signals';
import { hotDaysFor } from './sweep';
import { assertRegulatedReady } from '../../core/http/regulated-profile';

const HEALTH_KEY = `${OUTAGE_PREFIX}health/latest.json`;
export const OUTAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface OutageHealth {
  checkedAt: string; primaryWritable: boolean; classificationAvailable: boolean;
  journalWritable: boolean; monitorConfigured: boolean; monitorReachable: boolean;
  archiveHealthy: boolean; scanCursor?: string;
  admissionReady: boolean;
  alertDeliveryHealthy: boolean;
}
export interface OutageReview {
  incidentId: string; reviewedAt: string; reviewerId: string;
  disposition: 'evidence-located' | 'containment-verified' | 'unrecoverable-gap';
  evidenceRef: string; evidenceSha256: string;
}
export interface OutageItem {
  id: string; observedAt: string; reason: string; eventCount: number;
  captureComplete: boolean; review: OutageReview | null; alertDelivered: boolean;
}

export async function readOutage(env: Env, id: string): Promise<AuditOutage | null> {
  if (!OUTAGE_ID.test(id) || !env.AUDIT_OUTAGE_BUCKET) return null;
  const object = await env.AUDIT_OUTAGE_BUCKET.get(incidentKey(id));
  if (!object) return null;
  if (object.size > 256 * 1024) { await object.body.cancel(); throw new Error('Outage diagnostic too large'); }
  const incident = await object.json<AuditOutage>();
  if (incident.version !== 1 || incident.id !== id || !Array.isArray(incident.records)
      || incident.records.length > 50 || !['audit-write', 'classification', 'health', 'archive'].includes(incident.reason)
      || !Number.isFinite(Date.parse(incident.observedAt))) throw new Error('Invalid outage diagnostic');
  return incident;
}

export async function outagePage(env: Env, cursor?: string) {
  if (!outageEnabled(env)) return { enabled: false, available: false, health: null, items: [], nextCursor: null };
  try {
    if (!env.AUDIT_OUTAGE_BUCKET) throw new Error('No journal');
    const health = await (await env.AUDIT_OUTAGE_BUCKET.get(HEALTH_KEY))?.json<OutageHealth>() ?? null;
    const page = await env.AUDIT_OUTAGE_BUCKET.list({ prefix: `${OUTAGE_PREFIX}incidents/`, limit: 20, ...(cursor ? { cursor } : {}) });
    const items: OutageItem[] = [];
    for (const object of page.objects) {
      const id = object.key.slice(`${OUTAGE_PREFIX}incidents/`.length, -5);
      const incident = await readOutage(env, id);
      if (!incident) throw new Error('Missing incident');
      const review = await (await env.AUDIT_OUTAGE_BUCKET.get(reviewKey(id)))?.json<OutageReview>() ?? null;
      const alert = await (await env.AUDIT_OUTAGE_BUCKET.get(`${OUTAGE_PREFIX}alerts/${id}.json`))?.json<AlertState>();
      items.push({ id, observedAt: incident.observedAt, reason: incident.reason, eventCount: incident.eventCount,
        captureComplete: incident.captureComplete, review, alertDelivered: !!alert?.deliveredAt });
    }
    return { enabled: true, available: true, health, items, nextCursor: page.truncated ? page.cursor : null };
  } catch { return { enabled: true, available: false, health: null, items: [], nextCursor: null }; }
}

/** A bounded independent check before regulated admission, never content work.
 * The receiver must alarm on missing heartbeats; the CMS cannot detect its own
 * stopped scheduler or a provider-wide outage from inside that scheduler. */
export async function monitorAuditOutages(env: Env): Promise<void> {
  if (!outageEnabled(env)) return;
  let previous: OutageHealth | null = null;
  try { previous = await (await env.AUDIT_OUTAGE_BUCKET?.get(HEALTH_KEY))?.json<OutageHealth>() ?? null; } catch { /* Probe below. */ }
  const health: OutageHealth = { checkedAt: new Date().toISOString(), primaryWritable: false,
    classificationAvailable: false, journalWritable: false, monitorConfigured: !!env.AUDIT_MONITOR && !!monitorSource(env),
    monitorReachable: false, archiveHealthy: false, admissionReady: false, alertDeliveryHealthy: true };
  try {
    await auditStatement(env, { action: 'audit.monitor.probe', eventClass: 'admin', dataClass: 'none', retentionClass: 'admin_config',
      outcome: 'success', targetType: 'audit_health', targetId: null, targetIds: null, targetCount: 0,
      containerKey: null, queryFingerprint: null, detail: { phase: 'health-probe' },
    }, { userId: null, roles: null, sessionSid: null, via: 'system:audit-monitor' }).run();
    health.primaryWritable = true;
  } catch { /* Primary failures must not stop journal/receiver checks. */ }
  health.classificationAvailable = (await resolveDataClasses(env, true, false)).ok;
  try { await assertRegulatedReady(env, true); health.admissionReady = true; } catch { /* Health still runs. */ }
  try {
    if (!env.AUDIT_OUTAGE_BUCKET) throw new Error('No journal');
    const key = `${OUTAGE_PREFIX}health/probe`;
    const token = crypto.randomUUID();
    await env.AUDIT_OUTAGE_BUCKET.put(key, token);
    const object = await env.AUDIT_OUTAGE_BUCKET.get(key);
    health.journalWritable = await object?.text() === token;
  } catch { /* Receiver remains independent of R2. */ }
  if (health.primaryWritable) {
    try {
      const archive = await archiveHealth(env, 1);
      const configured = Number(env.AUDIT_ARCHIVE_MAX_LAG_SECONDS ?? 3600);
      const lag = Number.isFinite(configured) && configured > 0 ? configured : 3600;
      health.archiveHealthy = archive.bucketBound && !(archive.verification ?? []).some(v => !v.contentOk || !v.chainOk)
        && (!archive.oldestUnarchived || Date.now() - Date.parse(archive.oldestUnarchived) <= lag * 1000);
    } catch { /* Existing archive code supplies the checks. */ }
  }
  if (env.AUDIT_OUTAGE_BUCKET) {
    try {
      // Rotate through the whole journal, rather than starving new incidents
      // behind old reviewed entries. Each tick handles at most ten objects.
      const page = await env.AUDIT_OUTAGE_BUCKET.list({ prefix: `${OUTAGE_PREFIX}incidents/`, limit: 10,
        ...(previous?.scanCursor ? { cursor: previous.scanCursor } : {}) });
      for (const object of page.objects) {
        try {
          const id = object.key.slice(`${OUTAGE_PREFIX}incidents/`.length, -5);
          if (await env.AUDIT_OUTAGE_BUCKET.head(reviewKey(id))) continue;
          const incident = await readOutage(env, id);
          if (!incident) throw new Error('Missing outage diagnostic');
          if (!await deliverOutageAlert(env, incident)) health.alertDeliveryHealthy = false;
        } catch { health.journalWritable = false; }
      }
      if (page.truncated) health.scanCursor = page.cursor;
    } catch { health.journalWritable = false; }
  }
  try {
    if (env.AUDIT_MONITOR && monitorSource(env)) {
      const response = await env.AUDIT_MONITOR.fetch('https://audit-monitor.internal/heartbeat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
        body: JSON.stringify({ version: 1, kind: 'audit-heartbeat', source: monitorSource(env), checkedAt: health.checkedAt,
          primaryWritable: health.primaryWritable, classificationAvailable: health.classificationAvailable,
          journalWritable: health.journalWritable, archiveHealthy: health.archiveHealthy, admissionReady: health.admissionReady,
          alertDeliveryHealthy: health.alertDeliveryHealthy }),
      });
      health.monitorReachable = response.ok;
      await response.body?.cancel();
    }
  } catch { /* State and structured diagnostics remain available. */ }
  const conditions = (h: OutageHealth) => [h.primaryWritable, h.classificationAvailable, h.journalWritable,
    h.archiveHealthy, h.admissionReady, h.alertDeliveryHealthy, h.monitorConfigured, h.monitorReachable];
  if (conditions(health).some(value => !value) && (!previous || JSON.stringify(conditions(previous)) !== JSON.stringify(conditions(health)))) {
    await recordAuditOutage(env, 'health', [], undefined, {
      primaryWritable: health.primaryWritable, classificationAvailable: health.classificationAvailable,
      journalWritable: health.journalWritable, archiveHealthy: health.archiveHealthy,
      admissionReady: health.admissionReady,
      alertDeliveryHealthy: health.alertDeliveryHealthy,
      monitorConfigured: health.monitorConfigured, monitorReachable: health.monitorReachable });
  }
  if (!health.monitorReachable) console.error(JSON.stringify({ event: 'audit.monitor-unreachable', configured: health.monitorConfigured }));

  try { await env.AUDIT_OUTAGE_BUCKET?.put(HEALTH_KEY, JSON.stringify(health)); }
  catch { console.error(JSON.stringify({ event: 'audit.health-state-unavailable' })); }
}

/** Human review receipt only. Never replays a business effect or manufactures
 * a historical success row. The unique incident ID makes retries idempotent. */
export async function reconcileOutage(env: Env, id: string, actor: AuditActor,
  input: Pick<OutageReview, 'disposition' | 'evidenceRef' | 'evidenceSha256'>,
): Promise<OutageReview> {
  if (!outageEnabled(env) || !env.AUDIT_OUTAGE_BUCKET || !actor.userId) throw new Error('Outage unavailable');
  const incident = await readOutage(env, id);
  if (!incident) throw new Error('Outage unavailable');
  if (!['evidence-located', 'containment-verified', 'unrecoverable-gap'].includes(input.disposition)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(input.evidenceRef)
      || !/^[a-f0-9]{64}$/.test(input.evidenceSha256)) throw new Error('Invalid review evidence');
  const review: OutageReview = { incidentId: id, reviewedAt: new Date().toISOString(), reviewerId: actor.userId, ...input };
  const matches = (saved: OutageReview) => saved.incidentId === id && saved.disposition === review.disposition
    && saved.evidenceRef === review.evidenceRef && saved.evidenceSha256 === review.evidenceSha256 && saved.reviewerId === review.reviewerId;
  const prior = await (await env.AUDIT_OUTAGE_BUCKET.get(reviewKey(id)))?.json<OutageReview>();
  if (prior) {
    if (!matches(prior)) throw new Error('Review already recorded');
    return prior;
  }
  const row: AuditRow = { eventId: id, occurredAt: review.reviewedAt, action: 'audit.outage.reconcile', eventClass: 'admin',
    dataClass: 'none', retentionClass: 'admin_config', outcome: 'success', targetType: 'audit_outage', targetId: id,
    targetIds: null, targetCount: 1, containerKey: null, queryFingerprint: null, detail: { ...review } };
  const receipt = () => env.DB.prepare("SELECT detail FROM audit_events WHERE event_id = ? AND action = 'audit.outage.reconcile'")
    .bind(id).first<{ detail: string }>();
  let canonical = await receipt();
  if (!canonical) {
    // A receipt could already have been archived/pruned after a prolonged
    // marker outage. Do not invent a second review with the same identity.
    if (Date.now() - Date.parse(incident.observedAt) > hotDaysFor('admin_config') * 86400_000) {
      throw new Error('Archived receipt verification required');
    }
    await auditStatement(env, row, actor).run();
    canonical = await receipt();
  }
  if (!canonical) throw new Error('Reconciliation receipt unavailable');
  const saved = JSON.parse(canonical.detail) as OutageReview;
  if (!matches(saved)) throw new Error('Review already recorded');
  // A failed marker write leaves the incident open; retry repairs the marker
  // using the same canonical D1 receipt, without creating a second decision.
  await env.AUDIT_OUTAGE_BUCKET.put(reviewKey(id), JSON.stringify(saved));
  return saved;
}
