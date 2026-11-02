import type { AppContext } from '../http/context';
import type { AuthDbUser } from './sessions';
import { registrationAuditEvidence } from '../db/audit';
import { classFor, resolveDataClasses } from '../db/data-classes';
import { abortIf } from '../db/transaction-guard';

interface RegistrationIdentity {
  provider: string;
  providerUserId: string;
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string;
}

/** Account, initial role, provider identity and creation evidence commit
 * together. Call only after OAuth verification and registration admission.
 * A transport failure may be post-commit; never automatically replay it. */
export async function registerOAuthUser(c: AppContext, identity: RegistrationIdentity): Promise<AuthDbUser> {
  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) throw new Error('Registration classification unavailable');
  const classes = ['users', 'user_oauth_identities', 'roles', 'role_permissions']
    .map(table => classFor(policy, 'table', table));
  const dataClass = classes.includes('phi') ? 'phi' : classes.includes('pii') ? 'pii' : 'none';
  const audit = registrationAuditEvidence(c, identity.oauthId, identity.provider, dataClass, policy);
  const db = c.env.DB;
  const results = await db.batch([
    // Never adopt an orphan identity or overwrite an account on callback retry.
    abortIf(c.env, `EXISTS (SELECT 1 FROM user_oauth_identities WHERE oauth_id = ?
      OR (provider = ? AND provider_user_id = ?))`, [identity.oauthId, identity.provider, identity.providerUserId]),
    db.prepare(`INSERT INTO users (oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, 'viewer')`)
      .bind(identity.oauthId, identity.email, identity.name, identity.avatarUrl),
    abortIf(c.env, 'changes() <> 1'),
    db.prepare(`INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
      SELECT id, ?, ?, ? FROM users WHERE oauth_id = ? AND role = 'viewer'`)
      .bind(identity.provider, identity.providerUserId, identity.oauthId, identity.oauthId),
    audit.write,
    audit.guard,
    // Check the final state too: ignored inserts and later audit/identity
    // triggers must not leave misleading successful creation evidence.
    abortIf(c.env, `NOT EXISTS (SELECT 1 FROM users u JOIN user_oauth_identities i ON i.user_id = u.id
      WHERE u.oauth_id = ? AND u.email = ? AND u.name = ? AND u.avatar_url = ? AND u.role = 'viewer'
        AND i.oauth_id = ? AND i.provider = ? AND i.provider_user_id = ?)`,
    [identity.oauthId, identity.email, identity.name, identity.avatarUrl,
      identity.oauthId, identity.provider, identity.providerUserId]),
    db.prepare('SELECT id, email, name, role FROM users WHERE oauth_id = ?').bind(identity.oauthId),
  ]);
  const user = results[results.length - 1].results[0] as AuthDbUser | undefined;
  if (!user) throw new Error('Registration state unavailable');
  return user;
}
