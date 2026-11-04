// W13 technical exercise: alert to investigation (A.5.24–A.5.26, A.8.16).
// A burst of refused requests trips a signal; the signal reaches the receiver
// without personal data; a reviewer records the decision with a case
// reference; the receipt is retrievable and clears the overdue flag that the
// heartbeat carries to the receiver.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { createAuthSession, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { OUTAGE_PREFIX } from '../src/core/db/audit-outages';
import { reviewSignals } from '../src/features/audit/signals';
import { monitorAuditOutages } from '../src/features/audit/outages';
import { deliverSignalAlerts, lastSignalReview, reviewOverdue, SIGNAL_REVIEW_ACTION } from '../src/features/audit/signal-review';
import type { Env } from '../src/types';

const reviewer = { id: 9931, email: 'incident-reviewer@example.invalid', name: 'Incident reviewer', role: 'admin' };
const editor = { id: 9932, email: 'incident-editor@example.invalid', name: 'Incident editor', role: 'editor' };
const PROBE_IP = '203.0.113.77';
let session: IssuedAuthTokens;
let cfg: Env;
let messages: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>;
let receiverStatus: number;
let requestNumber = 0;

async function request(path: string, form?: Record<string, string>, tokens = session) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com/admin${path}`, {
    method: form ? 'POST' : 'GET', redirect: 'manual',
    headers: { Cookie: `__Host-access_token=${tokens.accessToken}`, 'Sec-Fetch-Site': 'same-origin', Origin: 'https://cms.example.com',
      'CF-Connecting-IP': `10.96.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const flash = (response: Response) => decodeURIComponent(new URL(response.headers.get('Location') ?? '', 'https://x').searchParams.get('flash') ?? '');

/** Six refused attempts from one address, as a probe would leave them. */
async function seedProbe() {
  for (let i = 0; i < 6; i++) {
    await env.DB.prepare(`INSERT INTO audit_events (event_id, occurred_at, event_class, data_class, retention_class, action, outcome, source_ip)
      VALUES (?, ?, 'auth', 'none', 'auth', 'auth.denied', 'denied', ?)`)
      .bind(crypto.randomUUID(), new Date(Date.now() - i * 60_000).toISOString(), PROBE_IP).run();
  }
}
async function clearJournal() {
  const objects = await env.MEDIA_BUCKET!.list({ prefix: OUTAGE_PREFIX, limit: 1000 });
  if (objects.objects.length) await env.MEDIA_BUCKET!.delete(objects.objects.map(object => object.key));
}

beforeEach(async () => {
  clearRolePermissionsCache();
  messages = []; receiverStatus = 200;
  for (const table of ['audit_events', 'audit_mutation_outbox', 'sessions']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  for (const user of [reviewer, editor]) {
    await env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = excluded.role')
      .bind(user.id, `fixture:${user.id}`, user.email, user.name, user.role).run();
  }
  session = await createAuthSession(env, reviewer);
  await clearJournal();
  cfg = { ...env, AUDIT_OUTAGE_MONITORING: 'true', AUDIT_OUTAGE_BUCKET: env.MEDIA_BUCKET, AUDIT_MONITOR_SOURCE: 'cms-test',
    AUDIT_MONITOR: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      messages.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(null, { status: receiverStatus });
    } } as Fetcher } as unknown as Env;
});
afterEach(clearJournal);

