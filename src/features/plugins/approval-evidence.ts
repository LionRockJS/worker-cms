import type { AppContext } from '../../core/http/context';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { PermissionDenialReason } from '../../core/auth/denial-contract';
import { classFor } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { limitedBytes } from '../../core/http/body-limit';
import { computeIntegrity } from './assets';
import { filePrefixesOverlap } from './file-prefixes';
import { auditPluginManagement } from './disclosure-audit';
import { inspectPluginManifest,PLUGIN_ORIGIN } from './registry';
import { capturePluginMutationContext,REGISTRY,IDENTITY,OWNED,snapshot,guard,json,fingerprint,invalidate,type Row } from './registration-evidence';

type Action='plugin.identity.approve'|'plugin.asset.approve'|'plugin.asset.revoke'|'plugin.file_prefix.approve'|'plugin.file_prefix.revoke'|'plugin.page_type.approve'|'plugin.page_type.revoke'|'plugin.page_type.approve_all';
export interface PluginApprovalChange {id:number;action:Action;key?:string;access?:string}
type Result='missing'|'unreachable'|'identity-ok'|'identity-claimed'|'identity-approved'|'invalid'|'fetch-failed'|'conflict'|'approved'|'revoked'|'approved-all';
interface Plan {table:string;fields:string[];keys:string[];before:Row[];after:Row[];where:string;args:string[]}
export class PluginApprovalUnavailableError extends Error {constructor(){super('Plugin approval change unavailable');}}
class PolicyRefusal extends Error {constructor(readonly result:Result,readonly reason:PermissionDenialReason){super(reason);}}
const safeId=(value:string)=>/^[a-z][a-z0-9-]{0,63}$/.test(value);
const sameKey=(a:Row,b:Row,keys:string[])=>keys.every(k=>a[k]===b[k]);

/** Explicit host approvals only. Inspection never takes automatic TOFU claims;
 * remote declarations/bytes are observations, not a cross-service transaction. */
