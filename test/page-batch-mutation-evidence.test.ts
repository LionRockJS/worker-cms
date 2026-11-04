import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { verifyJWT } from '../src/core/auth/jwt';
import { applyBulkPageAction } from '../src/core/pages/bulk-action';
import { updateDraftWeights, ContentBatchEvidenceUnavailableError } from '../src/core/pages/batch-mutation-evidence';
import { runCmsAdminJob } from '../src/features/jobs/runner';
import { createAdvancedSearchBulkActionJob } from '../src/features/jobs/queue';
import type { Env,JWTPayload } from '../src/types';

let cookie='';let user:JWTPayload;let count=0;
const trigger='batch_evidence_fault';
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for(const table of ['admin_jobs','audit_events','data_classes','page_tags','page_versions','pages','tags','taxonomies','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'9990',email:'private-actor@example.invalid',name:'Private Actor',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
  user=(await verifyJWT(cookie.slice('access_token='.length),env.JWT_SECRET))!;
  for(const id of [9991,9992])await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,weight,page_type,lect) VALUES (?,?,'Private Old name',?,5,'article',?)").bind(id,`private-uuid-${id}`,`private-slug-${id}`,'{"title":"Private Old body"}').run();
  await env.DB.prepare("INSERT INTO taxonomies(id,name,slug) VALUES (9993,'Private Taxonomy','clinical')").run();
  await env.DB.prepare("INSERT INTO tags(id,name,slug,taxonomy_slug) VALUES (9994,'Private Tag','private-tag','clinical')").run();
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();});
async function api(path:string,body:unknown,overrides:Partial<Env>={}){
  count++;const ctx=createExecutionContext();const form=body instanceof URLSearchParams;
  const response=await worker.fetch(new Request(`https://cms.example.com${path}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.93.${Math.floor(count/250)}.${count%250+1}`,'Content-Type':form?'application/x-www-form-urlencoded':'application/json'},body:form?body:JSON.stringify(body)}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);await waitOnExecutionContext(ctx);return response;
}
const bulkOptions={targetTagIds:[9994],searchText:'Old',replacementText:'New'};
const operations={
  weight:async(overrides:Partial<Env>={})=>(await api('/admin/pages/9991/weight',new URLSearchParams({weight:'20'}),overrides)).status,
  weights:async(overrides:Partial<Env>={})=>(await api('/admin/pages/batch-weight',{updates:[{id:9991,weight:20},{id:9992,weight:30}]},overrides)).status,
  reorder:async(overrides:Partial<Env>={})=>(await api('/admin/pages/reorder',{pageType:'article',page:1,pagesize:2,before:[9991,9992],after:[9992,9991]},overrides)).status,
  replace_text:async(overrides:Partial<Env>={})=>{await applyBulkPageAction({...env,...overrides},user,'replace_text',[9991,9992],bulkOptions);return 200;},
  add_tag:async(overrides:Partial<Env>={})=>{await applyBulkPageAction({...env,...overrides},user,'add_tag',[9991,9992],bulkOptions);return 200;},
  remove_tag:async(overrides:Partial<Env>={})=>{await applyBulkPageAction({...env,...overrides},user,'remove_tag',[9991,9992],bulkOptions);return 200;},
};
type Operation=keyof typeof operations;
async function setup(operation:Operation){if(operation==='remove_tag')for(const id of [9991,9992])await env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) VALUES (?,?,9994)').bind(id,id).run();}
async function call(operation:Operation,overrides:Partial<Env>={}){try{return await operations[operation](overrides);}catch{return 503;}}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('page.weight','page.weights','page.reorder','page.update') AND outcome='success' ORDER BY seq").all()).results;}
async function state(){return Promise.all(['pages','page_versions','page_tags'].map(async t=>(await env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results));}
async function classify(){await env.DB.prepare("INSERT INTO data_classes(container_kind,container_key,class) VALUES ('page_type','article','phi')").run();}
function race(change:()=>Promise<unknown>,uncertain=false):Env['DB']{
  let changed=false;const tracked=new WeakMap<D1PreparedStatement,{sql:string;actual:D1PreparedStatement}>();
  function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement{const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...values:unknown[])=>track(actual.bind(...values),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{sql,actual});return proxy;}
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let inject=false;if(!changed&&statements.some(s=>/^UPDATE pages SET/.test(tracked.get(s)?.sql??''))){changed=true;inject=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(inject&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;}};return DB as Env['DB'];
}
for(const operation of Object.keys(operations) as Operation[]){
  it.each(['none','phi'])(`commits ${operation} with exact private %s evidence`,async classification=>{
    await setup(operation);if(classification==='phi')await classify();expect(await call(operation)).toBe(operation==='weight'?302:200);
    const rows=await events();expect(rows).toHaveLength(operation==='weight'||operation==='weights'||operation==='reorder'?1:2);
    rows.forEach(row=>{expect(row).toMatchObject({actor_user_id:'9990',actor_roles:'admin',data_class:classification});expect(JSON.parse(String(row.detail))).toMatchObject({operation_id:expect.any(String),classification_policy_version:expect.any(Number)});});
    expect(new Set(rows.map(row=>JSON.parse(String(row.detail)).operation_id)).size).toBe(1);
    for(const secret of ['Private Actor','Private Old','Private Taxonomy','Private Tag','private-slug','private-actor@example.invalid'])expect(JSON.stringify(rows)).not.toContain(secret);
    if(operation==='replace_text')expect((await env.DB.prepare('SELECT * FROM page_versions').all()).results).toHaveLength(2);
  });
  it.each(['abort','ignore','rewrite'])(`rolls back the complete ${operation} transaction when evidence is %s`,async fault=>{
    await setup(operation);const before=await state();const sql=fault==='abort'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END":fault==='ignore'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events BEGIN UPDATE audit_events SET outcome='denied' WHERE event_id=NEW.event_id; END";
    await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run();expect(await call(operation)).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  });
  it.each(['policy','session','role','target','taxonomy','floor'])(`refuses ${operation} if %s changes before its write transaction`,async change=>{
    await setup(operation);if(change==='taxonomy'&&operation!=='add_tag')for(const id of [9991,9992])await env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) SELECT ?,?,9994 WHERE NOT EXISTS (SELECT 1 FROM page_tags WHERE page_id=? AND tag_id=9994)').bind(id,id,id).run();
    const DB=race(async()=>{
      if(change==='policy')return classify();if(change==='session')return env.DB.prepare('DELETE FROM sessions').run();if(change==='role')return env.DB.prepare("UPDATE users SET role='viewer' WHERE id=9990").run();
      if(change==='target')return env.DB.prepare("UPDATE pages SET name='Concurrent' WHERE id=9991").run();if(change==='taxonomy')return env.DB.prepare('UPDATE tags SET taxonomy_slug=NULL WHERE id=9994').run();
      return env.DB.prepare("INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('private-uuid-9991',2)").run();
    });
    expect(await call(operation,{DB})).toBe(503);expect(await events()).toEqual([]);
  });
  it(`retains committed ${operation} receipts after a lost acknowledgment without replaying`,async()=>{
    await setup(operation);expect(await call(operation,{DB:race(async()=>{},true)})).toBe(503);expect(await events()).toHaveLength(operation==='weight'||operation==='weights'||operation==='reorder'?1:2);
  });
}
it('records a complete reorder manifest beyond the indexed target cap',async()=>{
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205) INSERT INTO pages(id,uuid,name,slug,weight,page_type,lect) SELECT n,'uuid-'||n,'Private '||n,'slug-'||n,5,'article','{}' FROM seq").run();
  const response=await api('/admin/pages/reorder',{pageType:'article',page:1,pagesize:2,before:[1,10],after:[10,1]});expect(response.status).toBe(200);
  const row=(await events())[0];expect(row.target_count).toBe(205);expect(JSON.parse(String(row.target_ids))).toHaveLength(200);expect(JSON.parse(String(row.detail)).targets).toHaveLength(205);
});
it('refuses insertion into a reorder sequence after it was planned',async()=>{expect(await call('reorder',{DB:race(()=>env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,weight,page_type,lect) VALUES (9995,'uuid-extra','A','a',5,'article','{}')").run())})).toBe(503);expect(await events()).toEqual([]);});
it('treats unchanged weights and repeated tag actions as no-ops',async()=>{
  expect((await api('/admin/pages/batch-weight',{updates:[{id:9991,weight:5}]})).status).toBe(200);expect(await events()).toEqual([]);
  await call('add_tag');const before=await events();await call('add_tag');expect(await events()).toEqual(before);
});
it('checks the actual number of changed weights and rolls back ignored rows',async()=>{
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON pages WHEN OLD.id=9992 BEGIN SELECT RAISE(IGNORE); END`).run();const before=await state();expect(await call('weights')).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('uses a taxonomy floor for bulk addition and retains it after removal',async()=>{
  await env.DB.prepare("INSERT INTO data_classes(container_kind,container_key,class) VALUES ('taxonomy','clinical','phi')").run();expect(await call('add_tag')).toBe(200);expect((await events()).every(e=>e.data_class==='phi')).toBe(true);await env.DB.prepare('DELETE FROM audit_events').run();expect(await call('remove_tag')).toBe(200);expect((await events()).every(e=>e.data_class==='phi')).toBe(true);
});
it('refuses direct stale or sessionless bulk authority',async()=>{await expect(applyBulkPageAction(env,{...user,sid:undefined},'replace_text',[9991],bulkOptions)).rejects.toThrow();await expect(updateDraftWeights(env,{...user,exp:0},[{id:9991,weight:10}])).rejects.toThrow();expect(await events()).toEqual([]);});
it('keeps all direct local mutations blocked in regulated mode',async()=>{for(const operation of ['add_tag','replace_text'] as const)await expect(applyBulkPageAction({...env,REGULATED_MODE:'true'},user,operation,[9991],bulkOptions)).rejects.toThrow();await expect(updateDraftWeights({...env,REGULATED_MODE:'true'},user,[{id:9991,weight:20}])).rejects.toThrow();expect(await events()).toEqual([]);});

async function job(){return createAdvancedSearchBulkActionJob(env.DB,{action:'replace_text',scope:'selected',ids:[9991,9992],pageTypes:['article'],criteria:[],operator:'and',targetTagIds:[],searchText:'Old',replacementText:'New',returnTo:'/admin',user:{...user,exp:1}});}
it('executes a claimed job using current grants and its durable lease rather than an expired initiating JWT',async()=>{
  const queued=await job();await runCmsAdminJob(env,queued.id);expect(await env.DB.prepare('SELECT status FROM admin_jobs WHERE id=?').bind(queued.id).first()).toEqual({status:'done'});
  const rows=await events();expect(rows).toHaveLength(2);expect(rows.every(r=>r.acting_via===`job:${queued.id}`&&r.request_id===null)).toBe(true);expect(JSON.parse(String(rows[0].detail))).toMatchObject({job_id:queued.id,job_attempt:1});
});
it.each(['status','attempt','body','owner','role'])('refuses a queued slice if its %s changes at the transaction boundary',async field=>{
  const queued=await job();const before=await state();const DB=race(async()=>{if(field==='status')return env.DB.prepare("UPDATE admin_jobs SET status='queued' WHERE id=?").bind(queued.id).run();if(field==='attempt')return env.DB.prepare('UPDATE admin_jobs SET attempts=attempts+1 WHERE id=?').bind(queued.id).run();if(field==='body')return env.DB.prepare("UPDATE admin_jobs SET body='{}' WHERE id=?").bind(queued.id).run();if(field==='owner')return env.DB.prepare("UPDATE admin_jobs SET user_json=json_set(user_json,'$.sub','777') WHERE id=?").bind(queued.id).run();return env.DB.prepare("UPDATE users SET role='viewer' WHERE id=9990").run();});
  await runCmsAdminJob({...env,DB},queued.id);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  const current=await env.DB.prepare('SELECT status,attempts,body,user_json FROM admin_jobs WHERE id=?').bind(queued.id).first<{status:string;attempts:number;body:string;user_json:string}>();
  expect(current?.status).toBe(field==='status'?'queued':field==='role'?'failed':'running');
  if(field==='attempt')expect(current?.attempts).toBe(2);if(field==='body')expect(current?.body).toBe('{}');if(field==='owner')expect(JSON.parse(current!.user_json).sub).toBe('777');
});

it('commits a full hundred-page replacement slice with complete correlated receipts',async()=>{
  await env.DB.prepare('DELETE FROM pages').run();await env.DB.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100) INSERT INTO pages(id,uuid,name,slug,weight,page_type,lect) SELECT n,'uuid-'||n,'Private Old '||n,'slug-'||n,5,'article','{}' FROM seq").run();
  let batchError:unknown;
  const DB={withSession:()=>DB,prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{try{return await env.DB.batch(statements);}catch(error){batchError=error;throw error;}}};
  const result=await applyBulkPageAction({...env,DB:DB as Env['DB']},user,'replace_text',Array.from({length:100},(_,i)=>i+1),bulkOptions).catch(error=>{throw batchError??error;});
  expect(result.updated).toBe(100);
  const rows=await events();expect(rows).toHaveLength(100);rows.forEach((row,index)=>expect(JSON.parse(String(row.detail))).toMatchObject({operation_target_count:100,operation_index:index}));expect(new Set(rows.map(r=>JSON.parse(String(r.detail)).operation_id)).size).toBe(1);expect((await env.DB.prepare('SELECT * FROM page_versions').all()).results).toHaveLength(100);
});
it('retains a committed job slice receipt when the commit acknowledgment is lost',async()=>{
  const queued=await job();await runCmsAdminJob({...env,DB:race(async()=>{},true)},queued.id);expect(await events()).toHaveLength(2);
  expect(await env.DB.prepare('SELECT status FROM admin_jobs WHERE id=?').bind(queued.id).first()).toEqual({status:'failed'});
});
it('retains exact tag identifiers in per-page evidence without copying labels',async()=>{
  expect(await call('add_tag')).toBe(200);const row=(await events())[0];expect(JSON.parse(String(row.detail))).toMatchObject({tags_before:[],tags_after:[9994],tag_count:1});
});
it('gives bulk add_tag links distinct ids above any stored id, not the time/nonce default',async()=>{
  // An id above the whole time+16-bit-nonce range: the legacy column default can
  // never reach it, so only explicit MAX(id)+offset ids land above it.
  const seed=900_000_000_000_000;
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,weight,page_type,lect) VALUES (9995,'private-uuid-9995','Other','other',5,'article','{}')").run();
  await env.DB.prepare("INSERT INTO tags(id,name,slug,taxonomy_slug) VALUES (9996,'Second Tag','second-tag','clinical')").run();
  await env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) VALUES (?,9995,9994)').bind(seed).run();
  await applyBulkPageAction(env,user,'add_tag',[9991,9992],{...bulkOptions,targetTagIds:[9994,9996]});
  const rows=(await env.DB.prepare('SELECT id FROM page_tags WHERE page_id IN (9991,9992) ORDER BY rowid').all<{id:number}>()).results;
  expect(rows.map(r=>r.id)).toEqual([seed+1,seed+2,seed+3,seed+4]);
});
it('preserves legacy duplicate memberships during text-only changes',async()=>{
  await env.DB.prepare('INSERT INTO page_tags(id,page_id,tag_id) VALUES (1,9991,9994),(2,9991,9994)').run();expect(await call('replace_text')).toBe(200);expect((await env.DB.prepare('SELECT * FROM page_tags WHERE page_id=9991').all()).results).toHaveLength(2);
});
it.each(['page','version','tags','policy','floor','second-event'])('rolls back the entire multi-page slice after %s corruption',async failure=>{
  const before=await state();const sql=failure==='page'?"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN UPDATE pages SET lect='altered' WHERE id=9991; END"
    :failure==='version'?"AFTER INSERT ON page_versions BEGIN UPDATE page_versions SET lect='altered' WHERE uuid=NEW.uuid; END"
    :failure==='tags'?"BEFORE INSERT ON page_tags BEGIN SELECT RAISE(IGNORE); END"
    :failure==='policy'?"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN INSERT INTO data_class_floors(container_kind,container_key,level) VALUES ('table','pages',2); END"
    :failure==='floor'?"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('private-uuid-9991',2); END"
    :"BEFORE INSERT ON audit_events WHEN NEW.action='page.update' AND NEW.target_id='9992' BEGIN SELECT RAISE(IGNORE); END";
  await env.DB.prepare(`CREATE TRIGGER ${trigger} ${sql}`).run();expect(await call(failure==='tags'?'add_tag':'replace_text')).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('preserves the weight transaction if a later client retry is a no-op',async()=>{expect(await call('weights')).toBe(200);const before=await events();expect(await call('weights')).toBe(200);expect(await events()).toEqual(before);});
it('refuses oversized and duplicate target manifests before any business write',async()=>{
  const before=await state();await expect(updateDraftWeights(env,user,[{id:9991,weight:10},{id:9991,weight:20}])).rejects.toThrow();await expect(applyBulkPageAction(env,user,'replace_text',Array.from({length:101},()=>9991),bulkOptions)).rejects.toThrow();expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});

it('normalizes unavailable batch persistence without exposing query or body values',async()=>{
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'private diagnostic'); END`).run();
  await expect(applyBulkPageAction(env,user,'replace_text',[9991],bulkOptions)).rejects.toEqual(new ContentBatchEvidenceUnavailableError());expect(await events()).toEqual([]);
});
it('rechecks delegated grants without relying on a stale unchanged actor role',async()=>{
  await env.DB.prepare("INSERT INTO roles(name,label,builtin) VALUES ('writer','Writer',0)").run();await env.DB.prepare("INSERT INTO role_permissions(role,permission) VALUES ('writer','content:write')").run();await env.DB.prepare("UPDATE users SET role='writer' WHERE id=9990").run();user={...user,role:'writer'};
  const before=await state();const DB=race(()=>env.DB.prepare("DELETE FROM role_permissions WHERE role='writer'").run());
  await expect(applyBulkPageAction({...env,DB},user,'replace_text',[9991],bulkOptions)).rejects.toBeInstanceOf(ContentBatchEvidenceUnavailableError);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});

it('reports a weight persistence outage once through coarse monitoring',async()=>{
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();
  const alerts:Array<unknown>=[];const response=await api('/admin/pages/batch-weight',{updates:[{id:9991,weight:20}]},{AUDIT_OUTAGE_MONITORING:'true',AUDIT_MONITOR_SOURCE:'batch-local',AUDIT_MONITOR:{fetch:async(_input:RequestInfo|URL,init?:RequestInit)=>{alerts.push(JSON.parse(String(init?.body)));return new Response(null,{status:200});}} as Fetcher});
  expect(response.status).toBe(503);expect(alerts).toHaveLength(1);expect(JSON.stringify(alerts)).not.toContain('Private');
});

it('allocates durable snapshot ids above existing rows without relying on the legacy nonce',async()=>{
  const marker=Number.MAX_SAFE_INTEGER-10000;await env.DB.prepare("INSERT INTO page_versions(id,page_id,lect,action) VALUES (?,9992,'{}','existing')").bind(marker).run();
  expect((await applyBulkPageAction(env,user,'replace_text',[9991],bulkOptions)).updated).toBe(1);
  const row=await env.DB.prepare('SELECT id FROM page_versions WHERE page_id=9991').first<{id:number}>();expect(row!.id).toBeGreaterThan(marker);expect(Number.isSafeInteger(row!.id)).toBe(true);expect(await events()).toHaveLength(1);
});
it('rolls back content and receipts if snapshot allocation exceeds safe numeric identity',async()=>{
  await env.DB.prepare("INSERT INTO page_versions(id,page_id,lect,action) VALUES (?,9991,'{}','existing')").bind(Number.MAX_SAFE_INTEGER).run();const before=await state();
  expect(await call('replace_text')).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
