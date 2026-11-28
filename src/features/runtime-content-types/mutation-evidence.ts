import type { AppContext } from '../../core/http/context';
import { beginAuditedMutation, type MutationPlan } from '../../core/evidence/audited-mutation';
import type { ContainerKind } from '../../core/db/data-classes';
import { contextActor } from '../../core/db/audit';
import { guard, json, resultGuard, type Row } from '../../core/db/bounded-mutation';
import { nextIdSql } from '../../core/pages/snapshot-id';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { PAGE_TYPE_EXTENSIONS_SETTING_KEY,type PageTypeExtension } from '../../core/db/page-type-store';

type Table='page_types'|'block_types';
const BASE=['id','uuid','created_at','updated_at','slug','name','blueprint','weight'];
const fields=(table:Table)=>table==='page_types'?[...BASE,'block_lists','taxonomy_lists']:BASE;
const SETTING=['key','value','created_at','updated_at'];
const TAXONOMY=['id','uuid','slug','name','created_at','updated_at'];
export class RuntimeTypeMutationUnavailableError extends Error {constructor(){super('Runtime type change unavailable');}}
function array(value:unknown):string[] {if(value==null)return [];const parsed=typeof value==='string'?JSON.parse(value):value;if(!Array.isArray(parsed)||parsed.length>5000||parsed.some(v=>typeof v!=='string'))throw new Error('Invalid schema selection');return parsed;}
function extensionsFromRaw(raw:string|null):Record<string,PageTypeExtension> {
  const map=raw===null?{}:JSON.parse(raw);
  if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length>5000)throw new Error('Invalid extension map');
  for(const [key,value] of Object.entries(map)) {
    if(['__proto__','prototype','constructor'].includes(key)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(f=>f!=='blocks'&&f!=='taxonomies'))throw new Error('Unsafe extension map');
    const extension=value as PageTypeExtension;if((extension.blocks!==undefined&&!Array.isArray(extension.blocks))||(extension.taxonomies!==undefined&&!Array.isArray(extension.taxonomies)))throw new Error('Invalid extension selection');array(extension.blocks);array(extension.taxonomies);
  }
  return map;
}
async function unavailable(c:AppContext):Promise<never> {await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new RuntimeTypeMutationUnavailableError();}
const KEY=PAGE_TYPE_EXTENSIONS_SETTING_KEY;
/** NULL timestamps in an expected row: set by this transaction (see resultGuard). */
export async function prepareRuntimeTypeMutation(c:AppContext,table:Table) {
  assertRegulatedWritesAllowed(c.env);
  let mutation:Awaited<ReturnType<typeof begin>>;
  try{mutation=await begin(c,table);}catch(error){clearConfigCache();throw error;}
  const {pages,blocks,taxonomies,settings}=mutation.rows;
  const catalog={page_types:pages,block_types:blocks};const source=catalog[table];
  const other:Table=table==='page_types'?'block_types':'page_types';
  const unchanged={
    others:()=>[guard(c,other,fields(other),catalog[other]),guard(c,'taxonomies',TAXONOMY,taxonomies),guard(c,'settings',SETTING,settings,'key=?',[KEY])],
    catalogues:()=>[guard(c,'page_types',fields('page_types'),pages),guard(c,'block_types',BASE,blocks),guard(c,'taxonomies',TAXONOMY,taxonomies)],
  };
  const protection=(slugs:string[],taxa:string[]):Array<[ContainerKind,string]>=>[...slugs.map(slug=>['page_type',slug] as [ContainerKind,string]),...taxa.map(tax=>['taxonomy',tax] as [ContainerKind,string])];
  async function run(decide:Parameters<typeof mutation.commit>[0]):Promise<void> {try{await mutation.commit(decide);}finally{clearConfigCache();}}
  return {
    row(id:number):Row|undefined {const row=source.find(r=>r.id===id);return row?{...row}:undefined;},
    taxonomies:taxonomies.map(r=>({slug:String(r.slug),name:String(r.name)})),
    async extensions(){try{return Object.fromEntries(Object.entries(extensionsFromRaw(settings[0]?.value as string??null)).map(([slug,value])=>[slug,{blocks:value.blocks??[],taxonomies:value.taxonomies??[]}]));}catch{clearConfigCache();return unavailable(c);}},
    async save(values:Record<string,string|number|null>,id?:number):Promise<number> {let result=0;await run(async(_rows,tools):Promise<MutationPlan|null>=>{
      if(id!==undefined&&(!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid schema target');
      const before=id===undefined?undefined:source.find(r=>r.id===id);if(id!==undefined&&!before)throw new Error('Schema target disappeared');
      const columns=['slug','name','blueprint',...(table==='page_types'?['block_lists','taxonomy_lists']:[]),'weight'];
      if(columns.some(f=>values[f]===undefined)||!values.slug||!values.name||!Number.isFinite(values.weight)||!Array.isArray(JSON.parse(String(values.blueprint))))throw new Error('Invalid schema values');
      const taxa=table==='page_types'?[...array(before?.taxonomy_lists),...array(values.taxonomy_lists)]:[];if(table==='page_types'){array(values.block_lists);array(before?.block_lists);}json(values);
      const changed=columns.filter(f=>!before||before[f]!==values[f]);if(!changed.length){result=Number(before!.id);return null;}
      const clock=await tools.clock(`${nextIdSql(table)} AS next_id`);
      if(!before&&(!Number.isSafeInteger(clock.next_id)||Number(clock.next_id)<=0))throw new Error('Unsafe schema identity');
      const targetId=before?.id??Number(clock.next_id),uuid=before?.uuid??crypto.randomUUID();const next:Row={...before,id:targetId,uuid,created_at:before?.created_at??null,updated_at:null};for(const f of columns)next[f]=values[f];
      const expected=before?source.map(r=>r.id===id?next:r):[...source,next];if(expected.length>5000)throw new Error('Schema catalogue requires review');json(expected);
      const audit=table==='page_types'?'page_type':'block_type';result=Number(targetId);
      return {
        writes:[before?{sql:`UPDATE ${table} SET ${columns.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[...columns.map(f=>values[f]),id!]}
          :{sql:`INSERT INTO ${table}(id,uuid,${columns.join(',')}) VALUES (?,?,${columns.map(()=>'?').join(',')})`,args:[targetId,uuid,...columns.map(f=>values[f])]}],
        evidence:{entry:{action:`${audit}.${before?'update':'create'}`,entityType:audit,entityId:String(uuid),detail:{id:targetId,fields:changed}}},
        classify:protection([String(before?.slug??''),String(values.slug)],taxa),
        expect:since=>[resultGuard(c,table,fields(table),expected,since),...unchanged.others()],
      };
    });return result;},
    async remove(id:number):Promise<boolean> {let removed=false;await run(():MutationPlan|null=>{
      if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid schema target');const before=source.find(r=>r.id===id);
      if(!before)return null;
      const audit=table==='page_types'?'page_type':'block_type';removed=true;
      return {
        writes:[{sql:`DELETE FROM ${table} WHERE id=?`,args:[id]}],
        evidence:{entry:{action:`${audit}.delete`,entityType:audit,entityId:String(before.uuid),detail:{id}}},
        classify:protection([String(before.slug)],table==='page_types'?array(before.taxonomy_lists):[]),
        expect:()=>[guard(c,table,fields(table),source.filter(r=>r.id!==id)),...unchanged.others()],
      };
    });return removed;},
    extend(slug:string,extension:PageTypeExtension):Promise<void> {return run(async():Promise<MutationPlan|null>=>{
      if(table!=='page_types'||!slug||['__proto__','prototype','constructor'].includes(slug))throw new Error('Invalid schema extension');
      const map=extensionsFromRaw(settings[0]?.value as string??null);const old=map[slug]??{blocks:[],taxonomies:[]};array(extension.blocks);array(extension.taxonomies);
      if(json(old.blocks??[])===json(extension.blocks)&&json(old.taxonomies??[])===json(extension.taxonomies))return null;
      if(extension.blocks.length||extension.taxonomies.length)map[slug]=extension;else delete map[slug];if(Object.keys(map).length>5000)throw new Error('Extension catalogue requires review');const value=json(map);
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(slug)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      return {
        writes:[{sql:'INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',args:[KEY,value]}],
        evidence:{entry:{action:'page_type.extend',entityType:'page_type',entityId:`extension:${digest}`,detail:{fields:['blocks','taxonomies'],blocks_before:(old.blocks??[]).length,blocks_after:extension.blocks.length,taxonomies_before:(old.taxonomies??[]).length,taxonomies_after:extension.taxonomies.length}}},
        classify:protection([slug],[...(old.taxonomies??[]),...extension.taxonomies]),
        expect:since=>[...unchanged.catalogues(),resultGuard(c,'settings',SETTING,[{key:KEY,value,created_at:settings[0]?.created_at??null,updated_at:null}],since,'key=?',[KEY])],
      };
    });},
  };
}
function begin(c:AppContext,table:Table) {
  const tableRead=(key:string,targetType:string)=>({action:'schema.mutation-read',kind:'table' as const,key,targetType,id:(r:Row)=>String(r.id)});
  return beginAuditedMutation(c,{
    permission:table==='page_types'?'pagetype:write':'blocktype:write',
    // Every existing page type and taxonomy, so planning reads keep their class.
    classify:rows=>[...(['page_types','block_types','taxonomies','settings'].map(t=>['table',t]) as Array<[ContainerKind,string]>),
      ...rows.pages.map(r=>['page_type',String(r.slug)] as [ContainerKind,string]),...rows.taxonomies.map(r=>['taxonomy',String(r.slug)] as [ContainerKind,string])],
    snapshot:{
      pages:{table:'page_types',fields:fields('page_types'),where:'1',args:[],read:tableRead('page_types','page_type')},
      blocks:{table:'block_types',fields:BASE,where:'1',args:[],read:tableRead('block_types','block_type')},
      taxonomies:{table:'taxonomies',fields:TAXONOMY,where:'1',args:[],read:tableRead('taxonomies','taxonomy')},
      settings:{table:'settings',fields:SETTING,where:'key=?',args:[KEY],read:{action:'schema.extension-read',kind:'table',key:'settings',targetType:'settings',id:r=>String(r.key)}},
    },
    unavailable:()=>new RuntimeTypeMutationUnavailableError(),
  });
}
