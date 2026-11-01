import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { signJWT } from './auth-fixtures';

let cookie: string;
let requestNumber = 0;
let observedAlerts: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  clearRolePermissionsCache();
  observedAlerts = [];
  const oldIncidents = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/' });
  for (const object of oldIncidents.objects) await env.AUDIT_OUTAGE_BUCKET!.delete(object.key);
  await env.DB.prepare('DROP TRIGGER IF EXISTS w4b_audit_failure').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS w4b_policy_failure').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare("INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (8100, 'github:w4b', 'operator@example.invalid', 'Synthetic Operator', '', 'admin')").run();
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8101, 'w4b-synthetic', 'Synthetic record', 'synthetic-record', 'w4b-chart', '{}')").run();
  const now = Math.floor(Date.now() / 1000);
  cookie = `access_token=${await signJWT({ sub: '8100', name: 'Synthetic Operator', email: 'operator@example.invalid', role: 'admin', type: 'access', iat: now, exp: now + 900 }, env.JWT_SECRET)}`;
});

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS w4b_audit_failure').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS w4b_policy_failure').run();
  clearRolePermissionsCache();
});

function change(dataClass: 'pii' | 'phi', note = 'synthetic note must not enter audit', monitor = false): Promise<Response> {
  requestNumber += 1;
  const body = new URLSearchParams({ container_kind: 'page_type', container_key: 'w4b-chart', class: dataClass, note });
  return worker.fetch(new Request('https://cms.example.com/admin/audit/classes', {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': `10.81.0.${requestNumber}`, 'CF-Ray': `w4b-${requestNumber}`, 'User-Agent': 'W4b synthetic test' },
    body,
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, CANONICAL_ORIGIN: 'https://cms.example.com',
    ...(monitor ? { AUDIT_OUTAGE_MONITORING: 'true', AUDIT_MONITOR_SOURCE: 'w4b-local-only',
      AUDIT_MONITOR: { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedAlerts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 200 });
      } } as Fetcher } : {}),
  }, createExecutionContext());
}

async function policy() {
  return env.DB.prepare("SELECT class, note FROM data_classes WHERE container_kind = 'page_type' AND container_key = 'w4b-chart'").first<{ class: string; note: string | null }>();
}

async function floors() {
  const container = await env.DB.prepare("SELECT level FROM data_class_floors WHERE container_kind = 'page_type' AND container_key = 'w4b-chart'").first<{ level: number }>();
  const page = await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid = 'w4b-synthetic'").first<{ level: number }>();
  return { container: container?.level ?? null, page: page?.level ?? null };
}

async function events() {
  return (await env.DB.prepare("SELECT event_id, action, event_class, data_class, retention_class, outcome, actor_user_id, actor_roles, request_id, source_ip, target_type, target_id, detail FROM audit_events WHERE action = 'data_class.set' ORDER BY seq").all<Record<string, unknown>>()).results;
}

it('commits attributable policy evidence with a PII assignment and PHI upgrade', async () => {
  expect((await change('pii')).status).toBe(302);
  expect(await floors()).toEqual({ container: 1, page: 1 });
  expect((await change('phi', 'new synthetic note')).status).toBe(302);
  expect(await policy()).toEqual({ class: 'phi', note: 'new synthetic note' });
  expect(await floors()).toEqual({ container: 2, page: 2 });
  const rows = await events();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(row => row.event_id)).size).toBe(2);
  expect(rows).toMatchObject([
    { action: 'data_class.set', event_class: 'admin', data_class: 'pii', retention_class: 'admin_config', outcome: 'success', actor_user_id: '8100', actor_roles: 'admin', target_type: 'settings', target_id: 'page_type:w4b-chart', detail: '{"class":"pii"}' },
    { action: 'data_class.set', event_class: 'admin', data_class: 'phi', retention_class: 'admin_config', outcome: 'success', actor_user_id: '8100', actor_roles: 'admin', target_type: 'settings', target_id: 'page_type:w4b-chart', detail: '{"class":"phi"}' },
  ]);
  expect(rows[1].request_id).toBe(`w4b-${requestNumber}`);
  expect(rows[1].source_ip).toBe(`10.81.0.${requestNumber}`);
  expect(JSON.stringify(rows)).not.toContain('synthetic note');
});

