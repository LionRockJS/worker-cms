-- ============================================================
-- Additive migration: host-owned plugin sequences (/__cms/sequences).
--
-- The table's permanent home is src/features/plugins/schema.sql, which the
-- baseline (0001) is generated from — that covers fresh databases. This file
-- creates it on a database that already applied the baseline, and is written
-- as CREATE TABLE IF NOT EXISTS so applying it after a regenerated baseline is
-- a no-op rather than an error.
-- ============================================================

CREATE TABLE IF NOT EXISTS plugin_sequences(
    plugin_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (plugin_id, key)
);
