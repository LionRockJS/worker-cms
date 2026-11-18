import type { CmsFeature } from '../../core/feature';

/**
 * The languages and translations admin.
 *
 * Locale and translation editing is optional. src/core/i18n.ts stays core — the chrome
 * resolves the viewer's locale on every render — and so does
 * GET /admin/i18n/catalog/:locale, which serves the admin UI's own strings.
 * Without this feature the CMS runs on the locales already in the database
 * and the bundled catalogs, with no way to edit them.
 */
export const i18nFeature: CmsFeature = {
  id: 'i18n',
  navKeys: ['languages'],
};
