import type { Env, JWTPayload } from '../../types';
import { generateTokenId, hashToken, signJWT, verifyJWT } from './jwt';
import type { AppContext } from '../http/context';
import { sessionAuditEnvelope, sessionAuditEvidence } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { safeRoleAuditValue } from './role-mutation-sql';
import { identityGuard } from './oauth-identity-guard';
import { sessionOperation, sessionPolicy, sessionUserGuard, sessionSnapshotCondition,
  SESSION_SNAPSHOT_COLUMNS, removeSessionSnapshots, type SessionSnapshot } from './session-evidence';

export const ACCESS_TOKEN_TTL = 15 * 60;        // 15 minutes
export const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days
export const REFRESH_ROTATION_GRACE_SECONDS = 30;
export const MAX_SESSIONS_PER_USER = 5;

/** How long a session survives with no refresh. Bounds an abandoned session
 *  without ending one that is being worked in; a deployment holding regulated
 *  data states its own policy (commonly 15–30 minutes) and must set it. */
export const SESSION_IDLE_TTL_DEFAULT = 8 * 3600; // 8 hours

/**
 * Inactivity is observed when the access token is refreshed, because that is
 * the only moment a request writes to the session row. Requests made inside an
 * access token's lifetime are invisible to the database, so the idle window
 * cannot be shorter than ACCESS_TOKEN_TTL without ending sessions that are
 * actively in use. The consequence at the floor is conservative rather than
 * permissive: a session can be refused up to ACCESS_TOKEN_TTL before its
 * nominal deadline, never after it.
 *
 * Only a refresh made on behalf of a person moves `last_activity_at`, and only
 * to when that person last acted (see activityAge). A refresh triggered by a
 * request carrying BACKGROUND_HEADER (the admin keepalive with no interaction
 * since its last report, presence polling) rotates the token but leaves the
 * idle deadline where it was.
 */
export function parseSessionIdleTtl(value: string | undefined): number | null {
  if (!/^\d{1,8}$/.test(value ?? '')) return null;
  const seconds = Number(value);
  return seconds >= ACCESS_TOKEN_TTL && seconds <= REFRESH_TOKEN_TTL ? seconds : null;
}

/** An unset or unusable value falls back to the default, which is stricter
 *  than the refresh window — a misconfiguration never widens the window. */
export function sessionIdleTtl(env: Pick<Env, 'SESSION_IDLE_TTL'>): number {
  return parseSessionIdleTtl(env.SESSION_IDLE_TTL) ?? SESSION_IDLE_TTL_DEFAULT;
}

/** SQLite modifier for the idle cutoff. The value is digits-only by construction. */
const idleCutoff = (idleTtl: number) => `-${idleTtl} seconds`;

/** Sent by scripted requests nobody asked for, so they keep a page working
 *  without counting as activity. Honest-client policy, not a security
 *  boundary: anyone holding the cookie can make a request that counts. */
export const BACKGROUND_HEADER = 'X-CMS-Background';

/** Seconds since the person last interacted with the page, sent by the admin
 *  keepalive. A tick is not the moment of activity; recording the tick time
 *  would let a session outlive its deadline by up to one keepalive interval. */
export const IDLE_FOR_HEADER = 'X-CMS-Idle-For';

/**
 * How long ago the activity behind this request happened, in seconds, or null
 * when the request carries none. A request with neither header is a person
 * acting now. An internal refresh, a background request or a malformed age is
 * no activity, so a bad value can only end a session sooner.
 */
export function activityAge(c?: AppContext): number | null {
  if (!c || c.req.header(BACKGROUND_HEADER) === '1') return null;
  const idleFor = c.req.header(IDLE_FOR_HEADER);
  if (idleFor === undefined) return 0;
  return /^\d{1,7}$/.test(idleFor) ? Number(idleFor) : null;
}

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

/** Current and previous refresh tokens must still satisfy expiry, idle and
 * ownership checks at the transaction boundary, after every signing await. */
function refreshCondition(session: RefreshSession, hash: string, idleTtl: number, tokenExpires: number, previousOnly = false) {
  return { sql: `id = ? AND user_id = ? AND ? > CAST(strftime('%s', 'now') AS INTEGER)
    AND expires_at > CURRENT_TIMESTAMP AND created_at > datetime('now', '-30 days')
    AND COALESCE(last_activity_at, created_at) > datetime('now', ?)
    AND (${previousOnly ? '0' : 'refresh_token_hash = ?'} OR (previous_refresh_token_hash = ?
      AND rotated_at >= datetime('now', '-${REFRESH_ROTATION_GRACE_SECONDS} seconds')))`,
  bindings: [session.id, session.user_id, tokenExpires, idleCutoff(idleTtl), ...(previousOnly ? [] : [hash]), hash] };
}

