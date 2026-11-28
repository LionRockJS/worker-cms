import type { AppContext } from '../../core/http/context';
import { beginAuditedMutation, type PlannedWrite } from '../../core/evidence/audited-mutation';
import { recordPolicyDenial } from '../../core/auth/denials';
import type { PermissionDenialReason } from '../../core/auth/denial-contract';
import { abortIf } from '../../core/db/transaction-guard';
import { fingerprint, json, resultGuard } from '../../core/db/bounded-mutation';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { clearConfigCache } from '../../core/db/content-config';
import { CONTENT_DEFAULT_LANGUAGE_SETTING_KEY,DEFAULT_CONTENT_LANGUAGE,LocaleInputValidationError,defaultContentLanguageFromRows,normalizeLocaleCode,type LocaleRecord } from '../../core/i18n';
import { normalizeLocaleInput, normalizeLocaleMessageInput } from './validation';

type Change={action:'create';input:Record<string,unknown>}|{action:'update';input:Record<string,unknown>;code:string}|{action:'delete';code:unknown}|{action:'default';code:unknown}|{action:'message-save';code:unknown;key:unknown;value:unknown}|{action:'message-delete';code:unknown;key:unknown};
interface MessageRow {locale_code:string;message_key:string;value:string;updated_by:string|null;created_at:string|null;updated_at:string|null}
interface SettingRow {key:string;value:string;created_at:string|null;updated_at:string|null}
type Locale=Omit<LocaleRecord,'created_at'|'updated_at'>&{created_at:string|null;updated_at:string|null};
const LOCALE=['code','label','content_enabled','ui_enabled','direction','fallback_code','weight','builtin','created_at','updated_at'];
const MUTABLE=['label','content_enabled','ui_enabled','direction','fallback_code','weight'] as const;
const MESSAGE=['locale_code','message_key','value','updated_by','created_at','updated_at'];
const SETTING=['key','value','created_at','updated_at'];
const KEY=CONTENT_DEFAULT_LANGUAGE_SETTING_KEY;
export class LocaleMutationUnavailableError extends Error {constructor(){super('Locale change unavailable');}}
class LocalePolicyError extends LocaleInputValidationError {constructor(message:string,readonly reason:PermissionDenialReason){super(message);}}
const messageId=async(code:string,key:string)=>`${code}:message:${await fingerprint(key)}`;

/** Audited locale and message edits. Payloads and message keys stay out of detail.
 *  NULL timestamps in an expected row: set by this transaction (see resultGuard). */
