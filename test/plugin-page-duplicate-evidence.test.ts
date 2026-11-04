import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { __injectPluginFetcher, __clearInjectedFetchers, clearManifestCache, getPlugins } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import type { Env } from '../src/types';

const fault='plugin_page_duplicate_fault',url='https://private.invalid/plugin?token=private-query',pluginId='private-plugin',secret='private-duplicate-secret';
let hooks:ReturnType<typeof vi.fn>,requestNumber=0;
async function seed(count:number){
 await env.DB.prepare("DELETE FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE page_id=28011)").run();
 await env.DB.prepare('DELETE FROM pages WHERE page_id=28011').run();
 for(let offset=0;offset<count;offset+=100)await env.DB.batch(Array.from({length:Math.min(100,count-offset)},(_,i)=>{
  const id=28101+offset+i;
  return env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect,page_id,weight,start,end,timezone,created_at,updated_at) VALUES (?,?,?,?,'guest',?,28011,7,'2026-01-01','2026-12-31','+0800','2000-01-01','2000-01-01')").bind(id,`source-${id}`,'Private Person',`opaque-${id}`,JSON.stringify({status:'private-old',private:'source-body',privateDrop:[{secret:'drop-me'}],_pointers:{list:'source-list'}}));
 }));
 if(count)await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id) VALUES (28031,'source-link',28101,28021)").run();
}
beforeEach(async()=>{
 for(const name of [fault,`${fault}_second`])await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
 for(const table of ['audit_events','data_classes','page_tags','page_versions','pages','trash_pages','tags','page_sensitivity_floors','plugin_page_type_approvals','plugin_identity_approvals','plugins','credit_ledger','credit_wallets','shared_credit_ledger','shared_credits'])await env.DB.prepare(`DELETE FROM ${table}`).run();
 await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.limits.%' OR key LIKE 'plugin.credits.%'").run();
 await env.DB.prepare("INSERT INTO plugins(id,uuid,label,url,enabled,config,secret) VALUES (28010,'duplicate-registry-uuid','Private Label',?,1,'{\"private\":\"config\"}',?)").bind(url,secret).run();
 await env.DB.prepare('INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id) VALUES (28010,?)').bind(pluginId).run();
 await env.DB.prepare("INSERT INTO plugin_page_type_approvals(plugin_id,page_type,access,approved_by) VALUES (?,'guest','write','internal-admin')").bind(pluginId).run();
 await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (28011,'source-parent','Private Source','source-parent','collection','{}'),(28012,'target-parent','Private Target','target-parent','collection','{}')").run();
 await env.DB.prepare("INSERT INTO tags(id,uuid,name,slug,taxonomy_slug) VALUES (28021,'source-tag','Private Tag','source-tag','special')").run();
 await env.DB.prepare('DELETE FROM users WHERE id=28001').run();
 await env.DB.prepare("INSERT INTO users(id,oauth_id,name,email,role) VALUES (28001,'test:duplicate-payer','Private Payer','private-payer@example.invalid','editor')").run();
 await env.DB.prepare("INSERT INTO credit_wallets(user_id,currency,balance) VALUES (28001,'credit',10000)").run();
 await seed(3);
 hooks=vi.fn(async()=>new Response('ok'));clearConfigCache();clearManifestCache();__clearInjectedFetchers();
 __injectPluginFetcher(url,{fetch:async(input:RequestInfo|URL)=>{
  const href=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(new URL(href).pathname==='/__plugin/manifest')return Response.json({id:pluginId,name:'Private Manifest',version:'1',hooks:['create'],contentTypes:{blueprint:{guest:['@status','name']},writeTypes:['article','*']},limits:[{key:'total',page_type:'guest',scope:'total',default:10000},{key:'parent',page_type:'guest',scope:'per_parent',default:10000},{key:'collection',page_type:'guest',scope:'per_pointer',pointer_key:'list',default:10000}],credits:[{key:'create_guest',charge:'page_create',page_type:'guest',default:5}]});
  return hooks(input);
 }} as Fetcher);
});
afterEach(async()=>{for(const name of [fault,`${fault}_second`])await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();clearConfigCache();clearManifestCache();__clearInjectedFetchers();vi.restoreAllMocks();});
function input(){return {source_page_type:'guest',source_page_id:28011,target_page_id:28012,lect:{status:'private-new',_pointers:{list:'target-list'}},drop_lect:['privateDrop']};}
async function call(overrides:Partial<Env>={},body:unknown=input(),headers:Record<string,string>={}){
 const ctx=createExecutionContext();requestNumber++;
 const response=await worker.fetch(new Request('https://cms.example.com/__cms/pages/duplicate',{method:'POST',headers:{'content-type':'application/json','x-plugin-id':pluginId,'x-plugin-secret':secret,'CF-Ray':`duplicate-request-${requestNumber}`,'CF-Connecting-IP':`10.109.${Math.floor(requestNumber/250)}.${requestNumber%250+1}`,...headers},body:JSON.stringify(body)}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);await waitOnExecutionContext(ctx);return response;
}
async function events(action='page.duplicate'){return(await env.DB.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY seq').bind(action).all()).results;}
async function state(){return Promise.all(['pages','page_versions','page_tags','page_sensitivity_floors'].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${table==='page_sensitivity_floors'?'uuid':'id'}`).all()).results));}
async function clones(){return(await env.DB.prepare('SELECT * FROM pages WHERE page_id=28012 ORDER BY id').all()).results;}
async function originals(){return(await env.DB.prepare('SELECT * FROM pages WHERE page_id=28011 ORDER BY id').all()).results;}
async function balance(){return(await env.DB.prepare("SELECT balance FROM credit_wallets WHERE user_id=28001 AND currency='credit'").first())?.balance;}
async function classify(kind='page_type',key='guest',value='phi'){await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
async function limits(values:Record<string,number|null>){await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(`plugin.limits.${pluginId}`,JSON.stringify(values)).run();}
function race(change:()=>Promise<unknown>,uncertain=false,nth=1,phase:'commit'|'intent'|'reservation'='commit'):Env['DB']{
 let seen=0,changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string;args:unknown[]}>();
 function track(actual:D1PreparedStatement,sql:string,args:unknown[]=[]):D1PreparedStatement{const proxy=new Proxy(actual,{get(target,name){if(name==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql,args);const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql,args});return proxy;}
 const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let injected=false;const match=statements.some(s=>phase==='commit'?tracked.get(s)?.sql.startsWith('INSERT INTO pages(id,uuid,name'):phase==='reservation'?tracked.get(s)?.sql.includes('INSERT INTO credit_ledger'):tracked.get(s)?.args.includes('page.duplicate.intent'));if(match&&!changed&&++seen===nth){changed=true;injected=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(injected&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;}};return DB as Env['DB'];
}
it.each(['none','pii','phi'])('commits exact %s per-clone, chunk and operation evidence with immutable source links',async dataClass=>{
 if(dataClass!=='none')await classify('page_type','guest',dataClass);const before=await originals();const response=await call();expect(response.status).toBe(200);expect(await response.json()).toEqual({count:3,next_cursor:null,done:true});expect(await originals()).toEqual(before);
 const rows=await events();expect(rows).toHaveLength(3);const intent=(await events('page.duplicate.intent'))[0],operation=JSON.parse(String(intent.detail)).operation_id;
 for(const row of rows){expect(row).toMatchObject({action:'page.duplicate',target_type:'page',event_class:'mutation',retention_class:'content_mutation',data_class:dataClass,actor_user_id:null,actor_roles:null,session_sid:null,acting_via:'plugin:duplicate-registry-uuid'});expect(row.request_id).toMatch(/^duplicate-request-/);const detail=JSON.parse(String(row.detail));expect(detail).toMatchObject({operation_id:operation,source_id:expect.any(Number),source_uuid:expect.stringMatching(/^source-/),version_uuid:expect.any(String),classification_policy_version:expect.any(Number)});const saved=await env.DB.prepare('SELECT p.lect,v.lect version,p.slug FROM pages p JOIN page_versions v ON v.page_id=p.id WHERE p.uuid=? AND v.uuid=?').bind(row.target_id,detail.version_uuid).first();expect(saved?.lect).toBe(saved?.version);expect(saved?.slug).toMatch(/^opaque-/);const lect=JSON.parse(String(saved?.lect));expect(lect).toMatchObject({status:'private-new',private:'source-body',_pointers:{list:'target-list'}});expect(lect).not.toHaveProperty('privateDrop');}
 const chunk=(await events('page.duplicate.chunk'))[0];expect(JSON.parse(String(chunk.detail))).toMatchObject({operation_id:operation,chunk_index:0,count:3,cursor_before:0,cursor_after:28103,request_complete:true,done:true});
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE page_id=28012)').first())?.n).toBe(0);expect(await events('page.create')).toEqual([]);expect(hooks).toHaveBeenCalledTimes(1);
 expect(JSON.stringify([...rows,intent,chunk])).not.toMatch(/Private|opaque-|private-new|source-body|source-list|target-list|private-payer|private-duplicate-secret|private-query|private.*config/);
});
for(const action of ['page.duplicate.intent','page.duplicate','page.duplicate.chunk']){
 it.each(['abort','ignore','rewrite','delete'])(`refuses ${action} receipt %s without partial clone state`,async failure=>{
  const before=await state();const sql=failure==='abort'?`BEFORE INSERT ON audit_events WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic'); END`:failure==='ignore'?`BEFORE INSERT ON audit_events WHEN NEW.action='${action}' BEGIN SELECT RAISE(IGNORE); END`:`AFTER INSERT ON audit_events WHEN NEW.action='${action}' BEGIN ${failure==='delete'?'DELETE FROM audit_events WHERE event_id=NEW.event_id;':'UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id;'} END`;
  await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();const response=await call();expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await state()).toEqual(before);expect(await events()).toEqual([]);expect(await events('page.duplicate.chunk')).toEqual([]);expect(hooks).not.toHaveBeenCalled();
 });
}
it.each(['pages','page_versions','page_sensitivity_floors'])('refuses ignored %s writes in a copy transaction',async table=>{
 await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('source-28101',2)").run();const before=await state();
 await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON ${table} ${table==='page_sensitivity_floors'?"WHEN NEW.uuid NOT LIKE 'source-%'":table==='pages'?'WHEN NEW.page_id=28012':''} BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it.each(['policy','secret','disable','pin','approval','registry','source','selection-add','selection-remove','link','tag','floor','target','limit','price'])('refuses a concurrent %s change before a chunk commit',async kind=>{
 let concurrent:Awaited<ReturnType<typeof state>>;const DB=race(async()=>{
  if(kind==='policy')await classify();else if(kind==='secret')await env.DB.prepare("UPDATE plugins SET secret='rotated'").run();else if(kind==='disable')await env.DB.prepare('UPDATE plugins SET enabled=0').run();else if(kind==='pin')await env.DB.prepare('DELETE FROM plugin_identity_approvals').run();else if(kind==='approval')await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();else if(kind==='registry')await env.DB.prepare("UPDATE plugins SET uuid='replacement'").run();else if(kind==='source')await env.DB.prepare("UPDATE pages SET name='Changed' WHERE id=28101").run();else if(kind==='selection-add')await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,page_id,lect) VALUES (28104,'concurrent','New','new-source','guest',28011,'{}')").run();else if(kind==='selection-remove')await env.DB.prepare('UPDATE pages SET page_id=NULL WHERE id=28103').run();else if(kind==='link')await env.DB.prepare('DELETE FROM page_tags').run();else if(kind==='tag')await env.DB.prepare("UPDATE tags SET taxonomy_slug='changed'").run();else if(kind==='floor')await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('source-28101',2)").run();else if(kind==='target')await env.DB.prepare('DELETE FROM pages WHERE id=28012').run();else if(kind==='limit')await limits({total:3});else await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(`plugin.credits.${pluginId}`,'{"create_guest":10}').run();concurrent=await state();
 });expect((await call({DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);expect(hooks).not.toHaveBeenCalled();
});
it.each(['clone','history','source','link','tag','floor','target','policy','approval','prior-receipt'])('rolls back a receipt-triggered %s mutation',async kind=>{
 const before=await state();const sql=kind==='clone'?"UPDATE pages SET name='Rewritten' WHERE uuid=NEW.target_id;":kind==='history'?"UPDATE page_versions SET lect='{}' WHERE uuid=json_extract(NEW.detail,'$.version_uuid');":kind==='source'?"UPDATE pages SET name='Changed' WHERE id=28101;":kind==='link'?'DELETE FROM page_tags WHERE page_id=28101;':kind==='tag'?"UPDATE tags SET taxonomy_slug='changed';":kind==='floor'?"INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('source-28101',2);":kind==='target'?'DELETE FROM pages WHERE id=28012;':kind==='policy'?"INSERT INTO data_classes(container_kind,container_key,class) VALUES ('page_type','guest','phi');":kind==='approval'?'DELETE FROM plugin_page_type_approvals;':"UPDATE audit_events SET target_count=99 WHERE action='page.duplicate';";
 await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.duplicate' BEGIN ${sql} END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('carries retained source protection while omitting physical source tag links',async()=>{
 await classify('taxonomy','special');expect((await call()).status).toBe(200);const receipt=(await events()).find(row=>JSON.parse(String(row.detail)).source_id===28101)!;expect(receipt.data_class).toBe('phi');expect((await env.DB.prepare('SELECT level FROM page_sensitivity_floors WHERE uuid=?').bind(receipt.target_id).first())?.level).toBe(2);expect((await env.DB.prepare('SELECT COUNT(*) n FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE page_id=28012)').first())?.n).toBe(0);
});
it('pins table-classified source content through more than one chunk without inventing a stale count-floor conflict',async()=>{
 await seed(101);await classify('table','pages');expect((await call()).status).toBe(200);expect(await events()).toHaveLength(101);expect(await events('page.duplicate.chunk')).toHaveLength(2);expect((await env.DB.prepare('SELECT COUNT(*) n FROM page_sensitivity_floors f JOIN pages p ON p.uuid=f.uuid WHERE p.page_id=28012 AND f.level=2').first())?.n).toBe(101);
});
it('does not recursively select new clones when the inherited parent and pointer still match',async()=>{
 const response=await call({}, {...input(),target_page_id:28011,lect:{}});expect(response.status).toBe(200);expect(await response.json()).toEqual({count:3,next_cursor:null,done:true});expect(await events()).toHaveLength(3);
});
it('preserves the 1000-copy cap and original-source cursor across requests',async()=>{
 await seed(1001);const first=await call();expect(first.status).toBe(200);expect(await first.json()).toEqual({count:1000,next_cursor:29100,done:false});expect(await events()).toHaveLength(1000);expect(await events('page.duplicate.chunk')).toHaveLength(10);
 const last=await call({}, {...input(),cursor:29100});expect(last.status).toBe(200);expect(await last.json()).toEqual({count:1,next_cursor:null,done:true});expect(await clones()).toHaveLength(1001);expect(await originals()).toHaveLength(1001);
},30000);
it('audits protected look-ahead sources even when they are outside the current 1000-copy cap',async()=>{
 await seed(1001);await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('source-29101',2)").run();expect((await call()).status).toBe(200);const rows=(await env.DB.prepare("SELECT target_count FROM audit_events WHERE action='plugin.page-duplicate-source-read'").all()).results;expect(rows.reduce((sum,row)=>sum+Number(row.target_count),0)).toBe(1001);expect(await events()).toHaveLength(1000);
},30000);
it('retains a fully committed single chunk after an uncertain acknowledgment without replay or refund',async()=>{
 expect((await call({DB:race(async()=>{},true)},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await clones()).toHaveLength(3);expect(await events()).toHaveLength(3);expect(await events('page.duplicate.chunk')).toHaveLength(1);expect(await balance()).toBe(9985);expect(hooks).not.toHaveBeenCalled();expect(JSON.parse(String((await events('page.duplicate.result'))[0].detail))).toMatchObject({commit_state:'unknown',acknowledged_count:0,refund_state:'withheld_commit_unknown'});
});
it('retains a committed prefix and refunds only a known uncommitted remainder',async()=>{
 await seed(111);await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON pages WHEN NEW.page_id=28012 AND (SELECT COUNT(*) FROM pages WHERE page_id=28012)>=100 BEGIN SELECT RAISE(ABORT,'later chunk unavailable'); END`).run();
 expect((await call({},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await clones()).toHaveLength(100);expect(await events()).toHaveLength(100);expect(await events('page.duplicate.chunk')).toHaveLength(1);expect(await balance()).toBe(9500);expect(hooks).toHaveBeenCalledTimes(1);expect(JSON.parse(String((await events('page.duplicate.result'))[0].detail))).toMatchObject({commit_state:'prefix_committed',acknowledged_count:100,acknowledged_cursor:28200,refund_state:'attempted'});
});
it('does not refund an uncertain second chunk or replay the acknowledged prefix',async()=>{
 await seed(111);expect((await call({DB:race(async()=>{},true,2)},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await clones()).toHaveLength(111);expect(await events()).toHaveLength(111);expect(await events('page.duplicate.chunk')).toHaveLength(2);expect(await balance()).toBe(9445);expect(hooks).toHaveBeenCalledTimes(1);expect(JSON.parse(String((await events('page.duplicate.result'))[0].detail))).toMatchObject({commit_state:'unknown',acknowledged_count:100,acknowledged_cursor:28200,refund_state:'withheld_commit_unknown'});
});
it('stops after a committed prefix if the next chunk loses its current write grant',async()=>{
 await seed(111);expect((await call({DB:race(()=>env.DB.prepare('DELETE FROM plugin_page_type_approvals').run(),false,2)},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await clones()).toHaveLength(100);expect(await events()).toHaveLength(100);expect(await balance()).toBe(9500);
});
it('keeps a known prefix if a previously copied source changes before a later chunk',async()=>{
 await seed(111);expect((await call({DB:race(()=>env.DB.prepare("UPDATE pages SET name='Changed' WHERE id=28101").run(),false,2)})).status).toBe(503);expect(await clones()).toHaveLength(100);expect(await events()).toHaveLength(100);
});
it('does not charge when the intent is lost or cannot persist',async()=>{
 expect((await call({DB:race(async()=>{},true,1,'intent')},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await events('page.duplicate.intent')).toHaveLength(1);expect(await clones()).toEqual([]);expect(await balance()).toBe(10000);
});
it('retains an uncertain upfront reservation without starting any chunk',async()=>{
 expect((await call({DB:race(async()=>{},true,1,'reservation')},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await balance()).toBe(9985);expect(await clones()).toEqual([]);expect(await events('page.duplicate.intent')).toHaveLength(1);expect(JSON.parse(String((await events('page.duplicate.result'))[0].detail))).toMatchObject({commit_state:'not_committed',refund_state:'reservation_unconfirmed'});
});
it.each(['total','parent','collection'])('records a %s quota refusal before reservation',async scope=>{
 await limits({[scope]:scope==='total'?5:2});const before=await state();expect((await call({},undefined,{'x-acting-user-id':'28001'})).status).toBe(409);expect(await state()).toEqual(before);expect(await balance()).toBe(10000);expect(JSON.parse(String((await events('page.duplicate.denied'))[0].detail))).toMatchObject({reason:'limit_exceeded'});expect(await events('page.duplicate.intent')).toEqual([]);
});
it('enforces inherited pointer quotas using the actual transformed candidates',async()=>{
 await limits({collection:5});expect((await call({}, {...input(),lect:{status:'new'}})).status).toBe(409);expect(await clones()).toEqual([]);
});
it('closes a concurrent target quota last-slot race',async()=>{
 await limits({parent:3});const DB=race(()=>env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,page_id,lect) VALUES (99991,'concurrent','Concurrent','concurrent','guest',28012,'{}')").run());expect((await call({DB})).status).toBe(503);expect(await clones()).toHaveLength(1);expect(await events()).toEqual([]);
});
it('records a service-reported credit refusal without duplicating content',async()=>{
 await env.DB.prepare('UPDATE credit_wallets SET balance=0 WHERE user_id=28001').run();expect((await call({},undefined,{'x-acting-user-id':'28001'})).status).toBe(402);expect(await clones()).toEqual([]);expect(JSON.parse(String((await events('page.duplicate.denied'))[0].detail))).toMatchObject({reason:'reservation_refused',reservation_code:'insufficient_credits'});
});
it('requires a current declared write grant rather than a read grant',async()=>{
 await env.DB.prepare("UPDATE plugin_page_type_approvals SET access='read'").run();expect((await call()).status).toBe(403);expect(JSON.parse(String((await events('page.duplicate.denied'))[0].detail))).toMatchObject({reason:'forbidden_page_type'});expect(await clones()).toEqual([]);
});
it.each(['secret','pin','approval','registry'])('captures %s authority before parsing the duplication body',async kind=>{
 const original=Request.prototype.text;vi.spyOn(Request.prototype,'text').mockImplementationOnce(async function(this:Request){await env.DB.prepare(kind==='secret'?"UPDATE plugins SET secret='rotated'":kind==='pin'?'DELETE FROM plugin_identity_approvals':kind==='approval'?'DELETE FROM plugin_page_type_approvals':"UPDATE plugins SET uuid='replacement'").run();return original.call(this);});expect((await call()).status).toBe(503);expect(await clones()).toEqual([]);expect(await events()).toEqual([]);
});
it('rejects an identical same-second pin reclaim during body parsing',async()=>{
 const original=Request.prototype.text;vi.spyOn(Request.prototype,'text').mockImplementationOnce(async function(this:Request){const pin=await env.DB.prepare('SELECT * FROM plugin_identity_approvals').first();await env.DB.prepare('DELETE FROM plugin_identity_approvals').run();await getPlugins(env);await env.DB.prepare('UPDATE plugin_identity_approvals SET created_at=?,updated_at=?,approved_by=?').bind(pin!.created_at,pin!.updated_at,pin!.approved_by).run();return original.call(this);});expect((await call()).status).toBe(503);expect(await clones()).toEqual([]);
});
it.each(['28001','private@example.invalid','-1','9007199254740992'])('does not manufacture a CMS principal from assertion %s',async user=>{
 const response=await call({},undefined,{'x-acting-user-id':user,'x-user-role':'admin','x-session-sid':'99'});expect([200,400]).toContain(response.status);const rows=[...await events(),...await events('page.duplicate.intent'),...await events('page.duplicate.denied')];expect(rows.length).toBeGreaterThan(0);for(const row of rows){expect(row).toMatchObject({actor_user_id:null,actor_roles:null,session_sid:null,acting_via:'plugin:duplicate-registry-uuid'});const detail=JSON.parse(String(row.detail));expect(detail.acting_user_verified).toBe(false);if(user==='28001')expect(detail.asserted_user_id).toBe(28001);else expect(detail).not.toHaveProperty('asserted_user_id');if(user.includes('@'))expect(String(row.detail)).not.toContain(user);}
});
it.each(['source','chunk'])('refuses protected %s read-audit persistence failures',async phase=>{
 await classify();const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='${phase==='source'?'plugin.page-duplicate-source-read':'page.duplicate-read'}' BEGIN SELECT RAISE(ABORT,'private-source-outage'); END`).run();const response=await call({},undefined,{'x-acting-user-id':'28001'});expect(response.status).toBe(503);expect(await response.text()).not.toContain('source-body');expect(await state()).toEqual(before);expect(await balance()).toBe(10000);
});
it('returns a guarded no-op for an empty source collection',async()=>{
 await seed(0);expect(await (await call()).json()).toEqual({count:0,next_cursor:null,done:true});expect(await events()).toEqual([]);expect(await events('page.duplicate.intent')).toEqual([]);expect(await balance()).toBe(10000);
});
it('rejects a missing target parent before reservation',async()=>{expect((await call({}, {...input(),target_page_id:99999},{'x-acting-user-id':'28001'})).status).toBe(503);expect(await balance()).toBe(10000);expect(await clones()).toEqual([]);});
it.each([1.5,9007199254740992,'bad'])('rejects unsafe cursor %s',async cursor=>{expect((await call({}, {...input(),cursor})).status).toBe(400);expect(await clones()).toEqual([]);});
it.each(['page_versions','page_tags','page_sensitivity_floors','plugin_page_type_approvals','audit_events'])('refuses missing %s schema',async table=>{
 await env.DB.prepare(`ALTER TABLE ${table} RENAME TO duplicate_away`).run();try{expect((await call()).status).toBe(503);expect(await clones()).toEqual([]);}finally{await env.DB.prepare(`ALTER TABLE duplicate_away RENAME TO ${table}`).run();}
});
it('refuses oversized source snapshots before intent or charge',async()=>{await env.DB.prepare('UPDATE pages SET lect=? WHERE id=28101').bind(JSON.stringify({body:'x'.repeat(1_000_001)})).run();expect((await call({},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await balance()).toBe(10000);expect(await events('page.duplicate.intent')).toEqual([]);});
it('keeps regulated duplication held',async()=>{const before=await state();expect((await call({REGULATED_MODE:'true'})).status).toBe(503);expect(await state()).toEqual(before);expect(await balance()).toBe(10000);});
it('preserves local success when a separate create hook fails',async()=>{hooks.mockRejectedValue(new Error('Synthetic hook outage'));expect((await call()).status).toBe(200);expect(await events()).toHaveLength(3);expect(await clones()).toHaveLength(3);});
it('uses transaction-time metadata after delayed chunk submission',async()=>{expect((await call({DB:race(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));})})).status).toBe(200);expect(await events()).toHaveLength(3);});
it('rechecks creation authority before the upfront debit',async()=>{
 const DB=race(()=>env.DB.prepare('DELETE FROM plugin_page_type_approvals').run(),false,1,'intent');
 expect((await call({DB},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await balance()).toBe(10000);expect(await events('page.duplicate.intent')).toEqual([]);expect(await clones()).toEqual([]);
});
it('refunds only the uncommitted remainder after a later protected-read checkpoint fails',async()=>{
 await seed(111);await classify();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='page.duplicate-read' AND (SELECT COUNT(*) FROM audit_events WHERE action='page.duplicate-read')>=2 BEGIN SELECT RAISE(ABORT,'later read outage'); END`).run();
 expect((await call({},undefined,{'x-acting-user-id':'28001'})).status).toBe(503);expect(await clones()).toHaveLength(100);expect(await events()).toHaveLength(100);expect(await balance()).toBe(9500);expect(JSON.parse(String((await events('page.duplicate.result'))[0].detail))).toMatchObject({commit_state:'prefix_committed',acknowledged_count:100,refund_state:'attempted'});
});
it('rejects a chunk receipt trigger that corrupts an earlier per-clone receipt',async()=>{
 const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.duplicate.chunk' BEGIN UPDATE audit_events SET target_count=99 WHERE action='page.duplicate'; END`).run();
 expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);expect(await events('page.duplicate.chunk')).toEqual([]);
});
it('rejects a later history trigger that corrupts an earlier receipt in the same chunk',async()=>{
 const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON page_versions WHEN (SELECT COUNT(*) FROM page_versions)>=2 BEGIN UPDATE audit_events SET target_count=99 WHERE action='page.duplicate'; END`).run();
 expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it.each(['clone-created','version-created','version-id'])('rejects receipt-triggered %s integrity loss',async kind=>{
 const before=await state();const sql=kind==='clone-created'?"UPDATE pages SET created_at='1900-01-01' WHERE uuid=NEW.target_id;":kind==='version-created'?"UPDATE page_versions SET created_at='1900-01-01' WHERE uuid=json_extract(NEW.detail,'$.version_uuid');":"UPDATE page_versions SET id=9007199254740992 WHERE uuid=json_extract(NEW.detail,'$.version_uuid');";
 await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.duplicate' BEGIN ${sql} END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('refuses copying a source removed after the durable intent without losing its independent deletion',async()=>{
 const DB=race(()=>env.DB.prepare('DELETE FROM pages WHERE id=28101').run());expect((await call({DB})).status).toBe(503);expect(await clones()).toEqual([]);expect(await events()).toEqual([]);expect(await originals()).toHaveLength(2);
});

it('duplicates without the optional trash tables and validates their continued absence',async()=>{
 const saved=(await env.DB.prepare("SELECT type,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'trash_%' OR name LIKE 'idx_trash_%' OR name LIKE 'sensitivity_trash_%')").all<{type:string;sql:string}>()).results;
 const objects=(await env.DB.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'sensitivity_trash_%' AND type IN ('trigger','view')").all<{type:string;name:string}>()).results;
 for(const type of ['trigger','view'])for(const object of objects.filter(object=>object.type===type))await env.DB.prepare(`DROP ${type} ${object.name}`).run();
 for(const table of ['trash_page_versions','trash_page_tags','trash_pages'])await env.DB.prepare(`DROP TABLE ${table}`).run();
 try{expect((await call()).status).toBe(200);expect(await clones()).toHaveLength(3);expect(await events()).toHaveLength(3);}
 finally{for(const type of ['table','index','view','trigger'])for(const object of saved.filter(object=>object.type===type))await env.DB.prepare(object.sql).run();}
});
