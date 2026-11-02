import type { Env, JWTPayload, Page } from '../../types';
import type { AppContext } from '../http/context';
import { captureAccessAuthorization, captureContentJobAuthorization } from '../auth/access-authorization';
import { classFor, resolveDataClasses, classificationPolicyGuard } from '../db/data-classes';
import { attributedMutationAuditEvidence, type AuditActor } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { auditBackgroundReads } from '../http/access-log';
import { recordAuditOutage } from '../db/audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

export interface ContentJobLease {
  id: string;
  attempt: number;
  /** Prepared by the owning optional feature; core never imports its schema. */
  guard: D1PreparedStatement;
}
export interface ContentBatchContext { request?: AppContext; job?: ContentJobLease }
export interface PageWeight { id: number; weight: number }
export interface ReorderSnapshot { pageType: string; rows: Array<{id:number;uuid:string;name:string;weight:number;page_type:string|null}> }
export interface LocalPageChange { before: Page; name?: string; lect?: string | null; tags?: number[]; previousTagIds?: number[] }
const PAGE_FIELDS = ['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'] as const;
const METADATA_FIELDS = ['id','uuid','name','weight','page_type'] as const;
const MAX_MANIFEST_ROWS = 5000;

function bounded(value: unknown): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 1_000_000) throw new Error('Content batch manifest requires review');
  return json;
}
function rowGuard(env: Env, pages: object[], fields: readonly string[]) {
  return abortIf(env, `EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM pages p
    WHERE ${fields.map(f=>`p.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`, [bounded(pages)]);
}
async function prepare(env: Env, user: JWTPayload, pages: Array<Pick<Page,'id'|'uuid'|'page_type'>>, extraTagIds: number[], context: ContentBatchContext, includeHistory = false) {
  assertRegulatedWritesAllowed(env);
  const job = context.job && await captureContentJobAuthorization(env,user,context.job.guard);
  const authority = job?.authorization ?? await captureAccessAuthorization(env,user,'content:write');
  if (!authority.allowed) throw new Error('Content authority unavailable');
  const policy = await resolveDataClasses(env,true);
  if (!policy.ok) throw new Error('Content classification unavailable');
  const ids = pages.map(p=>p.id);
  const [links,tags,floors,versions] = await env.DB.batch([
    env.DB.prepare('SELECT id,page_id,tag_id FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(bounded(ids)),
    env.DB.prepare(`SELECT id,taxonomy_slug FROM tags WHERE id IN (SELECT value FROM json_each(?))
      OR id IN (SELECT tag_id FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 5001`).bind(bounded(extraTagIds),bounded(ids)),
    env.DB.prepare('SELECT uuid,level FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) ORDER BY uuid').bind(bounded(pages.map(p=>p.uuid))),
    env.DB.prepare('SELECT id,page_id FROM page_versions WHERE page_id IN (SELECT value FROM json_each(?)) AND ? ORDER BY id LIMIT 5001').bind(bounded(ids),includeHistory?1:0),
  ]);
  if (links.results.length > MAX_MANIFEST_ROWS || tags.results.length > MAX_MANIFEST_ROWS || versions.results.length > MAX_MANIFEST_ROWS) throw new Error('Content batch manifest requires review');
  const linkRows = links.results as Array<{id:number;page_id:number;tag_id:number}>;
  const tagRows = tags.results as Array<{id:number;taxonomy_slug:string|null}>;
  const floorRows = floors.results as Array<{uuid:string;level:number}>;
  const versionRows = versions.results as Array<{id:number;page_id:number}>;
  if (floorRows.some(f=>f.level!==1&&f.level!==2)) throw new Error('Content floor invalid');
  const guards = [authority.guard(),classificationPolicyGuard(env,policy)];
  if (job) guards.push(job.delegationGuard);
  const membershipGuard = () => abortIf(env, `(SELECT COUNT(*) FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?))) <> ?
    OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_tags t WHERE t.id=json_extract(e.value,'$.id')
      AND t.page_id=json_extract(e.value,'$.page_id') AND t.tag_id=json_extract(e.value,'$.tag_id')))`,[bounded(ids),linkRows.length,bounded(linkRows)]);
  const tagGuard = () => abortIf(env,`EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM tags t
    WHERE t.id=json_extract(e.value,'$.id') AND t.taxonomy_slug IS json_extract(e.value,'$.taxonomy_slug')))`,[bounded(tagRows)]);
  const floorGuard = () => abortIf(env, `(SELECT COUNT(*) FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?))) <> ?
    OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_sensitivity_floors f WHERE f.uuid=json_extract(e.value,'$.uuid') AND f.level=json_extract(e.value,'$.level')))`,[bounded(pages.map(p=>p.uuid)),floorRows.length,bounded(floorRows)]);
  guards.push(membershipGuard(),tagGuard(),floorGuard());
  const floorByUuid = new Map(floorRows.map(f=>[f.uuid,f.level]));
  const tagsById = new Map(tagRows.map(t=>[t.id,t]));
  const linksByPage = new Map<number,number[]>();
  for (const link of linkRows) { const ids=linksByPage.get(link.page_id)??[];ids.push(link.tag_id);linksByPage.set(link.page_id,ids); }
  const tableClasses = ['pages','page_tags','page_versions','tags','taxonomies'].map(t=>classFor(policy,'table',t));
  const dataClass = (page: Pick<Page,'id'|'uuid'|'page_type'>) => {
    const classes = [...tableClasses,classFor(policy,'page_type',page.page_type??'default')];
    for (const id of new Set([...(linksByPage.get(page.id)??[]),...extraTagIds])) {
      const tag=tagsById.get(id);if(tag)classes.push(classFor(policy,'taxonomy',tag.taxonomy_slug??'default'));
    }
    const floor = floorByUuid.get(page.uuid);
    return floor===2 || classes.includes('phi') ? 'phi' as const : floor===1 || classes.includes('pii') ? 'pii' as const : 'none' as const;
  };
  const actor: AuditActor = {userId:user.sub,roles:user.role,sessionSid:user.sid??null,via:context.job ? `job:${context.job.id}` : null};
  const grouped = new Map<string,typeof pages>();
  for (const page of pages) { const key=page.page_type??'default'; const group=grouped.get(key)??[];group.push(page);grouped.set(key,group); }
  await auditBackgroundReads(env,[...grouped].map(([key,group])=>({action:'page.batch-mutation-read',kind:'page_type' as const,key,targetType:'page',
    ids:group.map(p=>String(p.id)),count:group.length,uuidById:Object.fromEntries(group.map(p=>[String(p.id),p.uuid]))})),actor);
  const operationId = crypto.randomUUID();
  const details = {operation_id:operationId,...(context.job ? {job_id:context.job.id,job_attempt:context.job.attempt}: {})};
  const evidence = (entry: Parameters<typeof attributedMutationAuditEvidence>[2], classification: 'none'|'pii'|'phi', targets?: string[]) =>
    attributedMutationAuditEvidence(env,user,{...entry,detail:{...entry.detail,...details}},classification,policy,{context:context.request,via:actor.via??undefined,targetIds:targets});
  return {guards,policy,linkRows,tagRows,versionRows,floorRows,dataClass,evidence,membershipGuard,tagGuard,floorGuard,ids};
}

/** One transaction for all selected weights; a reorder also checks the entire
 * observed sequence, including names that break equal-weight ties. */
async function updateWeights(env: Env,user: JWTPayload, updates: PageWeight[], context: ContentBatchContext = {}, sequence?: ReorderSnapshot): Promise<void> {
  assertRegulatedWritesAllowed(env);
  if (updates.length>5000 || updates.some(u=>!Number.isSafeInteger(u.id)||u.id<=0||!Number.isFinite(u.weight)) || new Set(updates.map(u=>u.id)).size!==updates.length) throw new Error('Invalid weight manifest');
  if (!updates.length) return;
  const byId = new Map(updates.map(u=>[u.id,u.weight]));
  const rows = await env.DB.prepare(`SELECT id,uuid,name,weight,page_type FROM pages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(bounded(updates.map(u=>u.id))).all<Pick<Page,'id'|'uuid'|'name'|'weight'|'page_type'>>();
  if (rows.results.length!==updates.length) throw new Error('Weight targets changed');
  const prepared = await prepare(env,user,rows.results,[],context);
  const changed = rows.results.filter(p=>byId.get(p.id)!!==p.weight);
  const guards = [...prepared.guards,rowGuard(env,rows.results,METADATA_FIELDS)];
  if (sequence) {
    if (sequence.rows.length>5000) throw new Error('Reorder manifest requires review');
    guards.push(abortIf(env,'(SELECT COUNT(*) FROM pages WHERE page_type = ?) <> ?',[sequence.pageType,sequence.rows.length]),rowGuard(env,sequence.rows,METADATA_FIELDS));
  }
  if (!changed.length) { await env.DB.batch(guards); return; }
  const manifest = changed.map(p=>({id:p.id,uuid:p.uuid,weight_before:p.weight,weight_after:byId.get(p.id)!}));
  const finalRows = rows.results.map(p=>({...p,weight:byId.get(p.id)!}));
  const classes = changed.map(prepared.dataClass);
  const dataClass = classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  const receipt = prepared.evidence({action:sequence?'page.reorder':updates.length===1?'page.weight':'page.weights',entityType:'page',detail:{targets:manifest}},dataClass,changed.map(p=>p.uuid));
  await env.DB.batch([...guards,
    env.DB.prepare(`UPDATE pages SET weight=json_extract(e.value,'$.weight_after') FROM json_each(?) e
      WHERE pages.id=json_extract(e.value,'$.id')`).bind(bounded(manifest)),
    abortIf(env,'changes() <> ?',[changed.length]),receipt.write,receipt.guard,
    rowGuard(env,finalRows,METADATA_FIELDS),prepared.membershipGuard(),prepared.tagGuard(),prepared.floorGuard(),classificationPolicyGuard(env,prepared.policy),prepared.guards[0],
    ...(sequence ? [abortIf(env,'(SELECT COUNT(*) FROM pages WHERE page_type=?) <> ?',[sequence.pageType,sequence.rows.length]),
      rowGuard(env,sequence.rows.map(p=>({...p,weight:byId.get(p.id)??p.weight})),METADATA_FIELDS)] : []),
    ...(context.job ? [context.job.guard] : [])]);
}

