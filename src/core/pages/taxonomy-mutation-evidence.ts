import type { Env,Tag,Taxonomy } from '../../types';
import type { AppContext } from '../http/context';
import { captureAccessAuthorization } from '../auth/access-authorization';
import { mutationAuditEvidence,attributedMutationAuditEvidence } from '../db/audit';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../db/data-classes';
import { abortIf } from '../db/transaction-guard';
import { recordTagReads,recordTaxonomyReads,flushReadAudit } from '../http/access-log';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

const TAG_FIELDS=['id','uuid','created_at','updated_at','name','slug','weight','taxonomy_slug','parent_tag'] as const;
const TAX_FIELDS=['id','uuid','created_at','updated_at','name','slug'] as const;
const LINK_FIELDS=['id','uuid','page_id','tag_id','weight'] as const;
type TagMetadata=Omit<Tag,'lect'>;
type Bind = string|number|null;
type Row = Record<string,string|number|null>;
function json(value:unknown):string {const result=JSON.stringify(value);if(new TextEncoder().encode(result).length>1_000_000)throw new Error('Taxonomy manifest requires review');return result;}
function exact(env:Env,table:string,where:string,bindings:Bind[],rows:readonly unknown[],fields:readonly string[]) {
  return abortIf(env,`(SELECT COUNT(*) FROM ${table} WHERE ${where}) <> ? OR EXISTS (SELECT 1 FROM json_each(?) e
    WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE ${fields.map(f=>`t.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...bindings,rows.length,json(rows)]);
}
interface Scope { ids?:number[]; uuid?:string; taxonomySlugs?:string[]; childrenOf?:number }
async function snapshot(c:AppContext,scope:Scope,capability:'tag:write'|'taxonomy:write') {
  assertRegulatedWritesAllowed(c.env);
  const authority=await captureAccessAuthorization(c.env,c.get('user'),capability);
  if(!authority.allowed)throw new Error('Taxonomy authority unavailable');
  const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('Taxonomy classification unavailable');
  const where=`id IN (SELECT value FROM json_each(?)) OR uuid=? OR taxonomy_slug IN (SELECT value FROM json_each(?)) OR parent_tag=?`;
  const bindings:Bind[]=[json(scope.ids??[]),scope.uuid??'',json(scope.taxonomySlugs??[]),scope.childrenOf??null];
  const [tags,presence]=await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${TAG_FIELDS.join(',')} FROM tags WHERE ${where} ORDER BY id LIMIT 5001`).bind(...bindings),
    c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_tags') ORDER BY name"),
  ]);
  const tagRows=tags.results as TagMetadata[];
  if(tagRows.length>5000)throw new Error('Taxonomy manifest requires review');
  const trash=presence.results.length===2;if(presence.results.length!==0&&!trash)throw new Error('Trash schema unavailable');
  const ids=tagRows.map(t=>t.id);
  const slugKeys=[...new Set([...(scope.taxonomySlugs??[]),...tagRows.map(t=>t.taxonomy_slug??'default')])];
  const [taxonomies,links,trashLinks,pages,trashPages,floors]=await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM taxonomies WHERE slug IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(json(slugKeys)),
    c.env.DB.prepare('SELECT id,uuid,page_id,tag_id,weight FROM page_tags WHERE tag_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(json(ids)),
    c.env.DB.prepare(trash?'SELECT id,uuid,page_id,tag_id,weight FROM trash_page_tags WHERE tag_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001':'SELECT id,uuid,page_id,tag_id,weight FROM page_tags WHERE 0').bind(...(trash?[json(ids)]:[])),
    c.env.DB.prepare('SELECT id,uuid,page_type FROM pages WHERE id IN (SELECT page_id FROM page_tags WHERE tag_id IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 5001').bind(json(ids)),
    c.env.DB.prepare(trash?'SELECT id,uuid,page_type FROM trash_pages WHERE id IN (SELECT page_id FROM trash_page_tags WHERE tag_id IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 5001':'SELECT id,uuid,page_type FROM pages WHERE 0').bind(...(trash?[json(ids)]:[])),
    c.env.DB.prepare("SELECT container_key,level FROM data_class_floors WHERE container_kind='taxonomy' AND container_key IN (SELECT value FROM json_each(?)) ORDER BY container_key").bind(json(slugKeys)),
  ]);
  if([taxonomies,links,trashLinks,pages,trashPages].some(r=>r.results.length>5000))throw new Error('Taxonomy manifest requires review');
  const taxRows=taxonomies.results as Taxonomy[];
  const pageRows=pages.results as Array<{id:number;uuid:string;page_type:string|null}>;
  const trashRows=trashPages.results as typeof pageRows;
  const uuids=[...new Set([...pageRows,...trashRows].map(p=>p.uuid))];
  const retained=(await c.env.DB.prepare('SELECT uuid,level FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) ORDER BY uuid').bind(json(uuids)).all<{uuid:string;level:number}>()).results;
  if(retained.some(r=>r.level!==1&&r.level!==2))throw new Error('Taxonomy floor invalid');
  const classes=['tags','taxonomies','page_tags','pages',...(trash?['trash_page_tags','trash_pages']:[])].map(t=>classFor(policy,'table',t));
  for(const key of slugKeys)classes.push(classFor(policy,'taxonomy',key));
  for(const page of [...pageRows,...trashRows])classes.push(classFor(policy,'page_type',page.page_type??'default'));
  for(const floor of retained)classes.push(floor.level===2?'phi':'pii');
  const dataClass=classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  recordTagReads('tag.mutation-read',tagRows);recordTaxonomyReads('taxonomy.mutation-read',taxRows);
  if(await flushReadAudit(c))throw new Error('Taxonomy read evidence unavailable');
  const linkWhere='tag_id IN (SELECT value FROM json_each(?))';const linkBind=[json(ids)];
  const guards=[authority.guard(),classificationPolicyGuard(c.env,policy),
    exact(c.env,'tags',where,bindings,tagRows,TAG_FIELDS),
    exact(c.env,'taxonomies','slug IN (SELECT value FROM json_each(?))',[json(slugKeys)],taxRows,TAX_FIELDS),
    exact(c.env,'page_tags',linkWhere,linkBind,links.results,LINK_FIELDS),
    exact(c.env,'pages','id IN (SELECT value FROM json_each(?))',[json(pageRows.map(p=>p.id))],pageRows,['id','uuid','page_type']),
    exact(c.env,'page_sensitivity_floors','uuid IN (SELECT value FROM json_each(?))',[json(uuids)],retained,['uuid','level']),
    abortIf(c.env,"(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_tags')) <> ?",[trash?2:0])];
  if(trash)guards.push(exact(c.env,'trash_page_tags',linkWhere,linkBind,trashLinks.results,LINK_FIELDS),
    exact(c.env,'trash_pages','id IN (SELECT value FROM json_each(?))',[json(trashRows.map(p=>p.id))],trashRows,['id','uuid','page_type']));
  return {scope,where,bindings,tagRows,taxRows,links:links.results as Row[],trashLinks:trashLinks.results as Row[],trash,policy,authority,
    dataClass:dataClass as 'none'|'pii'|'phi',guards,retained,uuids,pageRows,trashRows,slugKeys,floors:floors.results as Array<{container_key:string;level:number}>,linkWhere,linkBind};
}
type Snapshot=Awaited<ReturnType<typeof snapshot>>;
function finalGuards(c:AppContext,s:Snapshot,tags:TagMetadata[],taxonomies:Taxonomy[],links:Row[],trashLinks:Row[],version:number) {
  const level=s.dataClass==='phi'?2:s.dataClass==='pii'?1:0;
  const statements=[classificationPolicyGuard(c.env,{...s.policy,version}),
    exact(c.env,'tags',`(${s.where}) OR id IN (SELECT value FROM json_each(?))`,[...s.bindings,json(s.tagRows.map(t=>t.id))],tags,TAG_FIELDS.filter(f=>f!=='updated_at')),
    exact(c.env,'taxonomies','slug IN (SELECT value FROM json_each(?))',[json(s.slugKeys)],taxonomies,TAX_FIELDS.filter(f=>f!=='updated_at')),
    exact(c.env,'page_tags',s.linkWhere,s.linkBind,links,LINK_FIELDS),
    exact(c.env,'pages','id IN (SELECT value FROM json_each(?))',[json(s.pageRows.map(p=>p.id))],s.pageRows,['id','uuid','page_type']),
    abortIf(c.env,`EXISTS (SELECT 1 FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) AND level>?)
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=json_extract(e.value,'$.uuid')),0)<json_extract(e.value,'$.level'))`,[json(s.uuids),level,json(s.retained)])];
  if(s.trash)statements.push(exact(c.env,'trash_page_tags',s.linkWhere,s.linkBind,trashLinks,LINK_FIELDS),exact(c.env,'trash_pages','id IN (SELECT value FROM json_each(?))',[json(s.trashRows.map(p=>p.id))],s.trashRows,['id','uuid','page_type']));
  return statements;
}
function relatedPages(s:Snapshot) {
  return [...s.pageRows.map(p=>({id:p.id,uuid:p.uuid,source:'draft'})),...s.trashRows.map(p=>({id:p.id,uuid:p.uuid,source:'trash'}))];
}
function detail<T extends Record<string,unknown>>(value:T):T {json(value);return value;}
export type TagValues=Pick<Tag,'name'|'slug'|'weight'|'taxonomy_slug'|'parent_tag'|'lect'>;
const VALUE_FIELDS=['name','slug','weight','taxonomy_slug','parent_tag','lect'] as const;
export async function saveTag(c:AppContext,values:TagValues,before?:Tag):Promise<number> {
  const uuid=before?.uuid??crypto.randomUUID();
  const s=await snapshot(c,{ids:[before?.id,before?.parent_tag,values.parent_tag].filter((id):id is number=>id!==null&&id!==undefined),uuid,taxonomySlugs:[before?.taxonomy_slug??'default',values.taxonomy_slug??'default']},'tag:write');
  if(before && !s.tagRows.some(t=>t.id===before.id&&TAG_FIELDS.every(f=>t[f]===before[f])))throw new Error('Tag changed');
  const statements=s.guards;
  if(before)statements.push(abortIf(c.env,'(SELECT lect FROM tags WHERE id=?) IS NOT ?',[before.id,before.lect]),c.env.DB.prepare(`UPDATE tags SET ${VALUE_FIELDS.map(f=>`${f}=?`).join(',')} WHERE id=?`).bind(...VALUE_FIELDS.map(f=>values[f]),before.id));
  else statements.push(c.env.DB.prepare(`INSERT INTO tags(uuid,${VALUE_FIELDS.join(',')}) VALUES (?,${VALUE_FIELDS.map(()=>'?').join(',')})`).bind(uuid,...VALUE_FIELDS.map(f=>values[f])));
  const evidence=mutationAuditEvidence(c,{action:before?'tag.update':'tag.create',entityType:'tag',entityId:uuid,detail:detail({fields:VALUE_FIELDS.filter(f=>!before||before[f]!==values[f]),...(before?{tag_id:before.id}:{}),related_pages:relatedPages(s)})},s.dataClass,{policy:s.policy,requirePreviousChange:true});
  statements.push(evidence.write,evidence.guard);
  const finalTags=s.tagRows.map(t=>t.id===before?.id?{...t,...values}:t);
  // A new id is database-generated; guard its UUID and every submitted field,
  // then exclude that one UUID from the pre-existing scope comparison.
  if(!before){
    s.where=`(${s.where}) AND uuid<>?`;s.bindings.push(uuid);
    statements.push(abortIf(c.env,`EXISTS (SELECT 1 FROM page_tags WHERE tag_id=(SELECT id FROM tags WHERE uuid=?))
      OR EXISTS (SELECT 1 FROM tags WHERE parent_tag=(SELECT id FROM tags WHERE uuid=?))`,[uuid,uuid]));
    if(s.trash)statements.push(abortIf(c.env,'EXISTS (SELECT 1 FROM trash_page_tags WHERE tag_id=(SELECT id FROM tags WHERE uuid=?))',[uuid]));
  }
  statements.push(...finalGuards(c,s,finalTags,s.taxRows,s.links,s.trashLinks,s.policy.version!),
    abortIf(c.env,`NOT EXISTS (SELECT 1 FROM tags WHERE uuid=? AND ${VALUE_FIELDS.map(f=>`${f} IS ?`).join(' AND ')})`,[uuid,...VALUE_FIELDS.map(f=>values[f])]),
    c.env.DB.prepare('SELECT id FROM tags WHERE uuid=?').bind(uuid));
  const result=await c.env.DB.batch(statements);const row=result.at(-1)!.results[0] as {id:number}|undefined;if(!row)throw new Error('Tag result unavailable');return row.id;
}
export async function deleteTag(c:AppContext,id:number):Promise<boolean> {
  const s=await snapshot(c,{ids:[id],childrenOf:id},'tag:write');const target=s.tagRows.find(t=>t.id===id);if(!target){await c.env.DB.batch(s.guards);return false;}
  const children=s.tagRows.filter(t=>t.parent_tag===id).map(t=>t.id);
  const removed=s.links.filter(l=>l.tag_id===id);const removedTrash=s.trashLinks.filter(l=>l.tag_id===id);
  const evidence=mutationAuditEvidence(c,{action:'tag.delete',entityType:'tag',entityId:target.uuid,detail:detail({tag_id:target.id,removed_live_links:removed,removed_trash_links:removedTrash,cleared_child_ids:children,cleared_children:s.tagRows.filter(t=>children.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),related_pages:relatedPages(s)})},s.dataClass,{policy:s.policy,requirePreviousChange:true});
  const statements=[...s.guards,c.env.DB.prepare('DELETE FROM page_tags WHERE tag_id=?').bind(id),abortIf(c.env,'changes() <> ?',[removed.length])];
  if(s.trash)statements.push(c.env.DB.prepare('DELETE FROM trash_page_tags WHERE tag_id=?').bind(id),abortIf(c.env,'changes() <> ?',[removedTrash.length]));
  statements.push(c.env.DB.prepare('UPDATE tags SET parent_tag=NULL WHERE parent_tag=?').bind(id),abortIf(c.env,'changes() <> ?',[children.length]),
    c.env.DB.prepare('DELETE FROM tags WHERE id=?').bind(id),evidence.write,evidence.guard,
    ...finalGuards(c,s,s.tagRows.filter(t=>t.id!==id).map(t=>t.parent_tag===id?{...t,parent_tag:null}:t),s.taxRows,s.links.filter(l=>l.tag_id!==id),s.trashLinks.filter(l=>l.tag_id!==id),s.policy.version!));
  await c.env.DB.batch(statements);return true;
}
export async function saveTaxonomy(c:AppContext,values:Pick<Taxonomy,'name'|'slug'>,before?:Taxonomy):Promise<number[]> {
  if(!values.name.trim()||!values.slug.trim())throw new Error('Invalid taxonomy values');
  const uuid=before?.uuid??crypto.randomUUID();const keys=[...new Set([before?.slug,values.slug].filter((k):k is string=>k!==undefined))];
  const s=await snapshot(c,{taxonomySlugs:keys},'taxonomy:write');
  if(before&&!s.taxRows.some(t=>t.id===before.id&&TAX_FIELDS.every(f=>t[f]===before[f])))throw new Error('Taxonomy changed');
  const moved=before&&before.slug!==values.slug?s.tagRows.filter(t=>t.taxonomy_slug===before.slug).map(t=>t.id):[];
  const source=s.floors.find(f=>f.container_key===before?.slug);const delta=before&&before.slug!==values.slug&&source?1:0;
  const afterPolicy={...s.policy,version:s.policy.version!+delta};
  const statements=s.guards;
  if(before)statements.push(c.env.DB.prepare('UPDATE taxonomies SET name=?,slug=? WHERE id=?').bind(values.name,values.slug,before.id));
  else statements.push(c.env.DB.prepare('INSERT INTO taxonomies(uuid,name,slug) VALUES (?,?,?)').bind(uuid,values.name,values.slug));
  statements.push(abortIf(c.env,'changes() <> 1'));
  if(moved.length)statements.push(c.env.DB.prepare('UPDATE tags SET taxonomy_slug=? WHERE id IN (SELECT value FROM json_each(?))').bind(values.slug,json(moved)),abortIf(c.env,'changes() <> ?',[moved.length]));
  const evidence=mutationAuditEvidence(c,{action:before?'taxonomy.update':'taxonomy.create',entityType:'taxonomy',entityId:uuid,detail:detail({fields:['name','slug'],...(before?{taxonomy_id:before.id}:{}),moved_tag_ids:moved,moved_tags:s.tagRows.filter(t=>moved.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),related_pages:relatedPages(s),classification_policy_version_before:s.policy.version})},s.dataClass,{policy:afterPolicy});
  const taxRows=s.taxRows.map(t=>t.id===before?.id?{...t,...values}:t);
  // Insert the expected new taxonomy into the final comparison via its UUID;
  // all other rows still have their captured identities and values.
  statements.push(evidence.write,evidence.guard);
  if(!before){s.slugKeys=s.slugKeys.filter(k=>k!==values.slug);}
  statements.push(...finalGuards(c,s,s.tagRows.map(t=>moved.includes(t.id)?{...t,taxonomy_slug:values.slug}:t),taxRows,s.links,s.trashLinks,afterPolicy.version!),
    abortIf(c.env,'NOT EXISTS (SELECT 1 FROM taxonomies WHERE uuid=? AND name IS ? AND slug IS ?)',[uuid,values.name,values.slug]));
  if(delta)statements.push(abortIf(c.env,"COALESCE((SELECT level FROM data_class_floors WHERE container_kind='taxonomy' AND container_key=?),0) < ?",[values.slug,source!.level]));
  await c.env.DB.batch(statements);return moved;
}
export async function deleteTaxonomy(c:AppContext,before:Taxonomy):Promise<number[]> {
  const s=await snapshot(c,{taxonomySlugs:[before.slug,'default']},'taxonomy:write');
  if(!s.taxRows.some(t=>t.id===before.id&&TAX_FIELDS.every(f=>t[f]===before[f])))throw new Error('Taxonomy changed');
  const orphaned=s.tagRows.filter(t=>t.taxonomy_slug===before.slug).map(t=>t.id);
  const evidence=mutationAuditEvidence(c,{action:'taxonomy.delete',entityType:'taxonomy',entityId:before.uuid,detail:detail({taxonomy_id:before.id,orphaned_tag_ids:orphaned,orphaned_tags:s.tagRows.filter(t=>orphaned.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),related_pages:relatedPages(s)})},s.dataClass,{policy:s.policy,requirePreviousChange:true});
  await c.env.DB.batch([...s.guards,c.env.DB.prepare('UPDATE tags SET taxonomy_slug=NULL WHERE taxonomy_slug=?').bind(before.slug),abortIf(c.env,'changes() <> ?',[orphaned.length]),
    c.env.DB.prepare('DELETE FROM taxonomies WHERE id=?').bind(before.id),evidence.write,evidence.guard,
    ...finalGuards(c,s,s.tagRows.map(t=>t.taxonomy_slug===before.slug?{...t,taxonomy_slug:null}:t),s.taxRows.filter(t=>t.id!==before.id),s.links,s.trashLinks,s.policy.version!)]);
  return orphaned;
}
export async function updateTagWeights(c:AppContext,updates:Array<{id:number;weight:number}>):Promise<number[]> {
  if(updates.length>5000||new Set(updates.map(u=>u.id)).size!==updates.length||updates.some(u=>!Number.isSafeInteger(u.id)||u.id<=0||!Number.isFinite(u.weight)))throw new Error('Invalid tag weights');
  if(!updates.length){assertRegulatedWritesAllowed(c.env);return [];}
  const s=await snapshot(c,{ids:updates.map(u=>u.id)},'tag:write');if(s.tagRows.length!==updates.length)throw new Error('Tag targets changed');
  const byId=new Map(updates.map(u=>[u.id,u.weight]));const changed=s.tagRows.filter(t=>t.weight!==byId.get(t.id));
  if(!changed.length){await c.env.DB.batch(s.guards);return [];}
  const targets=changed.map(t=>({id:t.id,uuid:t.uuid,weight_before:t.weight,weight_after:byId.get(t.id)!}));
  const evidence=attributedMutationAuditEvidence(c.env,c.get('user'),{action:'tag.weights',entityType:'tag',detail:detail({targets})},s.dataClass,s.policy,{context:c,targetIds:changed.map(t=>t.uuid)});
  await c.env.DB.batch([...s.guards,c.env.DB.prepare("UPDATE tags SET weight=json_extract(e.value,'$.weight_after') FROM json_each(?) e WHERE tags.id=json_extract(e.value,'$.id')").bind(json(targets)),
    abortIf(c.env,'changes() <> ?',[changed.length]),evidence.write,evidence.guard,
    ...finalGuards(c,s,s.tagRows.map(t=>({...t,weight:byId.get(t.id)!})),s.taxRows,s.links,s.trashLinks,s.policy.version!)]);
  return changed.map(t=>t.id);
}
