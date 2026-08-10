// Guards the migration assembler (scripts/build-migrations.mjs):
//
//   src/core/schema.sql + every enabled src/**/schema.sql
//     -> migrations/0001_initial_schema.sql
//
// The assembler itself runs in Node, so vitest.config.mts hands the assembled
// SQL over as bindings. Note that a fragment missing from cms.features.json
// (or a feature whose `-- requires:` dependency is disabled) makes the
// assembler throw while the test config is being built, failing the whole run
// before any of these assertions execute.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** One object per feature that must appear only when that feature is enabled. */
const FEATURE_MARKERS: Record<string, string[]> = {
  'trash': ['CREATE TABLE IF NOT EXISTS trash_pages(', 'CREATE TABLE IF NOT EXISTS trash_page_versions('],
  'runtime-content-types': ['CREATE TABLE IF NOT EXISTS page_types(', 'CREATE TABLE IF NOT EXISTS block_types('],
  'media': ['CREATE TABLE IF NOT EXISTS media_files('],
  'plugins': [
    'CREATE TABLE IF NOT EXISTS plugins(',
    'CREATE TABLE IF NOT EXISTS plugin_asset_approvals(',
    'CREATE TABLE IF NOT EXISTS plugin_file_prefix_approvals(',
  ],
  'plugin-pointer-indexes': ['idx_pages_pointer_event'],
  'jobs': ['CREATE TABLE IF NOT EXISTS admin_jobs('],
  'credits': [
    'CREATE TABLE IF NOT EXISTS credit_wallets(',
    'CREATE TABLE IF NOT EXISTS credit_ledger(',
    'CREATE TABLE IF NOT EXISTS credit_subscriptions(',
  ],
};

const availableFeatures = env.TEST_AVAILABLE_FEATURES.split(',').filter(Boolean);

describe('migration assembly', () => {
  it('keeps the committed baseline in sync with the fragments', () => {
    // Fails when a fragment under schema/ was edited without re-running
    // `npm run build:migrations`.
    expect(env.TEST_COMMITTED_BASELINE).toBe(env.TEST_ASSEMBLED_BASELINE);
  });

  it('marks the generated baseline as generated', () => {
    expect(env.TEST_COMMITTED_BASELINE).toContain('GENERATED FILE — do not edit');
    // Fragments live beside the code they belong to; the header records which
    // ones went in, so a generated baseline is traceable to its sources.
    expect(env.TEST_COMMITTED_BASELINE).toContain('src/core/schema.sql');
    expect(env.TEST_COMMITTED_BASELINE).toContain('src/features/trash/schema.sql');
  });

  it('has a marker for every feature fragment on disk', () => {
    // Keeps this test honest as features are added.
    expect(availableFeatures.slice().sort()).toEqual(Object.keys(FEATURE_MARKERS).sort());
  });

  it('includes every enabled feature in the full profile', () => {
    for (const markers of Object.values(FEATURE_MARKERS)) {
      for (const marker of markers) expect(env.TEST_ASSEMBLED_BASELINE).toContain(marker);
    }
  });

  it('drops every optional feature from a lean profile', () => {
    for (const [feature, markers] of Object.entries(FEATURE_MARKERS)) {
      for (const marker of markers) {
        expect(env.TEST_ASSEMBLED_LEAN_BASELINE, `${feature} leaked into the lean profile`).not.toContain(marker);
      }
    }
  });

  it('keeps the core schema in a lean profile', () => {
    // locales/locale_messages are core: the chrome resolves the viewer's
    // locale on every render, so a profile without them cannot serve a page.
    for (const table of ['users', 'sessions', 'pages', 'page_versions', 'tags', 'taxonomies', 'roles', 'settings', 'locales', 'locale_messages']) {
      expect(env.TEST_ASSEMBLED_LEAN_BASELINE).toContain(`CREATE TABLE IF NOT EXISTS ${table}(`);
    }
    expect(env.TEST_ASSEMBLED_LEAN_BASELINE).toContain('CREATE TABLE IF NOT EXISTS audit_log (');
    expect(env.TEST_ASSEMBLED_LEAN_BASELINE).toContain('CREATE TABLE IF NOT EXISTS role_permissions(');
  });

  it('records the disabled features in the generated header', () => {
    expect(env.TEST_ASSEMBLED_LEAN_BASELINE).toContain(`(disabled: ${availableFeatures.join(', ')})`);
  });

  it('orders dependencies before the features that require them', () => {
    // plugin-pointer-indexes declares `-- requires: plugins`.
    const plugins = env.TEST_ASSEMBLED_BASELINE.indexOf('CREATE TABLE IF NOT EXISTS plugins(');
    const pointers = env.TEST_ASSEMBLED_BASELINE.indexOf('idx_pages_pointer_event');
    expect(plugins).toBeGreaterThan(-1);
    expect(pointers).toBeGreaterThan(plugins);
  });
});
