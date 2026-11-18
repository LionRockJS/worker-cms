-- feature: publish

-- Submission sources to erase from the published database (W12). Purging a
-- submission mirror records its uuid here in the same batch; the source row is
-- deleted after the purge commits and erased_at confirms it. A row with no
-- erased_at is retried by cron. Ingest never mirrors a uuid listed here, so a
-- restored published database cannot bring an erased submission back.
CREATE TABLE IF NOT EXISTS submission_erasures (
    uuid TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    erased_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submission_erasures_pending ON submission_erasures (requested_at) WHERE erased_at IS NULL;
