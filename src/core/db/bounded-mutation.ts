import type { Env } from '../../types';
type MutationDatabaseContext={env:Pick<Env,'DB'>};
import { abortIf } from './transaction-guard';

export type Row=Record<string,string|number|null>;
/** Fixed, trusted SQL identifiers only; every source value is bound. */
export function json(value:unknown):string {const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>1_000_000)throw new Error('Mutation manifest requires review');return text;}
export async function fingerprint(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function snapshot<T>(c:MutationDatabaseContext,table:string,fields:string[],where='1',args:Array<string|number|null>=[],order=fields[0]):Promise<T[]> {
  return snapshotRows<T>(fields,await snapshotStatement(c,table,fields,where,args,order).first<{snapshot:string}>());
}
/** The bounded snapshot query alone, so a caller can batch it with guards. */
export function snapshotStatement(c:MutationDatabaseContext,table:string,fields:string[],where='1',args:Array<string|number|null>=[],order=fields[0]):D1PreparedStatement {
  const object=`json_object(${fields.map(f=>`'${f}',r.${f}`).join(',')})`;
  return c.env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 5001),
    budget AS (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END snapshot FROM budget`).bind(...args);
}
export function snapshotRows<T>(fields:string[],result:{snapshot:string}|null|undefined):T[] {
  if(!result)throw new Error('Mutation snapshot unavailable');const rows=JSON.parse(result.snapshot) as T[];
  if(fields.includes('id')&&(rows as Row[]).some(r=>!Number.isSafeInteger(r.id)||Number(r.id)<=0))throw new Error('Unsafe mutation identity');return rows;
}
export function guard(c:MutationDatabaseContext,table:string,fields:readonly string[],rows:readonly unknown[],where='1',args:Array<string|number|null>=[]) {
  return abortIf(c.env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} r WHERE ${fields.map(f=>`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...args,rows.length,json(rows)]);
}

/** NULL planned timestamps denote a new transaction-time value. Other NULLs
 * remain exact data. Source snapshots always use the ordinary exact guard. */
export function resultGuard(c:MutationDatabaseContext,table:string,fields:string[],rows:object[],since:string,where='1',args:Array<string|number|null>=[]){
  const timed:string[]=fields.filter(f=>f==='created_at'||f==='updated_at');
  return abortIf(c.env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} r WHERE ${fields.map(f=>timed.includes(f)?`(CASE WHEN json_extract(e.value,'$.${f}') IS NULL THEN r.${f}>=? AND r.${f}<=CURRENT_TIMESTAMP ELSE r.${f} IS json_extract(e.value,'$.${f}') END)`:`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...args,rows.length,json(rows),...timed.map(()=>since)]);
}
