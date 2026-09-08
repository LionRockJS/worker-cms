// Signed-in route fixtures include a real account and revocable session.
import { env } from 'cloudflare:workers';
import { signJWT as signRawJWT } from '../src/core/auth/jwt';
import { storeRefreshSession } from '../src/core/auth/sessions';
export { hashToken } from '../src/core/auth/jwt';

export async function signJWT(payload: Parameters<typeof signRawJWT>[0], secret: string): Promise<string> {
  if (payload.type !== 'access' || payload.sid) return signRawJWT(payload, secret);
  const id = Number(payload.sub);
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role=excluded.role, name=excluded.name`,
  ).bind(id, `fixture:${id}`, payload.email, payload.name, payload.role).run();
  const sid = await storeRefreshSession(env.DB, id, crypto.randomUUID());
  return signRawJWT({ ...payload, sid: String(sid) }, secret);
}
