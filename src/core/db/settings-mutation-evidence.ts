import type { AppContext } from '../http/context';
import { captureAccessAuthorization } from '../auth/access-authorization';
import { classFor,resolveDataClasses,classificationPolicyGuard } from './data-classes';
import { attributedMutationAuditEvidence,contextActor } from './audit';
import { abortIf } from './transaction-guard';
import { auditBackgroundReads,flushReadAudit } from '../http/access-log';
import { recordAuditOutage } from './audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { APP_BRANDING_SETTING_KEY,ADMIN_HOME_SETTING_KEY,SYSTEM_TIMEZONE_SETTING_KEY,SHOW_CREDITS_SETTING_KEY,SIDEBAR_MENU_SETTING_KEY } from './settings';

export const HOST_SETTINGS_KEYS=[APP_BRANDING_SETTING_KEY,ADMIN_HOME_SETTING_KEY,SYSTEM_TIMEZONE_SETTING_KEY,SHOW_CREDITS_SETTING_KEY,SIDEBAR_MENU_SETTING_KEY] as const;
type Row={key:string;value:string;created_at:string;updated_at:string};
export class SettingsMutationUnavailableError extends Error {constructor(){super('Settings change unavailable');}}
function json(value:unknown):string {
  const result=JSON.stringify(value);
  if(new TextEncoder().encode(result).length>1_000_000)throw new Error('Settings manifest requires review');
  return result;
}
async function unavailable(c:AppContext):Promise<never> {
  await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});
  throw new SettingsMutationUnavailableError();
}
/** Host system preferences only; generic saveSetting and feature writers keep
 * their own authorization/evidence contracts. Raw values never enter detail. */
export async function prepareHostSettingsMutation(c:AppContext) {
  assertRegulatedWritesAllowed(c.env);
  try {return await prepare(c);}catch {return unavailable(c);}
}
async function prepare(c:AppContext) {
  const env=c.env,user=c.get('user');
  const authority=await captureAccessAuthorization(env,user,'menu:manage');
  if(!authority.allowed)throw new Error('Settings authority unavailable');
  const policy=await resolveDataClasses(env,true);
  if(!policy.ok)throw new Error('Settings classification unavailable');
  const keys=json(HOST_SETTINGS_KEYS);
  const captured=await env.DB.prepare(`WITH scoped AS (SELECT key,value,created_at,updated_at FROM settings WHERE key IN (SELECT value FROM json_each(?))),
    budget AS (SELECT COALESCE(SUM(length(CAST(json_object('key',key,'value',value,'created_at',created_at,'updated_at',updated_at) AS BLOB))),0)+COUNT(*)+2 bytes FROM scoped)
    SELECT CASE WHEN bytes>1000000 THEN json('{') ELSE (SELECT json_group_array(json_object('key',key,'value',value,'created_at',created_at,'updated_at',updated_at)) FROM scoped) END snapshot FROM budget`).bind(keys).first<{snapshot:string}>();
  if(!captured)throw new Error('Settings snapshot unavailable');
  const rows=JSON.parse(captured.snapshot) as Row[];json(rows);
  const dataClass=classFor(policy,'table','settings')??'none';
  await auditBackgroundReads(env,[{action:'settings.mutation-read',kind:'table',key:'settings',targetType:'settings',ids:rows.map(r=>r.key),count:rows.length}],contextActor(c));
  const snapshotGuard=()=>abortIf(env,`(SELECT COUNT(*) FROM settings WHERE key IN (SELECT value FROM json_each(?)))<>?
    OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.key=json_extract(e.value,'$.key')
      AND s.value IS json_extract(e.value,'$.value') AND s.created_at IS json_extract(e.value,'$.created_at') AND s.updated_at IS json_extract(e.value,'$.updated_at')))`,[keys,rows.length,json(rows)]);
  return {
    value(key:typeof HOST_SETTINGS_KEYS[number]):string|null {return rows.find(r=>r.key===key)?.value??null;},
    async commit(writes:Array<{key:typeof HOST_SETTINGS_KEYS[number];value:string}>):Promise<void> {
      try {
        assertRegulatedWritesAllowed(env);
        if(writes.length>HOST_SETTINGS_KEYS.length||new Set(writes.map(w=>w.key)).size!==writes.length||writes.some(w=>!HOST_SETTINGS_KEYS.includes(w.key)||typeof w.value!=='string'))throw new Error('Invalid settings scope');
        json(writes);
        if(await flushReadAudit(c))throw new Error('Settings read evidence unavailable');
        const changed=writes.filter(w=>rows.find(r=>r.key===w.key)?.value!==w.value);
        const admission=[authority.guard(),classificationPolicyGuard(env,policy),snapshotGuard()];
        if(!changed.length){await env.DB.batch(admission);return;}
        const clock=await env.DB.prepare('SELECT CURRENT_TIMESTAMP AS now').first<{now:string}>();
        if(!clock)throw new Error('Settings clock unavailable');
        const receipt=attributedMutationAuditEvidence(env,user,{action:'settings.system.update',entityType:'settings',entityId:'admin.system',detail:{operation_id:crypto.randomUUID(),
          changes:changed.map(w=>({key:w.key,operation:rows.some(r=>r.key===w.key)?'update':'create'}))}},dataClass,policy,{context:c,targetIds:changed.map(w=>w.key)});
        const statements=[...admission];
        for(const write of changed)statements.push(env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(write.key,write.value),abortIf(env,'changes()<>1'));
        statements.push(receipt.write,receipt.guard,
          abortIf(env,'(SELECT COUNT(*) FROM settings WHERE key IN (SELECT value FROM json_each(?)))<>?',[keys,rows.length+changed.filter(w=>!rows.some(r=>r.key===w.key)).length]));
        for(const row of rows.filter(r=>!changed.some(w=>w.key===r.key)))statements.push(abortIf(env,'NOT EXISTS (SELECT 1 FROM settings WHERE key=? AND value IS ? AND created_at IS ? AND updated_at IS ?)',[row.key,row.value,row.created_at,row.updated_at]));
        for(const write of changed){const old=rows.find(r=>r.key===write.key);statements.push(abortIf(env,`NOT EXISTS (SELECT 1 FROM settings WHERE key=? AND value IS ? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP
          AND ${old?'created_at IS ?':'created_at>=? AND created_at<=CURRENT_TIMESTAMP'})`,[write.key,write.value,clock.now,old?.created_at??clock.now]));}
        statements.push(authority.guard(),classificationPolicyGuard(env,policy));
        await env.DB.batch(statements);
      }catch {await unavailable(c);}
    },
  };
}
