// ============================================================
// IP-keyed rate limiting using Cloudflare's Workers Rate
// Limiting binding (wrangler.toml [[unsafe.bindings]]).
//
// The binding is optional: when absent (local dev, tests) the
// middleware is a no-op, so the limiter never blocks development.
// Limits are per-colo, which is sufficient for brute-force and
// abuse throttling on auth and upload endpoints.
// ============================================================

import { createMiddleware } from 'hono/factory';
import type { Env, RateLimiter, Variables } from '../../types';
import type { AppContext } from './context';

export function rateLimitByIP(getLimiter: (env: Env) => RateLimiter | undefined, onDenied?: (c: AppContext) => Promise<void>) {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const limiter = getLimiter(c.env);
    if (!limiter) return next();

    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      if (onDenied) await onDenied(c);
      return c.json({ success: false, error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    }
    return next();
  });
}
