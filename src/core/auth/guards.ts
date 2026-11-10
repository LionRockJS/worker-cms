// ============================================================
// Auth middleware – validates dual JWT on every protected route.
//
// Strategy:
//  1. Read `access_token` httpOnly cookie → verify HS256 JWT
//  2. If expired, attempt silent refresh via `refresh_token` cookie:
//     a. Verify refresh JWT signature & expiry
//     b. Look up the hashed jti in the sessions table (revocation check)
//     c. Issue new access + refresh tokens, rotate the session row
//  3. Store the decoded access-token payload in c.var.user
//  4. If no valid token can be obtained → redirect to /auth/login
// ============================================================

import { createMiddleware } from 'hono/factory';
import { recordAuthDenial } from './denials';
import { routePath } from 'hono/route';
import type { AppContext } from '../http/context';
import { verifyJWT } from './jwt';
import { effectivePermissions, resolveRolePermissions, splitRoles } from './roles';
import { readSyncGrant } from './sync-grant';
import type { Permission } from '../../types';
import {
  accessCookieName,
  clearAuthCookie,
  readAuthCookie,
  refreshCookieName,
  setAuthCookie,
} from './cookies';
import type { Env, Variables, JWTPayload } from '../../types';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  maintainSessionHygiene,
  rotateAuthSession,
  sessionIdleTtl,
  validateAccessSession,
} from './sessions';

export function wantsJsonResponse(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname === '/admin/upload'
    || url.pathname.startsWith('/admin/api/')
    || !!request.headers.get('Accept')?.includes('application/json');
}

export function jsonError(body: { success: false; error: string }, status: number, cmsError: string): Response {
  return Response.json(body, {
    status,
    headers: { 'X-CMS-Error': cmsError },
  });
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const secret = c.env.JWT_SECRET;

  // Helper: read access token and verify
  const readAccess = async (): Promise<JWTPayload | null> => {
    const token = readAuthCookie(c, accessCookieName);
    if (!token) return null;
    const payload = await verifyJWT(token, secret);
    if (!payload || payload.type !== 'access') return null;
    return validateAccessSession(c.env.DB, payload, sessionIdleTtl(c.env));
  };

  // Helper: perform refresh flow
  const tryRefresh = async (): Promise<JWTPayload | null> => {
    const refreshToken = readAuthCookie(c, refreshCookieName);
    if (!refreshToken) return null;

    const rotated = await rotateAuthSession(c.env, refreshToken, sessionIdleTtl(c.env), c);
    if (!rotated.ok) return null;

    // Opportunistic hygiene: purge expired sessions without blocking the response.
    c.executionCtx.waitUntil(maintainSessionHygiene(c.env, Number(rotated.accessPayload.sub)));

    // Set cookies
    setAuthCookie(c, accessCookieName, rotated.accessToken, ACCESS_TOKEN_TTL);
    if (rotated.refreshToken) {
      setAuthCookie(c, refreshCookieName, rotated.refreshToken, REFRESH_TOKEN_TTL);
    }

    return rotated.accessPayload;
  };

  let user = await readAccess();
  if (!user) {
    user = await tryRefresh();
  }

  if (!user) {
    clearAuthCookie(c, accessCookieName);
    clearAuthCookie(c, refreshCookieName);
    const supplied = readAuthCookie(c, accessCookieName) || readAuthCookie(c, refreshCookieName);
    await recordAuthDenial(c, 'auth.access', { reason: supplied ? 'invalid_credentials' : 'missing_credentials' });
    if (wantsJsonResponse(c.req.raw)) {
      return jsonError({ success: false, error: 'Authentication required' }, 401, 'authentication-required');
    }
    return c.redirect('/auth/login');
  }

  c.set('user', user);
  return next();
});

/** A permission-less signed-in user may reach only their landing page and
 *  self-service profile. Everything else still needs at least one granted
 *  capability, followed by the route's own least-privilege check. */
