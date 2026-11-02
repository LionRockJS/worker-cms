import type { Env } from '../../types';
import type { AppContext } from '../http/context';
import { captureAccessAuthorization } from '../auth/access-authorization';
import { classFor, resolveDataClasses, classificationPolicyGuard } from '../db/data-classes';
import { attributedMutationAuditEvidence } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { auditBackgroundReads } from '../http/access-log';
import { recordAuditOutage } from '../db/audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

const PAGE = ['id','uuid','page_type','updated_at'];
const LINK = ['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const TAG = ['id','uuid','taxonomy_slug'];
type Row = Record<string,string|number|null>;
type Bind = string|number|null;
type Change = {action:'add';pageId:number;tagId:number}|{action:'remove';id:number};
export class PageTagEvidenceUnavailableError extends Error { constructor(){super('Page tag change unavailable');} }
function json(value:unknown):string {
  const result=JSON.stringify(value);
  if(new TextEncoder().encode(result).length>1_000_000)throw new Error('Association manifest requires review');
  return result;
}
/** Only identity/association metadata is loaded; enforce the budget in SQL. */
async function snapshot(env:Env,table:string,fields:string[],where:string,bindings:Bind[]):Promise<Row[]> {
  const object=`json_object(${fields.map(f=>`'${f}',r.${f}`).join(',')})`;
  const result=await env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY id LIMIT 5001),
    budget AS (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END snapshot FROM budget`).bind(...bindings).first<{snapshot:string}>();
  if(!result)throw new Error('Association snapshot unavailable');
  const rows=JSON.parse(result.snapshot) as Row[];
  if(rows.some(r=>!Number.isSafeInteger(r.id)||Number(r.id)<=0))throw new Error('Unsafe association identity');
  return rows;
}
function guard(env:Env,table:string,fields:string[],where:string,bindings:Bind[],rows:Row[]) {
  return abortIf(env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e
    WHERE NOT EXISTS (SELECT 1 FROM ${table} r WHERE ${fields.map(f=>`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...bindings,rows.length,json(rows)]);
}

/** Host HTTP associations only. A missing add target returns null; a missing
 * removal is a guarded no-op. No publication, history or hook effect is added. */
