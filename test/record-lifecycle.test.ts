// W12 record lifecycle (A.8.10, A.5.33, A.5.34). One synthetic submission is
// followed from the published database through ingest, trash and purge, and
// must end erased in both databases with evidence of each step. Holds must stop
// every purge path, and the opt-in retention rules must do nothing until set.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { createAuthSession, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { ingestSubmissions } from '../src/core/db/submission-ingest';
import { eraseSubmissionSources } from '../src/core/pages/submission-erasure';
import { jobsServices } from '../src/features/jobs/services';
import type { Env } from '../src/types';

const admin = { id: 9921, email: 'lifecycle-admin@example.invalid', name: 'Lifecycle admin', role: 'admin' };
const editor = { id: 9922, email: 'lifecycle-editor@example.invalid', name: 'Lifecycle editor', role: 'editor' };
const SUBMISSION = '5ab0c0de-0000-4000-8000-00000000c0de';
let session: IssuedAuthTokens;
let requestNumber = 0;

async function request(path: string, form?: Record<string, string>, overrides: Partial<Env> = {}, tokens = session) {
  requestNumber++;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com/admin${path}`, {
    method: form ? 'POST' : 'GET', redirect: 'manual',
    headers: { Cookie: `__Host-access_token=${tokens.accessToken}`, 'Sec-Fetch-Site': 'same-origin', Origin: 'https://cms.example.com',
      'CF-Connecting-IP': `10.97.${Math.floor(requestNumber / 250)}.${requestNumber % 250 + 1}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const flash = (response: Response) => decodeURIComponent(new URL(response.headers.get('Location') ?? '', 'https://x').searchParams.get('flash') ?? '');

async function seedSubmission(uuid = SUBMISSION) {
  await env.PUBLISHED_DB.prepare(`INSERT INTO pages (uuid, created_at, name, slug, page_type, lect) VALUES (?, '2026-11-04 09:00:00', 'Guest', ?, 'rsvp', ?)`)
    .bind(uuid, `guest-${uuid.slice(0, 8)}`, JSON.stringify({ email: 'guest@example.invalid' })).run();
}
const draftId = async (uuid: string, table = 'pages') =>
  (await env.DB.prepare(`SELECT id FROM ${table} WHERE uuid = ?`).bind(uuid).first<{ id: number }>())?.id;
async function trashPage(uuid: string, id?: number) {
  id ??= await env.DB.prepare(`INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES (?, 'Page', ?, 'article', '{}') RETURNING id`)
    .bind(uuid, `p-${uuid}`).first<{ id: number }>().then((row) => row!.id);
  expect((await request(`/pages/${id}/delete`, {})).status).toBe(302);
  return (await draftId(uuid, 'trash_pages'))!;
}
const auditActions = async () => (await env.DB.prepare('SELECT action, detail FROM audit_events ORDER BY seq').all<{ action: string; detail: string }>()).results;
async function resetIngestCursor() { await env.DB.prepare("DELETE FROM settings WHERE key = 'submissions.ingest.cursor'").run(); }

beforeEach(async () => {
  clearRolePermissionsCache();
  for (const table of ['pages', 'trash_pages', 'record_holds', 'submission_erasures', 'admin_jobs', 'audit_events', 'audit_mutation_outbox', 'sessions']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetIngestCursor();
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  for (const user of [admin, editor]) {
    await env.DB.prepare(`INSERT INTO users (id, oauth_id, email, name, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = excluded.role`)
      .bind(user.id, `fixture:${user.id}`, user.email, user.name, user.role).run();
  }
  session = await createAuthSession(env, admin);
});

describe('submission lifecycle', () => {
  it('is mirrored, trashed without coming back, then purged and erased from the published database', async () => {
    await seedSubmission();
    await ingestSubmissions(env);
    const mirrorId = await draftId(SUBMISSION);
    expect(mirrorId).toBeDefined();

    const trashId = await trashPage(SUBMISSION, mirrorId);
    // The cursor wraps on every complete pass; a trashed mirror must not be re-created.
    await resetIngestCursor();
    await ingestSubmissions(env);
    expect(await draftId(SUBMISSION)).toBeUndefined();

    const purge = await request(`/trash/${trashId}/delete`, {});
    expect(flash(purge)).toBe('Page permanently deleted');
    expect(await draftId(SUBMISSION, 'trash_pages')).toBeUndefined();
    expect(await env.PUBLISHED_DB.prepare('SELECT 1 FROM pages WHERE uuid = ?').bind(SUBMISSION).first()).toBeNull();
    const erasure = await env.DB.prepare('SELECT erased_at FROM submission_erasures WHERE uuid = ?').bind(SUBMISSION).first<{ erased_at: string | null }>();
    expect(erasure?.erased_at).not.toBeNull();
    const purged = (await auditActions()).find((event) => event.action === 'page.purge');
    expect(JSON.parse(purged!.detail).source_erasures).toEqual([SUBMISSION]);

    // A published database restored from backup must not bring it back either.
    await seedSubmission();
    await resetIngestCursor();
    await ingestSubmissions(env);
    expect(await draftId(SUBMISSION)).toBeUndefined();
  });

  it('keeps the erasure pending when the published database is unreachable, and completes it later', async () => {
    await seedSubmission();
    await ingestSubmissions(env);
    const trashId = await trashPage(SUBMISSION, await draftId(SUBMISSION));
    const real = env.PUBLISHED_DB;
    const unreachable: Record<string, unknown> = {
      prepare: (sql: string) => real.prepare(sql),
      batch: () => Promise.reject(new Error('D1 unavailable')),
    };
    unreachable.withSession = () => unreachable;
    const purge = await request(`/trash/${trashId}/delete`, {}, { PUBLISHED_DB: unreachable as unknown as D1Database });
    expect(flash(purge)).toBe('Page permanently deleted');
    expect(await env.DB.prepare('SELECT erased_at FROM submission_erasures WHERE uuid = ?').bind(SUBMISSION).first()).toEqual({ erased_at: null });
    expect(await env.PUBLISHED_DB.prepare('SELECT 1 FROM pages WHERE uuid = ?').bind(SUBMISSION).first()).not.toBeNull();

    expect(await eraseSubmissionSources(env)).toBe(1);
    expect(await env.PUBLISHED_DB.prepare('SELECT 1 FROM pages WHERE uuid = ?').bind(SUBMISSION).first()).toBeNull();
  });

  it('leaves an ordinary page purge without an erasure record', async () => {
    const trashId = await trashPage('plain-page');
    await request(`/trash/${trashId}/delete`, {});
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM submission_erasures').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('holds', () => {
  it('refuses to purge a held page by hand, by empty trash and by retention, until released', async () => {
    const heldId = await trashPage('held-page');
    const otherId = await trashPage('other-page');
    expect(flash(await request('/holds', { uuid: 'held-page', reason: 'Litigation 2026-17', back: 'trash' }))).toBe('Hold placed');

    expect(flash(await request(`/trash/${heldId}/delete`, {}))).toBe('Page is under hold and was not deleted');
    expect(await draftId('held-page', 'trash_pages')).toBe(heldId);
    const holds = await request('/holds');
    expect(holds.status).toBe(200);
    expect(await holds.text()).toContain('Litigation 2026-17');
    // The admin renders in the browser; the page carries the props its view uses.
    const trash = await (await request('/trash')).text();
    expect(trash).toContain('"canHold":true');
    expect(trash).toMatch(/"uuid":"held-page","held":true/);
    expect(trash).toMatch(/"uuid":"other-page","held":false/);

    await env.DB.prepare("UPDATE trash_pages SET updated_at = datetime('now', '-40 days')").run();
    await request('/trash/empty', { action: 'expired' }, { TRASH_RETENTION_DAYS: '30' });
    await request('/trash/empty', { action: 'now' });
    expect(await draftId('held-page', 'trash_pages')).toBe(heldId);
    expect(await draftId('other-page', 'trash_pages')).toBeUndefined();
    expect(otherId).toBeDefined();

    const hold = await env.DB.prepare('SELECT id FROM record_holds WHERE page_uuid = ?').bind('held-page').first<{ id: number }>();
    expect(flash(await request(`/holds/${hold!.id}/release`, {}))).toBe('Hold released');
    await request(`/trash/${heldId}/delete`, {});
    expect(await draftId('held-page', 'trash_pages')).toBeUndefined();

    const actions = (await auditActions()).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['hold.place', 'hold.release']));
    const released = await env.DB.prepare('SELECT placed_by, released_by, released_at FROM record_holds WHERE id = ?').bind(hold!.id).first();
    expect(released).toMatchObject({ placed_by: admin.id, released_by: admin.id });
  });

  it('keeps a parent whose purge would cascade to a held child', async () => {
    const parentId = await trashPage('parent-page');
    await env.DB.prepare("INSERT INTO trash_pages (uuid, name, slug, page_type, lect, page_id) VALUES ('held-child', 'Child', 'held-child', 'article', '{}', ?)")
      .bind(parentId).run();
    await request('/holds', { uuid: 'held-child', reason: 'Audit' });
    await request('/trash/empty', { action: 'now' });
    expect(await draftId('parent-page', 'trash_pages')).toBe(parentId);
    expect(flash(await request(`/trash/${parentId}/delete`, {}))).toBe('Page is under hold and was not deleted');
  });

  it('can be placed before a page is deleted', async () => {
    await request('/holds', { uuid: 'live-page', reason: 'Records request' });
    const trashId = await trashPage('live-page');
    expect(flash(await request(`/trash/${trashId}/delete`, {}))).toBe('Page is under hold and was not deleted');
  });

  it('cannot be placed or released without records:hold', async () => {
    const editorSession = await createAuthSession(env, editor);
    expect((await request('/holds', { uuid: 'any-page', reason: 'x' }, {}, editorSession)).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM record_holds').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('retention', () => {
  it('offers no expiry purge until TRASH_RETENTION_DAYS is set, then purges only older pages', async () => {
    const oldId = await trashPage('old-page');
    await trashPage('new-page');
    // Seed historical age without the refresh trigger undoing it at a clock
    // boundary. Restore the real trigger before exercising retention routes.
    const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trash_pages_updated_at'").first<{ sql: string }>();
    await env.DB.prepare('DROP TRIGGER trash_pages_updated_at').run();
    try { await env.DB.prepare("UPDATE trash_pages SET updated_at = datetime('now', '-40 days') WHERE id = ?").bind(oldId).run(); }
    finally { await env.DB.prepare(trigger!.sql).run(); }

    expect(flash(await request('/trash/empty', { action: 'expired' }))).toBe('No trash retention period is set');
    expect(await draftId('old-page', 'trash_pages')).toBe(oldId);

    expect(flash(await request('/trash/empty', { action: 'expired' }, { TRASH_RETENTION_DAYS: '30' }))).toBe('Purged 1 expired page');
    expect(await draftId('old-page', 'trash_pages')).toBeUndefined();
    expect(await draftId('new-page', 'trash_pages')).toBeDefined();
    const purge = (await auditActions()).find((event) => event.action === 'page.purge_all');
    expect(JSON.parse(purge!.detail).retention_days).toBe(30);
  });

  it('clears finished job bodies only once JOB_RETENTION_DAYS is set', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    for (const [id, status, at] of [['old-done', 'done', old], ['old-failed', 'failed', old], ['old-queued', 'queued', old], ['new-done', 'done', recent]]) {
      await env.DB.prepare(`INSERT INTO admin_jobs (id, type, status, body, user_json, created_at, updated_at)
        VALUES (?, 'plugin_admin_action', ?, 'name=Guest&email=guest@example.invalid', '{"sub":"1"}', ?, ?)`).bind(id, status, at, at).run();
    }
    expect(await jobsServices.scheduled!({ ...env } as Env)).toBeNull();
    expect(await jobsServices.scheduled!({ ...env, JOB_RETENTION_DAYS: '30' } as Env)).toBe('job retention: cleared 2');
    const rows = (await env.DB.prepare('SELECT id, status, body, user_json FROM admin_jobs ORDER BY id').all()).results;
    expect(rows).toEqual([
      { id: 'new-done', status: 'done', body: 'name=Guest&email=guest@example.invalid', user_json: '{"sub":"1"}' },
      { id: 'old-done', status: 'done', body: null, user_json: null },
      { id: 'old-failed', status: 'failed', body: null, user_json: null },
      { id: 'old-queued', status: 'queued', body: 'name=Guest&email=guest@example.invalid', user_json: '{"sub":"1"}' },
    ]);
  });
});
