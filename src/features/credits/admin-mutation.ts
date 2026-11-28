import type { AppContext } from '../../core/http/context';
import { beginAuditedMutation,type MutationPlan,type PlannedWrite,type SnapshotSpec } from '../../core/evidence/audited-mutation';
import { splitRoles } from '../../core/auth/roles';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { PermissionDenialReason } from '../../core/auth/denial-contract';
import type { ContainerKind } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import { json,guard,resultGuard,type Row } from '../../core/db/bounded-mutation';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import type { CreditCurrency } from './currencies';
import { isCreditCurrency } from './currencies';

type Operation='adjust-user'|'adjust-pool'|'transfer'|'donate'|'share';
interface Input {operation:Operation;amount:number;currency:CreditCurrency;note?:string;userId?:number;recipientEmail?:string}
type Failure={ok:false;error:'unknown_user'|'self_recipient'|'admin_recipient'|'insufficient_credits';balance:number;required:number};
type Result=Failure|{ok:true;balanceAfter:number;senderBalance:number;recipientBalance:number;sharedBalance:number;recipientEmail:string};
const USER=['id','email','role'];
const WALLET=['user_id','currency','balance'];
const POOL=['currency','balance'];
const LEDGER=['id','user_id','currency','delta','balance_after','action','entity_type','entity_id','plugin_id','note','created_by','created_at'];
const actions={ 'adjust-user':'user.credits.adjust','adjust-pool':'credits.shared.adjust',transfer:'user.credits.transfer',donate:'user.credits.donate',share:'user.credits.share'};
export class CreditAdministrationUnavailableError extends Error {constructor(){super('Credit administration unavailable');}}

const read=(table:string,currency:string)=>({action:'credit.administration-source-read',kind:'table' as const,key:table,targetType:table,id:(r:Row)=>String(r.id??r.user_id??currency)});

/** Host administration/self-service only. Wallets, paired ledgers and the exact
 * receipt commit together; downstream charges/refunds retain their own contract.
 * NULL timestamps in an expected row: set by this transaction (see resultGuard). */
