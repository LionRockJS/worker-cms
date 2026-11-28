import { legacyPageFilter } from '../../core/auth/page-access';
import type { AppContext } from '../../core/http/context';
import type { Page } from '../../types';
import type { PreparedCreate } from './api/types';
import { assertPluginPageAuthority, type PluginPageMutationAuthority as Authority } from './page-update-evidence';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError } from '../../core/db/audit';
import { classFor, classificationPolicyGuard, strongestClass } from '../../core/db/data-classes';
import { snapshotRows, snapshotStatement, guard, resultGuard, fingerprint, json, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { beginServiceAuditedMutation, type PlannedWrite, type MutationGroup } from '../../core/evidence/audited-mutation';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { NEXT_SNAPSHOT_ID_SQL, nextIdSql } from '../../core/pages/snapshot-id';
import { createCandidate, limitsForPageType, scopeGroups, countLimitUsage, type LimitViolation, type NormalizedLimitDef } from './limits';
import { pageTypeScopeAllows } from './page-types';
import { REGISTRY, IDENTITY, noteActingUser } from './evidence-common';

const APPROVAL=['id','created_at','updated_at','plugin_id','page_type','access','approved_by'];
const SETTING=['key','value','created_at','updated_at'];
const SETTINGS="key LIKE 'plugin.limits.%' OR key LIKE 'plugin.credits.%'";
const TAG=['id','uuid','taxonomy_slug'];
const PARENT=['id','uuid','page_type'];
const FLOOR=['uuid','level'];
const PAGE=['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const LINK=['uuid','created_at','updated_at','page_id','tag_id','weight'];
type Class='none'|'pii'|'phi';
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

function beginCreateMutation(c: AppContext, authority: Authority, check: () => D1PreparedStatement[], phase: 'planning' | 'content') {
  return beginServiceAuditedMutation(c, {
    classify: [],
    snapshot: {},
    unavailable: (error, submitted) => new PluginPageCreateUnavailableError(
      phase === 'planning' || !submitted || (error instanceof Error && /^D1_ERROR:.*SQLITE_/s.test(error.message)),
    ),
  }, { actor: authority.actor, policy: authority.policy, check });
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
    const ids=plans.map(p=>p.id),uuids=plans.map(p=>p.uuid),idArgs=[json(ids)],uuidArgs=[json(uuids)];
    const externalParents=[...new Set(plans.map(p=>p.parentId).filter((id):id is number=>id!==null&&!ids.includes(id)))];
    const parentArgs=[json(externalParents)];
    const tagIds=[...new Set(plans.flatMap(p=>p.tags))];
    if(tagIds.length>5000||tagIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid create tags');
    const tagArgs=[json(tagIds)];
    const idScope = 'id IN (SELECT value FROM json_each(?))';
    const [ , witness, registryRows, pinRows, approvalRows, settingRows, trash, parentRows, tagRows, floorRows] =
      await c.env.DB.batch<{ snapshot: string; generation: number }>([
        classificationPolicyGuard(c.env, authority.policy),
        c.env.DB.prepare("SELECT COALESCE(MAX(seq),0) generation FROM audit_events WHERE target_type='plugin'"),
        snapshotStatement(c, 'plugins', REGISTRY),
        snapshotStatement(c, 'plugin_identity_approvals', IDENTITY),
        snapshotStatement(c, 'plugin_page_type_approvals', APPROVAL),
        snapshotStatement(c, 'settings', SETTING, SETTINGS),
        c.env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash_pages'"),
        snapshotStatement(c, 'pages', PARENT, idScope, parentArgs),
        snapshotStatement(c, 'tags', TAG, idScope, tagArgs),
        snapshotStatement(c, 'page_sensitivity_floors', FLOOR, `uuid IN (SELECT uuid FROM pages WHERE ${idScope})`, parentArgs),
      ]);
    const journal = witness.results[0];
    if (!journal || !Number.isSafeInteger(journal.generation)) throw new Error('Contributor witness unavailable');
    const registries = snapshotRows<Row>(REGISTRY, registryRows.results[0]);
    const pins = snapshotRows<Row>(IDENTITY, pinRows.results[0]);
    const approvals = snapshotRows<Row>(APPROVAL, approvalRows.results[0]);
    const settings = snapshotRows<Row>(SETTING, settingRows.results[0]);
    const hasTrash = trash.results.length > 0;
    const parents = snapshotRows<Row>(PARENT, parentRows.results[0]);
    if (parents.length !== externalParents.length) throw new Error('Parent target unavailable');
    const tags = snapshotRows<Row>(TAG, tagRows.results[0]);
    if(tags.length!==tagIds.length)throw new Error('Tag target unavailable');
    const parentFloorArgs=[json(parents.map(p=>p.uuid))];
    const parentFloors = snapshotRows<Row>(FLOOR, floorRows.results[0]);
    if(parentFloors.some(f=>f.level!==1&&f.level!==2))throw new Error('Invalid parent floor');
    const inspected=strongestClass([authority.dataClass,copy?.dataClass,...(copy?.sources.map(s=>s.floor===2?'phi' as const:s.floor===1?'pii' as const:undefined)??[]),classFor(authority.policy,'table','settings'),classFor(authority.policy,'table','trash_pages'),...pins.map(p=>classFor(authority.policy,'plugin',String(p.manifest_id))),...parents.map(p=>classFor(authority.policy,'page_type',String(p.page_type??'default'))),...parentFloors.map(p=>p.level===2?'phi' as const:'pii' as const)]);
    const classification=(plan:PluginPageCreate)=>strongestClass([inspected,classFor(authority.policy,'page_type',plan.pageType),...tags.filter(tag=>plan.tags.includes(Number(tag.id))).map(tag=>classFor(authority.policy,'taxonomy',String(tag.taxonomy_slug??'default')))]);
    let dataClass=strongestClass([inspected,...plans.map(classification),...forbiddenTypes.map(type=>classFor(authority.policy,'page_type',type))]);
    const metadata=()=>[abortIf(c.env,"EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash_pages')<>?",[hasTrash?1:0]),...authority.check(),...(copy?.check()??[]),guard(c,'plugins',REGISTRY,registries),guard(c,'plugin_identity_approvals',IDENTITY,pins),guard(c,'plugin_page_type_approvals',APPROVAL,approvals),guard(c,'settings',SETTING,settings,SETTINGS),guard(c,'pages',PARENT,parents,'id IN (SELECT value FROM json_each(?))',parentArgs),guard(c,'tags',TAG,tags,'id IN (SELECT value FROM json_each(?))',tagArgs),guard(c,'page_sensitivity_floors',['uuid','level'],parentFloors,'uuid IN (SELECT value FROM json_each(?))',parentFloorArgs),abortIf(c.env,"(SELECT COALESCE(MAX(seq),0) FROM audit_events WHERE target_type='plugin')<>?",[journal.generation])];
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
    dataClass=strongestClass([dataClass,...[...typeFloors.values()].map(level=>level===2?'phi' as const:level===1?'pii' as const:undefined)]);
    const minimum=dataClass==='none'?undefined:dataClass;
    await auditBackgroundReads(c.env,[
      ...['plugins','plugin_identity_approvals','plugin_page_type_approvals','settings','tags'].map(table=>({action:'plugin.page-create-source-read',kind:'table' as const,key:table,targetType:table,ids:table==='plugins'?registries.map(r=>String(r.id)):table==='plugin_identity_approvals'?pins.map(r=>String(r.plugin_row_id)):table==='plugin_page_type_approvals'?approvals.map(r=>String(r.id)):table==='tags'?tags.map(r=>String(r.id)):[],count:table==='plugins'?registries.length:table==='plugin_identity_approvals'?pins.length:table==='plugin_page_type_approvals'?approvals.length:table==='tags'?tags.length:settings.length,minimumClass:minimum})),
      ...[...typeFloors].map(([type])=>({action:'plugin.page-create-count-read',kind:'page_type' as const,key:type,targetType:'page_floor_metadata',ids:[],count:1,minimumClass:minimum})),
      {action:'plugin.page-create-source-read',kind:'table' as const,key:'trash_pages',targetType:'trash_page_id_availability',ids:ids.map(String),count:0,minimumClass:minimum},
      ...parents.map(parent=>({action:'plugin.page-create-parent-read',kind:'page_type' as const,key:String(parent.page_type??'default'),targetType:'page',ids:[String(parent.id)],count:1,uuidById:{[String(parent.id)]:String(parent.uuid)},minimumClass:minimum}))],authority.actor,{policy:authority.policy});
    if(await flushReadAudit(c))throw new Error('Create source evidence unavailable');
    const detail:Record<string,unknown>={operation_id:operationId,registry_id:authority.registryId,identity_fingerprint:authority.identityFingerprint,principal:'credential_authenticated_plugin',targets:plans.map(p=>({id:p.id,uuid:p.uuid})),count:plans.length,...(copy?{operation:'duplicate',...copy.detail,sources:copy.sources}: {})};
    noteActingUser(c,detail);
    const entityType = copy ? 'page_duplicate_operation' : 'page_create_operation';
    const groups: MutationGroup[] = await Promise.all(forbiddenTypes.map(async type => ({
      evidence: {
        entry: { action: `page.${kind}.denied`, entityType, entityId: operationId, outcome: 'denied',
          detail: { ...detail, reason: 'forbidden_page_type', type_fingerprint: await fingerprint(type) } },
        dataClass,
      },
    })));
    const floorAdmission=()=>[...typeFloors].map(([type,level])=>abortIf(c.env,`(${typeFloorSql})<>?`,[...typeFloorArgs(type),level]));
    const admission=(selected=plans)=>[...absent(selected),...floorAdmission()];
    const quotaAdmission=(selected=plans)=>quotas.map(q=>{
      const attempted=scopeGroups(q.definition,selected.filter(p=>p.pageType===q.violation.pageType).map(p=>createCandidate(p.pageType,p.parentId,p.lect))).get(q.scopeValue)??0;
      return abortIf(c.env,`(SELECT COUNT(*) FROM pages p WHERE ${q.sql})+?>?`,[...q.args,attempted,q.limit]);
    });
    const violation=quotas.find(q=>q.current+q.attempted>q.limit);
    const countMatches = (quota: Quota) => abortIf(c.env, `(SELECT COUNT(*) FROM pages p WHERE ${quota.sql})<>?`, [...quota.args, quota.current]);
    const counts = (violation ? [violation] : quotas).map(countMatches);
    if (violation) {
      groups.push({
        check: counts,
        evidence: {
          entry: { action: `page.${kind}.denied`, entityType, entityId: operationId, outcome: 'denied',
            detail: { ...detail, reason: 'limit_exceeded', current: violation.current, attempted: violation.attempted, maximum: violation.limit } },
          dataClass,
        },
      });
    } else if (plans.length) {
      groups.push({
        check: [...quotaAdmission(), ...counts],
        evidence: {
          entry: { action: `page.${kind}.intent`, entityType, entityId: operationId, detail: { ...detail, phase: 'intent' } },
          dataClass,
        },
      });
    }
    const preflight = await beginCreateMutation(c, authority, () => [...metadata(), ...admission()], 'planning');
    await preflight.commit(() => ({ groups, expect: counts }));
    return {authority,kind,copy,plans,operationId,dataClass,classification,metadata,admission,quotaAdmission,quotas,typeFloors,typeFloorSql,typeFloorArgs,tags,ids,idArgs,uuidArgs,detail,violation:violation?.violation??null};
  } catch (error) {
    if (error instanceof PluginPageCreateUnavailableError) throw error;
    return unavailable(c,authority);
  }
}
export type PluginPageCreateContext=Awaited<ReturnType<typeof preparePluginPageCreates>>;
/** Intent/result evidence is separate from the optional reservation's financial
 * transaction. A refused reservation does not pretend a page was created. */
export async function recordPluginCreateReservationRefusal(c: AppContext, source: PluginPageCreateContext, code: string) {
  const mutation = await beginCreateMutation(c, source.authority, source.metadata, 'planning');
  await mutation.commit(() => ({
    groups: [{
      evidence: {
        entry: {
          action: `page.${source.kind}.denied`, entityType: source.copy ? 'page_duplicate_operation' : 'page_create_operation',
          entityId: source.operationId, outcome: 'denied',
          detail: { ...source.detail, reason: 'reservation_refused',
            reservation_code: ['unknown_acting_user', 'insufficient_credits'].includes(code) ? code : 'service_refused' },
        },
        dataClass: source.dataClass,
      },
    }],
    expect: [],
  }));
}
export async function recordPluginCreateFailure(c:AppContext,source:PluginPageCreateContext,rollbackKnown:boolean,refundState:string,progress:Record<string,number>={}){
  try{const receipt=serviceMutationAuditEvidence(c.env,{action:`page.${source.kind}.result`,entityType:source.copy?'page_duplicate_operation':'page_create_operation',entityId:source.operationId,outcome:'error',detail:{...source.detail,commit_state:source.copy&&progress.acknowledged_count===source.plans.length?'committed':rollbackKnown?(source.copy&&(progress.acknowledged_count??0)>0?'prefix_committed':'not_committed'):'unknown',refund_state:refundState,...(source.copy?{unacknowledged_commit_state:rollbackKnown?'not_committed':'unknown'}:{}),...progress}},source.authority.actor,source.dataClass,source.authority.policy,c);
    await c.env.DB.batch([...source.authority.check(),receipt.write,receipt.guard]);
  }catch{await recordAuditOutage(c.env,'health',[],source.authority.actor,undefined,{captureIncomplete:true});}
}
/** Commit one page or duplicate chunk against the plan captured before reservation. */
export async function commitPluginPageCreates(c: AppContext, source: PluginPageCreateContext, charged: number, selected?: PluginPageCreate[]): Promise<Page[]> {
  const mutation = await beginCreateMutation(c, source.authority, source.metadata, 'content');
  const plans = selected ?? source.plans;
  const saved = await mutation.commit(() => {
    if (plans.length > 100 || new Set(plans.map(plan => plan.uuid)).size !== plans.length ||
        plans.some(plan => !source.plans.includes(plan))) throw new Error('Invalid create slice');
    const copy = source.copy;
    const offset = source.plans.indexOf(plans[0]);
    if (copy && (!plans.length || !source.plans.slice(offset, offset + plans.length).every((plan, index) => plan === plans[index]))) {
      throw new Error('Invalid copy slice');
    }
    if (!Number.isSafeInteger(charged) || charged < 0 || source.violation) throw new Error('Invalid reservation result');

    const idArgs = [json(plans.map(plan => plan.id))];
    const pages = plans.map(plan => ({
      id: plan.id, uuid: plan.uuid, name: plan.name, slug: plan.slug, page_type: plan.pageType, lect: plan.lect,
      weight: plan.weight, start: plan.start, end: plan.end, timezone: plan.timezone, page_id: plan.parentId,
      creator: null, editors: null, created_at: null, updated_at: null,
    }));
    const leadingWrites: PlannedWrite[] = pages.map(page => ({
      sql: 'INSERT INTO pages(id,uuid,name,slug,page_type,lect,weight,start,end,timezone,page_id,creator,editors) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)',
      args: [page.id, page.uuid, page.name, page.slug, page.page_type, page.lect, page.weight, page.start, page.end, page.timezone, page.page_id],
    }));
    const links: Row[] = [];
    const versions: Array<{ uuid: string; page_id: number; lect: string }> = [];
    const provenance = new Map(copy?.sources.map(pair => [pair.targetUuid, pair]));
    const groups: MutationGroup[] = plans.map(plan => {
      const original = provenance.get(plan.uuid);
      const writes: PlannedWrite[] = [];
      if (original?.floor) writes.push({
        sql: 'INSERT INTO page_sensitivity_floors(uuid,level) VALUES (?,?) ON CONFLICT(uuid) DO UPDATE SET level=MAX(level,excluded.level)',
        args: [plan.uuid, original.floor],
      });
      const version = { uuid: crypto.randomUUID(), page_id: plan.id, lect: plan.lect };
      versions.push(version);
      writes.push({
        sql: `INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (${NEXT_SNAPSHOT_ID_SQL},?,?,?,'create')`,
        args: [version.uuid, version.page_id, version.lect],
      });
      const tagIds = [...new Set(plan.tags)];
      for (const tag of tagIds) {
        const uuid = crypto.randomUUID();
        links.push({ uuid, page_id: plan.id, tag_id: tag, weight: 5, created_at: null, updated_at: null });
        writes.push({
          sql: `INSERT INTO page_tags(id,uuid,page_id,tag_id) SELECT ${nextIdSql('page_tags')},?,?,?`,
          args: [uuid, plan.id, tag],
        });
      }
      return {
        writes,
        evidence: {
          entry: {
            action: copy ? 'page.duplicate' : 'page.create', entityType: 'page', entityId: plan.uuid,
            detail: {
              operation_id: source.operationId, registry_id: source.authority.registryId,
              identity_fingerprint: source.authority.identityFingerprint, principal: 'credential_authenticated_plugin',
              version_uuid: version.uuid, fields: ['content', 'history', 'tags'],
              ...(original ? { source_id: original.id, source_uuid: original.uuid, copied_floor: original.floor } : {}),
              tag_ids: tagIds, operation_reservation_charged: charged,
              ...(source.detail.acting_user_verified === false ? {
                acting_user_verified: false,
                ...(source.detail.asserted_user_id ? { asserted_user_id: source.detail.asserted_user_id } : { acting_user_unrecordable: true }),
              } : {}),
            },
          },
          dataClass: strongestClass([source.dataClass, source.classification(plan)]),
        },
      };
    });
    if (copy) {
      const pairs = plans.map(plan => provenance.get(plan.uuid)!);
      const last = offset + plans.length === source.plans.length;
      groups.push({
        evidence: {
          entry: {
            action: 'page.duplicate.chunk', entityType: 'page_duplicate_operation', entityId: source.operationId,
            detail: {
              operation_id: source.operationId, registry_id: source.authority.registryId,
              chunk_index: Math.floor(offset / 100), count: plans.length,
              cursor_before: offset ? copy.sources[offset - 1].id : copy.detail.source_cursor,
              cursor_after: pairs.at(-1)!.id,
              targets: pairs.map(pair => ({ source_id: pair.id, source_uuid: pair.uuid, target_uuid: pair.targetUuid })),
              request_complete: last, done: last && Number(copy.detail.source_count) <= source.plans.length,
            },
          },
          dataClass: source.dataClass,
        },
      });
    }
    return {
      admit: [...source.admission(plans), ...source.quotaAdmission(plans)],
      leadingWrites,
      groups,
      expect: since => {
        const checks = [
          resultGuard(c, 'pages', PAGE, pages, since, 'id IN (SELECT value FROM json_each(?))', idArgs),
          resultGuard(c, 'page_tags', LINK, links, since, 'page_id IN (SELECT value FROM json_each(?))', idArgs),
          abortIf(c.env, '(SELECT COUNT(*) FROM page_versions WHERE page_id IN (SELECT value FROM json_each(?)))<>?', [...idArgs, versions.length]),
        ];
        for (const table of ['page_versions', 'page_tags']) checks.push(abortIf(c.env,
          `EXISTS(SELECT 1 FROM ${table} WHERE page_id IN (SELECT value FROM json_each(?)) AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))`, idArgs));
        for (const version of versions) checks.push(abortIf(c.env,
          "NOT EXISTS(SELECT 1 FROM page_versions WHERE uuid=? AND page_id=? AND lect=? AND action='create' AND created_at>=? AND created_at<=CURRENT_TIMESTAMP AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)",
          [version.uuid, version.page_id, version.lect, since, since]));
        for (const plan of plans) {
          const classes = [classFor(source.authority.policy, 'page_type', plan.pageType),
            ...source.tags.filter(tag => plan.tags.includes(Number(tag.id))).map(tag => classFor(source.authority.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default')))];
          const level = Math.max(provenance.get(plan.uuid)?.floor ?? 0, classes.includes('phi') ? 2 : classes.includes('pii') ? 1 : 0);
          checks.push(abortIf(c.env, 'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>? OR (SELECT COUNT(*) FROM pages WHERE slug=?)<>1',
            [plan.uuid, level, plan.slug]));
          if (plan.parentId !== null) checks.push(abortIf(c.env, `NOT EXISTS(SELECT 1 FROM pages WHERE id=? AND ${legacyPageFilter('pages.uuid')})`, [plan.parentId]));
        }
        for (const quota of source.quotas) checks.push(abortIf(c.env, `(SELECT COUNT(*) FROM pages p WHERE ${quota.sql})>?`, [...quota.args, quota.limit]));
        for (const [type, previous] of source.typeFloors) {
          const classes = source.plans.filter(plan => plan.pageType === type).flatMap(plan => [
            classFor(source.authority.policy, 'page_type', type),
            ...source.tags.filter(tag => plan.tags.includes(Number(tag.id))).map(tag => classFor(source.authority.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default'))),
          ]);
          const next = copy ? previous : Math.max(previous, classes.includes('phi') ? 2 : classes.includes('pii') ? 1 : 0);
          checks.push(abortIf(c.env, `(${source.typeFloorSql})<>?`, [...source.typeFloorArgs(type), next]));
        }
        return checks;
      },
      returning: { sql: 'SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?))', args: idArgs },
    };
  }) as unknown as Page[];
  const byId = new Map(saved.map(page => [page.id, page]));
  if (saved.length !== plans.length || plans.some(plan => !byId.has(plan.id))) return unavailable(c, source.authority, false);
  return plans.map(plan => byId.get(plan.id)!);
}
