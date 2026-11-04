import { env } from 'cloudflare:workers';
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { signJWT } from './auth-fixtures';

let cookie='';let counter=0;
const fault='taxonomy_evidence_fault';
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();
  for(const table of ['audit_events','data_classes','page_tags','page_versions','pages','trash_page_tags','trash_page_versions','trash_pages','tags','taxonomies','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'10000',name:'Private Operator',email:'private-actor@example.invalid',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
  await env.DB.prepare("INSERT INTO taxonomies(id,uuid,name,slug) VALUES (10010,'tax-uuid-old','Private Old Taxonomy','old'),(10011,'tax-uuid-next','Private Next Taxonomy','next')").run();
  await env.DB.prepare(`INSERT INTO tags(id,uuid,name,slug,taxonomy_slug,parent_tag,lect) VALUES (10020,'tag-uuid-target','Private Target','private-target','old',NULL,'{"secret":"private body"}'),(10021,'tag-uuid-child','Private Child','private-child','old',10020,'{"secret":"private body"}'),(10022,'tag-uuid-next','Private Next','private-next','next',NULL,'{"secret":"private body"}')`).run();
  await env.DB.prepare(`INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (10030,'page-uuid-live','Private Page','private-page','article','{"secret":"private body"}')`).run();
  await env.DB.prepare(`INSERT INTO trash_pages(id,uuid,name,slug,page_type,lect) VALUES (10031,'page-uuid-trash','Private Trash','private-trash','article','{"secret":"private body"}')`).run();
  await env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) VALUES (1,10030,10020),(2,10030,10021)').run();
  await env.DB.prepare('INSERT INTO trash_page_tags(page_id,tag_id) VALUES (10031,10020)').run();
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();});
const operations={
  taxCreate:{path:'/admin/taxonomies',body:{name:'Private Created Taxonomy',slug:'created'},action:'taxonomy.create'},
  taxUpdate:{path:'/admin/taxonomies/10010',body:{name:'Private Changed Taxonomy',slug:'renamed'},action:'taxonomy.update'},
  taxDelete:{path:'/admin/taxonomies/10010/delete',body:{},action:'taxonomy.delete'},
  tagCreate:{path:'/admin/tags',body:{name:'Private Created Tag',slug:'created',taxonomy_slug:'old',weight:'10'},action:'tag.create'},
  tagUpdate:{path:'/admin/tags/10020',body:{name:'Private Changed Tag',slug:'changed',taxonomy_slug:'next',weight:'10'},action:'tag.update'},
  tagDelete:{path:'/admin/tags/10020/delete',body:{},action:'tag.delete'},
  weights:{path:'/admin/tags/batch-weight',body:{updates:[{id:10020,weight:10},{id:10021,weight:20}]},action:'tag.weights'},
};
type Operation=keyof typeof operations;
async function call(operation:Operation,overrides:Partial<Env>={}){
  counter++;const op=operations[operation];const ctx=createExecutionContext();const body=operation==='weights'?JSON.stringify(op.body):new URLSearchParams(op.body as Record<string,string>);
  const response=await worker.fetch(new Request(`https://cms.example.com${op.path}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','Content-Type':operation==='weights'?'application/json':'application/x-www-form-urlencoded','CF-Connecting-IP':`10.94.${Math.floor(counter/250)}.${counter%250+1}`},body}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);
  await waitOnExecutionContext(ctx);return response;
}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('taxonomy.create','taxonomy.update','taxonomy.delete','tag.create','tag.update','tag.delete','tag.weights') AND outcome='success' ORDER BY seq").all()).results;}
async function state(){return Promise.all(['taxonomies','tags','page_tags','trash_page_tags','data_class_floors','page_sensitivity_floors','classification_policy_version'].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));}
async function classify(kind='table',key='tags',value='phi'){await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
function race(change:()=>Promise<unknown>,uncertain=false):Env['DB']{
  let changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string}>();
  function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement{const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql});return proxy;}
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let inject=false;if(!changed&&statements.some(s=>/^(INSERT INTO|UPDATE|DELETE FROM) (tags|taxonomies)\b/.test(tracked.get(s)?.sql??''))){changed=true;inject=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(inject&&uncertain)throw new Error('Synthetic lost commit acknowledgment');return result;}};return DB as Env['DB'];
}
for(const operation of Object.keys(operations) as Operation[]){
  it.each(['none','phi'])(`commits ${operation} with private exact %s evidence`,async dataClass=>{
    if(dataClass==='phi')await classify();expect((await call(operation)).status).toBe(operation==='weights'?200:302);
    const rows=await events();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:operations[operation].action,actor_user_id:'10000',actor_roles:'admin',data_class:dataClass});
    expect(JSON.parse(String(rows[0].detail))).toMatchObject({classification_policy_version:expect.any(Number)});
    for(const marker of ['Private ','{"secret":"private body"}','private-actor@example.invalid','private-target','private-child'])expect(JSON.stringify(rows)).not.toContain(marker);
  });
  it.each(['abort','ignore','rewrite'])(`rolls back ${operation} when its audit row is %s`,async failure=>{
    const before=await state();const sql=failure==='abort'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events BEGIN UPDATE audit_events SET outcome='denied' WHERE event_id=NEW.event_id; END";
    await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();expect((await call(operation)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  });
  it.each(['policy','session','role','target','membership'])(`refuses ${operation} after a concurrent %s change`,async change=>{
    const DB=race(async()=>{if(change==='policy')return classify();if(change==='session')return env.DB.prepare('DELETE FROM sessions').run();if(change==='role')return env.DB.prepare("UPDATE users SET role='viewer' WHERE id=10000").run();if(change==='target')return env.DB.prepare("UPDATE tags SET name='Concurrent' WHERE id=10020").run();return env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) VALUES (3,10030,10020)').run();});
    const unrelated=operation==='taxCreate'&&(change==='target'||change==='membership');
    expect((await call(operation,{DB})).status).toBe(unrelated?302:503);expect(await events()).toHaveLength(unrelated?1:0);
  });
  it(`retains committed ${operation} state and evidence after a lost acknowledgment`,async()=>{expect((await call(operation,{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);});
}
it('advances the policy generation for an authorized classified taxonomy rename and retains PHI',async()=>{
  await classify('taxonomy','old');const before=(await env.DB.prepare('SELECT version FROM classification_policy_version').first<{version:number}>())!.version;
  expect((await call('taxUpdate')).status).toBe(302);const event=(await events())[0];expect(event.data_class).toBe('phi');expect(JSON.parse(String(event.detail))).toMatchObject({classification_policy_version_before:before,classification_policy_version:before+1,moved_tag_ids:[10020,10021]});
  expect(await env.DB.prepare("SELECT level FROM data_class_floors WHERE container_kind='taxonomy' AND container_key='renamed'").first()).toEqual({level:2});
});
it('refuses an unreviewed taxonomy removal that would lower its tag classification',async()=>{await classify('taxonomy','old');const before=await state();expect((await call('taxDelete')).status).toBe(409);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('permits orphaning into an equally protected default taxonomy',async()=>{await classify('taxonomy','old');await classify('taxonomy','default');expect((await call('taxDelete')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');});
it('records exact live/trash removals and child-parent changes on tag deletion',async()=>{
  expect((await call('tagDelete')).status).toBe(302);const detail=JSON.parse(String((await events())[0].detail));expect(detail.removed_live_links).toHaveLength(1);expect(detail.removed_trash_links).toHaveLength(1);expect(detail.cleared_child_ids).toEqual([10021]);expect(await env.DB.prepare('SELECT parent_tag FROM tags WHERE id=10021').first()).toEqual({parent_tag:null});
});
it('uses the generated tag id for publication and its UUID for local evidence',async()=>{
  expect((await call('tagCreate')).status).toBe(302);const tag=await env.DB.prepare("SELECT id,uuid FROM tags WHERE slug='created'").first<{id:number;uuid:string}>();expect(tag!.id).toBeGreaterThan(10000);expect((await events())[0].target_id).toBe(tag!.uuid);
  expect(await env.PUBLISHED_DB.prepare('SELECT id FROM tags WHERE id=?').bind(tag!.id).first()).toEqual({id:tag!.id});
});
it('keeps UUID-floor classification after deleting the final live and trash tag links',async()=>{
  await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('page-uuid-live',2),('page-uuid-trash',2)").run();expect((await call('tagDelete')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');expect((await env.DB.prepare('SELECT level FROM page_sensitivity_floors').all()).results).toHaveLength(2);
});
it('produces no new event for identical tag weights',async()=>{expect((await call('weights')).status).toBe(200);const before=await events();expect((await call('weights')).status).toBe(200);expect(await events()).toEqual(before);});
it('keeps regulated taxonomy writes contained',async()=>{expect((await call('tagUpdate',{REGULATED_MODE:'true'})).status).toBe(503);expect(await events()).toEqual([]);});
it.each(['tag-write','tag-delete','orphan','child','floor','link'])('rolls back partial relationship or state writes: %s',async failure=>{
  if(failure==='floor')await env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('page-uuid-live',2)").run();
  const before=await state();const sql=failure==='tag-write'?"BEFORE UPDATE ON tags WHEN OLD.id=10020 BEGIN SELECT RAISE(IGNORE); END"
    :failure==='tag-delete'?"BEFORE DELETE ON tags WHEN OLD.id=10020 BEGIN SELECT RAISE(IGNORE); END"
    :failure==='orphan'?"BEFORE UPDATE ON tags WHEN OLD.taxonomy_slug='old' AND NEW.taxonomy_slug IS NULL BEGIN SELECT RAISE(IGNORE); END"
    :failure==='child'?"BEFORE UPDATE ON tags WHEN OLD.parent_tag=10020 AND NEW.parent_tag IS NULL BEGIN SELECT RAISE(IGNORE); END"
    :failure==='floor'?"AFTER INSERT ON audit_events WHEN NEW.action='tag.delete' BEGIN UPDATE page_sensitivity_floors SET level=1 WHERE uuid='page-uuid-live'; END"
    :"AFTER INSERT ON audit_events WHEN NEW.action='tag.update' BEGIN INSERT INTO page_tags(id,page_id,tag_id) VALUES (3,10030,10020); END";
  await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();const operation=failure==='orphan'?'taxDelete':failure==='tag-write'||failure==='link'?'tagUpdate':'tagDelete';
  expect((await call(operation)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('deletes a tag when the optional trash schema is absent',async()=>{
  const objects=(await env.DB.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'trash_%' OR name LIKE 'sensitivity_trash_%' OR name LIKE 'idx_trash_%') ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END").all<{type:string;name:string;sql:string}>()).results;
  for(const object of objects.filter(o=>o.type==='trigger'||o.type==='view'))await env.DB.prepare(`DROP ${object.type} IF EXISTS ${object.name}`).run();
  for(const table of ['trash_page_tags','trash_page_versions','trash_pages'])await env.DB.prepare(`DROP TABLE ${table}`).run();
  try{expect((await call('tagDelete')).status).toBe(302);expect(JSON.parse(String((await events())[0].detail)).removed_trash_links).toEqual([]);}
  finally{for(const object of objects)await env.DB.prepare(object.sql).run();}
});
it('classifies a new ungrouped tag with the retained default taxonomy',async()=>{
  await classify('taxonomy','default');const ctx=createExecutionContext();const response=await worker.fetch(new Request('https://cms.example.com/admin/tags',{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin'},body:new URLSearchParams({name:'Private Ungrouped',slug:'ungrouped'})}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);await waitOnExecutionContext(ctx);expect(response.status).toBe(302);expect((await events())[0].data_class).toBe('phi');
});
it('rolls back retained-floor copying and its generation when rename evidence fails',async()=>{
  await classify('taxonomy','old');const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='taxonomy.update' BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call('taxUpdate')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('refuses an extra policy-generation change during an otherwise authorized rename',async()=>{
  await classify('taxonomy','old');const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='taxonomy.update' BEGIN UPDATE data_class_floors SET level=level WHERE container_kind='taxonomy' AND container_key='renamed'; END`).run();expect((await call('taxUpdate')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('retains the complete tag-weight manifest beyond the indexed target cap',async()=>{
  await env.DB.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205) INSERT INTO tags(id,uuid,name,slug,taxonomy_slug,lect) SELECT n,'weight-uuid-'||n,'Private '||n,'weight-'||n,'next','{}' FROM seq").run();
  const ctx=createExecutionContext();const response=await worker.fetch(new Request('https://cms.example.com/admin/tags/batch-weight',{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({updates:Array.from({length:205},(_,i)=>({id:i+1,weight:10}))})}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);await waitOnExecutionContext(ctx);expect(response.status).toBe(200);const row=(await events())[0];expect(row.target_count).toBe(205);expect(JSON.parse(String(row.target_ids))).toHaveLength(200);expect(JSON.parse(String(row.detail)).targets).toHaveLength(205);
});
it('refuses malformed policy before changing tags',async()=>{await classify('table','tags','invalid');const before=await state();expect((await call('tagUpdate')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses an oversized affected taxonomy before any mutation',async()=>{
  await env.DB.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<5001) INSERT INTO tags(id,uuid,name,slug,taxonomy_slug,lect) SELECT 100000+n,'many-uuid-'||n,'Private '||n,'many-'||n,'old','{}' FROM seq").run();expect((await call('taxUpdate')).status).toBe(503);expect(await env.DB.prepare('SELECT slug FROM taxonomies WHERE id=10010').first()).toEqual({slug:'old'});expect(await events()).toEqual([]);
});
it('does not contact publication storage when the local transaction is refused',async()=>{
  await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();let calls=0;const published={withSession:()=>published,prepare:(sql:string)=>{calls++;return env.PUBLISHED_DB.prepare(sql);},batch:env.PUBLISHED_DB.batch.bind(env.PUBLISHED_DB)};
  expect((await call('tagDelete',{PUBLISHED_DB:published as Env['PUBLISHED_DB']})).status).toBe(503);expect(calls).toBe(0);expect(await events()).toEqual([]);
});
it('checks current delegated taxonomy grants inside the mutation batch',async()=>{
  await env.DB.prepare("INSERT INTO roles(name,label,builtin) VALUES ('taxer','Taxer',0)").run();await env.DB.prepare("INSERT INTO role_permissions(role,permission) VALUES ('taxer','taxonomy:write'),('taxer','content:read')").run();
  cookie=`access_token=${await signJWT({sub:'10000',name:'Private Operator',email:'private-actor@example.invalid',role:'taxer',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
  const before=await state();expect((await call('taxUpdate',{DB:race(()=>env.DB.prepare("DELETE FROM role_permissions WHERE role='taxer' AND permission='taxonomy:write'").run())})).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});

it('does not create an invalid empty policy key when editing a classified taxonomy',async()=>{
  await classify('taxonomy','old');const before=await state();const ctx=createExecutionContext();const response=await worker.fetch(new Request('https://cms.example.com/admin/taxonomies/10010',{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin'},body:new URLSearchParams({name:'',slug:''})}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);await waitOnExecutionContext(ctx);expect(response.status).toBe(302);expect(response.headers.get('Location')).toContain('error=missing');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});

it('allows repeated withdrawal after an uncertain local delete without inventing a second mutation',async()=>{
  expect((await call('tagDelete',{DB:race(async()=>{},true)})).status).toBe(503);expect(await events()).toHaveLength(1);
  let calls=0;const published={withSession:()=>published,prepare:(sql:string)=>{calls++;return env.PUBLISHED_DB.prepare(sql);},batch:env.PUBLISHED_DB.batch.bind(env.PUBLISHED_DB)};
  expect((await call('tagDelete',{PUBLISHED_DB:published as Env['PUBLISHED_DB']})).status).toBe(302);expect(calls).toBeGreaterThan(0);expect(await events()).toHaveLength(1);
});

it('guards the edited body while avoiding unrelated body snapshots',async()=>{
  expect((await call('tagUpdate',{DB:race(()=>env.DB.prepare('UPDATE tags SET lect=? WHERE id=10020').bind('{"secret":"concurrent body"}').run())})).status).toBe(503);expect(await env.DB.prepare('SELECT lect FROM tags WHERE id=10020').first()).toEqual({lect:'{"secret":"concurrent body"}'});expect(await events()).toEqual([]);
});
