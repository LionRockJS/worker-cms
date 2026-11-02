import { env } from 'cloudflare:workers';
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { __injectPluginFetcher,__clearInjectedFetchers,clearManifestCache,getPlugins } from '../src/features/plugins/registry';
import { computeIntegrity } from '../src/features/plugins/assets';
import type { Env } from '../src/types';

const fault='plugin_approval_fault';
const url='https://private.example.invalid/plugin?token=private-query';
const tables=['plugins','plugin_identity_approvals','plugin_asset_approvals','plugin_page_type_approvals','plugin_file_prefix_approvals','plugin_state','plugin_sequences','settings'];
let cookie='',counter=0;
let manifest:Record<string,unknown>;
let fetch:ReturnType<typeof vi.fn>;
const ops={
 identity:['identity','plugin.identity.approve'],
 assetApprove:['assets/approve','plugin.asset.approve'],assetRevoke:['assets/revoke','plugin.asset.revoke'],
 fileApprove:['files/approve','plugin.file_prefix.approve'],fileRevoke:['files/revoke','plugin.file_prefix.revoke'],
 typeApprove:['page-types/approve','plugin.page_type.approve'],typeRevoke:['page-types/revoke','plugin.page_type.revoke'],
 typeAll:['page-types/approve-all','plugin.page_type.approve_all'],
} as const;
type Operation=keyof typeof ops;
beforeEach(async()=>{
 await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();
 await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}_second`).run();
 for(const table of ['audit_mutation_outbox','audit_events','data_classes','plugin_state','plugin_sequences','plugin_asset_approvals','plugin_page_type_approvals','plugin_file_prefix_approvals','plugin_identity_approvals','plugins','settings','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
 cookie=`access_token=${await signJWT({sub:'19000',name:'Private Actor',email:'private-actor@example.invalid',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
 await env.DB.prepare("INSERT INTO plugins(id,uuid,label,url,enabled,config,secret,created_at,updated_at) VALUES (19010,'approval-plugin-uuid','Private Label',?,1,'{\"private\":\"private-config\"}','private-secret','2000-01-01','2000-01-01')").bind(url).run();
 await env.DB.prepare("INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id,approved_by) VALUES (19010,'sample-plugin','private-admin@example.invalid')").run();
 await env.DB.prepare("INSERT INTO plugin_asset_approvals(id,plugin_id,path,integrity,approved_by) VALUES (19020,'sample-plugin','/private-asset.js','sha384-old','private-admin@example.invalid')").run();
 await env.DB.prepare("INSERT INTO plugin_page_type_approvals(id,plugin_id,page_type,access,approved_by) VALUES (19021,'sample-plugin','private-page-type','write','private-admin@example.invalid')").run();
 await env.DB.prepare("INSERT INTO plugin_file_prefix_approvals(id,plugin_id,prefix,approved_by) VALUES (19022,'sample-plugin','private-prefix/','private-admin@example.invalid')").run();
 for(const [table,maxId] of [['plugin_asset_approvals',19020],['plugin_page_type_approvals',19021],['plugin_file_prefix_approvals',19022]] as const)await env.DB.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').bind(maxId,table).run();
 await env.DB.prepare("INSERT INTO plugin_state(plugin_id,key,value,created_at,updated_at) VALUES ('sample-plugin','private-state-key','{\"private\":1}','2001-01-01','2001-01-02')").run();
 await env.DB.prepare("INSERT INTO plugin_sequences(plugin_id,key,value) VALUES ('sample-plugin','private-counter',17)").run();
 await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('plugin.limits.sample-plugin','{}'),('plugin.credits.sample-plugin','{}')").run();
 manifest={id:'sample-plugin',name:'Private Manifest',version:'1',assets:[{path:'/private-asset.js'},{path:'/new-asset.js'}],filePrefixes:['private-prefix/','new-prefix/'],contentTypes:{readTypes:['private-page-type','*'],writeTypes:['private-page-type','new-type'],blueprint:{'owned-type':{}}}};
 fetch=vi.fn(async(input:RequestInfo|URL)=>new URL(String(input)).pathname==='/__plugin/manifest'?Response.json(manifest):new Response('private asset bytes'));
 clearConfigCache();clearManifestCache();__clearInjectedFetchers();__injectPluginFetcher(url,{fetch} as Fetcher);
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}_second`).run();clearConfigCache();clearManifestCache();__clearInjectedFetchers();vi.restoreAllMocks();});
async function call(op:Operation,overrides:Partial<Env>={},fields:Record<string,string>={}){
 if(op==='identity'&&manifest.id==='sample-plugin')manifest.id='renamed-plugin';
 const ctx=createExecutionContext();counter++;
 const response=await worker.fetch(new Request(`https://cms.example.com/admin/plugins-manage/19010/${ops[op][0]}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.102.${Math.floor(counter/250)}.${counter%250+1}`},body:new URLSearchParams({path:'/private-asset.js',prefix:'private-prefix/',page_type:'private-page-type',access:'write',...fields})}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);
 await waitOnExecutionContext(ctx);return response;
}
async function regulatedEnv():Promise<Partial<Env>>{
 const inventory=[{kind:'plugin',key:'sample-plugin',class:'public'},
  ...[...tables,'users','roles','role_permissions','sessions','user_oauth_identities','data_classes','audit_events','locales','page_types','block_types','pages','trash_pages'].map(key=>({kind:'table',key,class:'public'}))];
 for(const [sql,kind] of [["SELECT DISTINCT COALESCE(page_type,'default') key FROM pages",'page_type'],['SELECT slug key FROM taxonomies','taxonomy']]){
  const rows=await env.DB.prepare(sql).all<{key:string}>();inventory.push(...rows.results.map(r=>({kind,key:r.key,class:'public'})));
 }
 return {REGULATED_MODE:'true',REGULATED_INVENTORY:JSON.stringify(inventory),CANONICAL_ORIGIN:'https://cms.example.com',SESSION_IDLE_TTL:'1800'};
}
async function state(){return Promise.all(tables.map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${table==='settings'?'key':table==='plugin_identity_approvals'?'plugin_row_id':table==='plugin_state'||table==='plugin_sequences'?'plugin_id,key':'id'}`).all()).results));}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('plugin.identity.approve','plugin.asset.approve','plugin.asset.revoke','plugin.file_prefix.approve','plugin.file_prefix.revoke','plugin.page_type.approve','plugin.page_type.revoke','plugin.page_type.approve_all') ORDER BY seq").all()).results;}
async function classify(kind='table',key='plugin_asset_approvals',value='phi'){await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
function race(change:()=>Promise<unknown>,uncertain=false,includeNoop=false):Env['DB']{
 let changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string}>();
 function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement{const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql});return proxy;}
 const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{
  const sqls=statements.map(s=>tracked.get(s)?.sql??'');let injected=false;
  if(!changed&&sqls.some(sql=>sql.includes('(SELECT COUNT(*) FROM plugins WHERE 1)'))&&(includeNoop||sqls.some(sql=>/^(INSERT INTO|DELETE FROM) plugin_/.test(sql)))){changed=true;injected=true;await change();}
  const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(injected&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;
 }};return DB as Env['DB'];
}
for(const op of Object.keys(ops) as Operation[]){
 it.each(['none','pii','phi'])(`commits ${op} with exact private %s evidence`,async dataClass=>{
  if(dataClass!=='none')await classify('table','plugin_asset_approvals',dataClass);
  expect((await call(op)).status).toBe(302);const rows=await events();expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({action:ops[op][1],actor_user_id:'19000',actor_roles:'admin',data_class:dataClass,target_type:'plugin',target_id:'approval-plugin-uuid',target_count:1,retention_class:'admin_config',outcome:'success'});
  expect(JSON.parse(String(rows[0].detail))).toMatchObject({operation_id:expect.any(String),id:19010,changes:expect.any(Array),identity_fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/),manifest_fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/),classification_policy_version:expect.any(Number)});
  for(const value of ['Private','private-','private.','private/','sample-plugin','renamed-plugin'])expect(JSON.stringify(rows)).not.toContain(value);
 });
 it.each(['abort','ignore','rewrite'])(`rolls back all ${op} changes when receipt is %s`,async failure=>{
  const before=await state();const sql=failure==='abort'?"BEFORE INSERT ON audit_events WHEN NEW.event_class='admin' BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events WHEN NEW.event_class='admin' BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events WHEN NEW.event_class='admin' BEGIN UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id; END";
  await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();const response=await call(op);expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.text()).not.toContain('synthetic');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
 });
 it.each(['policy','session','role','registry','pin','approval'])(`refuses ${op} after concurrent %s change`,async change=>{
  let concurrent:Awaited<ReturnType<typeof state>>;
  const DB=race(async()=>{if(change==='policy')await classify();else if(change==='session')await env.DB.prepare('DELETE FROM sessions').run();else if(change==='role')await env.DB.prepare("UPDATE users SET role='viewer' WHERE id=19000").run();else if(change==='registry')await env.DB.prepare("UPDATE plugins SET secret='concurrent' WHERE id=19010").run();else if(change==='pin')await env.DB.prepare("UPDATE plugin_identity_approvals SET manifest_id='concurrent-plugin' WHERE plugin_row_id=19010").run();else await env.DB.prepare("UPDATE plugin_asset_approvals SET approved_by='concurrent'").run();concurrent=await state();});
  expect((await call(op,{DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);
 });
 it(`retains committed ${op} evidence after lost acknowledgment`,async()=>{expect((await call(op,{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);});
 it(`preserves regulated admission for ${op}`,async()=>{const before=await state();const revocation=ops[op][1].endsWith('.revoke');expect((await call(op,await regulatedEnv())).status).toBe(revocation?302:503);if(revocation){expect(await events()).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(1);}else{expect(await state()).toEqual(before);expect(await events()).toEqual([]);expect(fetch).not.toHaveBeenCalled();}});
}
it('moves state and sequences atomically while revoking old and orphaned destination capabilities',async()=>{
 for(const [table,fields,values] of [['plugin_asset_approvals','path,integrity',"'/orphan.js','sha384-orphan'"],['plugin_page_type_approvals','page_type,access',"'orphan-type','write'"],['plugin_file_prefix_approvals','prefix',"'orphan/'"]])await env.DB.prepare(`INSERT INTO ${table}(plugin_id,${fields},approved_by) VALUES ('renamed-plugin',${values},'')`).run();
 await env.DB.prepare("INSERT INTO plugin_state(plugin_id,key,value) VALUES ('renamed-plugin','private-state-key','overwritten'),('renamed-plugin','retained-key','retained')").run();
 await env.DB.prepare("INSERT INTO plugin_sequences(plugin_id,key,value) VALUES ('renamed-plugin','private-counter',2)").run();
 expect((await call('identity')).status).toBe(302);
 expect(await env.DB.prepare('SELECT manifest_id,approved_by FROM plugin_identity_approvals').first()).toEqual({manifest_id:'renamed-plugin',approved_by:'private-actor@example.invalid'});
 for(const table of tables.slice(2,5))expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([]);
 expect(await env.DB.prepare("SELECT value,created_at,updated_at FROM plugin_state WHERE plugin_id='renamed-plugin' AND key='private-state-key'").first()).toEqual({value:'{"private":1}',created_at:'2001-01-01',updated_at:'2001-01-02'});
 expect(await env.DB.prepare("SELECT value FROM plugin_state WHERE plugin_id='renamed-plugin' AND key='retained-key'").first()).toEqual({value:'retained'});
 expect(await env.DB.prepare("SELECT value FROM plugin_sequences WHERE plugin_id='renamed-plugin'").first()).toEqual({value:17});expect((await env.DB.prepare('SELECT * FROM settings').all()).results).toHaveLength(2);
 const changes=JSON.parse(String((await events())[0].detail)).changes;expect(changes.find((c:{table:string})=>c.table==='plugin_state').overwritten).toHaveLength(1);
});
it.each(['plugin_asset_approvals','plugin_page_type_approvals','plugin_file_prefix_approvals','plugin_state','plugin_sequences'])('rolls back identity reapproval when %s removal is ignored',async table=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call('identity')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['plugin_state','plugin_sequences','plugin_identity_approvals'])('rolls back identity reapproval when %s destination write is ignored',async table=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call('identity')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['plugin_state','plugin_sequences'])('refuses a concurrent destination %s change',async table=>{const DB=race(()=>env.DB.prepare(`INSERT INTO ${table}(plugin_id,key,value) VALUES ('renamed-plugin','raced-key',?)`).bind(table==='plugin_state'?'{}':2).run());expect((await call('identity',{DB})).status).toBe(503);expect(await events()).toEqual([]);expect(await env.DB.prepare('SELECT manifest_id FROM plugin_identity_approvals').first()).toEqual({manifest_id:'sample-plugin'});});
it.each(['session','policy','approval','registry'])('rejects trigger-induced %s changes after capability mutation',async kind=>{
 const before=await state();const sql=kind==='session'?'DELETE FROM sessions;':kind==='policy'?"INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','plugin_asset_approvals','phi');":kind==='approval'?"UPDATE plugin_file_prefix_approvals SET approved_by='rewritten';":"UPDATE plugins SET config='{}';";
 await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON plugin_page_type_approvals BEGIN ${sql} END`).run();expect((await call('typeAll')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('does not take automatic identity claims during explicit capability approval',async()=>{await env.DB.prepare('DELETE FROM plugin_identity_approvals').run();expect((await call('typeApprove')).status).toBe(404);expect((await env.DB.prepare('SELECT * FROM plugin_identity_approvals').all()).results).toEqual([]);expect(await events()).toEqual([]);expect(await env.DB.prepare("SELECT detail FROM audit_events WHERE action='permission.denied'").first()).toMatchObject({detail:expect.stringContaining('plugin_identity_required')});});
it('takes an explicit first pin with evidence and clears inherited destination grants',async()=>{await env.DB.prepare('DELETE FROM plugin_identity_approvals').run();manifest.id='new-plugin';expect((await call('identity')).status).toBe(302);expect(await env.DB.prepare('SELECT manifest_id FROM plugin_identity_approvals').first()).toEqual({manifest_id:'new-plugin'});expect(await events()).toHaveLength(1);});
it('validates an unchanged identity without another mutation event',async()=>{manifest.id='unchanged-plugin';await env.DB.prepare("UPDATE plugin_identity_approvals SET manifest_id='unchanged-plugin'").run();const before=await state();expect((await call('identity')).headers.get('location')).toContain('identity-ok');expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses an already claimed identity with durable private denial evidence',async()=>{
 await env.DB.prepare("INSERT INTO plugins(id,uuid,url) VALUES (19011,'other-uuid','https://other.invalid')").run();await env.DB.prepare("INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (19011,'renamed-plugin')").run();const before=await state();expect((await call('identity')).headers.get('location')).toContain('identity-claimed');expect(await state()).toEqual(before);expect(await events()).toEqual([]);const denied=await env.DB.prepare("SELECT detail FROM audit_events WHERE action='permission.denied'").first();expect(String(denied?.detail)).toContain('plugin_identity_claimed');expect(String(denied?.detail)).not.toContain('renamed-plugin');
});
it('refuses a competing identity claim inserted after capture',async()=>{await env.DB.prepare("INSERT INTO plugins(id,uuid,url) VALUES (19011,'other-uuid','https://other.invalid')").run();const DB=race(()=>env.DB.prepare("INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (19011,'renamed-plugin')").run());expect((await call('identity',{DB})).status).toBe(503);expect(await events()).toEqual([]);});
it.each(['private-prefix/child/','private-prefix/'])('refuses a conflicting prefix %s with a durable denial',async prefix=>{await env.DB.prepare("UPDATE plugin_file_prefix_approvals SET plugin_id='other-plugin'").run();manifest.filePrefixes=[prefix];expect((await call('fileApprove',{}, {prefix})).headers.get('location')).toContain('conflict');expect(await events()).toEqual([]);const denied=await env.DB.prepare("SELECT detail FROM audit_events WHERE action='permission.denied'").first();expect(String(denied?.detail)).toContain('plugin_file_prefix_conflict');expect(String(denied?.detail)).not.toContain('private-prefix');});
it('refuses concurrent nested-prefix grants, closing the overlap read/insert race',async()=>{const DB=race(()=>env.DB.prepare("INSERT INTO plugin_file_prefix_approvals(plugin_id,prefix,approved_by) VALUES ('other-plugin','new-prefix/nested/','')").run());expect((await call('fileApprove',{DB},{prefix:'new-prefix/'})).status).toBe(503);expect(await events()).toEqual([]);expect(await env.DB.prepare("SELECT * FROM plugin_file_prefix_approvals WHERE prefix='new-prefix/'").first()).toBeNull();});
it('uses the durable denial outbox when the primary refusal receipt fails',async()=>{await env.DB.prepare("UPDATE plugin_file_prefix_approvals SET plugin_id='other-plugin'").run();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='permission.denied' BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();expect((await call('fileApprove')).headers.get('location')).toContain('conflict');const outbox=await env.DB.prepare('SELECT envelope FROM audit_mutation_outbox').first();expect(String(outbox?.envelope)).toContain('plugin_file_prefix_conflict');expect(await events()).toEqual([]);});
it('remains unavailable when both denial stores fail',async()=>{await env.DB.prepare("UPDATE plugin_file_prefix_approvals SET plugin_id='other-plugin'").run();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='permission.denied' BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();await env.DB.prepare(`CREATE TRIGGER ${fault}_second BEFORE INSERT ON audit_mutation_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();expect((await call('fileApprove')).status).toBe(503);expect(await events()).toEqual([]);});
it('does not approve undeclared assets, prefixes or page types',async()=>{for(const op of ['assetApprove','fileApprove','typeApprove'] as Operation[])expect((await call(op,{}, {path:'/unknown.js',prefix:'unknown/',page_type:'unknown'})).status).toBe(400);expect(await events()).toEqual([]);});
it('retains all-or-nothing complete approve-all manifests beyond 200 scopes',async()=>{manifest.contentTypes={readTypes:Array.from({length:205},(_,i)=>`type-${i}`),writeTypes:['*'],blueprint:{owned:{}}};expect((await call('typeAll')).status).toBe(302);const saved=JSON.parse(String((await events())[0].detail)).changes.find((c:{table:string})=>c.table==='plugin_page_type_approvals').saved;expect(saved).toHaveLength(207);expect(new Set(saved.map((r:{id:number})=>r.id)).size).toBe(207);});
it('preserves existing attribution and timestamps on repeated approve-all',async()=>{expect((await call('typeAll')).status).toBe(302);const before=await state();expect((await call('typeAll')).status).toBe(302);expect(await state()).toEqual(before);expect(await events()).toHaveLength(1);expect(await env.DB.prepare('SELECT approved_by FROM plugin_page_type_approvals WHERE id=19021').first()).toEqual({approved_by:'private-admin@example.invalid'});});
it('treats repeated single approvals and missing revocations as validated no-ops',async()=>{expect((await call('fileApprove')).status).toBe(302);expect((await call('fileApprove')).status).toBe(302);expect(await events()).toHaveLength(1);expect((await call('assetRevoke',{}, {path:'/missing.js'})).status).toBe(302);expect(await events()).toHaveLength(1);});
it('refuses stale no-op approval snapshots',async()=>{await env.DB.prepare('DELETE FROM plugin_asset_approvals').run();const DB=race(()=>env.DB.prepare("UPDATE plugins SET enabled=0").run(),false,true);expect((await call('assetRevoke',{DB})).status).toBe(503);expect(await events()).toEqual([]);});
it('pins fetched bytes and refuses unavailable fetches before approval',async()=>{expect((await call('assetApprove')).status).toBe(302);expect(await env.DB.prepare('SELECT integrity FROM plugin_asset_approvals').first()).toEqual({integrity:await computeIntegrity(new TextEncoder().encode('private asset bytes').buffer)});await env.DB.prepare('DELETE FROM audit_events').run();fetch.mockImplementation(async(input:RequestInfo|URL)=>new URL(String(input)).pathname==='/__plugin/manifest'?Response.json(manifest):new Response('no',{status:503}));expect((await call('assetApprove')).headers.get('location')).toContain('fetch-failed');expect(await events()).toEqual([]);});
it('inspects a fresh declaration instead of granting from a stale cached manifest',async()=>{expect(await getPlugins(env)).toHaveLength(1);manifest.contentTypes={readTypes:[],writeTypes:[]};expect((await call('typeApprove')).status).toBe(400);expect(await events()).toEqual([]);});
it('refuses registry changes made while fetching the manifest',async()=>{fetch.mockImplementation(async()=>{await env.DB.prepare("UPDATE plugins SET url='https://changed.invalid'").run();return Response.json(manifest);});expect((await call('typeApprove')).status).toBe(503);expect(await events()).toEqual([]);});
it('inherits destination state and plugin sensitivity on identity moves',async()=>{await classify('plugin','renamed-plugin');expect((await call('identity')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');});
it('refuses oversized approval and state snapshots without partial changes',async()=>{await env.DB.prepare("UPDATE plugin_state SET value=?").bind('x'.repeat(1_000_001)).run();const before=await state();expect((await call('identity')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses invalid policy before inspection',async()=>{await classify('table','plugins','invalid');expect((await call('typeAll')).status).toBe(503);expect(fetch).not.toHaveBeenCalled();expect(await events()).toEqual([]);});
it('requires the current plugin management capability',async()=>{cookie=`access_token=${await signJWT({sub:'19001',name:'Editor',email:'editor@example.invalid',role:'editor',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;expect((await call('typeAll')).status).toBe(403);expect(fetch).not.toHaveBeenCalled();expect(await events()).toEqual([]);});
it('uses transaction timestamps across a delayed commit',async()=>{expect((await call('typeAll',{DB:race(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));})})).status).toBe(302);expect(await events()).toHaveLength(1);});
it.each([
 ['assetApprove','plugin_asset_approvals','UPDATE'],['assetRevoke','plugin_asset_approvals','DELETE'],
 ['fileApprove','plugin_file_prefix_approvals','UPDATE'],['fileRevoke','plugin_file_prefix_approvals','DELETE'],
 ['typeApprove','plugin_page_type_approvals','UPDATE'],['typeRevoke','plugin_page_type_approvals','DELETE'],
 ['typeAll','plugin_page_type_approvals','INSERT'],
] as const)('refuses ignored primary writes for %s',async(op,table,operation)=>{
 const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();
 expect((await call(op)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it.each(['identity','assetApprove','fileApprove','typeAll'] as Operation[])('rolls back %s when its receipt trigger rewrites final business state',async op=>{
 const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.event_class='admin' BEGIN UPDATE plugin_identity_approvals SET approved_by='rewritten'; END`).run();
 expect((await call(op)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('does not commit approvals when protected source-read evidence fails',async()=>{
 await classify();const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='plugin.approval-source-read' BEGIN SELECT RAISE(ABORT,'private source error'); END`).run();
 const response=await call('typeAll');expect(response.status).toBe(503);expect(await response.text()).not.toContain('private source');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('keeps raw source values out of protected approval read evidence',async()=>{
 await classify();expect((await call('identity')).status).toBe(302);const reads=(await env.DB.prepare("SELECT * FROM audit_events WHERE action='plugin.approval-source-read'").all()).results;expect(reads.length).toBeGreaterThan(0);
 for(const value of ['private-secret','private-query','private-config','private-admin@example.invalid','private-state-key','private-counter'])expect(JSON.stringify(reads)).not.toContain(value);
});
it('refuses oversized approval catalogue rows before returning their values',async()=>{
 await env.DB.prepare('UPDATE plugin_asset_approvals SET path=?').bind('/'+ 'x'.repeat(1_000_001)).run();const before=await state();expect((await call('typeApprove')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('refuses row-count overflow without truncating approval manifests',async()=>{
 await env.DB.prepare("INSERT INTO plugin_asset_approvals(plugin_id,path,integrity,approved_by) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) SELECT 'sample-plugin','/asset-'||i,'sha384-unused','' FROM n").run();
 expect((await call('identity')).status).toBe(503);expect((await env.DB.prepare('SELECT COUNT(*) n FROM plugin_asset_approvals').first())?.n).toBe(5001);expect(await events()).toEqual([]);
});
it('refuses unsafe legacy approval IDs',async()=>{await env.DB.prepare('UPDATE plugin_asset_approvals SET id=9007199254740992').run();expect((await call('assetRevoke')).status).toBe(503);expect(await events()).toEqual([]);});
it('refuses exhausted approval IDs only when a new approval is needed',async()=>{
 await env.DB.prepare("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='plugin_page_type_approvals'").run();const before=await state();expect((await call('typeAll')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);expect((await call('typeApprove')).status).toBe(302);
});
it('rejects unsafe legacy pin strings without treating them as evidence targets',async()=>{await env.DB.prepare("UPDATE plugin_identity_approvals SET manifest_id='private-admin@example.invalid'").run();expect((await call('identity')).status).toBe(503);expect(await events()).toEqual([]);});
it('keeps disabled and unreachable plugins outside approval mutation paths',async()=>{
 await env.DB.prepare('UPDATE plugins SET enabled=0').run();expect((await call('typeAll')).status).toBe(404);expect(fetch).not.toHaveBeenCalled();expect(await events()).toEqual([]);
 await env.DB.prepare('UPDATE plugins SET enabled=1').run();fetch.mockImplementation(async()=>new Response('nf',{status:404}));expect((await call('identity')).headers.get('location')).toContain('identity-unreachable');expect(await events()).toEqual([]);
});
it('does not overwrite another plugin namespace when approving or revoking',async()=>{
 await env.DB.prepare("INSERT INTO plugin_asset_approvals(plugin_id,path,integrity,approved_by) VALUES ('other-plugin','/private-asset.js','sha384-other','')").run();
 expect((await call('assetApprove')).status).toBe(302);expect((await call('assetRevoke')).status).toBe(302);expect(await env.DB.prepare("SELECT integrity FROM plugin_asset_approvals WHERE plugin_id='other-plugin'").first()).toEqual({integrity:'sha384-other'});
});
it('rejects an identity mismatch before fetching candidate approval bytes',async()=>{
 manifest.id='renamed-plugin';expect((await call('assetApprove')).status).toBe(404);expect(fetch).toHaveBeenCalledTimes(1);expect(await events()).toEqual([]);
});
it('does not disclose asset requests after capture authority changes',async()=>{
 let calls=0;fetch.mockImplementation(async()=>{calls++;if(calls===1){await env.DB.prepare('DELETE FROM sessions').run();return Response.json(manifest);}return new Response('bytes');});
 expect((await call('assetApprove')).status).toBe(503);expect(calls).toBe(1);expect(await events()).toEqual([]);
});
it('invalidates manifest and effective-configuration caches after an uncertain approval commit',async()=>{
 expect((await getPlugins(env))[0].manifest.contentTypes?.blueprint).toEqual({});
 expect((await call('typeAll',{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);
 expect((await getPlugins(env))[0].manifest.contentTypes?.blueprint).toHaveProperty('owned-type');
});
it.each([
 ['typeApprove','page_type','private-page-type'],['typeAll','page_type','otherwise-unrequested'],
 ['fileApprove','media_prefix','new-prefix/sensitive/'],['identity','table','plugin_sequences'],
] as const)('inherits classified %s target scopes',async(op,kind,key)=>{
 await classify(kind,key);if(op==='fileApprove')expect((await call(op,{}, {prefix:'new-prefix/'})).status).toBe(302);else expect((await call(op)).status).toBe(302);expect((await events())[0].data_class).toBe('phi');
});
it('refuses sequence-only allocation races rather than reusing a consumed approval ID',async()=>{
 const before=await state();const DB=race(()=>env.DB.prepare("UPDATE sqlite_sequence SET seq=seq+100 WHERE name='plugin_page_type_approvals'").run());
 expect((await call('typeAll',{DB})).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('rolls back approvals if a receipt trigger rewrites the allocation sequence',async()=>{
 const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='plugin.page_type.approve_all' BEGIN UPDATE sqlite_sequence SET seq=seq+100 WHERE name='plugin_page_type_approvals'; END`).run();
 expect((await call('typeAll')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
