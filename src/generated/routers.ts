// GENERATED FILE — do not edit.
//
// Written by tools/build-features.mjs from cms.features.json.
// To add or drop a feature, edit that file and run `npm run build:features`.

import type { FeatureRouterEntry } from '../features/routers';
import { auditRoutes } from '../features/audit/routes';
import { creditApiRoutes } from '../features/credits/routes/contributor-api';
import { creditPanelRoutes } from '../features/credits/routes/panels';
import { creditSettingsRoutes } from '../features/credits/routes/settings';
import { i18nRoutes } from '../features/i18n/routes';
import { mediaFilesRoutes } from '../features/media/routes/files';
import { mediaPublicRoutes } from '../features/media/routes/public';
import { mediaUploadRoutes } from '../features/media/routes/upload';
import { pluginAdminRoutes } from '../features/plugins/routes/admin-proxy';
import { pluginApiRoutes, pluginTenantRoutes } from '../features/plugins/routes/cms-api';
import { pluginsManageRoutes } from '../features/plugins/routes/manage';
import { blockTypesRoutes, pageTypesRoutes } from '../features/runtime-content-types/routes';
import { searchRoutes } from '../features/search/routes';
import { trashRoutes } from '../features/trash/routes';
import { rolesRoutes } from '../features/users-roles/routes/roles';
import { usersRoutes } from '../features/users-roles/routes/users';

/** Mounted under /admin, in registry order. */
export const adminRouterEntries: readonly FeatureRouterEntry[] = [
  { id: 'audit', router: auditRoutes },
  { id: 'credits', router: creditPanelRoutes },
  { id: 'credits', router: creditSettingsRoutes },
  { id: 'i18n', router: i18nRoutes },
  { id: 'media', router: mediaFilesRoutes },
  { id: 'media', router: mediaUploadRoutes },
  { id: 'plugins', router: pluginAdminRoutes },
  { id: 'plugins', router: pluginsManageRoutes },
  { id: 'runtime-content-types', router: blockTypesRoutes },
  { id: 'runtime-content-types', router: pageTypesRoutes },
  { id: 'search', router: searchRoutes },
  { id: 'trash', router: trashRoutes },
  { id: 'users-roles', router: rolesRoutes },
  { id: 'users-roles', router: usersRoutes },
];

/** Mounted at the worker root, outside the auth stack. */
export const publicRouterEntries: readonly FeatureRouterEntry[] = [
  { id: 'credits', router: creditApiRoutes, basePath: '/__cms' },
  { id: 'media', router: mediaPublicRoutes },
  { id: 'plugins', router: pluginApiRoutes, basePath: '/__cms' },
  { id: 'plugins', router: pluginTenantRoutes, basePath: '/__cms' },
];
