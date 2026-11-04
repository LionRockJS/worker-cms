import type { AppContext } from '../../core/http/context';
import type { Page } from '../../types';
import type { DuplicateInput, PluginAuth } from './api/types';
import type { PluginPageMutationAuthority as Authority } from './page-update-evidence';
import { assertPluginPageAuthority } from './page-update-evidence';
import { PluginPageCreateUnavailableError, preparePluginPageCreates, commitPluginPageCreates, recordPluginCreateReservationRefusal, recordPluginCreateFailure, type PluginPageCopyEvidence } from './page-create-evidence';
import { snapshot, guard, fingerprint, json, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { classFor } from '../../core/db/data-classes';
import { auditBackgroundReads, auditReads, flushReadAudit } from '../../core/http/access-log';
import { countPageMetadata } from '../../core/db/count-metadata';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { blueprintToLect, mergeLects, safeParseLect, stringifyLect } from '../../core/db/lect';
import { withDraftMetadata } from '../../core/db/page-logic';
import { resolveCmsConfig } from '../../core/db/content-config';
import { slugify } from '../../core/http/forms';
import { pageTypeScopeAllows } from './page-types';
import { asFiniteNumber, coerceLect, collectionWhere, hasSubmittedValue } from './api/serialize';
import { forbiddenPageTypeBody } from './api/auth';
import { actingUserId, generatedPageIds, existingSlugSet, allocateSlug } from './api/create';
import { emitPluginHooks } from './api/hooks';
import { reservePageCreates, type FeatureReservation } from '../services';

const BATCH=100,MAX_COPIES=1000;
const PAGE=['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const LINK=['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const TAG=['id','uuid','taxonomy_slug'];
type Class='none'|'pii'|'phi';
function maximum(values:Array<Class|null|undefined>):Class{return values.includes('phi')?'phi':values.includes('pii')?'pii':'none';}

/** A single bounded read set includes the 1,001st look-ahead row. Guards
 * exclude this operation's own clone UUIDs, so inherited selectors cannot
 * recursively consume the newly inserted copies within the same call. */
async function sources(c:AppContext,authority:Authority,selector:{sql:string;params:unknown[]},pageType:string,cursor:number,operationId:string){
  const args=selector.params.map(value=>{if(typeof value==='string'||typeof value==='number'||value===null)return value;throw new Error('Invalid selector binding');});
  const where=`${selector.sql} AND page_type=? AND id>?`,bindings=[...args,pageType,cursor];
  const selectorFingerprint=await fingerprint(json({where,bindings}));
  const count=await countPageMetadata(c.env.DB,where,bindings,{types:[pageType],action:'page.duplicate-count'});
  if(!Number.isSafeInteger(count)||count<0)throw new Error('Unsafe source count');
  const selected=`id IN (SELECT id FROM pages WHERE ${where} ORDER BY id LIMIT ${MAX_COPIES+1})`;
  const pages=await snapshot<Page>(c,'pages',PAGE,selected,bindings);
  if(pages.length!==Math.min(count,MAX_COPIES+1))throw new Error('Source count changed');
  const ids=[json(pages.map(page=>page.id))],uuids=[json(pages.map(page=>page.uuid))];
  const links=await snapshot<Row>(c,'page_tags',LINK,'page_id IN (SELECT value FROM json_each(?))',ids);
  const tagArgs=[json([...new Set(links.map(link=>link.tag_id))])];
  const tags=await snapshot<Row>(c,'tags',TAG,'id IN (SELECT value FROM json_each(?))',tagArgs);
  if(tags.length!==new Set(links.map(link=>link.tag_id)).size)throw new Error('Source association unavailable');
  const floors=await snapshot<Row>(c,'page_sensitivity_floors',['uuid','level'],'uuid IN (SELECT value FROM json_each(?))',uuids);
  if(floors.some(floor=>floor.level!==1&&floor.level!==2))throw new Error('Source floor invalid');
  const bodyClass=(page:Page)=>maximum([
    ...['pages','page_tags','tags','taxonomies'].map(table=>classFor(authority.policy,'table',table)),classFor(authority.policy,'page_type',pageType),
    ...tags.filter(tag=>links.some(link=>link.page_id===page.id&&link.tag_id===tag.id)).map(tag=>classFor(authority.policy,'taxonomy',String(tag.taxonomy_slug??'default'))),
    floors.find(floor=>floor.uuid===page.uuid)?.level===2?'phi':floors.find(floor=>floor.uuid===page.uuid)?.level===1?'pii':undefined]);
  const dataClass=maximum([authority.dataClass,...pages.map(bodyClass)]),minimum=dataClass==='none'?undefined:dataClass;
  await auditBackgroundReads(c.env,[{action:'plugin.page-duplicate-source-read',kind:'page_type',key:pageType,targetType:'page',ids:pages.map(page=>String(page.id)),uuidById:Object.fromEntries(pages.map(page=>[String(page.id),page.uuid])),count:pages.length,minimumClass:minimum,detail:{operation:'duplicate',operation_id:operationId,phase:'source_capture',selector_fingerprint:selectorFingerprint}},
    ...['page_tags','tags','page_sensitivity_floors'].map(table=>({action:'plugin.page-duplicate-metadata-read',kind:'table' as const,key:table,targetType:table,ids:table==='page_tags'?links.map(row=>String(row.id)):table==='tags'?tags.map(row=>String(row.id)):floors.map(row=>String(row.uuid)),count:table==='page_tags'?links.length:table==='tags'?tags.length:floors.length,minimumClass:minimum}))],authority.actor);
  if(await flushReadAudit(c))throw new Error('Source evidence unavailable');
  const check=(clones:string[])=>{
    const excluded=json(clones),scope=`${where} AND uuid NOT IN (SELECT value FROM json_each(?))`,scopeArgs=[...bindings,excluded];
    return [...authority.check(),guard(c,'pages',PAGE,pages,`id IN (SELECT id FROM pages WHERE ${scope} ORDER BY id LIMIT ${MAX_COPIES+1})`,scopeArgs),
      abortIf(c.env,`(SELECT COUNT(*) FROM pages WHERE ${scope})<>?`,[...scopeArgs,count]),
      guard(c,'page_tags',LINK,links,'page_id IN (SELECT value FROM json_each(?))',ids),guard(c,'tags',TAG,tags,'id IN (SELECT value FROM json_each(?))',tagArgs),
      guard(c,'page_sensitivity_floors',['uuid','level'],floors,'uuid IN (SELECT value FROM json_each(?))',uuids)];
  };
  return {pages,count,dataClass,bodyClass,check,selectorFingerprint};
}

export async function duplicatePluginPages(c:AppContext,auth:PluginAuth,authority:Authority,body:DuplicateInput):Promise<Response>{
  assertRegulatedWritesAllowed(c.env);
  try{return await duplicate(c,auth,authority,body);}catch(error){
    if(error instanceof PluginPageCreateUnavailableError)throw error;
    await recordAuditOutage(c.env,'health',[],authority.actor,undefined,{captureIncomplete:true});throw new PluginPageCreateUnavailableError(false);
  }
}
async function duplicate(c:AppContext,auth:PluginAuth,authority:Authority,body:DuplicateInput):Promise<Response>{
  assertPluginPageAuthority(authority,'duplicate');
  const pageType=typeof body.source_page_type==='string'?body.source_page_type.trim():'';
  if(!pageType)return c.json({error:'source_page_type_required'},400);
  const operationId=crypto.randomUUID();
  if(!pageTypeScopeAllows(authority.allowed,pageType)){
    await preparePluginPageCreates(c,authority,[],[pageType],{operationId,sources:[],check:()=>[],dataClass:authority.dataClass,detail:{}});
    return c.json(forbiddenPageTypeBody(auth,pageType),403);
  }
  const sourceParent=asFiniteNumber(body.source_page_id),targetParent=asFiniteNumber(body.target_page_id);
  if((hasSubmittedValue(body.source_page_id)&&sourceParent===null)||(hasSubmittedValue(body.target_page_id)&&targetParent===null))return c.json({error:'invalid_page_id'},400);
  if((sourceParent!==null&&(!Number.isSafeInteger(sourceParent)||sourceParent<=0))||(targetParent!==null&&(!Number.isSafeInteger(targetParent)||targetParent<=0)))return c.json({error:'invalid_page_id'},400);
  const selector=collectionWhere(sourceParent,typeof body.source_pointer_key==='string'?body.source_pointer_key.trim():'',typeof body.source_pointer_value==='string'?body.source_pointer_value:'');
  if(!selector.ok)return c.json({error:selector.error},400);
  const parsedCursor=asFiniteNumber(body.cursor);
  if(hasSubmittedValue(body.cursor)&&parsedCursor===null)return c.json({error:'invalid_cursor'},400);
  const cursor=Math.max(parsedCursor??0,0);
  if(!Number.isSafeInteger(cursor))return c.json({error:'invalid_cursor'},400);
  const observed=await sources(c,authority,selector,pageType,cursor,operationId);
  const selected=observed.pages.slice(0,MAX_COPIES);
  const config=await resolveCmsConfig(c.env),seed=blueprintToLect(pageType,config.blueprint,config.defaultLanguage),overrides=coerceLect(body.lect);
  const dropKeys=Array.isArray(body.drop_lect)?body.drop_lect.filter((key):key is string=>typeof key==='string'):[];
  const transformFingerprint=await fingerprint(json({overrides,dropKeys,targetParent}));
  const ids=await generatedPageIds(c.env.DB,selected.length,new Set(selected.map(page=>page.id)));
  const slugs=await existingSlugSet(c.env.DB,selected.map(page=>slugify(page.slug)||slugify(page.name)||pageType));
  const plans=selected.map((page,index)=>{
    const lect=safeParseLect(page.lect);for(const key of dropKeys)delete lect[key];
    return {id:ids[index],uuid:crypto.randomUUID(),pageType,name:page.name,baseSlug:slugify(page.slug)||slugify(page.name)||pageType,slug:allocateSlug(slugify(page.slug)||slugify(page.name)||pageType,slugs),lect:stringifyLect(withDraftMetadata(mergeLects(seed,mergeLects(lect,overrides)),0)),weight:page.weight??5,start:page.start,end:page.end,timezone:page.timezone,parentId:targetParent,tags:[]};
  });
  const provenance:PluginPageCopyEvidence={operationId,sources:plans.map((plan,index)=>({targetUuid:plan.uuid,id:selected[index].id,uuid:selected[index].uuid,floor:observed.bodyClass(selected[index])==='phi'?2:observed.bodyClass(selected[index])==='pii'?1:0})),check:()=>observed.check(plans.map(plan=>plan.uuid)),dataClass:observed.dataClass,detail:{selector_fingerprint:observed.selectorFingerprint,transform_fingerprint:transformFingerprint,source_cursor:cursor,source_count:observed.count,request_cap:MAX_COPIES}};
  const source=await preparePluginPageCreates(c,authority,plans,[],provenance);
  if(source.violation)return c.json({error:'limit_exceeded',violation:source.violation},409);
  if(!plans.length)return c.json({count:0,next_cursor:null,done:true});
  let reservation:FeatureReservation|undefined,copied=0,acknowledgedCursor=cursor,chunkIndex=0;
  let inFlight=false;
  try{
    reservation=await reservePageCreates(c.env,{pageTypes:[{pageType,count:plans.length}],payerUserId:actingUserId(c),contributorId:auth.pluginId,operationId});
    if(!reservation.ok){await recordPluginCreateReservationRefusal(c,source,reservation.code);return c.json({error:reservation.code,...(reservation.details??{})},reservation.status);}
    while(copied<plans.length){
      const rows=observed.pages.slice(copied,copied+BATCH+1),chunk=plans.slice(copied,copied+BATCH);
      await auditReads(c,[{action:'page.duplicate-read',kind:'page_type',key:pageType,targetType:'page',ids:rows.map(page=>String(page.id)),count:rows.length,uuidById:Object.fromEntries(rows.map(page=>[String(page.id),page.uuid])),actor:authority.actor,minimumClass:observed.dataClass==='none'?undefined:observed.dataClass,detail:{operation:'duplicate',operation_id:operationId,phase:'intent',chunk_index:chunkIndex,source_cursor:acknowledgedCursor}}],true);
      inFlight=true;const saved=await commitPluginPageCreates(c,source,reservation.charged,chunk);inFlight=false;
      copied+=chunk.length;acknowledgedCursor=selected[copied-1].id;chunkIndex++;
      emitPluginHooks(c,'create',saved.map(page=>({id:page.id,uuid:page.uuid,page_type:page.page_type,name:page.name,slug:page.slug})),auth.pluginId,{evidenceCommitted:true,actor:authority.actor});
    }
  }catch(error){
    const known=error instanceof PluginPageCreateUnavailableError?error.rollbackKnown:!inFlight;
    let refundState=reservation?.ok?'not_required':reservation?'refused':'reservation_unconfirmed';
    if(reservation?.ok&&reservation.charged>0&&copied<plans.length){
      refundState='withheld_commit_unknown';
      if(known){try{await reservation.refund((plans.length-copied)/plans.length);refundState='attempted';}catch{refundState='unconfirmed';}}
    }
    await recordPluginCreateFailure(c,source,known,refundState,{acknowledged_count:copied,acknowledged_cursor:acknowledgedCursor,chunk_index:chunkIndex});
    throw error instanceof PluginPageCreateUnavailableError?error:new PluginPageCreateUnavailableError(known);
  }
  const done=observed.pages.length<=MAX_COPIES;
  return c.json({count:copied,next_cursor:done?null:acknowledgedCursor,done});
}
