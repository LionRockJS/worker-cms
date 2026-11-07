import type { AppContext } from '../../core/http/context';
import type { PluginAuth } from './api/types';
import type { PluginPageMutationAuthority } from './page-update-evidence';
import { assertPluginPageAuthority } from './page-update-evidence';
import { snapshot, guard, json, fingerprint, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError } from '../../core/db/audit';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { classFor } from '../../core/db/data-classes';
import { trashPagesAsService, PageLifecycleUnavailableError } from '../../core/pages/lifecycle-mutation-evidence';
import { pageTypeScopeAllows } from './page-types';
import { forbiddenPageTypeBody } from './api/auth';
import { collectionWhere, asPositiveSafeInteger } from './api/serialize';
import { emitPluginHooks } from './api/hooks';
import { unpublishPagesFromTargets, unpublishPageFromTargets } from '../../core/publish';

const FIELDS=['id','uuid','page_type'];
type Mode='single'|'batch'|'children';
/** Only acknowledged chunks advance progress. A lost D1 response never causes
 * a replay or an assertion that the unacknowledged chunk rolled back. */
export async function deletePluginPages(c:AppContext,auth:PluginAuth,authority:PluginPageMutationAuthority,mode:Mode,input:unknown):Promise<Response> {
 assertRegulatedWritesAllowed(c.env);
 const operationId=crypto.randomUUID();let acknowledged=0,chunkIndex=0,inFlight=false;let evidenceClass=authority.dataClass;
 const detail:Record<string,unknown>={operation_id:operationId,registry_id:authority.registryId,identity_fingerprint:authority.identityFingerprint,principal:'credential_authenticated_plugin',mode};
 const asserted=c.req.header('x-acting-user-id');
 if(asserted!==undefined){detail.acting_user_verified=false;const id=Number(asserted);if(/^\d+$/.test(asserted)&&Number.isSafeInteger(id)&&id>0)detail.asserted_user_id=id;else detail.acting_user_unrecordable=true;}
 try {
  assertPluginPageAuthority(authority,'delete');
  let where:string,args:Array<string|number|null>,selected:Row[],total:number;
  let declared:string|undefined;
  if(mode==='children'){
   if(!input||typeof input!=='object'||Array.isArray(input))return c.json({error:'invalid_body'},400);
   const body=input as Record<string,unknown>;
   declared=typeof body.page_type==='string'?body.page_type.trim():'';
   if(!declared)return c.json({error:'page_type_required'},400);
   const parent=body.parent_page_id===undefined||body.parent_page_id===null?null:asPositiveSafeInteger(body.parent_page_id);
   if(body.parent_page_id!==undefined&&body.parent_page_id!==null&&parent===null)return c.json({error:'invalid_page_id'},400);
   const selector=collectionWhere(parent,typeof body.pointer_key==='string'?body.pointer_key.trim():'',typeof body.pointer_value==='string'?body.pointer_value:'');
   if(!selector.ok)return c.json({error:selector.error},400);
   where=`${selector.sql} AND page_type=?`;args=[...selector.params,declared] as Array<string|number|null>;
  }else{
   const raw=mode==='single'?[input]:(input&&typeof input==='object'&&!Array.isArray(input)&&(input as {ids?:unknown}).ids);
   if(!Array.isArray(raw))return c.json({error:'invalid_body'},400);
   if(raw.length>100)return c.json({error:'batch_too_large',max:100},413);
   if(raw.some(id=>(mode==='batch'&&typeof id!=='number')||asPositiveSafeInteger(id)===null))return c.json({error:'invalid_id'},400);
   const ids=[...new Set(raw.map(id=>asPositiveSafeInteger(id)!))];where='id IN (SELECT value FROM json_each(?))';args=[json(ids)];
  }
  const count=await c.env.DB.prepare(`SELECT COUNT(*) n FROM pages WHERE ${where}`).bind(...args).first<{n:number}>();
  if(!count||!Number.isSafeInteger(count.n)||count.n<0)throw new Error('Deletion count unavailable');total=count.n;
  // Fixed trusted projection: no bodies or free-text selectors enter evidence.
  selected=await snapshot<Row>(c,'pages',FIELDS,`id IN (SELECT id FROM pages WHERE ${where} ORDER BY id LIMIT 1001)`,args);
  if(selected.length!==Math.min(total,1001))throw new Error('Deletion selection changed');
  const ceiling=Number(selected.at(-1)?.id??0),selectionFingerprint=await fingerprint(json({where,args}));
  detail.selector_fingerprint=selectionFingerprint;detail.selected_count=total;detail.request_cap=mode==='children'?1000:100;
  const remaining=(removed:number)=>selected.slice(removed);
  const selectionCheck=(removed:number)=>[
   ...authority.check(),
   abortIf(c.env,`(SELECT COUNT(*) FROM pages WHERE ${where})<>?`,[...args,total-removed]),
   guard(c,'pages',FIELDS,remaining(removed),`(${where}) AND id<=?`,[...args,ceiling]),
   guard(c,'page_sensitivity_floors',['uuid','level'],floors,'uuid IN (SELECT value FROM json_each(?))',[json(selected.map(p=>p.uuid))]),
   guard(c,'page_tags',LINK,links.filter(link=>remaining(removed).some(p=>p.id===link.page_id)),'page_id IN (SELECT value FROM json_each(?))',[json(remaining(removed).map(p=>p.id))]),
   guard(c,'tags',['id','uuid','taxonomy_slug'],tags,'id IN (SELECT value FROM json_each(?))',[json(tagIds)]),
  ];
  const floors=await snapshot<Row>(c,'page_sensitivity_floors',['uuid','level'],'uuid IN (SELECT value FROM json_each(?))',[json(selected.map(p=>p.uuid))]);
  if(floors.some(f=>f.level!==1&&f.level!==2))throw new Error('Invalid deletion floor');
  const LINK=['id','uuid','page_id','tag_id'];
  const links=await snapshot<Row>(c,'page_tags',LINK,'page_id IN (SELECT value FROM json_each(?))',[json(selected.map(p=>p.id))]);
  const tagIds=[...new Set(links.map(l=>l.tag_id))];
  const tags=await snapshot<Row>(c,'tags',['id','uuid','taxonomy_slug'],'id IN (SELECT value FROM json_each(?))',[json(tagIds)]);
  if(tags.length!==tagIds.length)throw new Error('Deletion tag identity unavailable');
  const classes=[...tags.map(t=>classFor(authority.policy,'taxonomy',String(t.taxonomy_slug??'default'))),authority.dataClass,...selected.map(p=>classFor(authority.policy,'page_type',String(p.page_type??'default'))),...(declared?[classFor(authority.policy,'page_type',declared)]:[]),...floors.map(f=>f.level===2?'phi':'pii')];
  evidenceClass=classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  await auditBackgroundReads(c.env,[{action:'plugin.page-delete-selection-read',kind:'table',key:'pages',targetType:'page',ids:selected.map(p=>String(p.id)),count:selected.length,minimumClass:evidenceClass==='none'?undefined:evidenceClass,detail:{operation_id:operationId,selector_fingerprint:selectionFingerprint}}],authority.actor);
  await auditBackgroundReads(c.env,['page_sensitivity_floors','page_tags','tags'].map(table=>({action:'plugin.page-delete-selection-metadata-read',kind:'table' as const,key:table,targetType:table,ids:selected.map(p=>String(p.uuid)),count:selected.length,minimumClass:evidenceClass==='none'?undefined:evidenceClass})),authority.actor);
  const forbiddenRow=selected.find(p=>!pageTypeScopeAllows(authority.allowed,String(p.page_type??'')));
  const forbidden=declared&&!pageTypeScopeAllows(authority.allowed,declared)?declared:forbiddenRow?String(forbiddenRow.page_type??''):undefined;
  if(forbidden!==undefined){
   const receipt=serviceMutationAuditEvidence(c.env,{action:'page.delete',entityType:'page_delete_operation',outcome:'denied',detail:{...detail,reason:'forbidden_page_type',page_type:forbidden}},authority.actor,evidenceClass,authority.policy,c);
   await c.env.DB.batch([...selectionCheck(0),receipt.write,receipt.guard,...selectionCheck(0),receipt.guard]);
   return c.json(forbiddenPageTypeBody(auth,String(forbidden??'')),403);
  }
  if(await flushReadAudit(c))throw new Error('Read evidence unavailable');
  if(!selected.length){await c.env.DB.batch(selectionCheck(0));return mode==='single'?c.json({error:'not_found'},404):c.json(mode==='batch'?{ok:true,trashed:0}:{trashed:0,done:true});}
  const intent=serviceMutationAuditEvidence(c.env,{action:'page.delete.intent',entityType:'page_delete_operation',entityId:operationId,detail:{...detail,targets:selected.slice(0,mode==='children'?1000:100)}},authority.actor,evidenceClass,authority.policy,c);
  await c.env.DB.batch([...selectionCheck(0),intent.write,intent.guard,...selectionCheck(0),intent.guard]);
  const targets=selected.slice(0,mode==='children'?1000:100);
  while(acknowledged<targets.length){
   const chunk=targets.slice(acknowledged,acknowledged+100),before=acknowledged,after=acknowledged+chunk.length;
   inFlight=true;
   const result=await trashPagesAsService(c.env,{actor:authority.actor,check:()=>[...authority.check(),intent.guard],allows:type=>pageTypeScopeAllows(authority.allowed,type),dataClass:evidenceClass,request:c,
    detail:{...detail,chunk_index:chunkIndex,acknowledged_before:before,acknowledged_after:after,request_complete:after===targets.length,done:after===total,withdrawal:mode==='children'?'not_requested':'separate_effect'},before:()=>selectionCheck(before),after:()=>selectionCheck(after)},chunk.map(p=>Number(p.id)));
   if(result.count!==chunk.length)throw new Error('Deletion result unavailable');inFlight=false;
   acknowledged=after;chunkIndex++;
   emitPluginHooks(c,'delete',result.pages,auth.pluginId,{evidenceCommitted:true,actor:authority.actor});
   // Preserve the existing external behavior. Local receipts never attest to
   // publication withdrawal or hook delivery; those remain W4b/R4 work.
   if(mode==='single')await unpublishPageFromTargets(c.env,result.pages[0].uuid,!!result.pages[0].submission_origin,authority.actor);
   else if(mode==='batch')await unpublishPagesFromTargets(c.env,result.pages,authority.actor).catch(()=>{});
  }
  return mode==='single'?c.json({ok:true,id:Number(targets[0].id)}):c.json(mode==='batch'?{ok:true,trashed:acknowledged}:{trashed:acknowledged,done:total===acknowledged});
 }catch(error){
  const unknown=inFlight&&!(error instanceof PageLifecycleUnavailableError && error.rollbackKnown);
  // Best effort error evidence cannot turn an unknown commit into a rollback.
  try{const receipt=serviceMutationAuditEvidence(c.env,{action:'page.delete.result',entityType:'page_delete_operation',outcome:'error',detail:{...detail,acknowledged_count:acknowledged,chunk_index:chunkIndex,commit_state:unknown?'unknown':acknowledged===Number(detail.selected_count)?'committed':acknowledged?'prefix_committed':'not_committed',unacknowledged_commit_state:unknown?'unknown':'not_committed'}},authority.actor,evidenceClass,authority.policy,c);await c.env.DB.batch([receipt.write,receipt.guard]);}catch{}
  await recordAuditOutage(c.env,'health',[],authority.actor,undefined,{captureIncomplete:true});throw new ServiceMutationUnavailableError();
 }
}
