import type { AppContext } from '../../core/http/context';
import { captureAccessAuthorization,captureSelfAuthorization } from '../../core/auth/access-authorization';
import { splitRoles } from '../../core/auth/roles';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { PermissionDenialReason } from '../../core/auth/denial-contract';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { json,snapshot,guard,resultGuard,type Row } from '../../core/db/bounded-mutation';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import type { CreditCurrency } from './currencies';
import { isCreditCurrency } from './currencies';

type Operation='adjust-user'|'adjust-pool'|'transfer'|'donate'|'share';
interface Input {operation:Operation;amount:number;currency:CreditCurrency;note?:string;userId?:number;recipientEmail?:string}
type Failure={ok:false;error:'unknown_user'|'self_recipient'|'admin_recipient'|'insufficient_credits';balance:number;required:number};
type Result=Failure|{ok:true;balanceAfter:number;senderBalance:number;recipientBalance:number;sharedBalance:number;recipientEmail:string};
interface Scope {table:string;fields:string[];rows:Row[];where:string;args:Array<string|number|null>}
const USER=['id','email','role'];
const WALLET=['user_id','currency','balance'];
const POOL=['currency','balance'];
const LEDGER=['id','user_id','currency','delta','balance_after','action','entity_type','entity_id','plugin_id','note','created_by','created_at'];
const actions={ 'adjust-user':'user.credits.adjust','adjust-pool':'credits.shared.adjust',transfer:'user.credits.transfer',donate:'user.credits.donate',share:'user.credits.share'};
export class CreditAdministrationUnavailableError extends Error {constructor(){super('Credit administration unavailable');}}
class Refusal extends Error {constructor(readonly result:Failure,readonly reason:PermissionDenialReason){super(reason);}}

/** Host administration/self-service only. Wallets, paired ledgers and the exact
 * receipt commit together; downstream charges/refunds retain their own contract. */
