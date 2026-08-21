-- ============================================================
-- Initial CMS schema — applied to the private CMS (admin) database.
--
-- GENERATED FILE — do not edit. Edit the schema.sql fragments beside
-- the code they belong to and run `npm run build:migrations`.
--
-- Assembled from:
--   src/core/schema.sql
--   src/features/credits/schema.sql
--   src/features/jobs/schema.sql
--   src/features/media/schema.sql
--   src/features/plugins/schema.sql
--   src/features/plugin-pointer-indexes/schema.sql
--   src/features/runtime-content-types/schema.sql
--   src/features/trash/schema.sql
-- ============================================================

-- ============================================================
-- Core CMS schema — always present, in every feature profile.
--
-- Holds identity, the content model (pages/tags/versions), roles and
-- settings: everything the admin shell cannot boot without. Optional
-- tables live in schema/cms/features/*.sql and are appended by
-- scripts/build-migrations.mjs.
-- ============================================================

-- 1. Users – populated on first OAuth login
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oauth_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    -- role: comma-separated list of admin | editor | moderator | viewer
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. Sessions – stores hashed refresh tokens for revocation support
CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Previous hash is retained briefly to tolerate concurrent token rotation.
    previous_refresh_token_hash TEXT,
    rotated_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 3. Multiple OAuth identities linked to one CMS user.
CREATE TABLE IF NOT EXISTS user_oauth_identities(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    oauth_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    UNIQUE(provider, provider_user_id)
);

-- 4. Taxonomies – groupings that tags belong to (e.g. Categories, Topics)
CREATE TABLE IF NOT EXISTS taxonomies(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
);

-- 5. Tags – terms within a taxonomy. Taxonomies are referenced by stable slug
--    so a taxonomy rebuild does not invalidate tag relationships.
CREATE TABLE IF NOT EXISTS tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    weight INTEGER DEFAULT 5,
    taxonomy_slug TEXT,
    parent_tag INTEGER REFERENCES tags(id) ON DELETE SET NULL,
    lect TEXT
);

-- 6. Pages (the draft/working copy)
--
-- Named `pages`, the same as the published database's table, so one physical
-- database can be a publish target for one host and the working set of the
-- next — publish A → B, B → C. Because the name no longer says which database
-- it belongs to, comments and docs disambiguate by binding: `DB.pages` is this
-- table, `PUBLISHED_DB.pages` is the published one (src/core/publish/schema.sql).
CREATE TABLE IF NOT EXISTS pages(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    weight INTEGER DEFAULT 5,
    start DATETIME,
    end DATETIME,
    -- IANA tz name or UTC offset (e.g. 'Asia/Hong_Kong', '+0800') for start/end.
    timezone TEXT,
    page_type TEXT,
    -- `lect` is the working copy and the single source of truth for a draft.
    -- page_versions is an append-only backup log: the newest row mirrors this
    -- column, older rows are restore candidates. There is deliberately no
    -- current-version pointer — it could name a snapshot other than `lect`.
    lect TEXT,
    -- Parent page. Deliberately NOT a foreign key, which makes this table's
    -- shape identical to PUBLISHED_DB.pages(page_id) and lets a page be handled
    -- independently of its parent's state. Two consequences:
    --
    --   * Deleting a parent no longer cascade-deletes its children. That
    --     cascade destroyed them outright — trashDraftPage copies only the page
    --     it was given, so children were hard-deleted, never reaching trash.
    --     They are now left in place with a page_id that resolves to nothing,
    --     which every reader already tolerates (parentPageOption returns no
    --     option, restore re-links only a parent that is live again).
    --   * Nothing rejects a parent id that does not exist, so writers validate
    --     it themselves: resolveParentPageId() on the admin form path, and an
    --     explicit existence check in the plugin create API.
    page_id INTEGER,
    creator INTEGER,
    editors TEXT
);

-- 7. Page Versions – supports version browsing and snapshots
CREATE TABLE IF NOT EXISTS page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
);

-- 8. Page Tags — same name and shape as PUBLISHED_DB.page_tags, so tag links
--    chain host-to-host alongside the pages they belong to.
CREATE TABLE IF NOT EXISTS page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
);

-- 9. Audit log for admin mutations (who did what, when)
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,            -- e.g. 'page.create', 'page.publish', 'taxonomy.delete', 'media.upload'
    entity_type TEXT NOT NULL,       -- 'page' | 'tag' | 'taxonomy' | 'media' | ...
    entity_id TEXT,
    detail TEXT,                     -- small JSON blob (slug, filename); never content bodies
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10. Roles – custom roles, plus built-in roles once their permissions are
--     customized. Built-in roles (admin/editor/moderator/viewer) are implicit
--     in code (USER_ROLES) and only appear here after being edited.
CREATE TABLE IF NOT EXISTS roles(
    name TEXT PRIMARY KEY,           -- slug-like role key
    label TEXT NOT NULL,
    -- 1 = a built-in role with customized permissions; 0 = a custom role
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 11. Role permissions – grants for any role listed in `roles`. A built-in role
--     with no override here falls back to its code default; the 'admin' role is
--     always granted every permission in code and is not stored.
--     Core, not part of the users/roles admin feature: every authenticated
--     request resolves permissions through this table.
CREATE TABLE IF NOT EXISTS role_permissions(
    role TEXT NOT NULL,
    permission TEXT NOT NULL,
    PRIMARY KEY (role, permission)
);

-- 12. Admin settings – small key/value store for runtime CMS preferences.
CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pages_page_type_name ON pages(page_type, name);
CREATE INDEX IF NOT EXISTS idx_pages_page_type_slug ON pages(page_type, slug);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug);
CREATE INDEX IF NOT EXISTS idx_page_versions_page_id_created_at ON page_versions(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tags_taxonomy_slug_weight_name ON tags(taxonomy_slug, weight, name);
CREATE INDEX IF NOT EXISTS idx_tags_parent_tag ON tags(parent_tag);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_user_id ON user_oauth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_previous_refresh ON sessions(previous_refresh_token_hash);

-- ── Triggers for updated_at column automatic updates ─────────
CREATE TRIGGER IF NOT EXISTS users_updated_at AFTER UPDATE ON users WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS roles_updated_at AFTER UPDATE ON roles WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE roles SET updated_at = CURRENT_TIMESTAMP WHERE name = old.name;
END;

CREATE TRIGGER IF NOT EXISTS taxonomies_updated_at AFTER UPDATE ON taxonomies WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE taxonomies SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tags_updated_at AFTER UPDATE ON tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS pages_updated_at AFTER UPDATE ON pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_versions_updated_at AFTER UPDATE ON page_versions WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_versions SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_tags_updated_at AFTER UPDATE ON page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS user_oauth_identities_updated_at
AFTER UPDATE ON user_oauth_identities
WHEN old.updated_at < CURRENT_TIMESTAMP
BEGIN
    UPDATE user_oauth_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

-- ── Locales ──────────────────────────────────────────────────
-- Core, not part of the i18n feature: the admin chrome resolves the viewer's
-- locale on every render (utils/i18n localeRegistry + resolveUiLocale), so the
-- CMS cannot serve a page without these tables. The i18n FEATURE is the admin
-- UI for editing them, which is optional; the data is not.

CREATE TABLE IF NOT EXISTS locales(
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    content_enabled INTEGER NOT NULL DEFAULT 1 CHECK (content_enabled IN (0, 1)),
    ui_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ui_enabled IN (0, 1)),
    direction TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
    fallback_code TEXT REFERENCES locales(code) ON DELETE SET NULL,
    weight INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO locales (code, label, content_enabled, ui_enabled, direction, fallback_code, weight, builtin) VALUES
    ('mis', 'Unspecified language', 1, 0, 'ltr', NULL, 0, 1),
    ('en', 'English', 1, 1, 'ltr', NULL, 10, 1),
    ('zh-hant', '繁體中文', 1, 1, 'ltr', 'en', 20, 1),
    ('zh-hans', '简体中文', 1, 1, 'ltr', 'en', 30, 1);

CREATE TABLE IF NOT EXISTS locale_messages(
    locale_code TEXT NOT NULL REFERENCES locales(code) ON DELETE CASCADE,
    message_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (locale_code, message_key)
);

CREATE INDEX IF NOT EXISTS idx_locales_content ON locales(content_enabled, weight, code);
CREATE INDEX IF NOT EXISTS idx_locales_ui ON locales(ui_enabled, weight, code);
CREATE INDEX IF NOT EXISTS idx_locale_messages_locale ON locale_messages(locale_code, message_key);

CREATE TRIGGER IF NOT EXISTS locales_updated_at
AFTER UPDATE ON locales
BEGIN
    UPDATE locales SET updated_at = CURRENT_TIMESTAMP WHERE code = NEW.code;
END;

CREATE TRIGGER IF NOT EXISTS locale_messages_updated_at
AFTER UPDATE ON locale_messages
BEGIN
    UPDATE locale_messages
    SET updated_at = CURRENT_TIMESTAMP
    WHERE locale_code = NEW.locale_code AND message_key = NEW.message_key;
END;

-- Feature: credits — metered billing for chargeable actions.
-- feature: credits
-- Per-user and site-wide balances, append-only ledgers, and the recurring
-- subscriptions billed by the cron sweep.
--
-- requires: core
--
-- Every balance carries an opaque currency identifier. Supported identifiers
-- are owned by ./currencies.ts; all storage is row-based, so adding a wallet
-- needs no SQL or core-schema change.

-- One row per user and currency. Missing rows are zero balances and are
-- created lazily on the first adjustment or attempted charge.
CREATE TABLE IF NOT EXISTS credit_wallets(
    user_id INTEGER NOT NULL,
    currency TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, currency),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Per-user credit balance audit ledger.
CREATE TABLE IF NOT EXISTS credit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'credit',
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    plugin_id TEXT,
    note TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Site-wide shared balance and append-only ledger, one pool per currency.
-- Missing rows are zero balances and are created lazily.
CREATE TABLE IF NOT EXISTS shared_credits(
    currency TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shared_credit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL DEFAULT 'credit',
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER,
    entity_type TEXT,
    entity_id TEXT,
    plugin_id TEXT,
    note TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- Recurring credit subscriptions: one row per (user, plugin, cost),
-- created/updated by plugin usage reports (POST /__cms/credits/usage) and
-- billed monthly by the cron sweep. The currency is not stored here — it comes
-- from the declared cost at sweep time, so re-denominating a cost in the
-- manifest bills the new wallet from the next period. See ./subscriptions.ts.
CREATE TABLE IF NOT EXISTS credit_subscriptions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plugin_id TEXT NOT NULL,
    credit_key TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    peak_quantity INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
    next_charge_at TEXT NOT NULL,
    last_charged_at TEXT,
    last_mode TEXT CHECK (last_mode IN ('advance', 'arrears')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, plugin_id, credit_key),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_shared_credit_ledger_user ON shared_credit_ledger(user_id, currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_shared_credit_ledger_currency ON shared_credit_ledger(currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_credit_subscriptions_due ON credit_subscriptions(status, next_charge_at);

-- Feature: jobs — durable admin background jobs backed by the queue binding.
-- feature: jobs
-- Without it, long plugin actions and bulk edits run synchronously and risk
-- the 1000-subrequest per-invocation limit. See utils/admin-job-runner.ts.

CREATE TABLE IF NOT EXISTS admin_jobs(
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('plugin_admin_action', 'advanced_search_bulk_action')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    plugin_id TEXT,
    method TEXT,
    path TEXT,
    content_type TEXT,
    body TEXT,
    user_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    result_status INTEGER,
    result_location TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_status_updated ON admin_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_plugin_created ON admin_jobs(plugin_id, created_at);

-- Feature: media — R2-backed uploads and the file browser.
-- feature: media
-- Without it the editor has no picture/file fields backed by the bucket.

CREATE TABLE IF NOT EXISTS media_files(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    key TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER DEFAULT 0
);

-- Feature: plugins — the plugin registry and its admin-approval tables.
-- feature: plugins
-- Dropping this removes the whole extensibility platform: plugin admin
-- proxying, hooks, delegated page types and pinned plugin assets.

-- Plugins – database-driven plugin registry (URL transport). Each row is a
-- plugin reached over HTTPS at `{url}/__plugin/...`. The CMS forwards the
-- plugin's own `secret` (falling back to env PLUGIN_SECRET when NULL).
CREATE TABLE IF NOT EXISTS plugins(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Admin-friendly label for the manage UI (the manifest name is preferred when reachable).
    label TEXT NOT NULL DEFAULT '',
    -- Base URL; the CMS calls {url}/__plugin/manifest, /hooks/*, /admin/*, /publish/*.
    url TEXT NOT NULL UNIQUE,
    -- 1 = active (manifest resolved + content types merged); 0 = registered but inert.
    enabled INTEGER NOT NULL DEFAULT 1,
    -- Optional JSON config (reserved for forwarding plugin settings).
    config TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Per-plugin shared secret; NULL falls back to env PLUGIN_SECRET.
    secret TEXT
);

-- Pinned plugin identity — binds a registry row to the manifest id it first
-- resolved with (trust on first use).
--
-- Everything else a plugin owns (asset, page-type and file-prefix approvals,
-- plugin_state, tenant enrollment, limit/credit settings) is keyed by the
-- MANIFEST id, which the plugin Worker asserts about itself and can change at
-- any time. Without this table a second plugin could claim an id already in
-- use — or one left behind by a deleted plugin — and inherit its approvals.
-- The UNIQUE constraint makes a manifest id belong to exactly one row, and the
-- registry refuses to resolve a plugin whose manifest stops matching its pin.
CREATE TABLE IF NOT EXISTS plugin_identity_approvals(
    -- plugins.id of the owning registry row (the row, not the manifest).
    -- ON DELETE CASCADE so an unregistered plugin releases its id: the admin
    -- delete route already does this explicitly, but a row removed any other
    -- way must not leave a pin that blocks re-registering the same plugin.
    plugin_row_id INTEGER PRIMARY KEY REFERENCES plugins(id) ON DELETE CASCADE,
    manifest_id TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Email of the admin who re-approved a changed identity; empty when the
    -- pin was taken automatically on first resolution.
    approved_by TEXT NOT NULL DEFAULT ''
);

-- Admin-approved, integrity-pinned plugin assets.
CREATE TABLE IF NOT EXISTS plugin_asset_approvals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    plugin_id TEXT NOT NULL,
    path TEXT NOT NULL,
    integrity TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, path)
);

-- Admin-approved delegated plugin page-type access.
CREATE TABLE IF NOT EXISTS plugin_page_type_approvals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    plugin_id TEXT NOT NULL,
    page_type TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read', 'write')),
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, page_type, access)
);

-- Admin-approved plugin file prefixes. A prefix is globally reserved so two
-- plugins cannot write the same folder (or nested folders under one another).
CREATE TABLE IF NOT EXISTS plugin_file_prefix_approvals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    plugin_id TEXT NOT NULL,
    prefix TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, prefix),
    UNIQUE(prefix)
);

-- Host-owned per-plugin state, read and written by the plugin Worker over
-- /__cms/state. A plugin Worker serving several CMS hosts must not be the
-- system of record for any one host's data: keeping it here means the record
-- is backed up, auditable and deleted with the host that owns it, instead of
-- outliving it in the plugin's own KV.
--
-- `value` is opaque JSON the CMS never parses. NOT for secrets — D1 is
-- plaintext at rest, so credentials stay in the plugin's Worker secrets.
-- The primary key serves both point reads and `WHERE plugin_id = ?` scans,
-- so no extra index is needed.
CREATE TABLE IF NOT EXISTS plugin_state(
    -- Manifest id of the owning plugin, as in the approval tables above.
    plugin_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (plugin_id, key)
);

CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_plugin_asset_approvals_plugin ON plugin_asset_approvals(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_page_type_approvals_plugin ON plugin_page_type_approvals(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_file_prefix_approvals_plugin ON plugin_file_prefix_approvals(plugin_id);

-- Feature: plugin-pointer-indexes — expression indexes for the JSON pointer
-- feature: plugin-pointer-indexes
-- lookups issued by specific plugins (events, EDM, contacts).
-- requires: plugins
--
-- These are pure query accelerators on the core pages table: dropping
-- them loses no data and no functionality, only speed, and only for the
-- plugins that use those pointers. Install alongside the matching plugin.
--
-- It has its own slice directory rather than living beside the platform's
-- schema, so dropping src/features/plugins does not silently take a fragment
-- that cms.features.json still lists with it.
--
-- SQLite only uses an expression index when the query spells the expression
-- identically, so these must stay byte-for-byte in sync with the SQL in
-- src/routes/cms-api.ts.

CREATE INDEX IF NOT EXISTS idx_pages_pointer_mail_list
    ON pages(json_extract(lect, '$._pointers.mail_list'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pages_pointer_event
    ON pages(json_extract(lect, '$._pointers.event'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pages_pointer_edm
    ON pages(json_extract(lect, '$._pointers.edm'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pages_pointer_contact
    ON pages(json_extract(lect, '$._pointers.contact'), page_type, updated_at DESC, id DESC);

-- Feature: runtime-content-types — runtime-editable page and block types.
-- feature: runtime-content-types
-- Without it the CMS still works, using only the compiled cms-config.ts
-- blueprint plus whatever plugin manifests contribute.

-- Page Types – runtime-editable content types, merged on top of
-- cms-config.ts + plugins by resolveCmsConfig(). See page-type-store.ts.
CREATE TABLE IF NOT EXISTS page_types(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- slug: the page-type key (e.g. 'event'); becomes the blueprint map key
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    -- JSON array of BlueprintEntry for this type (required)
    blueprint TEXT NOT NULL,
    -- Optional JSON arrays of names: block_lists = block-type slugs available on
    -- this page type; taxonomy_lists = taxonomy slugs shown in its editor.
    block_lists TEXT,
    taxonomy_lists TEXT,
    weight INTEGER DEFAULT 5
);

-- Block Types – reusable block definitions (a named blueprint) merged into
-- config.blocks by resolveCmsConfig(). See block-type-store.ts.
CREATE TABLE IF NOT EXISTS block_types(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- slug: the block-type key (e.g. 'logos'); becomes the blocks map key
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    -- JSON array of BlueprintEntry for this block's fields (required)
    blueprint TEXT NOT NULL,
    weight INTEGER DEFAULT 5
);

CREATE TRIGGER IF NOT EXISTS block_types_updated_at AFTER UPDATE ON block_types WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE block_types SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

-- Feature: trash — soft-delete holding area with full version history.
-- feature: trash
-- Without it, page deletes must be hard deletes.

-- Trash Pages
CREATE TABLE IF NOT EXISTS trash_pages(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    weight INTEGER DEFAULT 5,
    start DATETIME,
    end DATETIME,
    -- IANA tz name or UTC offset (e.g. 'Asia/Hong_Kong', '+0800') for start/end.
    timezone TEXT,
    page_type TEXT,
    lect TEXT,
    page_id INTEGER,
    -- Original draft parent id, retained so a trashed child can be restored
    -- under a parent that remains live (page_id references another trash row).
    source_page_id INTEGER,
    creator INTEGER,
    editors TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- Trash Page Tags
CREATE TABLE IF NOT EXISTS trash_page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- Trash Page Versions – mirrors page_versions for trashed pages so deleting
-- a page no longer loses its history and a restore brings every version back.
CREATE TABLE IF NOT EXISTS trash_page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trash_page_versions_page_id ON trash_page_versions(page_id);
CREATE INDEX IF NOT EXISTS idx_trash_pages_source_page_id ON trash_pages(source_page_id);

CREATE TRIGGER IF NOT EXISTS trash_pages_updated_at AFTER UPDATE ON trash_pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trash_page_tags_updated_at AFTER UPDATE ON trash_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
