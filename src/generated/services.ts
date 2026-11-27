// GENERATED FILE — do not edit.
//
// Written by tools/build-features.mjs from cms.features.json.
// To add or drop a feature, edit that file and run `npm run build:features`.

import type { FeatureServiceEntry } from '../features/services';
import { auditServices } from '../features/audit/services';
import { creditsServices } from '../features/credits/services';
import { i18nServices } from '../features/i18n/services';
import { jobsServices } from '../features/jobs/services';
import { pluginsServices } from '../features/plugins/services';
import { publishServices } from '../features/publish/services';
import { runtimeContentTypesServices } from '../features/runtime-content-types/services';
import { trashServices } from '../features/trash/services';
import { usersRolesServices } from '../features/users-roles/services';

/** Runtime services contributed by installed features. */
export const featureServiceEntries: readonly FeatureServiceEntry[] = [
  auditServices,
  creditsServices,
  i18nServices,
  jobsServices,
  pluginsServices,
  publishServices,
  runtimeContentTypesServices,
  trashServices,
  usersRolesServices,
];