export async function rotateAuthSession(env: Env, refreshToken: string,
  idleTtl: number = sessionIdleTtl(env), c?: AppContext): Promise<RotateAuthSessionResult> {
  return sessionOperation(env, async () => {
    const payload = await verifyJWT(refreshToken, env.JWT_SECRET);
    if (!payload || payload.type !== 'refresh' || typeof payload.jti !== 'string') return { ok: false, error: 'invalid_refresh_token' };
    const hash = await hashToken(payload.jti);
    const session = await findRefreshSession(env.DB, hash, idleTtl);
    if (!session || String(session.user_id) !== payload.sub) return { ok: false, error: 'session_revoked' };
    const user = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(session.user_id).first<AuthDbUser>();
    if (!user) return { ok: false, error: 'user_not_found' };
    if (!safeRoleAuditValue(user.role)) throw new Error('Session role evidence unavailable');
    const policy = await sessionPolicy(env);
    const source = c ? (c.req.path === '/auth/refresh' ? 'explicit-refresh' : 'silent-refresh') : 'internal-refresh';
    const age = activityAge(c);
    const activity = age === null ? 'background' : 'user';
    const activityAt = age === null ? null : `-${age} seconds`;
    const graceAccess = async () => {
      const access = await issueAccessToken(user, env.JWT_SECRET, String(session.id));
      const condition = refreshCondition(session, hash, idleTtl, payload.exp, true);
      const envelope = sessionAuditEnvelope(c, 'auth.session.grace', user.id, user.role, session.id, policy.dataClass, { source, activity });
      const evidence = sessionAuditEvidence(env, envelope, { policy: policy.policy });
      const guard = () => abortIf(env, `NOT EXISTS (SELECT 1 FROM sessions WHERE ${condition.sql})`, condition.bindings);
      await env.DB.batch([sessionUserGuard(env, user), guard(), evidence.write, evidence.guard, sessionUserGuard(env, user), guard()]);
      return { ok: true as const, ...access };
    };
    if (session.is_previous) return graceAccess();
    const issued = await issueAuthTokens(user, env.JWT_SECRET, String(session.id));
    const newHash = await hashToken(issued.refreshJti);
    const condition = refreshCondition(session, hash, idleTtl, payload.exp);
    const snapshot = sessionSnapshotCondition(session);
    const envelope = sessionAuditEnvelope(c, 'auth.session.rotate', user.id, user.role, session.id, policy.dataClass, { source, activity });
    const evidence = sessionAuditEvidence(env, envelope, { requirePreviousChange: true, policy: policy.policy });
    try {
      await env.DB.batch([
        sessionUserGuard(env, user),
        // The idle predicate in `condition` is evaluated in this same statement,
        // so concurrent activity cannot revive a session that has already lapsed.
        // MAX keeps an older report from moving the deadline backwards.
        env.DB.prepare(`UPDATE sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = ?,
          rotated_at = CURRENT_TIMESTAMP, expires_at = MIN(datetime('now', '+7 days'), datetime(created_at, '+30 days')),
          last_activity_at = CASE WHEN ? IS NULL THEN last_activity_at
            ELSE MAX(COALESCE(last_activity_at, created_at), datetime('now', ?)) END
          WHERE ${snapshot.sql} AND (${condition.sql}) AND refresh_token_hash = ?`)
          .bind(newHash, activityAt, activityAt, ...snapshot.bindings, ...condition.bindings, hash),
        evidence.write, evidence.guard, sessionUserGuard(env, user),
        abortIf(env, `NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND refresh_token_hash = ?
          AND previous_refresh_token_hash = ? AND created_at IS ? AND rotated_at IS NOT NULL AND rotated_at <= CURRENT_TIMESTAMP
          AND expires_at > CURRENT_TIMESTAMP AND expires_at <= MIN(datetime('now', '+7 days'), datetime(created_at, '+30 days')))`,
          [session.id, user.id, newHash, hash, session.created_at]),
      ]);
    } catch (error) {
      // A different request may have won. Only take grace after verifying this
      // operation did NOT commit; a lost acknowledgment of our own commit is
      // unavailable, never automatic token reissuance or rotation replay.
      const ownReceipt = await env.DB.prepare('SELECT 1 FROM audit_events WHERE event_id = ?').bind(envelope.row.eventId!).first();
      const raced = await findRefreshSession(env.DB, hash, idleTtl);
      if (!ownReceipt && raced?.is_previous && raced.id === session.id) return graceAccess();
      throw error;
    }
    return { ok: true, accessPayload: issued.accessPayload, accessToken: issued.accessToken, refreshToken: issued.refreshToken };
  });
}

