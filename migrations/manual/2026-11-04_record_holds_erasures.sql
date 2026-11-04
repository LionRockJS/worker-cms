-- Core upgrade for existing installations; no data deletion. Apply before
-- deploying the code that reads these tables: purge and submission ingest
-- fail closed without them.
CREATE TABLE IF NOT EXISTS record_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_uuid TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    placed_by INTEGER NOT NULL,
    placed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_by INTEGER,
    released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_holds_active ON record_holds (page_uuid) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS submission_erasures (
    uuid TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    erased_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submission_erasures_pending ON submission_erasures (requested_at) WHERE erased_at IS NULL;
