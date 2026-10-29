// Read logging and container classification.
//
// The four properties this has to get right, because each one is the difference
// between a usable audit control and a liability:
//
//   - an unclassified container records nothing, so an install with no
//     regulated data pays nothing and the log stays readable;
//   - a classified read records exactly one row, with the container on it;
//   - a list is one row carrying what the user actually received, not one row
//     per result and not the unfiltered total;
//   - ePHI is never served when the record could not be written.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

interface ReadRow {
  action: string;
  event_class: string;
  data_class: string;
  retention_class: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_ids: string | null;
  target_count: number | null;
  container_key: string | null;
  query_fingerprint: string | null;
}

async function cookieFor(sub: string, role: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub,
    email: `${role}@example.com`,
    name: `${role} user`,
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function adminFetch(path: string, init: RequestInit = {}, role = 'admin'): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', await cookieFor(role === 'admin' ? '1' : '2', role));
  if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.55.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    ...init,
    headers,
  }));
}

/** Read events only — mutation and auth rows share the table. */
function readRows() {
  return expect.poll(async () => (await env.DB.prepare(
    `SELECT action, event_class, data_class, retention_class, actor_user_id, target_type,
            target_id, target_ids, target_count, container_key, query_fingerprint
       FROM audit_events WHERE event_class = 'read' ORDER BY seq`,
  ).all<ReadRow>()).results, { timeout: 2000 });
}

async function classify(kind: string, key: string, dataClass: string): Promise<void> {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)')
    .bind(kind, key, dataClass)
    .run();
}

async function seedPages(count: number, pageType: string, firstId = 500): Promise<number[]> {
  const ids: number[] = [];
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const id = firstId + index;
    ids.push(id);
    statements.push(env.DB.prepare(
      'INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, `uuid-access-${id}`, `Page ${id}`, `page-${id}`, pageType, '{}'));
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
  return ids;
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM pages').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin'),
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor'),
  ]);
});

describe('read logging', () => {
  it('records nothing while the container is unclassified', async () => {
    const [id] = await seedPages(1, 'note');

    const response = await adminFetch(`/admin/pages/${id}/read`);
    expect(response.status).toBe(200);

    // Not "eventually one row" — nothing, ever. This is what keeps the cost of
    // the mechanism at zero for an install with no regulated data.
    await readRows().toEqual([]);
  });

  it('records exactly one row once the page type is classified', async () => {
    const [id] = await seedPages(1, 'note');
    await classify('page_type', 'note', 'pii');

    expect((await adminFetch(`/admin/pages/${id}/read`)).status).toBe(200);

    await readRows().toMatchObject([{
      action: 'page.read',
      event_class: 'read',
      data_class: 'pii',
      retention_class: 'pii_access',
      actor_user_id: '1',
      target_type: 'page',
      target_id: String(id),
      target_count: 1,
      container_key: 'note',
    }]);
  });

  it('leaves an unclassified page type alone when a sibling type is classified', async () => {
    const [noteId] = await seedPages(1, 'note', 600);
    const [articleId] = await seedPages(1, 'article', 700);
    await classify('page_type', 'note', 'pii');

    expect((await adminFetch(`/admin/pages/${articleId}/read`)).status).toBe(200);
    await readRows().toEqual([]);

    expect((await adminFetch(`/admin/pages/${noteId}/read`)).status).toBe(200);
    await readRows().toMatchObject([{ container_key: 'note', target_id: String(noteId) }]);
  });

  it('records a list as one row carrying what was returned', async () => {
    // 120 seeded, 100 is the page-size ceiling, so the reader received 100.
    // The row records the 100 they saw, not the 120 that matched.
    await seedPages(120, 'note');
    await classify('page_type', 'note', 'pii');

    expect((await adminFetch('/admin/pages/list/note?pagesize=100')).status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT target_count, target_id, target_ids, action FROM audit_events WHERE event_class = 'read'",
    ).all<ReadRow>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ action: 'page.list', target_count: 100, target_id: null });
    // Capped at 100 ids, with target_count staying authoritative.
    expect(JSON.parse(rows.results[0].target_ids ?? '[]')).toHaveLength(100);
  });

  it('records a search by fingerprint and never stores the terms', async () => {
    // Advanced search resolves its targets against the configured page types,
    // so this one uses a real type rather than an ad-hoc column value.
    const term = 'supersecretpatientname';
    await env.DB.prepare('INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(900, 'uuid-access-900', term, 'page-900', 'default', '{}')
      .run();
    await classify('page_type', 'default', 'pii');

    const response = await adminFetch(
      `/admin/advanced-search/default?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${term}&path1=`,
    );
    expect(response.status).toBe(200);

    await readRows().toHaveLength(1);
    const rows = (await env.DB.prepare(
      "SELECT action, query_fingerprint, detail, container_key, target_ids FROM audit_events WHERE event_class = 'read'",
    ).all<ReadRow>()).results;
    expect(rows[0].action).toBe('page.search');
    expect(rows[0].query_fingerprint).toMatch(/^[0-9a-f]{24}$/);
    // The whole point of the fingerprint: a search string in a CMS holding
    // regulated data is frequently the identifier being searched for.
    expect(JSON.stringify(rows)).not.toContain(term);
  });
});

