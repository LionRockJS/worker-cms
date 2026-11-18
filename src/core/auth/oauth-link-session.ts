import type { AppContext } from '../http/context';
import { accessCookieName, readAuthCookie, refreshCookieName } from './cookies';
import { hashToken, verifyJWT } from './jwt';
import { REFRESH_ROTATION_GRACE_SECONDS, sessionIdleTtl } from './sessions';
import { abortIf } from '../db/transaction-guard';

export interface OAuthLinkSession {
  userId: number;
  sessionId: number;
  tokenExpiresAt: number;
  refreshHash: string | null;
  idleTtl: number;
}

function sessionCondition(session: Omit<OAuthLinkSession, 'sessionId'> & { sessionId: number | null }) {
  return {
    sql: `EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.disabled_at IS NULL)
      AND s.user_id = ? AND (? IS NULL OR s.id = ?) AND ? > CAST(strftime('%s', 'now') AS INTEGER)
      AND s.expires_at > CURRENT_TIMESTAMP AND s.created_at > datetime('now', '-30 days')
      AND (? IS NULL OR (COALESCE(s.rotated_at, s.created_at) > datetime('now', ?)
        AND (s.refresh_token_hash = ? OR (s.previous_refresh_token_hash = ?
          AND s.rotated_at >= datetime('now', '-${REFRESH_ROTATION_GRACE_SECONDS} seconds')))))`,
    bindings: [session.userId, session.sessionId, session.sessionId, session.tokenExpiresAt,
      session.refreshHash, `-${session.idleTtl} seconds`, session.refreshHash, session.refreshHash],
  };
}

/** Read-only verification: linking never renews session activity or rotates
 * tokens. Carry this proof into the link transaction and recheck it there. */
export async function currentOAuthLinkSession(c: AppContext): Promise<OAuthLinkSession | null> {
  for (const name of [accessCookieName, refreshCookieName]) {
    const token = readAuthCookie(c, name);
    const payload = token && await verifyJWT(token, c.env.JWT_SECRET);
    if (!payload || (name === accessCookieName ? payload.type !== 'access' : payload.type !== 'refresh' || !payload.jti)) continue;
    const userId = Number(payload.sub);
    const sessionId = name === accessCookieName ? Number(payload.sid) : null;
    if (!Number.isSafeInteger(userId) || userId <= 0 || (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId <= 0))) continue;
    const proof = { userId, sessionId, tokenExpiresAt: payload.exp,
      refreshHash: name === refreshCookieName ? await hashToken(payload.jti!) : null, idleTtl: sessionIdleTtl(c.env) };
    const condition = sessionCondition(proof);
    const session = await c.env.DB.prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${condition.sql}`)
      .bind(...condition.bindings).first<{ id: number }>();
    if (session) return { ...proof, sessionId: session.id };
  }
  return null;
}

/** Recheck both before and after linking, in its business/evidence batch. */
export function oauthLinkSessionGuard(c: AppContext, session: OAuthLinkSession): D1PreparedStatement {
  const condition = sessionCondition(session);
  return abortIf(c.env, `NOT EXISTS (SELECT 1 FROM sessions s WHERE ${condition.sql})`, condition.bindings);
}
