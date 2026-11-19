import type { AppContext } from '../../core/http/context';
import { serviceMutationAuditEvidence, servicePlannedMutationAuditEvidence } from '../../core/db/audit';
import { fingerprint } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { capturePluginStoreAuthority, noteActingUser, unavailable } from './evidence-common';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { MAX_SEQUENCES_PER_PLUGIN, isValidSequenceKey } from './sequences';
import type { PluginAuth } from './api/types';

const authorityBrand = Symbol('plugin-sequence-authority');
/** Bind the request to the registration and dedicated credential that actually
 * authenticated it. A later pin/secret/registration cannot rebind this call. */
export async function capturePluginSequenceAuthority(c: AppContext, auth: PluginAuth) {
  return { [authorityBrand]: true as const, ...await capturePluginStoreAuthority(c, auth, 'plugin_sequences', 'plugin.sequence-authority-read') };
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
    noteActingUser(c, detail);
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
