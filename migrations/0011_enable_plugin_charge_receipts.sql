-- Completed metered charges, scoped to the authenticated plugin.
CREATE TABLE IF NOT EXISTS plugin_charge_receipts(
    plugin_id TEXT NOT NULL,
    charge_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY (plugin_id, charge_id)
);