/** Logout can resolve two different sessions from its cookies. Each actual
 * removal has its own atomic outbox receipt; repeated logout is a no-op. */
export async function revokeAuthSessions(env: Env, tokens: { accessToken?: string; refreshToken?: string }, c?: AppContext): Promise<number> {
  return sessionOperation(env, async () => {
    const selected = new Map<number, SessionSnapshot>();
    for (const [type, token] of [['access', tokens.accessToken], ['refresh', tokens.refreshToken]] as const) {
      const payload = token && await verifyJWT(token, env.JWT_SECRET);
      if (!payload || payload.type !== type) continue;
      let where: string;
      let parameters: Array<string>;
      if (type === 'access') {
        if (!/^\d+$/.test(payload.sid ?? '')) continue;
        where = 's.id = ? AND s.user_id = ?'; parameters = [payload.sid!, payload.sub];
      } else {
        if (typeof payload.jti !== 'string') continue;
        const hash = await hashToken(payload.jti);
        where = 's.user_id = ? AND (s.refresh_token_hash = ? OR s.previous_refresh_token_hash = ?)'; parameters = [payload.sub, hash, hash];
      }
      const rows = await env.DB.prepare(`SELECT ${SESSION_SNAPSHOT_COLUMNS} FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE ${where}`)
        .bind(...parameters).all<SessionSnapshot>();
      for (const row of rows.results) selected.set(row.id, row);
    }
    return removeSessionSnapshots(env, [...selected.values()], c ? 'logout' : 'explicit-revocation', '1', [], c);
  });
}

export async function revokeRefreshSession(env: Env, refreshToken: string): Promise<void> {
  await revokeAuthSessions(env, { refreshToken });
}

export async function findRefreshSessionUserId(
  db: D1DatabaseClient,
  refreshJti: string,
  idleTtl: number = SESSION_IDLE_TTL_DEFAULT,
): Promise<number | null> {
  const session = await findRefreshSession(db, await hashToken(refreshJti), idleTtl);
  return session?.user_id ?? null;
}

export async function capUserSessions(env: Env, userId: number): Promise<number> {
  return sessionOperation(env, async () => {
    const predicate = 'user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?)';
    const parameters = [userId, userId, MAX_SESSIONS_PER_USER];
    const rows = await env.DB.prepare(`SELECT ${SESSION_SNAPSHOT_COLUMNS} FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? AND s.id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?) ORDER BY s.id LIMIT 50`)
      .bind(...parameters).all<SessionSnapshot>();
    return removeSessionSnapshots(env, rows.results, 'session-cap', predicate, parameters);
  });
}

/** Bounded, per-session receipts for expired/idle/absolute-lifetime cleanup.
 * Remaining rows are still denied by authorization and handled on later ticks. */
export async function purgeExpiredSessions(env: Env, idleTtl: number = sessionIdleTtl(env)): Promise<number> {
  return sessionOperation(env, async () => {
    const predicate = `expires_at <= CURRENT_TIMESTAMP OR created_at <= datetime('now', '-30 days')
      OR COALESCE(last_activity_at, created_at) <= datetime('now', ?)`;
    const rows = await env.DB.prepare(`SELECT ${SESSION_SNAPSHOT_COLUMNS} FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${predicate.replace(/\b(expires_at|created_at|last_activity_at)\b/g, 's.$1')} ORDER BY s.id LIMIT 50`).bind(idleCutoff(idleTtl)).all<SessionSnapshot>();
    return removeSessionSnapshots(env, rows.results, 'expired', predicate, [idleCutoff(idleTtl)]);
  });
}

/** Failures are already reported through the lifecycle health path; keep
 * background hygiene from becoming an unhandled request-lifetime rejection. */
