// GENERATED FILE — do not edit.
//
// Written by tools/build-features.mjs from cms.features.json.
// To add or drop a feature, edit that file and run `npm run build:features`.

import type { CmsFeature } from '../core/feature';
import { auditFeature } from '../features/audit/feature';
import { creditsFeature } from '../features/credits/feature';
import { i18nFeature } from '../features/i18n/feature';
import { jobsFeature } from '../features/jobs/feature';
import { mediaFeature } from '../features/media/feature';
import { pluginsFeature } from '../features/plugins/feature';
import { runtimeContentTypesFeature } from '../features/runtime-content-types/feature';
import { searchFeature } from '../features/search/feature';
import { trashFeature } from '../features/trash/feature';
import { usersRolesFeature } from '../features/users-roles/feature';

/** Installed features, in cms.features.json order. */
export const featureManifests: readonly CmsFeature[] = [
  auditFeature,
  creditsFeature,
  i18nFeature,
  jobsFeature,
  mediaFeature,
  pluginsFeature,
  runtimeContentTypesFeature,
  searchFeature,
  trashFeature,
  usersRolesFeature,
];
