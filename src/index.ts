import { limitRequestBody, BodyTooLargeError } from './core/http/body-limit';
// ============================================================
// 0xCMS - main entry point
//
// Routes:
//   /auth/*   – OAuth 2.1 login / callback / logout / refresh
//   /admin/*  – Protected CMS admin UI (editor roles required)
//   /         – Public site (reads from live content tables)
// ============================================================

import { Hono } from 'hono';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { publicRouters } from './features/routers';
import { runFeatureScheduledWork } from './features/services';
import { errorPage } from './core/render/errors';
import {
  canonicalHostResponse,
  rejectCrossOriginMutation,
  withSensitiveCacheHeaders,
  withSecurityHeaders,
} from './core/http/headers';
import { accessLog } from './core/http/access-log';
import { generateCspNonce, requestContext } from './core/http/request-context';
import { viewRevision } from './core/http/view-revision';
import type { Env, Variables, WorkerEnv } from './types';
import { ingestSubmissions } from './core/db/submission-ingest';
import { coreExtensions } from './core/extensions';
import { withD1Sessions } from './core/http/d1-sessions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const MIN_JWT_SECRET_LENGTH = 32;
let warnedWeakJwtSecret = false;

app.use('*', async (c, next) => {
  // A weak HMAC secret lets anyone forge admin tokens, so refuse to serve
  // (outside local development) rather than run with a forgeable secret.
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    if (!warnedWeakJwtSecret) {
      warnedWeakJwtSecret = true;
      console.error(`JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (!isLocalHost(new URL(c.req.url).hostname)) {
      return withSensitiveCacheHeaders(
        withSecurityHeaders(new Response('Server misconfigured', { status: 500 })),
        c.req.raw,
      );
    }
  }

  // Canonical-host enforcement is opt-in: without CANONICAL_ORIGIN the CMS
  // serves whatever hostname it is deployed on.
  const canonicalOrigin = (c.env.CANONICAL_ORIGIN ?? '').trim();
  if (canonicalOrigin) {
    const canonicalResponse = canonicalHostResponse(
      c.req.raw,
      canonicalOrigin,
    );
    if (canonicalResponse) {
      return withSensitiveCacheHeaders(withSecurityHeaders(canonicalResponse), c.req.raw);
    }
  }

  // The /__cms plugin write-back API is a server-to-server channel authenticated
  // by PLUGIN_SECRET, not a browser. Such callers send no Origin/Referer, which
  // the fail-closed cross-origin guard would reject — so skip the guard here.
  // (The secret, not browser provenance, is the authenticator for /__cms.)
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/__cms/') && !(path === '/auth/callback' && c.req.method === 'POST')) {
    const crossOriginMutation = rejectCrossOriginMutation(c.req.raw, canonicalOrigin ? [canonicalOrigin] : []);
    if (crossOriginMutation) {
      return withSensitiveCacheHeaders(withSecurityHeaders(crossOriginMutation), c.req.raw);
    }
  }

  const cspNonce = generateCspNonce();
  await requestContext.run({ cspNonce }, () => next());
  c.res = withSensitiveCacheHeaders(withSecurityHeaders(c.res, cspNonce), c.req.raw);
  return undefined;
});

app.use('*', limitRequestBody);

// Reads announced by handlers are classified and written here, after the
// response is built. Mounted inside the requestContext scope above, and before
// the routes, so it covers the admin screens, the contributor API and the
// public media routes alike.
app.use('*', accessLog);

// ── Auth (OAuth 2.1 + JWT) ────────────────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin UI (protected) ──────────────────────────────────────────────────────
app.route('/admin', adminRoutes);

// ── Public routes contributed by installed features (media delivery) ─────────
for (const { router, basePath } of publicRouters) {
  app.route(basePath ?? '/', router);
}

app.get('/views/*', async (c) => {
  const path = c.req.path.slice('/views'.length);
  if (!path.startsWith('/') || path.includes('..')) return c.notFound();

  const response = await c.env.VIEWS.fetch(`https://views.local${path}`);
  if (!response.ok) return c.notFound();

  const headers = new Headers(response.headers);
  if (path.endsWith('.json')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  } else if (path.endsWith('.liquid')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
});

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

// ── Static assets (compiled CSS) from the VIEWS binding ──────────────────────
app.get('/assets/*', async (c) => {
  const assetPath = new URL(c.req.url).pathname;
  const response = await c.env.VIEWS.fetch(`https://views.local${assetPath}`);
  if (!response.ok) return c.notFound();
  const headers = new Headers(response.headers);
  if (assetPath.endsWith('.js')) {
    headers.set('Content-Type', 'text/javascript; charset=utf-8');
  }
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
});

// ── Login shortcut ────────────────────────────────────────────────────────────
app.get('/login', (c) => c.redirect('/auth/login'));

// ── Favicon ───────────────────────────────────────────────────────────────────
app.get('/favicon.ico', () => new Response(null, { status: 204 }));

// ── Public root ───────────────────────────────────────────────────────────────
app.get('/', (c) => {
  // Redirect root to the login page if no other public site handler is installed
  return c.redirect('/auth/login');
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.notFound(async (c) => {
  return c.html(
    await errorPage(c.env.VIEWS, {
      status: 404,
      title: 'Not Found',
      heading: 'Page Not Found',
      siteTitle: c.env.SITE_TITLE ?? '0xCMS',
      viewRevision: viewRevision(c.env),
    }),
    404,
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError(async (err, c) => {
  if (err instanceof BodyTooLargeError) return c.json({ error: 'body_too_large' }, 413);
  console.error(err);
  return c.html(
    await errorPage(c.env.VIEWS, {
      status: 500,
      title: 'Server Error',
      heading: 'Internal Server Error',
      message: 'Please try again later.',
      siteTitle: c.env.SITE_TITLE ?? '0xCMS',
      viewRevision: viewRevision(c.env),
    }),
    500,
  );
});

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, withD1Sessions(env), ctx);
  },

  // Queue consumer. The handler itself is part of the entrypoint and cannot be
  // contributed by a feature, so it dispatches to whoever handles the message —
  // today the jobs feature. With no handler registered a message is simply
  // acknowledged, which is what a build without a durable runner should do.
  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    const handle = coreExtensions().handleQueueMessage;
    if (!handle) return;
    const sessionEnv = withD1Sessions(env);
    for (const message of batch.messages) {
      await handle(sessionEnv, message.body);
    }
  },

  // Cron: pull live-only submission rows (published DB → draft pages) and
  // bill due recurring credit subscriptions. Each tick handles one bounded
  // batch of each; plugins can trigger the same ingest on demand via
  // POST /__cms/ingest/submissions.
  async scheduled(_controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    const sessionEnv = withD1Sessions(env);
    const result = await ingestSubmissions(sessionEnv);
    if (result.scanned) console.log('submission ingest:', JSON.stringify(result));
    // Cron work owned by installed features (today, the credit subscription
    // sweep) is composed through the generated feature-service registry.
    for (const featureWork of await runFeatureScheduledWork(sessionEnv)) {
      console.log(featureWork);
    }
  },
};
export { PageSyncDO } from './core/durable-objects/page-sync';
export { FormOnceDO } from './core/durable-objects/form-once';
