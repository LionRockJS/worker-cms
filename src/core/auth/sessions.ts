import type { JWTPayload } from '../../types';
import { generateTokenId, hashToken, signJWT, verifyJWT } from './jwt';

export const ACCESS_TOKEN_TTL = 15 * 60;        // 15 minutes
export const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days
export const REFRESH_ROTATION_GRACE_SECONDS = 30;
export const MAX_SESSIONS_PER_USER = 5;

export interface AuthDbUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

export interface IssuedAuthTokens {
  accessPayload: JWTPayload;
  accessToken: string;
  refreshToken: string;
  refreshJti: string;
}

export type RotateAuthSessionResult =
  | {
      ok: true;
      accessPayload: JWTPayload;
      accessToken: string;
      /** Omitted when a concurrent request used the just-rotated token. */
      refreshToken?: string;
    }
  | { ok: false; error: 'invalid_refresh_token' | 'session_revoked' | 'user_not_found' };

export async function issueAuthTokens(user: AuthDbUser, jwtSecret: string, sessionId?: string): Promise<IssuedAuthTokens> {
  const now = Math.floor(Date.now() / 1000);
  const refreshJti = generateTokenId();
  const accessPayload = { ...authPayload(user, 'access', now + ACCESS_TOKEN_TTL, now), sid: sessionId };
  const refreshPayload = authPayload(user, 'refresh', now + REFRESH_TOKEN_TTL, now, refreshJti);
  const [accessToken, refreshToken] = await Promise.all([
    signJWT(accessPayload, jwtSecret),
    signJWT(refreshPayload, jwtSecret),
  ]);

  return { accessPayload, accessToken, refreshToken, refreshJti };
}

export async function storeRefreshSession(db: D1DatabaseClient, userId: number, refreshJti: string): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+7 days')) RETURNING id`,
  )
    .bind(userId, await hashToken(refreshJti))
    .first<{ id: number }>();
  if (!row) throw new Error("Session creation failed");
  return row.id;
}

