// Inactivity termination (A.8.5). A refresh window that only slides forward
// keeps an abandoned session usable for its whole lifetime; these cases pin the
// idle deadline, the floor that keeps an active session alive, and the fact
// that a never-rotated session is measured from when it was created.
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken, signJWT } from './auth-fixtures';
import {
  ACCESS_TOKEN_TTL,
  BACKGROUND_HEADER,
  IDLE_FOR_HEADER,
  REFRESH_TOKEN_TTL,
  SESSION_IDLE_TTL_DEFAULT,
  parseSessionIdleTtl,
  purgeExpiredSessions,
  rotateAuthSession,
  sessionIdleTtl,
  validateAccessSession,
  activityAge as activityAgeOf,
} from '../src/core/auth/sessions';

const HOUR = 3600;
const worker = (exports as unknown as { default: Fetcher }).default;

const sqlTime = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace('T', ' ').slice(0, 19);

/** `activityAgo` is the last activity on behalf of a person; `rotatedAgo` a
 *  later refresh that may have been background and must not count. */
async function seedSession(jti: string, activity: { createdAgo: number; activityAgo?: number; rotatedAgo?: number }): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at, created_at, rotated_at, last_activity_at)
     VALUES (1, ?1, datetime('now', '+1 day'), datetime('now', ?2), ?3, ?4) RETURNING id`,
  ).bind(
    await hashToken(jti),
    `-${activity.createdAgo} seconds`,
    activity.rotatedAgo === undefined ? null : sqlTime(activity.rotatedAgo),
    activity.activityAgo === undefined ? null : sqlTime(activity.activityAgo),
  ).first<{ id: number }>();
  if (!row) throw new Error('seed failed');
  return row.id;
}

function refreshToken(jti: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
    type: 'refresh', jti, exp: now + REFRESH_TOKEN_TTL, iat: now }, env.JWT_SECRET);
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role) VALUES (1, 'fixture:1', 'admin@example.com', 'Admin User', 'admin')
     ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
  ).run();
});

describe('session idle timeout configuration', () => {
  it('accepts a value inside the usable range', () => {
    expect(parseSessionIdleTtl('1800')).toBe(1800);
    expect(parseSessionIdleTtl(String(ACCESS_TOKEN_TTL))).toBe(ACCESS_TOKEN_TTL);
    expect(parseSessionIdleTtl(String(REFRESH_TOKEN_TTL))).toBe(REFRESH_TOKEN_TTL);
  });

  // Below the access-token lifetime the database cannot see activity, so a
  // shorter window would end sessions that are actively in use.
  it.each(['899', '0', String(REFRESH_TOKEN_TTL + 1), '-1800', 'soon', '', undefined])(
    'refuses an unusable value %j', (value) => {
      expect(parseSessionIdleTtl(value)).toBeNull();
    });

  it('falls back to the default rather than widening the window', () => {
    expect(sessionIdleTtl({})).toBe(SESSION_IDLE_TTL_DEFAULT);
    expect(sessionIdleTtl({ SESSION_IDLE_TTL: '60' })).toBe(SESSION_IDLE_TTL_DEFAULT);
    expect(sessionIdleTtl({ SESSION_IDLE_TTL: '1800' })).toBe(1800);
    expect(SESSION_IDLE_TTL_DEFAULT).toBeLessThan(REFRESH_TOKEN_TTL);
  });
});

describe('inactivity terminates a session', () => {
  it('refuses to refresh a session idle beyond its window', async () => {
    const [narrow, wide] = ['idle-beyond', 'idle-beyond-wide'];
    await seedSession(narrow, { createdAgo: 3 * HOUR, activityAgo: 2 * HOUR });
    await seedSession(wide, { createdAgo: 3 * HOUR, activityAgo: 2 * HOUR });

    const result = await rotateAuthSession(env, await refreshToken(narrow), HOUR);

    expect(result).toEqual({ ok: false, error: 'session_revoked' });
    // The same session under the old seven-day window still refreshes, so the
    // refusal above is the idle policy and not an unrelated predicate.
    expect((await rotateAuthSession(env, await refreshToken(wide), REFRESH_TOKEN_TTL)).ok).toBe(true);
  });

  it('refreshes a session used inside its window', async () => {
    const jti = 'idle-within';
    await seedSession(jti, { createdAgo: 3 * HOUR, activityAgo: 30 * 60 });

    const result = await rotateAuthSession(env, await refreshToken(jti), HOUR);

    expect(result.ok).toBe(true);
  });

  // A session with no recorded activity since sign-in has no last_activity_at.
  it('measures a session with no recorded activity from when it was created', async () => {
    const [stale, fresh] = ['never-rotated-stale', 'never-rotated-fresh'];
    await seedSession(stale, { createdAgo: 2 * HOUR });
    await seedSession(fresh, { createdAgo: 10 * 60 });

    expect(await rotateAuthSession(env, await refreshToken(stale), HOUR))
      .toEqual({ ok: false, error: 'session_revoked' });
    expect((await rotateAuthSession(env, await refreshToken(fresh), HOUR)).ok).toBe(true);
  });

  it('applies the 8-hour default when no policy is configured', async () => {
    const [abandoned, recent] = ['default-abandoned', 'default-recent'];
    await seedSession(abandoned, { createdAgo: 10 * HOUR, activityAgo: 9 * HOUR });
    await seedSession(recent, { createdAgo: 10 * HOUR, activityAgo: 7 * HOUR });

    expect(await rotateAuthSession(env, await refreshToken(abandoned), sessionIdleTtl(env)))
      .toEqual({ ok: false, error: 'session_revoked' });
    expect((await rotateAuthSession(env, await refreshToken(recent), sessionIdleTtl(env))).ok).toBe(true);
  });

  // Refusing the token ends access; removing the row ends the session.
  it('purges idle rows while keeping sessions still in use', async () => {
    await seedSession('purge-idle', { createdAgo: 3 * HOUR, activityAgo: 2 * HOUR, rotatedAgo: 60 });
    await seedSession('purge-active', { createdAgo: 3 * HOUR, activityAgo: 5 * 60 });

    await purgeExpiredSessions(env, HOUR);

    const rows = await env.DB.prepare('SELECT refresh_token_hash FROM sessions').all<{ refresh_token_hash: string }>();
    expect(rows.results.map(row => row.refresh_token_hash)).toEqual([await hashToken('purge-active')]);
  });

  it('keeps an abandoned session out of reach through the HTTP refresh route', async () => {
    const jti = 'http-idle';
    await seedSession(jti, { createdAgo: 12 * HOUR, activityAgo: 11 * HOUR });

    const response = await worker.fetch(new Request('http://localhost/auth/refresh', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: `refresh_token=${await refreshToken(jti)}`,
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': '10.9.0.1',
      },
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'session_revoked' });
  });
});

// W6: an open tab is not activity. The keepalive and presence polling refresh
// in the background; only a person's interaction moves the idle deadline, and
// only to when it happened.
describe('background refresh does not keep an idle session alive', () => {
  function refreshRequest(jti: string, token: string, headers: Record<string, string> = {}) {
    return worker.fetch(new Request('http://localhost/auth/refresh', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `refresh_token=${token}`, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '10.9.0.2', ...headers },
    }));
  }

  async function activityAge(id: number): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', last_activity_at) AS INTEGER) AS age FROM sessions WHERE id = ?",
    ).bind(id).first<{ age: number }>();
    return Number(row?.age);
  }

  it('refuses a session idle beyond its window even when recently rotated', async () => {
    await seedSession('rotated-but-idle', { createdAgo: 3 * HOUR, activityAgo: 2 * HOUR, rotatedAgo: 60 });

    expect(await rotateAuthSession(env, await refreshToken('rotated-but-idle'), HOUR))
      .toEqual({ ok: false, error: 'session_revoked' });
  });

  it('rotates on a background refresh without moving the idle deadline', async () => {
    const id = await seedSession('background', { createdAgo: 3 * HOUR, activityAgo: HOUR });

    const response = await refreshRequest('background', await refreshToken('background'), { [BACKGROUND_HEADER]: '1' });

    expect(response.status).toBe(200);
    expect(await activityAge(id)).toBeGreaterThanOrEqual(HOUR - 5);
  });

  it('records a reported interaction at when it happened, not at the refresh', async () => {
    const id = await seedSession('reported', { createdAgo: 3 * HOUR, activityAgo: HOUR });

    const response = await refreshRequest('reported', await refreshToken('reported'), { [IDLE_FOR_HEADER]: '600' });

    expect(response.status).toBe(200);
    const age = await activityAge(id);
    expect(age).toBeGreaterThanOrEqual(595);
    expect(age).toBeLessThanOrEqual(605);
  });

  it('never moves the deadline backwards for an older report', async () => {
    const id = await seedSession('older-report', { createdAgo: 3 * HOUR, activityAgo: 5 * 60 });

    expect((await refreshRequest('older-report', await refreshToken('older-report'), { [IDLE_FOR_HEADER]: String(HOUR) })).status).toBe(200);

    expect(await activityAge(id)).toBeLessThanOrEqual(5 * 60 + 5);
  });

  it('treats a malformed report as no activity', async () => {
    const id = await seedSession('malformed', { createdAgo: 3 * HOUR, activityAgo: HOUR });

    expect((await refreshRequest('malformed', await refreshToken('malformed'), { [IDLE_FOR_HEADER]: '-5' })).status).toBe(200);

    expect(await activityAge(id)).toBeGreaterThanOrEqual(HOUR - 5);
  });

  it('counts a request with no activity headers as a person acting now', async () => {
    const id = await seedSession('navigation', { createdAgo: 3 * HOUR, activityAgo: HOUR });

    expect((await refreshRequest('navigation', await refreshToken('navigation'))).status).toBe(200);

    expect(await activityAge(id)).toBeLessThanOrEqual(5);
  });

  it('records whether the rotation was background or a person', async () => {
    await seedSession('evidence', { createdAgo: 3 * HOUR, activityAgo: HOUR });
    await env.DB.prepare("DELETE FROM audit_events WHERE action = 'auth.session.rotate'").run();

    expect((await refreshRequest('evidence', await refreshToken('evidence'), { [BACKGROUND_HEADER]: '1' })).status).toBe(200);

    const row = await env.DB.prepare("SELECT detail FROM audit_events WHERE action = 'auth.session.rotate' ORDER BY seq DESC LIMIT 1")
      .first<{ detail: string }>();
    expect(JSON.parse(String(row?.detail))).toMatchObject({ source: 'explicit-refresh', activity: 'background' });
  });

  it('reads no activity from an internal refresh', () => {
    expect(activityAgeOf(undefined)).toBeNull();
  });

  // The keepalive reissues access tokens, so the access check must apply the
  // idle deadline itself rather than relying on the refresh to refuse.
  it('refuses a still-valid access token once its session is idle', async () => {
    const id = await seedSession('access-idle', { createdAgo: 10 * HOUR, activityAgo: 9 * HOUR, rotatedAgo: 60 });
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access' as const, sid: String(id), exp: now + ACCESS_TOKEN_TTL, iat: now };

    expect(await validateAccessSession(env.DB, payload, sessionIdleTtl(env))).toBeNull();
    await env.DB.prepare("UPDATE sessions SET last_activity_at = datetime('now', '-60 seconds') WHERE id = ?").bind(id).run();
    expect(await validateAccessSession(env.DB, payload, sessionIdleTtl(env))).toMatchObject({ sub: '1' });
  });
});
