import type { AppContext } from '../http/context';
import type { User } from '../../types';
import { classFor, resolveDataClasses, classificationPolicyGuard } from '../db/data-classes';
import { contextActor, mutationAuditEnvelope, mutationAuditEvidence } from '../db/audit';
import { auditOutboxEvidence, drainAuditMutationOutbox } from '../db/audit-mutation-outbox';
import { abortIf } from '../db/transaction-guard';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { flushReadAudit } from '../http/access-log';
import { oauthLinkSessionGuard } from './oauth-link-session';
import { safeRoleAuditValue } from './role-mutation-sql';
import { sessionIdleTtl } from './sessions';

interface Identity {
  id: number; user_id: number; provider: string; provider_user_id: string; oauth_id: string; created_at: string;
}

async function ownAccount(c: AppContext): Promise<User> {
  const actor = c.get('user');
  if (!actor || !/^\d+$/.test(actor.sub) || !/^\d+$/.test(actor.sid ?? '')) throw new Error('Current account session required');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE disabled_at IS NULL AND id = ?').bind(actor.sub).first<User>();
  if (!user || user.role !== actor.role) throw new Error('Account changed');
  return user;
}

function sessionGuard(c: AppContext) {
  const actor = c.get('user');
  return oauthLinkSessionGuard(c, { userId: Number(actor.sub), sessionId: Number(actor.sid), tokenExpiresAt: actor.exp,
    refreshHash: null, idleTtl: sessionIdleTtl(c.env) });
}

function accountGuard(c: AppContext, user: User) {
  return abortIf(c.env, `NOT EXISTS (SELECT 1 FROM users WHERE disabled_at IS NULL AND id = ? AND oauth_id IS ? AND email IS ?
    AND name IS ? AND avatar_url IS ? AND role IS ?)`, [user.id, user.oauth_id, user.email, user.name, user.avatar_url, user.role]);
}

async function classification(c: AppContext, revocation: boolean) {
  try {
    const policy = await resolveDataClasses(c.env, true);
    if (policy.ok) {
      const classes = ['users', 'user_oauth_identities', 'roles', 'role_permissions', 'sessions'].map(table => classFor(policy, 'table', table));
      return { policy, dataClass: classes.includes('phi') ? 'phi' as const : classes.includes('pii') ? 'pii' as const : 'none' as const, unavailable: false };
    }
  } catch { /* Revocation retains conservative private evidence on lookup failure. */ }
  if (!revocation) throw new Error('Profile classification unavailable');
  return { dataClass: 'phi' as const, unavailable: true };
}

/** A picture the user set themselves (upload or generated initials), stored
 * inline. Provider sign-in refreshes must not overwrite it. */
export const OWN_AVATAR_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
export const OWN_AVATAR_MAX_LENGTH = 48 * 1024;
export function isOwnAvatar(avatarUrl: string | null): boolean {
  return !!avatarUrl && avatarUrl.startsWith('data:image/');
}

