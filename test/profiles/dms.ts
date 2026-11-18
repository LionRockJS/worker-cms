import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../../src/index';
import { featureInstalled } from '../../src/features';
import { createAdvancedSearchBulkActionJob } from '../../src/features/jobs/queue';
import { verifyJWT } from '../../src/core/auth/jwt';
import { signJWT } from '../auth-fixtures';

it('runs the internal document lifecycle with no published database or bucket', async () => {
  expect(env.PUBLISHED_DB).toBeUndefined();
  expect(env.PUBLISH_BUCKET).toBeUndefined();
  expect(featureInstalled('publish')).toBe(false);
  expect((await env.VIEWS.fetch('https://views.local/assets/publish-editor.js')).status).toBe(404);
  const layout = await (await env.VIEWS.fetch('https://views.local/layout/default.liquid')).text();
  expect(layout).toContain('input.value = row.weight');
  expect(layout).not.toContain('data-weight-drift');
  for (const feature of ['jobs', 'plugins', 'search', 'trash']) {
    expect(featureInstalled(feature)).toBe(true);
  }
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'submission_erasures'").first()).toBeNull();

  const token = await signJWT({
    sub: '1', email: 'dms@example.com', name: 'DMS Admin', role: 'admin', type: 'access',
    exp: Math.floor(Date.now() / 1000) + 900,
  }, env.JWT_SECRET);
  let requestCount = 0;
  async function request(path: string, method = 'GET', pairs: string[][] = []) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
      method,
      headers: {
        Cookie: `access_token=${token}`,
        Origin: 'https://cms.example.com',
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': `10.80.0.${++requestCount}`,
      },
      body: method === 'POST' ? new URLSearchParams(pairs) : undefined,
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function view(path: string) {
    const response = await request(path);
    expect(response.status, path).toBe(200);
    const payload = (await response.text()).match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s)?.[1];
    expect(payload, path).toBeDefined();
    return JSON.parse(payload!).bodyView.data;
  }

  expect((await request('/admin/tags', 'POST', [['name', 'Internal']])).status).toBe(302);
  const tag = await env.DB.prepare("SELECT id FROM tags WHERE slug = 'internal'").first<{id: number}>();
  expect((await request('/admin/pages', 'POST', [
    ['name', 'Private record'], ['slug', 'private-record'], ['page_type', 'default'],
    ['start', '2030-01-01T08:00'], ['end', '2030-01-02T08:00'], ['timezone', '+0800'],
    ['tag_ids', String(tag!.id)],
  ])).status).toBe(302);
  const page = await env.DB.prepare("SELECT id, start, end, timezone FROM pages WHERE slug = 'private-record'").first();
  expect(page).not.toBeNull();
  const id = Number(page!.id);
  const edit = `/admin/pages/${id}`;
  expect(await view('/admin?status=live')).toMatchObject({
    publishEnabled: false, hasStatusFilters: false, pages: [{ name: 'Private record' }],
  });
  expect(await view(`${edit}/edit`)).toMatchObject({
    publishEnabled: false, isPublished: false, isLiveSynced: false, publicationStatus: 'draft',
  });
  expect(await view('/admin/tags')).toMatchObject({ canSync: false });
  expect(await view('/admin/advanced-search?search1=Private')).toMatchObject({
    publishEnabled: false, pages: [{ name: 'Private record' }],
  });

  const unsupported = [
    `${edit}/publish`, `${edit}/unpublish`, '/admin/pages/pull/missing',
    '/admin/tags/sync-published', '/__cms/pages/publish', '/__cms/ingest/submissions',
  ];
  for (const path of unsupported) expect((await request(path, 'POST')).status, path).toBe(404);
  const pluginAuth = await request('/__cms/pages');
  expect(pluginAuth.status).toBe(400);
  expect(await pluginAuth.json()).toEqual({ error: 'missing_plugin_id' });

  for (const action of ['publish', 'unpublish']) {
    expect((await request('/admin/advanced-search/bulk', 'POST', [
      ['bulk_action', action], ['page_ids', String(id)],
    ])).status).toBe(404);
  }
  expect((await request(edit, 'POST', [['name', 'Forged'], ['slug', 'forged'], ['action', 'publish']])).status).toBe(404);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_jobs').first('count')).toBe(0);
  expect(await env.DB.prepare('SELECT name FROM pages WHERE id = ?').bind(id).first('name')).toBe('Private record');

  const user = (await verifyJWT(token, env.JWT_SECRET))!;
  const job = await createAdvancedSearchBulkActionJob(env.DB, {
    action: 'publish', scope: 'selected', ids: [id], criteria: [], operator: 'and',
    pageTypes: ['default'], targetTagIds: [], searchText: '', replacementText: '', returnTo: '/admin', user,
  });
  await worker.queue({ messages: [{ body: { kind: 'cms_admin_job', jobId: job.id } }] } as MessageBatch<unknown>, env);
  expect(await env.DB.prepare('SELECT status, attempts FROM admin_jobs WHERE id = ?').bind(job.id).first())
    .toEqual({ status: 'failed', attempts: 1 });

  expect((await request(edit, 'POST', [
    ['name', 'Updated record'], ['slug', 'private-record'], ['tag_ids', String(tag!.id)],
  ])).status).toBe(302);
  expect(await env.DB.prepare('SELECT id, start, end, timezone FROM pages WHERE id = ?').bind(id).first()).toEqual(page);
  expect(await view('/admin/pages/list')).toMatchObject({ pages: [{ name: 'Updated record', isPublished: false }] });
  expect(await env.DB.prepare('SELECT COUNT(*) FROM page_versions WHERE page_id = ?').bind(id).first('COUNT(*)')).toBe(2);

  expect((await request(`${edit}/delete`, 'POST')).status).toBe(302);
  expect(await env.DB.prepare('SELECT id FROM trash_pages WHERE id = ?').bind(id).first('id')).toBe(id);
  expect((await request(`/admin/trash/${id}/restore`, 'POST')).status).toBe(302);
  expect(await env.DB.prepare('SELECT name FROM pages WHERE id = ?').bind(id).first('name')).toBe('Updated record');

  // Older records can still carry an obligation to erase their public source.
  await env.DB.prepare("UPDATE page_versions SET action = 'ingest-submission' WHERE page_id = ?")
    .bind(id).run();
  expect((await request(`${edit}/delete`, 'POST')).status).toBe(302);
  expect((await request(`/admin/trash/${id}/delete`, 'POST')).status).toBe(503);
  expect(await env.DB.prepare('SELECT id FROM trash_pages WHERE id = ?').bind(id).first('id')).toBe(id);

  const ctx = createExecutionContext();
  await worker.scheduled({} as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
});