describe('ePHI fails closed', () => {
  it('refuses to serve a record it could not account for', async () => {
    const [id] = await seedPages(1, 'chart');
    await classify('page_type', 'chart', 'phi');

    // Take the audit table out from under the write, which is the one failure
    // the fail-closed rule exists for.
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      const response = await adminFetch(`/admin/pages/${id}/read`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Audit log unavailable');
    } finally {
      await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run();
    }
  });

  it('still serves an ordinary pii read when the write fails', async () => {
    // pii keeps the cheaper after-response write, so a logging failure must not
    // take the screen down with it.
    const [id] = await seedPages(1, 'note');
    await classify('page_type', 'note', 'pii');

    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      expect((await adminFetch(`/admin/pages/${id}/read`)).status).toBe(200);
    } finally {
      await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run();
    }
  });
});

describe('the classification screen', () => {
  it('lists classifications for audit:read and refuses an editor', async () => {
    await classify('page_type', 'chart', 'phi');

    const allowed = await adminFetch('/admin/audit/classes');
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('chart');

    expect((await adminFetch('/admin/audit/classes', {}, 'editor')).status).toBe(403);
  });

  it('classifies and declassifies a container, recording both', async () => {
    const add = await adminFetch('/admin/audit/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ container_kind: 'page_type', container_key: 'chart', class: 'phi' }).toString(),
    });
    expect(add.status).toBe(302);
    expect(await env.DB.prepare('SELECT class FROM data_classes WHERE container_key = ?').bind('chart').first())
      .toEqual({ class: 'phi' });

    const row = await env.DB.prepare('SELECT id FROM data_classes WHERE container_key = ?').bind('chart').first<{ id: number }>();
    const remove = await adminFetch(`/admin/audit/classes/${row?.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(remove.status).toBe(302);
    expect(await env.DB.prepare('SELECT id FROM data_classes').first()).toBeNull();

    // Turning recording on and off is itself recorded, or the policy could be
    // changed around a read without a trace.
    await expect.poll(async () => (await env.DB.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'data_class.%' ORDER BY seq",
    ).all<{ action: string }>()).results, { timeout: 2000 })
      .toEqual([{ action: 'data_class.set' }, { action: 'data_class.clear' }]);
  });

  it('rejects an unknown container kind rather than storing it', async () => {
    const response = await adminFetch('/admin/audit/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ container_kind: 'whatever', container_key: 'x', class: 'phi' }).toString(),
    });

    expect(response.headers.get('Location')).toBe('/admin/audit/classes?flash=audit.flash.invalid');
    expect(await env.DB.prepare('SELECT id FROM data_classes').first()).toBeNull();
  });
});
