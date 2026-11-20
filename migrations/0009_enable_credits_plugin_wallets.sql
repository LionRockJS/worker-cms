-- Plugin wallets (credits feature): credits a plugin's creator supplies to
-- this site, spendable only on that plugin's own costs. Copied from
-- src/features/credits/schema.sql; idempotent, so safe on a database that
-- already has the tables from a fresh baseline.
CREATE TABLE IF NOT EXISTS plugin_credits(
    plugin_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plugin_id, currency)
);

CREATE TABLE IF NOT EXISTS plugin_credit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER,
    entity_type TEXT,
    entity_id TEXT,
    grant_id TEXT,
    note TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    UNIQUE (plugin_id, grant_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_credit_ledger_plugin ON plugin_credit_ledger(plugin_id, currency, id DESC);
