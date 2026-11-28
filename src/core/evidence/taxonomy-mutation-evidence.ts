import type { Tag,Taxonomy } from '../../types';
import type { AppContext } from '../http/context';
import { classFor,strongestClass } from '../db/data-classes';
import { abortIf } from '../db/transaction-guard';
import { guard, json } from '../db/bounded-mutation';
import { recordTagReads,recordTaxonomyReads } from '../http/access-log';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { beginAuditedMutation, type LoadedSource, type SnapshotSource, type PlannedWrite } from './audited-mutation';

const TAG_FIELDS=['id','uuid','created_at','updated_at','name','slug','weight','taxonomy_slug','parent_tag'] as const;
const TAX_FIELDS=['id','uuid','created_at','updated_at','name','slug'] as const;
const LINK_FIELDS=['id','uuid','page_id','tag_id','weight'] as const;
type TagMetadata=Omit<Tag,'lect'>;
type Bind = string|number|null;
type Row = Record<string,string|number|null>;
interface Scope { ids?:number[]; uuid?:string; taxonomySlugs?:string[]; childrenOf?:number }
async function loadTaxonomyScope({ c, policy, policyGuard }: Parameters<SnapshotSource<unknown>['load']>[0],scope:Scope) {
  const where=`id IN (SELECT value FROM json_each(?)) OR uuid=? OR taxonomy_slug IN (SELECT value FROM json_each(?)) OR parent_tag=?`;
  const bindings:Bind[]=[json(scope.ids??[]),scope.uuid??'',json(scope.taxonomySlugs??[]),scope.childrenOf??null];
  const [,tags,presence]=await c.env.DB.batch([
    policyGuard(),
    c.env.DB.prepare(`SELECT ${TAG_FIELDS.join(',')} FROM tags WHERE ${where} ORDER BY id LIMIT 5001`).bind(...bindings),
    c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_tags') ORDER BY name"),
  ]);
  const tagRows=tags.results as TagMetadata[];
  if(tagRows.length>5000)throw new Error('Taxonomy manifest requires review');
  const trash=presence.results.length===2;if(presence.results.length!==0&&!trash)throw new Error('Trash schema unavailable');
  const ids=tagRows.map(t=>t.id);
  const slugKeys=[...new Set([...(scope.taxonomySlugs??[]),...tagRows.map(t=>t.taxonomy_slug??'default')])];
  const pageIds = (table: string) => `SELECT page_id FROM ${table} WHERE tag_id IN (SELECT value FROM json_each(?))`;
  const relatedUuids = `SELECT uuid FROM pages WHERE id IN (${pageIds('page_tags')})` +
    (trash ? ` UNION SELECT uuid FROM trash_pages WHERE id IN (${pageIds('trash_page_tags')})` : '');
  const [,taxonomies,links,trashLinks,pages,trashPages,floors,retainedResult]=await c.env.DB.batch([
    policyGuard(),
    c.env.DB.prepare('SELECT * FROM taxonomies WHERE slug IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(json(slugKeys)),
    c.env.DB.prepare('SELECT id,uuid,page_id,tag_id,weight FROM page_tags WHERE tag_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001').bind(json(ids)),
    c.env.DB.prepare(trash?'SELECT id,uuid,page_id,tag_id,weight FROM trash_page_tags WHERE tag_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 5001':'SELECT id,uuid,page_id,tag_id,weight FROM page_tags WHERE 0').bind(...(trash?[json(ids)]:[])),
    c.env.DB.prepare(`SELECT id,uuid,page_type FROM pages WHERE id IN (${pageIds('page_tags')}) ORDER BY id LIMIT 5001`).bind(json(ids)),
    c.env.DB.prepare(trash?`SELECT id,uuid,page_type FROM trash_pages WHERE id IN (${pageIds('trash_page_tags')}) ORDER BY id LIMIT 5001`:'SELECT id,uuid,page_type FROM pages WHERE 0').bind(...(trash?[json(ids)]:[])),
    c.env.DB.prepare("SELECT container_key,level FROM data_class_floors WHERE container_kind='taxonomy' AND container_key IN (SELECT value FROM json_each(?)) ORDER BY container_key").bind(json(slugKeys)),
    c.env.DB.prepare(`SELECT uuid,level FROM page_sensitivity_floors WHERE uuid IN (${relatedUuids}) ORDER BY uuid`).bind(...(trash?[json(ids),json(ids)]:[json(ids)])),
  ]);
  if([taxonomies,links,trashLinks,pages,trashPages].some(r=>r.results.length>5000))throw new Error('Taxonomy manifest requires review');
  const taxRows=taxonomies.results as Taxonomy[];
  const pageRows=pages.results as Array<{id:number;uuid:string;page_type:string|null}>;
  const trashRows=trashPages.results as typeof pageRows;
  const uuids=[...new Set([...pageRows,...trashRows].map(p=>p.uuid))];
  const retained=retainedResult.results as Array<{uuid:string;level:number}>;
  if(retained.some(r=>r.level!==1&&r.level!==2))throw new Error('Taxonomy floor invalid');
  const classes=['tags','taxonomies','page_tags','pages',...(trash?['trash_page_tags','trash_pages']:[])].map(t=>classFor(policy,'table',t));
  for(const key of slugKeys)classes.push(classFor(policy,'taxonomy',key));
  for(const page of [...pageRows,...trashRows])classes.push(classFor(policy,'page_type',page.page_type??'default'));
  for(const floor of retained)classes.push(floor.level===2?'phi':'pii');
  const dataClass=strongestClass(classes);
  recordTagReads('tag.mutation-read',tagRows);recordTaxonomyReads('taxonomy.mutation-read',taxRows);
  const linkWhere='tag_id IN (SELECT value FROM json_each(?))';const linkBind=[json(ids)];
  const guards=[
    guard(c,'tags',TAG_FIELDS,tagRows,where,bindings),
    guard(c,'taxonomies',TAX_FIELDS,taxRows,'slug IN (SELECT value FROM json_each(?))',[json(slugKeys)]),
    guard(c,'page_tags',LINK_FIELDS,links.results,linkWhere,linkBind),
    guard(c,'pages',['id','uuid','page_type'],pageRows,'id IN (SELECT value FROM json_each(?))',[json(pageRows.map(p=>p.id))]),
    guard(c,'page_sensitivity_floors',['uuid','level'],retained,'uuid IN (SELECT value FROM json_each(?))',[json(uuids)]),
    abortIf(c.env,"(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('trash_pages','trash_page_tags')) <> ?",[trash?2:0])];
  if(trash)guards.push(guard(c,'trash_page_tags',LINK_FIELDS,trashLinks.results,linkWhere,linkBind),
    guard(c,'trash_pages',['id','uuid','page_type'],trashRows,'id IN (SELECT value FROM json_each(?))',[json(trashRows.map(p=>p.id))]));
  const value={where,bindings,tagRows,taxRows,links:links.results as Row[],trashLinks:trashLinks.results as Row[],trash,
    dataClass,retained,uuids,pageRows,trashRows,slugKeys,floors:floors.results as Array<{container_key:string;level:number}>,linkWhere,linkBind};
  return { value, classify:dataClass==='none'?[]:[dataClass], readMode:'request', reads:[], guards:()=>guards } satisfies LoadedSource<typeof value>;
}
type Snapshot=Awaited<ReturnType<typeof loadTaxonomyScope>>['value'];
function taxonomySource(scope: Scope): SnapshotSource<Snapshot> {
  return { load: context => loadTaxonomyScope(context,scope) };
}
function beginTaxonomyMutation(c: AppContext, permission: 'tag:write' | 'taxonomy:write') {
  return beginAuditedMutation(c,{permission,classify:[],snapshot:{}});
}
function finalGuards(c:AppContext,s:Snapshot,tags:TagMetadata[],taxonomies:Taxonomy[],links:Row[],trashLinks:Row[],
  created: { tagUuid?:string; taxonomySlug?:string } = {}) {
  const level=s.dataClass==='phi'?2:s.dataClass==='pii'?1:0;
  const tagScope = `(${s.where}) OR id IN (SELECT value FROM json_each(?))`;
  const tagBindings = [...s.bindings,json(s.tagRows.map(t=>t.id))];
  const statements=[
    guard(c,'tags',TAG_FIELDS.filter(f=>f!=='updated_at'),tags,
      created.tagUuid?`(${tagScope}) AND uuid<>?`:tagScope,created.tagUuid?[...tagBindings,created.tagUuid]:tagBindings),
    guard(c,'taxonomies',TAX_FIELDS.filter(f=>f!=='updated_at'),taxonomies,'slug IN (SELECT value FROM json_each(?))',
      [json(s.slugKeys.filter(key=>key!==created.taxonomySlug))]),
    guard(c,'page_tags',LINK_FIELDS,links,s.linkWhere,s.linkBind),
    guard(c,'pages',['id','uuid','page_type'],s.pageRows,'id IN (SELECT value FROM json_each(?))',[json(s.pageRows.map(p=>p.id))]),
    abortIf(c.env,`EXISTS (SELECT 1 FROM page_sensitivity_floors WHERE uuid IN (SELECT value FROM json_each(?)) AND level>?)
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=json_extract(e.value,'$.uuid')),0)<json_extract(e.value,'$.level'))`,[json(s.uuids),level,json(s.retained)])];
  if(s.trash)statements.push(guard(c,'trash_page_tags',LINK_FIELDS,trashLinks,s.linkWhere,s.linkBind),guard(c,'trash_pages',['id','uuid','page_type'],s.trashRows,'id IN (SELECT value FROM json_each(?))',[json(s.trashRows.map(p=>p.id))]));
  return statements;
}
function relatedPages(s:Snapshot) {
  return [...s.pageRows.map(p=>({id:p.id,uuid:p.uuid,source:'draft'})),...s.trashRows.map(p=>({id:p.id,uuid:p.uuid,source:'trash'}))];
}
function detail<T extends Record<string,unknown>>(value:T):T {json(value);return value;}
export type TagValues=Pick<Tag,'name'|'slug'|'weight'|'taxonomy_slug'|'parent_tag'|'lect'>;
const VALUE_FIELDS=['name','slug','weight','taxonomy_slug','parent_tag','lect'] as const;
export class TagParentCycleError extends Error {
  static readonly messageText = 'Its parent tags form a loop.';
  constructor() { super(TagParentCycleError.messageText); }
}

// UNION stops the walk even when a legacy parent chain already contains a cycle.
const TAG_PARENT_CYCLE = `(WITH RECURSIVE ancestors(id, parent_tag) AS (
  SELECT id, parent_tag FROM tags WHERE id = ?
  UNION
  SELECT t.id, t.parent_tag FROM tags t JOIN ancestors a ON t.id = a.parent_tag
) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ?)
      OR (EXISTS (SELECT 1 FROM ancestors) AND NOT EXISTS (SELECT 1 FROM ancestors WHERE parent_tag IS NULL)))`;

export async function saveTag(c:AppContext,values:TagValues,before?:Tag):Promise<number> {
  const uuid=before?.uuid??crypto.randomUUID();
  const mutation=await beginTaxonomyMutation(c,'tag:write');
  const row=await mutation.commit(async (_rows,tools)=>{
    const s=await tools.source(taxonomySource({
      ids:[before?.id,before?.parent_tag,values.parent_tag].filter((id):id is number=>id!==null&&id!==undefined),
      uuid,taxonomySlugs:[before?.taxonomy_slug??'default',values.taxonomy_slug??'default'],
    }));
    if(before&&!s.tagRows.some(t=>t.id===before.id&&TAG_FIELDS.every(f=>t[f]===before[f])))throw new Error('Tag changed');

    const admit:D1PreparedStatement[]=[];
    if(values.parent_tag!==null){
      const bindings=[values.parent_tag,before?.id??null];
      if(await c.env.DB.prepare(`SELECT ${TAG_PARENT_CYCLE} AS cycle`).bind(...bindings).first<number>('cycle')) {
        throw new TagParentCycleError();
      }
      // Recheck in the write transaction in case an ancestor moved after validation.
      admit.push(abortIf(c.env,TAG_PARENT_CYCLE,bindings));
    }
    if(before)admit.push(abortIf(c.env,'(SELECT lect FROM tags WHERE id=?) IS NOT ?',[before.id,before.lect]));
    const args=VALUE_FIELDS.map(field=>field==='lect'&&values.lect!==null?{document:values.lect}:values[field]);
    const write:PlannedWrite=before
      ? {sql:`UPDATE tags SET ${VALUE_FIELDS.map(f=>`${f}=?`).join(',')} WHERE id=?`,args:[...args,before.id]}
      : {sql:`INSERT INTO tags(uuid,${VALUE_FIELDS.join(',')}) VALUES (?,${VALUE_FIELDS.map(()=>'?').join(',')})`,args:[uuid,...args]};
    const finalTags=s.tagRows.map(t=>t.id===before?.id?{...t,...values}:t);
    const expect=finalGuards(c,s,finalTags,s.taxRows,s.links,s.trashLinks,before?{}:{tagUuid:uuid});
    if(!before){
      expect.push(abortIf(c.env,`EXISTS (SELECT 1 FROM page_tags WHERE tag_id=(SELECT id FROM tags WHERE uuid=?))
        OR EXISTS (SELECT 1 FROM tags WHERE parent_tag=(SELECT id FROM tags WHERE uuid=?))`,[uuid,uuid]));
      if(s.trash)expect.push(abortIf(c.env,'EXISTS (SELECT 1 FROM trash_page_tags WHERE tag_id=(SELECT id FROM tags WHERE uuid=?))',[uuid]));
    }
    expect.push(abortIf(c.env,`NOT EXISTS (SELECT 1 FROM tags WHERE uuid=? AND ${VALUE_FIELDS.map(f=>`${f} IS ?`).join(' AND ')})`,
      [uuid,...VALUE_FIELDS.map(f=>values[f])]));
    return {
      admit,writes:[write],expect,
      evidence:{entry:{action:before?'tag.update':'tag.create',entityType:'tag',entityId:uuid,detail:detail({
        fields:VALUE_FIELDS.filter(f=>!before||before[f]!==values[f]),...(before?{tag_id:before.id}:{}),related_pages:relatedPages(s),
      })}},
      returning:{sql:'SELECT id FROM tags WHERE uuid=?',args:[uuid]},
    };
  });
  if(typeof row?.id!=='number')throw new Error('Tag result unavailable');
  return row.id;
}

export async function deleteTag(c:AppContext,id:number):Promise<boolean> {
  const mutation=await beginTaxonomyMutation(c,'tag:write');
  let removedTag=false;
  await mutation.commit(async (_rows,tools)=>{
    const s=await tools.source(taxonomySource({ids:[id],childrenOf:id}));
    const target=s.tagRows.find(t=>t.id===id);
    if(!target)return null;
    removedTag=true;
    const children=s.tagRows.filter(t=>t.parent_tag===id).map(t=>t.id);
    const removed=s.links.filter(l=>l.tag_id===id);
    const removedTrash=s.trashLinks.filter(l=>l.tag_id===id);
    const writes:PlannedWrite[]=[{sql:'DELETE FROM page_tags WHERE tag_id=?',args:[id],changes:removed.length}];
    if(s.trash)writes.push({sql:'DELETE FROM trash_page_tags WHERE tag_id=?',args:[id],changes:removedTrash.length});
    writes.push({sql:'UPDATE tags SET parent_tag=NULL WHERE parent_tag=?',args:[id],changes:children.length},
      {sql:'DELETE FROM tags WHERE id=?',args:[id]});
    return {
      writes,
      evidence:{entry:{action:'tag.delete',entityType:'tag',entityId:target.uuid,detail:detail({
        tag_id:target.id,removed_live_links:removed,removed_trash_links:removedTrash,cleared_child_ids:children,
        cleared_children:s.tagRows.filter(t=>children.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),related_pages:relatedPages(s),
      })}},
      expect:finalGuards(c,s,s.tagRows.filter(t=>t.id!==id).map(t=>t.parent_tag===id?{...t,parent_tag:null}:t),
        s.taxRows,s.links.filter(l=>l.tag_id!==id),s.trashLinks.filter(l=>l.tag_id!==id)),
    };
  });
  return removedTag;
}

export async function saveTaxonomy(c:AppContext,values:Pick<Taxonomy,'name'|'slug'>,before?:Taxonomy):Promise<number[]> {
  if(!values.name.trim()||!values.slug.trim())throw new Error('Invalid taxonomy values');
  const uuid=before?.uuid??crypto.randomUUID();
  const keys=[...new Set([before?.slug,values.slug].filter((key):key is string=>key!==undefined))];
  const mutation=await beginTaxonomyMutation(c,'taxonomy:write');
  let moved:number[]=[];
  await mutation.commit(async (_rows,tools)=>{
    const s=await tools.source(taxonomySource({taxonomySlugs:keys}));
    if(before&&!s.taxRows.some(t=>t.id===before.id&&TAX_FIELDS.every(f=>t[f]===before[f])))throw new Error('Taxonomy changed');

    const renamed=before&&before.slug!==values.slug;
    moved=renamed?s.tagRows.filter(t=>t.taxonomy_slug===before.slug).map(t=>t.id):[];
    const sourceFloor=renamed?s.floors.find(f=>f.container_key===before.slug):undefined;
    const writes:PlannedWrite[]=[before
      ? {sql:'UPDATE taxonomies SET name=?,slug=? WHERE id=?',args:[values.name,values.slug,before.id]}
      : {sql:'INSERT INTO taxonomies(uuid,name,slug) VALUES (?,?,?)',args:[uuid,values.name,values.slug]}];
    if(moved.length)writes.push({
      sql:'UPDATE tags SET taxonomy_slug=? WHERE id IN (SELECT value FROM json_each(?))',
      args:[values.slug,json(moved)],changes:moved.length,
    });

    const taxRows=s.taxRows.map(t=>t.id===before?.id?{...t,...values}:t);
    const expect=finalGuards(c,s,s.tagRows.map(t=>moved.includes(t.id)?{...t,taxonomy_slug:values.slug}:t),taxRows,
      s.links,s.trashLinks,before?{}:{taxonomySlug:values.slug});
    expect.push(abortIf(c.env,'NOT EXISTS (SELECT 1 FROM taxonomies WHERE uuid=? AND name IS ? AND slug IS ?)',[uuid,values.name,values.slug]));
    if(sourceFloor)expect.push(abortIf(c.env,
      "COALESCE((SELECT level FROM data_class_floors WHERE container_kind='taxonomy' AND container_key=?),0) < ?",[values.slug,sourceFloor.level]));

    return {
      writes,expect,policyVersionAdvance:sourceFloor?1:0,
      evidence:{entry:{action:before?'taxonomy.update':'taxonomy.create',entityType:'taxonomy',entityId:uuid,detail:detail({
        fields:['name','slug'],...(before?{taxonomy_id:before.id}:{}),moved_tag_ids:moved,
        moved_tags:s.tagRows.filter(t=>moved.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),
        related_pages:relatedPages(s),classification_policy_version_before:tools.policy.version,
      })}},
    };
  });
  return moved;
}

export async function deleteTaxonomy(c:AppContext,before:Taxonomy):Promise<number[]> {
  const mutation=await beginTaxonomyMutation(c,'taxonomy:write');
  let orphaned:number[]=[];
  await mutation.commit(async (_rows,tools)=>{
    const s=await tools.source(taxonomySource({taxonomySlugs:[before.slug,'default']}));
    if(!s.taxRows.some(t=>t.id===before.id&&TAX_FIELDS.every(f=>t[f]===before[f])))throw new Error('Taxonomy changed');
    orphaned=s.tagRows.filter(t=>t.taxonomy_slug===before.slug).map(t=>t.id);
    return {
      writes:[
        {sql:'UPDATE tags SET taxonomy_slug=NULL WHERE taxonomy_slug=?',args:[before.slug],changes:orphaned.length},
        {sql:'DELETE FROM taxonomies WHERE id=?',args:[before.id]},
      ],
      evidence:{entry:{action:'taxonomy.delete',entityType:'taxonomy',entityId:before.uuid,detail:detail({
        taxonomy_id:before.id,orphaned_tag_ids:orphaned,
        orphaned_tags:s.tagRows.filter(t=>orphaned.includes(t.id)).map(t=>({id:t.id,uuid:t.uuid})),related_pages:relatedPages(s),
      })}},
      expect:finalGuards(c,s,s.tagRows.map(t=>t.taxonomy_slug===before.slug?{...t,taxonomy_slug:null}:t),
        s.taxRows.filter(t=>t.id!==before.id),s.links,s.trashLinks),
    };
  });
  return orphaned;
}

export async function updateTagWeights(c:AppContext,updates:Array<{id:number;weight:number}>):Promise<number[]> {
  if(updates.length>5000||new Set(updates.map(u=>u.id)).size!==updates.length||updates.some(u=>!Number.isSafeInteger(u.id)||u.id<=0||!Number.isFinite(u.weight)))throw new Error('Invalid tag weights');
  if(!updates.length){assertRegulatedWritesAllowed(c.env);return [];}
  const mutation=await beginTaxonomyMutation(c,'tag:write');
  const byId=new Map(updates.map(u=>[u.id,u.weight]));
  let changedIds:number[]=[];
  await mutation.commit(async (_rows,tools)=>{
    const s=await tools.source(taxonomySource({ids:updates.map(u=>u.id)}));
    if(s.tagRows.length!==updates.length)throw new Error('Tag targets changed');
    const changed=s.tagRows.filter(t=>t.weight!==byId.get(t.id));
    if(!changed.length)return null;
    changedIds=changed.map(t=>t.id);
    const targets=changed.map(t=>({id:t.id,uuid:t.uuid,weight_before:t.weight,weight_after:byId.get(t.id)!}));
    return {
      writes:[{
        sql:"UPDATE tags SET weight=json_extract(e.value,'$.weight_after') FROM json_each(?) e WHERE tags.id=json_extract(e.value,'$.id')",
        args:[{document:json(targets)}],changes:changed.length,
      }],
      evidence:{entry:{action:'tag.weights',entityType:'tag',detail:detail({targets})},targetIds:changed.map(t=>t.uuid)},
      expect:finalGuards(c,s,s.tagRows.map(t=>({...t,weight:byId.get(t.id)!})),s.taxRows,s.links,s.trashLinks),
    };
  });
  return changedIds;
}
