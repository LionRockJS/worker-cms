import type { AppContext } from '../../core/http/context';
import { captureAccessAuthorization } from '../../core/auth/access-authorization';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { clearManifestCache } from './registry';
import { generatePluginSecret,type PluginInput } from './store';
import type { PluginRecord,PluginIdentityApproval } from './types';

export const REGISTRY=['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
export const IDENTITY=['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const MUTABLE=['label','url','enabled','config','sort_order','secret'] as const;
export const OWNED=[
  {table:'plugin_asset_approvals',fields:['id','plugin_id','path','integrity','approved_by','created_at','updated_at']},
  {table:'plugin_page_type_approvals',fields:['id','plugin_id','page_type','access','approved_by','created_at','updated_at']},
  {table:'plugin_file_prefix_approvals',fields:['id','plugin_id','prefix','approved_by','created_at','updated_at']},
  {table:'plugin_state',fields:['plugin_id','key','value','created_at','updated_at']},
];
export type Row=Record<string,string|number|null>;
export class PluginRegistrationUnavailableError extends Error {constructor(){super('Plugin registration change unavailable');}}
export class PluginRegistrationConflictError extends Error {constructor(){super('A plugin with that URL is already registered.');}}
export function json(value:unknown):string {const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>1_000_000)throw new Error('Plugin manifest requires review');return text;}
export async function fingerprint(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function snapshot<T>(c:AppContext,table:string,fields:string[],where='1',args:Array<string|number|null>=[]):Promise<T[]> {
  const object=`json_object(${fields.map(f=>`'${f}',r.${f}`).join(',')})`;
  const result=await c.env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY ${fields[0]} LIMIT 5001),
    budget AS (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END snapshot FROM budget`).bind(...args).first<{snapshot:string}>();
  if(!result)throw new Error('Plugin snapshot unavailable');const rows=JSON.parse(result.snapshot) as T[];
  if(fields.includes('id')&&(rows as Row[]).some(r=>!Number.isSafeInteger(r.id)||Number(r.id)<=0))throw new Error('Unsafe plugin identity');return rows;
}
export function guard(c:AppContext,table:string,fields:string[],rows:object[],where='1',args:Array<string|number|null>=[]) {
  return abortIf(c.env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} r WHERE ${fields.map(f=>`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...args,rows.length,json(rows)]);
}
export function invalidate(){clearManifestCache();clearConfigCache();}
async function unavailable(c:AppContext):Promise<never> {invalidate();await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new PluginRegistrationUnavailableError();}
/** Local host registration only. Remote enrollment/tenant configuration and
 * approval/TOFU writers retain separate identity and outcome contracts. */
