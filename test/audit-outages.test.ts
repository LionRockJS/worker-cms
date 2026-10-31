import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import cmsWorker from '../src/index';
import { recordAuditOutage, deliverOutageAlert, incidentKey, reviewKey, OUTAGE_PREFIX } from '../src/core/db/audit-outages';
import { writeBackgroundAuditRows, type AuditRow } from '../src/core/db/audit';
import { monitorAuditOutages, outagePage, readOutage, reconcileOutage } from '../src/features/audit/outages';
import { auditRoutes } from '../src/features/audit/routes';
import type { Env, Variables } from '../src/types';

const actor = { userId: '7501', roles: 'admin', sessionSid: null, via: null };
const row: AuditRow = { action: 'page.private-read', eventClass: 'read', dataClass: 'phi', retentionClass: 'phi_access', outcome: 'success',
  targetType: 'page', targetId: 'private-record-id', targetIds: null, targetCount: 1,
  containerKey: 'patient-chart', queryFingerprint: null, detail: { body: 'NEVER COPY THIS BODY', secret: 'NEVER COPY THIS SECRET' } };
const evidence = { disposition: 'containment-verified' as const, evidenceRef: 'SEC-42', evidenceSha256: 'a'.repeat(64) };
let messages: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
let receiverStatus = 200;
let cfg: Env;

beforeEach(async () => {
  messages = []; receiverStatus = 200;
  for (const table of ['audit_events', 'audit_seals', 'data_classes', 'role_permissions', 'roles', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  const objects = await env.MEDIA_BUCKET!.list({ prefix: OUTAGE_PREFIX, limit: 1000 });
  if (objects.objects.length) await env.MEDIA_BUCKET!.delete(objects.objects.map(object => object.key));
  cfg = { ...env, AUDIT_OUTAGE_MONITORING: 'true', AUDIT_OUTAGE_BUCKET: env.MEDIA_BUCKET,
    AUDIT_MONITOR_SOURCE: 'cms-test', AUDIT_MONITOR: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      messages.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(null, { status: receiverStatus });
    } } as Fetcher } as unknown as Env;
});
afterEach(async () => {
  const objects = await env.MEDIA_BUCKET!.list({ prefix: OUTAGE_PREFIX, limit: 1000 });
  if (objects.objects.length) await env.MEDIA_BUCKET!.delete(objects.objects.map(object => object.key));
});

it('is inert when monitoring is not enabled', async () => {
  const off = { ...cfg, AUDIT_OUTAGE_MONITORING: undefined };
  expect(await recordAuditOutage(off, 'audit-write', [row], actor)).toBeNull();
  await monitorAuditOutages(off);
  expect(messages).toEqual([]);
  expect((await env.MEDIA_BUCKET!.list({ prefix: OUTAGE_PREFIX })).objects).toEqual([]);
});

it('journals a strict primary failure without suppressing the original refusal', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await expect(writeBackgroundAuditRows(cfg, [row], actor, true)).rejects.toThrow(); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  const page = await outagePage(cfg);
  expect(page.items).toHaveLength(1);
  const incident = await readOutage(cfg, page.items[0].id);
  expect(incident).toMatchObject({ actor: { userId: '7501' }, reason: 'audit-write', eventCount: 1, captureComplete: true });
  expect(JSON.stringify(incident)).toContain('private-record-id');
  expect(JSON.stringify(incident)).not.toMatch(/NEVER COPY THIS BODY|NEVER COPY THIS SECRET/);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages[0].body)).not.toMatch(/7501|private-record-id|patient-chart|page.private-read|NEVER COPY/);
  expect(messages[0].headers.get('Idempotency-Key')).toBe(page.items[0].id);
});

it('records best-effort write failures too', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await expect(writeBackgroundAuditRows(cfg, [row], actor, false)).resolves.toBeUndefined(); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  expect((await outagePage(cfg)).items).toHaveLength(1);
});

it('still notifies the independent receiver when the private journal is unavailable', async () => {
  const unavailable = { ...cfg, AUDIT_OUTAGE_BUCKET: { get: async () => { throw new Error('unavailable'); }, put: async () => { throw new Error('unavailable'); } } as unknown as R2Bucket };
  await expect(recordAuditOutage(unavailable, 'audit-write', [row], actor)).resolves.toMatch(/^[a-f0-9-]{36}$/);
  expect(messages[0].body.journalRecorded).toBe(false);
  expect((await outagePage(unavailable)).available).toBe(false);
});