export async function mutateHostPageTag(c:AppContext,change:Change):Promise<{id:number;created:boolean}|null> {
  assertRegulatedWritesAllowed(c.env);
  try {return await mutate(c,change);}
  catch {
    await recordAuditOutage(c.env,'health',[],undefined,undefined,{captureIncomplete:true});
    throw new PageTagEvidenceUnavailableError();
  }
}
async function mutate(c:AppContext,change:Change):Promise<{id:number;created:boolean}|null> {
  const env=c.env,user=c.get('user');
  const input=change.action==='add'?[change.pageId,change.tagId]:[change.id];
  if(input.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid association selection');
  const authority=await captureAccessAuthorization(env,user,'content:write');
  if(!authority.allowed)throw new Error('Association authority unavailable');
  const policy=await resolveDataClasses(env,true);
  if(!policy.ok)throw new Error('Association classification unavailable');
  const admission=[authority.guard(),classificationPolicyGuard(env,policy)];
  const selected=change.action==='remove'?await snapshot(env,'page_tags',LINK,'id=?',[change.id]):[];
  if(change.action==='remove'&&!selected.length) {
    await env.DB.batch([...admission,guard(env,'page_tags',LINK,'id=?',[change.id],[])]);
    return {id:change.id,created:false};
  }
  const pageId=change.action==='add'?change.pageId:Number(selected[0].page_id);
  if(!Number.isSafeInteger(pageId)||pageId<=0)throw new Error('Association owner unavailable');
  const pages=await snapshot(env,'pages',PAGE,'id=?',[pageId]);
  const page=pages[0];
  if(!page) {
    if(change.action==='remove')throw new Error('Association owner unavailable');
    await env.DB.batch([...admission,guard(env,'pages',PAGE,'id=?',[pageId],[])]);
    return null;
  }
  const links=await snapshot(env,'page_tags',LINK,'page_id=?',[pageId]);
  if(links.some(l=>!Number.isSafeInteger(l.tag_id)||Number(l.tag_id)<=0||(l.weight!==null&&!Number.isFinite(l.weight))))throw new Error('Invalid association metadata');
  const tagIds=[...new Set([...links.map(l=>l.tag_id),...(change.action==='add'?[change.tagId]:[])])];
  const tagWhere='id IN (SELECT value FROM json_each(?))', tagArgs=[json(tagIds)];
  const tags=await snapshot(env,'tags',TAG,tagWhere,tagArgs);
  const floor=await env.DB.prepare('SELECT level FROM page_sensitivity_floors WHERE uuid=?').bind(page.uuid).first<{level:number}>();
  if(floor&&floor.level!==1&&floor.level!==2)throw new Error('Invalid association sensitivity');
  const classes=['pages','page_tags','tags','taxonomies'].map(t=>classFor(policy,'table',t));
  classes.push(classFor(policy,'page_type',String(page.page_type??'default')));
  for(const tag of tags)classes.push(classFor(policy,'taxonomy',String(tag.taxonomy_slug??'default')));
  const inherited=[classFor(policy,'page_type',String(page.page_type??'default')),...tags.map(t=>classFor(policy,'taxonomy',String(t.taxonomy_slug??'default')))];
  const minimumFloor=Math.max(floor?.level??0,inherited.includes('phi')?2:inherited.includes('pii')?1:0);
  const dataClass=floor?.level===2||classes.includes('phi')?'phi':floor?.level===1||classes.includes('pii')?'pii':'none';
  await auditBackgroundReads(env,[{action:'page.tag-association-read',kind:'page_type',key:String(page.page_type??'default'),targetType:'page',ids:[String(page.id)],count:1,
    uuidById:{[String(page.id)]:String(page.uuid)},minimumClass:dataClass==='none'?undefined:dataClass}],
    {userId:user.sub,roles:user.role,sessionSid:user.sid??null,via:null});
  const common=[...admission,guard(env,'pages',PAGE,'id=?',[pageId],pages),guard(env,'page_tags',LINK,'page_id=?',[pageId],links),
    guard(env,'tags',TAG,tagWhere,tagArgs,tags),
    abortIf(env,'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>?',[page.uuid,floor?.level??0])];
  if(change.action==='remove')common.push(guard(env,'page_tags',LINK,'id=?',[change.id],selected));
  // Refuse dangling new targets; legacy unrelated dangling links are preserved.
  if(change.action==='add'&&!tags.some(t=>t.id===change.tagId)) {await env.DB.batch(common);return null;}
  const existing=change.action==='add'?links.find(l=>l.tag_id===change.tagId):undefined;
  if(existing) {await env.DB.batch(common);return {id:Number(existing.id),created:false};}
  const clock=await env.DB.prepare("SELECT CURRENT_TIMESTAMP AS now").first<{now:string}>();
  if(!clock)throw new Error('Association clock unavailable');
  let affected:Row;
  if(change.action==='add') {
    if(links.length>=5000)throw new Error('Association manifest requires review');
    const next=await env.DB.prepare(`SELECT MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 id FROM page_tags`).first<{id:number}>();
    if(!next||!Number.isSafeInteger(next.id)||next.id<=0)throw new Error('Unsafe association identity');
    affected={id:next.id,uuid:crypto.randomUUID(),created_at:clock.now,updated_at:clock.now,page_id:pageId,tag_id:change.tagId,weight:5};
  } else affected=selected[0];
  const finalLinks=change.action==='add'?[...links,affected]:links.filter(l=>l.id!==affected.id);
  const detail={operation_id:crypto.randomUUID(),fields:['tags'],page:{id:page.id,uuid:page.uuid},
    association:affected,links_before:links,links_after:finalLinks};json(detail);
  const receipt=attributedMutationAuditEvidence(env,user,{action:change.action==='add'?'page.tag-add':'page.tag-remove',entityType:'page',entityId:String(page.uuid),detail},dataClass,policy,{context:c});
  const business=change.action==='add'
    ?env.DB.prepare(`INSERT INTO page_tags(${LINK.join(',')}) VALUES (${LINK.map(()=>'?').join(',')})`).bind(...LINK.map(f=>affected[f]))
    :env.DB.prepare('DELETE FROM page_tags WHERE id=?').bind(affected.id);
  await env.DB.batch([...common,business,abortIf(env,'changes()<>1'),
    env.DB.prepare('UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(pageId),abortIf(env,'changes()<>1'),
    receipt.write,receipt.guard,
    guard(env,'pages',PAGE.filter(f=>f!=='updated_at'),'id=?',[pageId],pages),
    abortIf(env,'NOT EXISTS (SELECT 1 FROM pages WHERE id=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)',[pageId,clock.now]),guard(env,'page_tags',LINK,'page_id=?',[pageId],finalLinks),
    guard(env,'tags',TAG,tagWhere,tagArgs,tags),classificationPolicyGuard(env,policy),authority.guard(),
    abortIf(env,`COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<? OR
      COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)>?`,[page.uuid,minimumFloor,page.uuid,dataClass==='phi'?2:dataClass==='pii'?1:0])]);
  return {id:Number(affected.id),created:change.action==='add'};
}
