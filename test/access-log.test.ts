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
      "SELECT target_count, target_id, target_ids, action FROM audit_events WHERE action = 'page.list'",
    ).all<ReadRow>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ action: 'page.list', target_count: 100, target_id: null });
    // Capped at 100 ids, with target_count staying authoritative.
    expect(JSON.parse(rows.results[0].target_ids ?? '[]')).toHaveLength(100);
    await expect.poll(async () => env.DB.prepare("SELECT target_count FROM audit_events WHERE action = 'page.count'").first()).toEqual({ target_count: 120 });
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

    await readRows().toHaveLength(2);
    const rows = (await env.DB.prepare(
      "SELECT action, query_fingerprint, detail, container_key, target_ids FROM audit_events WHERE event_class = 'read'",
    ).all<ReadRow>()).results;
    expect(rows.map(row => row.action).sort()).toEqual(['page.count', 'page.search']);
    expect(rows.every(row => /^[0-9a-f]{24}$/.test(row.query_fingerprint ?? ''))).toBe(true);
    // The whole point of the fingerprint: a search string in a CMS holding
    // regulated data is frequently the identifier being searched for.
    expect(JSON.stringify(rows)).not.toContain(term);
  });
});

describe('sensitive metadata lookups', () => {
  it('audits sensitive taxonomy associations on otherwise public page metadata', async () => {
    const [id] = await seedPages(1, 'article');
    await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (99, 'Sensitive', 'sensitive-tag', 'clinical')").run();
    await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (?, 99)').bind(id).run();
    await classify('taxonomy', 'clinical', 'phi');
    expect((await adminFetch('/admin/api/parent-pages')).status).toBe(200);
    await readRows().toEqual(expect.arrayContaining([expect.objectContaining({ action: 'page.lookup', container_key: 'clinical', data_class: 'phi', target_count: 1 })]));
  });

  it('refuses PHI live sync before upgrading the connection', async () => {
    const [id] = await seedPages(1, 'chart');
    await classify('page_type', 'chart', 'phi');
    const response = await adminFetch(`/admin/api/sync/${id}`, { headers: { Upgrade: 'websocket', Origin: 'http://localhost' } });
    expect(response.status).toBe(503);
  });

  it('records version preview/history separately from the current page read', async () => {
    const [id] = await seedPages(1, 'chart');
    await classify('page_type', 'chart', 'phi');
    await env.DB.prepare("INSERT INTO page_versions (id, page_id, lect, action) VALUES (987, ?, ?, 'update')").bind(id, JSON.stringify({ note: 'old secret' })).run();
    expect((await adminFetch(`/admin/pages/${id}/read?version=987`)).status).toBe(200);
    await readRows().toMatchObject([
      { action: 'page.read', data_class: 'phi' },
      { action: 'page.history', target_type: 'page_version', target_id: '987', data_class: 'phi' },
    ]);
  });

  it.each(['/admin/api/parent-pages', '/admin/api/pages/chart'])('audits page metadata at %s', async path => {
    await seedPages(1, 'chart');
    await classify('page_type', 'chart', 'phi');
    expect((await adminFetch(path)).status).toBe(200);
    await readRows().toMatchObject([{ action: 'page.lookup', container_key: 'chart', data_class: 'phi', target_count: 1 }]);
  });

  it('withholds lookup data if the PHI audit cannot be written', async () => {
    await seedPages(1, 'chart');
    await classify('page_type', 'chart', 'phi');
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      const response = await adminFetch('/admin/api/parent-pages');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('Page 500');
    } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  });

  it('audits user lookups under table classification', async () => {
    await classify('table', 'users', 'phi');
    expect((await adminFetch('/admin/api/users')).status).toBe(200);
    await readRows().toMatchObject([{ action: 'user.lookup', container_key: 'users', data_class: 'phi', target_count: 2 }]);
  });

  it('audits tag lookups against their actual taxonomy', async () => {
    await env.DB.prepare("INSERT INTO taxonomies (id, name, slug) VALUES (91, 'Diagnosis', 'diagnosis')").run();
    await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (92, 'Private diagnosis', 'private-diagnosis', 'diagnosis')").run();
    await classify('taxonomy', 'diagnosis', 'phi');
    expect((await adminFetch('/admin/api/tags/diagnosis')).status).toBe(200);
    await readRows().toMatchObject([{ action: 'tag.lookup', container_key: 'diagnosis', data_class: 'phi', target_count: 1 }]);
  });
});

