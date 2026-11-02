-- Core upgrade for existing installations; idempotent, no data deletion.
-- Revocation must not depend on the primary audit stream being writable.
-- Pending evidence is committed with the revocation, delivered idempotently,
-- and never pruned until its exact primary event has been verified.
CREATE TABLE IF NOT EXISTS audit_mutation_outbox (
    event_id TEXT PRIMARY KEY NOT NULL,
    envelope TEXT NOT NULL CHECK(json_valid(envelope) AND length(CAST(envelope AS BLOB)) <= 16384
      AND json_extract(envelope, '$.row.eventId') IS event_id),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 8),
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_mutation_outbox_due ON audit_mutation_outbox (attempts, next_attempt_at);
