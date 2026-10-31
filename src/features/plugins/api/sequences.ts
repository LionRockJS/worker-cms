// GET /sequences/:key and POST /sequences/:key/next — atomic counters for the
// calling plugin. As with /state, the plugin id comes from the authenticated
// caller, so one plugin cannot advance another's counters.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin } from './auth';
import { recordRead, recordTableReads } from '../../../core/http/access-log';
import { pluginReadActor } from './read-audit';
import type { AppContext } from '../../../core/http/context';
import {
  MAX_SEQUENCES_PER_PLUGIN,
  countPluginSequences,
  getPluginSequence,
  isValidSequenceKey,
  nextPluginSequence,
} from '../sequences';

export const sequencesApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function announceSequence(c: AppContext, pluginId: string, key: string): void {
  const actor = pluginReadActor(c, pluginId);
  recordTableReads('sequence.read', 'plugin_sequences', [`${pluginId}:${key}`], actor);
  recordRead({ action: 'sequence.read', kind: 'plugin', key: pluginId, targetType: 'plugin_sequence', ids: [key], count: 1, actor });
}

// The last value handed out; 0 when the counter was never advanced.
sequencesApiRoutes.get('/sequences/:key', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = c.req.param('key');
  if (!isValidSequenceKey(key)) return c.json({ error: 'invalid_key' }, 400);

  const value = await getPluginSequence(c.env.DB, auth.pluginId, key);
  announceSequence(c, auth.pluginId, key);
  return c.json({ key, value });
});

// Advances and returns the new value. Only a NEW counter is refused at the cap.
sequencesApiRoutes.post('/sequences/:key/next', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = c.req.param('key');
  if (!isValidSequenceKey(key)) return c.json({ error: 'invalid_key' }, 400);

  const pluginId = auth.plugin.manifest.id;
  if (await getPluginSequence(c.env.DB, pluginId, key) === 0
    && await countPluginSequences(c.env.DB, pluginId) >= MAX_SEQUENCES_PER_PLUGIN) {
    return c.json({ error: 'too_many_sequences', max_sequences: MAX_SEQUENCES_PER_PLUGIN }, 409);
  }

  const value = await nextPluginSequence(c.env.DB, pluginId, key);
  announceSequence(c, pluginId, key);
  return c.json({ key, value });
});
