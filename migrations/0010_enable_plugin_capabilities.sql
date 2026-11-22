-- Manifest-requested host capabilities require separate local approval.
CREATE TABLE IF NOT EXISTS plugin_capability_approvals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    plugin_id TEXT NOT NULL REFERENCES plugin_identity_approvals(manifest_id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, capability)
);
