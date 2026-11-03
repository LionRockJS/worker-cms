import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache, getPlugins } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import type { Env } from '../src/types';

const fault = 'plugin_page_update_fault', url = 'https://private.invalid/plugin?token=private-query';
const pluginId = 'private-plugin', secret = 'private-page-secret';
const originalLect = '{"status":"old-value","private":"old-body"}';
let requestNumber = 0, hooks: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  for (const name of [fault, `${fault}_second`]) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  for (const table of ['audit_events','data_classes','page_tags','page_versions','pages','tags','page_sensitivity_floors','plugin_page_type_approvals','plugin_identity_approvals','plugins']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("INSERT INTO plugins(id,uuid,label,url,enabled,config,secret) VALUES (24010,'page-plugin-registry','Private Label',?,1,'{\"private\":\"config\"}',?)").bind(url, secret).run();
  await env.DB.prepare('INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (24010,?)').bind(pluginId).run();
  await env.DB.prepare("INSERT INTO plugin_page_type_approvals(plugin_id,page_type,access,approved_by) VALUES (?,'guest','write','internal-admin')").bind(pluginId).run();
  for (const [id, type] of [[24011,'guest'],[24012,'guest'],[24013,'contact']] as const) {
    await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect,created_at,updated_at) VALUES (?,?,?, ?,?,?,'2000-01-01','2000-01-01')").bind(id, `page-${id}`, `Private Name ${id}`, `private-slug-${id}`, type, originalLect).run();
    await env.DB.prepare("INSERT INTO page_versions(id,uuid,page_id,lect,action,created_at,updated_at) VALUES (?,?,?,?,'private-action','2000-01-01','2000-01-01')").bind(id+100, `history-${id}`, id, originalLect).run();
  }
  await env.DB.prepare("INSERT INTO tags(id,uuid,name,slug,taxonomy_slug) VALUES (24021,'old-tag','Private Tag','private-tag','personal'),(24022,'new-tag','New Private Tag','private-new-tag','special')").run();
  await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id,created_at,updated_at) VALUES (24031,'old-link',24011,24021,'2000-01-01','2000-01-01')").run();
  hooks = vi.fn(async () => new Response('ok'));
  clearConfigCache(); clearManifestCache(); __clearInjectedFetchers();
  __injectPluginFetcher(url, { fetch: async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).pathname === '/__plugin/manifest') return Response.json({ id: pluginId, name: 'Private Manifest', version: '1', hooks: ['update'], contentTypes: { blueprint: { guest: ['@status','name'] }, writeTypes: ['article','*'] } });
    return hooks(input);
  } } as Fetcher);
});
afterEach(async () => { for (const name of [fault, `${fault}_second`]) await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run(); clearConfigCache(); clearManifestCache(); __clearInjectedFetchers(); vi.restoreAllMocks(); });
async function call(mode: 'PUT'|'PATCH'|'batch' = 'PUT', overrides: Partial<Env> = {}, body: unknown = mode === 'batch' ? { pages: [{ id: 24011, lect: { status: 'new-value' } }, { id: 24012, lect: { status: 'second-value' } }] } : { lect: { status: 'new-value' }, tags: [24022], version_action: 'private@example.invalid' }, headers: Record<string,string> = {}, id = 24011) {
  const ctx = createExecutionContext(); requestNumber++;
  const response = await worker.fetch(new Request(`https://cms.example.com/__cms/pages/${mode === 'batch' ? 'batch' : id}`, { method: mode === 'batch' ? 'PATCH' : mode, headers: {
    'content-type': 'application/json', 'x-plugin-id': pluginId, 'x-plugin-secret': secret, 'CF-Ray': `page-update-request-${requestNumber}`,
    'CF-Connecting-IP': `10.107.${Math.floor(requestNumber/250)}.${requestNumber%250+1}`, ...headers,
  }, body: JSON.stringify(body) }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE action='page.update' ORDER BY seq").all()).results; }
async function state() { return Promise.all(['pages','page_versions','page_tags','page_sensitivity_floors'].map(async table => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'page_sensitivity_floors' ? 'uuid' : 'id'}`).all()).results)); }
async function classify(kind = 'page_type', key = 'guest', value = 'phi') { await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind, key, value).run(); }
function race(change: () => Promise<unknown>, uncertain = false): Env['DB'] {
  let changed = false; const tracked = new WeakMap<D1PreparedStatement, { actual: D1PreparedStatement; sql: string }>();
  function track(actual: D1PreparedStatement, sql: string): D1PreparedStatement { const proxy = new Proxy(actual, { get(target, name) { if (name === 'bind') return (...args: unknown[]) => track(actual.bind(...args), sql); const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value; } }); tracked.set(proxy, { actual, sql }); return proxy; }
  const DB = { withSession: () => DB, prepare: (sql: string) => track(env.DB.prepare(sql), sql), batch: async (statements: D1PreparedStatement[]) => {
    let injected = false; if (!changed && statements.some(s => tracked.get(s)?.sql.startsWith('UPDATE pages SET name='))) { changed = true; injected = true; await change(); }
    const result = await env.DB.batch(statements.map(s => tracked.get(s)?.actual ?? s)); if (injected && uncertain) throw new Error('Synthetic lost acknowledgment'); return result;
  } }; return DB as Env['DB'];
}
for (const mode of ['PUT','PATCH','batch'] as const) {
  it.each(['none','pii','phi'])(`commits ${mode} pages/history/tags and exact %s service receipts`, async dataClass => {
    if (dataClass !== 'none') await classify('page_type','guest',dataClass);
    const response = await call(mode); expect(response.status).toBe(200);
    const rows = await events(); expect(rows).toHaveLength(mode === 'batch' ? 2 : 1);
    expect(new Set(rows.map(row => JSON.parse(String(row.detail)).operation_id)).size).toBe(1);
    for (const row of rows) {
      expect(row).toMatchObject({ action: 'page.update', event_class: 'mutation', retention_class: 'content_mutation', target_type: 'page', data_class: dataClass, actor_user_id: null, actor_roles: null, session_sid: null, acting_via: 'plugin:page-plugin-registry', outcome: 'success' });
      expect(row.request_id).toMatch(/^page-update-request-/); expect(row.target_id).toMatch(/^page-2401[12]$/);
      const detail = JSON.parse(String(row.detail)); expect(detail).toMatchObject({ operation_id: expect.any(String), registry_id: 24010, version_uuid: expect.any(String), classification_policy_version: expect.any(Number), principal: 'credential_authenticated_plugin', fields: expect.arrayContaining(['lect','history']) });
      const version = await env.DB.prepare('SELECT v.lect,p.lect actual FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE v.uuid=?').bind(detail.version_uuid).first(); expect(version?.lect).toBe(version?.actual);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Private|private-slug|private@example.invalid|old-body|new-value|private-page-secret|private-query|private.*config/);
    expect(hooks).toHaveBeenCalledTimes(1);
  });
  it.each(['abort','ignore','rewrite','delete'])(`rolls back all ${mode} state when its receipt is %s`, async failure => {
    const before = await state(); const sql = failure === 'abort' ? "BEFORE INSERT ON audit_events WHEN NEW.action='page.update' BEGIN SELECT RAISE(ABORT,'synthetic'); END" : failure === 'ignore' ? "BEFORE INSERT ON audit_events WHEN NEW.action='page.update' BEGIN SELECT RAISE(IGNORE); END" : `AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN ${failure === 'delete' ? 'DELETE FROM audit_events WHERE event_id=NEW.event_id;' : 'UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id;'} END`;
    await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run(); const response = await call(mode); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await state()).toEqual(before); expect(await events()).toEqual([]); expect(hooks).not.toHaveBeenCalled();
  });
  it.each(['policy','secret','disable','pin','approval','unregister','replacement','source','history','links','tag','floor'])(`refuses ${mode} after a concurrent %s change`, async kind => {
    let concurrent: Awaited<ReturnType<typeof state>>;
    const DB = race(async () => {
      if (kind === 'policy') await classify(); else if (kind === 'secret') await env.DB.prepare("UPDATE plugins SET secret='rotated'").run(); else if (kind === 'disable') await env.DB.prepare('UPDATE plugins SET enabled=0').run(); else if (kind === 'pin') await env.DB.prepare('DELETE FROM plugin_identity_approvals').run(); else if (kind === 'approval') await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run(); else if (kind === 'unregister') await env.DB.prepare('DELETE FROM plugins').run(); else if (kind === 'replacement') await env.DB.prepare("UPDATE plugins SET uuid='replacement-uuid'").run(); else if (kind === 'source') await env.DB.prepare("UPDATE pages SET lect='{}' WHERE id=24011").run(); else if (kind === 'history') await env.DB.prepare("INSERT INTO page_versions(id,uuid,page_id,lect) VALUES (99991,'concurrent-history',24011,'{}')").run(); else if (kind === 'links') await env.DB.prepare('DELETE FROM page_tags').run(); else if (kind === 'tag') await env.DB.prepare("UPDATE tags SET taxonomy_slug='other' WHERE id=24021").run(); else await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('page-24011',2)").run(); concurrent = await state();
    }); expect((await call(mode, { DB })).status).toBe(503); expect(await state()).toEqual(concurrent!); expect(await events()).toEqual([]); expect(hooks).not.toHaveBeenCalled();
  });
  it.each(['page','history'])(`refuses ignored ${mode} business %s writes`, async table => {
    const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE ${table === 'page' ? 'UPDATE ON pages' : 'INSERT ON page_versions'} BEGIN SELECT RAISE(IGNORE); END`).run(); expect((await call(mode)).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
  });
  it(`retains committed ${mode} data and receipts after lost acknowledgment without replay or hooks`, async () => { expect((await call(mode, { DB: race(async () => {}, true) })).status).toBe(503); expect((await events()).length).toBe(mode === 'batch' ? 2 : 1); expect((await state())[1].length).toBe(mode === 'batch' ? 5 : 4); expect(hooks).not.toHaveBeenCalled(); });
  it(`keeps ${mode} writes held in regulated mode`, async () => { const before = await state(); expect((await call(mode, { REGULATED_MODE: 'true' })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
}
it.each(['page','history','links','tag','floor','policy','secret','pin','approval'])('rolls back trigger-induced %s rewrites after a receipt', async kind => {
  const before = await state(); const sql = kind === 'page' ? "UPDATE pages SET name='rewritten' WHERE id=24011;" : kind === 'history' ? "UPDATE page_versions SET action='rewritten' WHERE uuid=json_extract(NEW.detail,'$.version_uuid');" : kind === 'links' ? 'DELETE FROM page_tags WHERE page_id=24011;' : kind === 'tag' ? "UPDATE tags SET taxonomy_slug='other' WHERE id=24022;" : kind === 'floor' ? "INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('page-24011',2);" : kind === 'policy' ? "INSERT INTO data_classes(container_kind,container_key,class) VALUES ('page_type','guest','phi');" : kind === 'secret' ? "UPDATE plugins SET secret='rotated';" : kind === 'pin' ? 'DELETE FROM plugin_identity_approvals;' : 'DELETE FROM plugin_page_type_approvals;';
  await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN ${sql} END`).run(); expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
});
it('rolls back earlier batch receipts if a later page/version trigger rewrites them', async () => { const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON page_versions WHEN NEW.page_id=24012 BEGIN UPDATE audit_events SET target_count=99 WHERE action='page.update'; END`).run(); expect((await call('batch')).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('records a mixed batch denial and successful update in one operation', async () => {
  const response = await call('batch', {}, { pages: [{ id: 24011, lect: { status: 'new' } }, { id: 24013, lect: { status: 'forbidden' } }, { id: 99999, lect: {} }, { id: 24011, lect: {} }, { id: 'bad', lect: {} }] }); expect(response.status).toBe(200);
  const body = await response.json() as { count: number; errors: unknown[] }; expect(body.count).toBe(1); expect(body.errors).toEqual([{ index: 1, error: 'forbidden_page_type' },{ index: 2, error: 'not_found' },{ index: 3, error: 'duplicate_id' },{ index: 4, error: 'invalid_id' }]);
  const rows = await events(); expect(rows).toHaveLength(2); expect(rows.map(row => row.outcome).sort()).toEqual(['denied','success']); expect(new Set(rows.map(row => JSON.parse(String(row.detail)).operation_id)).size).toBe(1);
});
it('fails the complete mixed batch if denial evidence is unavailable', async () => { const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='page.update' AND NEW.outcome='denied' BEGIN SELECT RAISE(IGNORE); END`).run(); expect((await call('batch', {}, { pages: [{ id: 24011, lect: {} },{ id: 24013, lect: {} }] })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('persists a scope denial before returning a single-page 403', async () => { const before = await state(); expect((await call('PUT', {}, {}, {}, 24013)).status).toBe(403); expect(await state()).toEqual(before); expect((await events())[0]).toMatchObject({ target_id: 'page-24013', outcome: 'denied' }); });
it('requires durable evidence for stale if_lect and preserves the 409 contract', async () => { const before = await state(); const response = await call('PUT', {}, { lect: { status: 'stale' }, if_lect: { status: 'wrong' } }); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'version_conflict' }); expect(await state()).toEqual(before); expect(JSON.parse(String((await events())[0].detail))).toMatchObject({ reason: 'version_precondition' }); });
it('holds a version-conflict response if its receipt fails', async () => { await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='page.update' BEGIN SELECT RAISE(IGNORE); END`).run(); expect((await call('PUT', {}, { if_lect: {} })).status).toBe(503); expect(await events()).toEqual([]); });
it('captures current approval and credential authority before body parsing', async () => { const original = Request.prototype.text; vi.spyOn(Request.prototype,'text').mockImplementationOnce(async function(this: Request) { await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run(); return original.call(this); }); expect((await call('batch')).status).toBe(503); expect(await events()).toEqual([]); });
it.each(['12345','private@example.invalid','-1','9007199254740992'])('does not turn acting-user assertion %s into a CMS principal', async user => { expect((await call('PUT', {}, undefined, { 'x-acting-user-id': user, 'x-user-role': 'admin', 'x-session-sid': '999' })).status).toBe(200); const row = (await events())[0]; expect(row).toMatchObject({ actor_user_id: null, actor_roles: null, session_sid: null, acting_via: 'plugin:page-plugin-registry' }); const detail = JSON.parse(String(row.detail)); expect(detail.acting_user_verified).toBe(false); if (user === '12345') expect(detail.asserted_user_id).toBe(12345); else { expect(detail).not.toHaveProperty('asserted_user_id'); expect(detail.acting_user_unrecordable).toBe(true); } if (user.includes('@')) expect(JSON.stringify(row)).not.toContain(user); });
it('elevates evidence and retained floors for a newly associated PHI taxonomy', async () => { await classify('taxonomy','special'); expect((await call()).status).toBe(200); expect((await events())[0].data_class).toBe('phi'); expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='page-24011'").first()).toMatchObject({ level: 2 }); });
it('retains the existing UUID floor when removing a classified association', async () => { await classify('taxonomy','personal'); expect((await call('PUT', {}, { lect: {}, tags: [] })).status).toBe(200); expect((await events())[0].data_class).toBe('phi'); expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='page-24011'").first()).toMatchObject({ level: 2 }); });
it('refuses a missing new tag without committing an orphan link', async () => { const before = await state(); expect((await call('PUT', {}, { lect: {}, tags: [99999] })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it.each(['link-insert','link-delete'])('refuses ignored tag replacement %s', async kind => { const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE ${kind === 'link-insert' ? 'INSERT' : 'DELETE'} ON page_tags BEGIN SELECT RAISE(IGNORE); END`).run(); expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('preserves link IDs and metadata when batch PATCH does not submit tags', async () => { const before = (await state())[2]; expect((await call('batch')).status).toBe(200); expect((await state())[2]).toEqual(before); });
it('closes the concurrent new-slug collision race', async () => { const DB = race(() => env.DB.prepare("UPDATE pages SET slug='renamed' WHERE id=24012").run()); expect((await call('PUT', { DB }, { slug: 'renamed', lect: {} })).status).toBe(503); expect(await events()).toEqual([]); });
it('refuses a missing new parent without changing the page', async () => { const before = await state(); expect((await call('PUT', {}, { page_id: 99999, lect: {} })).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('preserves a pre-existing orphan parent when it is not changed', async () => { await env.DB.prepare('UPDATE pages SET page_id=99999 WHERE id=24011').run(); expect((await call('PUT', {}, { lect: {} })).status).toBe(200); });
it('allows only one concurrent update from the same captured page snapshot', async () => { const responses = await Promise.all(Array.from({ length: 8 }, () => call('PUT', {}, { lect: { status: 'competing' }, if_lect: JSON.parse(originalLect) }))); expect(responses.filter(r => r.status === 200)).toHaveLength(1); expect(responses.every(r => [200,409,503].includes(r.status))).toBe(true); expect((await events()).filter(row => row.outcome === 'success')).toHaveLength(1); });
it('allocates one hundred distinct safe history IDs in a single batch', async () => { await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<98) SELECT 25000+i,'bulk-'||i,'Bulk','bulk-'||i,'guest','{}' FROM n").run(); const ids = [24011,24012,...Array.from({ length: 98 },(_,i) => 25001+i)]; const response = await call('batch', {}, { pages: ids.map(id => ({ id, lect: { status: 'bulk' } })) }); expect(response.status).toBe(200); const rows = await events(); expect(rows).toHaveLength(100); const histories = (await env.DB.prepare("SELECT id FROM page_versions WHERE action='update'").all()).results; expect(histories).toHaveLength(100); expect(new Set(histories.map(row => row.id)).size).toBe(100); });
it('refuses protected source evidence failure without mutation or hooks', async () => { await classify(); const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='plugin.page-update-source-read' BEGIN SELECT RAISE(ABORT,'private-source'); END`).run(); const response = await call(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-source'); expect(await state()).toEqual(before); expect(hooks).not.toHaveBeenCalled(); });
it('does not put content, action labels, configuration or credentials in protected metadata reads', async () => { await classify(); expect((await call()).status).toBe(200); const rows = (await env.DB.prepare("SELECT * FROM audit_events WHERE action LIKE 'plugin.page-update-%read'").all()).results; expect(rows.length).toBeGreaterThan(0); expect(JSON.stringify(rows)).not.toMatch(/Private|private-slug|private@example.invalid|old-body|new-value|private-page-secret|private-query|private.*config/); });
it('refuses malformed classification', async () => { await classify('table','pages','invalid'); const before = await state(); expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it.each(['page_versions','plugin_page_type_approvals','audit_events'])('refuses missing %s schema', async table => { await env.DB.prepare(`ALTER TABLE ${table} RENAME TO page_update_away`).run(); try { expect((await call()).status).toBe(503); } finally { await env.DB.prepare(`ALTER TABLE page_update_away RENAME TO ${table}`).run(); } });
it('refuses oversized selected bodies before mutating', async () => { await env.DB.prepare('UPDATE pages SET lect=? WHERE id=24011').bind(JSON.stringify('x'.repeat(1_000_001))).run(); const before = await state(); expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]); });
it('preserves exact page/version timestamps under delayed batch submission', async () => { expect((await call('batch', { DB: race(async () => { await new Promise(resolve => setTimeout(resolve,1100)); }) })).status).toBe(200); });
it.each(['read-only','unapproved','undeclared'])('does not treat %s scope as a write grant', async kind => {
  if (kind === 'read-only') await env.DB.prepare("UPDATE plugin_page_type_approvals SET access='read'").run();
  else if (kind === 'unapproved') await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
  else await env.DB.prepare("INSERT INTO plugin_page_type_approvals(plugin_id,page_type,access,approved_by) VALUES (?,'contact','write','internal-admin')").bind(pluginId).run();
  const id = kind === 'undeclared' ? 24013 : 24011;
  const before = await state(); expect((await call('PUT', {}, {}, {}, id)).status).toBe(403); expect(await state()).toEqual(before); expect((await events())[0].outcome).toBe('denied');
});
it.each(['article','*'])('honors explicitly approved declared delegation %s', async type => {
  await env.DB.prepare('INSERT INTO plugin_page_type_approvals(plugin_id,page_type,access,approved_by) VALUES (?,?,?,?)').bind(pluginId,type,'write','internal-admin').run();
  if (type === 'article') await env.DB.prepare("UPDATE pages SET page_type='article' WHERE id=24013").run();
  expect((await call('PUT', {}, { lect: {} }, {}, 24013)).status).toBe(200); expect((await events())[0]).toMatchObject({ target_id: 'page-24013', outcome: 'success' });
});
it.each(['parent','link-id','version-body','version-id','version-time','page-time','link-time'])('rolls back a receipt-triggered %s integrity fault', async kind => {
  const before = await state();
  const sql = kind === 'parent' ? 'DELETE FROM pages WHERE id=24012;' : kind === 'link-id' ? 'UPDATE page_tags SET id=24032 WHERE uuid=\'old-link\';' : kind === 'version-body' ? "UPDATE page_versions SET lect='{}' WHERE uuid=json_extract(NEW.detail,'$.version_uuid');" : kind === 'version-id' ? "UPDATE page_versions SET id=9007199254740992 WHERE uuid=json_extract(NEW.detail,'$.version_uuid');" : kind === 'version-time' ? "UPDATE page_versions SET created_at='1900-01-01' WHERE uuid=json_extract(NEW.detail,'$.version_uuid');" : kind === 'page-time' ? "UPDATE pages SET created_at='1900-01-01' WHERE id=24011;" : "UPDATE page_tags SET created_at='1900-01-01' WHERE page_id=24011;";
  await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN ${sql} END`).run();
  const response = kind === 'link-id' ? await call('batch') : await call('PUT', {}, { lect: { status: 'new-value' }, ...(kind === 'parent' ? { page_id: 24012 } : { tags: [24022] }) });
  expect(response.status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
});
it.each(['secret','pin','registration'])('does not adopt a new %s while parsing a single-page request body', async kind => {
  const original = Request.prototype.text;
  vi.spyOn(Request.prototype,'text').mockImplementationOnce(async function(this: Request) { await env.DB.prepare(kind === 'secret' ? "UPDATE plugins SET secret='rotated'" : kind === 'pin' ? 'DELETE FROM plugin_identity_approvals' : "UPDATE plugins SET uuid='replacement-uuid'").run(); return original.call(this); });
  expect((await call()).status).toBe(503); expect(await events()).toEqual([]);
});
it('requires protected relationship/history source evidence as well as page-body evidence', async () => {
  await classify(); const before = await state(); await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='plugin.page-update-metadata-read' BEGIN SELECT RAISE(ABORT,'private metadata'); END`).run();
  expect((await call()).status).toBe(503); expect(await state()).toEqual(before); expect(await events()).toEqual([]);
});
it('uses the credential principal for protected update-source and result reads despite an asserted user', async () => {
  await classify(); expect((await call('PUT', {}, undefined, { 'x-acting-user-id': '12345' })).status).toBe(200);
  const reads = (await env.DB.prepare("SELECT actor_user_id,acting_via FROM audit_events WHERE action LIKE 'plugin.page-update-%read' OR action='page.update-result'").all()).results;
  expect(reads.length).toBeGreaterThan(0); for (const row of reads) expect(row).toMatchObject({ actor_user_id: null, acting_via: 'plugin:page-plugin-registry' });
});
it('retains the local successful receipt when a separate hook delivery fails', async () => { hooks.mockRejectedValue(new Error('Synthetic hook outage')); expect((await call()).status).toBe(200); expect((await events())[0].outcome).toBe('success'); expect((await state())[1]).toHaveLength(4); });

it('refuses a same-second pin re-claim even when the replacement pin fields are identical', async () => {
  const before = await env.DB.prepare('SELECT * FROM plugin_identity_approvals').first();
  const DB = race(async () => {
    await env.DB.prepare('DELETE FROM plugin_identity_approvals').run(); await getPlugins(env);
    // Force the same-second case even if the test crosses a clock boundary.
    await env.DB.prepare('UPDATE plugin_identity_approvals SET created_at=?,updated_at=?,approved_by=?').bind(before!.created_at,before!.updated_at,before!.approved_by).run();
  });
  const response = await call('PUT', { DB }); expect(response.status).toBe(503); expect(await events()).toEqual([]);
  const after = await env.DB.prepare('SELECT * FROM plugin_identity_approvals').first();
  expect(after).toEqual(before);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='plugin.identity.claim'").first())?.n).toBe(1);
});