export async function mutatePluginApproval(c:AppContext,change:PluginApprovalChange):Promise<Result>{
  const containment=['plugin.asset.revoke','plugin.file_prefix.revoke','plugin.page_type.revoke'].includes(change.action);
  if(!containment)assertRegulatedWritesAllowed(c.env);
  try {const result=await mutate(c,change);invalidate();return result;}catch(error){
    invalidate();
    if(error instanceof PolicyRefusal){await recordPolicyDenial(c,error.reason);return error.result;}
    await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new PluginApprovalUnavailableError();
  }
}
async function mutate(c:AppContext,{id,action,key='',access=''}:PluginApprovalChange):Promise<Result>{
  if(!Number.isSafeInteger(id)||id<=0)return 'missing';
  const base=await capturePluginMutationContext(c);
  const row=base.plugins.find(p=>p.id===id);if(!row)return 'missing';
  const pin=base.identities.find(p=>p.plugin_row_id===id);
  if(pin&&!safeId(pin.manifest_id))throw new Error('Unsafe identity pin');
  const inspected=await inspectPluginManifest(row);if(!inspected)return 'unreachable';
  const {manifest,fetcher}=inspected,pluginId=manifest.id;
  const identity=action==='plugin.identity.approve';
  // Any manifest owner decision is rechecked by the complete pin snapshot.
  const claimed=base.identities.some(p=>p.manifest_id===pluginId&&p.plugin_row_id!==id);
  const refusal=async(result:Result,reason:PermissionDenialReason):Promise<never>=>{await c.env.DB.batch([...base.admission(),...base.finish()]);throw new PolicyRefusal(result,reason);};
  if(identity&&claimed)return refusal('identity-claimed','plugin_identity_claimed');
  if(!identity&&pin?.manifest_id!==pluginId)return refusal('missing','plugin_identity_required');
  if(identity&&pin?.manifest_id===pluginId){await c.env.DB.batch([...base.admission(),...base.finish()]);return 'identity-ok';}

  const plans:Plan[]=await Promise.all(OWNED.slice(0,3).map(async spec=>({...spec,keys:['id'],before:await snapshot<Row>(c,spec.table,spec.fields),after:[],where:'1',args:[]})));
  if(identity){
    const ids=[...new Set([pin?.manifest_id,pluginId].filter((v):v is string=>!!v))];
    for(const spec of [OWNED[3],{table:'plugin_sequences',fields:['plugin_id','key','value','created_at','updated_at']}]){
      plans.push({...spec,keys:['plugin_id','key'],before:await snapshot<Row>(c,spec.table,spec.fields,`plugin_id IN (${ids.map(()=>'?').join(',')})`,ids),after:[],where:`plugin_id IN (${ids.map(()=>'?').join(',')})`,args:ids});
    }
  }
  for(const plan of plans)plan.after=plan.before.map(r=>({...r}));
  const classes=[base.dataClass(plans.map(p=>p.table)),classFor(base.policy,'plugin',pluginId)];
  for(const plan of plans)for(const r of plan.before){if(typeof r.plugin_id!=='string'||!safeId(r.plugin_id))throw new Error('Unsafe approval namespace');classes.push(classFor(base.policy,'plugin',r.plugin_id));}
  // Grants cover classified target scopes too, including wildcard types and
  // sensitive descendants beneath an approved parent storage prefix.
  const pageScopes=[...plans[1].before.map(r=>String(r.page_type)),
    ...(action.startsWith('plugin.page_type.')?[key,...(manifest.contentTypes?.readTypes??[]),...(manifest.contentTypes?.writeTypes??[]),...Object.keys(manifest.contentTypes?.blueprint??{})]:[])];
  for(const scope of pageScopes){
    if(scope==='*')for(const [target,classification] of base.policy.exact)if(target.startsWith('page_type:'))classes.push(classification);
    classes.push(classFor(base.policy,'page_type',scope));
  }
  for(const prefix of [...plans[2].before.map(r=>String(r.prefix)),...(manifest.filePrefixes??[])]){
    for(const entry of base.policy.prefixes)if(filePrefixesOverlap(entry.key,prefix))classes.push(entry.class);
  }
  const dataClass=classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
  await auditBackgroundReads(c.env,await Promise.all(plans.map(async p=>({action:'plugin.approval-source-read',kind:'table' as const,key:p.table,targetType:p.table,
    ids:await Promise.all(p.before.map(r=>p.keys[0]==='id'?String(r.id):fingerprint(json([r.plugin_id,r.key])))),count:p.before.length,minimumClass:dataClass==='none'?undefined:dataClass}))),contextActor(c));
  const now=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!now)throw new Error('Clock unavailable');
  const detail:Record<string,unknown>={operation_id:crypto.randomUUID(),id,identity_fingerprint:await fingerprint(pluginId),manifest_fingerprint:await fingerprint(json(manifest))};
  const actor=c.get('user');
  const result:Result=action.endsWith('.revoke')?'revoked':action.endsWith('_all')?'approved-all':identity?'identity-approved':'approved';
  const allocated=new Map<string,number>();
  const sequenceSnapshots=new Map<string,number|null>();
  const nextId=async(plan:Plan)=>{
    if(allocated.has(plan.table)){const next=allocated.get(plan.table)!+1;if(!Number.isSafeInteger(next))throw new Error('Approval IDs exhausted');allocated.set(plan.table,next);return next;}
    const seq=await c.env.DB.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(plan.table).first<{seq:number}>();
    sequenceSnapshots.set(plan.table,seq?.seq??null);
    const next=Math.max(seq?.seq??0,...plan.after.map(r=>Number(r.id)),0)+1;
    if(!Number.isSafeInteger(next)||next<=0)throw new Error('Approval IDs exhausted');allocated.set(plan.table,next);return next;
  };
  const approve=async(plan:Plan,values:Row,keepExisting=false)=>{
    const keys=plan.table==='plugin_asset_approvals'?['plugin_id','path']:plan.table==='plugin_file_prefix_approvals'?['plugin_id','prefix']:['plugin_id','page_type','access'];
    const old=plan.after.find(r=>sameKey(r,values,keys));
    if(old&&(keepExisting||Object.entries(values).every(([k,v])=>old[k]===v)))return;
    const next:Row={...old,...values,id:old?.id??await nextId(plan),created_at:old?.created_at??null,updated_at:null};
    plan.after=old?plan.after.map(r=>r.id===old.id?next:r):[...plan.after,next];
  };
  if(identity){
    detail.previous_identity_fingerprint=pin?await fingerprint(pin.manifest_id):null;
    // A renamed identity must not inherit orphaned destination capabilities.
    for(const plan of plans.slice(0,3))plan.after=plan.after.filter(r=>r.plugin_id!==pin?.manifest_id&&r.plugin_id!==pluginId);
    for(const plan of plans.slice(3)){
      const moved=pin?plan.before.filter(r=>r.plugin_id===pin.manifest_id):[];
      if(plan.table==='plugin_sequences'&&plan.before.some(r=>!Number.isSafeInteger(r.value)))throw new Error('Unsafe sequence');
      const keys=new Set(moved.map(r=>r.key));
      plan.after=[...plan.before.filter(r=>r.plugin_id!==pin?.manifest_id&&!(r.plugin_id===pluginId&&keys.has(r.key))),...moved.map(r=>({...r,plugin_id:pluginId}))];
    }
    const before:Row[]=base.identities.map(r=>({...r}));
    plans.push({table:'plugin_identity_approvals',fields:IDENTITY,keys:['plugin_row_id'],before,after:[...before.filter(r=>r.plugin_row_id!==id),{plugin_row_id:id,manifest_id:pluginId,approved_by:actor.email,created_at:pin?.created_at??null,updated_at:null}],where:'1',args:[]});
    detail.retained_limit_pricing_settings=true;
  }else if(action.startsWith('plugin.asset.')){
    const plan=plans[0];
    if(action.endsWith('.approve')){
      if(!(manifest.assets??[]).some(a=>a.path===key))return 'invalid';
      await auditPluginManagement(c.env,pluginId,'asset-approve-fetch',contextActor(c));
      // Guard captured authority/registry before disclosing to the plugin too.
      await c.env.DB.batch([...base.admission(),...base.finish()]);
      const upstream=await fetcher.fetch(`${PLUGIN_ORIGIN}${key}`);if(!upstream.ok)return 'fetch-failed';
      const integrity=await computeIntegrity(await limitedBytes(upstream));
      await approve(plan,{plugin_id:pluginId,path:key,integrity,approved_by:actor.email});
      detail.integrity=integrity;
    }else plan.after=plan.after.filter(r=>r.plugin_id!==pluginId||r.path!==key);
    detail.key_fingerprint=await fingerprint(key);
  }else if(action.startsWith('plugin.file_prefix.')){
    const plan=plans[2];
    if(action.endsWith('.approve')){
      if(!(manifest.filePrefixes??[]).includes(key))return 'invalid';
      if(plan.before.some(r=>r.plugin_id!==pluginId&&filePrefixesOverlap(String(r.prefix),key))){
        await c.env.DB.batch([...base.admission(),...plans.map(p=>guard(c,p.table,p.fields,p.before,p.where,p.args)),...base.finish()]);
        throw new PolicyRefusal('conflict','plugin_file_prefix_conflict');
      }
      await approve(plan,{plugin_id:pluginId,prefix:key,approved_by:actor.email});
    }else plan.after=plan.after.filter(r=>r.plugin_id!==pluginId||r.prefix!==key);
    detail.key_fingerprint=await fingerprint(key);
  }else{
    const plan=plans[1],types=manifest.contentTypes;
    const scopes=action.endsWith('_all')?[
      ...[...new Set(types?.readTypes??[])].map(pageType=>({pageType,access:'read'})),
      ...[...new Set([...(types?.writeTypes??[]),...Object.keys(types?.blueprint??{})])].map(pageType=>({pageType,access:'write'})),
    ]:[{pageType:key,access}];
    for(const scope of scopes){
      if(!['read','write'].includes(scope.access)||typeof scope.pageType!=='string'||!scope.pageType||scope.pageType.length>256) return 'invalid';
      const declared=scope.access==='read'?types?.readTypes??[]:[...(types?.writeTypes??[]),...Object.keys(types?.blueprint??{})];
      if(!action.endsWith('.revoke')&&!declared.includes(scope.pageType))return 'invalid';
      if(action.endsWith('.revoke'))plan.after=plan.after.filter(r=>r.plugin_id!==pluginId||r.page_type!==scope.pageType||r.access!==scope.access);
      else await approve(plan,{plugin_id:pluginId,page_type:scope.pageType,access:scope.access,approved_by:actor.email},action.endsWith('_all'));
    }
  }
  const statements=[...base.admission(),...plans.map(p=>guard(c,p.table,p.fields,p.before,p.where,p.args)),
    ...[...sequenceSnapshots].map(([table,seq])=>abortIf(c.env,'(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ?',[table,seq]))];
  const changes:object[]=[];
  for(const plan of plans){
    if(plan.after.length>5000)throw new Error('Approval catalogue requires review');json(plan.after);
    const recordKey=(r:Row)=>JSON.stringify(plan.keys.map(k=>r[k]));
    const beforeByKey=new Map(plan.before.map(r=>[recordKey(r),r]));
    const afterByKey=new Map(plan.after.map(r=>[recordKey(r),r]));
    const removed=plan.before.filter(r=>!afterByKey.has(recordKey(r)));
    const saved=plan.after.filter(r=>{const old=beforeByKey.get(recordKey(r));return !old||plan.fields.some(f=>old[f]!==r[f]);});
    if(!removed.length&&!saved.length)continue;
    const entry=async(r:Row)=>({...(plan.keys[0]==='id'?{id:r.id}:plan.keys[0]==='plugin_row_id'?{id:r.plugin_row_id}:{key_fingerprint:await fingerprint(json([r.plugin_id,r.key]))}),
      ...(r.page_type?{scope_fingerprint:await fingerprint(String(r.page_type)),access:r.access}:{}),
      ...(r.path||r.prefix?{key_fingerprint:await fingerprint(String(r.path??r.prefix))}:{})});
    changes.push({table:plan.table,removed_count:removed.length,saved_count:saved.length,removed:await Promise.all(removed.map(entry)),saved:await Promise.all(saved.map(entry)),overwritten:await Promise.all(saved.filter(r=>beforeByKey.has(recordKey(r))).map(entry))});
    if(removed.length)statements.push(c.env.DB.prepare(`DELETE FROM ${plan.table} AS r WHERE EXISTS (SELECT 1 FROM json_each(?) e WHERE ${plan.keys.map(k=>`r.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')})`).bind(json(removed)),abortIf(c.env,'changes()<>?',[removed.length]));
    if(saved.length)statements.push(c.env.DB.prepare(`INSERT INTO ${plan.table} (${plan.fields.join(',')}) SELECT ${plan.fields.map(f=>f.endsWith('_at')?`COALESCE(json_extract(e.value,'$.${f}'),CURRENT_TIMESTAMP)`:`json_extract(e.value,'$.${f}')`).join(',')} FROM json_each(?) e WHERE 1
      ON CONFLICT(${plan.keys.join(',')}) DO UPDATE SET ${plan.fields.filter(f=>!plan.keys.includes(f)).map(f=>`${f}=excluded.${f}`).join(',')}`).bind(json(saved)),abortIf(c.env,'changes()<>?',[saved.length]));
  }
  if(changes.length){
    detail.changes=changes;json(detail);
    const receipt=attributedMutationAuditEvidence(c.env,actor,{action,entityType:'plugin',entityId:row.uuid,detail},dataClass,base.policy,{context:c});statements.push(receipt.write,receipt.guard);
  }
  statements.push(guard(c,'plugins',REGISTRY,base.plugins));
  if(!identity)statements.push(guard(c,'plugin_identity_approvals',IDENTITY,base.identities));
  for(const plan of plans){
    statements.push(abortIf(c.env,`(SELECT COUNT(*) FROM ${plan.table} WHERE ${plan.where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM ${plan.table} r WHERE ${plan.fields.map(f=>f.endsWith('_at')?`(CASE WHEN json_extract(e.value,'$.${f}') IS NULL THEN r.${f}>=? AND r.${f}<=CURRENT_TIMESTAMP ELSE r.${f} IS json_extract(e.value,'$.${f}') END)`:`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...plan.args,plan.after.length,json(plan.after),...plan.fields.filter(f=>f.endsWith('_at')).map(()=>now.now)]));
  }
  statements.push(...[...allocated].map(([table,seq])=>abortIf(c.env,'(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ?',[table,seq])),...base.finish());if(await flushReadAudit(c))throw new Error('Approval read evidence unavailable');
  await c.env.DB.batch(statements);return result;
}