it('rolls back a new policy and both sensitivity floors when evidence insertion fails', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
  const response = await change('phi');
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toEqual({ error: 'Classification change unavailable' });
  expect(await policy()).toBeNull();
  expect(await floors()).toEqual({ container: null, page: null });
  expect(await events()).toEqual([]);
});

it('reports an ambiguous policy transaction failure without sensitive details or a false audit cause', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
  expect((await change('phi', 'private synthetic note', true)).status).toBe(503);
  const listed = await env.AUDIT_OUTAGE_BUCKET!.list({ prefix: 'audit-outages/incidents/' });
  expect(listed.objects).toHaveLength(1);
  const incident = await (await env.AUDIT_OUTAGE_BUCKET!.get(listed.objects[0].key))!.json<Record<string, unknown>>();
  expect(incident).toMatchObject({ reason: 'classification', eventCount: 0, captureComplete: false, records: [] });
  expect(observedAlerts).toHaveLength(1);
  expect(observedAlerts[0]).toMatchObject({ kind: 'audit-outage', reason: 'classification', eventCount: 0, captureComplete: false, journalRecorded: true });
  expect(JSON.stringify([incident, observedAlerts])).not.toContain('private synthetic note');
  expect(JSON.stringify(observedAlerts)).not.toContain('8100');
  expect(JSON.stringify(observedAlerts)).not.toContain('w4b-chart');
  expect(await policy()).toBeNull();
  expect(await events()).toEqual([]);
});

it('rolls back a classification when the audit insert is silently ignored', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN SELECT RAISE(IGNORE); END").run();
  expect((await change('phi')).status).toBe(503);
  expect(await policy()).toBeNull(); expect(await floors()).toEqual({ container: null, page: null });
  expect(await events()).toEqual([]);
});

it('rolls back a classification if the stored policy differs after audit insertion', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure AFTER INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN UPDATE data_classes SET class = 'pii' WHERE container_key = 'w4b-chart'; END").run();
  expect((await change('phi')).status).toBe(503);
  expect(await policy()).toBeNull(); expect(await floors()).toEqual({ container: null, page: null });
  expect(await events()).toEqual([]);
});

it('rolls back an upgrade and its floor changes when evidence insertion fails', async () => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class, note) VALUES ('page_type', 'w4b-chart', 'pii', 'original')").run();
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
  expect((await change('phi')).status).toBe(503);
  expect(await policy()).toEqual({ class: 'pii', note: 'original' });
  expect(await floors()).toEqual({ container: 1, page: 1 });
  expect(await events()).toEqual([]);
});

it('does not invent success evidence when the policy write fails', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_policy_failure BEFORE INSERT ON data_classes BEGIN SELECT RAISE(ABORT, 'synthetic policy failure'); END").run();
  expect((await change('phi')).status).toBe(503);
  expect(await policy()).toBeNull();
  expect(await floors()).toEqual({ container: null, page: null });
  expect(await events()).toEqual([]);
});

it('allows an explicit retry after a known rollback to create one policy and event', async () => {
  await env.DB.prepare("CREATE TRIGGER w4b_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'data_class.set' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
  expect((await change('phi')).status).toBe(503);
  await env.DB.prepare('DROP TRIGGER w4b_audit_failure').run();
  expect((await change('phi')).status).toBe(302);
  expect(await policy()).toMatchObject({ class: 'phi' });
  expect(await floors()).toEqual({ container: 2, page: 2 });
  expect(await events()).toHaveLength(1);
});

it('continues to refuse an unreviewed PHI reduction without success evidence', async () => {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'w4b-chart', 'phi')").run();
  expect((await change('pii')).status).toBe(409);
  expect(await policy()).toEqual({ class: 'phi', note: null });
  expect(await floors()).toEqual({ container: 2, page: 2 });
  expect(await events()).toEqual([]);
});