describe('nested and administrative sensitive reads', () => {
  it('audits stored content returned by an invalid edit submission', async () => {
    const [id] = await seedPages(1, 'chart', 9200);
    await classify('page_type', 'chart', 'phi');
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      const response = await adminFetch(`/admin/pages/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: '', slug: '' }).toString(),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('Page 9200');
    } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  });

  it('retains every PHI identifier across bounded audit rows', async () => {
    const ids = await seedPages(120, 'chart', 9100);
    await classify('page_type', 'chart', 'phi');
    // Exercise the core helper with the same request scope used by routes;
    // dashboard pagination is intentionally capped at 100, so use its batch API.
    const { Hono } = await import('hono');
    const { requestContext } = await import('../src/core/http/request-context');
    const { accessLog, recordPageReads } = await import('../src/core/http/access-log');
    const app = new Hono();
    app.use('*', async (_, next) => { await requestContext.run({ cspNonce: '' }, () => next()); });
    app.use('*', accessLog);
    app.get('/', c => { recordPageReads('page.bulk-read', ids.map(id => ({ id, page_type: 'chart' }))); return c.json({ count: ids.length }); });
    expect((await app.request('http://localhost/', {}, env)).status).toBe(200);
    const rows = (await env.DB.prepare("SELECT target_ids, target_count FROM audit_events WHERE action = 'page.bulk-read' ORDER BY seq").all<ReadRow>()).results;
    expect(rows.map(row => row.target_count)).toEqual([100, 20]);
    expect(rows.flatMap(row => JSON.parse(row.target_ids ?? '[]'))).toEqual(ids.map(String));
  });

  it('audits a classified parent option on an unclassified child page', async () => {
    const [parent] = await seedPages(1, 'chart', 8100);
    const [child] = await seedPages(1, 'article', 8101);
    await env.DB.prepare('UPDATE pages SET page_id = ? WHERE id = ?').bind(parent, child).run();
    await classify('page_type', 'chart', 'phi');
    expect((await adminFetch(`/admin/pages/${child}/read?native=1`)).status).toBe(200);
    const rows = (await env.DB.prepare("SELECT action, target_id FROM audit_events WHERE event_class = 'read'").all()).results;
    expect(rows).toContainEqual({ action: 'page.parent-option', target_id: String(parent) });
  });

  it.each(['/admin/tags', '/admin/tags/8301/edit', '/admin/taxonomies/8300/edit', '/admin/pages/new?page_type=default'])('withholds classified nested taxonomy/tag data at %s on sink failure', async path => {
    await env.DB.prepare("INSERT INTO taxonomies (id, name, slug) VALUES (8300, 'Clinical labels', 'nested-clinical')").run();
    await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (8301, 'Sensitive label', 'nested-label', 'nested-clinical')").run();
    await classify('taxonomy', 'nested-clinical', 'phi');
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      const response = await adminFetch(path);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('Sensitive label');
    } finally {
      await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run();
      await env.DB.prepare('DELETE FROM tags WHERE id = 8301').run();
      await env.DB.prepare('DELETE FROM taxonomies WHERE id = 8300').run();
    }
  });

  it('inherits taxonomy classification from trash associations', async () => {
    await env.DB.prepare("INSERT INTO trash_pages (id, name, slug, page_type, lect) VALUES (8400, 'Trashed record', 'trash-record', 'article', '{}')").run();
    await env.DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (8401, 'Clinical', 'trash-clinical', 'trash-clinical')").run();
    await env.DB.prepare('INSERT INTO trash_page_tags (page_id, tag_id) VALUES (8400, 8401)').run();
    await classify('taxonomy', 'trash-clinical', 'phi');
    try {
      expect((await adminFetch('/admin/trash')).status).toBe(200);
      const rows = (await env.DB.prepare("SELECT action, container_key, target_id FROM audit_events WHERE event_class = 'read'").all()).results;
      expect(rows).toContainEqual({ action: 'page.trash-list', container_key: 'trash-clinical', target_id: '8400' });
    } finally {
      await env.DB.prepare('DELETE FROM trash_page_tags WHERE page_id = 8400').run();
      await env.DB.prepare('DELETE FROM trash_pages WHERE id = 8400').run();
      await env.DB.prepare('DELETE FROM tags WHERE id = 8401').run();
    }
  });

  it.each(['/admin/users', '/admin/users/2/edit'])('withholds classified user administration data at %s when auditing fails', async path => {
    await classify('table', 'users', 'phi');
    await env.DB.prepare('ALTER TABLE audit_events RENAME TO audit_events_away').run();
    try {
      const response = await adminFetch(path);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('editor@example.com');
    } finally { await env.DB.prepare('ALTER TABLE audit_events_away RENAME TO audit_events').run(); }
  });
});

describe('ePHI fails closed', () => {
  it.each([
    ['page_type', 'chart', 'unknown'],
    ['unknown', 'chart', 'phi'],
    ['page_type', ' ', 'phi'],
  ])('withholds reads for malformed policy %s/%s/%s', async (kind, key, value) => {
    const [id] = await seedPages(1, 'chart');
    await classify(kind, key, value);
    const response = await adminFetch(`/admin/pages/${id}/read`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Audit log unavailable');
  });

  it('withholds page data when classification cannot be resolved', async () => {
    const [id] = await seedPages(1, 'chart');
    await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
    try {
      const response = await adminFetch(`/admin/pages/${id}/read`);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('Audit log unavailable');
    } finally {
      await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run();
    }
  });

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

  it('classifies a container and refuses removal until governed declassification exists', async () => {
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
    expect(remove.status).toBe(409);
    expect(await env.DB.prepare('SELECT id FROM data_classes').first()).not.toBeNull();

    // No successful removal is invented for a refused transition.
    await expect.poll(async () => (await env.DB.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'data_class.%' ORDER BY seq",
    ).all<{ action: string }>()).results, { timeout: 2000 })
      .toEqual([{ action: 'data_class.set' }]);
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
