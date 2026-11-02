import { env } from 'cloudflare:workers';
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { verifyJWT } from '../src/core/auth/jwt';
import { applyBulkPageAction } from '../src/core/pages/bulk-action';
import { mutatePageLifecycle } from '../src/core/pages/lifecycle-mutation-evidence';
import { createAdvancedSearchBulkActionJob } from '../src/features/jobs/queue';
import { runCmsAdminJob } from '../src/features/jobs/runner';
import type { Env,JWTPayload } from '../src/types';

let cookie='';let user:JWTPayload;let counter=0;
const trigger='lifecycle_evidence_fault';
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for(const table of ['admin_jobs','audit_events','data_classes','page_tags','page_versions','pages','trash_page_tags','trash_page_versions','trash_pages','tags','taxonomies','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'11000',name:'Private Actor',email:'private-actor@example.invalid',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;user=(await verifyJWT(cookie.slice('access_token='.length),env.JWT_SECRET))!;
  await env.DB.prepare("INSERT INTO taxonomies(id,name,slug) VALUES (11031,'Private Taxonomy','clinical')").run();
  await env.DB.prepare("INSERT INTO tags(id,uuid,name,slug,taxonomy_slug,lect) VALUES (11030,'tag-uuid','Private Tag','private-tag','clinical','{}')").run();
  for(const id of [11010,11011])await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect,page_id) VALUES (?,?,'Private Draft',?,'article',?,?)").bind(id,`draft-uuid-${id}`,`private-slug-${id}`,'{"private":"private draft body"}',id===11011?11010:null).run();
  for(const id of [11020,11021,11022])await env.DB.prepare("INSERT INTO trash_pages(id,uuid,name,slug,page_type,lect,page_id,source_page_id) VALUES (?,?,'Private Trash',?,?,?, ?,?)").bind(id,`trash-uuid-${id}`,`private-slug-${id}`,id===11020?'article':'other','{"private":"private trash body"}',id===11020?null:id-1,id===11020?null:id-1).run();
  for(const id of [11010,11011]){await env.DB.prepare("INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (?,?,?,?,'create')").bind(id+1000,`version-${id}`,id,'{"private":"private draft history"}').run();await env.DB.prepare('INSERT INTO page_tags(id,uuid,page_id,tag_id) VALUES (?,?,?,11030)').bind(id+2000,`link-${id}`,id).run();}
  for(const id of [11020,11021,11022]){await env.DB.prepare("INSERT INTO trash_page_versions(id,uuid,page_id,lect,action) VALUES (?,?,?,?,'create')").bind(id+3000,`version-${id}`,id,'{"private":"private trash history"}').run();await env.DB.prepare('INSERT INTO trash_page_tags(id,uuid,page_id,tag_id) VALUES (?,?,?,11030)').bind(id+4000,`link-${id}`,id).run();}
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();});
const ops={trash:'/admin/pages/11010/delete',trashBulk:'bulk',restore:'/admin/trash/11020/restore',restoreBulk:'/admin/trash/restore',purge:'/admin/trash/11020/delete',purgeBulk:'/admin/trash/empty'};
type Operation=keyof typeof ops;
async function call(operation:Operation,overrides:Partial<Env>={},form:Record<string,string>={}){
  if(operation==='trashBulk'){try{const outcome=await applyBulkPageAction({...env,...overrides},user,'delete',[11010,11011]);return new Response(JSON.stringify(outcome),{status:200});}catch{return new Response('unavailable',{status:503});}}
  counter++;const ctx=createExecutionContext();const response=await worker.fetch(new Request(`https://cms.example.com${ops[operation]}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.95.${Math.floor(counter/250)}.${counter%250+1}`},body:new URLSearchParams(form)}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);await waitOnExecutionContext(ctx);return response;
}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('page.delete','page.restore','page.restore_all','page.purge','page.purge_all') AND outcome='success' ORDER BY seq").all()).results;}
async function state(){return Promise.all(['pages','page_versions','page_tags','trash_pages','trash_page_versions','trash_page_tags','page_sensitivity_floors'].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`.replace('page_sensitivity_floors ORDER BY id','page_sensitivity_floors ORDER BY uuid')).all()).results));}
async function classify(kind='table',key='pages',value='phi'){await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
function race(change:()=>Promise<unknown>,uncertain=false):Env['DB']{
  let changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string}>();
  function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement{const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql});return proxy;}
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let inject=false;if(!changed&&statements.some(s=>/^(INSERT INTO|UPDATE|DELETE FROM) (pages|trash_pages|page_versions|trash_page_versions)\b/.test(tracked.get(s)?.sql??''))){changed=true;inject=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(inject&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;}};return DB as Env['DB'];
}
for(const operation of Object.keys(ops) as Operation[]){
  const source=operation.startsWith('trash')?'pages':'trash_pages';const id=operation.startsWith('trash')?11010:11020;const versions=source==='pages'?'page_versions':'trash_page_versions';const links=source==='pages'?'page_tags':'trash_page_tags';
  it.each(['none','phi'])(`commits ${operation} and exact private %s lifecycle evidence`,async dataClass=>{
    if(dataClass==='phi')await classify('table',source);expect((await call(operation)).status).toBe(operation==='trashBulk'?200:302);
    const rows=await events();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({actor_user_id:'11000',actor_roles:'admin',data_class:dataClass});const detail=JSON.parse(String(rows[0].detail));expect(detail).toMatchObject({operation_id:expect.any(String),classification_policy_version:expect.any(Number)});expect(detail.sources).toHaveLength(rows[0].target_count);
    for(const secret of ['Private ','private draft','private trash','private-slug','private-actor@example.invalid'])expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it.each(['abort','ignore','rewrite'])(`rolls back ${operation} if its lifecycle receipt is %s`,async failure=>{
    const before=await state();const sql=failure==='abort'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events BEGIN UPDATE audit_events SET outcome='denied' WHERE event_id=NEW.event_id; END";await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run();expect((await call(operation)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  });
  it.each(['policy','session','role','body','history','links'])(`refuses ${operation} if %s changes before its write batch`,async change=>{
    const DB=race(async()=>{if(change==='policy')return classify();if(change==='session')return env.DB.prepare('DELETE FROM sessions').run();if(change==='role')return env.DB.prepare("UPDATE users SET role='viewer' WHERE id=11000").run();if(change==='body')return env.DB.prepare(`UPDATE ${source} SET lect=? WHERE id=?`).bind('{"private":"concurrent body"}',id).run();if(change==='history')return env.DB.prepare(`UPDATE ${versions} SET lect=? WHERE page_id=?`).bind('{"private":"concurrent history"}',id).run();return env.DB.prepare(`INSERT INTO ${links}(page_id,tag_id) VALUES (?,11030)`).bind(id).run();});expect((await call(operation,{DB})).status).toBe(503);expect(await events()).toEqual([]);
  });
  it(`retains committed ${operation} and its receipt after a lost acknowledgment`,async()=>{expect((await call(operation,{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);});
}
it('restores a parent without cascade-deleting unselected children or their history',async()=>{
  expect((await call('restore')).status).toBe(302);expect(await env.DB.prepare('SELECT page_id,source_page_id FROM trash_pages WHERE id=11021').first()).toEqual({page_id:null,source_page_id:11020});expect(await env.DB.prepare('SELECT page_id FROM trash_pages WHERE id=11022').first()).toEqual({page_id:11021});expect((await env.DB.prepare('SELECT * FROM trash_page_versions').all()).results).toHaveLength(2);expect((await env.DB.prepare('SELECT * FROM trash_page_tags').all()).results).toHaveLength(2);
  const detail=JSON.parse(String((await events())[0].detail));expect(detail.detached_children).toMatchObject([{id:11021,uuid:'trash-uuid-11021',parent_id:11020}]);
});
it('restores a selected family and resolves parents within the same transaction',async()=>{
  expect((await call('restoreBulk')).status).toBe(302);expect((await env.DB.prepare('SELECT id,page_id FROM pages WHERE id>=11020 ORDER BY id').all()).results).toEqual([{id:11020,page_id:null},{id:11021,page_id:11020},{id:11022,page_id:11021}]);expect((await env.DB.prepare('SELECT * FROM trash_pages').all()).results).toEqual([]);
});
it('records the full purge descendant closure even for a filtered selection',async()=>{
  expect((await call('purgeBulk',{}, {type:'article'})).status).toBe(302);const row=(await events())[0];expect(row.target_count).toBe(3);expect(JSON.parse(String(row.detail))).toMatchObject({selected_ids:[11020],cascade_ids:[11021,11022]});expect((await env.DB.prepare('SELECT * FROM trash_pages').all()).results).toEqual([]);
});
it('uses a descendants retained PHI floor for the entire purge event',async()=>{await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('trash-uuid-11022',2)").run();expect((await call('purge')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='trash-uuid-11022'").first()).toEqual({level:2});});
it('round-trips page, version and association identities through trash',async()=>{
  const page=await env.DB.prepare('SELECT id,uuid,lect FROM pages WHERE id=11010').first();const version=await env.DB.prepare('SELECT id,uuid,lect FROM page_versions WHERE page_id=11010').first();const link=await env.DB.prepare('SELECT id,uuid,tag_id,weight FROM page_tags WHERE page_id=11010').first();expect((await call('trash')).status).toBe(302);
  const ctx=createExecutionContext();const response=await worker.fetch(new Request('https://cms.example.com/admin/trash/11010/restore',{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin'}}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);await waitOnExecutionContext(ctx);expect(response.status).toBe(302);expect(await env.DB.prepare('SELECT id,uuid,lect FROM pages WHERE id=11010').first()).toEqual(page);expect(await env.DB.prepare('SELECT id,uuid,lect FROM page_versions WHERE page_id=11010').first()).toEqual(version);expect(await env.DB.prepare('SELECT id,uuid,tag_id,weight FROM page_tags WHERE page_id=11010').first()).toEqual(link);
});
it.each(['restoreBulk','purgeBulk'] as Operation[])('freezes last-hour scope for %s',async operation=>{
  await env.DB.prepare("UPDATE trash_pages SET created_at=datetime('now','-2 hours') WHERE id=11020").run();expect((await call(operation,{}, {action:'1h'})).status).toBe(302);expect((await env.DB.prepare('SELECT id FROM trash_pages ORDER BY id').all()).results).toEqual([{id:11020}]);expect(JSON.parse(String((await events())[0].detail)).selected_ids).toEqual([11021,11022]);
});
it('does not invent lifecycle receipts for empty selections',async()=>{await env.DB.prepare('DELETE FROM trash_pages').run();expect((await call('restoreBulk')).status).toBe(302);expect((await call('purgeBulk')).status).toBe(302);expect(await events()).toEqual([]);});
it('rejects incompatible version identity collisions without losing either side',async()=>{
  await env.DB.prepare("INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (14020,'unrelated-version',11010,'{}','create')").run();const before=await state();expect((await call('restore')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('merges only compatible existing history for a matching UUID',async()=>{
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11100,'trash-uuid-11020','Existing','existing','article','{}')").run();expect((await call('restore')).status).toBe(302);expect(await env.DB.prepare('SELECT page_id FROM page_versions WHERE uuid=?').bind('version-11020').first()).toEqual({page_id:11100});expect(await env.DB.prepare('SELECT page_id FROM page_tags WHERE uuid=?').bind('link-11020').first()).toEqual({page_id:11100});
  await mutatePageLifecycle(env,user,'restore',{ids:[11021]});expect(await env.DB.prepare('SELECT page_id FROM pages WHERE id=11021').first()).toEqual({page_id:11100});
});
it('keeps every direct lifecycle operation contained in regulated mode',async()=>{for(const action of ['trash','restore','purge'] as const)await expect(mutatePageLifecycle({...env,REGULATED_MODE:'true'},user,action,{ids:[11020]})).rejects.toThrow();expect(await events()).toEqual([]);});
it('rejects source bodies exceeding the snapshot budget before copying or deleting',async()=>{
  await env.DB.prepare('UPDATE trash_pages SET lect=? WHERE id=11020').bind(JSON.stringify({private:'x'.repeat(1_000_001)})).run();expect((await call('restore')).status).toBe(503);expect(await env.DB.prepare('SELECT id FROM trash_pages WHERE id=11020').first()).toEqual({id:11020});expect(await events()).toEqual([]);
});

it.each(['page-copy','history-copy','link-copy','history-delete','page-delete','child-detach'])('rejects an ignored lifecycle write: %s',async failure=>{
  const before=await state();const sql=failure==='page-copy'?"BEFORE INSERT ON pages BEGIN SELECT RAISE(IGNORE); END"
    :failure==='history-copy'?"BEFORE INSERT ON page_versions BEGIN SELECT RAISE(IGNORE); END"
    :failure==='link-copy'?"BEFORE INSERT ON page_tags BEGIN SELECT RAISE(IGNORE); END"
    :failure==='history-delete'?"BEFORE DELETE ON trash_page_versions BEGIN SELECT RAISE(IGNORE); END"
    :failure==='page-delete'?"BEFORE DELETE ON trash_pages WHEN OLD.id=11020 BEGIN SELECT RAISE(IGNORE); END"
    :"BEFORE UPDATE ON trash_pages WHEN OLD.id=11021 AND NEW.page_id IS NULL BEGIN SELECT RAISE(IGNORE); END";
  await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run();expect((await call('restore')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('records the finite purge closure for a cyclic trash hierarchy',async()=>{await env.DB.prepare('UPDATE trash_pages SET page_id=11022 WHERE id=11020').run();expect((await call('purge')).status).toBe(302);expect((await events())[0].target_count).toBe(3);expect((await env.DB.prepare('SELECT * FROM trash_pages').all()).results).toEqual([]);});
it('does not overwrite an unrelated numeric page identity',async()=>{await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11020,'unrelated-uuid','Unrelated','unrelated','article','{}')").run();const before=await state();expect((await call('restore')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('reuses compatible existing version UUIDs while preserving their target IDs',async()=>{
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11100,'trash-uuid-11020','Existing','existing','article','{}')").run();
  await env.DB.prepare('INSERT INTO page_versions(id,uuid,created_at,updated_at,page_id,lect,action) SELECT 16000,uuid,created_at,updated_at,11100,lect,action FROM trash_page_versions WHERE page_id=11020').run();expect((await call('restore')).status).toBe(302);expect(await env.DB.prepare("SELECT id,page_id FROM page_versions WHERE uuid='version-11020'").first()).toEqual({id:16000,page_id:11100});
});
it('refuses matching history UUIDs with incompatible bodies',async()=>{
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11100,'trash-uuid-11020','Existing','existing','article','{}')").run();
  await env.DB.prepare("INSERT INTO page_versions(id,uuid,created_at,updated_at,page_id,lect,action) SELECT 16000,uuid,created_at,updated_at,11100,'{}',action FROM trash_page_versions WHERE page_id=11020").run();const before=await state();expect((await call('restore')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('refuses matching link UUIDs with incompatible metadata',async()=>{
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11100,'trash-uuid-11020','Existing','existing','article','{}')").run();await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id,weight) VALUES (16000,'link-11020',11100,11030,99)").run();const before=await state();expect((await call('restore')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('inherits taxonomy sensitivity while preserving floors across a move',async()=>{await classify('taxonomy','clinical');expect((await call('trash')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='draft-uuid-11010'").first()).toEqual({level:2});});
it('refuses new matches in a bulk scope after its snapshot',async()=>{const DB=race(()=>env.DB.prepare("INSERT INTO trash_pages(id,uuid,name,slug,page_type,lect) VALUES (11123,'new-uuid','New','new','article','{}')").run());expect((await call('restoreBulk',{DB})).status).toBe(503);expect((await env.DB.prepare('SELECT * FROM trash_pages').all()).results).toHaveLength(4);expect(await events()).toEqual([]);});
it('refuses a new descendant after the purge closure was captured',async()=>{const DB=race(()=>env.DB.prepare("INSERT INTO trash_pages(id,uuid,name,slug,page_type,lect,page_id) VALUES (11123,'new-child','New','new','article','{}',11022)").run());expect((await call('purge',{DB})).status).toBe(503);expect((await env.DB.prepare('SELECT * FROM trash_pages').all()).results).toHaveLength(4);expect(await events()).toEqual([]);});
it('rechecks the current destination parent before restoring its child',async()=>{await env.DB.prepare('UPDATE trash_pages SET source_page_id=11010 WHERE id=11020').run();expect((await call('restore',{DB:race(()=>env.DB.prepare('DELETE FROM pages WHERE id=11010').run())})).status).toBe(503);expect(await events()).toEqual([]);});
it('includes protected current-parent identity in lifecycle classification',async()=>{await env.DB.prepare('UPDATE trash_pages SET source_page_id=11010 WHERE id=11020').run();await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('draft-uuid-11010',2)").run();expect((await call('restore')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');});
it('refuses malformed policy without changing lifecycle state',async()=>{await classify('table','trash_pages','invalid');const before=await state();expect((await call('purge')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('retains a complete lifecycle target manifest beyond the indexed cap',async()=>{
  await env.DB.prepare('DELETE FROM trash_pages').run();await env.DB.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205) INSERT INTO trash_pages(id,uuid,name,slug,page_type,lect) SELECT n,'many-'||n,'Private '||n,'slug-'||n,'article','{}' FROM seq").run();expect((await call('purgeBulk')).status).toBe(302);const row=(await events())[0];expect(row.target_count).toBe(205);expect(JSON.parse(String(row.target_ids))).toHaveLength(200);expect(JSON.parse(String(row.detail)).sources).toHaveLength(205);
});
async function job(){return createAdvancedSearchBulkActionJob(env.DB,{action:'delete',scope:'selected',ids:[11010,11011],pageTypes:['article'],criteria:[],operator:'AND',targetTagIds:[],searchText:'',replacementText:'',returnTo:'/admin',user:{...user,exp:1}});}
it('executes a queued deletion with current delete authority and its persisted claim',async()=>{const queued=await job();await runCmsAdminJob(env,queued.id);expect(await env.DB.prepare('SELECT status FROM admin_jobs WHERE id=?').bind(queued.id).first()).toEqual({status:'done'});const rows=await events();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({acting_via:`job:${queued.id}`,request_id:null,target_count:2});expect(JSON.parse(String(rows[0].detail))).toMatchObject({job_id:queued.id,job_attempt:1});});
it.each(['lease','grant'])('refuses a queued deletion if its %s changes at admission',async change=>{const queued=await job();const before=await state();const DB=race(()=>change==='lease'?env.DB.prepare('UPDATE admin_jobs SET attempts=attempts+1 WHERE id=?').bind(queued.id).run():env.DB.prepare("UPDATE users SET role='viewer' WHERE id=11000").run());await runCmsAdminJob({...env,DB},queued.id);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});

it('refuses unavailable optional trash storage without hard-deleting a draft',async()=>{
  const DB={withSession:()=>DB,prepare:(sql:string)=>sql.includes("name IN ('trash_pages','trash_page_versions','trash_page_tags')")?{first:async()=>({n:0})} as D1PreparedStatement:env.DB.prepare(sql),batch:env.DB.batch.bind(env.DB)};
  expect((await call('trash',{DB:DB as Env['DB']})).status).toBe(503);expect(await env.DB.prepare('SELECT id FROM pages WHERE id=11010').first()).toEqual({id:11010});expect(await events()).toEqual([]);
});
it('does not overwrite a destination changed after the restore snapshot',async()=>{
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (11100,'trash-uuid-11020','Existing','existing','article','{}')").run();const DB=race(()=>env.DB.prepare('UPDATE pages SET lect=? WHERE id=11100').bind('{"private":"concurrent destination"}').run());expect((await call('restore',{DB})).status).toBe(503);expect(await env.DB.prepare('SELECT lect FROM pages WHERE id=11100').first()).toEqual({lect:'{"private":"concurrent destination"}'});expect(await events()).toEqual([]);
});
