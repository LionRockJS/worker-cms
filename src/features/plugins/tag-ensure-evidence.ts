import type { AppContext } from '../../core/http/context';
import type { PluginPageMutationAuthority } from './page-update-evidence';
import { assertPluginPageAuthority } from './page-update-evidence';
import { noteActingUser } from './evidence-common';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError } from '../../core/db/audit';
import { guard, resultGuard, json, fingerprint, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { beginServiceAuditedMutation, type MutationGroup } from '../../core/evidence/audited-mutation';
import { nextIdSql } from '../../core/pages/snapshot-id';
import { classFor,strongestClass } from '../../core/db/data-classes';
import { auditBackgroundReads, flushReadAudit, recordTagReads } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { slugify } from '../../core/http/forms';
import { publication } from '../services';

const TAX=['id','uuid','created_at','updated_at','name','slug'];
const TAG=['id','uuid','created_at','updated_at','name','slug','weight','taxonomy_slug','parent_tag','lect'];
const OWNER=['id','uuid','slug','taxonomy_slug'];
const NEXT_TAG_ID=nextIdSql('tags');
const TRASH_TAGS_COUNT="(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='trash_page_tags')";

class TagEnsureUnavailableError extends ServiceMutationUnavailableError {}

/** Find/create is one local transaction, including reused identities and item
 * decisions. Catalogue publication has its own external outcome. */
export async function ensurePluginTags(c:AppContext,authority:PluginPageMutationAuthority,input:unknown):Promise<Response> {
 assertRegulatedWritesAllowed(c.env);
 const operationId=crypto.randomUUID();let committed=false,dataClass=authority.dataClass;
 const detail:Record<string,unknown>={operation_id:operationId,registry_id:authority.registryId,identity_fingerprint:authority.identityFingerprint,principal:'credential_authenticated_plugin'};
 noteActingUser(c,detail);
 async function recordFailure(commitState:'committed'|'not_committed'|'unknown'){
  try{
   const receipt=serviceMutationAuditEvidence(c.env,{
    action:'tag.ensure.result',entityType:'tag_ensure_operation',entityId:operationId,outcome:'error',
    detail:{...detail,commit_state:commitState},
   },authority.actor,dataClass,authority.policy,c);
   await c.env.DB.batch([receipt.write,receipt.guard]);
  }catch{}
 }
 try {
  assertPluginPageAuthority(authority,'tag-ensure');
  const mutation=await beginServiceAuditedMutation(c,{
   classify:[],snapshot:{},
   unavailable:async (error,submitted)=>{
    const rollbackKnown=error instanceof Error&&/^D1_ERROR:.*SQLITE_/s.test(error.message);
    await recordFailure(authority.allowed.size&&submitted&&!rollbackKnown?'unknown':'not_committed');
    return new TagEnsureUnavailableError();
   },
  },authority);
  if(!authority.allowed.size){
   await mutation.commit(()=>({
    groups:[{evidence:{entry:{action:'tag.ensure',entityType:'tag_ensure_operation',entityId:operationId,outcome:'denied',
     detail:{...detail,reason:'write_scope_required'}},dataClass}}],
    expect:[],
   }));
   return c.json({error:'forbidden'},403);
  }
  const items=input&&typeof input==='object'&&!Array.isArray(input)&&(input as {tags?:unknown}).tags;
  if(!Array.isArray(items))return c.json({error:'invalid_body'},400);
  if(items.length>200)return c.json({error:'batch_too_large',max:200},413);
  json(items);
  const errors:Array<{index:number;error:string}>=[],pairs:Array<{taxonomy:string;name:string;index:number}>=[];
  for(const [index,item] of items.entries()){
   const entry=item&&typeof item==='object'&&!Array.isArray(item)?item as Record<string,unknown>:{};
   const name=typeof entry.name==='string'?entry.name.trim():'',taxonomy=typeof entry.taxonomy==='string'?entry.taxonomy.trim():'';
   if(!name){errors.push({index,error:'name_required'});continue;}pairs.push({index,name,taxonomy});
  }
  const targets:Array<{taxonomy:string;name:string;uuid:Row['uuid']}>=[];
  const rows=await mutation.commit(async (_rows,tools)=>{
   const keys=[...new Set(pairs.map(p=>p.taxonomy))],taxArgs=[json(keys)],taxWhere='slug IN (SELECT value FROM json_each(?))';
   const [taxonomies]=await tools.snapshot([{table:'taxonomies',fields:TAX,where:taxWhere,args:taxArgs,read:null}]);
   const accepted=pairs.filter(pair=>{
    if(taxonomies.some(t=>t.slug===pair.taxonomy))return true;
    errors.push({index:pair.index,error:'unknown_taxonomy'});
    return false;
   });
   errors.sort((a,b)=>a.index-b.index);
   const unique=[...new Map(accepted.map(p=>[json([p.taxonomy,p.name]),p])).values()];
   const pairArgs=[json(unique)],pairWhere="EXISTS(SELECT 1 FROM json_each(?) e WHERE tags.taxonomy_slug=json_extract(e.value,'$.taxonomy') AND tags.name=json_extract(e.value,'$.name'))";
   const [existing]=await tools.snapshot([{table:'tags',fields:TAG,where:pairWhere,args:pairArgs,read:null}]);
   const missing=unique.filter(p=>!existing.some(t=>t.taxonomy_slug===p.taxonomy&&t.name===p.name));
   const baseFor=(pair:typeof unique[number])=>{
    const taxonomy=taxonomies.find(t=>t.slug===pair.taxonomy)!;
    return slugify(`${taxonomy.slug||taxonomy.name}-${pair.name}`)||'tag';
   };
   const bases=[...new Set(missing.map(baseFor))];
   const slugWhere="EXISTS(SELECT 1 FROM json_each(?) e WHERE tags.slug=e.value OR substr(tags.slug,1,length(e.value)+1)=e.value||'-')",slugArgs=[json(bases)];
   const [owners]=await tools.snapshot([{table:'tags',fields:OWNER,where:slugWhere,args:slugArgs,read:null}]);
   dataClass=strongestClass([
    authority.dataClass,
    ...keys.map(key=>classFor(tools.policy,'taxonomy',key)),
    ...owners.map(tag=>classFor(tools.policy,'taxonomy',String(tag.taxonomy_slug??'default'))),
   ]);
   detail.request_fingerprint=await fingerprint(json(pairs));
   await auditBackgroundReads(c.env,([
    ['taxonomies',taxonomies],['tags',existing],['tags',owners],
   ] as const).map(([table,source])=>({
    action:'plugin.tag-ensure-source-read',kind:'table',key:table,targetType:table,
    ids:source.map(row=>String(row.id)),count:source.length,minimumClass:dataClass==='none'?undefined:dataClass,
   })),authority.actor,{policy:tools.policy});
   if(await flushReadAudit(c))throw new Error('Tag source evidence unavailable');

   const used=new Set(owners.map(t=>String(t.slug))),created:Row[]=[];
   for(const pair of missing){
    const base=baseFor(pair);let slug=base,suffix=1;
    while(used.has(slug)){
     if(++suffix>5001)throw new Error('Tag slug namespace requires review');
     slug=`${base}-${suffix}`;
    }
    used.add(slug);
    created.push({uuid:crypto.randomUUID(),created_at:null,updated_at:null,name:pair.name,slug,
     weight:5,taxonomy_slug:pair.taxonomy,parent_tag:null,lect:null});
   }
   const allTags=[...existing,...created];
   const selected=unique.map(pair=>{
    const tag=allTags.find(t=>t.taxonomy_slug===pair.taxonomy&&t.name===pair.name)!;
    return {pair,uuid:tag.uuid,created:created.includes(tag),
     input_indices:accepted.filter(p=>p.taxonomy===pair.taxonomy&&p.name===pair.name).map(p=>p.index)};
   });
   for(const {taxonomy,name} of accepted){
    const target=selected.find(({pair})=>pair.taxonomy===taxonomy&&pair.name===name)!;
    targets.push({taxonomy,name,uuid:target.uuid});
   }
   const groups:MutationGroup[]=selected.map(({pair,uuid,created:isNew,input_indices})=>{
    const taxonomy=taxonomies.find(t=>t.slug===pair.taxonomy)!;
    return {evidence:{entry:{action:isNew?'tag.create':'tag.ensure',entityType:'tag',entityId:String(uuid),
     detail:{...detail,created:isNew,taxonomy_id:taxonomy.id,taxonomy_uuid:taxonomy.uuid,input_indices}},dataClass}};
   });
   if(items.length)groups.push({evidence:{
    entry:{action:'tag.ensure.batch',entityType:'tag_ensure_operation',entityId:operationId,
     detail:{...detail,input_count:items.length,targets:selected.map(({uuid,created,input_indices})=>({uuid,created,input_indices})),
      errors,publication:'separate_effect'}},dataClass,
   }});
   const {now,trashCount}=await tools.clock(`${TRASH_TAGS_COUNT} AS trashCount`);
   if(trashCount!==0&&trashCount!==1)throw new Error('Tag storage observation unavailable');
   const newUuids=json(created.map(t=>t.uuid));
   return {
    leadingWrites:created.map(tag=>({
     sql:`INSERT INTO tags(id,uuid,name,slug,taxonomy_slug) VALUES (${NEXT_TAG_ID},?,?,?,?)`,
     args:[tag.uuid,tag.name,tag.slug,tag.taxonomy_slug],
    })),
    groups,
    expect:[
     guard(c,'taxonomies',TAX,taxonomies,taxWhere,taxArgs),
     guard(c,'tags',TAG,existing,`(${pairWhere}) AND uuid NOT IN (SELECT value FROM json_each(?))`,[...pairArgs,newUuids]),
     resultGuard(c,'tags',TAG.filter(f=>f!=='id'),allTags,now,pairWhere,pairArgs),
     guard(c,'tags',OWNER,owners,`(${slugWhere}) AND uuid NOT IN (SELECT value FROM json_each(?))`,[...slugArgs,newUuids]),
     abortIf(c.env,`EXISTS(SELECT 1 FROM tags WHERE ${pairWhere} AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))`,pairArgs),
     abortIf(c.env,'EXISTS(SELECT 1 FROM page_tags WHERE tag_id IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?)))) OR EXISTS(SELECT 1 FROM tags WHERE parent_tag IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?))))',[newUuids,newUuids]),
     abortIf(c.env,`${TRASH_TAGS_COUNT}<>?`,[trashCount]),
     ...(trashCount?[abortIf(c.env,'EXISTS(SELECT 1 FROM trash_page_tags WHERE tag_id IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?))))',[newUuids])]:[]),
    ],
    returning:{sql:`SELECT id,uuid FROM tags WHERE ${pairWhere} ORDER BY id`,args:pairArgs},
   };
  });
  committed=true;
  const ensured=targets.map(({taxonomy,name,uuid})=>{
   const row=rows.find(r=>r.uuid===uuid);
   if(typeof row?.id!=='number'||!Number.isSafeInteger(row.id)||row.id<=0)throw new Error('Tag result unavailable');
   return {taxonomy,name,id:row.id};
  });
  await publication()?.publishTagsToTargets(c.env,[...new Set(ensured.map(t=>t.id))],authority.actor);
  recordTagReads('tag.ensure-result',ensured.map(tag=>({id:tag.id,taxonomy_slug:tag.taxonomy})),authority.actor);
  return c.json({tags:ensured,errors});
 }catch(error){
  if(error instanceof TagEnsureUnavailableError)throw error;
  await recordFailure(committed?'committed':'not_committed');
  await recordAuditOutage(c.env,'health',[],authority.actor,undefined,{captureIncomplete:true});
  throw new ServiceMutationUnavailableError();
 }
}
