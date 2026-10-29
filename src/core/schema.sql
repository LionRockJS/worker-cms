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

-- 9b. Audit events – supersedes audit_log. One stream for mutations, reads,
--     authentication and exports, carrying the request context a compliance
--     audit asks for. See docs/access-logging-design-2026-10-29.md.
--     audit_log is left in place as history; nothing writes to it any more.
CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- orders events written in the same millisecond
    event_id TEXT NOT NULL UNIQUE,           -- uuid; the same id in D1, the archive and any SIEM
    occurred_at TEXT NOT NULL,               -- ISO-8601 UTC with ms, set in code, never CURRENT_TIMESTAMP
    event_class TEXT NOT NULL,               -- 'auth' | 'read' | 'mutation' | 'export' | 'admin'
    data_class TEXT NOT NULL DEFAULT 'none', -- 'none' | 'pii' | 'phi'; set once containers are classified
    retention_class TEXT NOT NULL,           -- what the retention sweep goes by
    action TEXT NOT NULL,                    -- e.g. 'page.create', 'auth.login', 'media.upload'
    outcome TEXT NOT NULL DEFAULT 'success', -- 'success' | 'denied' | 'error'
    -- Internal user id only, never an email: the viewer joins users for a
    -- display name, so an erased account leaves the row intact with nothing
    -- left to resolve. NULL means no signed-in user — a contributor acting on
    -- its own, or an unauthenticated request.
    actor_user_id TEXT,
    actor_roles TEXT,                        -- role snapshot at the time; forensic, not identifying
    acting_via TEXT,                         -- contributor/plugin id when one is acting
    session_sid TEXT,                        -- JWTPayload.sid, so a session can be traced or revoked
    request_id TEXT,                         -- CF-Ray
    source_ip TEXT,
    user_agent TEXT,
    target_type TEXT,                        -- 'page' | 'media' | 'tag' | 'user' | 'query' | ...
    -- One target, the common case, kept scalar so it is indexable: "everything
    -- that touched page 101" is the question an investigation starts from.
    target_id TEXT,
    target_ids TEXT,                         -- JSON array when there are many, capped
    target_count INTEGER,                    -- authoritative even when target_ids is capped
    container_key TEXT,                      -- the classified container this touched
    query_fingerprint TEXT,                  -- hash of search criteria; never the raw terms
    detail TEXT                              -- small JSON (slug, filename); never content bodies
);

-- 9c. Data classification – which containers hold regulated data.
--     Empty by default, which is what makes read logging inert: core resolves
--     this table on any request that read something and records nothing when
--     the container is unclassified. Policy lives in data rather than in the
--     build profile, so an install cannot drop its audit control by editing
--     cms.features.json. Classification is per container, never per row: a row
--     test fails the moment a container that was clean starts holding
--     regulated data.
CREATE TABLE IF NOT EXISTS data_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'page_type' | 'taxonomy' | 'media_prefix' | 'plugin' | 'table'
    container_kind TEXT NOT NULL,
    -- the page type slug, R2 key prefix, contributor id or table name
    container_key TEXT NOT NULL,
    -- 'pii' | 'phi'. 'phi' additionally makes a failed audit write fail the
    -- request, so ePHI is never served without a record of who received it.
    class TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (container_kind, container_key)
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
CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events (target_type, target_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_retention ON audit_events (retention_class, occurred_at);
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