export async function preparePluginRegistrationMutation(c:AppContext){
  assertRegulatedWritesAllowed(c.env);
  try{return await prepare(c);}catch{return unavailable(c);}
}
export async function capturePluginMutationContext(c:AppContext){
  const authority=await captureAccessAuthorization(c.env,c.get('user'),'plugin:manage');if(!authority.allowed)throw new Error('Plugin authority unavailable');
  const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('Plugin classification unavailable');
  const [plugins,identities]=await Promise.all([snapshot<PluginRecord>(c,'plugins',REGISTRY),snapshot<PluginIdentityApproval>(c,'plugin_identity_approvals',IDENTITY)]);
  const baseClasses=['plugins','plugin_identity_approvals'].map(t=>classFor(policy,'table',t));for(const pin of identities)baseClasses.push(classFor(policy,'plugin',pin.manifest_id));
  const dataClass=(tables:string[]=[])=>{const classes=[...baseClasses,...tables.map(t=>classFor(policy,'table',t))];return classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;};
  const initialClass=dataClass();
  await auditBackgroundReads(c.env,[{action:'plugin.registration-read',kind:'table' as const,key:'plugins',targetType:'plugin',ids:plugins.map(r=>String(r.id)),count:plugins.length},
    {action:'plugin.registration-identity-read',kind:'table' as const,key:'plugin_identity_approvals',targetType:'plugin_identity',ids:identities.map(r=>String(r.plugin_row_id)),count:identities.length}].map(read=>({...read,minimumClass:initialClass==='none'?undefined:initialClass})),contextActor(c));
  const admission=()=>[authority.guard(),classificationPolicyGuard(c.env,policy),guard(c,'plugins',REGISTRY,plugins),guard(c,'plugin_identity_approvals',IDENTITY,identities)];
  const finish=()=>[authority.guard(),classificationPolicyGuard(c.env,policy)];
  async function run<T>(work:()=>Promise<T>):Promise<T>{assertRegulatedWritesAllowed(c.env);try{if(await flushReadAudit(c))throw new Error('Plugin read evidence unavailable');const result=await work();invalidate();return result;}catch(error){if(error instanceof PluginRegistrationConflictError)throw error;return unavailable(c);}}
  return {plugins,identities,policy,dataClass,admission,finish,run};
}
async function prepare(c:AppContext){
  const {plugins,identities,policy,dataClass,admission,finish,run}=await capturePluginMutationContext(c);
  const row=(id:number)=>{if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid plugin identity');return plugins.find(p=>p.id===id);};
  async function save(action:'plugin.create'|'plugin.update'|'plugin.toggle'|'plugin.rotate_secret',input:PluginInput|undefined,id?:number):Promise<PluginRecord>{return run(async()=>{
    const before=id===undefined?undefined:row(id);if(id!==undefined&&!before)throw new Error('Plugin disappeared');
    if(input&&plugins.some(p=>p.url===input.url&&p.id!==id))throw new PluginRegistrationConflictError();
    const clock=await c.env.DB.prepare(`SELECT CURRENT_TIMESTAMP now,MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 next_id FROM plugins`).first<{now:string;next_id:number}>();
    if(!clock||(!before&&(!Number.isSafeInteger(clock.next_id)||clock.next_id<=0)))throw new Error('Unsafe plugin identity');
    const next:PluginRecord=before?{...before}:{id:clock.next_id,uuid:crypto.randomUUID(),created_at:clock.now,updated_at:clock.now,label:'',url:'',enabled:0,config:null,sort_order:0,secret:generatePluginSecret()};
    if(input){next.label=input.label;next.url=input.url;next.enabled=input.enabled?1:0;next.config=input.config??null;next.sort_order=input.sort_order??0;if(next.config!==null)JSON.parse(next.config);
      if(before&&before.url!==next.url)next.config=JSON.stringify({...JSON.parse(next.config||'{}'),cmsTrustedUi:false});}
    if(action==='plugin.toggle')next.enabled=before!.enabled?0:1;
    if(action==='plugin.rotate_secret')next.secret=generatePluginSecret();
    if(!next.url||!Number.isFinite(next.sort_order))throw new Error('Invalid plugin configuration');json(next);
    const changed=MUTABLE.filter(f=>!before||before[f]!==next[f]);if(!changed.length){await c.env.DB.batch(admission());return next;}
    const expected=before?plugins.map(p=>p.id===id?next:p):[...plugins,next];if(expected.length>5000)throw new Error('Plugin catalogue requires review');json(expected);
    const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action,entityType:'plugin',entityId:next.uuid,detail:{operation_id:crypto.randomUUID(),id:next.id,fields:changed,
      ...(changed.includes('enabled')?{enabled_before:before?!!before.enabled:null,enabled_after:!!next.enabled}:{})}},dataClass(),policy,{context:c});
    const columns=action==='plugin.toggle'?['enabled'] as const:action==='plugin.rotate_secret'?['secret'] as const:['label','url','enabled','config','sort_order'] as const;
    const business=before?c.env.DB.prepare(`UPDATE plugins SET ${columns.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...columns.map(f=>next[f]),id!):c.env.DB.prepare(`INSERT INTO plugins(id,uuid,${MUTABLE.join(',')}) VALUES (?,?,${MUTABLE.map(()=>'?').join(',')})`).bind(next.id,next.uuid,...MUTABLE.map(f=>next[f]));
    const results=await c.env.DB.batch([...admission(),business,abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
      guard(c,'plugins',REGISTRY.filter(f=>f!=='created_at'&&f!=='updated_at'),expected),guard(c,'plugins',REGISTRY,plugins.filter(p=>p.id!==id),'id<>?',[next.id]),
      abortIf(c.env,`NOT EXISTS (SELECT 1 FROM plugins WHERE id=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${before?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[next.id,clock.now,before?.created_at??clock.now]),guard(c,'plugin_identity_approvals',IDENTITY,identities),...finish(),c.env.DB.prepare(`SELECT ${REGISTRY.join(',')} FROM plugins WHERE uuid=?`).bind(next.uuid)]);
    const saved=results.at(-1)?.results[0] as PluginRecord|undefined;if(!saved)throw new Error('Plugin result unavailable');return saved;
  });}
  return {
    row(id:number){const plugin=row(id);return plugin?{...plugin}:undefined;},
    create(input:PluginInput){return save('plugin.create',input);},
    update(id:number,input:PluginInput){return save('plugin.update',input,id);},
    toggle(id:number){return save('plugin.toggle',undefined,id);},
    rotate(id:number){return save('plugin.rotate_secret',undefined,id);},
    remove(id:number):Promise<void>{return run(async()=>{
      const before=row(id);if(!before){await c.env.DB.batch(admission());return;}
      const pin=identities.find(p=>p.plugin_row_id===id);if(pin&&!/^[a-z][a-z0-9-]{0,63}$/.test(pin.manifest_id))throw new Error('Unsafe plugin identity pin');
      const owned=pin?await Promise.all(OWNED.map(async spec=>({...spec,rows:await snapshot<Row>(c,spec.table,spec.fields,'plugin_id=?',[pin.manifest_id])}))):[];
      const classification=dataClass(owned.map(s=>s.table));const state=owned.find(s=>s.table==='plugin_state');
      const stateIds=await Promise.all((state?.rows??[]).map(async r=>await fingerprint(String(r.key))));
      await auditBackgroundReads(c.env,owned.map(spec=>({action:'plugin.unregister-read',kind:'table' as const,key:spec.table,targetType:spec.table,
        ids:spec.table==='plugin_state'?stateIds:spec.rows.map(r=>String(r.id)),count:spec.rows.length,minimumClass:classification==='none'?undefined:classification})),contextActor(c));
      if(await flushReadAudit(c))throw new Error('Plugin cleanup read evidence unavailable');
      const detail={operation_id:crypto.randomUUID(),id,fields:['registry',...(pin?['identity','approvals','state']:[])],cleanup:pin?'pinned_identity':'no_pinned_identity',
        ...(pin?{identity_fingerprint:await fingerprint(pin.manifest_id)}:{}),removed:owned.map(spec=>({table:spec.table,count:spec.rows.length,ids:spec.table==='plugin_state'?stateIds:spec.rows.map(r=>r.id)})),retained_sequences:true,retained_limit_pricing_settings:true};json(detail);
      const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action:'plugin.delete',entityType:'plugin',entityId:before.uuid,detail},classification,policy,{context:c});
      const statements=[...admission(),...owned.map(spec=>guard(c,spec.table,spec.fields,spec.rows,'plugin_id=?',[pin!.manifest_id]))];
      for(const spec of owned)statements.push(c.env.DB.prepare(`DELETE FROM ${spec.table} WHERE plugin_id=?`).bind(pin!.manifest_id),abortIf(c.env,'changes()<>?',[spec.rows.length]));
      statements.push(c.env.DB.prepare('DELETE FROM plugin_identity_approvals WHERE plugin_row_id=?').bind(id),abortIf(c.env,'changes()<>?',[pin?1:0]),
        c.env.DB.prepare('DELETE FROM plugins WHERE id=?').bind(id),abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
        guard(c,'plugins',REGISTRY,plugins.filter(p=>p.id!==id)),guard(c,'plugin_identity_approvals',IDENTITY,identities.filter(p=>p.plugin_row_id!==id)),
        ...owned.map(spec=>guard(c,spec.table,spec.fields,[],'plugin_id=?',[pin!.manifest_id])),...finish());
      await c.env.DB.batch(statements);
    });},
  };
}
