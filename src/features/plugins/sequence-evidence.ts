import type { AppContext } from '../../core/http/context';
import { serviceMutationAuditEvidence, servicePlannedMutationAuditEvidence, ServiceMutationUnavailableError, type AuditActor } from '../../core/db/audit';
import { resolveDataClasses, classFor, classificationPolicyGuard } from '../../core/db/data-classes';
import { snapshot, guard, fingerprint, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { timingSafeEqualStr } from '../../core/http/crypto';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { MAX_SEQUENCES_PER_PLUGIN, isValidSequenceKey } from './sequences';
import type { PluginAuth } from './api/types';

const REGISTRY = ['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
const IDENTITY = ['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const authorityBrand = Symbol('plugin-sequence-authority');
async function unavailable(c: AppContext, actor?: AuditActor): Promise<never> {
  await recordAuditOutage(c.env, 'health', [], actor, undefined, { captureIncomplete: true });
  throw new ServiceMutationUnavailableError();
}
/** Bind the request to the registration and dedicated credential that actually
 * authenticated it. A later pin/secret/registration cannot rebind this call. */
export async function capturePluginSequenceAuthority(c: AppContext, auth: PluginAuth) {
  try {
    const registration = auth.plugin.registration;
    if (!registration || !Number.isSafeInteger(registration.id) || registration.id <= 0) throw new Error('Missing registration identity');
    const policy = await resolveDataClasses(c.env, true);
    if (!policy.ok) throw new Error('Sequence policy unavailable');
    const rows = await snapshot<Row>(c, 'plugins', REGISTRY, 'id=?', [registration.id]);
    const pins = await snapshot<Row>(c, 'plugin_identity_approvals', IDENTITY, 'plugin_row_id=?', [registration.id]);
    const row = rows[0], pin = pins[0];
    if (!row || row.uuid !== registration.uuid || row.enabled !== 1 || row.url !== auth.plugin.binding || pin?.manifest_id !== auth.pluginId || !row.secret
      || !timingSafeEqualStr(String(row.secret), auth.plugin.apiSecret) || !timingSafeEqualStr(String(row.secret), c.req.header('x-plugin-secret') ?? '')) throw new Error('Sequence credential changed');
    const actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: `plugin:${registration.uuid}` };
    const classes = ['plugins','plugin_identity_approvals','plugin_sequences'].map(table => classFor(policy, 'table', table));
    classes.push(classFor(policy, 'plugin', auth.pluginId));
    const dataClass = classes.includes('phi') ? 'phi' as const : classes.includes('pii') ? 'pii' as const : 'none' as const;
    await auditBackgroundReads(c.env, ['plugins','plugin_identity_approvals'].map(table => ({ action: 'plugin.sequence-authority-read', kind: 'table' as const, key: table, targetType: table, ids: [String(registration.id)], count: 1, minimumClass: dataClass === 'none' ? undefined : dataClass })), actor);
    const check = () => [guard(c, 'plugins', REGISTRY, rows, 'id=?', [registration.id]), guard(c, 'plugin_identity_approvals', IDENTITY, pins, 'plugin_row_id=?', [registration.id]), classificationPolicyGuard(c.env, policy)];
    return { [authorityBrand]: true as const, actor, policy, dataClass, check, pluginId: auth.pluginId, registryId: registration.id, uuid: registration.uuid };
  } catch { return unavailable(c); }
}
type Authority = Awaited<ReturnType<typeof capturePluginSequenceAuthority>>;

/** Every issued number is a transaction-time plan in the primary audit stream.
 * No stale value/catalogue CAS: ordinary concurrent increments all serialize.
 * No retry after an uncertain D1 acknowledgment: a committed number stays used. */
export async function advancePluginSequence(c: AppContext, authority: Authority, key: string): Promise<number | 'too_many_sequences'> {
  assertRegulatedWritesAllowed(c.env);
  try {
    if (!authority?.[authorityBrand] || !isValidSequenceKey(key)) throw new Error('Invalid sequence mutation');
    const { actor, policy, dataClass, pluginId, registryId, uuid } = authority;
    const keyFingerprint = await fingerprint(key);
    const detail: Record<string, unknown> = { operation_id: crypto.randomUUID(), registry_id: registryId,
      identity_fingerprint: await fingerprint(pluginId), key_fingerprint: keyFingerprint, principal: 'credential_authenticated_plugin', fields: ['value'], increment: 1 };
    const asserted = c.req.header('x-acting-user-id');
    if (asserted !== undefined) {
      const id = Number(asserted); detail.acting_user_verified = false;
      if (/^\d+$/.test(asserted) && Number.isSafeInteger(id) && id > 0) detail.asserted_user_id = id;
      else detail.acting_user_unrecordable = true;
    }
    await auditBackgroundReads(c.env, [{ action: 'plugin.sequence-mutation-source-read', kind: 'table', key: 'plugin_sequences', targetType: 'plugin_sequence', ids: [keyFingerprint], count: 1, minimumClass: dataClass === 'none' ? undefined : dataClass }], actor);
    // Only choose the refusal path here. The authoritative cap and numerical
    // checks run inside the batch, including a race for the last namespace slot.
    const quota = await c.env.DB.prepare('SELECT NOT EXISTS(SELECT 1 FROM plugin_sequences WHERE plugin_id=? AND key=?) AND (SELECT COUNT(*) FROM plugin_sequences WHERE plugin_id=?)>=? AS at_limit').bind(pluginId, key, pluginId, MAX_SEQUENCES_PER_PLUGIN).first<{ at_limit: number }>();
    if (!quota || await flushReadAudit(c)) throw new Error('Sequence source evidence unavailable');
    const entry = { action: 'plugin.sequence.advance', entityType: 'plugin_sequence', entityId: `${uuid}:sequence:${keyFingerprint}`, detail };
    const atCap = 'NOT EXISTS(SELECT 1 FROM plugin_sequences WHERE plugin_id=? AND key=?) AND (SELECT COUNT(*) FROM plugin_sequences WHERE plugin_id=?)>=?';
    const capArgs = [pluginId, key, pluginId, MAX_SEQUENCES_PER_PLUGIN];
    if (quota.at_limit) {
      const refusal = serviceMutationAuditEvidence(c.env, { ...entry, outcome: 'denied', detail: { ...detail, reason: 'sequence_key_limit', max_sequences: MAX_SEQUENCES_PER_PLUGIN } }, actor, dataClass, policy, c);
      await c.env.DB.batch([...authority.check(), abortIf(c.env, `NOT (${atCap})`, capArgs), refusal.write, refusal.guard,
        abortIf(c.env, `NOT (${atCap})`, capArgs), ...authority.check()]);
      return 'too_many_sequences';
    }
    const clock = await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{ now: string }>();
    if (!clock) throw new Error('Clock unavailable');
    const receipt = servicePlannedMutationAuditEvidence(c.env, entry, actor, dataClass, policy, c, eventId => {
      const saved = (field: string) => `json_extract((SELECT detail FROM audit_events WHERE event_id=?),'$.${field}')`;
      const source = 'FROM (SELECT 1) LEFT JOIN plugin_sequences s ON s.plugin_id=? AND s.key=?';
      return {
        write: { sql: `SELECT json_object('value_before',COALESCE(s.value,0),'value_after',COALESCE(s.value,0)+1,'created_at',COALESCE(s.created_at,CURRENT_TIMESTAMP),'advanced_at',CURRENT_TIMESTAMP) ${source}`, bindings: [pluginId, key] },
        // Read the saved clock rather than re-evaluating CURRENT_TIMESTAMP on
        // a later statement, which may cross a whole-second boundary.
        before: { sql: `SELECT json_object('value_before',COALESCE(s.value,0),'value_after',COALESCE(s.value,0)+1,'created_at',COALESCE(s.created_at,${saved('created_at')}),'advanced_at',${saved('advanced_at')}) ${source}`, bindings: [eventId, eventId, pluginId, key] },
        after: { sql: "SELECT json_object('value_before',value-1,'value_after',value,'created_at',created_at,'advanced_at',updated_at) FROM plugin_sequences WHERE plugin_id=? AND key=?", bindings: [pluginId, key] },
      };
    });
    const stamp = (field: string) => `json_extract(detail,'$.${field}')`;
    const results = await c.env.DB.batch<{ value?: number }>([...authority.check(), abortIf(c.env, atCap, capArgs),
      abortIf(c.env, "EXISTS(SELECT 1 FROM plugin_sequences WHERE plugin_id=? AND key=? AND (typeof(value)<>'integer' OR value<0 OR value>=?))", [pluginId, key, Number.MAX_SAFE_INTEGER]),
      receipt.write, receipt.guard,
      abortIf(c.env, `NOT EXISTS(SELECT 1 FROM audit_events WHERE event_id=? AND ${stamp('advanced_at')}>=? AND ${stamp('advanced_at')}<=CURRENT_TIMESTAMP AND ${stamp('created_at')} IS NOT NULL AND (EXISTS(SELECT 1 FROM plugin_sequences WHERE plugin_id=? AND key=?) OR (${stamp('created_at')}>=? AND ${stamp('created_at')}<=CURRENT_TIMESTAMP)))`, [receipt.eventId, clock.now, pluginId, key, clock.now]),
      ...authority.check(),
      c.env.DB.prepare(`INSERT INTO plugin_sequences(plugin_id,key,value,created_at,updated_at)
        SELECT ?,?,${stamp('value_after')},${stamp('created_at')},${stamp('advanced_at')} FROM audit_events WHERE event_id=?
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at RETURNING value`).bind(pluginId, key, receipt.eventId),
      abortIf(c.env, 'changes()<>1'), receipt.finalGuard, ...authority.check()]);
    // RETURNING is from the counter statement, not D1 meta.changes. The final
    // exact receipt check has already proved its value and metadata persisted.
    const issued = results.flatMap(result => result.results ?? []).filter(row => row.value !== undefined);
    if (issued.length !== 1 || !Number.isSafeInteger(issued[0].value) || Number(issued[0].value) <= 0) throw new Error('Sequence result unavailable');
    return Number(issued[0].value);
  } catch { return unavailable(c, authority?.actor); }
}
