import type { AppContext } from '../../core/http/context';
import { classFor } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { json,snapshot,guard,resultGuard,fingerprint,type Row } from '../../core/db/bounded-mutation';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { recordPolicyDenial } from '../../core/auth/denials';
import { cmsConfig } from '../../cms-config';
import { callFeatureService } from '../services';
import { capturePluginMutationContext,REGISTRY,IDENTITY,OWNED,invalidate } from './registration-evidence';
import { inspectPluginManifest } from './registry';
import { declaredLimits,limitsSettingKey } from './limits';

const SETTING=['key','value','created_at','updated_at'];
export class PluginSettingsUnavailableError extends Error {constructor(){super('Plugin limits/pricing change unavailable');}}
export async function mutatePluginSettings(c:AppContext,id:number,kind:'limits'|'pricing',form:FormData):Promise<boolean>{
  assertRegulatedWritesAllowed(c.env);
  try{const result=await mutate(c,id,kind,form);invalidate();return result;}catch{invalidate();await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new PluginSettingsUnavailableError();}
}
async function mutate(c:AppContext,id:number,kind:'limits'|'pricing',form:FormData):Promise<boolean>{
  if(!Number.isSafeInteger(id)||id<=0)return false;
  const base=await capturePluginMutationContext(c),row=base.plugins.find(r=>r.id===id);if(!row)return false;
  const found=await inspectPluginManifest(row);if(!found)return false;
  const manifest=found.manifest,pin=base.identities.find(p=>p.plugin_row_id===id);
  if(pin?.manifest_id!==manifest.id){await c.env.DB.batch([...base.admission(),...base.finish()]);await recordPolicyDenial(c,'plugin_identity_required');return false;}
  const spec=OWNED[1],approvals=await snapshot<Row>(c,spec.table,spec.fields,'plugin_id=?',[manifest.id]);
  const write=new Set(approvals.filter(r=>r.access==='write').map(r=>String(r.page_type)));
  const types=new Set(Object.keys(manifest.contentTypes?.blueprint??{}).filter(type=>write.has(type)&&!Object.hasOwn(cmsConfig.blueprint,type)));
  for(const type of manifest.contentTypes?.writeTypes??[])if(write.has(type))types.add(type);
  const classes=[base.dataClass(['settings',spec.table]),classFor(base.policy,'plugin',manifest.id),...([...types].map(t=>classFor(base.policy,'page_type',t)))];
  if(types.has('*'))for(const [target,value] of base.policy.exact)if(target.startsWith('page_type:'))classes.push(value);
  const dataClass=classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
  await auditBackgroundReads(c.env,[{action:'plugin.configuration-source-read',kind:'table',key:spec.table,targetType:spec.table,ids:approvals.map(r=>String(r.id)),count:approvals.length,minimumClass:dataClass==='none'?undefined:dataClass}],contextActor(c));
  let values:Record<string,number|null>=Object.create(null);
  let key=limitsSettingKey(manifest.id);
  if(kind==='limits'){
    for(const def of declaredLimits(manifest,types)){
      if(form.get(`unlimited_${def.key}`)!==null){values[def.key]=null;continue;}
      const raw=String(form.get(`value_${def.key}`)??'').trim();if(!raw)continue;
      const n=Number(raw);if(Number.isSafeInteger(Math.trunc(n))&&n>=0)values[def.key]=Math.trunc(n);
    }
  }else{
    const submitted:Record<string,string>=Object.create(null);for(const [key,value] of form)if(key.startsWith('value_'))submitted[key.slice(6)]=String(value).trim();
    const prepared=await callFeatureService<{key:string;values:Record<string,number>}>('credits','prepare-admin-pricing',c.env,{contributor:{id:manifest.id,name:manifest.name,credits:manifest.credits??[],pricablePageTypes:types},submitted});
    if(prepared===undefined)return true; // Missing metering feature is inert.
    key=prepared.key;values=prepared.values;
  }
  const before=await snapshot<Row>(c,'settings',SETTING,'key=?',[key]);
  const keyFingerprint=await fingerprint(key);
  await auditBackgroundReads(c.env,[{action:'plugin.configuration-source-read',kind:'table',key:'settings',targetType:'settings',ids:before.length?[keyFingerprint]:[],count:before.length}].map(r=>({...r,kind:'table' as const,minimumClass:dataClass==='none'?undefined:dataClass})),contextActor(c));
  const admission=[...base.admission(),guard(c,spec.table,spec.fields,approvals,'plugin_id=?',[manifest.id]),guard(c,'settings',SETTING,before,'key=?',[key])];
  const next=json(values),old=before[0]?.value;
  let previous:Record<string,unknown>={};if(old!==undefined){const parsed=JSON.parse(String(old));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Unsafe saved configuration');previous=parsed;}
  const same=old!==undefined&&Object.keys(previous).length===Object.keys(values).length&&Object.entries(values).every(([k,v])=>previous[k]===v);
  if(await flushReadAudit(c))throw new Error('Configuration read evidence unavailable');
  if(same||(!before.length&&!Object.keys(values).length)){await c.env.DB.batch([...admission,...base.finish()]);return true;}
  const keys=[...new Set([...Object.keys(previous),...Object.keys(values)])];if(keys.length>5000)throw new Error('Configuration key catalogue requires review');
  const changed=await Promise.all(keys.filter(k=>previous[k]!==values[k]||Object.hasOwn(previous,k)!==Object.hasOwn(values,k)).sort().map(k=>fingerprint(k)));
  const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Clock unavailable');
  const expected=[{key,value:next,created_at:before[0]?.created_at??null,updated_at:null}];
  const detail={operation_id:crypto.randomUUID(),id,fields:['value'],key_fingerprint:keyFingerprint,changed_key_fingerprints:changed,configured_count:Object.keys(values).length,manifest_fingerprint:await fingerprint(json(manifest))};json(detail);
  const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action:kind==='limits'?'plugin.limits.update':'plugin.credits.update',entityType:'plugin',entityId:row.uuid,detail},dataClass,base.policy,{context:c});
  await c.env.DB.batch([...admission,c.env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(key,next),abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
    resultGuard(c,'settings',SETTING,expected,clock.now,'key=?',[key]),guard(c,'plugins',REGISTRY,base.plugins),guard(c,'plugin_identity_approvals',IDENTITY,base.identities),guard(c,spec.table,spec.fields,approvals,'plugin_id=?',[manifest.id]),...base.finish()]);return true;
}
