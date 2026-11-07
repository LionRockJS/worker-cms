import type { AppContext } from '../../core/http/context';
import type { PluginPageMutationAuthority } from './page-update-evidence';
import { assertPluginPageAuthority } from './page-update-evidence';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError } from '../../core/db/audit';
import { snapshot, guard, resultGuard, json, fingerprint, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { classFor } from '../../core/db/data-classes';
import { auditBackgroundReads, flushReadAudit, recordTagReads } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { slugify } from '../../core/http/forms';
import { publishTagsToTargets } from '../../core/publish';

const TAX=['id','uuid','created_at','updated_at','name','slug'];
const TAG=['id','uuid','created_at','updated_at','name','slug','weight','taxonomy_slug','parent_tag','lect'];
const OWNER=['id','uuid','slug','taxonomy_slug'];
const NEXT_TAG_ID=`(SELECT MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 FROM tags)`;
/** Find/create is one local transaction, including reused identities and item
 * decisions. Catalogue publication has its own external outcome. */
export async function ensurePluginTags(c:AppContext,authority:PluginPageMutationAuthority,input:unknown):Promise<Response> {
 assertRegulatedWritesAllowed(c.env);
 const operationId=crypto.randomUUID();let attempted=false,committed=false,dataClass=authority.dataClass;
 const detail:Record<string,unknown>={operation_id:operationId,registry_id:authority.registryId,identity_fingerprint:authority.identityFingerprint,principal:'credential_authenticated_plugin'};
 const asserted=c.req.header('x-acting-user-id');if(asserted!==undefined){detail.acting_user_verified=false;const id=Number(asserted);if(/^\d+$/.test(asserted)&&Number.isSafeInteger(id)&&id>0)detail.asserted_user_id=id;else detail.acting_user_unrecordable=true;}
 try {
  assertPluginPageAuthority(authority,'tag-ensure');
  if(!authority.allowed.size){const receipt=serviceMutationAuditEvidence(c.env,{action:'tag.ensure',entityType:'tag_ensure_operation',entityId:operationId,outcome:'denied',detail:{...detail,reason:'write_scope_required'}},authority.actor,dataClass,authority.policy,c);await c.env.DB.batch([...authority.check(),receipt.write,receipt.guard,...authority.check(),receipt.guard]);return c.json({error:'forbidden'},403);}
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
  const keys=[...new Set(pairs.map(p=>p.taxonomy))],taxArgs=[json(keys)],taxWhere='slug IN (SELECT value FROM json_each(?))';
  const taxonomies=await snapshot<Row>(c,'taxonomies',TAX,taxWhere,taxArgs);
  const accepted=pairs.filter(pair=>{if(taxonomies.some(t=>t.slug===pair.taxonomy))return true;errors.push({index:pair.index,error:'unknown_taxonomy'});return false;});
  errors.sort((a,b)=>a.index-b.index);
  const unique=[...new Map(accepted.map(p=>[json([p.taxonomy,p.name]),p])).values()];
  const pairArgs=[json(unique)],pairWhere="EXISTS(SELECT 1 FROM json_each(?) e WHERE tags.taxonomy_slug=json_extract(e.value,'$.taxonomy') AND tags.name=json_extract(e.value,'$.name'))";
  const existing=await snapshot<Row>(c,'tags',TAG,pairWhere,pairArgs);
  const missing=unique.filter(p=>!existing.some(t=>t.taxonomy_slug===p.taxonomy&&t.name===p.name));
  const baseFor=(pair:typeof unique[number])=>{const taxonomy=taxonomies.find(t=>t.slug===pair.taxonomy)!;return slugify(`${taxonomy.slug||taxonomy.name}-${pair.name}`)||'tag';};
  const bases=[...new Set(missing.map(baseFor))];
  const slugWhere="EXISTS(SELECT 1 FROM json_each(?) e WHERE tags.slug=e.value OR substr(tags.slug,1,length(e.value)+1)=e.value||'-')",slugArgs=[json(bases)];
  const owners=await snapshot<Row>(c,'tags',OWNER,slugWhere,slugArgs);
  const classes=[...owners.map(t=>classFor(authority.policy,'taxonomy',String(t.taxonomy_slug??'default'))),authority.dataClass,...keys.map(key=>classFor(authority.policy,'taxonomy',key))];
  dataClass=classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  const requestFingerprint=await fingerprint(json(pairs));detail.request_fingerprint=requestFingerprint;
  await auditBackgroundReads(c.env,[['taxonomies',taxonomies],['tags',existing],['tags',owners]].map(([table,rows])=>({action:'plugin.tag-ensure-source-read',kind:'table' as const,key:table as string,targetType:table as string,ids:(rows as Row[]).map(row=>String(row.id)),count:(rows as Row[]).length,minimumClass:dataClass==='none'?undefined:dataClass})),authority.actor);
  if(await flushReadAudit(c))throw new Error('Tag source evidence unavailable');
  const used=new Set(owners.map(t=>String(t.slug))),created:Row[]=[];
  for(const pair of missing){const base=baseFor(pair);let slug=base,suffix=1;while(used.has(slug)){if(++suffix>5001)throw new Error('Tag slug namespace requires review');slug=`${base}-${suffix}`;}used.add(slug);created.push({uuid:crypto.randomUUID(),created_at:null,updated_at:null,name:pair.name,slug,weight:5,taxonomy_slug:pair.taxonomy,parent_tag:null,lect:null});}
  const selected=unique.map(p=>({pair:p,tag:existing.find(t=>t.taxonomy_slug===p.taxonomy&&t.name===p.name)??created.find(t=>t.taxonomy_slug===p.taxonomy&&t.name===p.name)!}));
  const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Tag clock unavailable');
  const initial=()=>[...authority.check(),guard(c,'taxonomies',TAX,taxonomies,taxWhere,taxArgs),guard(c,'tags',TAG,existing,pairWhere,pairArgs),guard(c,'tags',OWNER,owners,slugWhere,slugArgs)];
  const statements=initial(),receipts=[];
  for(const tag of created)statements.push(c.env.DB.prepare(`INSERT INTO tags(id,uuid,name,slug,taxonomy_slug) VALUES (${NEXT_TAG_ID},?,?,?,?)`).bind(tag.uuid,tag.name,tag.slug,tag.taxonomy_slug),abortIf(c.env,'changes()<>1'));
  for(const {pair,tag} of selected){const taxonomy=taxonomies.find(t=>t.slug===pair.taxonomy)!;const isNew=created.includes(tag);const receipt=serviceMutationAuditEvidence(c.env,{action:isNew?'tag.create':'tag.ensure',entityType:'tag',entityId:String(tag.uuid),detail:{...detail,created:isNew,taxonomy_id:taxonomy.id,taxonomy_uuid:taxonomy.uuid,input_indices:accepted.filter(p=>p.taxonomy===pair.taxonomy&&p.name===pair.name).map(p=>p.index)}},authority.actor,dataClass,authority.policy,c);statements.push(receipt.write,receipt.guard);receipts.push(receipt);}
  if(items.length){const receipt=serviceMutationAuditEvidence(c.env,{action:'tag.ensure.batch',entityType:'tag_ensure_operation',entityId:operationId,detail:{...detail,input_count:items.length,targets:selected.map(({pair,tag})=>({uuid:tag.uuid,created:created.includes(tag),input_indices:accepted.filter(p=>p.taxonomy===pair.taxonomy&&p.name===pair.name).map(p=>p.index)})),errors,publication:'separate_effect'}},authority.actor,dataClass,authority.policy,c);statements.push(receipt.write,receipt.guard);receipts.push(receipt);}
  const newUuids=json(created.map(t=>t.uuid)),allTags=[...existing,...created];
  statements.push(guard(c,'taxonomies',TAX,taxonomies,taxWhere,taxArgs),guard(c,'tags',TAG,existing,`(${pairWhere}) AND uuid NOT IN (SELECT value FROM json_each(?))`,[...pairArgs,newUuids]),
   resultGuard(c,'tags',TAG.filter(f=>f!=='id'),allTags,clock.now,pairWhere,pairArgs),
   guard(c,'tags',OWNER,owners,`(${slugWhere}) AND uuid NOT IN (SELECT value FROM json_each(?))`,[...slugArgs,newUuids]),
   abortIf(c.env,`EXISTS(SELECT 1 FROM tags WHERE ${pairWhere} AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))`,pairArgs),
   abortIf(c.env,'EXISTS(SELECT 1 FROM page_tags WHERE tag_id IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?)))) OR EXISTS(SELECT 1 FROM tags WHERE parent_tag IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?))))',[newUuids,newUuids]));
  const trash=await c.env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='trash_page_tags'").first<{n:number}>();
  if(!trash)throw new Error('Tag storage observation unavailable');
  statements.push(abortIf(c.env,"(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='trash_page_tags')<>?",[trash.n]));
  if(trash.n)statements.push(abortIf(c.env,'EXISTS(SELECT 1 FROM trash_page_tags WHERE tag_id IN (SELECT id FROM tags WHERE uuid IN (SELECT value FROM json_each(?))))',[newUuids]));
  statements.push(...receipts.map(r=>r.guard),...authority.check(),c.env.DB.prepare(`SELECT id,uuid FROM tags WHERE ${pairWhere} ORDER BY id`).bind(...pairArgs));
  attempted=true;const result=await c.env.DB.batch(statements);committed=true;
  const rows=result.at(-1)!.results as Array<{id:number;uuid:string}>;
  const ensured=accepted.map(pair=>{const target=selected.find(s=>s.pair.taxonomy===pair.taxonomy&&s.pair.name===pair.name)!.tag;const row=rows.find(r=>r.uuid===target.uuid);if(!row||!Number.isSafeInteger(row.id)||row.id<=0)throw new Error('Tag result unavailable');return {taxonomy:pair.taxonomy,name:pair.name,id:row.id};});
  await publishTagsToTargets(c.env,[...new Set(ensured.map(t=>t.id))],authority.actor);
  recordTagReads('tag.ensure-result',ensured.map(tag=>({id:tag.id,taxonomy_slug:tag.taxonomy})),authority.actor);
  return c.json({tags:ensured,errors});
 }catch(error){
  const known=!attempted||(error instanceof Error && /^D1_ERROR:.*SQLITE_/s.test(error.message));
  try{const receipt=serviceMutationAuditEvidence(c.env,{action:'tag.ensure.result',entityType:'tag_ensure_operation',entityId:operationId,outcome:'error',detail:{...detail,commit_state:committed?'committed':known?'not_committed':'unknown'}},authority.actor,dataClass,authority.policy,c);await c.env.DB.batch([receipt.write,receipt.guard]);}catch{}
  await recordAuditOutage(c.env,'health',[],authority.actor,undefined,{captureIncomplete:true});throw new ServiceMutationUnavailableError();
 }
}
