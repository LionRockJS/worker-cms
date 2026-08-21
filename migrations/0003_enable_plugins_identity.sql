-- ============================================================
-- Additive migration: pinned plugin identity.
--
-- The table's permanent home is src/features/plugins/schema.sql, which the
-- baseline (0001) is generated from — that covers fresh databases. This file
-- creates it on a database that already applied the baseline, and is written
-- as CREATE TABLE IF NOT EXISTS so applying it after a regenerated baseline is
-- a no-op rather than an error.
--
-- No back-fill: the registry pins each enabled plugin to the manifest id it
-- currently serves on the next resolution (trust on first use), and enforces
-- it from then on.
-- ============================================================

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