/** Only the current user's display name and picture are editable through this service. */
async function updateOwnProfileField(c: AppContext, field: 'name' | 'avatar_url', value: string): Promise<void> {
  assertRegulatedWritesAllowed(c.env);
  const policy = await classification(c, false);
  const before = await ownAccount(c);
  if (!safeRoleAuditValue(before.role)) throw new Error('Profile evidence requires review');
  const refused = await flushReadAudit(c);
  if (refused) throw new Error('Protected read evidence unavailable');
  const statements = [classificationPolicyGuard(c.env, policy.policy!), sessionGuard(c), accountGuard(c, before)];
  if (value !== before[field]) {
    const evidence = mutationAuditEvidence(c, { action: 'profile.update', entityType: 'user', entityId: before.id,
      detail: { fields: [field] } }, policy.dataClass, { requirePreviousChange: true, policy: policy.policy });
    statements.push(c.env.DB.prepare(`UPDATE users SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(value, before.id),
      evidence.write, evidence.guard);
  }
  statements.push(accountGuard(c, { ...before, [field]: value }), sessionGuard(c), classificationPolicyGuard(c.env, policy.policy!));
  await c.env.DB.batch(statements);
}

export async function updateOwnProfileName(c: AppContext, name: string): Promise<void> {
  if (!name || name.length > 100 || name !== name.trim()) throw new Error('Invalid display name');
  await updateOwnProfileField(c, 'name', name);
}

/** `''` removes the picture; the next provider sign-in may then supply one. */
export async function updateOwnAvatar(c: AppContext, avatarUrl: string): Promise<void> {
  if (avatarUrl && (avatarUrl.length > OWN_AVATAR_MAX_LENGTH || !OWN_AVATAR_PATTERN.test(avatarUrl))) throw new Error('Invalid avatar');
  await updateOwnProfileField(c, 'avatar_url', avatarUrl);
}

function identitiesGuard(c: AppContext, userId: number, identities: Identity[]) {
  return abortIf(c.env, `(SELECT COUNT(*) FROM user_oauth_identities WHERE user_id = ?) <> ?
    OR EXISTS (SELECT 1 FROM user_oauth_identities i WHERE i.user_id = ? AND NOT EXISTS (
      SELECT 1 FROM json_each(?) expected WHERE i.id IS json_extract(expected.value, '$.id')
        AND i.user_id IS json_extract(expected.value, '$.user_id') AND i.provider IS json_extract(expected.value, '$.provider')
        AND i.provider_user_id IS json_extract(expected.value, '$.provider_user_id') AND i.oauth_id IS json_extract(expected.value, '$.oauth_id')
        AND i.created_at IS json_extract(expected.value, '$.created_at')))`, [userId, identities.length, userId, JSON.stringify(identities)]);
}

/** Removal and primary-key replacement share a D1 transaction with durable
 * outbox evidence. Primary audit outages cannot prevent an eligible revocation.
 * Database/outbox unavailability still prevents a safe committed mutation. */
export async function disconnectOwnIdentity(c: AppContext, identityId: number): Promise<'removed' | 'missing' | 'last-method' | 'review'> {
  if (!Number.isSafeInteger(identityId) || identityId <= 0) throw new Error('Invalid identity');
  const before = await ownAccount(c);
  const identities = (await c.env.DB.prepare(`SELECT id, user_id, provider, provider_user_id, oauth_id, created_at
    FROM user_oauth_identities WHERE user_id = ? ORDER BY created_at, id`).bind(before.id).all<Identity>()).results;
  const identity = identities.find(item => item.id === identityId);
  if (!identity) return 'missing';
  if (identities.length <= 1) return 'last-method';
  const remaining = identities.filter(item => item.id !== identityId);
  const primaryReplaced = before.oauth_id === identity.oauth_id;
  const replacement = primaryReplaced ? remaining[0] : null;
  if (replacement && (!['eventuai', 'github', 'google', 'microsoft', 'apple'].includes(replacement.provider)
    || replacement.oauth_id !== `${replacement.provider}:${replacement.provider_user_id}`)) return 'review';
  const after = { ...before, oauth_id: replacement?.oauth_id ?? before.oauth_id };
  const policy = await classification(c, true);
  const actor = contextActor(c);
  const rolesUnavailable = !safeRoleAuditValue(before.role);
  if (rolesUnavailable) actor.roles = null;
  const envelope = mutationAuditEnvelope(c, { action: 'user.oauth-disconnect', entityType: 'user_oauth_identity', entityId: identityId,
    detail: { user_id: String(before.id), primary_replaced: primaryReplaced, replacement_identity_id: replacement?.id ?? null,
      classification_unavailable: policy.unavailable, roles_unavailable: rolesUnavailable } }, 'phi', actor);
  const evidence = auditOutboxEvidence(c.env, envelope);
  const statements = [sessionGuard(c), accountGuard(c, before), identitiesGuard(c, before.id, identities)];
  if (primaryReplaced) {
    statements.push(c.env.DB.prepare('UPDATE users SET oauth_id = ? WHERE id = ?').bind(after.oauth_id, before.id), abortIf(c.env, 'changes() <> 1'));
  }
  statements.push(c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE id = ? AND user_id = ?').bind(identityId, before.id),
    evidence.write, evidence.guard, accountGuard(c, after), identitiesGuard(c, before.id, remaining), sessionGuard(c));
  await c.env.DB.batch(statements);
  // Delivery is separate; its result cannot undo or misreport the revocation.
  await drainAuditMutationOutbox(c.env, envelope.row.eventId);
  return 'removed';
}

/** Disabling retains account data while releasing all sign-in keys. The
 * revocation and durable evidence commit together, including during audit outages. */
export async function disableOwnAccount(c: AppContext): Promise<void> {
  const before = await ownAccount(c);
  const policy = await classification(c, true);
  const actor = contextActor(c);
  const rolesUnavailable = !safeRoleAuditValue(before.role);
  if (rolesUnavailable) actor.roles = null;
  const envelope = mutationAuditEnvelope(c, { action: 'user.disable', entityType: 'user', entityId: before.id,
    detail: { classification_unavailable: policy.unavailable, roles_unavailable: rolesUnavailable } }, 'phi', actor);
  const evidence = auditOutboxEvidence(c.env, envelope);
  // This namespace cannot be emitted by an OAuth provider. A random key also
  // avoids collisions with legacy primary identities.
  const retiredKey = `disabled:${crypto.randomUUID()}`;
  await c.env.DB.batch([
    sessionGuard(c), accountGuard(c, before),
    c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE user_id = ?').bind(before.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(before.id),
    c.env.DB.prepare(`UPDATE users SET disabled_at = CURRENT_TIMESTAMP, oauth_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND disabled_at IS NULL`).bind(retiredKey, before.id),
    evidence.write, evidence.guard,
    abortIf(c.env, `NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NOT NULL AND oauth_id = ?
      AND email IS ? AND name IS ? AND avatar_url IS ? AND role IS ?)
      OR EXISTS (SELECT 1 FROM user_oauth_identities WHERE user_id = ?)
      OR EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)`,
    [before.id, retiredKey, before.email, before.name, before.avatar_url, before.role, before.id, before.id]),
  ]);
  await drainAuditMutationOutbox(c.env, envelope.row.eventId);
}
