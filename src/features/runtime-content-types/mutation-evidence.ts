import type { AppContext } from '../../core/http/context';
import { captureAccessAuthorization } from '../../core/auth/access-authorization';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { PAGE_TYPE_EXTENSIONS_SETTING_KEY,type PageTypeExtension } from '../../core/db/page-type-store';

type Table='page_types'|'block_types';
type Row=Record<string,string|number|null>;
const BASE=['id','uuid','created_at','updated_at','slug','name','blueprint','weight'];
const fields=(table:Table)=>table==='page_types'?[...BASE,'block_lists','taxonomy_lists']:BASE;
const SETTING=['key','value','created_at','updated_at'];
const TAXONOMY=['id','uuid','slug','name','created_at','updated_at'];
export class RuntimeTypeMutationUnavailableError extends Error {constructor(){super('Runtime type change unavailable');}}
function json(value:unknown):string {
  const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>1_000_000)throw new Error('Schema manifest requires review');return text;
}
async function snapshot(c:AppContext,table:string,columns:string[],where='1',args:Array<string|number|null>=[]):Promise<Row[]> {
  const object=`json_object(${columns.map(f=>`'${f}',r.${f}`).join(',')})`;
  const row=await c.env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY ${columns[0]} LIMIT 5001),
    budget AS (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END snapshot FROM budget`).bind(...args).first<{snapshot:string}>();
  if(!row)throw new Error('Schema snapshot unavailable');
  const rows=JSON.parse(row.snapshot) as Row[];
  if(columns.includes('id')&&rows.some(r=>!Number.isSafeInteger(r.id)||Number(r.id)<=0))throw new Error('Unsafe schema identity');
  return rows;
}
function guard(c:AppContext,table:string,columns:string[],rows:Row[],where='1',args:Array<string|number|null>=[]) {
  return abortIf(c.env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} r WHERE ${columns.map(f=>`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...args,rows.length,json(rows)]);
}
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
async function unavailable(c:AppContext):Promise<never> {clearConfigCache();await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new RuntimeTypeMutationUnavailableError();}
export async function prepareRuntimeTypeMutation(c:AppContext,table:Table) {
  assertRegulatedWritesAllowed(c.env);
  try{return await prepare(c,table);}catch{return unavailable(c);}
}
async function prepare(c:AppContext,table:Table) {
  const authority=await captureAccessAuthorization(c.env,c.get('user'),table==='page_types'?'pagetype:write':'blocktype:write');
  if(!authority.allowed)throw new Error('Schema authority unavailable');
  const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('Schema classification unavailable');
  const [pages,blocks,taxonomies,settings]=await Promise.all([snapshot(c,'page_types',fields('page_types')),snapshot(c,'block_types',BASE),snapshot(c,'taxonomies',TAXONOMY),snapshot(c,'settings',SETTING,'key=?',[PAGE_TYPE_EXTENSIONS_SETTING_KEY])]);
  const catalog={page_types:pages,block_types:blocks};const source=catalog[table];
  const admission=()=>[authority.guard(),classificationPolicyGuard(c.env,policy),guard(c,'page_types',fields('page_types'),pages),guard(c,'block_types',BASE,blocks),guard(c,'taxonomies',TAXONOMY,taxonomies),guard(c,'settings',SETTING,settings,'key=?',[PAGE_TYPE_EXTENSIONS_SETTING_KEY])];
  const protection=(slugs:string[],taxa:string[])=>{
    const classes=['page_types','block_types','taxonomies','settings'].map(t=>classFor(policy,'table',t));
    for(const slug of [...pages.map(r=>String(r.slug)),...slugs])classes.push(classFor(policy,'page_type',slug));
    for(const tax of [...taxonomies.map(r=>String(r.slug)),...taxa])classes.push(classFor(policy,'taxonomy',tax));
    return classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
  };
  const readClass=protection([],[]);
  await auditBackgroundReads(c.env,[{action:'schema.mutation-read',kind:'table',key:'page_types',targetType:'page_type',ids:pages.map(r=>String(r.id)),count:pages.length},
    {action:'schema.mutation-read',kind:'table',key:'block_types',targetType:'block_type',ids:blocks.map(r=>String(r.id)),count:blocks.length},
    {action:'schema.mutation-read',kind:'table',key:'taxonomies',targetType:'taxonomy',ids:taxonomies.map(r=>String(r.id)),count:taxonomies.length},
    {action:'schema.extension-read',kind:'table',key:'settings',targetType:'settings',ids:settings.map(r=>String(r.key)),count:settings.length}].map(read=>({...read,kind:'table' as const,minimumClass:readClass==='none'?undefined:readClass})),contextActor(c));
  const finish=()=>[authority.guard(),classificationPolicyGuard(c.env,policy)];
  const otherGuards=()=>[guard(c,table==='page_types'?'block_types':'page_types',fields(table==='page_types'?'block_types':'page_types'),catalog[table==='page_types'?'block_types':'page_types']),guard(c,'taxonomies',TAXONOMY,taxonomies),guard(c,'settings',SETTING,settings,'key=?',[PAGE_TYPE_EXTENSIONS_SETTING_KEY])];
  async function run<T>(work:()=>Promise<T>):Promise<T> {try{assertRegulatedWritesAllowed(c.env);if(await flushReadAudit(c))throw new Error('Schema read evidence unavailable');const result=await work();clearConfigCache();return result;}catch{return unavailable(c);}}
  return {
    row(id:number):Row|undefined {const row=source.find(r=>r.id===id);return row?{...row}:undefined;},
    taxonomies:taxonomies.map(r=>({slug:String(r.slug),name:String(r.name)})),
    async extensions(){try{return Object.fromEntries(Object.entries(extensionsFromRaw(settings[0]?.value as string??null)).map(([slug,value])=>[slug,{blocks:value.blocks??[],taxonomies:value.taxonomies??[]}]));}catch{return unavailable(c);}},
    save(values:Record<string,string|number|null>,id?:number):Promise<number> {return run(async()=>{
      if(id!==undefined&&(!Number.isSafeInteger(id)||id<=0))throw new Error('Invalid schema target');
      const before=id===undefined?undefined:source.find(r=>r.id===id);if(id!==undefined&&!before)throw new Error('Schema target disappeared');
      const columns=['slug','name','blueprint',...(table==='page_types'?['block_lists','taxonomy_lists']:[]),'weight'];
      if(columns.some(f=>values[f]===undefined)||!values.slug||!values.name||!Number.isFinite(values.weight)||!Array.isArray(JSON.parse(String(values.blueprint))))throw new Error('Invalid schema values');
      const taxa=table==='page_types'?[...array(before?.taxonomy_lists),...array(values.taxonomy_lists)]:[];if(table==='page_types'){array(values.block_lists);array(before?.block_lists);}json(values);
      const changed=columns.filter(f=>!before||before[f]!==values[f]);if(!changed.length){await c.env.DB.batch(admission());return Number(before!.id);}
      const clock=await c.env.DB.prepare(`SELECT CURRENT_TIMESTAMP now,MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 next_id FROM ${table}`).first<{now:string;next_id:number}>();
      if(!clock||(!before&&(!Number.isSafeInteger(clock.next_id)||clock.next_id<=0)))throw new Error('Unsafe schema identity');
      const targetId=before?.id??clock.next_id,uuid=before?.uuid??crypto.randomUUID();const next:Row={...before,id:targetId,uuid,created_at:before?.created_at??clock.now,updated_at:clock.now};for(const f of columns)next[f]=values[f];
      const expected=before?source.map(r=>r.id===id?next:r):[...source,next];if(expected.length>5000)throw new Error('Schema catalogue requires review');json(expected);
      const audit=table==='page_types'?'page_type':'block_type';const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action:`${audit}.${before?'update':'create'}`,entityType:audit,entityId:String(uuid),detail:{operation_id:crypto.randomUUID(),id:targetId,fields:changed}},protection([String(before?.slug??''),String(values.slug)],taxa),policy,{context:c});
      const business=before?c.env.DB.prepare(`UPDATE ${table} SET ${columns.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...columns.map(f=>values[f]),id!):c.env.DB.prepare(`INSERT INTO ${table}(id,uuid,${columns.join(',')}) VALUES (?,?,${columns.map(()=>'?').join(',')})`).bind(targetId,uuid,...columns.map(f=>values[f]));
      await c.env.DB.batch([...admission(),business,abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
        guard(c,table,fields(table).filter(f=>f!=='created_at'&&f!=='updated_at'),expected),
        guard(c,table,fields(table),source.filter(r=>r.id!==id),'id<>?',[targetId]),
        abortIf(c.env,`NOT EXISTS (SELECT 1 FROM ${table} WHERE id=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${before?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[targetId,clock.now,before?.created_at??clock.now]),...otherGuards(),...finish()]);
      return Number(targetId);
    });},
    remove(id:number):Promise<boolean> {return run(async()=>{
      if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid schema target');const before=source.find(r=>r.id===id);
      if(!before){await c.env.DB.batch(admission());return false;}
      const audit=table==='page_types'?'page_type':'block_type';const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action:`${audit}.delete`,entityType:audit,entityId:String(before.uuid),detail:{operation_id:crypto.randomUUID(),id}},protection([String(before.slug)],table==='page_types'?array(before.taxonomy_lists):[]),policy,{context:c});
      await c.env.DB.batch([...admission(),c.env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id),abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,guard(c,table,fields(table),source.filter(r=>r.id!==id)),...otherGuards(),...finish()]);return true;
    });},
    extend(slug:string,extension:PageTypeExtension):Promise<void> {return run(async()=>{
      if(table!=='page_types'||!slug||['__proto__','prototype','constructor'].includes(slug))throw new Error('Invalid schema extension');
      const map=extensionsFromRaw(settings[0]?.value as string??null);const old=map[slug]??{blocks:[],taxonomies:[]};array(extension.blocks);array(extension.taxonomies);
      if(json(old.blocks??[])===json(extension.blocks)&&json(old.taxonomies??[])===json(extension.taxonomies)){await c.env.DB.batch(admission());return;}
      if(extension.blocks.length||extension.taxonomies.length)map[slug]=extension;else delete map[slug];if(Object.keys(map).length>5000)throw new Error('Extension catalogue requires review');const value=json(map);
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(slug)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action:'page_type.extend',entityType:'page_type',entityId:`extension:${digest}`,detail:{operation_id:crypto.randomUUID(),fields:['blocks','taxonomies'],blocks_before:(old.blocks??[]).length,blocks_after:extension.blocks.length,taxonomies_before:(old.taxonomies??[]).length,taxonomies_after:extension.taxonomies.length}},protection([slug],[...(old.taxonomies??[]),...extension.taxonomies]),policy,{context:c});
      const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Schema clock unavailable');
      await c.env.DB.batch([...admission(),c.env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(PAGE_TYPE_EXTENSIONS_SETTING_KEY,value),abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
        guard(c,'page_types',fields('page_types'),pages),guard(c,'block_types',BASE,blocks),guard(c,'taxonomies',TAXONOMY,taxonomies),
        abortIf(c.env,`NOT EXISTS (SELECT 1 FROM settings WHERE key=? AND value IS ? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${settings[0]?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[PAGE_TYPE_EXTENSIONS_SETTING_KEY,value,clock.now,settings[0]?.created_at??clock.now]),...finish()]);
    });},
  };
}
