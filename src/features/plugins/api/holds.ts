// POST /holds — place or lengthen record holds on the calling plugin's own
// pages (owned or approved-write types). See ../hold-evidence.ts.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin } from './auth';
import { MAX_HOLDS, placePluginHolds, readHoldInputs } from '../hold-evidence';

export const holdsApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

holdsApiRoutes.post('/holds', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const holds = readHoldInputs(await c.req.json().catch(() => null));
  if (!holds) return c.json({ error: 'invalid_body', max: MAX_HOLDS }, 400);
  return c.json({ holds: await placePluginHolds(c, auth, holds) });
});
