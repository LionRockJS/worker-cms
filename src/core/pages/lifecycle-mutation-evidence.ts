import type { Env,JWTPayload } from '../../types';
import type { TrashedPageRef } from '../db/admin-queries';
import type { ContentBatchContext } from './batch-mutation-evidence';
import { captureAccessAuthorization,captureContentJobAuthorization } from '../auth/access-authorization';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../db/data-classes';
import { attributedMutationAuditEvidence } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { auditBackgroundReads } from '../http/access-log';
import { recordAuditOutage } from '../db/audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { eraseSubmissionSources } from './submission-erasure';

const PAGE=['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const TRASH=[...PAGE,'source_page_id'];
const VERSION=['id','uuid','created_at','updated_at','page_id','lect','action'];
const LINK=['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const CONTENT=['name','slug','weight','start','end','timezone','page_type','lect','creator','editors'];
type Row=Record<string,string|number|null>;
type Bind=string|number|null;
/** olderThanDays selects trash rows unchanged for that long (W12 retention). */
export interface LifecycleSelection {ids?:number[];pageType?:string|null;withinLastHour?:boolean;olderThanDays?:number}
export type LifecycleAction='trash'|'restore'|'purge';
export class PageLifecycleUnavailableError extends Error {constructor(){super('Page lifecycle change unavailable');}}
/** A purge reached a page under an active hold (W12). Nothing was changed. */
export class RecordHeldError extends Error {constructor(readonly uuids:string[]){super('Record under hold');}}
const ACTIVE_HOLDS='SELECT page_uuid FROM record_holds WHERE released_at IS NULL';
/** A held trash row and every trash ancestor whose purge would cascade to it. */
const HELD_SUBTREES=`id NOT IN (WITH RECURSIVE up(id,page_id) AS (SELECT id,page_id FROM trash_pages WHERE uuid IN (${ACTIVE_HOLDS})
  UNION SELECT t.id,t.page_id FROM trash_pages t JOIN up ON t.id=up.page_id) SELECT id FROM up)`;
const MIRROR_ACTIONS=['ingest-submission','pull-published'];
function json(value:unknown):string {const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>1_000_000)throw new Error('Lifecycle manifest requires review');return text;}
/** The database checks the budget before returning bodies to the Worker. */
async function snapshot(env:Env,table:string,fields:string[],where:string,bindings:Bind[]=[]):Promise<Row[]> {
  const object=`json_object(${fields.map(f=>`'${f}',r.${f}`).join(',')})`;
  const result=await env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY id LIMIT 5001),
    budget AS (SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 AS bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END AS snapshot FROM budget`).bind(...bindings).first<{snapshot:string}>();
  if(!result)throw new Error('Lifecycle snapshot unavailable');
  const rows=JSON.parse(result.snapshot) as Row[];
  if(fields.includes('id')&&rows.some(r=>!Number.isSafeInteger(r.id)||Number(r.id)<=0))throw new Error('Unsafe lifecycle identity');
  return rows;
}
function guard(env:Env,table:string,fields:string[],where:string,bindings:Bind[],rows:Row[]) {
  return abortIf(env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} p WHERE ${fields.map(f=>`p.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...bindings,rows.length,json(rows)]);
}
function subset(env:Env,table:string,fields:string[],rows:Row[]) {
  return abortIf(env,`EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM ${table} p WHERE
    ${fields.map(f=>`p.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[json(rows)]);
}
function mergeRows(existing:Row[],incoming:Row[],fields:string[]):Row[] {
  const result=[...existing];
  for(const row of incoming){const old=result.find(r=>r.uuid===row.uuid);if(old){if(fields.some(f=>old[f]!==row[f]))throw new Error('Conflicting lifecycle history');}
    else {if(result.some(r=>r.id===row.id))throw new Error('Conflicting lifecycle identity');result.push(row);}}
  json(result);return result;
}
export async function mutatePageLifecycle(env:Env,user:JWTPayload,action:LifecycleAction,selection:LifecycleSelection={},context:ContentBatchContext={}):Promise<{count:number;pages:TrashedPageRef[]}> {
  assertRegulatedWritesAllowed(env);
  try{return await mutate(env,user,action,selection,context);}catch(error){
    if(String(error).includes('sensitivity_reduction_requires_review')||error instanceof RecordHeldError)throw error;
    await recordAuditOutage(env,'health',[],undefined,undefined,{captureIncomplete:true});throw new PageLifecycleUnavailableError();
  }
}
async function mutate(env:Env,user:JWTPayload,action:LifecycleAction,selection:LifecycleSelection,context:ContentBatchContext) {
  if(selection.ids&&(selection.ids.length>5000||selection.ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(selection.ids).size!==selection.ids.length))throw new Error('Invalid lifecycle selection');
  const capability=action==='trash'?'content:delete':action==='restore'?'trash:restore':'trash:purge';
  if(context.job&&action!=='trash')throw new Error('Unsupported lifecycle delegation');
  const job=context.job&&await captureContentJobAuthorization(env,user,context.job.guard,'content:delete');
  const authority=job?.authorization??await captureAccessAuthorization(env,user,capability);if(!authority.allowed)throw new Error('Lifecycle authority unavailable');
  const schema=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_versions','trash_page_tags')").first<{n:number}>();
  if(schema?.n!==3)throw new Error('Trash storage unavailable');
  const policy=await resolveDataClasses(env,true);if(!policy.ok)throw new Error('Lifecycle classification unavailable');
  const clock=await env.DB.prepare("SELECT CURRENT_TIMESTAMP AS now,datetime('now','-1 hour') AS cutoff").first<{now:string;cutoff:string}>();if(!clock)throw new Error('Lifecycle clock unavailable');
  const src=action==='trash'?'pages':'trash_pages';const dst=action==='trash'?'trash_pages':'pages';
  const sf=src==='pages'?PAGE:TRASH;const df=dst==='pages'?PAGE:TRASH;
  const sv=src==='pages'?'page_versions':'trash_page_versions';const sl=src==='pages'?'page_tags':'trash_page_tags';
  const dv=dst==='pages'?'page_versions':'trash_page_versions';const dl=dst==='pages'?'page_tags':'trash_page_tags';
  const conditions=['1'];const params:Bind[]=[];
  if(selection.ids){conditions.push('id IN (SELECT value FROM json_each(?))');params.push(json(selection.ids));}
  if(selection.pageType){conditions.push('page_type=?');params.push(selection.pageType);}
  if(selection.withinLastHour){conditions.push('created_at>=?');params.push(clock.cutoff);}
  if(selection.olderThanDays!==undefined){if(action!=='purge'||!Number.isSafeInteger(selection.olderThanDays)||selection.olderThanDays<=0)throw new Error('Invalid lifecycle selection');
    conditions.push("updated_at<datetime('now',?)");params.push(`-${selection.olderThanDays} days`);}
  // Bulk purges pass over held pages; an explicit purge of one is refused below.
  if(action==='purge'&&!selection.ids)conditions.push(HELD_SUBTREES);
  const selectedWhere=conditions.join(' AND ');
  const selected=await snapshot(env,src,['id'],selectedWhere,params);const selectedIds=selected.map(p=>p.id);
  const recursive=`WITH RECURSIVE picked(id) AS (SELECT id FROM trash_pages WHERE id IN (SELECT value FROM json_each(?))
    UNION SELECT c.id FROM trash_pages c JOIN picked p ON c.page_id=p.id) SELECT id FROM picked`;
  const sourceWhere=action==='purge'?`id IN (${recursive})`:'id IN (SELECT value FROM json_each(?))';
  const sourceParams=[json(selectedIds)];const sources=await snapshot(env,src,sf,sourceWhere,sourceParams);
  const ids=sources.map(p=>p.id);const uuids=sources.map(p=>p.uuid);const idJson=json(ids);const uuidJson=json(uuids);
  const heldWhere=`page_uuid IN (SELECT value FROM json_each(?)) AND page_uuid IN (${ACTIVE_HOLDS})`;
  if(action==='purge'){
    const held=await env.DB.prepare(`SELECT page_uuid FROM record_holds WHERE ${heldWhere}`).bind(uuidJson).all<{page_uuid:string}>();
    if(held.results.length)throw new RecordHeldError(held.results.map(r=>r.page_uuid));
  }
  const base=[authority.guard(),classificationPolicyGuard(env,policy),
    abortIf(env,"(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_versions','trash_page_tags'))<>3"),
    guard(env,src,['id'],selectedWhere,params,selected),guard(env,src,sf,sourceWhere,sourceParams,sources)];
  if(job)base.push(job.delegationGuard);
  // A hold placed after the read above still stops the batch.
  if(action==='purge')base.push(abortIf(env,`EXISTS (SELECT 1 FROM record_holds WHERE ${heldWhere})`,[uuidJson]));
  if(!sources.length){await env.DB.batch(base);return {count:0,pages:[]};}
  for(const page of sources)for(const key of ['page_id','source_page_id'])if(page[key]!=null&&(!Number.isSafeInteger(page[key])||Number(page[key])<=0))throw new Error('Unsafe lifecycle parent');
  const parentIds=[...new Set(sources.flatMap(p=>[p.page_id,p.source_page_id]).filter((id):id is number=>typeof id==='number'))];
  const parentJson=json(parentIds);const subWhere='page_id IN (SELECT value FROM json_each(?))';
  const childFields=sf.filter(f=>f!=='lect');
  const childWhere='page_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))';
  const [versions,links,destinations,children,sourceParents,destinationParents]=await Promise.all([
    snapshot(env,sv,VERSION,subWhere,[idJson]),snapshot(env,sl,LINK,subWhere,[idJson]),
    action==='purge'?Promise.resolve([] as Row[]):snapshot(env,dst,df,'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson]),
    src==='trash_pages'?snapshot(env,src,childFields,childWhere,[idJson,idJson]):Promise.resolve([] as Row[]),
    snapshot(env,src,['id','uuid','page_type'],'id IN (SELECT value FROM json_each(?))',[parentJson]),
    action==='purge'?Promise.resolve([] as Row[]):snapshot(env,dst,['id','uuid','page_type'],`id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT uuid FROM ${src} WHERE id IN (SELECT value FROM json_each(?)))`,[parentJson,parentJson]),
  ]);
  const targetId=(p:Row)=>destinations.find(d=>d.uuid===p.uuid)?.id??p.id;
  const targetIds=sources.map(targetId);const targetJson=json(targetIds);
  const destSubWhere='page_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))';
  const versionArgs=[targetJson,json(versions.map(v=>v.id)),json(versions.map(v=>v.uuid))];
  const linkArgs=[targetJson,json(links.map(l=>l.id)),json(links.map(l=>l.uuid))];
  const [destVersions,destLinks]=action==='purge'?[[],[]] as Row[][]:await Promise.all([snapshot(env,dv,VERSION,destSubWhere,versionArgs),snapshot(env,dl,LINK,destSubWhere,linkArgs)]);
  if([...links,...destLinks].some(l=>!Number.isSafeInteger(l.tag_id)||Number(l.tag_id)<=0||(l.weight!==null&&!Number.isFinite(l.weight))))throw new Error('Unsafe lifecycle link metadata');
  const tagIds=[...new Set([...links,...destLinks].map(l=>l.tag_id))];
  const tags=await snapshot(env,'tags',['id','uuid','taxonomy_slug'],'id IN (SELECT value FROM json_each(?))',[json(tagIds)]);
  if(action==='restore'&&links.some(l=>!tags.some(t=>t.id===l.tag_id)))throw new Error('Restoration tag unavailable');
  const floorUuids=[...new Set([...sources,...destinations,...children,...sourceParents,...destinationParents].map(p=>p.uuid))];
  const floorWhere='uuid IN (SELECT value FROM json_each(?))';
  const floorResult=await env.DB.prepare(`SELECT uuid,level FROM page_sensitivity_floors WHERE ${floorWhere}`).bind(json(floorUuids)).all<{uuid:string;level:number}>();
  const floors=floorResult.results;if(floors.some(f=>f.level!==1&&f.level!==2))throw new Error('Invalid lifecycle sensitivity');
  const classes=[src,sv,sl,...(action==='purge'?[]:[dst,dv,dl]),'tags'].map(t=>classFor(policy,'table',t));
  for(const page of [...sources,...destinations,...children,...sourceParents,...destinationParents])classes.push(classFor(policy,'page_type',String(page.page_type??'default')));
  for(const tag of tags)classes.push(classFor(policy,'taxonomy',String(tag.taxonomy_slug??'default')));
  for(const floor of floors)classes.push(floor.level===2?'phi':'pii');
  const dataClass=classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  const actor={userId:user.sub,roles:user.role,sessionSid:user.sid??null,via:context.job?`job:${context.job.id}`:null};
  for(const [table,rows] of [[src,sources],[dst,destinations]] as Array<[string,Row[]]>) {
    const types=[...new Set(rows.map(p=>String(p.page_type??'default')))];
    await auditBackgroundReads(env,types.map(key=>{const group=rows.filter(p=>(p.page_type??'default')===key);return {action:table==='trash_pages'?'page.trash-lifecycle-read':'page.lifecycle-read',kind:'page_type' as const,key,targetType:'page',ids:group.map(p=>String(p.id)),count:group.length,uuidById:Object.fromEntries(group.map(p=>[String(p.id),String(p.uuid)]))};}),actor);
  }
  base.push(guard(env,sv,VERSION,subWhere,[idJson],versions),guard(env,sl,LINK,subWhere,[idJson],links),
    guard(env,'tags',['id','uuid','taxonomy_slug'],'id IN (SELECT value FROM json_each(?))',[json(tagIds)],tags),
    guard(env,'page_sensitivity_floors',['uuid','level'],floorWhere,[json(floorUuids)],floors),
    guard(env,src,['id','uuid','page_type'],'id IN (SELECT value FROM json_each(?))',[parentJson],sourceParents));
  if(src==='trash_pages')base.push(guard(env,src,childFields,childWhere,[idJson,idJson],children));
  if(action!=='purge')base.push(guard(env,dst,df,'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson],destinations),
    guard(env,dv,VERSION,destSubWhere,versionArgs,destVersions),guard(env,dl,LINK,destSubWhere,linkArgs,destLinks),
    guard(env,dst,['id','uuid','page_type'],`id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT uuid FROM ${src} WHERE id IN (SELECT value FROM json_each(?)))`,[parentJson,parentJson],destinationParents));
  const detached:Row[]=children.map(c=>({...c,page_id:null,source_page_id:action==='restore'?targetId(sources.find(p=>p.id===c.page_id)!):(c.source_page_id??c.page_id)}));
  const mirror=(p:Row)=>versions.some(v=>v.page_id===p.id&&MIRROR_ACTIONS.includes(String(v.action)));
  // Purging a submission mirror erases its published source too (W12).
  const erasures=action==='purge'?sources.filter(mirror).map(p=>String(p.uuid)):[];
  const manifest=sources.map(p=>({id:p.id,uuid:p.uuid,parent_id:p.page_id,...(src==='trash_pages'?{source_parent_id:p.source_page_id}:{}),
    versions:versions.filter(v=>v.page_id===p.id).map(v=>({id:v.id,uuid:v.uuid})),links:links.filter(l=>l.page_id===p.id).map(l=>({id:l.id,uuid:l.uuid,tag_id:l.tag_id,weight:l.weight}))}));
  const detail={operation_id:crypto.randomUUID(),sources:manifest,selected_ids:selectedIds,cascade_ids:ids.filter(id=>!selectedIds.includes(id)),detached_children:children.map(c=>({id:c.id,uuid:c.uuid,parent_id:c.page_id,source_parent_id:c.source_page_id,restored_parent_id:detached.find(d=>d.id===c.id)?.source_page_id})),
    destination_before:destinations.filter(d=>uuids.includes(d.uuid)).map(d=>({id:d.id,uuid:d.uuid})),...(context.job?{job_id:context.job.id,job_attempt:context.job.attempt}:{}),
    ...(erasures.length?{source_erasures:erasures}:{}),...(selection.olderThanDays!==undefined?{retention_days:selection.olderThanDays}:{})};json(detail);
  const receipt=attributedMutationAuditEvidence(env,user,{action:action==='trash'?'page.delete':action==='restore'?(selection.ids?'page.restore':'page.restore_all'):(selection.ids?'page.purge':'page.purge_all'),entityType:'page',...(sources.length===1?{entityId:String(sources[0].uuid)}:{}),detail},dataClass,policy,{context:context.request,via:actor.via??undefined,targetIds:uuids.map(String)});
  const statements=[...base];
  let expectedDest:Row[]=[];let expectedVersions:Row[]=[];let expectedLinks:Row[]=[];
  const parentRefs:Row[]=[];
  if(action!=='purge') {
    const projected=sources.map(p=>{
      const old=destinations.find(d=>d.uuid===p.uuid);
      const original=action==='restore'?(p.source_page_id??p.page_id):p.page_id;
      const parent=sourceParents.find(r=>r.id===p.page_id)??sourceParents.find(r=>r.id===original);
      const selectedParent=parent&&sources.find(r=>r.uuid===parent.uuid);
      const targetParent=selectedParent?{id:targetId(selectedParent),uuid:selectedParent.uuid}:destinationParents.find(r=>parent?r.uuid===parent.uuid:r.id===original);
      if(targetParent)parentRefs.push(targetParent);
      const row:Row={id:targetId(p),uuid:p.uuid,created_at:old?.created_at??clock.now,updated_at:clock.now,page_id:targetParent?.id??null};
      for(const field of CONTENT)row[field]=p[field];if(action==='trash')row.source_page_id=p.page_id;return row;
    });
    expectedDest=[...destinations.filter(d=>!uuids.includes(d.uuid)),...projected];json(expectedDest);
    const mapOwner=(r:Row)=>targetId(sources.find(p=>p.id===r.page_id)!);
    const versionIncoming=versions.map(v=>({...v,page_id:mapOwner(v),id:destVersions.find(d=>d.uuid===v.uuid)?.id??v.id}));
    const linkIncoming=links.map(l=>({...l,page_id:mapOwner(l),id:destLinks.find(d=>d.uuid===l.uuid)?.id??l.id}));
    expectedVersions=mergeRows(destVersions,versionIncoming,['uuid','created_at','page_id','lect','action']);expectedLinks=mergeRows(destLinks,linkIncoming,['uuid','page_id','tag_id','weight']);
    statements.push(env.DB.prepare(`INSERT INTO ${dst} (id,uuid,created_at,updated_at,${CONTENT.join(',')},page_id${action==='trash'?',source_page_id':''})
      SELECT COALESCE((SELECT d.id FROM ${dst} d WHERE d.uuid=s.uuid),s.id),s.uuid,COALESCE((SELECT d.created_at FROM ${dst} d WHERE d.uuid=s.uuid),?),?,
      ${CONTENT.map(f=>`s.${f}`).join(',')},NULL${action==='trash'?',s.page_id':''} FROM ${src} s WHERE s.id IN (SELECT value FROM json_each(?))
      ON CONFLICT(uuid) DO UPDATE SET ${CONTENT.map(f=>`${f}=excluded.${f}`).join(',')},updated_at=excluded.updated_at${action==='trash'?',source_page_id=excluded.source_page_id':''}`).bind(clock.now,clock.now,idJson),
      abortIf(env,'changes()<>?',[sources.length]),
      env.DB.prepare(`UPDATE ${dst} SET page_id=json_extract(e.value,'$.page_id') FROM json_each(?) e WHERE ${dst}.uuid=json_extract(e.value,'$.uuid')`).bind(json(projected)),abortIf(env,'changes()<>?',[sources.length]),
      env.DB.prepare(`INSERT INTO ${dv} (${VERSION.join(',')}) SELECT COALESCE((SELECT d.id FROM ${dv} d WHERE d.uuid=s.uuid),s.id),s.uuid,s.created_at,s.updated_at,d.id,s.lect,s.action
        FROM ${sv} s JOIN ${src} p ON p.id=s.page_id JOIN ${dst} d ON d.uuid=p.uuid WHERE s.page_id IN (SELECT value FROM json_each(?)) ON CONFLICT(uuid) DO NOTHING`).bind(idJson),
      env.DB.prepare(`INSERT INTO ${dl} (${LINK.join(',')}) SELECT COALESCE((SELECT d.id FROM ${dl} d WHERE d.uuid=s.uuid),s.id),s.uuid,s.created_at,s.updated_at,d.id,s.tag_id,s.weight
        FROM ${sl} s JOIN ${src} p ON p.id=s.page_id JOIN ${dst} d ON d.uuid=p.uuid WHERE s.page_id IN (SELECT value FROM json_each(?)) ON CONFLICT(uuid) DO NOTHING`).bind(idJson));
  }
  if(src==='trash_pages') {
    statements.push(env.DB.prepare('UPDATE trash_pages SET page_id=NULL WHERE id IN (SELECT value FROM json_each(?))').bind(idJson),abortIf(env,'changes()<>?',[sources.length]));
    if(detached.length)statements.push(env.DB.prepare(`UPDATE trash_pages SET page_id=NULL,source_page_id=json_extract(e.value,'$.source_page_id')
      FROM json_each(?) e WHERE trash_pages.id=json_extract(e.value,'$.id')`).bind(json(detached.map(c=>({id:c.id,source_page_id:c.source_page_id})))),abortIf(env,'changes()<>?',[detached.length]));
  }
  statements.push(env.DB.prepare(`DELETE FROM ${sv} WHERE ${subWhere}`).bind(idJson),abortIf(env,'changes()<>?',[versions.length]),
    env.DB.prepare(`DELETE FROM ${sl} WHERE ${subWhere}`).bind(idJson),abortIf(env,'changes()<>?',[links.length]),
    env.DB.prepare(`DELETE FROM ${src} WHERE id IN (SELECT value FROM json_each(?))`).bind(idJson),abortIf(env,'changes()<>?',[sources.length]),
    receipt.write,receipt.guard,
    ...(erasures.length?[env.DB.prepare('INSERT INTO submission_erasures (uuid) SELECT value FROM json_each(?) WHERE true ON CONFLICT(uuid) DO NOTHING').bind(json(erasures))]:[]),
    guard(env,src,sf,'id IN (SELECT value FROM json_each(?))',[idJson],[]),guard(env,sv,VERSION,subWhere,[idJson],[]),guard(env,sl,LINK,subWhere,[idJson],[]));
  if(action!=='purge')statements.push(guard(env,dst,df.filter(f=>f!=='updated_at'),'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson],expectedDest),
    guard(env,dv,VERSION,destSubWhere,versionArgs,expectedVersions),guard(env,dl,LINK,destSubWhere,linkArgs,expectedLinks),subset(env,dst,['id','uuid'],parentRefs));
  if(children.length)statements.push(subset(env,src,childFields.filter(f=>f!=='updated_at'),detached));
  statements.push(classificationPolicyGuard(env,policy),authority.guard(),
    abortIf(env,`EXISTS (SELECT 1 FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) AND level>?)
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=json_extract(e.value,'$.uuid')),0)<json_extract(e.value,'$.level'))`,[json(floorUuids),dataClass==='phi'?2:dataClass==='pii'?1:0,json(floors)]));
  if(job)statements.push(job.delegationGuard);
  await env.DB.batch(statements);
  // The purge has committed with the erasure recorded; a failure here leaves it pending for cron.
  if(erasures.length)await eraseSubmissionSources(env).catch(()=>console.error(JSON.stringify({event:'submission.erasure-pending',count:erasures.length})));
  return {count:sources.length,pages:sources.map(p=>({id:Number(p.id),uuid:String(p.uuid),name:String(p.name),slug:String(p.slug),page_type:p.page_type as string|null,
    submission_origin:mirror(p)?1:0}))};
}
