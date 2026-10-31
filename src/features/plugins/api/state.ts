// GET/PUT/DELETE /state — host-owned key/value storage for the calling plugin.
//
// The plugin names only the key: the plugin id comes from the authenticated
// caller, never from the request, so one plugin cannot address another's
// entries even by guessing. See ../state.ts for why this lives on the host
// rather than in the plugin's own KV.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { recordRead, recordTableReads } from '../../../core/http/access-log';
import { actingUserId } from './create';
import type { AppContext } from '../../../core/http/context';
import { authenticatePlugin } from './auth';
import {
  MAX_STATE_KEYS_PER_PLUGIN,
  MAX_STATE_VALUE_BYTES,
  countPluginStateKeys,
  deletePluginState,
  getPluginState,
  isValidStateKey,
  listPluginState,
  putPluginState,
  stateValueBytes,
} from '../state';

export const stateApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function recordStateRead(c: AppContext, pluginId: string, action: string, keys: string[]): void {
  const userId = actingUserId(c);
  const actor = { userId: userId === null ? null : String(userId), roles: null, sessionSid: null, via: pluginId };
  recordRead({ action, kind: 'plugin', key: pluginId, targetType: 'plugin_state', ids: keys, count: keys.length, actor });
  recordTableReads(action, 'plugin_state', keys, actor);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Every entry this plugin owns, optionally narrowed with ?prefix=. Values are
// returned exactly as they were stored.
stateApiRoutes.get('/state', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const prefix = (c.req.query('prefix') ?? '').trim();
  if (prefix && !isValidStateKey(prefix)) return c.json({ error: 'invalid_prefix' }, 400);

  const entries = await listPluginState(c.env.DB, auth.plugin.manifest.id, prefix);
  recordStateRead(c, auth.pluginId, 'state.list', entries.map(entry => entry.key));
  return c.json({ state: entries });
});

// A single entry. 404 rather than an empty value, so "never written" and
// "written as empty" stay distinguishable to the caller.
stateApiRoutes.get('/state/:key', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = c.req.param('key');
  if (!isValidStateKey(key)) return c.json({ error: 'invalid_key' }, 400);

  const entry = await getPluginState(c.env.DB, auth.plugin.manifest.id, key);
  if (!entry) return c.json({ error: 'not_found' }, 404);
  recordStateRead(c, auth.pluginId, 'state.read', [entry.key]);
  return c.json({ key: entry.key, value: entry.value, updated_at: entry.updated_at });
});

// Store an entry. `value` is JSON the CMS keeps opaque; it is re-serialized
// here only to normalize what gets stored, never inspected.
stateApiRoutes.put('/state/:key', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = c.req.param('key');
  if (!isValidStateKey(key)) return c.json({ error: 'invalid_key' }, 400);

  const body = await c.req.json().catch(() => null) as { value?: unknown } | null;
  if (!body || typeof body !== 'object' || !('value' in body)) {
    return c.json({ error: 'missing_value' }, 400);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(body.value);
  } catch {
    return c.json({ error: 'unserializable_value' }, 400);
  }
  // JSON.stringify(undefined) is undefined, which is not a storable value.
  if (typeof serialized !== 'string') return c.json({ error: 'missing_value' }, 400);
  if (stateValueBytes(serialized) > MAX_STATE_VALUE_BYTES) {
    return c.json({ error: 'value_too_large', max_bytes: MAX_STATE_VALUE_BYTES }, 413);
  }

  // The cap counts distinct keys, so overwriting an existing one is always
  // allowed even at the limit — only a NEW key can be refused.
  const existing = await getPluginState(c.env.DB, auth.plugin.manifest.id, key);
  if (!existing && await countPluginStateKeys(c.env.DB, auth.plugin.manifest.id) >= MAX_STATE_KEYS_PER_PLUGIN) {
    return c.json({ error: 'too_many_keys', max_keys: MAX_STATE_KEYS_PER_PLUGIN }, 409);
  }

  await putPluginState(c.env.DB, auth.plugin.manifest.id, key, serialized);
  return c.json({ ok: true, key });
});

// Removing an entry that was never there is a success: callers disconnecting
// something should not have to know whether it was ever connected.
stateApiRoutes.delete('/state/:key', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = c.req.param('key');
  if (!isValidStateKey(key)) return c.json({ error: 'invalid_key' }, 400);

  await deletePluginState(c.env.DB, auth.plugin.manifest.id, key);
  return c.json({ ok: true, key });
});
