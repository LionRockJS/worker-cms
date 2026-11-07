import { env } from 'cloudflare:workers';
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it } from 'vitest';
import { Hono } from 'hono';
import { verifyJWT } from '../src/core/auth/jwt';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { HOST_SETTINGS_KEYS,prepareHostSettingsMutation } from '../src/core/db/settings-mutation-evidence';
import { APP_BRANDING_SETTING_KEY,SYSTEM_TIMEZONE_SETTING_KEY,SHOW_CREDITS_SETTING_KEY,SIDEBAR_MENU_SETTING_KEY,sidebarChromeSettingsFromRaw } from '../src/core/db/settings';
import type { Env,Variables } from '../src/types';

let cookie='',counter=0;
const fault='host_settings_fault';
beforeEach(async()=>{
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();
  for(const table of ['settings','audit_events','data_classes','sessions','user_oauth_identities','users','roles','role_permissions'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie=`access_token=${await signJWT({sub:'14000',name:'Private Actor',email:'private@example.invalid',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
});
afterEach(async()=>{await env.DB.prepare(`DROP TRIGGER IF EXISTS ${fault}`).run();});
function form(alternate=false){return {app_name:alternate?'Other Private Name':'Private Name',app_icon:'beaker',primary_color:alternate?'#abc':'#def',app_font:'mono',admin_home_path:alternate?'/admin?token=other-private-query':'/admin?token=private-query',system_timezone:alternate?'+0900':'+0800',show_credits:alternate?'false':'true',visible_items:'pages',weight_pages:alternate?'21':'17',sidebar_label_pages_en:alternate?'Other Private Label':'Private Label'};}
async function call(fields:Record<string,string>=form(),overrides:Partial<Env>={},path='/admin/settings/system'){
  const ctx=createExecutionContext();counter++;
  const response=await worker.fetch(new Request(`https://cms.example.com${path}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.98.${Math.floor(counter/250)}.${counter%250+1}`},body:new URLSearchParams(fields)}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined,...overrides},ctx);
  await waitOnExecutionContext(ctx);return response;
}
async function events(){return(await env.DB.prepare("SELECT * FROM audit_events WHERE action='settings.system.update' ORDER BY seq").all()).results;}
async function state(){return(await env.DB.prepare('SELECT * FROM settings ORDER BY key').all()).results;}
async function classify(value='phi'){await env.DB.prepare("INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','settings',?)").bind(value).run();}
function race(change:()=>Promise<unknown>,uncertain=false):Env['DB']{
  let changed=false;const tracked=new WeakMap<D1PreparedStatement,{actual:D1PreparedStatement;sql:string}>();
  function track(actual:D1PreparedStatement,sql:string):D1PreparedStatement {const proxy=new Proxy(actual,{get(target,key){if(key==='bind')return(...args:unknown[])=>track(actual.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});tracked.set(proxy,{actual,sql});return proxy;}
  const DB={withSession:()=>DB,prepare:(sql:string)=>track(env.DB.prepare(sql),sql),batch:async(statements:D1PreparedStatement[])=>{let injected=false;if(!changed&&statements.some(s=>tracked.get(s)?.sql.includes('(SELECT COUNT(*) FROM settings WHERE key IN'))){changed=true;injected=true;await change();}const result=await env.DB.batch(statements.map(s=>tracked.get(s)?.actual??s));if(injected&&uncertain)throw new Error('Synthetic lost acknowledgment');return result;}};return DB as Env['DB'];
}
it.each(['none','pii','phi'])('commits all host preferences with exact private %s evidence',async dataClass=>{
  if(dataClass!=='none')await classify(dataClass);const response=await call();expect(response.status).toBe(302);expect(response.headers.get('Location')).toBe('/admin/settings/system?flash=saved');
  const rows=await events();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({actor_user_id:'14000',actor_roles:'admin',target_type:'settings',target_id:'admin.system',target_count:5,outcome:'success',data_class:dataClass,event_class:'admin',retention_class:'admin_config'});expect(rows[0].source_ip).toMatch(/^10\.98\./);
  expect(JSON.parse(String(rows[0].target_ids)).sort()).toEqual([...HOST_SETTINGS_KEYS].sort());const detail=JSON.parse(String(rows[0].detail));expect(detail).toMatchObject({operation_id:expect.any(String),classification_policy_version:expect.any(Number)});expect(detail.changes).toHaveLength(5);expect(detail.changes.every((c:{operation:string})=>c.operation==='create')).toBe(true);
  const stored=await state();expect(stored.filter(r=>HOST_SETTINGS_KEYS.includes(r.key as typeof HOST_SETTINGS_KEYS[number]))).toHaveLength(5);expect(await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SYSTEM_TIMEZONE_SETTING_KEY).first()).toEqual({value:'+0800'});
  for(const secret of ['Private','private@example','private-query','/admin?','+0800','#ddeeff'])expect(JSON.stringify(rows)).not.toContain(secret);
});
it.each(['abort','ignore','rewrite'])('rolls back every host preference when the receipt is %s',async failure=>{
  const before=await state();const sql=failure==='abort'?"BEFORE INSERT ON audit_events WHEN NEW.action='settings.system.update' BEGIN SELECT RAISE(ABORT,'synthetic'); END":failure==='ignore'?"BEFORE INSERT ON audit_events WHEN NEW.action='settings.system.update' BEGIN SELECT RAISE(IGNORE); END":"AFTER INSERT ON audit_events WHEN NEW.action='settings.system.update' BEGIN UPDATE audit_events SET target_count=99 WHERE event_id=NEW.event_id; END";
  await env.DB.prepare(`CREATE TRIGGER ${fault} ${sql}`).run();const response=await call();expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
for(const key of HOST_SETTINGS_KEYS){
  it(`rolls back all preferences when inserting ${key} is ignored`,async()=>{const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON settings WHEN NEW.key='${key}' BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
  it(`rolls back all preferences when updating ${key} is ignored`,async()=>{expect((await call()).status).toBe(302);await env.DB.prepare('DELETE FROM audit_events').run();const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE UPDATE ON settings WHEN NEW.key='${key}' BEGIN SELECT RAISE(IGNORE); END`).run();expect((await call(form(true))).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
}
it.each(['policy','policyRestore','session','role','grants','value','timestamp','creation','missing','new-key'])('refuses concurrent %s changes without partial settings',async change=>{
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(APP_BRANDING_SETTING_KEY,'{"appName":"Existing"}').run();let concurrent:Awaited<ReturnType<typeof state>>;
  const DB=race(async()=>{if(change==='policy'||change==='policyRestore'){await classify();if(change==='policyRestore')await env.DB.prepare('DELETE FROM data_classes').run();}
    else if(change==='session')await env.DB.prepare('DELETE FROM sessions').run();else if(change==='role')await env.DB.prepare("UPDATE users SET role='viewer' WHERE id=14000").run();else if(change==='grants')await env.DB.prepare("INSERT INTO role_permissions(role,permission) VALUES ('editor','content:write')").run();
    else if(change==='value')await env.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind('{"appName":"Concurrent"}',APP_BRANDING_SETTING_KEY).run();
    else if(change==='timestamp')await env.DB.prepare("UPDATE settings SET updated_at='2000-01-01' WHERE key=?").bind(APP_BRANDING_SETTING_KEY).run();
    else if(change==='creation')await env.DB.prepare("UPDATE settings SET created_at='2000-01-01' WHERE key=?").bind(APP_BRANDING_SETTING_KEY).run();
    else if(change==='missing')await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(APP_BRANDING_SETTING_KEY).run();
    else await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(SHOW_CREDITS_SETTING_KEY,'false').run();concurrent=await state();});
  expect((await call(form(),{DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);
});
it.each(['value','timestamp','creation','session','policy'])('refuses unexpected %s changes from business triggers',async failure=>{
  const before=await state();const body=failure==='value'?"UPDATE settings SET value='rewritten' WHERE key=NEW.key;":failure==='timestamp'?"UPDATE settings SET updated_at='2000-01-01' WHERE key=NEW.key;":failure==='creation'?"UPDATE settings SET created_at='2000-01-01' WHERE key=NEW.key;":failure==='session'?"DELETE FROM sessions;":"INSERT INTO data_classes(container_kind,container_key,class) VALUES ('table','settings','phi');";
  await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON settings WHEN NEW.key='${SIDEBAR_MENU_SETTING_KEY}' BEGIN ${body} END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('retains unchanged timestamps and emits no mutation event for a no-op save',async()=>{expect((await call()).status).toBe(302);await env.DB.prepare('DELETE FROM audit_events').run();const before=await state();expect((await call()).status).toBe(302);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('records only the actually changed key with prior-existence metadata',async()=>{expect((await call()).status).toBe(302);await env.DB.prepare('DELETE FROM audit_events').run();expect((await call({...form(),app_name:'Another Name'})).status).toBe(302);const row=(await events())[0];expect(row.target_count).toBe(1);expect(JSON.parse(String(row.detail)).changes).toEqual([{key:APP_BRANDING_SETTING_KEY,operation:'update'}]);});
it('preserves omitted timezone, credit visibility and unsubmitted labels from the same snapshot',async()=>{
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?),(?,?),(?,?)').bind(SYSTEM_TIMEZONE_SETTING_KEY,'+0930',SHOW_CREDITS_SETTING_KEY,'false',SIDEBAR_MENU_SETTING_KEY,JSON.stringify({labels:{pages:{en:'Private Saved Label','fr':'French Private Label'},hiddenFeature:{en:'Unsubmitted'}}})).run();
  const fields=form();delete (fields as Partial<typeof fields>).system_timezone;delete (fields as Partial<typeof fields>).show_credits;delete (fields as Partial<typeof fields>).sidebar_label_pages_en;
  expect((await call(fields)).status).toBe(302);expect(await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SYSTEM_TIMEZONE_SETTING_KEY).first()).toEqual({value:'+0930'});expect(await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SHOW_CREDITS_SETTING_KEY).first()).toEqual({value:'false'});const sidebar=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SIDEBAR_MENU_SETTING_KEY).first<{value:string}>();expect(sidebarChromeSettingsFromRaw(sidebar!.value).labels).toEqual({pages:{en:'Private Saved Label',fr:'French Private Label'},hiddenFeature:{en:'Unsubmitted'}});
});
it('does not create an omitted credit preference for older forms',async()=>{const fields=form();delete (fields as Partial<typeof fields>).show_credits;expect((await call(fields)).status).toBe(302);expect(await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(SHOW_CREDITS_SETTING_KEY).first()).toBeNull();expect((await events())[0].target_count).toBe(4);});
it('retains existing creation timestamps when updating preferences',async()=>{await call();await env.DB.prepare("UPDATE settings SET created_at='2000-01-01' WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(HOST_SETTINGS_KEYS)).run();await env.DB.prepare('DELETE FROM audit_events').run();expect((await call(form(true))).status).toBe(302);for(const row of(await state()).filter(r=>HOST_SETTINGS_KEYS.includes(r.key as typeof HOST_SETTINGS_KEYS[number])))expect(row.created_at).toBe('2000-01-01');});
it('does not include or mutate unrelated secret settings',async()=>{await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('plugin.secret.private-key','private-secret-value')").run();expect((await call()).status).toBe(302);expect(await env.DB.prepare("SELECT value FROM settings WHERE key='plugin.secret.private-key'").first()).toEqual({value:'private-secret-value'});expect(JSON.stringify(await events())).not.toContain('private-key');expect(JSON.stringify(await events())).not.toContain('private-secret-value');});
it('retains invalid-timezone refusal without mutation',async()=>{const before=await state();const response=await call({...form(),system_timezone:'bad-timezone'});expect(response.status).toBe(303);expect(response.headers.get('Location')).toBe('/admin/settings/system?error=invalid-timezone');expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('keeps the legacy menu POST as a redirect without a mutation event',async()=>{expect((await call(undefined,undefined,'/admin/settings/menu')).status).toBe(303);expect(await events()).toEqual([]);});
it('keeps settings unavailable in regulated mode',async()=>{const before=await state();expect((await call(form(),{REGULATED_MODE:'true'})).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses malformed classification',async()=>{await classify('invalid');const before=await state();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('retains the exact receipt and full settings after a lost commit acknowledgment',async()=>{const response=await call(form(),{DB:race(async()=>{},true)});expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await events()).toHaveLength(1);expect((await state()).filter(r=>HOST_SETTINGS_KEYS.includes(r.key as typeof HOST_SETTINGS_KEYS[number]))).toHaveLength(5);});
it('withholds writes when protected settings read evidence cannot be written',async()=>{await classify();const before=await state();await env.DB.prepare(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_events WHEN NEW.action='settings.mutation-read' BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('refuses oversized stored settings before planning a write',async()=>{await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(SIDEBAR_MENU_SETTING_KEY,'x'.repeat(1_000_001)).run();const before=await state();expect((await call()).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it('retains current menu-management permission enforcement',async()=>{cookie=`access_token=${await signJWT({sub:'14001',name:'Editor',email:'editor@example.invalid',role:'editor',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;const before=await state();expect((await call()).status).toBe(403);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});

it('refuses a stale no-op snapshot without reporting another change',async()=>{await call();await env.DB.prepare('DELETE FROM audit_events').run();let concurrent:Awaited<ReturnType<typeof state>>;const DB=race(async()=>{await env.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind('{"appName":"Concurrent"}',APP_BRANDING_SETTING_KEY).run();concurrent=await state();});expect((await call(form(),{DB})).status).toBe(503);expect(await state()).toEqual(concurrent!);expect(await events()).toEqual([]);});
it('preserves an omitted credit preference even if a business trigger tries to rewrite it',async()=>{await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(SHOW_CREDITS_SETTING_KEY,'false').run();const before=await state();const fields=form();delete (fields as Partial<typeof fields>).show_credits;await env.DB.prepare(`CREATE TRIGGER ${fault} AFTER INSERT ON settings WHEN NEW.key='${SIDEBAR_MENU_SETTING_KEY}' BEGIN UPDATE settings SET value='true' WHERE key='${SHOW_CREDITS_SETTING_KEY}'; END`).run();expect((await call(fields)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);});
it.each(['outside-scope','duplicate','oversized'])('refuses %s writes through the core host-settings contract',async failure=>{
  const app=new Hono<{Bindings:Env;Variables:Variables}>();app.onError(()=>new Response('unavailable',{status:503}));
  app.post('/',async c=>{c.set('user',(await verifyJWT(cookie.slice('access_token='.length),env.JWT_SECRET))!);const mutation=await prepareHostSettingsMutation(c);const writes=failure==='outside-scope'?[{key:'plugin.secret.private-key' as typeof APP_BRANDING_SETTING_KEY,value:'private-secret-value'}]:failure==='duplicate'?[{key:APP_BRANDING_SETTING_KEY,value:'first'},{key:APP_BRANDING_SETTING_KEY,value:'second'}]:[{key:APP_BRANDING_SETTING_KEY,value:'x'.repeat(1_000_001)}];await mutation.commit(writes);return c.text('saved');});
  const before=await state();expect((await app.request('https://settings.local/',{method:'POST'},env)).status).toBe(503);expect(await state()).toEqual(before);expect(await events()).toEqual([]);
});
it('accepts valid transaction-time timestamps after a delayed admission',async()=>{const DB=race(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});expect((await call(form(),{DB})).status).toBe(302);expect(await events()).toHaveLength(1);});