it('bounds a stalled journal rather than indefinitely delaying containment failure handling', async () => {
  const stalled = { ...cfg, AUDIT_OUTAGE_BUCKET: { get: async () => null, put: () => new Promise(() => {}) } as unknown as R2Bucket };
  await expect(recordAuditOutage(stalled, 'audit-write', [row], actor)).resolves.toMatch(/^[a-f0-9-]{36}$/);
  expect(messages[0].body.journalRecorded).toBe(false);
});

it('bounds diagnostics and explicitly reports incomplete identifier capture', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', Array.from({ length: 60 }, () => row), actor))!;
  const incident = (await readOutage(cfg, id))!;
  expect(incident.records).toHaveLength(50); expect(incident.eventCount).toBe(60); expect(incident.captureComplete).toBe(false);
  const second = (await recordAuditOutage(cfg, 'audit-write', [{ ...row, targetId: null, targetIds: ['one'], targetCount: 200 }], actor))!;
  expect((await readOutage(cfg, second))?.captureComplete).toBe(false);
  const large = { ...row, targetId: null, targetIds: Array(100).fill('x'.repeat(1024)), targetCount: 100 };
  const capped = (await recordAuditOutage(cfg, 'audit-write', Array(50).fill(large), actor))!;
  expect((await readOutage(cfg, capped))?.captureComplete).toBe(false);
  expect((await cfg.AUDIT_OUTAGE_BUCKET!.head(incidentKey(capped)))!.size).toBeLessThanOrEqual(256 * 1024);
});

it('does not replicate email or credential-bearing URL identifiers into the journal', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [{ ...row,
    targetId: 'https://user:PRIVATE@example.invalid/path?token=PRIVATE', containerKey: 'person@example.invalid' }], actor))!;
  const incident = (await readOutage(cfg, id))!;
  expect(incident.captureComplete).toBe(false);
  expect(JSON.stringify(incident)).not.toMatch(/PRIVATE|example.invalid/);
});

it('persists alert retry state and retries with the same receiver idempotency key', async () => {
  receiverStatus = 503;
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const incident = (await readOutage(cfg, id))!;
  await deliverOutageAlert(cfg, incident);
  expect(messages).toHaveLength(1); // Backoff, not a tight loop.
  const key = `${OUTAGE_PREFIX}alerts/${id}.json`;
  await cfg.AUDIT_OUTAGE_BUCKET!.put(key, JSON.stringify({ attempts: 1, nextAttemptAt: '2020-01-01T00:00:00.000Z' }));
  receiverStatus = 200;
  cfg.AUDIT_MONITOR_SOURCE = 'changed-source';
  await deliverOutageAlert(cfg, incident);
  await deliverOutageAlert(cfg, incident);
  expect(messages).toHaveLength(2);
  expect(messages.every(message => message.headers.get('Idempotency-Key') === id)).toBe(true);
  expect(messages.every(message => message.body.source === 'cms-test')).toBe(true);
  expect((await outagePage(cfg)).items[0].alertDelivered).toBe(true);
});

it('does not forward journal content through coarse alert fields', async () => {
  const id = (await recordAuditOutage(cfg, 'health'))!;
  const incident = (await readOutage(cfg, id))!;
  await cfg.AUDIT_OUTAGE_BUCKET!.delete(`${OUTAGE_PREFIX}alerts/${id}.json`);
  await deliverOutageAlert(cfg, { ...incident, eventCount: 'PRIVATE' as unknown as number, captureComplete: 'PRIVATE' as unknown as boolean });
  expect(messages[1].body.eventCount).toBe(0);
  expect(messages[1].body.captureComplete).toBe(false);
  expect(JSON.stringify(messages[1].body)).not.toContain('PRIVATE');
});

it('checks actual primary/journal writes, archive and classification, and sends a PHI-free heartbeat', async () => {
  await monitorAuditOutages(cfg);
  const page = await outagePage(cfg);
  expect(page.health).toMatchObject({ primaryWritable: true, classificationAvailable: true, journalWritable: true,
    archiveHealthy: true, admissionReady: true, monitorConfigured: true, monitorReachable: true });
  const heartbeat = messages.find(message => message.path === '/heartbeat');
  expect(heartbeat?.body).toMatchObject({ source: 'cms-test', primaryWritable: true, journalWritable: true });
  expect(heartbeat?.body).not.toHaveProperty('monitorReachable');
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'audit.monitor.probe'").first<{ n: number }>())?.n).toBe(1);
});