describe('alert delivery', () => {
  it('sends a flagged signal once a day, with counts and no personal data', async () => {
    await seedProbe();
    const signals = await reviewSignals(cfg);
    expect(signals.find(signal => signal.id === 'refused_access')!.rows).toHaveLength(1);

    const day = new Date('2026-11-04T10:00:00Z');
    expect(await deliverSignalAlerts(cfg, signals, day)).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].path).toBe('/signals');
    expect(messages[0].headers.get('Idempotency-Key')).toBe('cms-test:refused_access:2026-11-04');
    expect(messages[0].body).toEqual({ version: 1, kind: 'security-signal', source: 'cms-test', signal: 'refused_access',
      day: '2026-11-04', flagged: 1, windowHours: 24, threshold: 5 });
    expect(JSON.stringify(messages[0].body)).not.toContain(PROBE_IP);

    expect(await deliverSignalAlerts(cfg, signals, new Date('2026-11-04T11:00:00Z'))).toBe(0);
    expect(await deliverSignalAlerts(cfg, signals, new Date('2026-11-05T10:00:00Z'))).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it('retries a refused delivery and sends nothing when nothing is flagged', async () => {
    expect(await deliverSignalAlerts(cfg, await reviewSignals(cfg))).toBe(0);
    expect(messages).toHaveLength(0);

    await seedProbe();
    receiverStatus = 503;
    expect(await deliverSignalAlerts(cfg, await reviewSignals(cfg))).toBe(0);
    receiverStatus = 200;
    expect(await deliverSignalAlerts(cfg, await reviewSignals(cfg))).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it('is inert without outage monitoring', async () => {
    await seedProbe();
    expect(await deliverSignalAlerts({ ...cfg, AUDIT_OUTAGE_MONITORING: undefined } as Env, await reviewSignals(cfg))).toBe(0);
    expect(messages).toHaveLength(0);
  });
});

describe('review receipt', () => {
  it('records the decision, clears the overdue flag and reports both in the heartbeat', async () => {
    await seedProbe();
    expect(reviewOverdue(cfg, await lastSignalReview(cfg))).toBe(true);
    await monitorAuditOutages(cfg);
    expect(messages.find(message => message.path === '/heartbeat')!.body.signalReviewOverdue).toBe(true);

    const page = await (await request('/audit/review')).text();
    expect(page).toContain('"reviewOverdue":true');

    expect(flash(await request('/audit/review/record', { outcome: 'incident-opened' })))
      .toBe('Choose an outcome; an opened incident needs a case reference');
    expect(flash(await request('/audit/review/record', { outcome: 'no-action', reference: 'guest@example.invalid' })))
      .toBe('Choose an outcome; an opened incident needs a case reference');
    expect(await lastSignalReview(cfg)).toBeNull();

    expect(flash(await request('/audit/review/record', { outcome: 'incident-opened', reference: 'INC-2026-0042' }))).toBe('Review recorded');
    const receipt = await env.DB.prepare('SELECT actor_user_id, detail, event_class, outcome FROM audit_events WHERE action = ?')
      .bind(SIGNAL_REVIEW_ACTION).first<{ actor_user_id: string; detail: string; event_class: string; outcome: string }>();
    expect(receipt).toMatchObject({ actor_user_id: String(reviewer.id), event_class: 'admin', outcome: 'success' });
    expect(JSON.parse(receipt!.detail)).toEqual({ outcome: 'incident-opened', reference: 'INC-2026-0042',
      flagged: { bulk_reads: 0, refused_access: 1, contributor_alone: 0 } });

    const last = await lastSignalReview(cfg);
    expect(last).toMatchObject({ by: reviewer.id, outcome: 'incident-opened', reference: 'INC-2026-0042' });
    expect(reviewOverdue(cfg, last)).toBe(false);
    expect(reviewOverdue(cfg, last, Date.now() + 8 * 86_400_000)).toBe(true);
    expect(reviewOverdue({ ...cfg, AUDIT_REVIEW_INTERVAL_DAYS: '30' } as Env, last, Date.now() + 8 * 86_400_000)).toBe(false);

    messages = [];
    await monitorAuditOutages(cfg);
    expect(messages.find(message => message.path === '/heartbeat')!.body.signalReviewOverdue).toBe(false);
  });

  it('cannot be recorded without audit:read', async () => {
    const editorSession = await createAuthSession(env, editor);
    expect((await request('/audit/review/record', { outcome: 'no-action' }, editorSession)).status).toBe(403);
    expect(await lastSignalReview(cfg)).toBeNull();
  });
});
