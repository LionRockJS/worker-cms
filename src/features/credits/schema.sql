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

-- Plugin wallets: credits a plugin's creator supplies to this site, one row
-- per (plugin, currency). Spendable only on that plugin's own costs, before
-- the member's wallet and the shared pool. Missing rows are zero balances.
-- Forfeited (zeroed with a ledger row) when the plugin is unregistered, so a
-- Worker that later claims the same manifest id inherits nothing.
CREATE TABLE IF NOT EXISTS plugin_credits(
    plugin_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plugin_id, currency)
);

-- Append-only plugin wallet ledger. user_id is the member a spend benefited;
-- grant_id makes a plugin's grant/revoke idempotent (NULL for spends).
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

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_credit_ledger_plugin ON plugin_credit_ledger(plugin_id, currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_shared_credit_ledger_user ON shared_credit_ledger(user_id, currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_shared_credit_ledger_currency ON shared_credit_ledger(currency, id DESC);
CREATE INDEX IF NOT EXISTS idx_credit_subscriptions_due ON credit_subscriptions(status, next_charge_at);
-- Completed metered charges, scoped to the authenticated plugin.
CREATE TABLE IF NOT EXISTS plugin_charge_receipts(
    plugin_id TEXT NOT NULL,
    charge_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY (plugin_id, charge_id)
);