it('keeps monitoring before a failed regulated admission gate without running content work', async () => {
  cfg.REGULATED_MODE = 'true'; cfg.REGULATED_INVENTORY = '[]';
  await expect(cmsWorker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
    cfg, createExecutionContext())).rejects.toThrow();
  expect(messages.some(message => message.path === '/heartbeat' && message.body.admissionReady === false)).toBe(true);
  expect((await outagePage(cfg)).items.some(item => item.reason === 'health')).toBe(true);
});

it('monitors primary outages without relying on the broken table', async () => {
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await monitorAuditOutages(cfg); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  const page = await outagePage(cfg);
  expect(page.health?.primaryWritable).toBe(false);
  expect(page.items.some(item => item.reason === 'health')).toBe(true);
  expect(messages.some(message => message.path === '/heartbeat' && message.body.primaryWritable === false)).toBe(true);
});

it('detects archive backlog using existing archive health and an operator threshold', async () => {
  await env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome) VALUES (?, ?, 'read', 'none', 'none', 'test', 'success')")
    .bind(crypto.randomUUID(), new Date(Date.now() - 7200_000).toISOString()).run();
  await monitorAuditOutages(cfg);
  expect((await outagePage(cfg)).health?.archiveHealthy).toBe(false);
});

it('reports corrupt diagnostics as unavailable in the heartbeat, not as an empty healthy journal', async () => {
  await cfg.AUDIT_OUTAGE_BUCKET!.put(incidentKey(crypto.randomUUID()), '{broken');
  await monitorAuditOutages(cfg);
  expect(messages.find(message => message.path === '/heartbeat')?.body.journalWritable).toBe(false);
  expect((await outagePage(cfg)).available).toBe(false);
});

it('reports pending failed alerts even when the heartbeat endpoint is reachable', async () => {
  cfg.AUDIT_MONITOR = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    messages.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(null, { status: path === '/heartbeat' ? 200 : 503 });
  } } as Fetcher;
  await recordAuditOutage(cfg, 'audit-write', [row], actor);
  await monitorAuditOutages(cfg);
  expect(messages.find(message => message.path === '/heartbeat')?.body.alertDeliveryHealthy).toBe(false);
  expect((await outagePage(cfg)).health?.monitorReachable).toBe(true);
});

it('rotates bounded monitoring scans through a journal larger than one batch', async () => {
  const quiet = { ...cfg, AUDIT_MONITOR: undefined };
  for (let i = 0; i < 23; i++) await recordAuditOutage(quiet, 'audit-write', [row], actor);
  for (let i = 0; i < 4; i++) await monitorAuditOutages(cfg);
  const delivered = new Set(messages.filter(message => message.path === '/incidents').map(message => message.body.incidentId));
  expect(delivered.size).toBe(23);
  const first = await outagePage(cfg);
  expect(first.items).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
  expect((await outagePage(cfg, first.nextCursor!)).items).toHaveLength(3);
});

it('stores an idempotent review receipt without replaying or fabricating missing success events', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const first = await reconcileOutage(cfg, id, actor, evidence);
  expect(await reconcileOutage(cfg, id, actor, evidence)).toEqual(first);
  expect((await outagePage(cfg)).items[0].review).toMatchObject({ reviewerId: actor.userId, evidenceRef: 'SEC-42' });
  const rows = (await env.DB.prepare('SELECT action, event_id FROM audit_events').all()).results;
  expect(rows).toEqual([{ action: 'audit.outage.reconcile', event_id: id }]);
  await expect(reconcileOutage(cfg, id, actor, { ...evidence, evidenceRef: 'SEC-99' })).rejects.toThrow('already recorded');
});

it('requires constrained evidence references and a digest', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  for (const input of [{ ...evidence, evidenceRef: 'patient@example.com' }, { ...evidence, evidenceSha256: '' }]) {
    await expect(reconcileOutage(cfg, id, actor, input)).rejects.toThrow('Invalid review');
  }
  expect(await cfg.AUDIT_OUTAGE_BUCKET!.head(reviewKey(id))).toBeNull();
});