export async function maintainSessionHygiene(env: Env, userId?: number): Promise<void> {
  try {
    if (userId === undefined) {
      // One over-limit account per tick/request keeps legacy or burst backlog
      // recoverable without an unbounded sweep across all accounts.
      const excess = await env.DB.prepare(`SELECT user_id FROM sessions GROUP BY user_id HAVING COUNT(*) > ? ORDER BY MIN(id) LIMIT 1`)
        .bind(MAX_SESSIONS_PER_USER).first<{ user_id: number }>();
      userId = excess?.user_id;
    }
    if (userId !== undefined) await capUserSessions(env, userId);
    await purgeExpiredSessions(env);
  }
  catch { /* Retain unprocessed sessions/evidence for recovery. */ }
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

interface RefreshSession extends SessionSnapshot { is_previous: number }

async function findRefreshSession(
  db: D1DatabaseClient,
  refreshHash: string,
  idleTtl: number,
): Promise<RefreshSession | null> {
  return db.prepare(
    `SELECT s.*, u.role,
            CASE WHEN refresh_token_hash = ?1 THEN 0 ELSE 1 END AS is_previous
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > CURRENT_TIMESTAMP AND s.created_at > datetime('now', '-30 days')
        AND COALESCE(s.last_activity_at, s.created_at) > datetime('now', ?2)
        AND (
          refresh_token_hash = ?1
          OR (
            previous_refresh_token_hash = ?1
            AND rotated_at >= datetime('now', '-${REFRESH_ROTATION_GRACE_SECONDS} seconds')
          )
        )`,
  )
    .bind(refreshHash, idleCutoff(idleTtl))
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

/** Create the session and durable sign-in evidence before returning tokens. */
export async function createAuthSession(env: Env, user: AuthDbUser, c?: AppContext,
  identity?: { provider: string; providerUserId: string; oauthId: string }): Promise<IssuedAuthTokens> {
  return sessionOperation(env, async () => {
    if (!safeRoleAuditValue(user.role)) throw new Error('Session role evidence unavailable');
    if (identity && (!['eventuai', 'github', 'google', 'microsoft', 'apple'].includes(identity.provider)
      || !identity.providerUserId || identity.oauthId !== `${identity.provider}:${identity.providerUserId}`)) throw new Error('Invalid session identity');
    const policy = await sessionPolicy(env);
    const issued = await issueAuthTokens(user, env.JWT_SECRET);
    const hash = await hashToken(issued.refreshJti);
    const envelope = sessionAuditEnvelope(c, 'auth.login', user.id, user.role, null, policy.dataClass,
      identity ? { provider: identity.provider } : { source: 'internal' });
    const evidence = sessionAuditEvidence(env, envelope, { requirePreviousChange: true, refreshHash: hash, policy: policy.policy });
    const guard = () => abortIf(env, `NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND refresh_token_hash = ?
      AND previous_refresh_token_hash IS NULL AND rotated_at IS NULL AND created_at <= CURRENT_TIMESTAMP
      AND expires_at > CURRENT_TIMESTAMP AND expires_at <= MIN(datetime('now', '+7 days'), datetime(created_at, '+30 days')))`, [user.id, hash]);
    const statements = [sessionUserGuard(env, user)];
    if (identity) statements.push(identityGuard(env, identity, user.id, true));
    statements.push(env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").bind(user.id, hash),
      evidence.write, evidence.guard, sessionUserGuard(env, user), guard());
    if (identity) statements.push(identityGuard(env, identity, user.id, true));
    statements.push(env.DB.prepare('SELECT id FROM sessions WHERE refresh_token_hash = ?').bind(hash));
    const results = await env.DB.batch(statements);
    const row = results[results.length - 1].results[0] as { id: number };
    issued.accessPayload.sid = String(row.id);
    issued.accessToken = await signJWT(issued.accessPayload, env.JWT_SECRET);
    return issued;
  });
}

/** Authorization always uses the current account, never a cached JWT role.
 *  The idle deadline applies here too: a keepalive keeps reissuing access
 *  tokens, so without it an idle session would outlive its window. */
export async function validateAccessSession(db: D1DatabaseClient, payload: JWTPayload, idleTtl: number): Promise<JWTPayload | null> {
  if (payload.type !== 'access' || !payload.sid || !/^\d+$/.test(payload.sid)
      || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  const user = await db.prepare(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.user_id = ? AND s.expires_at > CURRENT_TIMESTAMP AND s.created_at > datetime('now', '-30 days')
       AND COALESCE(s.last_activity_at, s.created_at) > datetime('now', ?)`,
  ).bind(payload.sid, payload.sub, idleCutoff(idleTtl)).first<AuthDbUser>();
  return user ? { ...payload, email: user.email, name: user.name, role: user.role } : null;
}
