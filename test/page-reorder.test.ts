// Drag-and-drop reorder of the paginated page list (POST /admin/pages/reorder).
//
// The list is a LIMIT/OFFSET window over `weight ASC, name ASC, id ASC`, so the
// interesting cases are all about what a drop on page N does to the pages the
// user cannot see: it must renumber the whole sequence, never collide windows,
// and refuse outright when the window it was told about has moved on.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import '../src/index';
import { signJWT } from '../src/core/auth/jwt';
import type { JWTPayload } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
let ipCounter = 0;

describe('page list reorder', () => {
  beforeEach(async () => {
    for (const table of ['page_tags', 'page_versions', 'pages', 'users', 'audit_log', 'roles', 'role_permissions']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin')
      .run();
    // Six default-weight pages: as unordered as a real list starts out.
    for (let index = 1; index <= 6; index += 1) {
      await env.DB.prepare(
        'INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, 5, ?, ?)',
      )
        .bind(index, `uuid-${index}`, `Page ${index}`, `page-${index}`, 'article', '{}')
        .run();
    }
    // A second type that must not be touched by an `article` reorder.
    await env.DB.prepare(
      'INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, 5, ?, ?)',
    )
      .bind(99, 'uuid-99', 'Other', 'other', 'note', '{}')
      .run();
  });

  it('renumbers the whole sequence so a windowed drop cannot collide', async () => {
    // Page 2 of a 2-per-page list holds pages 3 and 4; swap them.
    const response = await post({ pageType: 'article', page: 2, pagesize: 2, before: [3, 4], after: [4, 3] });
    expect(response.status).toBe(200);
    // The window's new weights come back so the list can update its fields
    // in place rather than showing pre-drag numbers until the next reload.
    expect(await response.json()).toEqual({
      success: true,
      renumbered: 6,
      weights: [{ id: 4, weight: 30 }, { id: 3, weight: 40 }],
    });

    expect(await order('article')).toEqual([1, 2, 4, 3, 5, 6]);
    // Dense and unique: the next drop only has to move what the user moved.
    expect(await weights('article')).toEqual([10, 20, 30, 40, 50, 60]);
    // Untouched page type keeps its default weight.
    expect(await weights('note')).toEqual([5]);
  });

  it('leaves the other windows alone once the sequence is dense', async () => {
    await post({ pageType: 'article', page: 1, pagesize: 2, before: [1, 2], after: [2, 1] });
    const before = await weights('article');

    await post({ pageType: 'article', page: 3, pagesize: 2, before: [5, 6], after: [6, 5] });

    expect(await order('article')).toEqual([2, 1, 3, 4, 6, 5]);
    // Only the last window's two rows changed value; the rest kept theirs.
    expect(await weights('article')).toEqual(before);
  });

  it('refuses a drop whose window no longer matches the stored order', async () => {
    // Someone else reordered first.
    await post({ pageType: 'article', page: 1, pagesize: 2, before: [1, 2], after: [2, 1] });

    const stale = await post({ pageType: 'article', page: 1, pagesize: 2, before: [1, 2], after: [1, 2] });
    expect(stale.status).toBe(409);
    // The winning order stands — no half-applied guess.
    expect(await order('article')).toEqual([2, 1, 3, 4, 5, 6]);
  });

  it('rejects payloads that are not a permutation of one window', async () => {
    expect((await post({ pageType: 'article', page: 1, pagesize: 2, before: [1, 2], after: [1, 5] })).status).toBe(409);
    expect((await post({ pageType: 'article', page: 1, pagesize: 2, before: [1, 1], after: [1, 1] })).status).toBe(400);
    expect((await post({ pageType: '', page: 1, pagesize: 2, before: [1, 2], after: [2, 1] })).status).toBe(400);
    expect(await weights('article')).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('needs content:write', async () => {
    const response = await post(
      { pageType: 'article', page: 1, pagesize: 2, before: [1, 2], after: [2, 1] },
      await authCookie('moderator'),
    );
    expect(response.status).toBe(403);
    expect(await weights('article')).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('offers the handle on a single-type list and withholds it elsewhere', async () => {
    const typed = await listData('/admin/pages/list/article');
    expect(typed.canReorder).toBe(true);
    expect(typed.reorderAction).toBe('/admin/pages/reorder');
    expect(typed.reorderPageType).toBe('article');
    // The POST replays this window, so it must carry the clamped page/size the
    // list actually used, not whatever the query string asked for.
    expect(typed.reorderPage).toBe(1);
    expect(typed.reorderPageSize).toBe(100);

    // All types: a renumber here would interleave `article` with `note`.
    expect((await listData('/admin/pages/list')).canReorder).toBe(false);
    // Live/scheduled/ended read from the published DB while the weight write
    // lands in the draft DB, so the list would not re-sort under the drop.
    expect((await listData('/admin/pages/list/article?status=live')).canReorder).toBe(false);
    // Read-only roles get no handle rather than a drag that 403s.
    expect((await listData('/admin/pages/list/article', await authCookie('moderator'))).canReorder).toBe(false);
  });
});

async function post(body: Record<string, unknown>, cookie?: string): Promise<Response> {
  return fetchWorker('/admin/pages/reorder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookie ?? await authCookie(),
    },
    body: JSON.stringify(body),
  });
}

/** The page list is client-rendered, so the reorder wiring lives in the
 *  render payload rather than in the server HTML. */
async function listData(path: string, cookie?: string): Promise<Record<string, unknown>> {
  const response = await fetchWorker(path, { headers: { Cookie: cookie ?? await authCookie() } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing cms-render-payload script');
  const payload = JSON.parse(match[1]) as { bodyView: null | { data: Record<string, unknown> } };
  return payload.bodyView?.data ?? {};
}

/** Page ids in list order for `pageType`. */
async function order(pageType: string): Promise<number[]> {
  const rows = await env.DB.prepare(
    'SELECT id FROM pages WHERE page_type = ? ORDER BY weight ASC, name ASC, id ASC',
  ).bind(pageType).all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

/** Weights in list order for `pageType`. */
async function weights(pageType: string): Promise<number[]> {
  const rows = await env.DB.prepare(
    'SELECT weight FROM pages WHERE page_type = ? ORDER BY weight ASC, name ASC, id ASC',
  ).bind(pageType).all<{ weight: number }>();
  return rows.results.map((row) => row.weight);
}

async function fetchWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.2.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    ...init,
    headers,
  }));
}

async function authCookie(role = 'admin'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}
