import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import type { Env } from '../src/types';

const fault = 'plugin_sequence_evidence_fault', url = 'https://private.invalid/plugin?token=private-query';
const pluginId = 'private-plugin', secret = 'private-sequence-secret', key = 'private.counter';
let requestNumber = 0;
beforeEach(async () => {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();
  for (const table of ['audit_events','data_classes','plugin_state','plugin_sequences','plugin_identity_approvals','plugins']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("INSERT INTO plugins(id,uuid,label,url,enabled,config,secret) VALUES (23010,'sequence-registry-uuid','Private Label',?,1,'{\"private\":\"config\"}',?)").bind(url, secret).run();
  await env.DB.prepare('INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (23010,?)').bind(pluginId).run();
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
  __injectPluginFetcher(url, { fetch: async () => Response.json({ id: pluginId, name: 'Private Manifest', version: '1' }) } as Fetcher);
});
afterEach(async () => { await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run(); clearConfigCache(); clearManifestCache(); __clearInjectedFetchers(); vi.restoreAllMocks(); });
async function call(overrides: Partial<Env> = {}, headers: Record<string,string> = {}, selected = key) {
  requestNumber++; const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com/__cms/sequences/${selected}/next`, { method: 'POST', headers: {
    'x-plugin-id': pluginId, 'x-plugin-secret': secret, 'CF-Ray': `sequence-request-${requestNumber}`,
    'CF-Connecting-IP': `10.106.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}`, ...headers,
  } }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE action='plugin.sequence.advance' ORDER BY seq").all()).results; }
async function state() { return (await env.DB.prepare('SELECT * FROM plugin_sequences ORDER BY plugin_id,key').all()).results; }
async function seed(value: number | string = 41) { await env.DB.prepare("INSERT INTO plugin_sequences(plugin_id,key,value,created_at,updated_at) VALUES (?,?,?,'2000-01-01','2000-01-01')").bind(pluginId, key, value).run(); }
async function fill(n: number) { await env.DB.prepare("INSERT INTO plugin_sequences(plugin_id,key,value) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?,'counter.'||i,1 FROM n").bind(n, pluginId).run(); }
async function classify(kind = 'table', selected = 'plugin_sequences', dataClass = 'phi') { await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind, selected, dataClass).run(); }
function race(change: () => Promise<unknown>, uncertain = false): Env['DB'] {
  let changed = false; const tracked = new WeakMap<D1PreparedStatement, { actual: D1PreparedStatement; sql: string }>();
  function track(actual: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(actual, { get(target, name) { if (name === 'bind') return (...args: unknown[]) => track(actual.bind(...args), sql); const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value; } });
    tracked.set(proxy, { actual, sql }); return proxy;
  }
  const DB = { withSession: () => DB, prepare: (sql: string) => track(env.DB.prepare(sql), sql), batch: async (statements: D1PreparedStatement[]) => {
    let injected = false;
    if (!changed && statements.some(s => tracked.get(s)?.sql.includes('INSERT INTO plugin_sequences(plugin_id,key,value,created_at'))) { changed = true; injected = true; await change(); }
    const result = await env.DB.batch(statements.map(s => tracked.get(s)?.actual ?? s));
    if (injected && uncertain) throw new Error('Synthetic lost acknowledgment'); return result;
  } };
  return DB as Env['DB'];
}
for (const existing of [false, true]) {
  it.each(['none','pii','phi'])(`commits ${existing ? 'existing' : 'new'} counter and exact %s evidence`, async dataClass => {
    if (existing) await seed(); if (dataClass !== 'none') await classify('table', 'plugin_sequences', dataClass);
    const response = await call(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ key, value: existing ? 42 : 1 });
    const rows = await events(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'plugin.sequence.advance', target_type: 'plugin_sequence', event_class: 'admin', retention_class: 'admin_config', outcome: 'success', data_class: dataClass, actor_user_id: null, actor_roles: null, session_sid: null, acting_via: 'plugin:sequence-registry-uuid', target_count: 1 });
    expect(rows[0].request_id).toMatch(/^sequence-request-/); expect(rows[0].target_id).toMatch(/^sequence-registry-uuid:sequence:[a-f0-9]{64}$/);
    const detail = JSON.parse(String(rows[0].detail)); expect(detail).toMatchObject({ value_before: existing ? 41 : 0, value_after: existing ? 42 : 1, increment: 1, registry_id: 23010, operation_id: expect.any(String), classification_policy_version: expect.any(Number), principal: 'credential_authenticated_plugin', key_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), identity_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const saved = (await state())[0]; expect(detail.created_at).toBe(saved.created_at); expect(detail.advanced_at).toBe(saved.updated_at); if (existing) expect(saved.created_at).toBe('2000-01-01');
    expect(JSON.stringify(rows)).not.toMatch(/private.counter|private-plugin|private-sequence-secret|private-query|Private|private.*config/);
  });
  it.each(['abort','ignore','rewrite','value','delete'])(`rolls back ${existing ? 'existing' : 'new'} advance when receipt is %s`, async failure => {
    if (existing) await seed(); const before = await state();
    const sql = failure === 'abort' ? "BEFORE INSERT ON audit_events WHEN NEW.target_type='plugin_sequence' BEGIN SELECT RAISE(ABORT,'synthetic'); END" : failure === 'ignore' ? "BEFORE INSERT ON audit_events WHEN NEW.target_type='plugin_sequence' BEGIN SELECT RAISE(IGNORE); END" : `AFTER INSERT ON audit_events WHEN NEW.target_type='plugin_sequence' BEGIN ${failure === 'delete' ? 'DELETE FROM audit_events WHERE event_id=NEW.event_id;' : failure === 'value' ? "UPDATE audit_events SET detail=json_set(detail,'$.value_after',999) WHERE event_id=NEW.event_id;" : 'UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id;'} END`;
    await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run(); const response = await call(); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
  });
  it.each(['ignore','value','created_at','updated_at','receipt','policy','secret','pin'])(`rolls back ${existing ? 'existing' : 'new'} counter write with %s fault`, async failure => {
    if (existing) await seed(); const before = await state();
    const body = failure === 'ignore' ? "SELECT RAISE(IGNORE);" : failure === 'value' ? 'UPDATE plugin_sequences SET value=value+100;' : failure === 'created_at' ? "UPDATE plugin_sequences SET created_at='1900-01-01';" : failure === 'updated_at' ? "UPDATE plugin_sequences SET updated_at='1900-01-01';" : failure === 'receipt' ? "UPDATE audit_events SET detail=json_set(detail,'$.operation_id','rewritten') WHERE action='plugin.sequence.advance';" : failure === 'policy' ? "INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','plugin_sequences','phi');" : failure === 'secret' ? "UPDATE plugins SET secret='rotated';" : 'DELETE FROM plugin_identity_approvals;';
    await env.DB.prepare(`CREATE TRIGGER ${fault} ${failure === 'ignore' ? 'BEFORE INSERT' : existing ? 'AFTER UPDATE' : 'AFTER INSERT'} ON plugin_sequences BEGIN ${body} END`).run();
    expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
  });
}
it('serializes twenty concurrent existing-counter allocations with exact contiguous receipts', async () => {
  await seed(); const responses = await Promise.all(Array.from({ length: 20 }, () => call())); expect(responses.every(r => r.status === 200)).toBe(true);
  const values = await Promise.all(responses.map(async response => (await response.json() as { value: number }).value));
  expect(values.sort((a,b) => a-b)).toEqual(Array.from({ length: 20 }, (_,i) => i+42));
  const rows = await events(); expect(rows).toHaveLength(20); expect(new Set(rows.map(row => row.event_id)).size).toBe(20);
  expect(rows.map(row => JSON.parse(String(row.detail)).value_after).sort((a,b) => a-b)).toEqual(values);
  for (const row of rows) { const d = JSON.parse(String(row.detail)); expect(d.value_after).toBe(d.value_before+1); }
});
it.each(['policy','secret','disable','pin','unregister','replacement'])('refuses an old caller after concurrent %s change', async change => {
  await seed(); const before = await state(); const DB = race(async () => {
    if (change === 'policy') await classify(); else if (change === 'secret') await env.DB.prepare("UPDATE plugins SET secret='rotated'").run(); else if (change === 'disable') await env.DB.prepare('UPDATE plugins SET enabled=0').run(); else if (change === 'pin') await env.DB.prepare("UPDATE plugin_identity_approvals SET manifest_id='replacement'").run(); else if (change === 'unregister') await env.DB.prepare('DELETE FROM plugins').run(); else { await env.DB.prepare('DELETE FROM plugins').run(); await env.DB.prepare("INSERT INTO plugins(id,uuid,url,enabled,secret) VALUES (23010,'replacement-uuid',?,1,?)").bind(url,secret).run(); await env.DB.prepare('INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (23010,?)').bind(pluginId).run(); }
  }); expect((await call({ DB })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
});
it('uses a concurrently advanced value at transaction time rather than rejecting a stale CAS', async () => { await seed(); expect((await call({ DB: race(() => env.DB.prepare('UPDATE plugin_sequences SET value=42').run()) })).status).toBe(200); expect(JSON.parse(String((await events())[0].detail))).toMatchObject({ value_before: 42, value_after: 43 }); });
it('retains the issued number and receipt on a lost acknowledgment without replay', async () => { expect((await call({ DB: race(async () => {}, true) })).status).toBe(503); expect((await state())[0].value).toBe(1); expect(await events()).toHaveLength(1); expect(await (await call()).json()).toEqual({ key, value: 2 }); expect(await events()).toHaveLength(2); });
it('records exact quota denial while allowing an existing zero-valued counter at the cap', async () => {
  await seed(0); await fill(999); const before = await state(); const response = await call({}, {}, 'new.counter'); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'too_many_sequences', max_sequences: 1000 }); expect(await state()).toEqual(before);
  expect((await events())[0]).toMatchObject({ outcome: 'denied' }); expect(JSON.parse(String((await events())[0].detail))).toMatchObject({ reason: 'sequence_key_limit', max_sequences: 1000 }); expect(await (await call()).json()).toEqual({ key, value: 1 });
});
it('refuses quota denial when its exact receipt cannot persist', async () => { await fill(1000); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.target_type='plugin_sequence' BEGIN SELECT RAISE(IGNORE); END`).run(); expect((await call()).status).toBe(503); expect(await events()).toEqual([]); });
it('closes a race for the final namespace slot', async () => { await fill(999); const responses = await Promise.all(Array.from({ length: 8 }, (_,i) => call({}, {}, `last.${i}`))); expect(responses.filter(r => r.status === 200)).toHaveLength(1); expect(responses.every(r => [200,409,503].includes(r.status))).toBe(true); expect((await state()).length).toBe(1000); expect((await events()).filter(r => r.outcome === 'success')).toHaveLength(1); });
it.each([-1, 1.5, 'not-a-number', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER+1])('refuses unsafe/exhausted counter %s without an advance receipt', async value => { await seed(value); const before = await state(); expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('issues the final safe integer exactly once', async () => { await seed(Number.MAX_SAFE_INTEGER-1); expect(await (await call()).json()).toEqual({ key, value: Number.MAX_SAFE_INTEGER }); expect((await call()).status).toBe(503); expect(await events()).toHaveLength(1); });
it('retains asserted user IDs only as unverified detail', async () => { expect((await call({}, { 'x-acting-user-id': '12345', 'x-user-role': 'admin', 'x-session-sid': '99' })).status).toBe(200); const row = (await events())[0]; expect(row).toMatchObject({ actor_user_id: null, actor_roles: null, session_sid: null, acting_via: 'plugin:sequence-registry-uuid' }); expect(JSON.parse(String(row.detail))).toMatchObject({ asserted_user_id: 12345, acting_user_verified: false }); });
it.each(['private@example.invalid','-1','1.5','9007199254740992'])('excludes unsafe acting-user assertion %s', async asserted => { expect((await call({}, { 'x-acting-user-id': asserted })).status).toBe(200); const detail = JSON.parse(String((await events())[0].detail)); expect(detail).toMatchObject({ acting_user_verified: false, acting_user_unrecordable: true }); expect(detail).not.toHaveProperty('asserted_user_id'); if (asserted.includes('@')) expect(JSON.stringify(detail)).not.toContain(asserted); });
it.each([['table','plugins'],['table','plugin_identity_approvals'],['plugin',pluginId]])('includes authority classification from %s %s', async (kind, selected) => { await classify(kind, selected); expect((await call()).status).toBe(200); expect((await events())[0].data_class).toBe('phi'); });
it('awaits protected source evidence and keeps its metadata private', async () => { await classify(); expect((await call()).status).toBe(200); const reads = (await env.DB.prepare("SELECT * FROM audit_events WHERE action LIKE 'plugin.sequence-%read'").all()).results; expect(reads.length).toBeGreaterThan(0); expect(JSON.stringify(reads)).not.toMatch(/private.counter|private-sequence-secret|private-query|private.*config/); });
it('refuses protected source evidence failure', async () => { await classify(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='plugin.sequence-mutation-source-read' BEGIN SELECT RAISE(ABORT,'private source'); END`).run(); const response = await call(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private source'); expect(await state()).toEqual([]); expect(await events()).toEqual([]); });
it('refuses malformed policy', async () => { await classify('table','plugin_sequences','invalid'); expect((await call()).status).toBe(503); expect(await state()).toEqual([]); expect(await events()).toEqual([]); });
it.each(['plugin_sequences','audit_events'])('refuses missing %s schema', async table => { await env.DB.prepare(`ALTER TABLE ${table} RENAME TO sequence_away`).run(); try { expect((await call()).status).toBe(503); expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table === 'audit_events' ? 'sequence_away' : 'audit_events'} WHERE action='plugin.sequence.advance'`).first()).toMatchObject({ n: 0 }); } finally { await env.DB.prepare(`ALTER TABLE sequence_away RENAME TO ${table}`).run(); } });
it('keeps regulated advances held', async () => { await seed(); const before = await state(); expect((await call({ REGULATED_MODE: 'true' })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('uses transaction-time timestamps even when submission is delayed', async () => { expect((await call({ DB: race(async () => { await new Promise(resolve => setTimeout(resolve,1100)); }) })).status).toBe(200); const detail = JSON.parse(String((await events())[0].detail)); expect(detail.created_at).toBe((await state())[0].created_at); expect(detail.advanced_at).toBe((await state())[0].updated_at); });
it('does not let request fields select another namespace', async () => { await env.DB.prepare("INSERT INTO plugin_sequences(plugin_id,key,value) VALUES ('other-plugin',?,123)").bind(key).run(); expect((await call({}, { 'x-plugin-namespace': 'other-plugin' })).status).toBe(200); expect((await env.DB.prepare("SELECT value FROM plugin_sequences WHERE plugin_id='other-plugin'").first())?.value).toBe(123); });

it.each(['counter','policy','secret','pin','created_at','advanced_at'])('rolls back a sequence plan receipt trigger that rewrites %s', async faultKind => {
  // A source change after planning must not be adopted as a new plan.
  if (!['created_at','advanced_at'].includes(faultKind)) await seed();
  const before = await state();
  const body = faultKind === 'counter' ? 'UPDATE plugin_sequences SET value=value+1;' : faultKind === 'policy' ? "INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','plugin_sequences','phi');" : faultKind === 'secret' ? "UPDATE plugins SET secret='rotated';" : faultKind === 'pin' ? 'DELETE FROM plugin_identity_approvals;' : `UPDATE audit_events SET detail=json_set(detail,'$.${faultKind}','1900-01-01') WHERE event_id=NEW.event_id;`;
  await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.target_type='plugin_sequence' BEGIN ${body} END`).run();
  expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
});
it('rejects a missing final counter even if its receipt detail is also cleared', async () => {
  await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON plugin_sequences BEGIN DELETE FROM plugin_sequences WHERE plugin_id=NEW.plugin_id AND key=NEW.key; UPDATE audit_events SET detail=NULL WHERE action='plugin.sequence.advance'; END`).run();
  expect((await call()).status).toBe(503); expect(await state()).toEqual([]); expect(await events()).toEqual([]);
});
