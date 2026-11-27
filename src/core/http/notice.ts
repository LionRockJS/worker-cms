// Flash and error notices carried in a redirect's query string.
//
// Pages show the notice text as-is, so without a check a crafted link could
// put its own wording inside the admin chrome. Every notice is therefore
// signed for the user it was written for, and a page shows it only when the
// signature verifies; anything else is silently dropped.

import type { AppContext } from './context';
import { timingSafeEqualStr } from './crypto';

export type NoticeKind = 'flash' | 'error';

async function sign(secret: string, userId: string, kind: NoticeKind, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`notice:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}|${userId}|${message}`));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** `flash=<message>&flash_sig=<hmac>` (or `error=…&error_sig=…`) for a redirect shown to `userId`. */
export async function signedNotice(secret: string, userId: string, message: string, kind: NoticeKind = 'flash'): Promise<string> {
  return `${kind}=${encodeURIComponent(message)}&${kind}_sig=${await sign(secret, userId, kind, message)}`;
}

/** The signed query fragment for a redirect back to this request's user. */
export function notice(c: AppContext, message: string, kind: NoticeKind = 'flash'): Promise<string> {
  return signedNotice(c.env.JWT_SECRET, c.get('user').sub, message, kind);
}

/** This request's notice, or '' when it is missing or not signed for the signed-in user. */
export async function readNotice(c: AppContext, kind: NoticeKind = 'flash'): Promise<string> {
  const message = c.req.query(kind) ?? '';
  const signature = c.req.query(`${kind}_sig`) ?? '';
  const userId = c.get('user')?.sub;
  if (!message || !signature || !userId) return '';
  return timingSafeEqualStr(await sign(c.env.JWT_SECRET, userId, kind, message), signature) ? message : '';
}