function isViewerSafeAdminRoute(path: string): boolean {
  return path === '/admin'
    || path === '/admin/'
    || path === '/admin/profile'
    || path.startsWith('/admin/profile/')
    // Every admin page loads its UI translations before rendering, including
    // the viewer landing page and profile. This grants no locale-edit access.
    || /^\/admin\/i18n\/catalog\/[^/]+$/.test(path)
    // Client-rendered safe pages still need their authenticated view source.
    // This route only serves bundled JSON/Liquid assets; content and mutation
    // routes remain protected by the editor/permission guards.
    || path.startsWith('/admin/views/');
}

export const editorGuard = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const user = c.get('user');
  const map = await resolveRolePermissions(c.env);
  if (effectivePermissions(map, user.role).size === 0) {
    if (isViewerSafeAdminRoute(c.req.path)) return next();
    await logDenial(c, { reason: 'editor_required' });
    if (wantsJsonResponse(c.req.raw)) {
      return jsonError({ success: false, error: 'Editor role required' }, 403, 'editor-role-required');
    }
    return c.redirect('/auth/login?error=forbidden');
  }
  return next();
});

/** Keep the registered route pattern, never user-supplied path parameters,
 * query terms or private object keys. Persist before the refusal is returned. */
function logDenial(c: AppContext, detail: Record<string, string>): Promise<void> {
  return recordAuthDenial(c, 'permission.denied', { ...detail, path: routePath(c, -1) });
}

/**
 * Middleware factory that enforces a specific capability. Accepts both built-in
 * permissions and plugin-declared permission strings. The admin role always
 * passes — plugin permissions are not stored in the built-in permission set so
 * admin is special-cased here rather than re-deriving the full set on every call.
 * Apply per-route on top of editorGuard so each mutation requires the least
 * privilege it needs.
 */
export function requirePermission(permission: Permission | string) {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const user = c.get('user');
    if (splitRoles(user.role).includes('admin')) return next();
    const map = await resolveRolePermissions(c.env);
    if (!effectivePermissions(map, user.role).has(permission as Permission)) {
      await logDenial(c, { permission });
      const message = `Insufficient permissions. Required permission: ${permission}`;
      if (wantsJsonResponse(c.req.raw)) {
        return jsonError({ success: false, error: message }, 403, 'insufficient-permissions');
      }
      return c.text(`Forbidden: ${message}`, 403);
    }
    return next();
  });
}

/**
 * Guards the presence and live-sync routes of one page (`:pageId`). Passes with
 * the given permission, or with a sync grant the plugin proxy issued this
 * session for that page; a grant's expiry is left in `syncGrantExp` for the
 * sync socket.
 */
export function requirePageSync(permission: 'content:read' | 'content:write') {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const user = c.get('user');
    if (splitRoles(user.role).includes('admin')) return next();
    if (effectivePermissions(await resolveRolePermissions(c.env), user.role).has(permission)) return next();
    const pageId = Number(c.req.param('pageId'));
    const grantExp = user.sid && Number.isSafeInteger(pageId) && pageId > 0
      ? await readSyncGrant(c, c.env.JWT_SECRET, user.sid, pageId)
      : null;
    if (grantExp === null) {
      await logDenial(c, { permission });
      return jsonError({ success: false, error: `Insufficient permissions. Required permission: ${permission}` }, 403, 'insufficient-permissions');
    }
    c.set('syncGrantExp', grantExp);
    return next();
  });
}

/** Requires at least one of the supplied capabilities. This is used for read
 * surfaces that support several legitimate operator roles (for example, trash
 * may be viewed by a content reader, restorer, or purger). */
export function requireAnyPermission(...permissions: Array<Permission | string>) {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const user = c.get('user');
    if (splitRoles(user.role).includes('admin')) return next();
    const map = await resolveRolePermissions(c.env);
    const effective = effectivePermissions(map, user.role);
    if (!permissions.some((permission) => effective.has(permission as Permission))) {
      await logDenial(c, { permissions: permissions.join(',') });
      const message = `Insufficient permissions. Required permission (one of): ${permissions.join(', ')}`;
      if (wantsJsonResponse(c.req.raw)) {
        return jsonError({ success: false, error: message }, 403, 'insufficient-permissions');
      }
      return c.text(`Forbidden: ${message}`, 403);
    }
    return next();
  });
}
