// Publish / pull / unpublish / delete — moving a page between the draft and
// published stores, and soft-deleting it to trash.

import { Hono } from 'hono';
import { announcePageEvent } from '../../../core/page-events';
import type { Env, Variables } from '../../../types';
import { appendQuery, safeAdminReturnPath } from '../../../core/http/forms';
import { trashDraftPage } from '../../../core/db/admin-queries';
import { describeFailures, publishPageToTargets, unpublishPageFromTargets } from '../../../core/publish';
import type { PublishOutcome } from '../../../core/publish';
import { requirePermission } from '../../../core/auth/guards';
import { pullPublishedPageToDraft } from '../../../core/db/page-store';
import { isSubmissionMirror } from '../../../core/db/submission-ingest';
import { contextActor } from '../../../core/db/audit';


export const pageLifecycleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// with the targets that failed (failures are already logged by the registry).
export function publishFlash(outcome: PublishOutcome): string {
  if (outcome.refusedReason === 'writes_unavailable') {
    return encodeURIComponent('Publication is unavailable while regulated writes are contained');
  }
  if (outcome.refusedReason === 'regulated') {
    return encodeURIComponent('This page holds regulated data and cannot be published');
  }
  if (outcome.refusedReason === 'classification_unavailable') {
    return encodeURIComponent('Not published: the data classification could not be read, so regulated data cannot be ruled out');
  }
  if (outcome.refused) return encodeURIComponent('Submission pages cannot be published — they mirror source data from the published database');
  const failed = describeFailures(outcome);
  if (!failed) return 'Page+published+successfully';
  return encodeURIComponent(`Page published, but these targets failed: ${failed}`);
}

// ── Publish (DRAFT → PUBLISHED) ───────────────────────────────────────────────

pageLifecycleRoutes.post('/pages/:id/publish', requirePermission('content:publish'), async (c) => {
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

pageLifecycleRoutes.post('/pages/pull/:uuid', requirePermission('content:write'), async (c) => {
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

pageLifecycleRoutes.post('/pages/:id/unpublish', requirePermission('content:publish'), async (c) => {
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

// ── Delete page → move to TRASH (soft-delete) ────────────────────────────────

pageLifecycleRoutes.post('/pages/:id/delete', requirePermission('content:delete'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  // Copy the page (and its version + tag history) into trash, preserving ids so
  // a later restore keeps the same identity. Shared with the plugin write-back
  // API so the trash schema lives in one place.
  const page = await trashDraftPage(c.env.DB, pageId);
  if (!page) return c.notFound();

  // Unpublish from every publish target now that the draft copy is gone.
  await unpublishPageFromTargets(c.env, page.uuid, !!page.submission_origin, contextActor(c));

  announcePageEvent(c, 'delete', {
    id: page.id,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect('/admin?flash=Page+moved+to+trash');
});
