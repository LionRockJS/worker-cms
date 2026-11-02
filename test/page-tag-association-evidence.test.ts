import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import type { Env } from '../src/types';

let cookie='',counter=0;
const trigger='association_evidence_fault';
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for(const table of ['audit_events','data_classes','page_tags','page_versions','pages','trash_page_tags','trash_page_versions','trash_pages','tags','taxonomies','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'12000',name:'Private Actor',email:'private@example.invalid',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect,updated_at) VALUES (12010,'page-uuid','Private Page','private-slug','article','{\"private\":\"secret body\"}','2020-01-01 00:00:00')").run();
  await env.DB.prepare("INSERT INTO taxonomies(id,uuid,name,slug) VALUES (12020,'taxonomy-uuid','Private Taxonomy','clinical')").run();
  await env.DB.prepare("INSERT INTO tags(id,uuid,name,slug,taxonomy_slug,lect) VALUES (12030,'tag-uuid-30','Private Tag','private-tag','clinical','{}'),(12031,'tag-uuid-31','Other Private Tag','other-tag','other','{}')").run();
  await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id,weight) VALUES (12040,'link-uuid',12010,12030,7)").run();
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();});
const paths={add:'/admin/api/page/12010/tag/12031',remove:'/admin/api/page_tag/12040',removeAlias:'/admin/api/page/remove/page_tag/12040'};
type Operation=keyof typeof paths;
async function request(path:string,method='POST',overrides:Partial<Env>={},headers:Record<string,string>={}) {
  const ctx=createExecutionContext();counter++;
  const response=await worker.fetch(new Request(`https://cms.example.com${path}`,{method,headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.96.${Math.floor(counter/250)}.${counter%250+1}`,...headers}}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);
  await waitOnExecutionContext(ctx);return response;
}
function call(op:Operation,overrides:Partial<Env>={}){return request(paths[op],op==='add'?'POST':'DELETE',overrides);}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('page.tag-add','page.tag-remove') ORDER BY seq").all()).results;}
async function state(){return Promise.all(['pages','page_tags','page_versions','page_sensitivity_floors'].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${table==='page_sensitivity_floors'?'uuid':'id'}`).all()).results));}
async function classify(kind='table',key='page_tags',value='phi'){await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
function race(change:()=>Promise<unknown>,uncertain=false,nextId?:number):Env['DB'] {
  let changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string}>();
  function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement {const proxy=new Proxy(actual,{get(target,key){if(key==='first'&&nextId!==undefined&&sql.startsWith('SELECT MAX(COALESCE(MAX(id),0)'))return async()=>({id:nextId});if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql});return proxy;}
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let inject=false;if(!changed&&statements.some(s=>/^(INSERT INTO|DELETE FROM) page_tags\b/.test(tracked.get(s)?.sql??''))){changed=true;inject=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(inject&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;}};return DB as Env['DB'];
}
for(const op of Object.keys(paths) as Operation[]) {
  it.each(['none','pii','phi'])(`commits ${op} and exact %s evidence with request attribution`,async classification=>{
    if(classification!=='none')await classify('table','page_tags',classification);
    const before=await state();const response=await call(op);expect(response.status).toBe(200);
    const payload=await response.json() as {payload:{id:number;success:boolean}};expect(payload.payload.success).toBe(true);
    const rows=await events();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:op==='add'?'page.tag-add':'page.tag-remove',target_id:'page-uuid',target_count:1,data_class:classification,outcome:'success',actor_user_id:'12000',actor_roles:'admin',retention_class:'content_mutation'});
    expect(rows[0].source_ip).toMatch(/^10\.96\./);
    const detail=JSON.parse(String(rows[0].detail));expect(detail).toMatchObject({operation_id:expect.any(String),classification_policy_version:expect.any(Number),page:{id:12010,uuid:'page-uuid'},association:{id:payload.payload.id,page_id:12010,tag_id:op==='add'?12031:12030,weight:op==='add'?5:7}});
    expect(detail.links_before).toHaveLength(1);expect(detail.links_after).toHaveLength(op==='add'?2:0);
    expect((await state())[2]).toEqual(before[2]);
    expect(await env.DB.prepare('SELECT updated_at FROM pages WHERE id=12010').first()).not.toEqual({updated_at:'2020-01-01 00:00:00'});
    for(const secret of ['Private','private@example','secret body','private-slug','private-tag'])expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it.each(['abort','ignore','rewrite'])(`rolls back ${op} with %s mutation evidence`,async failure=>{
    const before=await state();const fault=failure==='abort'?"BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'page.tag-%' BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'page.tag-%' BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events WHEN NEW.action LIKE 'page.tag-%' BEGIN UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id; END";
    await env.DB.prepare(`CREATE TRIGGER ${trigger} ${fault}`).run();const response=await call(op);expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  });
  it.each(['policy','policyRestore','session','grants','page','tag','links','floor'])(`refuses ${op} after concurrent %s changes`,async change=>{
    let concurrent:Awaited<ReturnType<typeof state>>;
    const DB=race(async()=>{await(async()=>{
      if(change==='policy'||change==='policyRestore'){await classify();if(change==='policyRestore')await env.DB.prepare('DELETE FROM data_classes').run();return;}
      if(change==='session')return env.DB.prepare('DELETE FROM sessions').run();
      if(change==='grants')return env.DB.prepare("INSERT INTO role_permissions(role,permission) VALUES ('editor','content:write')").run();
      if(change==='page')return env.DB.prepare("UPDATE pages SET uuid='changed-uuid' WHERE id=12010").run();
      if(change==='tag')return env.DB.prepare("UPDATE tags SET uuid='changed-tag' WHERE id=12030").run();
      if(change==='links')return env.DB.prepare('UPDATE page_tags SET weight=99 WHERE id=12040').run();
      return env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('page-uuid',2)").run();
    })();concurrent=await state();});expect((await call(op,{DB})).status).toBe(503);expect(await events()).toEqual([]);
    expect(await state()).toEqual(concurrent!);
  });
  it(`keeps committed ${op} and its receipt after a lost acknowledgment`,async()=>{expect((await call(op,{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);expect((await env.DB.prepare('SELECT COUNT(*) n FROM page_tags').first<{n:number}>())?.n).toBe(op==='add'?2:0);});
  it(`refuses ${op} on malformed classification`,async()=>{await classify('table','page_tags','invalid');const before=await state();expect((await call(op)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
  it(`retains regulated containment for ${op}`,async()=>{const before=await state();expect((await call(op,{REGULATED_MODE:'true'})).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
}
it('preserves duplicate-add response without timestamp or mutation receipt',async()=>{
  const before=await state();const response=await request('/admin/api/page/12010/tag/12030');expect(response.status).toBe(200);expect(await response.json()).toEqual({type:'ADD_PAGE_TAG',payload:{success:false,message:'tag exist',id:12040}});expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it.each(['/admin/api/page_tag/99999','/admin/api/page/remove/page_tag/99999'])('preserves missing-delete success for %s without a receipt',async path=>{const before=await state();const response=await request(path,'DELETE');expect(response.status).toBe(200);expect(await response.json()).toEqual({type:'DELETE_PAGE_TAG',payload:{success:true,id:99999}});expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['/admin/api/page/99999/tag/12030','/admin/api/page/12010/tag/99999'])('refuses missing add target %s',async path=>{const before=await state();expect((await request(path)).status).toBe(404);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['0','-1','12x','1.5','9007199254740992'])('rejects invalid association identity %s',async id=>{expect((await request(`/admin/api/page/${id}/tag/12030`)).status).toBe(400);expect((await request(`/admin/api/page/12010/tag/${id}`)).status).toBe(400);expect((await request(`/admin/api/page_tag/${id}`,'DELETE')).status).toBe(400);expect(await events()).toEqual([]);});
it('deletes only the selected link, preserving legacy duplicates and their weights',async()=>{
  await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id,weight) VALUES (12041,'duplicate-link',12010,12030,9)").run();expect((await call('removeAlias')).status).toBe(200);expect((await env.DB.prepare('SELECT id,uuid,weight FROM page_tags').all()).results).toEqual([{id:12041,uuid:'duplicate-link',weight:9}]);const detail=JSON.parse(String((await events())[0].detail));expect(detail.links_before).toHaveLength(2);expect(detail.links_after).toHaveLength(1);
});
it('retains taxonomy sensitivity after removing its last association',async()=>{await classify('taxonomy','clinical');expect((await call('remove')).status).toBe(200);expect((await events())[0].data_class).toBe('phi');expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='page-uuid'").first()).toEqual({level:2});});
it('raises the page floor when adding a protected taxonomy',async()=>{await classify('taxonomy','other');expect((await call('add')).status).toBe(200);expect((await events())[0].data_class).toBe('phi');expect(await env.DB.prepare("SELECT level FROM page_sensitivity_floors WHERE uuid='page-uuid'").first()).toEqual({level:2});});
it.each(['add','remove'] as const)('refuses ignored %s association writes',async op=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE ${op==='add'?'INSERT':'DELETE'} ON page_tags BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call(op)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['ignore','rewrite'])('refuses %s page timestamp updates',async fault=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} ${fault==='ignore'?"BEFORE UPDATE ON pages BEGIN SELECT RAISE(IGNORE); END":"AFTER UPDATE ON pages BEGIN UPDATE pages SET updated_at='2000-01-01' WHERE id=NEW.id; END"}`).run();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('rolls back a rewritten association payload',async()=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON page_tags BEGIN UPDATE page_tags SET weight=999 WHERE id=NEW.id; END`).run();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('does not replay an already removed association',async()=>{expect((await call('remove')).status).toBe(200);expect((await call('remove')).status).toBe(200);expect(await events()).toHaveLength(1);});
it('does not replay an already added association',async()=>{const first=await(await call('add')).json();const second=await(await call('add')).json() as {payload:{success:boolean;id:number}};expect(second.payload.success).toBe(false);expect(second.payload.id).toBe((first as typeof second).payload.id);expect(await events()).toHaveLength(1);});
it('refuses metadata above the SQL byte budget',async()=>{await env.DB.prepare('UPDATE page_tags SET uuid=? WHERE id=12040').bind('x'.repeat(1_000_001)).run();const before=await state();expect((await call('remove')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('allocates a safe new association identity above existing links',async()=>{await env.DB.prepare('UPDATE page_tags SET id=9007199254740990 WHERE id=12040').run();const response=await call('add');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({payload:{id:9007199254740991}});});
it('refuses exhausted numeric association identities',async()=>{await env.DB.prepare('UPDATE page_tags SET id=9007199254740991 WHERE id=12040').run();const before=await state();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('rolls back a link when its required sensitivity floor is ignored',async()=>{await classify('taxonomy','other');const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON page_sensitivity_floors BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('rolls back a deletion that loses its retained sensitivity floor',async()=>{await classify('taxonomy','clinical');const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER DELETE ON page_tags BEGIN DELETE FROM page_sensitivity_floors; END`).run();expect((await call('remove')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('rechecks authority after business triggers',async()=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON page_tags BEGIN DELETE FROM sessions; END`).run();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await env.DB.prepare('SELECT COUNT(*) n FROM sessions').first()).toEqual({n:1});expect(await events()).toEqual([]);});
it('rechecks policy after business triggers',async()=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER DELETE ON page_tags BEGIN INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','page_tags','phi'); END`).run();expect((await call('remove')).status).toBe(503);expect(await state()).toEqual(before);expect(await env.DB.prepare('SELECT COUNT(*) n FROM data_classes').first()).toEqual({n:0});expect(await events()).toEqual([]);});
it('refuses a concurrently inserted association rather than recording an incomplete manifest',async()=>{let concurrent:Awaited<ReturnType<typeof state>>;const DB=race(async()=>{await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id) VALUES (12042,'concurrent',12010,12031)").run();concurrent=await state();});expect((await call('add',{DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);});
it('refuses a concurrent taxonomy reassignment',async()=>{const DB=race(()=>env.DB.prepare("UPDATE tags SET taxonomy_slug='new-taxonomy' WHERE id=12031").run());expect((await call('add',{DB})).status).toBe(503);expect(await events()).toEqual([]);});
it('refuses a new association identity collision without losing existing links',async()=>{await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type) VALUES (12011,'other-page','Other','other','article')").run();let concurrent:Awaited<ReturnType<typeof state>>;const DB=race(async()=>{await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id) VALUES (77777,'competing',12011,12031)").run();concurrent=await state();},false,77777);expect((await call('add',{DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);});
it('retains the full association manifest beyond 200 rows',async()=>{
  await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id,weight) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<205) SELECT 20000+i,'many-link-'||i,12010,12030,i FROM n").run();expect((await call('remove')).status).toBe(200);const row=(await events())[0];expect(row.target_count).toBe(1);const detail=JSON.parse(String(row.detail));expect(detail.links_before).toHaveLength(206);expect(detail.links_after).toHaveLength(205);
});
it('refuses association snapshots above the row budget',async()=>{await env.DB.prepare("INSERT INTO page_tags(id,uuid,page_id,tag_id) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001) SELECT 20000+i,'over-link-'||i,12010,12030 FROM n").run();const before=await state();expect((await call('remove')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses an orphan legacy link rather than inventing page attribution',async()=>{await env.DB.prepare('UPDATE page_tags SET page_id=NULL WHERE id=12040').run();const before=await state();expect((await call('remove')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('requires content write permission',async()=>{cookie=`access_token=${await signJWT({sub:'12001',name:'Viewer',email:'viewer@example.invalid',role:'viewer',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;const before=await state();expect((await call('add')).status).toBe(403);expect((await call('removeAlias')).status).toBe(403);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('fails closed when protected metadata read evidence cannot be written',async()=>{await classify();const before=await state();await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events WHEN NEW.action='page.tag-association-read' BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();expect((await call('add')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('uses transaction time when execution crosses a timestamp second',async()=>{const DB=race(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});expect((await call('add',{DB})).status).toBe(200);expect(await events()).toHaveLength(1);});
