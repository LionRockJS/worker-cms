import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { signJWT } from './auth-fixtures';

const id=9981;
const uuid='99810000-0000-4000-8000-000000000001';
const fault='content_mutation_fault';
let cookie=''; let count=0;
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();
  for(const table of ['audit_mutation_outbox','audit_events','data_classes','page_versions','page_tags','pages','tags','taxonomies','sessions','user_oauth_identities','users','roles','role_permissions']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'9980',email:'private-actor@example.invalid',name:'Private Actor',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
  await env.DB.prepare("INSERT INTO pages(id,uuid,name,slug,page_type,lect) VALUES (?,?,'Private Name','private-slug','default',?)").bind(id,uuid,JSON.stringify({private:'old confidential body'})).run();
  await env.DB.prepare("INSERT INTO page_versions(id,page_id,lect,action) VALUES (99811,?,?,'create'),(99812,?,?,'update')").bind(id,'{"private":"first confidential body"}',id,'{"private":"old confidential body"}').run();
  await env.DB.prepare("INSERT INTO taxonomies(id,name,slug) VALUES (9982,'Private taxonomy','private-taxonomy')").run();
  await env.DB.prepare("INSERT INTO tags(id,name,slug,taxonomy_slug) VALUES (9983,'Private tag','private-tag','private-taxonomy')").run();
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();});
const actions={create:'page.create',update:'page.update',restore:'page.restore',remove:'page.version.delete',clear:'page.versions.delete'} as const;
type Operation=keyof typeof actions;
async function call(operation:Operation,overrides:Partial<Env>={}){
  count++; const body=new URLSearchParams({name:'New Private Name',slug:'new-private-slug',page_type:'default',weight:'5',
    'lect__private':'new confidential body',...((operation==='create'||operation==='update')?{tag_ids:'9983'}:{}),
    action:operation==='restore'?'revert:99811':operation==='remove'?'delete-version:99811':operation==='clear'?'delete-versions':'update'});
  const ctx=createExecutionContext();
  const response=await worker.fetch(new Request(`https://cms.example.com/admin/pages${operation==='create'?'':`/${id}`}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.92.${Math.floor(count/250)}.${count%250+1}`},body}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action IN ('page.create','page.update','page.restore','page.version.delete','page.versions.delete') AND outcome='success'").all()).results;}
async function state(){return Promise.all(['pages','page_versions','page_tags'].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));}
async function classify(kind='page_type',key='default',value='phi') {await env.DB.prepare('INSERT INTO data_classes(container_kind,container_key,class) VALUES (?,?,?)').bind(kind,key,value).run();}
/** Inject only at the business batch, after all evidence/authority snapshots. */
function race(change:()=>Promise<unknown>, uncertain=false):Env['DB']{
  const tracked=new WeakMap<D1PreparedStatement,{sql:string;actual:D1PreparedStatement}>(); let changed=false;
  const track=(actual:D1PreparedStatement,sql:string):D1PreparedStatement=>{const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{sql,actual});return proxy;};
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let injected=false;if(!changed&&statements.some(s=>/^(INSERT INTO pages |UPDATE pages SET|DELETE FROM page_versions)/.test(tracked.get(s)?.sql??''))){changed=true;injected=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(injected&&uncertain)throw new Error('Lost commit acknowledgment');return result;}};
  return DB as Env['DB'];
}
for(const operation of Object.keys(actions) as Operation[]){
  it.each(['none','pii','phi'])(`commits ${operation} and exact %s evidence together`,async dataClass=>{
    if(dataClass!=='none')await classify('page_type','default',dataClass);
    expect((await call(operation)).status).toBe(302);
    const rows=await events();expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({action:actions[operation],data_class:dataClass,actor_user_id:'9980',actor_roles:'admin',target_type:'page'});
    const detail=JSON.parse(String(rows[0].detail));expect(detail.classification_policy_version).toEqual(expect.any(Number));
    for(const secret of ['Private Name','Private Actor','Private tag','private-slug','confidential body','private-actor@example.invalid'])expect(JSON.stringify(rows)).not.toContain(secret);
    if(operation==='create'||operation==='update'||operation==='restore'){
      const saved=await env.DB.prepare('SELECT id,lect FROM pages WHERE uuid=?').bind(rows[0].target_id).first<{id:number;lect:string}>();expect(saved).not.toBeNull();
      expect(await env.DB.prepare('SELECT lect FROM page_versions WHERE uuid=? AND page_id=?').bind(detail.version_uuid,saved!.id).first()).toEqual({lect:saved!.lect});
    } else expect(detail.removed_version_ids).toEqual(operation==='clear'?[99811,99812]:[99811]);
  });
  it.each(['abort','ignore','rewrite'])(`rolls back ${operation} if its audit row is %s`,async failure=>{
    const before=await state();const sql=failure==='abort'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events BEGIN UPDATE audit_events SET outcome='denied' WHERE event_id=NEW.event_id; END";
    await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();
    const response=await call(operation);expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toContain('no-store');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
  });
  it.each(['policy','session','target','grant'])(`refuses stale ${operation} after a concurrent %s change`,async change=>{
    const DB=race(async()=>{
      if(change==='policy')return classify();
      if(change==='session')return env.DB.prepare('DELETE FROM sessions').run();
      if(change==='grant')return env.DB.prepare("UPDATE users SET role='viewer' WHERE id=9980").run();
      return env.DB.prepare("UPDATE pages SET name='Concurrent Name' WHERE id=?").bind(id).run();
    });
    // Creating another page is independent of edits to this existing target.
    expect((await call(operation,{DB})).status).toBe(change==='target'&&operation==='create'?302:503);
    expect(await events()).toHaveLength(change==='target'&&operation==='create'?1:0);
  });
}
it('inherits PHI from newly selected taxonomy tags',async()=>{await classify('taxonomy','private-taxonomy');expect((await call('update')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');});
it('retains the prior PHI floor when tags or page type are removed',async()=>{
  await classify('taxonomy','private-taxonomy');await env.DB.prepare('INSERT INTO page_tags(page_id,tag_id) VALUES (?,9983)').bind(id).run();
  await env.DB.prepare('DELETE FROM page_tags WHERE page_id=?').bind(id).run();expect((await call('remove')).status).toBe(302);expect((await events())[0].data_class).toBe('phi');
});
it('rejects a taxonomy move between classification and the write',async()=>{const DB=race(()=>env.DB.prepare("UPDATE tags SET taxonomy_slug=NULL WHERE id=9983").run());expect((await call('update',{DB})).status).toBe(503);expect(await events()).toEqual([]);});
it('refuses missing selected tags without partial page/history changes',async()=>{const before=await state();const DB=race(()=>env.DB.prepare('DELETE FROM tags WHERE id=9983').run());expect((await call('create',{DB})).status).toBe(503);expect(await state()).toEqual(before);});
it('does not invent history-deletion events for an already empty history',async()=>{await env.DB.prepare('DELETE FROM page_versions').run();expect((await call('clear')).status).toBe(302);expect(await events()).toEqual([]);});
it('keeps regulated content writes contained',async()=>{expect((await call('update',{REGULATED_MODE:'true'})).status).toBe(503);expect(await events()).toEqual([]);});

it.each(['version-ignore','version-rewrite','tag-ignore','page-rewrite','policy-rewrite','floor-upgrade'])('rolls back the full save after %s',async failure=>{
  const before=await state();
  const sql=failure==='version-ignore'?"BEFORE INSERT ON page_versions BEGIN SELECT RAISE(IGNORE); END"
    :failure==='version-rewrite'?"AFTER INSERT ON page_versions BEGIN UPDATE page_versions SET lect='altered' WHERE uuid=NEW.uuid; END"
    :failure==='tag-ignore'?"BEFORE INSERT ON page_tags BEGIN SELECT RAISE(IGNORE); END"
    :failure==='page-rewrite'?"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN UPDATE pages SET name='altered' WHERE id=9981; END"
    :failure==='policy-rewrite'?"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN INSERT INTO data_class_floors(container_kind,container_key,level) VALUES ('table','pages',2); END"
    :"AFTER INSERT ON audit_events WHEN NEW.action='page.update' BEGIN INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('99810000-0000-4000-8000-000000000001',2); END";
  await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();
  expect((await call('update')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it.each(['create','update','clear'] as Operation[])('does not replay %s after a lost commit acknowledgment',async operation=>{
  expect((await call(operation,{DB:race(async()=>{},true)})).status).toBe(503);
  expect(await events()).toHaveLength(1);
  const rows=await state();expect(operation==='create'?rows[0].length:operation==='clear'?rows[1].length:rows[1].length).toBe(operation==='create'?2:operation==='clear'?0:3);
});
it('refuses a changed UUID sensitivity floor at batch admission',async()=>{const before=await state();expect((await call('update',{DB:race(()=>env.DB.prepare('INSERT INTO page_sensitivity_floors(uuid,level) VALUES (?,2)').bind(uuid).run())})).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses stale history or tag memberships at batch admission',async()=>{expect((await call('clear',{DB:race(()=>env.DB.prepare("INSERT INTO page_versions(page_id,lect,action) VALUES (?,'concurrent','update')").bind(id).run())})).status).toBe(503);expect(await events()).toEqual([]);});
it('refuses malformed classification without changing content',async()=>{await classify('table','pages','invalid');const before=await state();expect((await call('update')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});

it('rolls back history removal if its receipt trigger changes UUID sensitivity',async()=>{
  const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON audit_events WHEN NEW.action='page.versions.delete' BEGIN INSERT INTO page_sensitivity_floors(uuid,level) VALUES ('99810000-0000-4000-8000-000000000001',2); END`).run();
  expect((await call('clear')).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
