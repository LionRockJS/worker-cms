// Inactivity termination (A.8.5). A refresh window that only slides forward
// keeps an abandoned session usable for its whole lifetime; these cases pin the
// idle deadline, the floor that keeps an active session alive, and the fact
// that a never-rotated session is measured from when it was created.
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken, signJWT } from './auth-fixtures';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  SESSION_IDLE_TTL_DEFAULT,
  parseSessionIdleTtl,
  purgeExpiredSessions,
  rotateAuthSession,
  sessionIdleTtl,
} from '../src/core/auth/sessions';

const HOUR = 3600;
const worker = (exports as unknown as { default: Fetcher }).default;

async function seedSession(jti: string, activity: { createdAgo: number; rotatedAgo?: number }): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at, created_at, rotated_at)
     VALUES (1, ?1, datetime('now', '+1 day'), datetime('now', ?2), ?3) RETURNING id`,
  ).bind(
    await hashToken(jti),
    `-${activity.createdAgo} seconds`,
    activity.rotatedAgo === undefined ? null : new Date(Date.now() - activity.rotatedAgo * 1000).toISOString().replace('T', ' ').slice(0, 19),
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
    await seedSession(narrow, { createdAgo: 3 * HOUR, rotatedAgo: 2 * HOUR });
    await seedSession(wide, { createdAgo: 3 * HOUR, rotatedAgo: 2 * HOUR });

    const result = await rotateAuthSession(env, await refreshToken(narrow), HOUR);

    expect(result).toEqual({ ok: false, error: 'session_revoked' });
    // The same session under the old seven-day window still refreshes, so the
    // refusal above is the idle policy and not an unrelated predicate.
    expect((await rotateAuthSession(env, await refreshToken(wide), REFRESH_TOKEN_TTL)).ok).toBe(true);
  });

  it('refreshes a session used inside its window', async () => {
    const jti = 'idle-within';
    await seedSession(jti, { createdAgo: 3 * HOUR, rotatedAgo: 30 * 60 });

    const result = await rotateAuthSession(env, await refreshToken(jti), HOUR);

    expect(result.ok).toBe(true);
  });

  // A session that signed in and was never refreshed has no rotated_at.
  it('measures a never-rotated session from when it was created', async () => {
    const [stale, fresh] = ['never-rotated-stale', 'never-rotated-fresh'];
    await seedSession(stale, { createdAgo: 2 * HOUR });
    await seedSession(fresh, { createdAgo: 10 * 60 });

    expect(await rotateAuthSession(env, await refreshToken(stale), HOUR))
      .toEqual({ ok: false, error: 'session_revoked' });
    expect((await rotateAuthSession(env, await refreshToken(fresh), HOUR)).ok).toBe(true);
  });

  it('applies the 8-hour default when no policy is configured', async () => {
    const [abandoned, recent] = ['default-abandoned', 'default-recent'];
    await seedSession(abandoned, { createdAgo: 10 * HOUR, rotatedAgo: 9 * HOUR });
    await seedSession(recent, { createdAgo: 10 * HOUR, rotatedAgo: 7 * HOUR });

    expect(await rotateAuthSession(env, await refreshToken(abandoned), sessionIdleTtl(env)))
      .toEqual({ ok: false, error: 'session_revoked' });
    expect((await rotateAuthSession(env, await refreshToken(recent), sessionIdleTtl(env))).ok).toBe(true);
  });

  // Refusing the token ends access; removing the row ends the session.
  it('purges idle rows while keeping sessions still in use', async () => {
    await seedSession('purge-idle', { createdAgo: 3 * HOUR, rotatedAgo: 2 * HOUR });
    await seedSession('purge-active', { createdAgo: 3 * HOUR, rotatedAgo: 5 * 60 });

    await purgeExpiredSessions(env, HOUR);

    const rows = await env.DB.prepare('SELECT refresh_token_hash FROM sessions').all<{ refresh_token_hash: string }>();
    expect(rows.results.map(row => row.refresh_token_hash)).toEqual([await hashToken('purge-active')]);
  });

  it('keeps an abandoned session out of reach through the HTTP refresh route', async () => {
    const jti = 'http-idle';
    await seedSession(jti, { createdAgo: 12 * HOUR, rotatedAgo: 11 * HOUR });

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
