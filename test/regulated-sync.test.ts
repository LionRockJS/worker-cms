import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { verifyJWT } from '../src/core/auth/jwt';

it('closes a live socket before delivering a snapshot after its page becomes PHI', async () => {
  const id = 72071;
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, 'sync-policy-test', 'Test', 'sync-policy-test', 'sync_policy', '{}')").bind(id).run();
  const exp = Math.floor(Date.now() / 1000) + 900;
  const token = await signJWT({ sub: '72071', name: 'Test', email: 'sync@example.invalid', role: 'admin', type: 'access', exp }, env.JWT_SECRET);
  const payload = (await verifyJWT(token, env.JWT_SECRET))!;
  const response = await env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(`regulated-sync-${crypto.randomUUID()}`)).fetch('https://sync/api/sync', {
    headers: { Upgrade: 'websocket', 'X-User-Id': payload.sub, 'X-User-Name': payload.name, 'X-Session-Id': payload.sid!, 'X-Session-Expires': String(exp), 'X-Page-Id': String(id) },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  let messages = 0;
  ws.addEventListener('message', () => { messages++; });
  try {
    await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES ('page_type', 'sync_policy', 'phi')").run();
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), 2000);
      ws.addEventListener('close', (event: CloseEvent) => { clearTimeout(timer); resolve(event.code); }, { once: true });
    });
    ws.send(JSON.stringify({ type: 'sync' }));
    expect(await closed).toBe(1008);
    expect(messages).toBe(0);
  } finally {
    ws.close();
    await env.DB.prepare("DELETE FROM data_classes WHERE container_key = 'sync_policy'").run();
    await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id).run();
  }
});
