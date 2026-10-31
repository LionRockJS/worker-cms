// GET /limits — the calling plugin's effective creation limits and usage.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin } from './auth';
import { asFiniteNumber } from './serialize';
import { countLimitUsage, effectiveLimitsForPlugin } from '../limits';
import { recordRead } from '../../../core/http/access-log';
import { pluginReadActor } from './read-audit';

export const limitsApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Routes ────────────────────────────────────────────────────────────────────

// The calling plugin's declared limits with effective values and current
// usage — read-only, for plugin UIs to show quotas ("1,240 / 2,000 guests")
// and pre-warn before bulk actions. Scoped usage needs the scope value:
// pass ?page_id= for per_parent limits and ?pointer_value= for per_pointer
// limits; without it those report usage: null. Enforcement stays host-side
// regardless of what a plugin does with this data.
limitsApiRoutes.get('/limits', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const limits = await effectiveLimitsForPlugin(c.env, auth.plugin);
  const pointerValue = (c.req.query('pointer_value') ?? '').trim();
  const parentId = asFiniteNumber(c.req.query('page_id'));
  const actor = pluginReadActor(c, auth.pluginId);

  const out = [];
  for (const limit of limits) {
    let usage: number | null = null;
    if (limit.def.scope === 'total') {
      usage = await countLimitUsage(c.env.DB, limit.def, null);
    } else if (limit.def.scope === 'per_parent' && parentId !== null) {
      usage = await countLimitUsage(c.env.DB, limit.def, parentId);
    } else if (limit.def.scope === 'per_pointer' && pointerValue) {
      usage = await countLimitUsage(c.env.DB, limit.def, pointerValue);
    }
    out.push({
      key: limit.def.key,
      label: limit.def.label,
      description: limit.def.description,
      page_type: limit.def.pageType,
      scope: limit.def.scope,
      pointer_key: limit.def.pointerKey,
      value: limit.value,
      configured: limit.configured,
      usage,
    });
  }

  if (out.length) recordRead({ action: 'plugin.limits-read', kind: 'plugin', key: auth.pluginId, targetType: 'plugin_limit', ids: out.map(limit => limit.key), count: out.length, actor });
  return c.json({ limits: out });
});
