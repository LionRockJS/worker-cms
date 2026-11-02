import type { Env } from '../../types';
import type { PluginRecord,PluginManifest } from './types';
import { serviceMutationAuditEvidence,ServiceMutationUnavailableError,type AuditActor } from '../../core/db/audit';
import { resolveDataClasses,classFor,classificationPolicyGuard } from '../../core/db/data-classes';
import { snapshot,guard,fingerprint,json,resultGuard,type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';

const REGISTRY=['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
const IDENTITY=['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const actor:AuditActor={userId:null,roles:null,sessionSid:null,via:'service:plugin-registry'};
/** The enabled host registration authorizes TOFU, not a caller-supplied user
 * or secret. Keep the observed security binding across the manifest exchange. */
export async function claimAutomaticPluginIdentity(env:Env,observed:PluginRecord,manifest:PluginManifest):Promise<boolean>{
  assertRegulatedWritesAllowed(env);
  try{
    const db={env},policy=await resolveDataClasses(env,true);if(!policy.ok)throw new Error('Claim policy unavailable');
    if(!Number.isSafeInteger(observed.id)||observed.id<=0||!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id))throw new Error('Unsafe claim');
    const rows=await snapshot<Row>(db,'plugins',REGISTRY,'id=?',[observed.id]),current=rows[0];
    if(!current||current.enabled!==1||['id','uuid','url','secret'].some(f=>current[f]!==observed[f as keyof PluginRecord]))throw new Error('Claim registration changed');
    const where='plugin_row_id=? OR manifest_id=?',args=[observed.id,manifest.id];
    const pins=await snapshot<Row>(db,'plugin_identity_approvals',IDENTITY,where,args);
    const classes=['plugins','plugin_identity_approvals'].map(t=>classFor(policy,'table',t));for(const id of [manifest.id,...pins.map(p=>String(p.manifest_id))])classes.push(classFor(policy,'plugin',id));
    const dataClass=classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
    await auditBackgroundReads(env,[{action:'plugin.identity-claim-source-read',kind:'table',key:'plugins',targetType:'plugin',ids:[String(observed.id)],count:1,minimumClass:dataClass==='none'?undefined:dataClass},
      {action:'plugin.identity-claim-source-read',kind:'table',key:'plugin_identity_approvals',targetType:'plugin_identity',ids:pins.map(p=>String(p.plugin_row_id)),count:pins.length,minimumClass:dataClass==='none'?undefined:dataClass}],actor);
    const authority=()=>[classificationPolicyGuard(env,policy),guard(db,'plugins',REGISTRY,rows,'id=?',[observed.id])];
    if(pins.length){await env.DB.batch([...authority(),guard(db,'plugin_identity_approvals',IDENTITY,pins,where,args)]);return pins.some(p=>p.plugin_row_id===observed.id&&p.manifest_id===manifest.id);}
    const clock=await env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Clock unavailable');
    const detail={operation_id:crypto.randomUUID(),id:observed.id,claim_mode:'first_resolution',identity_fingerprint:await fingerprint(manifest.id),manifest_fingerprint:await fingerprint(json(manifest))};
    const receipt=serviceMutationAuditEvidence(env,{action:'plugin.identity.claim',entityType:'plugin',entityId:String(current.uuid),detail},actor,dataClass,policy);
    try{
      await env.DB.batch([...authority(),guard(db,'plugin_identity_approvals',IDENTITY,[],where,args),
        env.DB.prepare("INSERT INTO plugin_identity_approvals(plugin_row_id,manifest_id,approved_by) VALUES (?,?,'')").bind(observed.id,manifest.id),abortIf(env,'changes()<>1'),receipt.write,receipt.guard,
        resultGuard(db,'plugin_identity_approvals',IDENTITY,[{plugin_row_id:observed.id,manifest_id:manifest.id,approved_by:'',created_at:null,updated_at:null}],clock.now,where,args),...authority()]);
      return true;
    }catch(error){
      // A SQLite statement failure rolls back D1.batch. Join only a claim
      // another caller has already committed; never replay a business write.
      // Transport/lost-acknowledgment errors stay unavailable, even if a pin
      // is now visible. Fresh read guards retain the original policy/registry.
      if(!(error instanceof Error)||!/^D1_ERROR:.*SQLITE_/s.test(error.message))throw error;
      const winner=await snapshot<Row>(db,'plugin_identity_approvals',IDENTITY,where,args);
      if(!winner.some(p=>p.plugin_row_id===observed.id&&p.manifest_id===manifest.id))throw error;
      await auditBackgroundReads(env,[{action:'plugin.identity-claim-source-read',kind:'table',key:'plugin_identity_approvals',targetType:'plugin_identity',ids:winner.map(p=>String(p.plugin_row_id)),count:winner.length,minimumClass:dataClass==='none'?undefined:dataClass}],actor);
      await env.DB.batch([...authority(),guard(db,'plugin_identity_approvals',IDENTITY,winner,where,args)]);return true;
    }
  }catch{
    await recordAuditOutage(env,'health',[],actor,undefined,{captureIncomplete:true});throw new ServiceMutationUnavailableError();
  }
}
