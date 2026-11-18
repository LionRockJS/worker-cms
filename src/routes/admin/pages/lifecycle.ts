import { requestPageAllowed } from '../../../core/auth/page-access';
import { Hono } from 'hono';
import { announcePageEvent } from '../../../core/page-events';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { contextActor } from '../../../core/db/audit';
import { publication, requireTrashLifecycle } from '../../../features/services';

export const pageLifecycleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Delete page → move to TRASH (soft-delete) ────────────────────────────────

pageLifecycleRoutes.post('/pages/:id/delete', requirePermission('content:delete'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  if (!await requestPageAllowed(c, pageId, 'write', true)) return c.notFound();

  // Commit the local transfer and exact receipt before external withdrawal.
  const result = await requireTrashLifecycle().mutatePageLifecycle(c.env,c.get('user'),'trash',{ids:[pageId]},{request:c});
  const page=result.pages[0];
  if (!page) return c.notFound();

  // Unpublish from every publish target now that the draft copy is gone.
  await publication()?.unpublishPageFromTargets(c.env, page.uuid, !!page.submission_origin, contextActor(c));

  announcePageEvent(c, 'delete', {
    id: page.id,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  },{durableEvidence:true});

  return c.redirect('/admin?flash=Page+moved+to+trash');
});
