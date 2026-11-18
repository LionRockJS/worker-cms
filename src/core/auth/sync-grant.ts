// ============================================================
// Per-page sync grants — let a plugin's own editors join presence and live
// field sync on that plugin's pages without the CMS-wide content:write role.
//
// The plugin proxy mints a grant when a plugin serves one of its own pages
// with `x-cms-editor-page-id`; the sync and presence routes accept it in place
// of the role permission. It is stateless: `<expSeconds>.<hmac>` bound to the
// session and the page, carried in an HttpOnly cookie.
// ============================================================

import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { timingSafeEqualStr } from '../http/crypto';
import { isSecureRequest } from './cookies';

/** Every render of the plugin page renews the grant. */
export const SYNC_GRANT_TTL_SECONDS = 2 * 3600;

function cookieName(pageId: number): string {
  return `sync_grant_${pageId}`;
}

async function sign(secret: string, sid: string, pageId: number, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`sync-grant:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${sid}|${pageId}|${exp}`));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function mintSyncGrant(secret: string, sid: string, pageId: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SYNC_GRANT_TTL_SECONDS;
  return `${exp}.${await sign(secret, sid, pageId, exp)}`;
}

/** The grant's expiry in seconds, or null when it is not a live grant for this session and page. */
export async function verifySyncGrant(secret: string, token: string, sid: string, pageId: number): Promise<number | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.length > 128) return null;
  const exp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  return timingSafeEqualStr(await sign(secret, sid, pageId, exp), token.slice(dot + 1)) ? exp : null;
}

type AnyContext = Context<any>;

export async function setSyncGrantCookie(c: AnyContext, secret: string, sid: string, pageId: number): Promise<void> {
  setCookie(c, cookieName(pageId), await mintSyncGrant(secret, sid, pageId), {
    httpOnly: true,
    secure: isSecureRequest(c.req.raw),
    sameSite: 'Strict',
    path: '/admin/api',
    maxAge: SYNC_GRANT_TTL_SECONDS,
  });
}

export async function readSyncGrant(c: AnyContext, secret: string, sid: string, pageId: number): Promise<number | null> {
  const token = getCookie(c, cookieName(pageId));
  return token ? verifySyncGrant(secret, token, sid, pageId) : null;
}
