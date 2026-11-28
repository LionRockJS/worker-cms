import { json,fingerprint,snapshot,guard,resultGuard,type Row } from '../../core/db/bounded-mutation';
import { beginAuditedMutation, type MutationPlan, type PlannedWrite } from '../../core/evidence/audited-mutation';
import type { AppContext } from '../../core/http/context';
import { classFor,classificationPolicyGuard,strongestClass,type ContainerKind } from '../../core/db/data-classes';
import { captureMutationAuthority } from '../../core/evidence/mutation-authority';
import { contextActor } from '../../core/db/audit';
import { nextIdSql } from '../../core/pages/snapshot-id';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { clearManifestCache } from './registry';
import { generatePluginSecret,type PluginInput } from './store';
import type { PluginRecord,PluginIdentityApproval } from './types';
import { REGISTRY,IDENTITY } from './evidence-common';

const MUTABLE=['label','url','enabled','config','sort_order','secret'] as const;
export const APPROVAL_TABLES=[
  {table:'plugin_asset_approvals',fields:['id','plugin_id','path','integrity','approved_by','created_at','updated_at']},
  {table:'plugin_page_type_approvals',fields:['id','plugin_id','page_type','access','approved_by','created_at','updated_at']},
  {table:'plugin_file_prefix_approvals',fields:['id','plugin_id','prefix','approved_by','created_at','updated_at']},
  {table:'plugin_capability_approvals',fields:['id','plugin_id','capability','approved_by','created_at','updated_at']},
];
export const STATE_TABLE={table:'plugin_state',fields:['plugin_id','key','value','created_at','updated_at']};
const OWNED=[...APPROVAL_TABLES, STATE_TABLE];

export class PluginRegistrationUnavailableError extends Error {constructor(){super('Plugin registration change unavailable');}}
export class PluginRegistrationConflictError extends Error {constructor(){super('A plugin with that URL is already registered.');}}
export function invalidate(){clearManifestCache();clearConfigCache();}
async function unavailable(c:AppContext):Promise<never> {invalidate();await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new PluginRegistrationUnavailableError();}
/** Local host registration only. Remote enrollment/tenant configuration and
 * approval/TOFU writers retain separate identity and outcome contracts. */
export async function preparePluginRegistrationMutation(c:AppContext){
  assertRegulatedWritesAllowed(c.env);
  try{return await prepare(c);}catch(error){invalidate();throw error;}
}
export async function capturePluginMutationContext(c:AppContext){
  const { authority, policy } = await captureMutationAuthority(c, 'plugin:manage');
  const [plugins,identities]=await Promise.all([snapshot<PluginRecord>(c,'plugins',REGISTRY),snapshot<PluginIdentityApproval>(c,'plugin_identity_approvals',IDENTITY)]);
  const baseClasses=['plugins','plugin_identity_approvals'].map(t=>classFor(policy,'table',t));for(const pin of identities)baseClasses.push(classFor(policy,'plugin',pin.manifest_id));
  const dataClass=(tables:string[]=[])=>{const classes=[...baseClasses,...tables.map(t=>classFor(policy,'table',t))];return strongestClass(classes);};
  const initialClass=dataClass();
  await auditBackgroundReads(c.env,[{action:'plugin.registration-read',kind:'table' as const,key:'plugins',targetType:'plugin',ids:plugins.map(r=>String(r.id)),count:plugins.length},
    {action:'plugin.registration-identity-read',kind:'table' as const,key:'plugin_identity_approvals',targetType:'plugin_identity',ids:identities.map(r=>String(r.plugin_row_id)),count:identities.length}].map(read=>({...read,minimumClass:initialClass==='none'?undefined:initialClass})),contextActor(c));
  const admission=()=>[authority.guard(),classificationPolicyGuard(c.env,policy),guard(c,'plugins',REGISTRY,plugins),guard(c,'plugin_identity_approvals',IDENTITY,identities)];
  const finish=()=>[authority.guard(),classificationPolicyGuard(c.env,policy)];
  async function run<T>(work:()=>Promise<T>):Promise<T>{assertRegulatedWritesAllowed(c.env);try{if(await flushReadAudit(c))throw new Error('Plugin read evidence unavailable');const result=await work();invalidate();return result;}catch(error){if(error instanceof PluginRegistrationConflictError)throw error;return unavailable(c);}}
  return {plugins,identities,policy,dataClass,admission,finish,run};
}
/** NULL timestamps in an expected row: set by this transaction (see resultGuard). */
/** The local plugin registry and identity pins, as every host plugin-management
 *  change on the runner starts: `plugin:manage`, classified by each pinned plugin. */
