// GENERATED FILE — do not edit.
//
// Written by tools/build-features.mjs from cms.features.json.
// To add or drop a feature, edit that file and run `npm run build:features`.

import type { FeatureServiceEntry } from '../features/services';
import { auditServices } from '../features/audit/services';
import { creditsServices } from '../features/credits/services';
import { pluginsServices } from '../features/plugins/services';

/** Runtime services contributed by installed features. */
export const featureServiceEntries: readonly FeatureServiceEntry[] = [
  auditServices,
  creditsServices,
  pluginsServices,
];
