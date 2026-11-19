// Pieces every credential-authenticated plugin mutation shares: the registry/pin
// column sets, the fail-closed outage path, the unverified acting-user note,
// and the registration/credential snapshot that binds a request to the exact
// registry row and identity pin that authenticated it.

import type { AppContext } from '../../core/http/context';
import { ServiceMutationUnavailableError, type AuditActor } from '../../core/db/audit';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { resolveDataClasses, classFor, classificationPolicyGuard, strongestClass } from '../../core/db/data-classes';
import { snapshot, guard, type Row } from '../../core/db/bounded-mutation';
import { timingSafeEqualStr } from '../../core/http/crypto';
import { auditBackgroundReads } from '../../core/http/access-log';
import type { PluginAuth } from './api/types';

export const REGISTRY = ['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
export const IDENTITY = ['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];

export async function unavailable(c: AppContext, actor?: AuditActor): Promise<never> {
  await recordAuditOutage(c.env, 'health', [], actor, undefined, { captureIncomplete: true });
  throw new ServiceMutationUnavailableError();
}

/** The x-acting-user-id header is a plugin's assertion, never verified: record
 * it as such, or flag it when it is not a positive safe integer. */
export function noteActingUser(c: AppContext, detail: Record<string, unknown>): void {
  const asserted = c.req.header('x-acting-user-id');
  if (asserted === undefined) return;
  detail.acting_user_verified = false;
  const id = Number(asserted);
  if (/^\d+$/.test(asserted) && Number.isSafeInteger(id) && id > 0) detail.asserted_user_id = id;
  else detail.acting_user_unrecordable = true;
}

/** Snapshot the registry row and identity pin behind `auth` and prove they
 * still carry the credential that authenticated this request. Throws if not. */
export async function snapshotPluginCredential(c: AppContext, auth: PluginAuth) {
  const registration = auth.plugin.registration;
  if (!registration || !Number.isSafeInteger(registration.id) || registration.id <= 0) throw new Error('Missing registration identity');
  const rows = await snapshot<Row>(c, 'plugins', REGISTRY, 'id=?', [registration.id]);
  const pins = await snapshot<Row>(c, 'plugin_identity_approvals', IDENTITY, 'plugin_row_id=?', [registration.id]);
  const row = rows[0];
  if (!row || row.uuid !== registration.uuid || row.enabled !== 1 || row.url !== auth.plugin.binding || pins[0]?.manifest_id !== auth.pluginId || !row.secret
    || !timingSafeEqualStr(String(row.secret), auth.plugin.apiSecret) || !timingSafeEqualStr(String(row.secret), c.req.header('x-plugin-secret') ?? '')) throw new Error('Plugin credential changed');
  const actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: `plugin:${registration.uuid}` };
  const check = () => [guard(c, 'plugins', REGISTRY, rows, 'id=?', [registration.id]), guard(c, 'plugin_identity_approvals', IDENTITY, pins, 'plugin_row_id=?', [registration.id])];
  return { registration, rows, pins, actor, check };
}

/** Authority for a plugin's own key/value store (state, sequences): the
 * credential snapshot plus the classification of the store table. */
export async function capturePluginStoreAuthority(c: AppContext, auth: PluginAuth, table: 'plugin_state' | 'plugin_sequences', readAction: string) {
  try {
    const policy = await resolveDataClasses(c.env, true);
    if (!policy.ok) throw new Error('Store policy unavailable');
    const { registration, actor, check } = await snapshotPluginCredential(c, auth);
    const dataClass = strongestClass([...['plugins', 'plugin_identity_approvals', table].map(t => classFor(policy, 'table', t)), classFor(policy, 'plugin', auth.pluginId)]);
    await auditBackgroundReads(c.env, ['plugins', 'plugin_identity_approvals'].map(t => ({ action: readAction, kind: 'table' as const, key: t, targetType: t, ids: [String(registration.id)], count: 1, minimumClass: dataClass === 'none' ? undefined : dataClass })), actor);
    return { actor, policy, dataClass, check: () => [...check(), classificationPolicyGuard(c.env, policy)], pluginId: auth.pluginId, registryId: registration.id, uuid: registration.uuid };
  } catch { return unavailable(c); }
}