it('requires archive investigation rather than blindly recreating a potentially pruned review receipt', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const incident = (await readOutage(cfg, id))!;
  incident.observedAt = new Date(Date.now() - 500 * 86400_000).toISOString();
  await cfg.AUDIT_OUTAGE_BUCKET!.put(incidentKey(id), JSON.stringify(incident));
  await expect(reconcileOutage(cfg, id, actor, evidence)).rejects.toThrow('Archived receipt verification required');
  expect(await cfg.AUDIT_OUTAGE_BUCKET!.head(reviewKey(id))).toBeNull();
});

it('does not mark reviewed when the primary receipt cannot be persisted', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try { await expect(reconcileOutage(cfg, id, actor, evidence)).rejects.toThrow(); }
  finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  expect(await cfg.AUDIT_OUTAGE_BUCKET!.head(reviewKey(id))).toBeNull();
});

it('repairs a failed review marker write without changing or duplicating the primary receipt', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const bucket = cfg.AUDIT_OUTAGE_BUCKET!;
  const failing = { ...cfg, AUDIT_OUTAGE_BUCKET: { get: bucket.get.bind(bucket), put: async () => { throw new Error('marker failure'); } } as unknown as R2Bucket };
  await expect(reconcileOutage(failing, id, actor, evidence)).rejects.toThrow('marker failure');
  expect((await outagePage(cfg)).items[0].review).toBeNull();
  await reconcileOutage(cfg, id, actor, evidence);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'audit.outage.reconcile'").first<{ n: number }>())?.n).toBe(1);
  expect((await outagePage(cfg)).items[0].review).not.toBeNull();
});

function reviewApp(role: string) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', { sub: actor.userId, role, email: 'operator@example.invalid', name: 'Operator', type: 'access', iat: 1, exp: 9999999999 }); await next(); });
  app.route('/admin', auditRoutes);
  return app;
}

it('gates review actions and journals detail reads before returning private diagnostics', async () => {
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const app = reviewApp('viewer');
  const denied = await app.fetch(new Request(`http://localhost/admin/audit/outages/${id}/reconcile`, { method: 'POST', body: new URLSearchParams() }), cfg);
  expect(denied.status).toBe(403); await denied.text();
  const admin = reviewApp('admin');
  const response = await admin.fetch(new Request(`http://localhost/admin/audit/outages/${id}`), cfg);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json() as { id: string }).id).toBe(id);
  expect(await env.DB.prepare("SELECT event_id FROM audit_events WHERE action = 'audit.outage.read'").first()).not.toBeNull();
  await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
  try {
    const blocked = await admin.fetch(new Request(`http://localhost/admin/audit/outages/${id}`), cfg);
    expect(blocked.status).toBe(503); expect(await blocked.text()).not.toContain('private-record-id');
  } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
});

it('allows audit readers to inspect an incident but reserves review decisions for management permission', async () => {
  await env.DB.prepare("INSERT INTO roles (name, label) VALUES ('auditor', 'Auditor')").run();
  await env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES ('auditor', 'audit:read')").run();
  const id = (await recordAuditOutage(cfg, 'audit-write', [row], actor))!;
  const app = reviewApp('auditor');
  const read = await app.fetch(new Request(`http://localhost/admin/audit/outages/${id}`), cfg);
  expect(read.status).toBe(200); await read.text();
  const write = await app.fetch(new Request(`http://localhost/admin/audit/outages/${id}/reconcile`, { method: 'POST',
    body: new URLSearchParams({ disposition: evidence.disposition, evidence_ref: evidence.evidenceRef, evidence_sha256: evidence.evidenceSha256 }) }), cfg);
  expect(write.status).toBe(403); await write.text();
  expect(await cfg.AUDIT_OUTAGE_BUCKET!.head(reviewKey(id))).toBeNull();
});

it('does not render a stale all-green heartbeat as healthy', async () => {
  await monitorAuditOutages(cfg);
  const key = `${OUTAGE_PREFIX}health/latest.json`;
  const health = await (await cfg.AUDIT_OUTAGE_BUCKET!.get(key))!.json<Record<string, unknown>>();
  health.checkedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await cfg.AUDIT_OUTAGE_BUCKET!.put(key, JSON.stringify(health));
  const response = await reviewApp('admin').fetch(new Request('http://localhost/admin/audit/review'), cfg);
  expect(response.status).toBe(200);
  const html = await response.text();
  const payload = JSON.parse(html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s)![1]);
  expect(payload.bodyView.data.outageHealthy).toBe(false);
});
