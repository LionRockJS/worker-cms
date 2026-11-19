import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { verifyJWT } from '../src/core/auth/jwt';

async function session(id: number, role: string) {
  const token = await signJWT({
    sub: String(id), name: `User ${id}`, email: `user-${id}@example.test`, role,
    type: 'access', exp: Math.floor(Date.now() / 1000) + 600,
  }, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function request(path: string, cookie: string, fields?: Record<string, string>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com/admin${path}`, {
    method: fields ? 'POST' : 'GET', body: fields ? new URLSearchParams(fields) : undefined,
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '192.0.2.8' },
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

it('keeps legacy pages role-based, grants edit on one page, and transfers ownership', async () => {
  const owner = await session(72101, 'editor');
  const editor = await session(72102, 'editor');
  const guest = await session(72103, 'viewer');
  await env.DB.prepare(`INSERT INTO pages (id,uuid,name,slug,page_type,lect,creator,editors)
    VALUES (72100,'acl-legacy','Legacy access fixture','acl-legacy','default','{}',72101,'72103')`).run();
  expect((await request('/pages/72100/edit', editor)).status).toBe(200);
  expect((await request('/pages/72100/read', guest)).status).toBe(302);
  const accessView = JSON.parse((await (await request('/pages/72100/access', owner)).text())
    .match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s)![1]).bodyView;
  expect(accessView).toMatchObject({ viewPath: '/templates/page-access.json', data: { enabled: false, mode: '600' } });

  const enabled = await request('/pages/72100/access', owner, { action: 'mode', revision: '0', owner: '6', group: '0', others: '0' });
  expect(enabled.status).toBe(303);
  expect((await request('/pages/72100/edit', editor)).status).toBe(404);
  expect((await request('/pages/72100/read', guest)).status).toBe(302);
  expect((await request('/pages/72100/access', owner, { action: 'add', revision: '1', user_id: '72103' })).status).toBe(303);

  expect((await request('/pages/72100/edit', guest)).status).toBe(200);
  expect((await request('/api/presence/72100', guest)).status).toBe(200);
  expect((await request('/pages/72100/access', guest)).status).toBe(404);
  const change = { name: 'Edited by a page-only editor', slug: 'acl-legacy', page_type: 'default' };
  expect((await request('/pages/72100', guest, { ...change, action: 'publish' })).status).toBe(403);
  expect((await request('/pages/72100', guest, change)).status).toBe(302);
  expect(await env.DB.prepare('SELECT name,creator FROM pages WHERE id=72100').first())
    .toEqual({ name: change.name, creator: 72101 });

  const created = await request('/pages/new_post/default', owner, { name: 'Other private page', slug: 'acl-other-private' });
  expect(created.status).toBe(302);
  const other = await env.DB.prepare(`SELECT p.id, a.owner_id, a.mode FROM pages p JOIN page_access_policies a ON a.page_uuid=p.uuid
    WHERE p.slug='acl-other-private'`).first<{id: number; owner_id: number; mode: number}>();
  expect(other).toMatchObject({ owner_id: 72101, mode: 600 });
  expect((await request(`/pages/${other!.id}/read`, guest)).status).toBe(404);
  const matches = await (await request('/api/pages/default?q=acl-', guest)).json<Array<{ id: number }>>();
  expect(matches.map(row => row.id)).toEqual([72100]);

  const payload = (await verifyJWT(guest.slice('access_token='.length), env.JWT_SECRET))!;
  const upgrade = await env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName('page-72100')).fetch('https://page-sync/api/sync', {
    headers: {
      Upgrade: 'websocket', 'X-Page-Id': '72100', 'X-User-Id': payload.sub, 'X-User-Name': payload.name,
      'X-Session-Id': payload.sid!, 'X-Session-Expires': String(payload.exp),
    },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;
  socket.accept();
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));

  expect((await request('/pages/72100/access', owner, { action: 'remove', revision: '1', user_id: '72103' })).status).toBe(409);
  expect((await request('/pages/72100/access', owner, { action: 'remove', revision: '2', user_id: '72103' })).status).toBe(303);
  expect(await closed).toBe(1008);
  expect((await request('/pages/72100', guest, change)).status).toBe(302);
  expect((await request('/pages/72100/access', owner, { action: 'transfer', revision: '3', user_id: '72103' })).status).toBe(303);
  expect((await request('/pages/72100/edit', owner)).status).toBe(404);
  expect((await request('/pages/72100/access', guest)).status).toBe(200);
  expect(await env.DB.prepare('SELECT creator FROM pages WHERE id=72100').first()).toEqual({ creator: 72101 });
});

it('applies owner, group and others modes before listing, including legacy label opt-in', async () => {
  const owner = await session(72201, 'editor');
  const groupMember = await session(72202, 'moderator');
  const reader = await session(72203, 'viewer');
  const named = await session(72204, 'viewer');
  await env.DB.prepare(`INSERT INTO pages (id,uuid,name,slug,page_type,lect,creator,editors)
    VALUES (72200,'acl-mode','Mode fixture','acl-mode','default','{}',72201,'72204')`).run();
  const enable = new URLSearchParams({ action: 'mode', revision: '0', owner: '6', group: '6', others: '4', group_role: 'moderator', legacy_user: '72204' });
  expect((await request('/pages/72200/access', owner, Object.fromEntries(enable))).status).toBe(303);
  expect((await request('/pages/72200/edit', groupMember)).status).toBe(200);
  expect((await request('/pages/72200/read', reader)).status).toBe(200);
  expect((await request('/pages/72200/edit', reader)).headers.get('Location')).toBe('/admin/pages/72200/read');
  expect((await request('/pages/72200/edit', named)).status).toBe(200);
  expect((await request('/pages/list', reader)).status).toBe(200);
  expect((await request('/pages/72200/access', groupMember)).status).toBe(404);
});


it('transfers ownership without enabling an existing page and preserves policy through trash', async () => {
  const original = await session(72301, 'editor');
  const owner = await session(72302, 'editor');
  const admin = await session(72303, 'admin');
  const named = await session(72304, 'viewer');
  await env.DB.prepare(`INSERT INTO pages (id,uuid,name,slug,page_type,lect,creator)
    VALUES (72300,'acl-trash','Trash fixture','acl-trash','default','{}',72301)`).run();
  expect((await request('/pages/72300/access', original, { action: 'transfer', revision: '0', user_id: '72302' })).status).toBe(303);
  expect((await request('/pages/72300/access', original)).status).toBe(404);
  expect((await request('/pages/72300/edit', original)).status).toBe(200);
  expect((await request('/pages/72300/access', owner, { action: 'mode', revision: '1', owner: '6', group: '0', others: '0' })).status).toBe(303);
  expect((await request('/pages/72300/access', owner, { action: 'add', revision: '2', user_id: '72304' })).status).toBe(303);
  expect((await request('/pages/72300/delete', original, {})).status).toBe(404);
  expect((await request('/pages/72300/delete', owner, {})).status).toBe(302);
  const trash = await env.DB.prepare("SELECT id FROM trash_pages WHERE uuid='acl-trash'").first<{ id: number }>();
  expect((await request(`/trash/${trash!.id}/restore`, admin, {})).status).toBe(302);
  const restored = await env.DB.prepare("SELECT id FROM pages WHERE uuid='acl-trash'").first<{ id: number }>();
  expect((await request(`/pages/${restored!.id}/edit`, named)).status).toBe(200);
  expect((await request(`/pages/${restored!.id}/edit`, original)).status).toBe(404);
});
