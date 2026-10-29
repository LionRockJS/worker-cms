import { putPublicMedia } from './media-fixtures';
// Feature routers are mounted through src/features/routers.ts rather than
// explicitly in routes/admin/index.ts, and they now sit *after* the page
// routes instead of before them. Nothing else asserts that each feature's
// entry point is still reachable at its original path, so a registry mistake
// or a shadowing route would only show up in the browser.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

async function adminGet(path: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  ipCounter += 1;
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': `10.11.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
      Cookie: `access_token=${token}`,
    },
  }));
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin').run();
});

describe('feature router mounting', () => {
  // One entry point per feature that owns admin routes.
  const entryPoints: Array<[string, string]> = [
    ['audit', '/admin/audit'],
    ['trash', '/admin/trash'],
    ['runtime-content-types', '/admin/page_types'],
    ['runtime-content-types', '/admin/block_types'],
    ['search', '/admin/advanced-search'],
    ['search', '/admin/advanced-search/default'],
    ['users-roles', '/admin/users'],
    ['users-roles', '/admin/roles'],
    ['media', '/admin/settings/content'],
    ['i18n', '/admin/settings/languages'],
    ['i18n', '/admin/settings/translations'],
    ['credits', '/admin/settings/credits'],
    ['plugins', '/admin/plugins-manage'],
  ];

  for (const [feature, path] of entryPoints) {
    it(`serves ${path} for the ${feature} feature`, async () => {
      const response = await adminGet(path);
      expect(response.status, `${path} returned ${response.status}`).toBe(200);
    });
  }

  it('mounts a feature public router at the worker root', async () => {
    // publicRouters is a second registry, mounted by src/index.ts outside the
    // admin stack — nothing else covers that path, and /media/* is served to
    // anonymous visitors, so a mounting mistake would not surface in any
    // admin test.
    await putPublicMedia('upload/probe.txt', 'hello');
    ipCounter += 1;
    const response = await worker.fetch(new IncomingRequest('http://localhost/media/upload/probe.txt', {
      redirect: 'manual',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '10.12.0.1' },
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  it('does not let the page routes shadow a later-mounted feature', async () => {
    // The features block is mounted after pagesRoutes. Page routes are all
    // rooted at /pages or /, so this must stay true — but it is exactly the
    // kind of thing a new pages catch-all would silently break.
    const response = await adminGet('/admin/advanced-search');
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toContain('cms-render-payload');
  });
});
