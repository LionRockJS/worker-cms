import type { Env } from '../../types';
import { abortIf } from '../db/transaction-guard';

interface OAuthIdentityKey { provider: string; providerUserId: string; oauthId: string }

function identityCondition(identity: OAuthIdentityKey, userId: number) {
  return {
    sql: 'oauth_id = ? AND provider = ? AND provider_user_id = ? AND user_id = ?',
    bindings: [identity.oauthId, identity.provider, identity.providerUserId, userId],
  };
}

export function identityGuard(env: Env, identity: OAuthIdentityKey, userId: number, allowLegacy = false) {
  const condition = identityCondition(identity, userId);
  // Legacy primary keys still authenticate before identity backfill. A
  // conflicting/malformed linked row must never fall back to that legacy key.
  const legacy = allowLegacy ? `OR (EXISTS (SELECT 1 FROM users WHERE id = ? AND oauth_id = ?)
    AND NOT EXISTS (SELECT 1 FROM user_oauth_identities WHERE oauth_id = ? OR (provider = ? AND provider_user_id = ?)))` : '';
  return abortIf(env, `NOT (EXISTS (SELECT 1 FROM user_oauth_identities WHERE ${condition.sql}) ${legacy})`,
    [...condition.bindings, ...(allowLegacy ? [userId, identity.oauthId, identity.oauthId, identity.provider, identity.providerUserId] : [])]);
}

