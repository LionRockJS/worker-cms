import { Hono } from 'hono';
import type { Env, Page, Variables } from '../../../types';
import { publication } from '../../services';
import { authenticatePlugin } from '../api/auth';
import { emitPluginHooks } from '../api/hooks';
import { pluginReadActor as apiActor } from '../api/read-audit';
import { asPositiveSafeInteger } from '../api/serialize';
import type { HookPage } from '../hooks';
import { pageTypeScopeAllows } from '../page-types';

export const basePath = '/__cms';
export const requiresFeature = 'publish';
export const pluginPublishRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_BATCH = 100;

// Publish draft pages to every configured target. This is intentionally a
// bounded, id-only operation: the caller cannot supply a page type or snapshot
// to smuggle content across its manifest scope, and every id is resolved from
// this tenant's draft DB before the existing publish pipeline builds the live
// snapshot.
pluginPublishRoutes.post('/pages/publish', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const rawIds = body && Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds) return c.json({ error: 'invalid_body' }, 400);
  if (rawIds.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const candidates: Array<{ index: number; id: number }> = [];
  const errors: Array<{ index: number; id?: number; error: string; page_type?: string; failed_targets?: string[] }> = [];
  const seenIds = new Set<number>();
  for (let index = 0; index < rawIds.length; index++) {
    const id = asPositiveSafeInteger(rawIds[index]);
    if (id === null) {
      errors.push({ index, error: 'invalid_id' });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ index, id, error: 'duplicate_id' });
      continue;
    }
    seenIds.add(id);
    candidates.push({ index, id });
  }

  const pageById = new Map<number, Page>();
  if (candidates.length) {
    const ids = candidates.map((candidate) => candidate.id);
    const pages = await c.env.DB.prepare(
      `SELECT * FROM pages WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<Page>();
    for (const page of pages.results) pageById.set(page.id, page);
  }

  const publishable: Array<{ index: number; page: Page }> = [];
  for (const candidate of candidates) {
    const page = pageById.get(candidate.id);
    if (!page) {
      errors.push({ index: candidate.index, id: candidate.id, error: 'not_found' });
      continue;
    }
    const pageType = page.page_type ?? '';
    if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) {
      errors.push({ index: candidate.index, id: candidate.id, error: 'forbidden_page_type', page_type: pageType });
      continue;
    }
    publishable.push({ index: candidate.index, page });
  }

  // One batched fan-out for the whole request rather than a publish per id: the
  // per-page helper costs about six round trips each, which a MAX_BATCH request
  // multiplies straight into the subrequest budget. Per-id outcomes are still
  // reported — the batched call hands back which pages it refused, and target
  // failures apply to the slice.
  const publishing = publication();
  if (!publishing) return c.notFound();
  const outcome = await publishing.publishPagesToTargets(c.env, publishable.map((item) => item.page), apiActor(c, auth.pluginId));
  if (outcome.refusedReason === 'writes_unavailable') {
    return c.json({ error: 'regulated_writes_unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
  const refusedIds = new Set(outcome.refused.map((page) => page.id));
  const regulatedIds = new Set(outcome.refusedRegulated.map((page) => page.id));

  const published: number[] = [];
  const hookPages: HookPage[] = [];
  for (const item of publishable) {
    if (refusedIds.has(item.page.id)) {
      errors.push({
        index: item.index,
        id: item.page.id,
        error: regulatedIds.has(item.page.id) ? 'regulated_publish_refused' : 'submission_publish_refused',
      });
      continue;
    }
    if (!outcome.targets.length) {
      errors.push({ index: item.index, id: item.page.id, error: 'no_publish_targets' });
      continue;
    }

    // Mirror the admin publish route: a partial target failure is observable
    // through the publish hook/audit, but is still returned as an error so a
    // caller such as EDM delivery cannot mint a link to incomplete live data.
    hookPages.push({
      id: item.page.id,
      uuid: item.page.uuid,
      page_type: item.page.page_type,
      name: item.page.name,
      slug: item.page.slug,
    });
    if (outcome.failures.length) {
      errors.push({
        index: item.index,
        id: item.page.id,
        error: 'publish_failed',
        failed_targets: outcome.failures,
      });
      continue;
    }
    published.push(item.page.id);
  }

  emitPluginHooks(c, 'publish', hookPages, auth.pluginId);
  errors.sort((a, b) => a.index - b.index);
  return c.json({ published, errors, count: published.length });
});

// Pull live-only submissions into private records in a bounded, idempotent batch.
pluginPublishRoutes.post('/ingest/submissions', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  if (!(auth.plugin.manifest.hooks ?? []).includes('submission')) {
    return c.json({ error: 'submission_hook_required' }, 403);
  }

  const publishing = publication();
  if (!publishing) return c.notFound();
  const result = await publishing.ingestSubmissions(c.env, { userId: null, roles: null, sessionSid: null, via: auth.pluginId });
  return c.json({ ok: true, ...result });
});
