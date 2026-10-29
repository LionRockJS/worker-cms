-- ============================================================
-- Manual migration: data_classes, the container classification registry.
--
-- The table's permanent home is src/core/schema.sql, which the baseline (0001)
-- is generated from — that covers fresh databases. This file creates it on a
-- database that already applied the baseline.
--
-- It lives under migrations/manual/ because migrations/ carries the baseline
-- and `*_enable_*` files only (test/migration-contract.test.ts enforces that),
-- and a core table has no feature to enable. Wrangler's migrations_dir does not
-- descend into this directory, so apply it by hand to every existing database:
--
--   wrangler d1 execute <db> --remote --file migrations/manual/2026-10-30_data_classes.sql
--
-- Delete it once every database has it; the baseline is the permanent home.
--
-- Creating the table changes nothing on its own: while it is empty, no read is
-- recorded. Classifying a container is what turns read logging on for it.
--
-- See docs/access-logging-design-2026-10-29.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS data_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_kind TEXT NOT NULL,            -- 'page_type' | 'taxonomy' | 'media_prefix' | 'plugin' | 'table'
    container_key TEXT NOT NULL,             -- page type slug, R2 key prefix, contributor id or table name
    class TEXT NOT NULL,                     -- 'pii' | 'phi'
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (container_kind, container_key)
);
