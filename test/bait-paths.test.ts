import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { isBaitPath } from '../src/core/http/bait-paths';
import { issueAuthTokens } from '../src/core/auth/sessions';

// Each test uses its own IP: bans live in the shared Cache API.
let ipCounter = 0;
const nextIp = () => { ipCounter++; return `10.123.${Math.floor(ipCounter / 250)}.${ipCounter % 250 + 1}`; };

async function call(path: string, ip: string, cookie = '') {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': ip },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sessionCookie(type: 'access' | 'refresh'): Promise<string> {
  const tokens = await issueAuthTokens({ id: 9901, email: 'bait@example.invalid', name: 'Bait', role: 'editor' }, env.JWT_SECRET, '99001');
  return type === 'access' ? `__Host-access_token=${tokens.accessToken}` : `__Host-refresh_token=${tokens.refreshToken}`;
}

describe('isBaitPath', () => {
  it('matches scanner paths regardless of case', () => {
    for (const path of ['/wp-login.php', '/WP-ADMIN/', '/xmlrpc.php', '/.env', '/.env.local', '/.git/config', '/phpmyadmin/index.php', '/index.php'])
      expect(isBaitPath(path), path).toBe(true);
  });

  it('never matches app-owned or ordinary paths', () => {
    for (const path of ['/', '/auth/login', '/admin/pages', '/admin/x.php', '/__cms/pages', '/media/upload.php', '/media-preview/a.php', '/assets/app.css', '/favicon.ico'])
      expect(isBaitPath(path), path).toBe(false);
  });
});

describe('bait-path ban', () => {
  it('serves the normal 404 for bait, then refuses /auth/* from that IP', async () => {
    const ip = nextIp();
    expect((await call('/auth/login', ip)).status).toBe(200);

    const bait = await call('/.env', ip);
    expect(bait.status).toBe(404);

    const refused = await call('/auth/login', ip);
    expect(refused.status).toBe(403);
    expect((await call('/auth/start?provider=github', ip)).status).toBe(403);
  });

  it('leaves other IPs and non-auth paths alone', async () => {
    const ip = nextIp();
    await call('/wp-login.php', ip);
    expect((await call('/auth/login', nextIp())).status).toBe(200);
    expect((await call('/login', ip)).status).toBe(302);
  });

  it('does not ban a request that carries a valid session', async () => {
    const ip = nextIp();
    await call('/xmlrpc.php', ip, await sessionCookie('access'));
    expect((await call('/auth/login', ip)).status).toBe(200);
  });

  it('still lets a signed-in editor through /auth/* from a banned IP', async () => {
    const ip = nextIp();
    await call('/.git/config', ip);
    expect((await call('/auth/login', ip)).status).toBe(403);
    expect((await call('/auth/login', ip, await sessionCookie('access'))).status).toBe(200);
    expect((await call('/auth/login', ip, await sessionCookie('refresh'))).status).toBe(200);
  });

  it('treats a forged session cookie as no session', async () => {
    const ip = nextIp();
    await call('/.env', ip, '__Host-access_token=eyJhbGciOiJIUzI1NiJ9.e30.forged');
    expect((await call('/auth/login', ip, '__Host-access_token=eyJhbGciOiJIUzI1NiJ9.e30.forged')).status).toBe(403);
  });
});