export async function mutateCreditAdministration(c:AppContext,input:Input):Promise<Result>{
  assertRegulatedWritesAllowed(c.env);
  const {operation,amount,currency}=input;
  const actor=c.get('user'),selfId=Number(actor.sub);
  const userWhere=operation==='transfer'?'id=? OR lower(email)=?':'id IN (?,?)';
  const userArgs=operation==='transfer'?[selfId,input.recipientEmail??'']:[selfId,input.userId??selfId];
  const touchesPool=operation==='adjust-pool'||operation==='donate'||operation==='share';
  const scopeTables=['credit_wallets','credit_ledger',...(touchesPool?['shared_credits','shared_credit_ledger']:[])];
  let result:Result|undefined,refusal:PermissionDenialReason|undefined;
  const mutation=await beginAuditedMutation(c,{
    permission:operation==='transfer'||operation==='donate'?'self':operation==='share'?'credits:share':'users:manage',
    classify:['users','roles','role_permissions','sessions',...scopeTables].map(t=>['table',t] as [ContainerKind,string]),
    snapshot:{users:{table:'users',fields:USER,where:userWhere,args:userArgs,read:read('users',currency)}},
    unavailable:()=>new CreditAdministrationUnavailableError(),
  });
  await mutation.commit(async({users},tools):Promise<MutationPlan|null>=>{
    if(!Number.isSafeInteger(amount)||!amount||(!operation.startsWith('adjust-')&&amount<0)||!isCreditCurrency(currency))throw new Error('Unsafe credit input');
    if(!Number.isSafeInteger(selfId)||selfId<=0)throw new Error('Unsafe actor');
    if(operation==='transfer'&&users.filter(r=>String(r.email).toLowerCase()===input.recipientEmail).length>1)throw new Error('Ambiguous recipient');
    const target=operation==='transfer'?users.find(r=>String(r.email).toLowerCase()===input.recipientEmail):users.find(r=>r.id===(input.userId??selfId));
    const refuse=(error:Failure['error'],reason:PermissionDenialReason|undefined,balance=0)=>{result={ok:false,error,balance,required:Math.abs(amount)};refusal=reason;return null;};
    if(!target&&operation!=='adjust-pool')return refuse('unknown_user',undefined,0);
    const userIds=[...new Set([selfId,...(target?[Number(target.id)]:[])])];
    const walletWhere=`currency=? AND user_id IN (${userIds.map(()=>'?').join(',')})`,walletArgs=[currency,...userIds];
    const specs:SnapshotSpec[]=[{table:'credit_wallets',fields:WALLET,where:walletWhere,args:walletArgs,read:read('credit_wallets',currency)},
      {table:'credit_ledger',fields:LEDGER,where:walletWhere,args:walletArgs,read:read('credit_ledger',currency)},
      ...(touchesPool?[{table:'shared_credits',fields:POOL,where:'currency=?',args:[currency],read:read('shared_credits',currency)},
        {table:'shared_credit_ledger',fields:LEDGER,where:'currency=?',args:[currency],read:read('shared_credit_ledger',currency)}]:[])];
    const scopes=(await tools.snapshot(specs)).map((rows,index)=>({...specs[index],rows:rows as Row[]}));
    if(operation==='transfer'&&target!.id===selfId)return refuse('self_recipient','credit_self_transfer');
    if(operation==='transfer'&&splitRoles(String(target!.role)).includes('admin'))return refuse('admin_recipient','credit_recipient_admin');
    for(const s of scopes.filter(s=>s.table==='credit_wallets'||s.table==='shared_credits'))if(s.rows.some(r=>!Number.isSafeInteger(r.balance)||Number(r.balance)<0))throw new Error('Unsafe balance');
    const wallets=scopes[0],pool=scopes.find(s=>s.table==='shared_credits');
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
    // Ledger IDs come from each ledger's AUTOINCREMENT state, read with the clock.
    const ledgers=[...new Set(deltas.map(d=>d.userId===null?'shared_credit_ledger':'credit_ledger'))];
    const clock=await tools.clock(ledgers.map(t=>`(SELECT seq FROM sqlite_sequence WHERE name='${t}') AS ${t}_seq,(SELECT COALESCE(MAX(id),0) FROM ${t}) AS ${t}_max`).join(','));
    const allocation=new Map(ledgers.map(t=>[t,{seq:clock[`${t}_seq`] as number|null,maximum:Number(clock[`${t}_max`]),next:Math.max(Number(clock[`${t}_seq`]??0),Number(clock[`${t}_max`]))}]));
    const expected=new Map(scopes.map(s=>[s.table,s.rows.map(r=>({...r}))]));
    const writes:PlannedWrite[]=[],manifest:object[]=[];
    for(const part of deltas){
      const table=part.userId===null?'shared_credits':'credit_wallets',ledgerTable=part.userId===null?'shared_credit_ledger':'credit_ledger';
      const old=part.userId===null?poolBefore:balance(part.userId),next=old+part.delta;
      if(!Number.isSafeInteger(next)||next<0)throw new Error('Unsafe final balance');
      const rows=expected.get(table)!;
      expected.set(table,[...rows.filter(r=>part.userId!==null?r.user_id!==part.userId:false),{...(part.userId===null?{}:{user_id:part.userId}),currency,balance:next}]);
      writes.push(part.userId===null?{sql:'INSERT INTO shared_credits(currency,balance) VALUES (?,?) ON CONFLICT(currency) DO UPDATE SET balance=excluded.balance',args:[currency,next]}
        :{sql:'INSERT INTO credit_wallets(user_id,currency,balance) VALUES (?,?,?) ON CONFLICT(user_id,currency) DO UPDATE SET balance=excluded.balance',args:[part.userId,currency,next]});
      const ledgerId=++allocation.get(ledgerTable)!.next;if(!Number.isSafeInteger(ledgerId)||ledgerId<=0)throw new Error('Ledger IDs exhausted');
      const record:Row={id:ledgerId,user_id:part.userId??part.beneficiary,currency,delta:part.delta,balance_after:next,action:part.action,entity_type:part.entityType,entity_id:part.entityId,plugin_id:null,note:input.note||null,created_by:actor.sub,created_at:null};
      expected.get(ledgerTable)!.push(record);json(expected.get(ledgerTable));
      if(expected.get(ledgerTable)!.length>5000)throw new Error('Ledger history requires review');
      writes.push({sql:`INSERT INTO ${ledgerTable}(${LEDGER.join(',')}) VALUES (${LEDGER.map(f=>f==='created_at'?'CURRENT_TIMESTAMP':'?').join(',')})`,args:LEDGER.filter(f=>f!=='created_at').map(f=>record[f])});
      manifest.push({table:ledgerTable,id:ledgerId,user_id:part.userId??part.beneficiary,currency,delta:part.delta,balance_before:old,balance_after:next});
    }
    const finalUser=(id:number)=>Number(expected.get('credit_wallets')!.find(r=>r.user_id===id)?.balance??0),finalPool=Number(expected.get('shared_credits')?.[0]?.balance??poolBefore);
    result={ok:true,balanceAfter:operation==='adjust-pool'?finalPool:finalUser(Number(target!.id)),senderBalance:finalUser(selfId),recipientBalance:target?finalUser(Number(target.id)):0,sharedBalance:finalPool,recipientEmail:String(target?.email??'')};
    return {
      admit:[...allocation].map(([t,a])=>abortIf(c.env,`(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ? OR (SELECT COALESCE(MAX(id),0) FROM ${t})<>?`,[t,a.seq,a.maximum])),
      writes,
      evidence:{entry:{action:actions[operation],entityType:operation==='adjust-pool'?'shared_credits':'user',entityId:operation==='adjust-pool'?1:Number(target!.id),detail:{currency,amount,note_present:!!input.note,entries:manifest}}},
      expect:since=>[guard(c,'users',USER,users,userWhere,userArgs),...scopes.map(s=>resultGuard(c,s.table,s.fields,expected.get(s.table)!,since,s.where,s.args)),
        ...[...allocation].map(([t,a])=>abortIf(c.env,'(SELECT seq FROM sqlite_sequence WHERE name=?) IS NOT ?',[t,a.next]))],
    };
  });
  if(refusal)await recordPolicyDenial(c,refusal);
  return result!;
}
