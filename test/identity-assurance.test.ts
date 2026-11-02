// W9 identity, access and cryptography acceptance (A.5.16, A.5.17, A.5.18,
// A.8.2, A.8.5, A.8.24). The individual guards are tested where they live;
// these cases cover what the W9 assessment found untested: JWT header and
// token-type confusion, the joiner/mover/leaver path as one sequence, and what
// a JWT_SECRET rotation does to every outstanding token.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { createAuthSession, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { verifyJWT } from '../src/core/auth/jwt';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { Env } from '../src/types';

const user = { id: 9901, email: 'identity-assurance@example.invalid', name: 'Identity assurance', role: 'admin' };
const ROTATED_SECRET = 'rotated-identity-assurance-secret-0123456789abcdef';
let issued: IssuedAuthTokens;
let requestNumber = 0;

beforeEach(async () => {
  clearRolePermissionsCache();
  for (const table of ['audit_mutation_outbox', 'sessions', 'user_oauth_identities']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // A second administrator keeps the last-admin guard out of these cases.
  await env.DB.prepare(`INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?), (9902, 'fixture:other-admin', 'other-admin@example.invalid', 'Other admin', 'admin')
    ON CONFLICT(id) DO UPDATE SET role = excluded.role`)
    .bind(user.id, 'fixture:identity-assurance', user.email, user.name, user.role).run();
  issued = await createAuthSession(env, user);
});

async function request(path: string, cookie: string, overrides: Partial<Env> = {}, method = 'GET') {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    method,
    headers: { Cookie: cookie, Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': `10.99.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const access = (token: string) => `__Host-access_token=${token}`;
const refresh = (token: string) => `__Host-refresh_token=${token}`;

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Re-signs the issued access token's claims under an arbitrary header. */
async function withHeader(header: Record<string, unknown>, sign: boolean): Promise<string> {
  const claims = issued.accessPayload;
  const input = `${encode(header)}.${encode(claims)}`;
  if (!sign) return `${input}.`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
  return `${input}.${btoa(String.fromCharCode(...signature)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}

describe('token confusion', () => {
  it('accepts the issued access token, as the baseline for the refusals below', async () => {
    expect((await request('/admin/users', access(issued.accessToken))).status).toBe(200);
  });

  it.each([
    ['an unsigned alg:none token', { alg: 'none', typ: 'JWT' }, false],
    ['an HS512 header over an HS256 signature', { alg: 'HS512', typ: 'JWT' }, true],
    ['a header with no typ', { alg: 'HS256' }, true],
  ])('refuses %s', async (_label, header, sign) => {
    const token = await withHeader(header, sign);
    expect(await verifyJWT(token, env.JWT_SECRET)).toBeNull();
    expect((await request('/admin/users', access(token))).status).toBe(401);
  });

  // Every token type is signed with the same secret, so the type claim is all
  // that stops a refresh or OAuth-state token from acting as an access token.
  it('refuses a refresh token presented as the access token', async () => {
    expect((await request('/admin/users', access(issued.refreshToken))).status).toBe(401);
  });
});

describe('joiner, mover, leaver', () => {
  // Joiner: registration always creates a viewer; see registration-mutation-audit.test.ts.

  it('applies a role change to an existing access token on its next request', async () => {
    expect((await request('/admin/users', access(issued.accessToken))).status).toBe(200);

    await env.DB.prepare("UPDATE users SET role = 'editor' WHERE id = ?").bind(user.id).run();

    // The token still says admin; authorization reads the current account.
    expect((await request('/admin/users', access(issued.accessToken))).status).toBe(403);
    expect((await request('/admin/api/parent-pages', access(issued.accessToken))).status).toBe(200);
  });

  it('refuses every outstanding token once the account is removed', async () => {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

    expect((await request('/admin/users', access(issued.accessToken))).status).toBe(401);
    expect((await request('/auth/refresh', refresh(issued.refreshToken), {}, 'POST')).status).toBe(401);
  });
});

describe('JWT_SECRET rotation', () => {
  // The documented procedure: put a new secret, and every access, refresh and
  // OAuth-state token signed with the old one stops working at once. Sessions
  // signed before the rotation cannot be refreshed back to life.
  it('refuses tokens signed with the previous secret', async () => {
    const rotated = { JWT_SECRET: ROTATED_SECRET };

    expect((await request('/admin/users', access(issued.accessToken), rotated)).status).toBe(401);
    expect((await request('/auth/refresh', refresh(issued.refreshToken), rotated, 'POST')).status).toBe(401);
  });

  it('accepts a session created after the rotation', async () => {
    const rotatedEnv = { ...env, JWT_SECRET: ROTATED_SECRET } as Env;
    const fresh = await createAuthSession(rotatedEnv, user);

    expect((await request('/admin/users', access(fresh.accessToken), { JWT_SECRET: ROTATED_SECRET })).status).toBe(200);
    expect((await request('/admin/users', access(fresh.accessToken))).status).toBe(401);
  });

  it('refuses a secret too short to sign with', async () => {
    expect((await request('/admin/users', access(issued.accessToken), { JWT_SECRET: 'short-secret' })).status).toBeGreaterThanOrEqual(500);
  });
});
