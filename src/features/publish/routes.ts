import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { announcePageEvent } from '../../core/page-events';
import { appendQuery, safeAdminReturnPath } from '../../core/http/forms';
import { requirePermission } from '../../core/auth/guards';
import { contextActor, logAudit } from '../../core/db/audit';
import { publishFlash, publishPageToTargets, publishTagsToTargets, unpublishPageFromTargets } from './index';
import { pullPublishedPageToDraft } from './pull';
import { isSubmissionMirror } from './submission-mirrors';

export const publishRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Publish (DRAFT → PUBLISHED) ───────────────────────────────────────────────

publishRoutes.post('/pages/:id/publish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));
  const outcome = await publishPageToTargets(c.env, pageId, contextActor(c));
  if (!outcome) return c.notFound();

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!outcome.refused) {
    announcePageEvent(c, 'publish', {
      id: pageId,
      uuid: page?.uuid,
      name: page?.name,
      slug: page?.slug,
      page_type: page?.page_type,
    });
  }

  return c.redirect(appendQuery(backHref, `flash=${publishFlash(outcome)}`));
});

// ── Pull published page (PUBLISHED → DRAFT) ───────────────────────────────────

publishRoutes.post('/pages/pull/:uuid', requirePermission('content:write'), async (c) => {
  const result = await pullPublishedPageToDraft(c.env, c.req.param('uuid'), contextActor(c));
  if (!result) return c.notFound();

  if (result.created) {
    announcePageEvent(c, 'submission', {
      id: result.page.id,
      uuid: result.page.uuid,
      page_type: result.page.page_type,
      name: result.page.name,
      slug: result.page.slug,
    });
  }

  const flash = result.created ? 'Published+page+pulled+to+draft' : 'Draft+already+exists';
  return c.redirect(`/admin/pages/${result.page.id}/edit?flash=${flash}`);
});

// ── Unpublish (remove from published DB) ──────────────────────────────────────

publishRoutes.post('/pages/:id/unpublish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!page) return c.notFound();

  const outcome = await unpublishPageFromTargets(c.env, page.uuid, await isSubmissionMirror(c.env.DB, pageId), contextActor(c));

  announcePageEvent(c, 'unpublish', {
    id: pageId,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  const problems = [outcome.failures.length ? 'some targets could not be withdrawn' : '',
    outcome.auditFailures?.length ? 'audit evidence incomplete' : ''].filter(Boolean);
  const flash = problems.length ? encodeURIComponent(`Withdrawal requested; ${problems.join('; ')}`) : 'Page+unpublished';
  return c.redirect(appendQuery(backHref, `flash=${flash}`));
});

// Backfills the published tag catalogue. A database that published pages before
// the catalogue existed has tag links whose ids resolve to nothing there; edits
// push one tag at a time, this pushes the lot.
publishRoutes.post('/tags/sync-published', requirePermission('tag:write'), async (c) => {
  const outcome = await publishTagsToTargets(c.env, undefined, contextActor(c));
  logAudit(c, 'tag.sync-published', 'tag', undefined, { count: outcome.count, failures: outcome.failures });
  const error = outcome.refusedReason === 'writes_unavailable' ? 'Publication is unavailable while regulated writes are contained'
    : outcome.refusedReason === 'classification_unavailable' ? 'Tag classification unavailable'
    : outcome.refusedCount ? `${outcome.refusedCount} regulated tags withheld`
    : outcome.failures.join(',');
  const status = error ? `error=${encodeURIComponent(error)}` : `synced=${outcome.count}`;
  return c.redirect(`/admin/tags?${status}`);
});
