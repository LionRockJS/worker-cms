import type { AppContext } from '../http/context';
import { beginAuditedMutation } from './audited-mutation';
import { json, resultGuard } from '../db/bounded-mutation';
import { APP_BRANDING_SETTING_KEY,ADMIN_HOME_SETTING_KEY,SYSTEM_TIMEZONE_SETTING_KEY,SHOW_CREDITS_SETTING_KEY,SIDEBAR_MENU_SETTING_KEY,CUSTOM_ICON_SPRITE_SETTING_KEY } from '../db/settings';

export const HOST_SETTINGS_KEYS=[APP_BRANDING_SETTING_KEY,ADMIN_HOME_SETTING_KEY,SYSTEM_TIMEZONE_SETTING_KEY,SHOW_CREDITS_SETTING_KEY,SIDEBAR_MENU_SETTING_KEY] as const;
type HostSettingKey = typeof HOST_SETTINGS_KEYS[number] | typeof CUSTOM_ICON_SPRITE_SETTING_KEY;
export type HostSettingWrite = { key: HostSettingKey; value: string };

const FIELDS = ['key','value','created_at','updated_at'];
const UPSERT = `INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`;

export class SettingsMutationUnavailableError extends Error {constructor(){super('Settings change unavailable');}}

/** Host system preferences only; generic saveSetting and feature writers keep
 * their own authorization/evidence contracts. Raw values never enter detail. */
export async function prepareHostSettingsMutation(c:AppContext, scope: readonly HostSettingKey[] = HOST_SETTINGS_KEYS) {
  const where = 'key IN (SELECT value FROM json_each(?))', args = [json(scope)];
  const mutation = await beginAuditedMutation(c, {
    permission: 'menu:manage',
    classify: [['table','settings']],
    snapshot: {
      settings: { table: 'settings', fields: FIELDS, where, args,
        read: { action: 'settings.mutation-read', kind: 'table', key: 'settings', targetType: 'settings', id: row => String(row.key) } },
    },
    unavailable: () => new SettingsMutationUnavailableError(),
  });
  const rows = mutation.rows.settings;
  return {
    value(key:HostSettingKey):string|null {return (rows.find(r=>r.key===key)?.value as string|undefined)??null;},
    async commit(writes: HostSettingWrite[]):Promise<void> {
      await mutation.commit(() => {
        if(writes.length>scope.length||new Set(writes.map(w=>w.key)).size!==writes.length||writes.some(w=>!scope.includes(w.key)||typeof w.value!=='string'))throw new Error('Invalid settings scope');
        const changed=writes.filter(w=>rows.find(r=>r.key===w.key)?.value!==w.value);
        const created=changed.filter(w=>!rows.some(r=>r.key===w.key));
        // NULL timestamps: set by this transaction (see resultGuard).
        const final=[...rows.map(r=>{const w=changed.find(w=>w.key===r.key);return w?{...r,value:w.value,updated_at:null}:r;}),
          ...created.map(w=>({key:w.key,value:w.value,created_at:null,updated_at:null}))];
        return {
          writes: changed.map(w=>({sql:UPSERT,args:[w.key,w.value]})),
          evidence: {entry:{action:'settings.system.update',entityType:'settings',entityId:'admin.system',
            detail:{changes:changed.map(w=>({key:w.key,operation:created.includes(w)?'create':'update'}))}},targetIds:changed.map(w=>w.key)},
          expect: since => [resultGuard(c,'settings',FIELDS,final,since,where,args)],
        };
      });
    },
  };
}
