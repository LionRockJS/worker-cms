import type { AppContext } from '../../core/http/context';
import { serviceMutationAuditEvidence,ServiceMutationUnavailableError,type AuditActor } from '../../core/db/audit';
import { resolveDataClasses,classFor,classificationPolicyGuard } from '../../core/db/data-classes';
import { snapshot,guard,resultGuard,fingerprint,json,type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { timingSafeEqualStr } from '../../core/http/crypto';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { MAX_STATE_KEYS_PER_PLUGIN,MAX_STATE_VALUE_BYTES,isValidStateKey,stateValueBytes } from './state';
import type { PluginAuth } from './api/types';

const REGISTRY=['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
const IDENTITY=['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const ENTRY=['plugin_id','key','value','created_at','updated_at'];
const CATALOGUE=['plugin_id','key','created_at','updated_at'];
const authorityBrand=Symbol('plugin-state-authority');
async function unavailable(c:AppContext,actor?:AuditActor):Promise<never>{
  await recordAuditOutage(c.env,'health',[],actor,undefined,{captureIncomplete:true});throw new ServiceMutationUnavailableError();
}
/** Capture immediately after credential authentication, BEFORE waiting for the
 * request body. A later pin/credential/registration cannot rebind this request. */
export async function capturePluginStateAuthority(c:AppContext,auth:PluginAuth){
  try{
    const registration=auth.plugin.registration;
    if(!registration||!Number.isSafeInteger(registration.id)||registration.id<=0)throw new Error('Missing registration identity');
    const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('State policy unavailable');
    const rows=await snapshot<Row>(c,'plugins',REGISTRY,'id=?',[registration.id]);
    const pins=await snapshot<Row>(c,'plugin_identity_approvals',IDENTITY,'plugin_row_id=?',[registration.id]);
    const row=rows[0],pin=pins[0];
    if(!row||row.uuid!==registration.uuid||row.enabled!==1||row.url!==auth.plugin.binding||pin?.manifest_id!==auth.pluginId||!row.secret
      ||!timingSafeEqualStr(String(row.secret),auth.plugin.apiSecret)||!timingSafeEqualStr(String(row.secret),c.req.header('x-plugin-secret')??''))throw new Error('State credential changed');
    const actor:AuditActor={userId:null,roles:null,sessionSid:null,via:`plugin:${registration.uuid}`};
    const classes=['plugins','plugin_identity_approvals','plugin_state'].map(t=>classFor(policy,'table',t));classes.push(classFor(policy,'plugin',auth.pluginId));
    const dataClass=classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
    await auditBackgroundReads(c.env,['plugins','plugin_identity_approvals'].map(table=>({action:'plugin.state-authority-read',kind:'table' as const,key:table,targetType:table,ids:[String(registration.id)],count:1,minimumClass:dataClass==='none'?undefined:dataClass})),actor);
    const check=()=>[guard(c,'plugins',REGISTRY,rows,'id=?',[registration.id]),guard(c,'plugin_identity_approvals',IDENTITY,pins,'plugin_row_id=?',[registration.id]),classificationPolicyGuard(c.env,policy)];
    return {[authorityBrand]:true as const,actor,policy,dataClass,check,pluginId:auth.pluginId,registryId:registration.id,uuid:registration.uuid};
  }catch{return unavailable(c);}
}
type Authority=Awaited<ReturnType<typeof capturePluginStateAuthority>>;
/** Point mutations guard the exact selected value and the namespace key/
 * timestamp catalogue, without loading every other opaque value into memory. */
export async function mutatePluginState(c:AppContext,authority:Authority,key:string,value?:string):Promise<'ok'|'too_many_keys'>{
  assertRegulatedWritesAllowed(c.env);
  try{
    if(!authority?.[authorityBrand]||!isValidStateKey(key)||(value!==undefined&&stateValueBytes(value)>MAX_STATE_VALUE_BYTES))throw new Error('Invalid state mutation');
    if(value!==undefined)JSON.parse(value);
    const {actor,pluginId,registryId,uuid,policy,dataClass}=authority;
    const catalogue=await snapshot<Row>(c,'plugin_state',CATALOGUE,'plugin_id=?',[pluginId]);
    const before=await snapshot<Row>(c,'plugin_state',ENTRY,'plugin_id=? AND key=?',[pluginId,key]);
    const keyFingerprint=await fingerprint(key),identityFingerprint=await fingerprint(pluginId);
    await auditBackgroundReads(c.env,[{action:'plugin.state-mutation-source-read',kind:'table',key:'plugin_state',targetType:'plugin_state_catalogue',ids:await Promise.all(catalogue.map(r=>fingerprint(String(r.key)))),count:catalogue.length,minimumClass:dataClass==='none'?undefined:dataClass}],actor);
    const admission=[...authority.check(),guard(c,'plugin_state',CATALOGUE,catalogue,'plugin_id=?',[pluginId]),guard(c,'plugin_state',ENTRY,before,'plugin_id=? AND key=?',[pluginId,key])];
    if(await flushReadAudit(c))throw new Error('State source evidence unavailable');
    const detail:Record<string,unknown>={operation_id:crypto.randomUUID(),registry_id:registryId,identity_fingerprint:identityFingerprint,key_fingerprint:keyFingerprint,
      principal:'credential_authenticated_plugin',fields:value===undefined?['entry']:['value']};
    const asserted=c.req.header('x-acting-user-id');
    if(asserted!==undefined){const id=Number(asserted);detail.acting_user_verified=false;if(/^\d+$/.test(asserted)&&Number.isSafeInteger(id)&&id>0)detail.asserted_user_id=id;else detail.acting_user_unrecordable=true;}
    const target=`${uuid}:state:${keyFingerprint}`,action=value===undefined?'plugin.state.delete':'plugin.state.put';
    if(value!==undefined&&!before.length&&catalogue.length>=MAX_STATE_KEYS_PER_PLUGIN){
      const refusal=serviceMutationAuditEvidence(c.env,{action,entityType:'plugin_state',entityId:target,outcome:'denied',detail:{...detail,reason:'state_key_limit',max_keys:MAX_STATE_KEYS_PER_PLUGIN}},actor,dataClass,policy,c);
      await c.env.DB.batch([...admission,refusal.write,refusal.guard,...authority.check(),guard(c,'plugin_state',CATALOGUE,catalogue,'plugin_id=?',[pluginId]),guard(c,'plugin_state',ENTRY,before,'plugin_id=? AND key=?',[pluginId,key])]);return 'too_many_keys';
    }
    if((value===undefined&&!before.length)||(value!==undefined&&before[0]?.value===value)){
      await c.env.DB.batch([...admission,...authority.check()]);return 'ok';
    }
    const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Clock unavailable');
    const expected=value===undefined?[]:[{plugin_id:pluginId,key,value,created_at:before[0]?.created_at??null,updated_at:null}];
    const expectedCatalogue=[...catalogue.filter(r=>r.key!==key),...expected.map(({plugin_id,key,created_at,updated_at})=>({plugin_id,key,created_at,updated_at}))];json(expectedCatalogue);
    const receipt=serviceMutationAuditEvidence(c.env,{action,entityType:'plugin_state',entityId:target,detail},actor,dataClass,policy,c);
    await c.env.DB.batch([...admission,
      value===undefined?c.env.DB.prepare('DELETE FROM plugin_state WHERE plugin_id=? AND key=?').bind(pluginId,key):c.env.DB.prepare(`INSERT INTO plugin_state(plugin_id,key,value) VALUES (?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(pluginId,key,value),
      abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
      resultGuard(c,'plugin_state',ENTRY,expected,clock.now,'plugin_id=? AND key=?',[pluginId,key]),resultGuard(c,'plugin_state',CATALOGUE,expectedCatalogue,clock.now,'plugin_id=?',[pluginId]),...authority.check()]);return 'ok';
  }catch{return unavailable(c,authority?.actor);}
}
