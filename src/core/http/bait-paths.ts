// ============================================================
// Bait-path ban.
//
// The CMS serves no PHP, WordPress or dotfiles, so a request for one is a
// scanner. Such a request still gets the normal 404, but its IP is barred
// from /auth/* for BAN_SECONDS so it cannot go on to probe sign-in. The hit
// that places the ban is recorded as an auth.access denial (bait_path).
//
// Bans live in the Cache API: no binding or config, and they expire on
// their own. They are per-colo and may be evicted early, which is fine for
// a speed bump — a ban is never the only thing standing in the way.
//
// Shared IPs (offices, mobile carriers) can put a scanner and an editor
// behind one address, so a request carrying a validly signed session
// cookie is never banned and never refused.
// ============================================================

import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../../types';
import { accessCookieName, readAuthCookie, refreshCookieName } from '../auth/cookies';
import { connectingIp } from '../auth/ip-access';
import { verifyJWT } from '../auth/jwt';
import { recordAuthDenial } from '../auth/denials';
import type { AppContext } from './context';

const BAN_SECONDS = 60 * 60;

const BAIT_PREFIXES = ['/wp-', '/wordpress', '/phpmyadmin', '/.env', '/.git/', '/.aws/', '/.ssh/', '/cgi-bin/'];
const APP_PREFIXES = ['/admin/', '/__cms/', '/media/', '/media-preview/', '/assets/', '/views/'];
const BAIT_EXACT =new Set(['/xmlrpc.php', '/.git', '/.ds_store', '/server-status', '/actuator/env']);

export function isBaitPath(path: string): boolean {
  const lower = path.toLowerCase();
  // App-owned prefixes (admin, plugin API, public media keys) are never bait.
  if (APP_PREFIXES.some(prefix => lower.startsWith(prefix))) return false;
  return BAIT_EXACT.has(lower) || lower.endsWith('.php') || BAIT_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function banKey(c: AppContext, ip: string): Request {
  return new Request(`${new URL(c.req.url).origin}/__bait-ban/${encodeURIComponent(ip)}`);
}

/** Bar this request's IP from /auth/* for BAN_SECONDS. Also used by the
 *  plugin API's canary secret. */
export async function banRequestIp(c: AppContext): Promise<void> {
  const ip = connectingIp(c.req.raw.headers);
  if (!ip) return;
  await caches.default.put(banKey(c, ip), new Response('banned', {
    headers: { 'Cache-Control': `max-age=${BAN_SECONDS}` },
  }));
}

async function hasSession(c: AppContext): Promise<boolean> {
  const access = readAuthCookie(c, accessCookieName);
  if (access && (await verifyJWT(access, c.env.JWT_SECRET))?.type === 'access') return true;
  const refresh = readAuthCookie(c, refreshCookieName);
  return !!refresh && (await verifyJWT(refresh, c.env.JWT_SECRET))?.type === 'refresh';
}

export const baitPathBan = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const ip = connectingIp(c.req.raw.headers);
  if (!ip) return next();
  const path = c.req.path;

  if (isBaitPath(path)) {
    // Audit only the hit that places a ban, so a scanner sweeping dozens of
    // paths writes one row per IP per BAN_SECONDS rather than one per path.
    if (!await hasSession(c) && !await caches.default.match(banKey(c, ip))) {
      await recordAuthDenial(c, 'auth.access', { reason: 'bait_path' });
      await banRequestIp(c);
    }
    return next();
  }

  if (path.startsWith('/auth/') && await caches.default.match(banKey(c, ip)) && !await hasSession(c)) {
    return c.text('Forbidden', 403, { 'Cache-Control': 'no-store' });
  }
  return next();
});
