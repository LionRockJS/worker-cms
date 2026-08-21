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
