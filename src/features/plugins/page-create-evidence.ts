import type { AppContext } from '../../core/http/context';
import type { Page } from '../../types';
import type { PreparedCreate } from './api/types';
import { assertPluginPageAuthority, type PluginPageMutationAuthority as Authority } from './page-update-evidence';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError } from '../../core/db/audit';
import { classFor } from '../../core/db/data-classes';
import { snapshot, guard, resultGuard, fingerprint, json, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { NEXT_SNAPSHOT_ID_SQL } from '../../core/pages/snapshot-id';
import { createCandidate, limitsForPageType, scopeGroups, countLimitUsage, type LimitViolation, type NormalizedLimitDef } from './limits';
import { pageTypeScopeAllows } from './page-types';

const REGISTRY=['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
const PIN=['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const APPROVAL=['id','created_at','updated_at','plugin_id','page_type','access','approved_by'];
const SETTING=['key','value','created_at','updated_at'];
const SETTINGS="key LIKE 'plugin.limits.%' OR key LIKE 'plugin.credits.%'";
const TAG=['id','uuid','taxonomy_slug'];
const PARENT=['id','uuid','page_type'];
const PAGE=['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const LINK=['uuid','created_at','updated_at','page_id','tag_id','weight'];
type Class='none'|'pii'|'phi';
function maximum(values:Array<Class|null|undefined>):Class{return values.includes('phi')?'phi':values.includes('pii')?'pii':'none';}
export interface PluginPageCreate extends Omit<PreparedCreate,'id'>{id:number;uuid:string;slug:string}
interface Quota {definition:NormalizedLimitDef;scopeValue:string|number|null;sql:string;args:Array<string|number|null>;attempted:number;current:number;limit:number;violation:LimitViolation}
/** Trusted duplication adapter: selected immutable source provenance and SQL
 * checks remain owned by the contributor feature, never supplied by a client. */
export interface PluginPageCopyEvidence {
  operationId:string;
  sources:Array<{targetUuid:string;id:number;uuid:string;floor:number}>;
  check:()=>D1PreparedStatement[];
  dataClass:Class;
  detail:Record<string,unknown>;
}
export class PluginPageCreateUnavailableError extends ServiceMutationUnavailableError {
  constructor(readonly rollbackKnown:boolean){super();}
}
async function unavailable(c:AppContext,authority:Authority,rollbackKnown=true):Promise<never>{
  await recordAuditOutage(c.env,'health',[],authority.actor,undefined,{captureIncomplete:true});throw new PluginPageCreateUnavailableError(rollbackKnown);
}
/** Prepare the complete selected create set before any reservation. Global
 * contributor/configuration snapshots bind the existing quota/pricing resolver
 * to the same registry/pins/grants/settings at admission and completion. */
export async function preparePluginPageCreates(c:AppContext,authority:Authority,plans:PluginPageCreate[],forbiddenTypes:string[],copy?:PluginPageCopyEvidence){
  assertRegulatedWritesAllowed(c.env);
  try{
    assertPluginPageAuthority(authority,copy?'duplicate':'create');
    const kind=copy?'duplicate':'create';
    if(copy&&(copy.sources.length!==plans.length||new Set(copy.sources.map(s=>s.targetUuid)).size!==plans.length||plans.some(p=>!copy.sources.some(s=>s.targetUuid===p.uuid&&Number.isSafeInteger(s.id)&&s.id>0&&[0,1,2].includes(s.floor)))))throw new Error('Invalid copy provenance');
    if(plans.length>(copy?1000:100)||new Set(plans.map(p=>p.id)).size!==plans.length||plans.some(p=>!Number.isSafeInteger(p.id)||p.id<=0||!pageTypeScopeAllows(authority.allowed,p.pageType)))throw new Error('Invalid create manifest');
    json(plans);
    const operationId=copy?.operationId??crypto.randomUUID();
    const journal=await c.env.DB.prepare("SELECT COALESCE(MAX(seq),0) generation FROM audit_events WHERE target_type='plugin'").first<{generation:number}>();
    if(!journal||!Number.isSafeInteger(journal.generation))throw new Error('Contributor witness unavailable');
    const registries=await snapshot<Row>(c,'plugins',REGISTRY);
    const pins=await snapshot<Row>(c,'plugin_identity_approvals',PIN);
    const approvals=await snapshot<Row>(c,'plugin_page_type_approvals',APPROVAL);
    const settings=await snapshot<Row>(c,'settings',SETTING,SETTINGS);
    const hasTrash=!!await c.env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash_pages'").first();
    const ids=plans.map(p=>p.id),uuids=plans.map(p=>p.uuid),idArgs=[json(ids)],uuidArgs=[json(uuids)];
    const externalParents=[...new Set(plans.map(p=>p.parentId).filter((id):id is number=>id!==null&&!ids.includes(id)))];
    const parentArgs=[json(externalParents)];
    const parents=await snapshot<Row>(c,'pages',PARENT,'id IN (SELECT value FROM json_each(?))',parentArgs);
    if(parents.length!==externalParents.length)throw new Error('Parent target unavailable');
    const tagIds=[...new Set(plans.flatMap(p=>p.tags))];
    if(tagIds.length>5000||tagIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid create tags');
    const tagArgs=[json(tagIds)];
    const tags=await snapshot<Row>(c,'tags',TAG,'id IN (SELECT value FROM json_each(?))',tagArgs);
    if(tags.length!==tagIds.length)throw new Error('Tag target unavailable');
    const parentFloorArgs=[json(parents.map(p=>p.uuid))];
    const parentFloors=await snapshot<Row>(c,'page_sensitivity_floors',['uuid','level'],'uuid IN (SELECT value FROM json_each(?))',parentFloorArgs);
    if(parentFloors.some(f=>f.level!==1&&f.level!==2))throw new Error('Invalid parent floor');
    const inspected=maximum([authority.dataClass,copy?.dataClass,...(copy?.sources.map(s=>s.floor===2?'phi' as const:s.floor===1?'pii' as const:undefined)??[]),classFor(authority.policy,'table','settings'),classFor(authority.policy,'table','trash_pages'),...pins.map(p=>classFor(authority.policy,'plugin',String(p.manifest_id))),...parents.map(p=>classFor(authority.policy,'page_type',String(p.page_type??'default'))),...parentFloors.map(p=>p.level===2?'phi' as const:'pii' as const)]);
    const classification=(plan:PluginPageCreate)=>maximum([inspected,classFor(authority.policy,'page_type',plan.pageType),...tags.filter(tag=>plan.tags.includes(Number(tag.id))).map(tag=>classFor(authority.policy,'taxonomy',String(tag.taxonomy_slug??'default')))]);
    let dataClass=maximum([inspected,...plans.map(classification),...forbiddenTypes.map(type=>classFor(authority.policy,'page_type',type))]);
    const metadata=()=>[abortIf(c.env,"EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash_pages')<>?",[hasTrash?1:0]),...authority.check(),...(copy?.check()??[]),guard(c,'plugins',REGISTRY,registries),guard(c,'plugin_identity_approvals',PIN,pins),guard(c,'plugin_page_type_approvals',APPROVAL,approvals),guard(c,'settings',SETTING,settings,SETTINGS),guard(c,'pages',PARENT,parents,'id IN (SELECT value FROM json_each(?))',parentArgs),guard(c,'tags',TAG,tags,'id IN (SELECT value FROM json_each(?))',tagArgs),guard(c,'page_sensitivity_floors',['uuid','level'],parentFloors,'uuid IN (SELECT value FROM json_each(?))',parentFloorArgs),abortIf(c.env,"(SELECT COALESCE(MAX(seq),0) FROM audit_events WHERE target_type='plugin')<>?",[journal.generation])];
    const absent=(selected:PluginPageCreate[])=>{
      const selectedIds=[json(selected.map(p=>p.id))],selectedUuids=[json(selected.map(p=>p.uuid))];
      return [
        ...['pages',...(hasTrash?['trash_pages']:[])].map(table=>abortIf(c.env,`EXISTS(SELECT 1 FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) OR uuid IN (SELECT value FROM json_each(?)))`,[...selectedIds,...selectedUuids])),
        ...['page_versions','page_tags'].map(table=>abortIf(c.env,`EXISTS(SELECT 1 FROM ${table} WHERE page_id IN (SELECT value FROM json_each(?)))`,selectedIds)),
        abortIf(c.env,'EXISTS(SELECT 1 FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)))',selectedUuids),
        ...selected.map(plan=>abortIf(c.env,'EXISTS(SELECT 1 FROM pages WHERE slug=?)',[plan.slug]))];
    };
    const quotas:Quota[]=[];
    const typeFloors=new Map<string,number>();
    const typeFloorSql="SELECT COALESCE(MAX(f.level),0) level FROM pages p JOIN page_sensitivity_floors f ON f.uuid=p.uuid WHERE p.page_type=?"+(copy?' AND p.uuid NOT IN (SELECT value FROM json_each(?))':'');
    const typeFloorArgs=(type:string)=>copy?[type,json(plans.map(p=>p.uuid))]:[type];
    for(const type of new Set(plans.map(p=>p.pageType))){
      const floor=await c.env.DB.prepare(typeFloorSql).bind(...typeFloorArgs(type)).first<{level:number}>();
      if(!floor||![0,1,2].includes(floor.level))throw new Error('Invalid count provenance');typeFloors.set(type,floor.level);
      const candidates=plans.filter(p=>p.pageType===type).map(p=>createCandidate(p.pageType,p.parentId,p.lect));
      for(const limit of await limitsForPageType(c.env,type)){
        if(limit.value===null)continue;
        if(!Number.isSafeInteger(limit.value)||limit.value<0)throw new Error('Unsafe quota');
        for(const [scopeValue,attempted] of scopeGroups(limit.def,candidates)){
          let sql='p.page_type=?';const args:Array<string|number|null>=[type];
          if(limit.def.scope==='per_parent'){sql+=' AND p.page_id=?';args.push(scopeValue);}
          else if(limit.def.scope==='per_pointer'){sql+=' AND CAST(json_extract(p.lect,?) AS TEXT)=?';args.push(`$._pointers.${limit.def.pointerKey}`,String(scopeValue??''));}
          const current=await countLimitUsage(c.env.DB,limit.def,scopeValue);
          if(!Number.isSafeInteger(current)||current<0)throw new Error('Unsafe quota count');
          quotas.push({definition:limit.def,scopeValue,sql,args,attempted,current,limit:limit.value,violation:{pluginId:limit.pluginId,key:limit.def.key,label:limit.def.label,pageType:type,scope:limit.def.scope,limit:limit.value,current,attempted}});
        }
      }
    }
    dataClass=maximum([dataClass,...[...typeFloors.values()].map(level=>level===2?'phi' as const:level===1?'pii' as const:undefined)]);
    const minimum=dataClass==='none'?undefined:dataClass;
    await auditBackgroundReads(c.env,[
      ...['plugins','plugin_identity_approvals','plugin_page_type_approvals','settings','tags'].map(table=>({action:'plugin.page-create-source-read',kind:'table' as const,key:table,targetType:table,ids:table==='plugins'?registries.map(r=>String(r.id)):table==='plugin_identity_approvals'?pins.map(r=>String(r.plugin_row_id)):table==='plugin_page_type_approvals'?approvals.map(r=>String(r.id)):table==='tags'?tags.map(r=>String(r.id)):[],count:table==='plugins'?registries.length:table==='plugin_identity_approvals'?pins.length:table==='plugin_page_type_approvals'?approvals.length:table==='tags'?tags.length:settings.length,minimumClass:minimum})),
      ...[...typeFloors].map(([type])=>({action:'plugin.page-create-count-read',kind:'page_type' as const,key:type,targetType:'page_floor_metadata',ids:[],count:1,minimumClass:minimum})),
      {action:'plugin.page-create-source-read',kind:'table' as const,key:'trash_pages',targetType:'trash_page_id_availability',ids:ids.map(String),count:0,minimumClass:minimum},
      ...parents.map(parent=>({action:'plugin.page-create-parent-read',kind:'page_type' as const,key:String(parent.page_type??'default'),targetType:'page',ids:[String(parent.id)],count:1,uuidById:{[String(parent.id)]:String(parent.uuid)},minimumClass:minimum}))],authority.actor);
    if(await flushReadAudit(c))throw new Error('Create source evidence unavailable');
    const detail:Record<string,unknown>={operation_id:operationId,registry_id:authority.registryId,identity_fingerprint:authority.identityFingerprint,principal:'credential_authenticated_plugin',targets:plans.map(p=>({id:p.id,uuid:p.uuid})),count:plans.length,...(copy?{operation:'duplicate',...copy.detail,sources:copy.sources}: {})};
    const asserted=c.req.header('x-acting-user-id');if(asserted!==undefined){const id=Number(asserted);detail.acting_user_verified=false;if(/^\d+$/.test(asserted)&&Number.isSafeInteger(id)&&id>0)detail.asserted_user_id=id;else detail.acting_user_unrecordable=true;}
    const scopeDenials=await Promise.all(forbiddenTypes.map(async type=>serviceMutationAuditEvidence(c.env,{action:`page.${kind}.denied`,entityType:copy?'page_duplicate_operation':'page_create_operation',entityId:operationId,outcome:'denied',detail:{...detail,reason:'forbidden_page_type',type_fingerprint:await fingerprint(type)}},authority.actor,dataClass,authority.policy,c)));
    const floorAdmission=()=>[...typeFloors].map(([type,level])=>abortIf(c.env,`(${typeFloorSql})<>?`,[...typeFloorArgs(type),level]));
    const admission=(selected=plans)=>[...metadata(),...absent(selected),...floorAdmission()];
    const quotaAdmission=(selected=plans)=>quotas.map(q=>{
      const attempted=scopeGroups(q.definition,selected.filter(p=>p.pageType===q.violation.pageType).map(p=>createCandidate(p.pageType,p.parentId,p.lect))).get(q.scopeValue)??0;
      return abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${q.sql})+?>?`,[...q.args,attempted,q.limit]);
    });
    const violation=quotas.find(q=>q.current+q.attempted>q.limit);
    const preflight=[...admission(),...scopeDenials.flatMap(receipt=>[receipt.write,receipt.guard])];
    const finalReceipts=scopeDenials.map(receipt=>receipt.guard);
    if(violation){
      const refusal=serviceMutationAuditEvidence(c.env,{action:`page.${kind}.denied`,entityType:copy?'page_duplicate_operation':'page_create_operation',entityId:operationId,outcome:'denied',detail:{...detail,reason:'limit_exceeded',current:violation.current,attempted:violation.attempted,maximum:violation.limit}},authority.actor,dataClass,authority.policy,c);
      finalReceipts.push(refusal.guard);
      preflight.push(abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${violation.sql})<>?`,[...violation.args,violation.current]),refusal.write,refusal.guard,abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${violation.sql})<>?`,[...violation.args,violation.current]));
    }else if(plans.length){
      const intent=serviceMutationAuditEvidence(c.env,{action:`page.${kind}.intent`,entityType:copy?'page_duplicate_operation':'page_create_operation',entityId:operationId,detail:{...detail,phase:'intent'}},authority.actor,dataClass,authority.policy,c);
      const counts=quotas.map(q=>abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${q.sql})<>?`,[...q.args,q.current]));
      preflight.push(...quotaAdmission(),...counts,intent.write,intent.guard,...counts);finalReceipts.push(intent.guard);
    }
    preflight.push(...admission(),...finalReceipts);await c.env.DB.batch(preflight);
    return {authority,kind,copy,plans,operationId,dataClass,classification,metadata,admission,quotaAdmission,quotas,typeFloors,typeFloorSql,typeFloorArgs,tags,ids,idArgs,uuidArgs,detail,violation:violation?.violation??null};
  }catch{return unavailable(c,authority);}
}
export type PluginPageCreateContext=Awaited<ReturnType<typeof preparePluginPageCreates>>;
/** Intent/result evidence is separate from the optional reservation's financial
 * transaction. A refused reservation does not pretend a page was created. */
export async function recordPluginCreateReservationRefusal(c:AppContext,source:PluginPageCreateContext,code:string){
  try{const receipt=serviceMutationAuditEvidence(c.env,{action:`page.${source.kind}.denied`,entityType:source.copy?'page_duplicate_operation':'page_create_operation',entityId:source.operationId,outcome:'denied',detail:{...source.detail,reason:'reservation_refused',reservation_code:['unknown_acting_user','insufficient_credits'].includes(code)?code:'service_refused'}},source.authority.actor,source.dataClass,source.authority.policy,c);
    await c.env.DB.batch([...source.metadata(),receipt.write,receipt.guard,...source.metadata()]);
  }catch{return unavailable(c,source.authority);}
}
export async function recordPluginCreateFailure(c:AppContext,source:PluginPageCreateContext,rollbackKnown:boolean,refundState:string,progress:Record<string,number>={}){
  try{const receipt=serviceMutationAuditEvidence(c.env,{action:`page.${source.kind}.result`,entityType:source.copy?'page_duplicate_operation':'page_create_operation',entityId:source.operationId,outcome:'error',detail:{...source.detail,commit_state:source.copy&&progress.acknowledged_count===source.plans.length?'committed':rollbackKnown?(source.copy&&(progress.acknowledged_count??0)>0?'prefix_committed':'not_committed'):'unknown',refund_state:refundState,...(source.copy?{unacknowledged_commit_state:rollbackKnown?'not_committed':'unknown'}:{}),...progress}},source.authority.actor,source.dataClass,source.authority.policy,c);
    await c.env.DB.batch([...source.authority.check(),receipt.write,receipt.guard]);
  }catch{await recordAuditOutage(c.env,'health',[],source.authority.actor,undefined,{captureIncomplete:true});}
}
/** One local page/history/link/receipt transaction; no automatic retry. */
export async function commitPluginPageCreates(c:AppContext,source:PluginPageCreateContext,charged:number,selected?:PluginPageCreate[]):Promise<Page[]>{
  assertRegulatedWritesAllowed(c.env);let attempted=false;
  try{
    const plans=selected??source.plans;
    if(plans.length>100||new Set(plans.map(p=>p.uuid)).size!==plans.length||plans.some(p=>!source.plans.includes(p)))throw new Error('Invalid create slice');
    if(source.copy&&(plans.length===0||!source.plans.slice(source.plans.indexOf(plans[0]),source.plans.indexOf(plans[0])+plans.length).every((plan,index)=>plan===plans[index])))throw new Error('Invalid copy slice');
    const idArgs=[json(plans.map(p=>p.id))];
    if(!Number.isSafeInteger(charged)||charged<0||source.violation)throw new Error('Invalid reservation result');
    const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Clock unavailable');
    const statements=[...source.admission(plans),...source.quotaAdmission(plans)];
    const pages=plans.map(p=>({id:p.id,uuid:p.uuid,name:p.name,slug:p.slug,page_type:p.pageType,lect:p.lect,weight:p.weight,start:p.start,end:p.end,timezone:p.timezone,page_id:p.parentId,creator:null,editors:null,created_at:null,updated_at:null}));
    const links:Row[]=[],versions:Array<{uuid:string;page_id:number;lect:string}>=[],receiptGuards:D1PreparedStatement[]=[];
    for(const page of pages)statements.push(c.env.DB.prepare('INSERT INTO pages(id,uuid,name,slug,page_type,lect,weight,start,end,timezone,page_id,creator,editors) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').bind(page.id,page.uuid,page.name,page.slug,page.page_type,page.lect,page.weight,page.start,page.end,page.timezone,page.page_id),abortIf(c.env,'changes()<>1'));
    for(const plan of plans){
      const provenance=source.copy?.sources.find(s=>s.targetUuid===plan.uuid);
      if(provenance?.floor)statements.push(c.env.DB.prepare('INSERT INTO page_sensitivity_floors(uuid,level) VALUES (?,?) ON CONFLICT(uuid) DO UPDATE SET level=MAX(level,excluded.level)').bind(plan.uuid,provenance.floor));
      const version={uuid:crypto.randomUUID(),page_id:plan.id,lect:plan.lect};versions.push(version);
      statements.push(c.env.DB.prepare(`INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (${NEXT_SNAPSHOT_ID_SQL},?,?,?,'create')`).bind(version.uuid,plan.id,plan.lect),abortIf(c.env,'changes()<>1'));
      for(const tag of [...new Set(plan.tags)]){const uuid=crypto.randomUUID();links.push({uuid,page_id:plan.id,tag_id:tag,weight:5,created_at:null,updated_at:null});statements.push(c.env.DB.prepare(`INSERT INTO page_tags(id,uuid,page_id,tag_id) SELECT (SELECT MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 FROM page_tags),?,?,?`).bind(uuid,plan.id,tag),abortIf(c.env,'changes()<>1'));}
      const receipt=serviceMutationAuditEvidence(c.env,{action:source.copy?'page.duplicate':'page.create',entityType:'page',entityId:plan.uuid,detail:{operation_id:source.operationId,registry_id:source.authority.registryId,identity_fingerprint:source.authority.identityFingerprint,principal:'credential_authenticated_plugin',version_uuid:version.uuid,fields:['content','history','tags'],...(provenance?{source_id:provenance.id,source_uuid:provenance.uuid,copied_floor:provenance.floor}:{}),tag_ids:[...new Set(plan.tags)],operation_reservation_charged:charged,...(source.detail.acting_user_verified===false?{acting_user_verified:false,...(source.detail.asserted_user_id?{asserted_user_id:source.detail.asserted_user_id}:{acting_user_unrecordable:true})}:{})}},source.authority.actor,maximum([source.dataClass,source.classification(plan)]),source.authority.policy,c);
      statements.push(receipt.write,receipt.guard);receiptGuards.push(receipt.guard);
    }
    if(source.copy){
      const offset=source.plans.indexOf(plans[0]),pairs=plans.map(plan=>source.copy!.sources.find(row=>row.targetUuid===plan.uuid)!);
      const last=offset+plans.length===source.plans.length;
      const receipt=serviceMutationAuditEvidence(c.env,{action:'page.duplicate.chunk',entityType:'page_duplicate_operation',entityId:source.operationId,detail:{operation_id:source.operationId,registry_id:source.authority.registryId,chunk_index:Math.floor(offset/100),count:plans.length,cursor_before:offset?source.copy.sources[offset-1].id:source.copy.detail.source_cursor,cursor_after:pairs.at(-1)!.id,targets:pairs.map(pair=>({source_id:pair.id,source_uuid:pair.uuid,target_uuid:pair.targetUuid})),request_complete:last,done:last&&Number(source.copy.detail.source_count)<=source.plans.length}},source.authority.actor,source.dataClass,source.authority.policy,c);
      statements.push(receipt.write,receipt.guard);receiptGuards.push(receipt.guard);
    }
    statements.push(resultGuard(c,'pages',PAGE,pages,clock.now,'id IN (SELECT value FROM json_each(?))',idArgs),resultGuard(c,'page_tags',LINK,links,clock.now,'page_id IN (SELECT value FROM json_each(?))',idArgs),
      abortIf(c.env,'(SELECT COUNT(*) FROM page_versions WHERE page_id IN (SELECT value FROM json_each(?)))<>?',[...idArgs,versions.length]));
    for(const table of ['page_versions','page_tags'])statements.push(abortIf(c.env,`EXISTS(SELECT 1 FROM ${table} WHERE page_id IN (SELECT value FROM json_each(?)) AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))`,idArgs));
    for(const version of versions)statements.push(abortIf(c.env,"NOT EXISTS(SELECT 1 FROM page_versions WHERE uuid=? AND page_id=? AND lect=? AND action='create' AND created_at>=? AND created_at<=CURRENT_TIMESTAMP AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)",[version.uuid,version.page_id,version.lect,clock.now,clock.now]));
    for(const plan of plans){
      const classes=[classFor(source.authority.policy,'page_type',plan.pageType),...source.tags.filter(tag=>plan.tags.includes(Number(tag.id))).map(tag=>classFor(source.authority.policy,'taxonomy',String(tag.taxonomy_slug??'default')))];
      const level=Math.max(source.copy?.sources.find(s=>s.targetUuid===plan.uuid)?.floor??0,classes.includes('phi')?2:classes.includes('pii')?1:0);
      statements.push(abortIf(c.env,'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>? OR (SELECT COUNT(*) FROM pages WHERE slug=?)<>1',[plan.uuid,level,plan.slug]));
      if(plan.parentId!==null)statements.push(abortIf(c.env,'NOT EXISTS(SELECT 1 FROM pages WHERE id=?)',[plan.parentId]));
    }
    for(const quota of source.quotas)statements.push(abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${quota.sql})>?`,[...quota.args,quota.limit]));
    for(const [type,previous] of source.typeFloors){const classes=source.plans.filter(p=>p.pageType===type).flatMap(p=>[classFor(source.authority.policy,'page_type',type),...source.tags.filter(t=>p.tags.includes(Number(t.id))).map(t=>classFor(source.authority.policy,'taxonomy',String(t.taxonomy_slug??'default')))]);const next=source.copy?previous:Math.max(previous,classes.includes('phi')?2:classes.includes('pii')?1:0);statements.push(abortIf(c.env,`(${source.typeFloorSql})<>?`,[...source.typeFloorArgs(type),next]));}
    statements.push(...receiptGuards,...source.metadata(),c.env.DB.prepare('SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?))').bind(...idArgs));
    attempted=true;const results=await c.env.DB.batch(statements);const saved=results.at(-1)!.results as Page[];
    if(saved.length!==plans.length)throw new Error('Create result unavailable');return plans.map(p=>saved.find(row=>row.id===p.id)!);
  }catch(error){return unavailable(c,source.authority,!attempted||(error instanceof Error&&/^D1_ERROR:.*SQLITE_/s.test(error.message)));}
}
