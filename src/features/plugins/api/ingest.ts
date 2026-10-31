// POST /ingest/submissions — pull live-only submission rows into draft pages
// on demand, the same bounded batch the cron tick runs.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin } from './auth';
import { ingestSubmissions } from '../../../core/db/submission-ingest';

export const ingestApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// required. The run is idempotent and never mutates published rows.
ingestApiRoutes.post('/ingest/submissions', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  if (!(auth.plugin.manifest.hooks ?? []).includes('submission')) {
    return c.json({ error: 'submission_hook_required' }, 403);
  }

  const result = await ingestSubmissions(c.env, { userId: null, roles: null, sessionSid: null, via: auth.pluginId });
  return c.json({ ok: true, ...result });
});

// Soft-delete a page to trash.
