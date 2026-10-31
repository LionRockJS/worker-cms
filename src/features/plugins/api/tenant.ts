// ============================================================
// Tenant enrollment claim — plugin → CMS, mounted at /__cms.
//
// The one CMS endpoint a plugin may call BEFORE it holds a secret. It is not
// open: the caller must present a single-use ticket this CMS minted moments
// earlier for that exact plugin (see utils/plugin-enroll.ts), and the ticket
// only ever travelled to the plugin's registered HTTPS URL. Redeeming it
// returns the pairwise secret once and destroys the ticket.
//
// Deliberately outside the /admin auth stack (server-to-server, no user, no
// cookies) — like the rest of /__cms, possession of a credential is the
// authenticator, not browser provenance.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { pluginById } from '../registry';
import { pluginTenantId } from '../proxy';
import { claimEnrollmentTicket, manifestAllowsAutoTenant } from '../enroll';
import { auditPluginManagement } from '../disclosure-audit';

export const cmsTenantRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const TICKET_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const NO_STORE = { 'cache-control': 'no-store' } as const;

cmsTenantRoutes.post('/tenant/claim', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const ticket = typeof body?.ticket === 'string' ? body.ticket.trim() : '';
  const pluginId = typeof body?.plugin_id === 'string' ? body.plugin_id.trim() : '';

  // Shape-check before any database work so a malformed flood stays cheap.
  if (!TICKET_PATTERN.test(ticket) || !PLUGIN_ID_PATTERN.test(pluginId)) {
    return c.json({ error: 'bad_request' }, 400, NO_STORE);
  }

  const tenantId = pluginTenantId(c.env);
  if (!tenantId) return c.json({ error: 'enrollment_unavailable' }, 503, NO_STORE);

  const plugin = await pluginById(c.env, pluginId);
  if (!plugin || !plugin.apiSecret || !manifestAllowsAutoTenant(plugin.manifest)) {
    return c.json({ error: 'unknown_plugin' }, 403, NO_STORE);
  }

  const claimed = await claimEnrollmentTicket(c.env, pluginId, ticket);
  if (!claimed) return c.json({ error: 'invalid_ticket' }, 403, NO_STORE);
  // A ticket is bound to the URL that was registered when it was minted; if an
  // admin repointed the plugin in between, the old target must not be able to
  // redeem it.
  if (claimed.url !== plugin.binding) return c.json({ error: 'invalid_ticket' }, 403, NO_STORE);
  try {
    await auditPluginManagement(c.env, pluginId, 'credential-claim', claimed.actor
      ? { ...claimed.actor, via: pluginId }
      : { userId: null, roles: null, sessionSid: null, via: pluginId });
  } catch {
    return c.json({ error: 'audit_unavailable' }, 503, NO_STORE);
  }

  console.log(`Plugin ${pluginId} enrolled tenant ${tenantId}`);
  return c.json(
    { tenant: tenantId, cms_url: tenantId, plugin_id: pluginId, secret: plugin.apiSecret },
    200,
    NO_STORE,
  );
});
