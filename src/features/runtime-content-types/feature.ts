import type { CmsFeature } from '../../core/feature';

/**
 * The admin screens for content types defined at runtime in the database —
 * the page_types and block_types tables — as opposed to the types compiled
 * into cms-config.ts or declared by a plugin manifest. resolveCmsConfig()
 * layers all three, database last, so a type added here overrides the others.
 *
 * This feature owns the administration routes and form validation. Core
 * continues reading existing page and block types when these routes are disabled.
 */
export const runtimeContentTypesFeature: CmsFeature = {
  id: 'runtime-content-types',
  // No `requires`: the "owned by" column reads core's contentTypeContributors
  // extension, which is empty when nothing contributes types.
  navKeys: ['pageTypes', 'blockTypes'],
};