export async function rotateAuthSession(
  db: D1DatabaseClient,
  jwtSecret: string,
  refreshToken: string,
): Promise<RotateAuthSessionResult> {
  const refreshPayload = await verifyJWT(refreshToken, jwtSecret);
  if (!refreshPayload || refreshPayload.type !== 'refresh' || !refreshPayload.jti) {
    return { ok: false, error: 'invalid_refresh_token' };
  }

  const refreshHash = await hashToken(refreshPayload.jti);
  const session = await findRefreshSession(db, refreshHash);

  if (!session) {
    return { ok: false, error: 'session_revoked' };
  }

  const user = await db.prepare(
    'SELECT id, email, name, role FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first<AuthDbUser>();

  if (!user) {
    return { ok: false, error: 'user_not_found' };
  }

  // A request that carries the immediately previous token is a concurrent
  // refresh, not a revoked session. Give it a fresh access token but do not
  // rotate or set a refresh cookie: the winning response owns the new token.
  if (session.is_previous) {
    const access = await issueAccessToken(user, jwtSecret, String(session.id));
    return { ok: true, ...access };
  }

  const issued = await issueAuthTokens(user, jwtSecret, String(session.id));
  const update = await db.prepare(
    `UPDATE sessions
        SET previous_refresh_token_hash = refresh_token_hash,
            refresh_token_hash = ?,
            rotated_at = CURRENT_TIMESTAMP,
            expires_at = MIN(datetime('now', '+7 days'), datetime(created_at, '+30 days'))
      WHERE id = ? AND refresh_token_hash = ?`,
  )
    .bind(await hashToken(issued.refreshJti), session.id, refreshHash)
    .run();

  // Another request may have won between SELECT and UPDATE. Confirm that this
  // token is now the grace token before returning access-only success.
  if ((update.meta.changes ?? 0) === 0) {
    const racedSession = await findRefreshSession(db, refreshHash);
    if (!racedSession || !racedSession.is_previous || racedSession.id !== session.id) {
      return { ok: false, error: 'session_revoked' };
    }
    const access = await issueAccessToken(user, jwtSecret, String(session.id));
    return { ok: true, ...access };
  }

  return {
    ok: true,
    accessPayload: issued.accessPayload,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
  };
}

export async function revokeRefreshSession(
  db: D1DatabaseClient,
  jwtSecret: string,
  refreshToken: string,
): Promise<void> {
  const payload = await verifyJWT(refreshToken, jwtSecret);
  if (!payload?.jti) return;

  const refreshHash = await hashToken(payload.jti);
  await db.prepare(
    'DELETE FROM sessions WHERE refresh_token_hash = ? OR previous_refresh_token_hash = ?',
  )
    .bind(refreshHash, refreshHash)
    .run();
}

export async function findRefreshSessionUserId(
  db: D1DatabaseClient,
  refreshJti: string,
): Promise<number | null> {
  const session = await findRefreshSession(db, await hashToken(refreshJti));
  return session?.user_id ?? null;
}

export function capUserSessions(db: D1DatabaseClient, userId: number): Promise<D1Result> {
  return db.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2
     )`,
  ).bind(userId, MAX_SESSIONS_PER_USER).run();
}

export function purgeExpiredSessions(db: D1DatabaseClient): Promise<D1Result> {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
}

function authPayload(
  user: AuthDbUser,
  type: 'access' | 'refresh',
  exp: number,
  iat: number,
  jti?: string,
): JWTPayload {
  return {
    sub: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    type,
    jti,
    exp,
    iat,
  };
}

interface RefreshSession {
  id: number;
  user_id: number;
  is_previous: number;
}

async function findRefreshSession(db: D1DatabaseClient, refreshHash: string): Promise<RefreshSession | null> {
  return db.prepare(
    `SELECT id,
            user_id,
            CASE WHEN refresh_token_hash = ?1 THEN 0 ELSE 1 END AS is_previous
       FROM sessions
      WHERE expires_at > CURRENT_TIMESTAMP AND created_at > datetime('now', '-30 days')
        AND (
          refresh_token_hash = ?1
          OR (
            previous_refresh_token_hash = ?1
            AND rotated_at >= datetime('now', '-${REFRESH_ROTATION_GRACE_SECONDS} seconds')
          )
        )`,
  )
    .bind(refreshHash)
    .first<RefreshSession>();
}

async function issueAccessToken(
  user: AuthDbUser,
  jwtSecret: string,
  sessionId: string,
): Promise<Pick<IssuedAuthTokens, 'accessPayload' | 'accessToken'>> {
  const now = Math.floor(Date.now() / 1000);
  const accessPayload = { ...authPayload(user, 'access', now + ACCESS_TOKEN_TTL, now), sid: sessionId };
  return {
    accessPayload,
    accessToken: await signJWT(accessPayload, jwtSecret),
  };
}

/** Create the revocable session before issuing its access token. */
export async function createAuthSession(db: D1DatabaseClient, user: AuthDbUser, secret: string): Promise<IssuedAuthTokens> {
  const issued = await issueAuthTokens(user, secret);
  const id = await storeRefreshSession(db, user.id, issued.refreshJti);
  issued.accessPayload.sid = String(id);
  issued.accessToken = await signJWT(issued.accessPayload, secret);
  return issued;
}

/** Authorization always uses the current account, never a cached JWT role. */
export async function validateAccessSession(db: D1DatabaseClient, payload: JWTPayload): Promise<JWTPayload | null> {
  if (payload.type !== 'access' || !payload.sid || !/^\d+$/.test(payload.sid)
      || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  const user = await db.prepare(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.user_id = ? AND s.expires_at > CURRENT_TIMESTAMP AND s.created_at > datetime('now', '-30 days')`,
  ).bind(payload.sid, payload.sub).first<AuthDbUser>();
  return user ? { ...payload, email: user.email, name: user.name, role: user.role } : null;
}
