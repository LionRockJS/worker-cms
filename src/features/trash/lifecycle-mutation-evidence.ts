import { ACTIVE_HOLD } from '../../core/db/record-holds';
import { legacyPageFilter, pageAccessFilter, pageAccessGuard } from '../../core/auth/page-access';
import type { Env,JWTPayload } from '../../types';
import { PageLifecycleUnavailableError, type ServiceTrashAuthority, type TrashedPageRef } from '../../core/pages/trash-lifecycle';
import type { ContentBatchContext } from '../../core/evidence/batch-mutation-evidence';
import { captureAccessAuthorization,captureContentJobAuthorization } from '../../core/auth/access-authorization';
import { classFor,classificationPolicyGuard,strongestClass,type DataClassMap } from '../../core/db/data-classes';
import type { AuditActor, AuditEntry } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { guard, json, snapshot, snapshotRows, snapshotStatement } from '../../core/db/bounded-mutation';
import { beginAttributedAuditedMutation, beginServiceAuditedMutation, type MutationGroup, type PlannedWrite } from '../../core/evidence/audited-mutation';
import { auditBackgroundReads } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { publication } from '../services';

const PAGE=['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const TRASH=[...PAGE,'source_page_id'];
const VERSION=['id','uuid','created_at','updated_at','page_id','lect','action'];
const LINK=['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const CONTENT=['name','slug','weight','start','end','timezone','page_type','lect','creator','editors'];
type Row=Record<string,string|number|null>;
type Bind=string|number|null;
/** olderThanDays selects trash rows unchanged for that long (W12 retention). */
export interface LifecycleSelection {ids?:number[];pageType?:string|null;withinLastHour?:boolean;olderThanDays?:number}
export async function trashPagesAsService(env:Env,service:ServiceTrashAuthority,ids:number[]) {
  assertRegulatedWritesAllowed(env);
  try {
    return await mutate(env,null,'trash',{ids},{request:service.request},service);
  } catch (error) {
    if (error instanceof PageLifecycleUnavailableError) throw error;
    await recordAuditOutage(env,'health',[],service.actor,undefined,{captureIncomplete:true});
    throw new PageLifecycleUnavailableError(true);
  }
}
export type LifecycleAction='trash'|'restore'|'purge';
/** A purge reached a page under an active hold (W12). Nothing was changed. */
export class RecordHeldError extends Error {constructor(readonly uuids:string[]){super('Record under hold');}}
const ACTIVE_HOLDS=`SELECT page_uuid FROM record_holds WHERE ${ACTIVE_HOLD}`;
/** A held trash row and every trash ancestor whose purge would cascade to it. */
const HELD_SUBTREES=`id NOT IN (WITH RECURSIVE up(id,page_id) AS (SELECT id,page_id FROM trash_pages WHERE uuid IN (${ACTIVE_HOLDS})
  UNION SELECT t.id,t.page_id FROM trash_pages t JOIN up ON t.id=up.page_id) SELECT id FROM up)`;
const MIRROR_ACTIONS=['ingest-submission','pull-published'];
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
/** Each dependent read set shares a policy check and one D1 round trip. */
async function snapshotSet(env: Env, policy: DataClassMap, queries: Array<[string, string[], string, Bind[]] | null>) {
  const [, ...results] = await env.DB.batch<{ snapshot: string }>([
    classificationPolicyGuard(env, policy),
    ...queries.flatMap(query => query ? [snapshotStatement({ env }, ...query)] : []),
  ]);
  let index = 0;
  return queries.map(query => query ? snapshotRows<Row>(query[1], results[index++].results[0]) : []);
}
export async function mutatePageLifecycle(env:Env,user:JWTPayload,action:LifecycleAction,selection:LifecycleSelection={},context:ContentBatchContext={}):Promise<{count:number;pages:TrashedPageRef[]}> {
  assertRegulatedWritesAllowed(env);
  try{return await mutate(env,user,action,selection,context);}catch(error){
    if(String(error).includes('sensitivity_reduction_requires_review') || error instanceof RecordHeldError)throw error;
    await recordAuditOutage(env,'health',[],undefined,undefined,{captureIncomplete:true});throw new PageLifecycleUnavailableError();
  }
}
async function mutate(env:Env,user:JWTPayload|null,action:LifecycleAction,selection:LifecycleSelection,context:ContentBatchContext,service?:ServiceTrashAuthority) {
  if(selection.ids&&(selection.ids.length>5000||selection.ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(selection.ids).size!==selection.ids.length))throw new Error('Invalid lifecycle selection');
  const capability=action==='trash'?'content:delete':action==='restore'?'trash:restore':'trash:purge';
  if(context.job&&action!=='trash')throw new Error('Unsupported lifecycle delegation');
  const job=context.job&&user&&await captureContentJobAuthorization(env,user,context.job.guard,'content:delete');
  const authority=service?null:job?.authorization??(user&&await captureAccessAuthorization(env,user,capability));if(!service&&!authority?.allowed)throw new Error('Lifecycle authority unavailable');
  if(service&&(action!=='trash'||!selection.ids||selection.ids.length>100||context.job))throw new Error('Invalid service trash operation');
  const checks=()=>service?service.check():[authority!.guard()];
  const policy=service?.policy??authority!.policy;
  if(!policy.ok)throw new Error('Lifecycle classification unavailable');
  const via=context.job?`job:${context.job.id}`:undefined;
  const snapshotSpec={classify:[],snapshot:{}};
  const mutation = service
    ? await beginServiceAuditedMutation(service.request, {
      ...snapshotSpec,
      unavailable: (error, submitted) => new PageLifecycleUnavailableError(
        !submitted || (error instanceof Error && /^D1_ERROR:.*SQLITE_/s.test(error.message)),
      ),
    }, { policy, check: checks, actor: service.actor })
    : await beginAttributedAuditedMutation(env,snapshotSpec,{policy,check:checks},{user:user!,via,request:context.request});
  const schemaCount="(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_versions','trash_page_tags'))";
  const clock=await env.DB.prepare(`SELECT ${schemaCount} AS n,CURRENT_TIMESTAMP AS now,datetime('now','-1 hour') AS cutoff`).first<{n:number;now:string;cutoff:string}>();
  if(clock?.n!==3)throw new Error('Trash storage unavailable');
  const src=action==='trash'?'pages':'trash_pages';const dst=action==='trash'?'trash_pages':'pages';
  const sf=src==='pages'?PAGE:TRASH;const df=dst==='pages'?PAGE:TRASH;
  const sv=src==='pages'?'page_versions':'trash_page_versions';const sl=src==='pages'?'page_tags':'trash_page_tags';
  const dv=dst==='pages'?'page_versions':'trash_page_versions';const dl=dst==='pages'?'page_tags':'trash_page_tags';
  const access = user ? pageAccessFilter(user, 'write', `${src}.uuid`, true)
    : { sql: legacyPageFilter(`${src}.uuid`), args: [] };
  const conditions=[access.sql];const params:Bind[]=[...access.args];
  if(selection.ids){conditions.push('id IN (SELECT value FROM json_each(?))');params.push(json(selection.ids));}
  if(selection.pageType){conditions.push('page_type=?');params.push(selection.pageType);}
  if(selection.withinLastHour){conditions.push('created_at>=?');params.push(clock.cutoff);}
  if(selection.olderThanDays!==undefined){if(action!=='purge'||!Number.isSafeInteger(selection.olderThanDays)||selection.olderThanDays<=0)throw new Error('Invalid lifecycle selection');
    conditions.push("updated_at<datetime('now',?)");params.push(`-${selection.olderThanDays} days`);}
  // Bulk purges pass over held pages; an explicit purge of one is refused below.
  if(action==='purge'&&!selection.ids)conditions.push(HELD_SUBTREES);
  const selectedWhere=conditions.join(' AND ');
  const selected=await snapshot<Row>({env},src,['id'],selectedWhere,params);const selectedIds=selected.map(p=>p.id);
  const recursive=`WITH RECURSIVE picked(id) AS (SELECT id FROM trash_pages WHERE id IN (SELECT value FROM json_each(?))
    UNION SELECT c.id FROM trash_pages c JOIN picked p ON c.page_id=p.id) SELECT id FROM picked`;
  const sourceWhere=action==='purge'?`id IN (${recursive})`:'id IN (SELECT value FROM json_each(?))';
  const sourceParams=[json(selectedIds)];const sources=await snapshot<Row>({env},src,sf,sourceWhere,sourceParams);
  const ids=sources.map(p=>p.id);const uuids=sources.map(p=>p.uuid);const idJson=json(ids);const uuidJson=json(uuids);
  const heldWhere=`page_uuid IN (SELECT value FROM json_each(?)) AND page_uuid IN (${ACTIVE_HOLDS})`;
  if(action==='purge'){
    const held=await env.DB.prepare(`SELECT page_uuid FROM record_holds WHERE ${heldWhere}`).bind(uuidJson).all<{page_uuid:string}>();
    if(held.results.length)throw new RecordHeldError(held.results.map(r=>r.page_uuid));
  }
  if(service&&sources.some(p=>!service.allows(String(p.page_type??''))))throw new Error('Service trash scope changed');
  const base=[...(service?.before?.()??[]),abortIf(env,`${schemaCount}<>3`),
    guard({env},src,['id'],selected,selectedWhere,params),guard({env},src,sf,sources,sourceWhere,sourceParams)];
  if (user) base.push(pageAccessGuard(env, user, uuids.map(String), true));
  if(job)base.push(job.delegationGuard);
  // A hold placed after the read above still stops the batch.
  if(action==='purge')base.push(abortIf(env,`EXISTS (SELECT 1 FROM record_holds WHERE ${heldWhere})`,[uuidJson]));
  if(!sources.length){
    await mutation.commit(()=>({admit:base,groups:[],expect:service?.after?.()??[]}));
    return {count:0,pages:[]};
  }
  for(const page of sources)for(const key of ['page_id','source_page_id'])if(page[key]!=null&&(!Number.isSafeInteger(page[key])||Number(page[key])<=0))throw new Error('Unsafe lifecycle parent');
  const parentIds=[...new Set(sources.flatMap(p=>[p.page_id,p.source_page_id]).filter((id):id is number=>typeof id==='number'))];
  const parentJson=json(parentIds);const subWhere='page_id IN (SELECT value FROM json_each(?))';
  const childFields=sf.filter(f=>f!=='lect');
  const childWhere='page_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))';
  const [versions,links,destinations,children,sourceParents,destinationParents]=await snapshotSet(env,policy,[
    [sv,VERSION,subWhere,[idJson]],[sl,LINK,subWhere,[idJson]],
    action==='purge'?null:[dst,df,'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson]],
    src==='trash_pages'?[src,childFields,childWhere,[idJson,idJson]]:null,
    [src,['id','uuid','page_type'],'id IN (SELECT value FROM json_each(?))',[parentJson]],
    action==='purge'?null:[dst,['id','uuid','page_type'],`id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT uuid FROM ${src} WHERE id IN (SELECT value FROM json_each(?)))`,[parentJson,parentJson]],
  ]);
  const targetId=(p:Row)=>destinations.find(d=>d.uuid===p.uuid)?.id??p.id;
  const targetIds=sources.map(targetId);const targetJson=json(targetIds);
  const destSubWhere='page_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))';
  const versionArgs=[targetJson,json(versions.map(v=>v.id)),json(versions.map(v=>v.uuid))];
  const linkArgs=[targetJson,json(links.map(l=>l.id)),json(links.map(l=>l.uuid))];
  const [destVersions,destLinks]=action==='purge'?[[],[]] as Row[][]:await snapshotSet(env,policy,[[dv,VERSION,destSubWhere,versionArgs],[dl,LINK,destSubWhere,linkArgs]]);
  if([...links,...destLinks].some(l=>!Number.isSafeInteger(l.tag_id)||Number(l.tag_id)<=0||(l.weight!==null&&!Number.isFinite(l.weight))))throw new Error('Unsafe lifecycle link metadata');
  const tagIds=[...new Set([...links,...destLinks].map(l=>l.tag_id))];
  const floorUuids=[...new Set([...sources,...destinations,...children,...sourceParents,...destinationParents].map(p=>p.uuid))];
  const floorWhere='uuid IN (SELECT value FROM json_each(?))';
  const [, tagResult, floorResult] = await env.DB.batch<{ snapshot: string; uuid: string; level: number }>([
    classificationPolicyGuard(env,policy),
    snapshotStatement({env},'tags',['id','uuid','taxonomy_slug'],'id IN (SELECT value FROM json_each(?))',[json(tagIds)]),
    env.DB.prepare(`SELECT uuid,level FROM page_sensitivity_floors WHERE ${floorWhere}`).bind(json(floorUuids)),
  ]);
  const tags=snapshotRows<Row>(['id','uuid','taxonomy_slug'],tagResult.results[0]);
  if(action==='restore'&&links.some(l=>!tags.some(t=>t.id===l.tag_id)))throw new Error('Restoration tag unavailable');
  const floors=floorResult.results.map(({uuid,level})=>({uuid,level}));
  if(floors.some(f=>f.level!==1&&f.level!==2))throw new Error('Invalid lifecycle sensitivity');
  const classes=[src,sv,sl,...(action==='purge'?[]:[dst,dv,dl]),'tags'].map(t=>classFor(policy,'table',t));
  for(const page of [...sources,...destinations,...children,...sourceParents,...destinationParents])classes.push(classFor(policy,'page_type',String(page.page_type??'default')));
  for(const tag of tags)classes.push(classFor(policy,'taxonomy',String(tag.taxonomy_slug??'default')));
  for(const floor of floors)classes.push(floor.level===2?'phi':'pii');
  if(service&&service.dataClass!=='none')classes.push(service.dataClass);
  const dataClass=strongestClass(classes);
  const actor:AuditActor=service?.actor??{userId:user!.sub,roles:user!.role,sessionSid:user!.sid??null,via:via??null};
  for(const [table,rows] of [[src,sources],[dst,destinations]] as Array<[string,Row[]]>) {
    const types=[...new Set(rows.map(p=>String(p.page_type??'default')))];
    await auditBackgroundReads(env,types.map(key=>{const group=rows.filter(p=>(p.page_type??'default')===key);return {action:table==='trash_pages'?'page.trash-lifecycle-read':'page.lifecycle-read',kind:'page_type' as const,key,targetType:'page',ids:group.map(p=>String(p.id)),count:group.length,...(service&&dataClass!=='none'?{minimumClass:dataClass}:{}),uuidById:Object.fromEntries(group.map(p=>[String(p.id),String(p.uuid)]))};}),actor,{policy});
  }
  if(service)await auditBackgroundReads(env,[sv,sl,dv,dl,'tags','page_sensitivity_floors'].map(table=>({action:'page.delete-metadata-read',kind:'table' as const,key:table,targetType:table,ids:uuids.map(String),count:sources.length,minimumClass:dataClass==='none'?undefined:dataClass})),actor,{policy});
  base.push(guard({env},sv,VERSION,versions,subWhere,[idJson]),guard({env},sl,LINK,links,subWhere,[idJson]),
    guard({env},'tags',['id','uuid','taxonomy_slug'],tags,'id IN (SELECT value FROM json_each(?))',[json(tagIds)]),
    guard({env},'page_sensitivity_floors',['uuid','level'],floors,floorWhere,[json(floorUuids)]),
    guard({env},src,['id','uuid','page_type'],sourceParents,'id IN (SELECT value FROM json_each(?))',[parentJson]));
  if(src==='trash_pages')base.push(guard({env},src,childFields,children,childWhere,[idJson,idJson]));
  if(action!=='purge')base.push(guard({env},dst,df,destinations,'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson]),
    guard({env},dv,VERSION,destVersions,destSubWhere,versionArgs),guard({env},dl,LINK,destLinks,destSubWhere,linkArgs),
    guard({env},dst,['id','uuid','page_type'],destinationParents,`id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT uuid FROM ${src} WHERE id IN (SELECT value FROM json_each(?)))`,[parentJson,parentJson]));
  const detached:Row[]=children.map(c=>({...c,page_id:null,source_page_id:action==='restore'?targetId(sources.find(p=>p.id===c.page_id)!):(c.source_page_id??c.page_id)}));
  const mirror=(p:Row)=>versions.some(v=>v.page_id===p.id&&MIRROR_ACTIONS.includes(String(v.action)));
  // Purging a submission mirror erases its published source too (W12).
  const erasures=action==='purge'?sources.filter(mirror).map(p=>String(p.uuid)):[];
  const publishing = publication();
  if (erasures.length && !publishing) throw new PageLifecycleUnavailableError(true);
  const manifest=sources.map(p=>({id:p.id,uuid:p.uuid,parent_id:p.page_id,...(src==='trash_pages'?{source_parent_id:p.source_page_id}:{}),
    versions:versions.filter(v=>v.page_id===p.id).map(v=>({id:v.id,uuid:v.uuid})),links:links.filter(l=>l.page_id===p.id).map(l=>({id:l.id,uuid:l.uuid,tag_id:l.tag_id,weight:l.weight}))}));
  const detail={operation_id:crypto.randomUUID(),...(service?.detail??{}),sources:manifest,selected_ids:selectedIds,cascade_ids:ids.filter(id=>!selectedIds.includes(id)),detached_children:children.map(c=>({id:c.id,uuid:c.uuid,parent_id:c.page_id,source_parent_id:c.source_page_id,restored_parent_id:detached.find(d=>d.id===c.id)?.source_page_id})),
    destination_before:destinations.filter(d=>uuids.includes(d.uuid)).map(d=>({id:d.id,uuid:d.uuid})),...(context.job?{job_id:context.job.id,job_attempt:context.job.attempt}:{}),
    ...(erasures.length?{source_erasures:erasures}:{}),...(selection.olderThanDays!==undefined?{retention_days:selection.olderThanDays}:{})};json(detail);
  const entry: AuditEntry = service
    ? {action:'page.delete.chunk',entityType:'page_delete_operation',detail}
    : {action:action==='trash'?'page.delete':action==='restore'?(selection.ids?'page.restore':'page.restore_all'):(selection.ids?'page.purge':'page.purge_all'),
      entityType:'page',...(sources.length===1?{entityId:String(sources[0].uuid)}:{}),detail};
  const groups: MutationGroup[] = [{ evidence: { entry, dataClass, targetIds: service ? undefined : uuids.map(String) } }];
  if (service) {
    for (const item of manifest) {
      const page = sources.find(p => p.uuid === item.uuid)!;
      groups.push({ evidence: { entry: {
        action:'page.delete',entityType:'page',entityId:String(page.uuid),
        detail:{...service.detail,source_id:page.id,source_uuid:page.uuid,trash_id:targetId(page),source_parent_id:page.page_id,
          versions:item.versions,links:item.links},
      },dataClass } });
    }
  }
  const leadingWrites: PlannedWrite[] = [];
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
    leadingWrites.push({ sql: `INSERT INTO ${dst} (id,uuid,created_at,updated_at,${CONTENT.join(',')},page_id${action==='trash'?',source_page_id':''})
      SELECT COALESCE((SELECT d.id FROM ${dst} d WHERE d.uuid=s.uuid),s.id),s.uuid,COALESCE((SELECT d.created_at FROM ${dst} d WHERE d.uuid=s.uuid),?),?,
      ${CONTENT.map(f=>`s.${f}`).join(',')},NULL${action==='trash'?',s.page_id':''} FROM ${src} s WHERE s.id IN (SELECT value FROM json_each(?))
      ON CONFLICT(uuid) DO UPDATE SET ${CONTENT.map(f=>`${f}=excluded.${f}`).join(',')},updated_at=excluded.updated_at${action==='trash'?',source_page_id=excluded.source_page_id':''}`,
      args:[clock.now,clock.now,idJson],changes:sources.length },
    { sql:`UPDATE ${dst} SET page_id=json_extract(e.value,'$.page_id') FROM json_each(?) e WHERE ${dst}.uuid=json_extract(e.value,'$.uuid')`,
      args:[json(projected)],changes:sources.length },
    { sql:`INSERT INTO ${dv} (${VERSION.join(',')}) SELECT COALESCE((SELECT d.id FROM ${dv} d WHERE d.uuid=s.uuid),s.id),s.uuid,s.created_at,s.updated_at,d.id,s.lect,s.action
        FROM ${sv} s JOIN ${src} p ON p.id=s.page_id JOIN ${dst} d ON d.uuid=p.uuid WHERE s.page_id IN (SELECT value FROM json_each(?)) ON CONFLICT(uuid) DO NOTHING`,
      args:[idJson],changes:expectedVersions.length-destVersions.length },
    { sql:`INSERT INTO ${dl} (${LINK.join(',')}) SELECT COALESCE((SELECT d.id FROM ${dl} d WHERE d.uuid=s.uuid),s.id),s.uuid,s.created_at,s.updated_at,d.id,s.tag_id,s.weight
        FROM ${sl} s JOIN ${src} p ON p.id=s.page_id JOIN ${dst} d ON d.uuid=p.uuid WHERE s.page_id IN (SELECT value FROM json_each(?)) ON CONFLICT(uuid) DO NOTHING`,
      args:[idJson],changes:expectedLinks.length-destLinks.length });
  }
  if(src==='trash_pages') {
    leadingWrites.push({sql:'UPDATE trash_pages SET page_id=NULL WHERE id IN (SELECT value FROM json_each(?))',args:[idJson],changes:sources.length});
    if(detached.length)leadingWrites.push({sql:`UPDATE trash_pages SET page_id=NULL,source_page_id=json_extract(e.value,'$.source_page_id')
      FROM json_each(?) e WHERE trash_pages.id=json_extract(e.value,'$.id')`,args:[json(detached.map(c=>({id:c.id,source_page_id:c.source_page_id})))],changes:detached.length});
  }
  leadingWrites.push(
    {sql:`DELETE FROM ${sv} WHERE ${subWhere}`,args:[idJson],changes:versions.length},
    {sql:`DELETE FROM ${sl} WHERE ${subWhere}`,args:[idJson],changes:links.length},
    {sql:`DELETE FROM ${src} WHERE id IN (SELECT value FROM json_each(?))`,args:[idJson],changes:sources.length},
  );
  const sourceGone = [
    guard({env},src,sf,[],'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson]),
    guard({env},sv,VERSION,[],subWhere,[idJson]),guard({env},sl,LINK,[],subWhere,[idJson]),
  ];
  const tail = [...(erasures.length?[env.DB.prepare('INSERT INTO submission_erasures (uuid) SELECT value FROM json_each(?) WHERE true ON CONFLICT(uuid) DO NOTHING')
    .bind(json(erasures))]:[]), ...sourceGone];
  if (action === 'purge') tail.push(env.DB.prepare(`DELETE FROM page_access_policies WHERE page_uuid IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM pages WHERE uuid = page_uuid)`).bind(uuidJson));
  const destinationChecks = action === 'purge' ? [] : [
    guard({env},dst,df.filter(f=>f!=='updated_at'),expectedDest,'id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?))',[idJson,uuidJson]),
    guard({env},dv,VERSION,expectedVersions,destSubWhere,versionArgs),guard({env},dl,LINK,expectedLinks,destSubWhere,linkArgs),subset(env,dst,['id','uuid'],parentRefs),
  ];
  const expected = [...destinationChecks];
  if(children.length)expected.push(subset(env,src,childFields.filter(f=>f!=='updated_at'),detached));
  if(service)expected.push(abortIf(env,`EXISTS(SELECT 1 FROM trash_pages WHERE uuid IN (SELECT value FROM json_each(?)) AND (updated_at<? OR updated_at>CURRENT_TIMESTAMP))`,[uuidJson,clock.now]),guard({env},'tags',['id','uuid','taxonomy_slug'],tags,'id IN (SELECT value FROM json_each(?))',[json(tagIds)]));
  expected.push(...(service?.after?.()??[]),
    abortIf(env,`EXISTS (SELECT 1 FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) AND level>?)
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=json_extract(e.value,'$.uuid')),0)<json_extract(e.value,'$.level'))`,[json(floorUuids),dataClass==='phi'?2:dataClass==='pii'?1:0,json(floors)]));
  if(job)expected.push(job.delegationGuard);
  await mutation.commit(() => ({
    admit: base,
    leadingWrites,
    groups,
    tail,
    expect: expected,
    // Prove the local trash result and current claim before publication withdrawal.
    reconcile: job && user ? receipts => [
      job.delegationGuard, ...checks(), pageAccessGuard(env, user, uuids.map(String), true),
      ...receipts, ...sourceGone, ...destinationChecks,
    ] : undefined,
  }));
  // The purge has committed with the erasure recorded; a failure here leaves it pending for cron.
  if(erasures.length)await publishing?.eraseSubmissionSources(env).catch(()=>console.error(JSON.stringify({event:'submission.erasure-pending',count:erasures.length})));
  return {count:sources.length,pages:sources.map(p=>({id:Number(p.id),uuid:String(p.uuid),name:String(p.name),slug:String(p.slug),page_type:p.page_type as string|null,
    submission_origin:mirror(p)?1:0}))};
}
