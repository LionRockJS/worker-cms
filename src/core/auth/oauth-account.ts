import type { AppContext } from '../http/context';
import type { AuthDbUser } from './sessions';
import type { OAuthLinkSession } from './oauth-link-session';
import { oauthLinkSessionGuard } from './oauth-link-session';
import { identityGuard } from './oauth-identity-guard';
import { safeRoleAuditValue } from './role-mutation-sql';
import { oauthAccountAuditEvidence } from '../db/audit';
import { classFor, resolveDataClasses, classificationPolicyGuard } from '../db/data-classes';
import { abortIf } from '../db/transaction-guard';
import { isOwnAvatar } from './self-profile';

interface OAuthAccountIdentity {
  provider: string;
  providerUserId: string;
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string;
}
interface AccountSnapshot extends AuthDbUser { oauth_id: string; avatar_url: string | null; email_claimed: number }

export class OAuthIdentityConflictError extends Error {}

async function accountSnapshot(c: AppContext, userId: number, identity: OAuthAccountIdentity): Promise<AccountSnapshot> {
  const user = await c.env.DB.prepare(`SELECT u.id, u.oauth_id, u.email, u.name, u.role, u.avatar_url,
    EXISTS (SELECT 1 FROM users other WHERE other.email = ? AND other.id <> u.id) AS email_claimed
    FROM users u WHERE u.disabled_at IS NULL AND u.id = ?`).bind(identity.email, userId).first<AccountSnapshot>();
  if (!user || !safeRoleAuditValue(user.role)) throw new Error('OAuth account state unavailable');
  return user;
}

async function accountClass(c: AppContext) {
  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) throw new Error('OAuth account classification unavailable');
  const classes = ['users', 'user_oauth_identities', 'roles', 'role_permissions', 'sessions']
    .map(table => classFor(policy, 'table', table));
  return { policy, dataClass: classes.includes('phi') ? 'phi' as const : classes.includes('pii') ? 'pii' as const : 'none' as const };
}

function snapshotGuard(c: AppContext, user: AccountSnapshot) {
  return abortIf(c.env, `NOT EXISTS (SELECT 1 FROM users WHERE disabled_at IS NULL AND id = ? AND oauth_id IS ? AND email IS ?
    AND name IS ? AND avatar_url IS ? AND role IS ?)`,
  [user.id, user.oauth_id, user.email, user.name, user.avatar_url, user.role]);
}

function selectUser(c: AppContext, id: number) {
  return c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(id);
}
function batchUser(results: D1Result[]): AuthDbUser {
  const user = results[results.length - 1].results[0] as AuthDbUser | undefined;
  if (!user) throw new Error('OAuth account state unavailable');
  return user;
}

/** Explicit linking needs both a verified provider and a still-valid CMS
 * session for this same account. Repeated links validate but do not mutate. */
export async function linkOAuthIdentity(c: AppContext, identity: OAuthAccountIdentity, session: OAuthLinkSession): Promise<AuthDbUser> {
  const { policy, dataClass } = await accountClass(c);
  const user = await accountSnapshot(c, session.userId, identity);
  const existing = await c.env.DB.prepare(`SELECT user_id, provider, provider_user_id, oauth_id FROM user_oauth_identities
    WHERE oauth_id = ? OR (provider = ? AND provider_user_id = ?)`)
    .bind(identity.oauthId, identity.provider, identity.providerUserId)
    .all<{ user_id: number; provider: string; provider_user_id: string; oauth_id: string }>();
  if (existing.results.some(row => row.user_id !== user.id || row.oauth_id !== identity.oauthId
      || row.provider !== identity.provider || row.provider_user_id !== identity.providerUserId)) throw new OAuthIdentityConflictError();
  const legacyOwnerGuard = () => abortIf(c.env, 'EXISTS (SELECT 1 FROM users WHERE oauth_id = ? AND id <> ?)', [identity.oauthId, user.id]);
  const statements = [classificationPolicyGuard(c.env, policy), oauthLinkSessionGuard(c, session), snapshotGuard(c, user), legacyOwnerGuard()];
  if (!existing.results.length) {
    const audit = oauthAccountAuditEvidence(c, { action: 'user.oauth-link', entityType: 'user_oauth_identity',
      detail: { provider: identity.provider, user_id: String(user.id) } }, dataClass,
    { userId: String(user.id), roles: user.role, sessionSid: String(session.sessionId), via: `oauth:${identity.provider}` }, identity.oauthId, policy);
    statements.push(
      abortIf(c.env, 'EXISTS (SELECT 1 FROM user_oauth_identities WHERE oauth_id = ? OR (provider = ? AND provider_user_id = ?))',
        [identity.oauthId, identity.provider, identity.providerUserId]),
      c.env.DB.prepare('INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id) VALUES (?, ?, ?, ?)')
        .bind(user.id, identity.provider, identity.providerUserId, identity.oauthId),
      audit.write, audit.guard,
    );
  }
  statements.push(identityGuard(c.env, identity, user.id), snapshotGuard(c, user), legacyOwnerGuard(), oauthLinkSessionGuard(c, session), classificationPolicyGuard(c.env, policy), selectUser(c, user.id));
  return batchUser(await c.env.DB.batch(statements));
}

/** Refresh only provider-owned profile fields. The collision decision and
 * observed account/identity state are checked again inside the transaction. */
export async function updateOAuthProfile(c: AppContext, userId: number, identity: OAuthAccountIdentity): Promise<AuthDbUser> {
  const { policy, dataClass } = await accountClass(c);
  const before = await accountSnapshot(c, userId, identity);
  const after = { ...before, email: before.email_claimed ? before.email : identity.email,
    // Match SQLite trim(name): only ordinary spaces count as a missing name.
    name: /^ *$/.test(before.name) ? identity.name : before.name,
    // A picture the user chose on their profile outranks the provider's.
    avatar_url: isOwnAvatar(before.avatar_url) ? before.avatar_url : identity.avatarUrl };
  const fields = (['email', 'name', 'avatar_url'] as const).filter(field => before[field] !== after[field]);
  const statements = [classificationPolicyGuard(c.env, policy), snapshotGuard(c, before), identityGuard(c.env, identity, userId, true),
    abortIf(c.env, '(SELECT EXISTS (SELECT 1 FROM users WHERE email = ? AND id <> ?)) <> ?',
      [identity.email, userId, before.email_claimed])];
  if (fields.length) {
    const audit = oauthAccountAuditEvidence(c, { action: 'user.oauth-profile', entityType: 'user', entityId: userId,
      detail: { provider: identity.provider, fields } }, dataClass,
    { userId: String(userId), roles: before.role, sessionSid: null, via: `oauth:${identity.provider}` }, undefined, policy);
    statements.push(c.env.DB.prepare('UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?')
      .bind(after.email, after.name, after.avatar_url, userId), audit.write, audit.guard);
  }
  statements.push(snapshotGuard(c, after), identityGuard(c.env, identity, userId, true), classificationPolicyGuard(c.env, policy), selectUser(c, userId));
  return batchUser(await c.env.DB.batch(statements));
}