export function beginPluginRegistryMutation(c:AppContext,unavailable:()=>Error,passthrough?:(error:unknown)=>boolean){
  return beginAuditedMutation(c,{
    permission:'plugin:manage',
    classify:rows=>[['table','plugins'],['table','plugin_identity_approvals'],...rows.identities.map(pin=>['plugin',String(pin.manifest_id)] as [ContainerKind,string])],
    snapshot:{
      plugins:{table:'plugins',fields:REGISTRY,where:'1',args:[],read:{action:'plugin.registration-read',kind:'table',key:'plugins',targetType:'plugin',id:r=>String(r.id)}},
      identities:{table:'plugin_identity_approvals',fields:IDENTITY,where:'1',args:[],read:{action:'plugin.registration-identity-read',kind:'table',key:'plugin_identity_approvals',targetType:'plugin_identity',id:r=>String(r.plugin_row_id)}},
    },
    unavailable,passthrough,
  });
}
async function prepare(c:AppContext){
  const mutation=await beginPluginRegistryMutation(c,()=>new PluginRegistrationUnavailableError(),error=>error instanceof PluginRegistrationConflictError);
  const plugins=mutation.rows.plugins as unknown as PluginRecord[],identities=mutation.rows.identities as unknown as PluginIdentityApproval[];
  const row=(id:number)=>{if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid plugin identity');return plugins.find(p=>p.id===id);};
  async function run<T>(decide:Parameters<typeof mutation.commit>[0]):Promise<T|undefined>{try{return await mutation.commit(decide) as T|undefined;}finally{invalidate();}}
  async function save(action:'plugin.create'|'plugin.update'|'plugin.toggle'|'plugin.rotate_secret',input:PluginInput|undefined,id?:number):Promise<PluginRecord>{
    let unchanged:PluginRecord|undefined;
    const saved=await run<PluginRecord>(async(_rows,tools):Promise<MutationPlan|null>=>{
      const before=id===undefined?undefined:row(id);if(id!==undefined&&!before)throw new Error('Plugin disappeared');
      if(input&&plugins.some(p=>p.url===input.url&&p.id!==id))throw new PluginRegistrationConflictError();
      const clock=await tools.clock(`${nextIdSql('plugins')} AS next_id`);
      if(!before&&(!Number.isSafeInteger(clock.next_id)||Number(clock.next_id)<=0))throw new Error('Unsafe plugin identity');
      const next:PluginRecord=before?{...before}:{id:Number(clock.next_id),uuid:crypto.randomUUID(),created_at:clock.now,updated_at:clock.now,label:'',url:'',enabled:0,config:null,sort_order:0,secret:generatePluginSecret()};
      if(input){next.label=input.label;next.url=input.url;next.enabled=input.enabled?1:0;next.config=input.config??null;next.sort_order=input.sort_order??0;if(next.config!==null)JSON.parse(next.config);
        if(before&&before.url!==next.url)next.config=JSON.stringify({...JSON.parse(next.config||'{}'),cmsTrustedUi:false});}
      if(action==='plugin.toggle')next.enabled=before!.enabled?0:1;
      if(action==='plugin.rotate_secret')next.secret=generatePluginSecret();
      if(!next.url||!Number.isFinite(next.sort_order))throw new Error('Invalid plugin configuration');json(next);
      const changed=MUTABLE.filter(f=>!before||before[f]!==next[f]);if(!changed.length){unchanged=next;return null;}
      const final={...next,created_at:before?.created_at??null,updated_at:null};
      const expected=before?plugins.map(p=>p.id===id?final:p):[...plugins,final];if(expected.length>5000)throw new Error('Plugin catalogue requires review');json(expected);
      const columns=action==='plugin.toggle'?['enabled'] as const:action==='plugin.rotate_secret'?['secret'] as const:['label','url','enabled','config','sort_order'] as const;
      return {
        writes:[before?{sql:`UPDATE plugins SET ${columns.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[...columns.map(f=>next[f]),id!]}
          :{sql:`INSERT INTO plugins(id,uuid,${MUTABLE.join(',')}) VALUES (?,?,${MUTABLE.map(()=>'?').join(',')})`,args:[next.id,next.uuid,...MUTABLE.map(f=>next[f])]}],
        evidence:{entry:{action,entityType:'plugin',entityId:next.uuid,detail:{id:next.id,fields:changed,
          ...(changed.includes('enabled')?{enabled_before:before?!!before.enabled:null,enabled_after:!!next.enabled}:{})}}},
        expect:since=>[resultGuard(c,'plugins',REGISTRY,expected,since),guard(c,'plugin_identity_approvals',IDENTITY,identities)],
        returning:{sql:`SELECT ${REGISTRY.join(',')} FROM plugins WHERE uuid=?`,args:[next.uuid]},
      };
    });
    return unchanged??saved!;
  }
  return {
    row(id:number){const plugin=row(id);return plugin?{...plugin}:undefined;},
    create(input:PluginInput){return save('plugin.create',input);},
    update(id:number,input:PluginInput){return save('plugin.update',input,id);},
    toggle(id:number){return save('plugin.toggle',undefined,id);},
    rotate(id:number){return save('plugin.rotate_secret',undefined,id);},
    async remove(id:number):Promise<void>{await run(async(_rows,tools):Promise<MutationPlan|null>=>{
      const before=row(id);if(!before)return null;
      const pin=identities.find(p=>p.plugin_row_id===id);if(pin&&!/^[a-z][a-z0-9-]{0,63}$/.test(pin.manifest_id))throw new Error('Unsafe plugin identity pin');
      const captured=pin?await tools.snapshot(OWNED.map(spec=>({table:spec.table,fields:spec.fields,where:'plugin_id=?',args:[pin.manifest_id],
        read:{action:'plugin.unregister-read',kind:'table' as const,key:spec.table,targetType:spec.table,id:(r:Row)=>spec.table==='plugin_state'?fingerprint(String(r.key)):String(r.id)}})),
        OWNED.map(spec=>['table',spec.table] as [ContainerKind,string])):[];
      const owned=pin?OWNED.map((spec,index)=>({...spec,rows:captured[index] as Row[]})):[];
      const state=owned.find(s=>s.table==='plugin_state');
      const stateIds=await Promise.all((state?.rows??[]).map(async r=>await fingerprint(String(r.key))));
      const detail={id,fields:['registry',...(pin?['identity','approvals','state']:[])],cleanup:pin?'pinned_identity':'no_pinned_identity',
        ...(pin?{identity_fingerprint:await fingerprint(pin.manifest_id)}:{}),removed:owned.map(spec=>({table:spec.table,count:spec.rows.length,ids:spec.table==='plugin_state'?stateIds:spec.rows.map(r=>r.id)})),retained_sequences:true,retained_limit_pricing_settings:true};json(detail);
      const writes:PlannedWrite[]=owned.map(spec=>({sql:`DELETE FROM ${spec.table} WHERE plugin_id=?`,args:[pin!.manifest_id],changes:spec.rows.length}));
      writes.push({sql:'DELETE FROM plugin_identity_approvals WHERE plugin_row_id=?',args:[id],changes:pin?1:0},{sql:'DELETE FROM plugins WHERE id=?',args:[id]});
      return {
        writes,
        evidence:{entry:{action:'plugin.delete',entityType:'plugin',entityId:before.uuid,detail}},
        expect:()=>[guard(c,'plugins',REGISTRY,plugins.filter(p=>p.id!==id)),guard(c,'plugin_identity_approvals',IDENTITY,identities.filter(p=>p.plugin_row_id!==id)),
          ...owned.map(spec=>guard(c,spec.table,spec.fields,[],'plugin_id=?',[pin!.manifest_id]))],
      };
    });},
  };
}
