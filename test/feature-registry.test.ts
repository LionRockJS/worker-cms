// The feature manifest registry (src/core/feature.ts + src/features/*).
//
// Two registries have to agree: the manifests in src/features/index.ts and the
// routers in src/features/routers.ts. scripts/check-boundaries.mjs checks they
// have not drifted; these tests cover the runtime behaviour that drift or a
// bad manifest would break.

import { describe, expect, it } from 'vitest';
import { assertFeatureRegistry, type CmsFeature } from '../src/core/feature';
import { featureInstalled, features } from '../src/features';
import { featureRouters } from '../src/features/routers';
import { SIDEBAR_MENU_ITEMS } from '../src/core/db/settings';

describe('feature registry', () => {
  it('installs the expected feature set', () => {
    // Deliberately explicit: adding or dropping a feature is a decision, so it
    // should show up as a change here rather than passing silently.
    expect(features.map((feature) => feature.id).sort()).toEqual([
      'audit',
      'credits',
      'i18n',
      'jobs',
      'media',
      'plugins',
      'runtime-content-types',
      'search',
      'trash',
      'users-roles',
    ]);
  });

  it('reports installed features and treats unowned nav entries as visible', () => {
    expect(featureInstalled('trash')).toBe(true);
    expect(featureInstalled('credits')).toBe(true);
    expect(featureInstalled('not-installed')).toBe(false);
    // Core sidebar entries carry no owner, so they are never gated.
    expect(featureInstalled(undefined)).toBe(true);
  });

  it('tags every owned sidebar entry with an installed feature', () => {
    // A typo here would silently hide a menu item, so pin the wiring: each
    // navKey a feature claims must exist in SIDEBAR_MENU_ITEMS and be tagged
    // back to that same feature.
    const keys = new Map(SIDEBAR_MENU_ITEMS.map((item) => [
      item.key as string,
      'feature' in item ? item.feature as string : undefined,
    ]));
    for (const feature of features) {
      for (const navKey of feature.navKeys ?? []) {
        expect(keys.has(navKey), `${feature.id} claims unknown nav key ${navKey}`).toBe(true);
        expect(keys.get(navKey)).toBe(feature.id);
      }
    }
    // Deliberately NOT asserted: that every tagged entry names an installed
    // feature. A tag outliving its feature is the designed state — it is what
    // tells the chrome to hide the entry — so requiring it here would fail
    // every profile that actually drops a feature.
  });

  it('registers every router under an installed feature id', () => {
    const installed = features.map((feature) => feature.id);
    for (const entry of featureRouters) expect(installed).toContain(entry.id);
  });

  it('rejects a duplicate feature id', () => {
    const duplicate: CmsFeature[] = [{ id: 'a' }, { id: 'a' }];
    expect(() => assertFeatureRegistry(duplicate)).toThrow(/duplicate feature id "a"/);
  });

  it('rejects a feature whose dependency was removed', () => {
    const orphan: CmsFeature[] = [{ id: 'pointers', requires: ['plugins'] }];
    expect(() => assertFeatureRegistry(orphan)).toThrow(/requires "plugins"/);
  });

  it('accepts a registry whose dependencies are all present', () => {
    const valid: CmsFeature[] = [{ id: 'plugins' }, { id: 'pointers', requires: ['plugins'] }];
    expect(() => assertFeatureRegistry(valid)).not.toThrow();
  });
});
