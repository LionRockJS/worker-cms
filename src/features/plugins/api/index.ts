// ============================================================
// Plugin API — Plugin → CMS page write-back / read API.
//
// The standard plugin contract is CMS → plugin only (manifest, admin proxy,
// hooks, publish snapshots). This router adds the reverse channel: a trusted
// plugin Worker can read and write the CMS pages it owns or has been delegated,
// so guest-facing flows that live on the plugin's own domain (public RSVP
// submit, QR check-in, bulk contact import) can create/update guest pages in
// the single source of truth.
//
// Transport & trust:
//   - Mounted at the reserved /__cms prefix, OUTSIDE the /admin auth stack
//     (there is no signed-in user — this is server-to-server).
//   - Authenticated by the calling plugin row's dedicated secret
//     (x-plugin-secret header). The legacy env PLUGIN_SECRET is never accepted
//     inbound because it would let one compromised plugin impersonate another.
//   - The caller names itself via x-plugin-id; writes are scoped to that
//     plugin's manifest blueprint page types plus explicit, admin-approved
//     `writeTypes`. Each plugin has its own credential and can be independently
//     rotated/revoked; only register trusted plugin URLs.
//   - The global cross-origin mutation guard is bypassed for /__cms (see
//     index.ts): server-to-server callers send no Origin, and PLUGIN_SECRET is
//     the real authenticator here.
//
// Every create/update/delete mints a page_version and fires the matching
// lifecycle hook, exactly like the admin editor — so plugin writes are
// versioned, auditable, and observable to other plugins.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { limitsApiRoutes } from './limits';
import { contentApiRoutes } from './content';
import { pagesApiRoutes } from './pages';
import { ingestApiRoutes } from './ingest';
import { stateApiRoutes } from './state';
import { filesApiRoutes } from './files';
export const cmsApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Mounted by resource, in the order the routes were originally registered.
// Within /pages the relative order is load-bearing (static paths before the
// :id catch-alls) and lives in ./pages.ts; across resources it is not, since
// no two of these prefixes can match the same request.
cmsApiRoutes.route('/', limitsApiRoutes);
cmsApiRoutes.route('/', contentApiRoutes);
cmsApiRoutes.route('/', pagesApiRoutes);
cmsApiRoutes.route('/', ingestApiRoutes);
cmsApiRoutes.route('/', stateApiRoutes);
cmsApiRoutes.route('/', filesApiRoutes);
