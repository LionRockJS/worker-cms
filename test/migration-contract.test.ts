import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function objectNames(db: D1Database, type: 'table' | 'index' | 'trigger'): Promise<string[]> {
  const { results } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA', 'd1_migrations') ORDER BY name",
  ).bind(type).all<{ name: string }>();
  return results.map((row) => row.name);
}

describe('flattened migration contract', () => {
  it('ships one complete baseline per D1 database', () => {
    // Exactly one baseline each. Additive `000N_enable_<feature>.sql` files may
    // sit alongside it: D1 tracks applied migrations by name, so regenerating a
    // baseline never reaches a database that already ran it, and a feature's
    // tables get there through an enable migration instead (see
    // tools/build-migrations.mjs --enable). Those are idempotent by
    // construction — every statement is CREATE ... IF NOT EXISTS — so they are
    // no-ops on a fresh install that got the same objects from the baseline.
    //
    // A column *removal* cannot join them: DROP COLUMN aborts on the fresh
    // install whose baseline never had the column, and the rebuild that would
    // be safe on both cascades through DB.pages' foreign keys (D1 runs with
    // foreign_keys=1) and takes page_versions and page_tags with it. Such
    // changes leave the baseline and ship as a one-off under migrations/manual/.
    const names = env.TEST_MIGRATIONS.map((migration) => migration.name);
    expect(names.filter((name) => !/^\d{4}_enable_/.test(name))).toEqual(['0001_initial_schema.sql']);
    expect(names[0]).toBe('0001_initial_schema.sql');
    // The published database has no feature switches, so an additive file there
    // is hand-written and short-lived: `0002_published_tags.sql` created the tag
    // catalogue on databases that had already run the baseline, and was deleted
    // once they had it — the baseline (regenerated from
    // src/core/publish/schema.sql) is what fresh installs get. A published
    // database that has not applied that table needs it created by hand.
    expect(env.TEST_PUBLISHED_MIGRATIONS.map((migration) => migration.name))
      .toEqual(['0001_published_schema.sql']);
  });

  it('creates the complete private schema without transitional tables', async () => {
    expect(await objectNames(env.DB, 'table')).toEqual([
      'admin_jobs', 'audit_log', 'block_types', 'credit_ledger', 'credit_subscriptions', 'credit_wallets',
      'locale_messages', 'locales', 'media_files', 'page_tags', 'page_types',
      'page_versions', 'pages', 'plugin_asset_approvals', 'plugin_file_prefix_approvals',
      'plugin_identity_approvals', 'plugin_page_type_approvals',
      'plugin_state', 'plugins', 'role_permissions', 'roles', 'sessions', 'settings',
      'shared_credit_ledger', 'shared_credits', 'tags', 'taxonomies',
      'trash_page_tags', 'trash_page_versions', 'trash_pages',
      'user_oauth_identities', 'users',
    ]);

    // Both databases now name their tables identically (`pages`, `page_tags`),
    // so no single table name tells them apart any more — the exact set does.
    // What remains worth asserting here is that no transitional table from an
    // earlier flattening survived.
    expect(await objectNames(env.DB, 'table')).not.toEqual(expect.arrayContaining([
      'used_form_tokens', 'tags_new', 'admin_jobs_new',
    ]));
    expect(await objectNames(env.DB, 'index')).toEqual(expect.arrayContaining([
      'idx_pages_pointer_contact', 'idx_pages_pointer_edm',
      'idx_pages_pointer_event', 'idx_pages_pointer_mail_list',
      'idx_sessions_previous_refresh', 'idx_tags_taxonomy_slug_weight_name',
    ]));
    expect(await objectNames(env.DB, 'trigger')).toEqual(expect.arrayContaining([
      'locales_updated_at', 'locale_messages_updated_at', 'user_oauth_identities_updated_at',
    ]));
  });

  it('leaves lect as the only current-content column on page tables', async () => {
    // `lect` is the working copy and the source of truth; page_versions is an
    // append-only backup log whose newest row mirrors it. A current-version
    // pointer would be a second answer to "what does this page say", and could
    // disagree — deleting the version it named repointed it at older content.
    for (const table of ['pages', 'trash_pages']) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const columns = results.map((column) => column.name);
      expect(columns).toContain('lect');
      expect(columns).not.toContain('current_page_version_id');
    }
  });

  it('gives pages no foreign keys while its dependents keep theirs', async () => {
    // page_id mirrors PUBLISHED_DB.pages.page_id: a plain column, so a page is handled
    // independently of its parent's state and a parent delete cannot cascade
    // its children away (that cascade hard-deleted them past trash entirely).
    const parentFks = await env.DB.prepare('PRAGMA foreign_key_list(pages)').all();
    expect(parentFks.results).toEqual([]);

    // The cascade that must stay: deleting a page still cleans up its own
    // version rows and tag links.
    for (const table of ['page_versions', 'page_tags']) {
      const { results } = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`)
        .all<{ table: string; from: string; on_delete: string }>();
      expect(results).toEqual([
        expect.objectContaining({ table: 'pages', from: 'page_id', on_delete: 'CASCADE' }),
      ]);
    }
  });

  it('preserves security-critical columns and seed rows', async () => {
    const { results: sessionColumns } = await env.DB.prepare('PRAGMA table_info(sessions)').all<{ name: string }>();
    expect(sessionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'refresh_token_hash', 'previous_refresh_token_hash', 'rotated_at',
    ]));
    const { results: pluginColumns } = await env.DB.prepare('PRAGMA table_info(plugins)').all<{ name: string }>();
    expect(pluginColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['secret', 'enabled']));

    const { results: locales } = await env.DB.prepare(
      'SELECT code FROM locales ORDER BY weight, code',
    ).all<{ code: string }>();
    expect(locales.map((locale) => locale.code)).toEqual(['mis', 'en', 'zh-hant', 'zh-hans']);
    const { results: userColumns } = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
    expect(userColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['credits', 'diamonds']));
    expect(await env.DB.prepare("SELECT balance FROM shared_credits WHERE currency = 'credit'").first())
      .toBeNull();
  });

  it('keeps published content isolated in its three-table schema', async () => {
    // `tags` is the tag catalogue the publish path mirrors, so a reader can
    // resolve a page_tags link to a name and a grouping. `taxonomies` stays
    // CMS-only — the published grouping key is the tag's own taxonomy_slug.
    expect(await objectNames(env.PUBLISHED_DB, 'table')).toEqual(['page_tags', 'pages', 'tags']);
    expect(await objectNames(env.PUBLISHED_DB, 'index')).toEqual(expect.arrayContaining([
      'idx_pages_created_at_uuid', 'idx_pages_page_type_created_at',
      'idx_pages_page_type_page_id', 'idx_tags_taxonomy_slug_weight_name',
    ]));

    // No self-referencing foreign key, unlike DB.tags: a child tag can be
    // mirrored before its parent exists.
    const parentFks = await env.PUBLISHED_DB.prepare('PRAGMA foreign_key_list(tags)').all();
    expect(parentFks.results).toEqual([]);
  });
});