export async function mutateCreditAdministration(c:AppContext,input:Input):Promise<Result>{
  assertRegulatedWritesAllowed(c.env);
  try{return await mutate(c,input);}catch(error){
    if(error instanceof Refusal){await recordPolicyDenial(c,error.reason);return error.result;}
    await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new CreditAdministrationUnavailableError();
  }
}
async function mutate(c:AppContext,input:Input):Promise<Result>{
  const {operation,amount,currency}=input;
  if(!Number.isSafeInteger(amount)||!amount||(!operation.startsWith('adjust-')&&amount<0)||!isCreditCurrency(currency))throw new Error('Unsafe credit input');
  const actor=c.get('user'),selfId=Number(actor.sub);
  if(!Number.isSafeInteger(selfId)||selfId<=0)throw new Error('Unsafe actor');
  const authority=operation==='transfer'||operation==='donate'?await captureSelfAuthorization(c.env,actor):await captureAccessAuthorization(c.env,actor,operation==='share'?'credits:share':'users:manage');
  if(!authority.allowed)throw new Error('Credit authority unavailable');
  const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('Credit classification unavailable');
  const userWhere=operation==='transfer'?'id=? OR lower(email)=?':'id IN (?,?)';
  const userArgs=operation==='transfer'?[selfId,input.recipientEmail??'']:[selfId,input.userId??selfId];
  const users=await snapshot<Row>(c,'users',USER,userWhere,userArgs);
  if(operation==='transfer'&&users.filter(r=>String(r.email).toLowerCase()===input.recipientEmail).length>1)throw new Error('Ambiguous recipient');
  const target=operation==='transfer'?users.find(r=>String(r.email).toLowerCase()===input.recipientEmail):users.find(r=>r.id===(input.userId??selfId));
  if(!target&&operation!=='adjust-pool')return {ok:false,error:'unknown_user',balance:0,required:amount};
  const userIds=[...new Set([selfId,...(target?[Number(target.id)]:[])])];
  const walletWhere=`currency=? AND user_id IN (${userIds.map(()=>'?').join(',')})`,walletArgs=[currency,...userIds];
  const touchesPool=operation==='adjust-pool'||operation==='donate'||operation==='share';
  const specs=[{table:'credit_wallets',fields:WALLET,where:walletWhere,args:walletArgs},
    {table:'credit_ledger',fields:LEDGER,where:walletWhere,args:walletArgs},
    ...(touchesPool?[{table:'shared_credits',fields:POOL,where:'currency=?',args:[currency]},
      {table:'shared_credit_ledger',fields:LEDGER,where:'currency=?',args:[currency]}]:[])];
  const scopes:Scope[]=await Promise.all(specs.map(async s=>({...s,rows:await snapshot<Row>(c,s.table,s.fields,s.where,s.args)})));
  const classes=['users','roles','role_permissions','sessions',...scopes.map(s=>s.table)].map(t=>classFor(policy,'table',t));
  const dataClass=classes.includes('phi')?'phi' as const:classes.includes('pii')?'pii' as const:'none' as const;
  await auditBackgroundReads(c.env,[{table:'users',rows:users},...scopes].map(s=>({action:'credit.administration-source-read',kind:'table' as const,key:s.table,targetType:s.table,
    ids:s.rows.map(r=>String(r.id??r.user_id??currency)),count:s.rows.length,minimumClass:dataClass==='none'?undefined:dataClass})),contextActor(c));
  const admission=()=>[authority.guard(),classificationPolicyGuard(c.env,policy),guard(c,'users',USER,users,userWhere,userArgs),...scopes.map(s=>guard(c,s.table,s.fields,s.rows,s.where,s.args))];
  const finish=()=>[authority.guard(),classificationPolicyGuard(c.env,policy)];
  async function refuse(error:Failure['error'],reason:PermissionDenialReason,balance=0):Promise<never>{
    if(await flushReadAudit(c))throw new Error('Credit source evidence unavailable');
    await c.env.DB.batch([...admission(),...finish()]);throw new Refusal({ok:false,error,balance,required:Math.abs(amount)},reason);
  }
  if(operation==='transfer'&&target!.id===selfId)return refuse('self_recipient','credit_self_transfer');
  if(operation==='transfer'&&splitRoles(String(target!.role)).includes('admin'))return refuse('admin_recipient','credit_recipient_admin');
  for(const s of scopes.filter(s=>s.table==='credit_wallets'||s.table==='shared_credits'))if(s.rows.some(r=>!Number.isSafeInteger(r.balance)||Number(r.balance)<0))throw new Error('Unsafe balance');
  const wallets=scopes[0],ledger=scopes[1],pool=scopes.find(s=>s.table==='shared_credits'),sharedLedger=scopes.find(s=>s.table==='shared_credit_ledger');
  const balance=(id:number)=>Number(wallets.rows.find(r=>r.user_id===id)?.balance??0);
  const poolBefore=Number(pool?.rows[0]?.balance??0);
  const fromPool=operation==='share'||(operation==='adjust-pool'&&amount<0);
  const fromUser=operation==='transfer'||operation==='donate'||(operation==='adjust-user'&&amount<0);
  const debitBalance=fromPool?poolBefore:balance(operation==='adjust-user'?Number(target!.id):selfId);
  if((fromPool||fromUser)&&debitBalance<Math.abs(amount))return refuse('insufficient_credits','credit_insufficient_balance',debitBalance);
  const deltas:Array<{userId:number|null;delta:number;action:string;entityType:string|null;entityId:string|null;beneficiary:number|null}>=[];
  if(operation==='adjust-user')deltas.push({userId:Number(target!.id),delta:amount,action:'admin:adjust',entityType:null,entityId:null,beneficiary:null});
  if(operation==='adjust-pool')deltas.push({userId:null,delta:amount,action:'admin:adjust',entityType:null,entityId:null,beneficiary:null});
  if(operation==='transfer')deltas.push({userId:selfId,delta:-amount,action:'transfer:send',entityType:'user',entityId:String(target!.id),beneficiary:null},{userId:Number(target!.id),delta:amount,action:'transfer:receive',entityType:'user',entityId:String(selfId),beneficiary:null});
  if(operation==='donate')deltas.push({userId:selfId,delta:-amount,action:'shared:donate',entityType:'shared',entityId:null,beneficiary:null},{userId:null,delta:amount,action:'shared:donate',entityType:null,entityId:null,beneficiary:selfId});
  if(operation==='share')deltas.push({userId:null,delta:-amount,action:'shared:send',entityType:null,entityId:null,beneficiary:Number(target!.id)},{userId:Number(target!.id),delta:amount,action:'shared:receive',entityType:'shared',entityId:null,beneficiary:null});
  const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Clock unavailable');
  const expected=new Map(scopes.map(s=>[s.table,s.rows.map(r=>({...r}))]));
  const sequences=new Map<string,{seq:number|null;maximum:number;next:number}>();
  const statements=admission(),manifest:object[]=[];
  for(const part of deltas){
    const table=part.userId===null?'shared_credits':'credit_wallets',ledgerScope=part.userId===null?sharedLedger!:ledger;
    const old=part.userId===null?poolBefore:balance(part.userId),next=old+part.delta;
    if(!Number.isSafeInteger(next)||next<0)throw new Error('Unsafe final balance');
    const rows=expected.get(table)!;
    const newRow:Row={...(part.userId===null?{}:{user_id:part.userId}),currency,balance:next};
    expected.set(table,[...rows.filter(r=>part.userId!==null?r.user_id!==part.userId:false),newRow]);
    statements.push(c.env.DB.prepare(part.userId===null?'INSERT INTO shared_credits(currency,balance) VALUES (?,?) ON CONFLICT(currency) DO UPDATE SET balance=excluded.balance':'INSERT INTO credit_wallets(user_id,currency,balance) VALUES (?,?,?) ON CONFLICT(user_id,currency) DO UPDATE SET balance=excluded.balance').bind(...(part.userId===null?[currency,next]:[part.userId,currency,next])),abortIf(c.env,'changes()<>1'));
    let allocation=sequences.get(ledgerScope.table);
    if(!allocation){
      const selected=await c.env.DB.prepare(`SELECT (SELECT seq FROM sqlite_sequence WHERE name=?) seq,COALESCE(MAX(id),0) maximum FROM ${ledgerScope.table}`).bind(ledgerScope.table).first<{seq:number|null;maximum:number}>();
      if(!selected)throw new Error('Ledger allocator unavailable');
      allocation={...selected,next:Math.max(selected.seq??0,selected.maximum)};sequences.set(ledgerScope.table,allocation);
      statements.push(abortIf(c.env,`(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ? OR (SELECT COALESCE(MAX(id),0) FROM ${ledgerScope.table})<>?`,[ledgerScope.table,selected.seq,selected.maximum]));
    }
    const ledgerId=++allocation.next;if(!Number.isSafeInteger(ledgerId)||ledgerId<=0)throw new Error('Ledger IDs exhausted');
    const record:Row={id:ledgerId,user_id:part.userId??part.beneficiary,currency,delta:part.delta,balance_after:next,action:part.action,entity_type:part.entityType,entity_id:part.entityId,plugin_id:null,note:input.note||null,created_by:actor.sub,created_at:null};
    expected.get(ledgerScope.table)!.push(record);json(expected.get(ledgerScope.table));
    if(expected.get(ledgerScope.table)!.length>5000)throw new Error('Ledger history requires review');
    statements.push(c.env.DB.prepare(`INSERT INTO ${ledgerScope.table}(${LEDGER.join(',')}) VALUES (${LEDGER.map(f=>f==='created_at'?'CURRENT_TIMESTAMP':'?').join(',')})`).bind(...LEDGER.filter(f=>f!=='created_at').map(f=>record[f])),abortIf(c.env,'changes()<>1'));
    manifest.push({table:ledgerScope.table,id:ledgerId,user_id:part.userId??part.beneficiary,currency,delta:part.delta,balance_before:old,balance_after:next});
  }
  const receipt=attributedMutationAuditEvidence(c.env,actor,{action:actions[operation],entityType:operation==='adjust-pool'?'shared_credits':'user',entityId:operation==='adjust-pool'?1:Number(target!.id),detail:{operation_id:crypto.randomUUID(),currency,amount,note_present:!!input.note,entries:manifest}},dataClass,policy,{context:c});
  statements.push(receipt.write,receipt.guard,guard(c,'users',USER,users,userWhere,userArgs),...scopes.map(s=>resultGuard(c,s.table,s.fields,expected.get(s.table)!,clock.now,s.where,s.args)),
    ...[...sequences].map(([table,s])=>abortIf(c.env,'(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ?',[table,s.next])),...finish());
  if(await flushReadAudit(c))throw new Error('Credit source evidence unavailable');await c.env.DB.batch(statements);
  const finalUser=(id:number)=>Number(expected.get('credit_wallets')!.find(r=>r.user_id===id)?.balance??0),finalPool=Number(expected.get('shared_credits')?.[0]?.balance??poolBefore);
  return {ok:true,balanceAfter:operation==='adjust-pool'?finalPool:finalUser(Number(target!.id)),senderBalance:finalUser(selfId),recipientBalance:target?finalUser(Number(target.id)):0,sharedBalance:finalPool,recipientEmail:String(target?.email??'')};
}
