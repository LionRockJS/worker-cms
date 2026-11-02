// Signed-in route fixtures include a real account and revocable session.
import { env } from 'cloudflare:workers';
import { signJWT as signRawJWT } from '../src/core/auth/jwt';
import { hashToken } from '../src/core/auth/jwt';
export { hashToken } from '../src/core/auth/jwt';

export async function signJWT(payload: Parameters<typeof signRawJWT>[0], secret: string): Promise<string> {
  if (payload.type !== 'access' || payload.sid) return signRawJWT(payload, secret);
  const id = Number(payload.sub);
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role=excluded.role, name=excluded.name`,
  ).bind(id, `fixture:${id}`, payload.email, payload.name, payload.role).run();
  const row = await env.DB.prepare("INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+7 days')) RETURNING id")
    .bind(id, await hashToken(crypto.randomUUID())).first<{ id: number }>();
  if (!row) throw new Error('Fixture session creation failed');
  const sid = row.id;
  return signRawJWT({ ...payload, sid: String(sid) }, secret);
}