export async function mutateLocaleAdmin(c:AppContext,change:Change):Promise<string> {
  assertRegulatedWritesAllowed(c.env);
  try {return await mutate(c,change);}catch(error){
    if(error instanceof LocaleInputValidationError){if(error instanceof LocalePolicyError)await recordPolicyDenial(c,error.reason);throw error;}
    clearConfigCache();throw error;
  }
}
async function mutate(c:AppContext,change:Change):Promise<string> {
  const code=normalizeLocaleCode(change.action==='create'?change.input.code:change.code);
  const mutation=await beginAuditedMutation(c,{
    permission:'menu:manage',
    classify:[['table','locales'],['table','locale_messages'],['table','settings']],
    snapshot:{
      locales:{table:'locales',fields:LOCALE,where:'1',args:[],order:'weight,label COLLATE NOCASE,code',
        read:{action:'locale.mutation-read',kind:'table',key:'locales',targetType:'locale',id:r=>String(r.code)}},
      messages:{table:'locale_messages',fields:MESSAGE,where:'locale_code=?',args:[code],order:'message_key',
        read:{action:'locale.messages-mutation-read',kind:'table',key:'locale_messages',targetType:'locale_message',id:r=>messageId(code,String(r.message_key))}},
      settings:{table:'settings',fields:SETTING,where:'key=?',args:[KEY],order:'key',
        read:{action:'locale.default-mutation-read',kind:'table',key:'settings',targetType:'settings',id:r=>String(r.key)}},
    },
    unavailable:()=>new LocaleMutationUnavailableError(),
    passthrough:error=>error instanceof LocaleInputValidationError,
  });
  await mutation.commit(async snapshot=>{
    const locales=snapshot.locales as unknown as Locale[],messages=snapshot.messages as unknown as MessageRow[],settings=snapshot.settings as unknown as SettingRow[];
    const currentDefault=defaultContentLanguageFromRows(locales as LocaleRecord[],settings[0]?.value??null);
    const before=locales.find(l=>l.code===code);
    let finalLocales=locales,finalMessages=messages,finalSettings=settings;
    let action='',target=code,fields:string[]=[],detail:Record<string,unknown>={};
    const writes:PlannedWrite[]=[];
    if(change.action==='create'||change.action==='update') {
      if(change.action==='create'&&before)throw new LocaleInputValidationError('Language already exists');
      if(change.action==='update'&&!before)throw new LocaleInputValidationError('Language does not exist');
      if(change.input.fallback_code&&normalizeLocaleCode(change.input.fallback_code)===code)throw new LocalePolicyError('A locale cannot fall back to itself','locale_fallback_invalid');
      const values=normalizeLocaleInput(change.input,currentDefault,change.action==='update'?code:undefined);
      if(values.fallback_code&&!locales.some(l=>l.code===values.fallback_code))throw new LocalePolicyError('Fallback language must exist','locale_fallback_invalid');
      const next={...before,...values,code,builtin:before?.builtin??0,created_at:before?.created_at??null,updated_at:null} as Locale;
      if(!locales.some(l=>l.code!==code&&l.ui_enabled===1)&&next.ui_enabled!==1)throw new LocalePolicyError('At least one CMS interface locale must remain enabled','locale_ui_required');
      fields=MUTABLE.filter(f=>!before||before[f]!==values[f]);
      if(fields.length){finalLocales=before?locales.map(l=>l.code===code?next:l):[...locales,next];action=`locale.${change.action}`;
        writes.push(before?{sql:`UPDATE locales SET ${MUTABLE.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE code=?`,args:[...MUTABLE.map(f=>values[f]),code]}
          :{sql:`INSERT INTO locales(code,${MUTABLE.join(',')}) VALUES (?,${MUTABLE.map(()=>'?').join(',')})`,args:[code,...MUTABLE.map(f=>values[f])]});}
    } else if(change.action==='delete') {
      if(code===DEFAULT_CONTENT_LANGUAGE)throw new LocalePolicyError('The unspecified content language cannot be deleted','locale_protected');
      if(code===currentDefault)throw new LocalePolicyError('The default content language cannot be deleted','locale_default_required');
      if(before?.builtin)throw new LocalePolicyError('Built-in locales cannot be deleted','locale_protected');
      if(before){if(!locales.some(l=>l.code!==code&&l.ui_enabled===1))throw new LocalePolicyError('At least one CMS interface locale must remain enabled','locale_ui_required');
        const dependants=locales.filter(l=>l.code!==code&&l.fallback_code===code).map(l=>l.code);
        finalLocales=locales.filter(l=>l.code!==code).map(l=>dependants.includes(l.code)?{...l,fallback_code:null,updated_at:null}:l);finalMessages=[];
        writes.push({sql:'DELETE FROM locale_messages WHERE locale_code=?',args:[code],changes:messages.length},
          {sql:'UPDATE locales SET fallback_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE fallback_code=? AND code<>?',args:[code,code],changes:dependants.length},
          {sql:'DELETE FROM locales WHERE code=?',args:[code]});
        action='locale.delete';fields=['locale','messages','fallbacks'];
        detail={removed_messages:await Promise.all(messages.map(m=>messageId(code,m.message_key))),removed_message_count:messages.length,cleared_fallbacks:dependants};
      }
    } else if(change.action==='default') {
      if(before?.content_enabled!==1)throw new LocalePolicyError('The default content language must be enabled for content','locale_default_required');
      if(settings[0]?.value!==code){finalSettings=[{key:KEY,value:code,created_at:settings[0]?.created_at??null,updated_at:null}];action='locale.default.update';fields=['default_language'];
        writes.push({sql:'INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',args:[KEY,code]});}
    } else {
      const key=change.action==='message-save'?normalizeLocaleMessageInput(code,change.key,change.value).key:String(change.key??'').trim();
      const old=messages.find(m=>m.message_key===key);target=await messageId(code,key);
      if(change.action==='message-save'){
        if(!before)throw new LocaleInputValidationError('Language does not exist');const {value}=normalizeLocaleMessageInput(code,key,change.value);
        if(old?.value!==value){const next={locale_code:code,message_key:key,value,updated_by:String(c.get('user').sub),created_at:old?.created_at??null,updated_at:null};
          finalMessages=old?messages.map(m=>m.message_key===key?next:m):[...messages,next];action='locale_message.upsert';fields=['value'];
          writes.push({sql:'INSERT INTO locale_messages(locale_code,message_key,value,updated_by) VALUES (?,?,?,?) ON CONFLICT(locale_code,message_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP',args:[code,key,value,next.updated_by]});}
      }else if(old){finalMessages=messages.filter(m=>m.message_key!==key);action='locale_message.delete';fields=['value'];
        writes.push({sql:'DELETE FROM locale_messages WHERE locale_code=? AND message_key=?',args:[code,key]});}
    }
    if(finalLocales.length>5000||finalMessages.length>5000)throw new Error('Locale manifest requires review');json(detail);
    return {
      writes,
      evidence:{entry:{action,entityType:'locale',entityId:target,detail:{fields,...detail}}},
      expect:since=>[
        resultGuard(c,'locales',LOCALE,finalLocales,since),
        resultGuard(c,'locale_messages',MESSAGE,finalMessages,since,'locale_code=?',[code]),
        resultGuard(c,'settings',SETTING,finalSettings,since,'key=?',[KEY]),
        abortIf(c.env,'NOT EXISTS (SELECT 1 FROM locales WHERE ui_enabled=1) OR NOT EXISTS (SELECT 1 FROM locales WHERE content_enabled=1)'),
      ],
    };
  });
  clearConfigCache();return code;
}
