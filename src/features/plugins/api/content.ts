import { recordTaxonomyReads } from '../../../core/http/access-log';
import { actingUserId } from './create';
// Content metadata and tag provisioning: what a plugin needs to build an
// import UI (page types, blueprint fields, taxonomies) plus tag upsert.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin, forbiddenPageType } from './auth';
import { stringList } from './serialize';
import { resolveCmsConfig } from '../../../core/db/content-config';
import { editorTaxonomy } from '../../../core/db/admin-queries';
import { capturePluginPageMutationAuthority } from '../page-update-evidence';
import { ensurePluginTags } from '../tag-ensure-evidence';
import { advancedSearchPathSpecs } from '../../../core/db/search';
import { pageTypeScopeAllows } from '../page-types';

export const contentApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// and the old built-in CSV importer derive columns from). Read-scoped.
contentApiRoutes.get('/content-meta', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const config = await resolveCmsConfig(c.env);
  const allTypes = Object.keys(config.blueprint).filter((pageType) => pageTypeScopeAllows(auth.readableTypes, pageType));
  const requested = stringList(c.req.query('types'));
  const types = requested.length === 0 || requested.includes('all') ? allTypes : requested;
  for (const pageType of types) {
    if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return forbiddenPageType(c, auth, pageType);
  }

  const taxonomy = await editorTaxonomy(c.env.DB);
  const userId = actingUserId(c);
  recordTaxonomyReads('taxonomy.plugin-meta', taxonomy.taxonomies, { userId: userId === null ? null : String(userId), roles: null, sessionSid: null, via: auth.pluginId });
  const pathSpecs: Record<string, Array<{ path: string; kind: string }>> = {};
  for (const pageType of types) {
    pathSpecs[pageType] = advancedSearchPathSpecs([pageType], config).map(({ path, kind }) => ({ path, kind }));
  }

  return c.json({
    page_types: allTypes,
    languages: config.languages,
    default_language: config.defaultLanguage,
    taxonomies: taxonomy.taxonomies.map(({ name, slug }) => ({ name, slug })),
    path_specs: pathSpecs,
  });
});

// Find-or-create tags by (taxonomy slug, name) — bulk imports create tags on
// demand, exactly like the old built-in CSV importer. Requires write scope.
contentApiRoutes.post('/tags/ensure', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const authority = await capturePluginPageMutationAuthority(c, auth, 'tag-ensure');
  if (!authority.allowed.size) return ensurePluginTags(c, authority, null);
  const body = await c.req.json().catch(() => null);
  return ensurePluginTags(c, authority, body);
});
