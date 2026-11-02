import type { AppContext } from '../../core/http/context';
import { captureAccessAuthorization } from '../../core/auth/access-authorization';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { PermissionDenialReason } from '../../core/auth/denial-contract';
import { classFor,resolveDataClasses,classificationPolicyGuard } from '../../core/db/data-classes';
import { attributedMutationAuditEvidence,contextActor } from '../../core/db/audit';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads,flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,DEFAULT_CONTENT_LANGUAGE,LocaleInputValidationError,defaultContentLanguageFromRows,normalizeLocaleCode,normalizeLocaleInput,normalizeLocaleMessageInput,type LocaleRecord } from '../../core/i18n';

type Change={action:'create';input:Record<string,unknown>}|{action:'update';input:Record<string,unknown>;code:string}|{action:'delete';code:unknown}|{action:'default';code:unknown}|{action:'message-save';code:unknown;key:unknown;value:unknown}|{action:'message-delete';code:unknown;key:unknown};
interface MessageRow {locale_code:string;message_key:string;value:string;updated_by:string|null;created_at:string;updated_at:string}
interface SettingRow {key:string;value:string;created_at:string;updated_at:string}
const LOCALE=['code','label','content_enabled','ui_enabled','direction','fallback_code','weight','builtin','created_at','updated_at'];
const MUTABLE=['label','content_enabled','ui_enabled','direction','fallback_code','weight'] as const;
const MESSAGE=['locale_code','message_key','value','updated_by','created_at','updated_at'];
const SETTING=['key','value','created_at','updated_at'];
export class LocaleMutationUnavailableError extends Error {constructor(){super('Locale change unavailable');}}
class LocalePolicyError extends LocaleInputValidationError {constructor(message:string,readonly reason:PermissionDenialReason){super(message);}}
function json(value:unknown):string {const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>1_000_000)throw new Error('Locale manifest requires review');return text;}
async function fingerprint(key:string):Promise<string> {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function snapshot<T>(c:AppContext,table:string,fields:string[],where:string,args:Array<string|number|null>,order:string):Promise<T[]> {
  const object=`json_object(${fields.map(f=>`'${f}',r.${f}`).join(',')})`;
  const result=await c.env.DB.prepare(`WITH scoped AS (SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 5001),
    budget AS (SELECT COUNT(*) n,COALESCE(SUM(length(CAST(${object} AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped r)
    SELECT CASE WHEN n>5000 OR bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(${object}) FROM scoped r) END snapshot FROM budget`).bind(...args).first<{snapshot:string}>();
  if(!result)throw new Error('Locale snapshot unavailable');return JSON.parse(result.snapshot) as T[];
}
function guard(c:AppContext,table:string,fields:string[],rows:object[],where='1',args:Array<string|number|null>=[]) {
  return abortIf(c.env,`(SELECT COUNT(*) FROM ${table} WHERE ${where})<>? OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM ${table} r WHERE ${fields.map(f=>`r.${f} IS json_extract(e.value,'$.${f}')`).join(' AND ')}))`,[...args,rows.length,json(rows)]);
}
/** Host locale/message administration only; DB-only core helpers keep their
 * own caller/evidence boundary. Payloads and message keys stay out of detail. */
export async function mutateLocaleAdmin(c:AppContext,change:Change):Promise<string> {
  assertRegulatedWritesAllowed(c.env);
  try {return await mutate(c,change);}catch(error){
    if(error instanceof LocaleInputValidationError){if(error instanceof LocalePolicyError)await recordPolicyDenial(c,error.reason);throw error;}
    clearConfigCache();await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});throw new LocaleMutationUnavailableError();
  }
}
async function mutate(c:AppContext,change:Change):Promise<string> {
  const code=normalizeLocaleCode(change.action==='create'?change.input.code:change.code);
  const authority=await captureAccessAuthorization(c.env,c.get('user'),'menu:manage');if(!authority.allowed)throw new Error('Locale authority unavailable');
  const policy=await resolveDataClasses(c.env,true);if(!policy.ok)throw new Error('Locale classification unavailable');
  const [locales,messages,settings]=await Promise.all([
    snapshot<LocaleRecord>(c,'locales',LOCALE,'1',[],'weight,label COLLATE NOCASE,code'),
    snapshot<MessageRow>(c,'locale_messages',MESSAGE,'locale_code=?',[code],'message_key'),
    snapshot<SettingRow>(c,'settings',SETTING,'key=?',[CONTENT_DEFAULT_LANGUAGE_SETTING_KEY],'key'),
  ]);
  const classes=['locales','locale_messages','settings'].map(t=>classFor(policy,'table',t));const dataClass=classes.includes('phi')?'phi':classes.includes('pii')?'pii':'none';
  const messageIds=await Promise.all(messages.map(async row=>`${code}:message:${await fingerprint(row.message_key)}`));
  await auditBackgroundReads(c.env,[{action:'locale.mutation-read',kind:'table' as const,key:'locales',targetType:'locale',ids:locales.map(l=>l.code),count:locales.length},
    {action:'locale.messages-mutation-read',kind:'table' as const,key:'locale_messages',targetType:'locale_message',ids:messageIds,count:messages.length},
    {action:'locale.default-mutation-read',kind:'table' as const,key:'settings',targetType:'settings',ids:settings.map(s=>s.key),count:settings.length}].map(read=>({...read,minimumClass:dataClass==='none'?undefined:dataClass})),contextActor(c));
  if(await flushReadAudit(c))throw new Error('Locale read evidence unavailable');
  const admission=()=>[authority.guard(),classificationPolicyGuard(c.env,policy),guard(c,'locales',LOCALE,locales),guard(c,'locale_messages',MESSAGE,messages,'locale_code=?',[code]),guard(c,'settings',SETTING,settings,'key=?',[CONTENT_DEFAULT_LANGUAGE_SETTING_KEY])];
  const currentDefault=defaultContentLanguageFromRows(locales,settings[0]?.value??null);
  const before=locales.find(l=>l.code===code);
  const clock=await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{now:string}>();if(!clock)throw new Error('Locale clock unavailable');
  let expectedLocales=locales;let expectedMessages=messages;let expectedSetting=settings;
  const changedLocales=new Set<string>();let changedMessage:string|undefined,settingChanged=false;
  let action='',target=code;let fields:string[]=[];let detail:Record<string,unknown>={};
  const writes:D1PreparedStatement[]=[];
  if(change.action==='create'||change.action==='update') {
    if(change.action==='create'&&before)throw new LocaleInputValidationError('Language already exists');
    if(change.action==='update'&&!before)throw new LocaleInputValidationError('Language does not exist');
    if(change.input.fallback_code&&normalizeLocaleCode(change.input.fallback_code)===code)throw new LocalePolicyError('A locale cannot fall back to itself','locale_fallback_invalid');
    const values=normalizeLocaleInput(change.input,currentDefault,change.action==='update'?code:undefined);
    if(values.fallback_code&&!locales.some(l=>l.code===values.fallback_code))throw new LocalePolicyError('Fallback language must exist','locale_fallback_invalid');
    const next={...before,...values,builtin:before?.builtin??0,created_at:before?.created_at??clock.now,updated_at:clock.now};
    if(!locales.some(l=>l.code!==code&&l.ui_enabled===1)&&next.ui_enabled!==1)throw new LocalePolicyError('At least one CMS interface locale must remain enabled','locale_ui_required');
    fields=MUTABLE.filter(f=>!before||before[f]!==values[f]);
    if(fields.length){changedLocales.add(code);expectedLocales=before?locales.map(l=>l.code===code?next:l):[...locales,next];
      writes.push(before?c.env.DB.prepare(`UPDATE locales SET ${MUTABLE.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE code=?`).bind(...MUTABLE.map(f=>values[f]),code):c.env.DB.prepare(`INSERT INTO locales(code,${MUTABLE.join(',')}) VALUES (?,${MUTABLE.map(()=>'?').join(',')})`).bind(code,...MUTABLE.map(f=>values[f])));action=`locale.${change.action}`;}
  } else if(change.action==='delete') {
    if(code===DEFAULT_CONTENT_LANGUAGE)throw new LocalePolicyError('The unspecified content language cannot be deleted','locale_protected');
    if(code===currentDefault)throw new LocalePolicyError('The default content language cannot be deleted','locale_default_required');
    if(before?.builtin)throw new LocalePolicyError('Built-in locales cannot be deleted','locale_protected');
    if(before){if(!locales.some(l=>l.code!==code&&l.ui_enabled===1))throw new LocalePolicyError('At least one CMS interface locale must remain enabled','locale_ui_required');
      const dependants=locales.filter(l=>l.code!==code&&l.fallback_code===code);for(const row of dependants)changedLocales.add(row.code);
      expectedLocales=locales.filter(l=>l.code!==code).map(l=>changedLocales.has(l.code)?{...l,fallback_code:null,updated_at:clock.now}:l);expectedMessages=[];
      writes.push(c.env.DB.prepare('DELETE FROM locale_messages WHERE locale_code=?').bind(code),abortIf(c.env,'changes()<>?',[messages.length]),
        c.env.DB.prepare('UPDATE locales SET fallback_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE fallback_code=? AND code<>?').bind(code,code),abortIf(c.env,'changes()<>?',[dependants.length]),
        c.env.DB.prepare('DELETE FROM locales WHERE code=?').bind(code));action='locale.delete';fields=['locale','messages','fallbacks'];detail={removed_messages:messageIds,removed_message_count:messages.length,cleared_fallbacks:dependants.map(l=>l.code)};
    }
  } else if(change.action==='default') {
    if(before?.content_enabled!==1)throw new LocalePolicyError('The default content language must be enabled for content','locale_default_required');
    if(settings[0]?.value!==code){settingChanged=true;expectedSetting=[{key:CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,value:code,created_at:settings[0]?.created_at??clock.now,updated_at:clock.now}];
      writes.push(c.env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,code));action='locale.default.update';fields=['default_language'];}
  } else {
    const key=change.action==='message-save'?normalizeLocaleMessageInput(code,change.key,change.value).key:String(change.key??'').trim();
    const old=messages.find(m=>m.message_key===key);target=`${code}:message:${await fingerprint(key)}`;
    if(change.action==='message-save'){
      if(!before)throw new LocaleInputValidationError('Language does not exist');const {value}=normalizeLocaleMessageInput(code,key,change.value);
      if(old?.value!==value){changedMessage=key;const next={locale_code:code,message_key:key,value,updated_by:String(c.get('user').sub),created_at:old?.created_at??clock.now,updated_at:clock.now};expectedMessages=old?messages.map(m=>m.message_key===key?next:m):[...messages,next];
        writes.push(c.env.DB.prepare(`INSERT INTO locale_messages(locale_code,message_key,value,updated_by) VALUES (?,?,?,?) ON CONFLICT(locale_code,message_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).bind(code,key,value,next.updated_by));action='locale_message.upsert';fields=['value'];}
    }else if(old){changedMessage=key;expectedMessages=messages.filter(m=>m.message_key!==key);writes.push(c.env.DB.prepare('DELETE FROM locale_messages WHERE locale_code=? AND message_key=?').bind(code,key));action='locale_message.delete';fields=['value'];}
  }
  if(!writes.length){await c.env.DB.batch(admission());return code;}
  if(expectedLocales.length>5000||expectedMessages.length>5000)throw new Error('Locale manifest requires review');json(expectedLocales);json(expectedMessages);json(detail);
  const receipt=attributedMutationAuditEvidence(c.env,c.get('user'),{action,entityType:'locale',entityId:target,detail:{operation_id:crypto.randomUUID(),fields,...detail}},dataClass,policy,{context:c});
  const statements=[...admission(),...writes,abortIf(c.env,'changes()<>1'),receipt.write,receipt.guard,
    guard(c,'locales',LOCALE.filter(f=>f!=='created_at'&&f!=='updated_at'),expectedLocales),
    guard(c,'locales',LOCALE,expectedLocales.filter(l=>!changedLocales.has(l.code)),'code NOT IN (SELECT value FROM json_each(?))',[json([...changedLocales])])];
  for(const locale of expectedLocales.filter(l=>changedLocales.has(l.code))){const old=locales.find(l=>l.code===locale.code);statements.push(abortIf(c.env,`NOT EXISTS (SELECT 1 FROM locales WHERE code=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${old?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[locale.code,clock.now,old?.created_at??clock.now]));}
  if(changedMessage!==undefined){
    statements.push(guard(c,'locale_messages',MESSAGE.filter(f=>f!=='created_at'&&f!=='updated_at'),expectedMessages,'locale_code=?',[code]),guard(c,'locale_messages',MESSAGE,expectedMessages.filter(m=>m.message_key!==changedMessage),'locale_code=? AND message_key<>?',[code,changedMessage]));
    const expected=expectedMessages.find(m=>m.message_key===changedMessage),old=messages.find(m=>m.message_key===changedMessage);
    if(expected)statements.push(abortIf(c.env,`NOT EXISTS (SELECT 1 FROM locale_messages WHERE locale_code=? AND message_key=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${old?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[code,changedMessage,clock.now,old?.created_at??clock.now]));
  }else statements.push(guard(c,'locale_messages',MESSAGE,expectedMessages,'locale_code=?',[code]));
  if(settingChanged)statements.push(guard(c,'settings',['key','value'],expectedSetting,'key=?',[CONTENT_DEFAULT_LANGUAGE_SETTING_KEY]),abortIf(c.env,`NOT EXISTS (SELECT 1 FROM settings WHERE key=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP AND ${settings[0]?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,clock.now,settings[0]?.created_at??clock.now]));
  else statements.push(guard(c,'settings',SETTING,settings,'key=?',[CONTENT_DEFAULT_LANGUAGE_SETTING_KEY]));
  statements.push(abortIf(c.env,'NOT EXISTS (SELECT 1 FROM locales WHERE ui_enabled=1) OR NOT EXISTS (SELECT 1 FROM locales WHERE content_enabled=1)'),authority.guard(),classificationPolicyGuard(c.env,policy));
  await c.env.DB.batch(statements);clearConfigCache();return code;
}
