import type { AppContext } from '../../core/http/context';
import type { AuditEntry } from '../../core/db/audit';
import { guard, resultGuard, fingerprint } from '../../core/db/bounded-mutation';
import { beginServiceAuditedMutation } from '../../core/evidence/audited-mutation';
import { capturePluginStoreAuthority, noteActingUser, unavailable } from './evidence-common';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { MAX_STATE_KEYS_PER_PLUGIN, MAX_STATE_VALUE_BYTES, isValidStateKey, stateValueBytes } from './state';
import type { PluginAuth } from './api/types';

const ENTRY=['plugin_id','key','value','created_at','updated_at'];
const CATALOGUE=['plugin_id','key','created_at','updated_at'];
const authorityBrand=Symbol('plugin-state-authority');
/** Capture immediately after credential authentication, BEFORE waiting for the
 * request body. A later pin/credential/registration cannot rebind this request. */
export async function capturePluginStateAuthority(c:AppContext,auth:PluginAuth){
  return {[authorityBrand]:true as const,...await capturePluginStoreAuthority(c,auth,'plugin_state','plugin.state-authority-read')};
}
type Authority=Awaited<ReturnType<typeof capturePluginStateAuthority>>;
/** Point mutations guard the exact selected value and the namespace key/
 * timestamp catalogue, without loading every other opaque value into memory. */
export async function mutatePluginState(c: AppContext, authority: Authority, key: string, value?: string): Promise<'ok' | 'too_many_keys'> {
  assertRegulatedWritesAllowed(c.env);
  try {
    if (!authority?.[authorityBrand] || !isValidStateKey(key) ||
        (value !== undefined && stateValueBytes(value) > MAX_STATE_VALUE_BYTES)) throw new Error('Invalid state mutation');
    if (value !== undefined) JSON.parse(value);
    const { pluginId, registryId, uuid, dataClass } = authority;
    const namespaceWhere = 'plugin_id=?', namespaceArgs = [pluginId];
    const entryWhere = 'plugin_id=? AND key=?', entryArgs = [pluginId, key];
    const mutation = await beginServiceAuditedMutation(c, {
      classify: dataClass === 'none' ? [] : [dataClass],
      snapshot: {
        catalogue: {
          table: 'plugin_state', fields: CATALOGUE, where: namespaceWhere, args: namespaceArgs,
          read: {
            action: 'plugin.state-mutation-source-read', kind: 'table', key: 'plugin_state',
            targetType: 'plugin_state_catalogue', id: row => fingerprint(String(row.key)),
          },
        },
        selected: { table: 'plugin_state', fields: ENTRY, where: entryWhere, args: entryArgs, read: null },
      },
    }, authority);
    const { catalogue, selected } = mutation.rows;
    const before = selected[0];
    const denied = value !== undefined && !before && catalogue.length >= MAX_STATE_KEYS_PER_PLUGIN;
    await mutation.commit(async () => {
      const noChange = value === undefined ? !before : before?.value === value;
      if (noChange) return { groups: [], expect: [] };

      const keyFingerprint = await fingerprint(key);
      const detail: Record<string, unknown> = {
        registry_id: registryId, identity_fingerprint: await fingerprint(pluginId), key_fingerprint: keyFingerprint,
        principal: 'credential_authenticated_plugin', fields: value === undefined ? ['entry'] : ['value'],
      };
      noteActingUser(c, detail);
      const entry: AuditEntry = {
        action: value === undefined ? 'plugin.state.delete' : 'plugin.state.put',
        entityType: 'plugin_state', entityId: `${uuid}:state:${keyFingerprint}`, detail,
      };
      if (denied) {
        return {
          groups: [{
            evidence: {
              entry: { ...entry, outcome: 'denied', detail: { ...detail, reason: 'state_key_limit', max_keys: MAX_STATE_KEYS_PER_PLUGIN } },
              dataClass,
            },
          }],
          expect: [
            guard(c, 'plugin_state', CATALOGUE, catalogue, namespaceWhere, namespaceArgs),
            guard(c, 'plugin_state', ENTRY, selected, entryWhere, entryArgs),
          ],
        };
      }
      const expected = value === undefined ? [] : [
        { plugin_id: pluginId, key, value, created_at: before?.created_at ?? null, updated_at: null },
      ];
      const expectedCatalogue = [
        ...catalogue.filter(row => row.key !== key),
        ...expected.map(({ plugin_id, key, created_at, updated_at }) => ({ plugin_id, key, created_at, updated_at })),
      ];
      const write = value === undefined
        ? { sql: `DELETE FROM plugin_state WHERE ${entryWhere}`, args: entryArgs }
        : {
          sql: `INSERT INTO plugin_state(plugin_id,key,value) VALUES (?,?,?)
                ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
          args: [pluginId, key, value],
        };
      return {
        groups: [{ writes: [write], evidence: { entry, dataClass } }],
        expect: since => [
          resultGuard(c, 'plugin_state', ENTRY, expected, since, entryWhere, entryArgs),
          resultGuard(c, 'plugin_state', CATALOGUE, expectedCatalogue, since, namespaceWhere, namespaceArgs),
        ],
      };
    });
    return denied ? 'too_many_keys' : 'ok';
  } catch {
    return unavailable(c, authority?.actor);
  }
}
