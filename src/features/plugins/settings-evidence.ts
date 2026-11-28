import type { AppContext } from '../../core/http/context';
import type { ContainerKind, DataClass } from '../../core/db/data-classes';
import type { MutationPlan } from '../../core/evidence/audited-mutation';
import { json,guard,resultGuard,fingerprint,type Row } from '../../core/db/bounded-mutation';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { recordPolicyDenial } from '../../core/auth/denials';
import { cmsConfig } from '../../cms-config';
import { callFeatureService } from '../services';
import { beginPluginRegistryMutation,APPROVAL_TABLES,invalidate } from './registration-evidence';
import { REGISTRY,IDENTITY } from './evidence-common';
import { inspectPluginManifest } from './registry';
import { declaredLimits,limitsSettingKey } from './limits';
import type { PluginRecord,PluginIdentityApproval } from './types';

const SETTING=['key','value','created_at','updated_at'];
export class PluginSettingsUnavailableError extends Error {constructor(){super('Plugin limits/pricing change unavailable');}}
export async function mutatePluginSettings(c:AppContext,id:number,kind:'limits'|'pricing',form:FormData):Promise<boolean>{
  assertRegulatedWritesAllowed(c.env);
  try{return await mutate(c,id,kind,form);}finally{invalidate();}
}
/** NULL timestamps in an expected row: set by this transaction (see resultGuard). */
async function mutate(c:AppContext,id:number,kind:'limits'|'pricing',form:FormData):Promise<boolean>{
  if(!Number.isSafeInteger(id)||id<=0)return false;
  const mutation=await beginPluginRegistryMutation(c,()=>new PluginSettingsUnavailableError());
  const plugins=mutation.rows.plugins as unknown as PluginRecord[],identities=mutation.rows.identities as unknown as PluginIdentityApproval[];
  const row=plugins.find(r=>r.id===id);if(!row)return false;
  let result=true,denied=false;
  await mutation.commit(async(_rows,tools):Promise<MutationPlan|null>=>{
    const found=await inspectPluginManifest(row);if(!found){result=false;return null;}
    const manifest=found.manifest,pin=identities.find(p=>p.plugin_row_id===id);
    if(pin?.manifest_id!==manifest.id){denied=true;result=false;return null;}
    const spec=APPROVAL_TABLES[1];
    let types=new Set<string>();
    const [approvals]=await tools.snapshot([{table:spec.table,fields:spec.fields,where:'plugin_id=?',args:[manifest.id],
      read:{action:'plugin.configuration-source-read',kind:'table',key:spec.table,targetType:spec.table,id:r=>String(r.id)}}],([captured])=>{
      const write=new Set(captured.filter(r=>r.access==='write').map(r=>String(r.page_type)));
      types=new Set(Object.keys(manifest.contentTypes?.blueprint??{}).filter(type=>write.has(type)&&!Object.hasOwn(cmsConfig.blueprint,type)));
      for(const type of manifest.contentTypes?.writeTypes??[])if(write.has(type))types.add(type);
      // A wildcard grant covers every classified page type.
      const wildcard:DataClass[]=types.has('*')?[...tools.policy.exact].filter(([target])=>target.startsWith('page_type:')).map(([,value])=>value):[];
      return [['table','settings'],['table',spec.table],['plugin',manifest.id],...[...types].map(t=>['page_type',t] as [ContainerKind,string]),...wildcard];
    });
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
      if(prepared===undefined)return null; // Missing metering feature is inert.
      key=prepared.key;values=prepared.values;
    }
    const keyFingerprint=await fingerprint(key);
    const [before]=await tools.snapshot([{table:'settings',fields:SETTING,where:'key=?',args:[key],
      read:{action:'plugin.configuration-source-read',kind:'table',key:'settings',targetType:'settings',id:()=>keyFingerprint}}]);
    const next=json(values),old=before[0]?.value;
    let previous:Record<string,unknown>={};if(old!==undefined){const parsed=JSON.parse(String(old));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Unsafe saved configuration');previous=parsed;}
    const same=old!==undefined&&Object.keys(previous).length===Object.keys(values).length&&Object.entries(values).every(([k,v])=>previous[k]===v);
    if(same||(!before.length&&!Object.keys(values).length))return null;
    const keys=[...new Set([...Object.keys(previous),...Object.keys(values)])];if(keys.length>5000)throw new Error('Configuration key catalogue requires review');
    const changed=await Promise.all(keys.filter(k=>previous[k]!==values[k]||Object.hasOwn(previous,k)!==Object.hasOwn(values,k)).sort().map(k=>fingerprint(k)));
    const detail={id,fields:['value'],key_fingerprint:keyFingerprint,changed_key_fingerprints:changed,configured_count:Object.keys(values).length,manifest_fingerprint:await fingerprint(json(manifest))};json(detail);
    return {
      writes:[{sql:'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',args:[key,next]}],
      evidence:{entry:{action:kind==='limits'?'plugin.limits.update':'plugin.credits.update',entityType:'plugin',entityId:row.uuid,detail}},
      expect:since=>[resultGuard(c,'settings',SETTING,[{key,value:next,created_at:(before[0]?.created_at as string|undefined)??null,updated_at:null}],since,'key=?',[key]),
        guard(c,'plugins',REGISTRY,plugins),guard(c,'plugin_identity_approvals',IDENTITY,identities),guard(c,spec.table,spec.fields,approvals as Row[],'plugin_id=?',[manifest.id])],
    };
  });
  if(denied)await recordPolicyDenial(c,'plugin_identity_required');
  return result;
}