/** A bounded local bulk slice. Its changed pages and all receipts commit together. */
async function applyChanges(env: Env,user: JWTPayload, changes: LocalPageChange[], context: ContentBatchContext = {}): Promise<void> {
  assertRegulatedWritesAllowed(env);
  if (changes.length>100 || new Set(changes.map(c=>c.before.id)).size!==changes.length) throw new Error('Invalid bulk manifest');
  if (!changes.length) return;
  const extraTags = [...new Set(changes.flatMap(c=>c.tags??[]))];
  if (extraTags.length>5000 || extraTags.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error('Invalid bulk tags');
  const prepared = await prepare(env,user,changes.map(c=>c.before),extraTags,context,true);
  for (const change of changes) if (change.previousTagIds && bounded([...change.previousTagIds].sort((a,b)=>a-b)) !== bounded(prepared.linkRows.filter(l=>l.page_id===change.before.id).map(l=>l.tag_id).sort((a,b)=>a-b))) throw new Error('Bulk tag membership changed');
  if (extraTags.some(id=>!prepared.tagRows.some(t=>t.id===id))) throw new Error('Bulk tag unavailable');
  const finalTagCount=changes.reduce((n,c)=>n+(c.tags ? new Set(c.tags).size : prepared.linkRows.filter(l=>l.page_id===c.before.id).length),0);
  if (finalTagCount>MAX_MANIFEST_ROWS) throw new Error('Bulk tag manifest requires review');
  const statements = [...prepared.guards,rowGuard(env,changes.map(c=>c.before),PAGE_FIELDS)];
  const expectedVersions: Array<{uuid:string;page_id:number;lect:string|null}> = [];
  const finals = changes.map(change=>({...change.before,name:change.name??change.before.name,lect:change.lect===undefined?change.before.lect:change.lect}));
  for (const [index,change] of changes.entries()) {
    const page=finals[index];
    statements.push(env.DB.prepare('UPDATE pages SET name=?,lect=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(page.name,page.lect,page.id),abortIf(env,'changes() <> 1'));
    if (change.tags) {
      statements.push(env.DB.prepare('DELETE FROM page_tags WHERE page_id=?').bind(page.id));
      statements.push(env.DB.prepare('INSERT INTO page_tags(page_id,tag_id) SELECT ?, value FROM json_each(?)').bind(page.id,bounded([...new Set(change.tags)])));
    } else {
      const uuid=crypto.randomUUID();expectedVersions.push({uuid,page_id:page.id,lect:page.lect});
      statements.push(env.DB.prepare("INSERT INTO page_versions(uuid,page_id,lect,action) VALUES (?,?,?,'bulk-replace')").bind(uuid,page.id,page.lect),abortIf(env,'changes() <> 1'));
    }
    const detail = change.tags ? {fields:['tags'],tags_before:prepared.linkRows.filter(l=>l.page_id===page.id).map(l=>l.tag_id),tags_after:[...new Set(change.tags)],tag_count:new Set(change.tags).size} : {fields:['name','lect'],version_uuid:expectedVersions.at(-1)!.uuid};
    const receipt=prepared.evidence({action:'page.update',entityType:'page',entityId:page.id,detail:{...detail,operation_target_count:changes.length,operation_index:index}},prepared.dataClass(page));
    statements.push(receipt.write,receipt.guard);
  }
  const expectedLinks = changes.flatMap(c=>(c.tags ? [...new Set(c.tags)] : prepared.linkRows.filter(l=>l.page_id===c.before.id).map(l=>l.tag_id)).map(tag_id=>({page_id:c.before.id,tag_id})));
  statements.push(rowGuard(env,finals,PAGE_FIELDS.filter(f=>f!=='updated_at')),prepared.tagGuard(),
    abortIf(env,`(SELECT COUNT(*) FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?))) <> ?
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_tags t WHERE t.page_id=json_extract(e.value,'$.page_id') AND t.tag_id=json_extract(e.value,'$.tag_id')))
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE (SELECT COUNT(*) FROM page_tags t WHERE t.page_id=json_extract(e.value,'$.page_id') AND t.tag_id=json_extract(e.value,'$.tag_id'))
        <> (SELECT COUNT(*) FROM json_each(?) x WHERE json_extract(x.value,'$.page_id')=json_extract(e.value,'$.page_id') AND json_extract(x.value,'$.tag_id')=json_extract(e.value,'$.tag_id')))`,[bounded(prepared.ids),expectedLinks.length,bounded(expectedLinks),bounded(expectedLinks),bounded(expectedLinks)]),
    abortIf(env,`(SELECT COUNT(*) FROM page_versions WHERE page_id IN (SELECT value FROM json_each(?))) <> ?
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.id=json_extract(e.value,'$.id') AND v.page_id=json_extract(e.value,'$.page_id')))
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.uuid=json_extract(e.value,'$.uuid') AND v.page_id=json_extract(e.value,'$.page_id') AND v.lect IS json_extract(e.value,'$.lect') AND v.action='bulk-replace'))`,
    [bounded(prepared.ids),prepared.versionRows.length+expectedVersions.length,bounded(prepared.versionRows),bounded(expectedVersions)]),classificationPolicyGuard(env,prepared.policy));
  // Tag edits can legitimately raise retained UUID floors; they cannot lower
  // an old floor or leave evidence below the final protection level.
  for (const change of changes) statements.push(abortIf(env,`COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0) > ?
    OR COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0) < ?`,[change.before.uuid,prepared.dataClass(change.before)==='phi'?2:prepared.dataClass(change.before)==='pii'?1:0,
    change.before.uuid,prepared.floorRows.find(f=>f.uuid===change.before.uuid)?.level??0]));
  statements.push(prepared.guards[0]);
  if (context.job) statements.push(context.job.guard);
  await env.DB.batch(statements);
}

export class ContentBatchEvidenceUnavailableError extends Error {
  constructor() { super('Content batch change unavailable'); }
}
async function execute<T>(env: Env, work: () => Promise<T>): Promise<T> {
  assertRegulatedWritesAllowed(env);
  try { return await work(); }
  catch {
    await recordAuditOutage(env,'health',[],undefined,undefined,{captureIncomplete:true});
    throw new ContentBatchEvidenceUnavailableError();
  }
}
export async function updateDraftWeights(env: Env,user: JWTPayload,updates: PageWeight[],context: ContentBatchContext = {},sequence?: ReorderSnapshot): Promise<void> {
  return execute(env,()=>updateWeights(env,user,updates,context,sequence));
}
export async function applyLocalPageChanges(env: Env,user: JWTPayload,changes: LocalPageChange[],context: ContentBatchContext = {}): Promise<void> {
  return execute(env,()=>applyChanges(env,user,changes,context));
}
