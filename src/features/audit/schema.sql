-- Feature: audit — the audit log reader, the archive and the retention sweep.
-- feature: audit
--
-- audit_events and data_classes are deliberately NOT here: recording must not
-- be droppable, so they live in the core schema. What this fragment owns is
-- what only the sweep touches — the seal ledger that makes the archive
-- verifiable.
--
-- requires: core

-- One row per archived segment. The sweep writes the segment to R2, records it
-- here, and only then prunes the rows it covers from D1.
CREATE TABLE IF NOT EXISTS audit_seals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The seq range this segment covers. Completeness is proven by the ranges
    -- joining end to end, which timestamps cannot do: Workers freezes the clock
    -- between I/O, so every event in one request shares one occurred_at.
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    -- SHA-256 over the segment's canonical NDJSON.
    segment_hash TEXT NOT NULL,
    -- The previous seal's rolling_hash, so a segment cannot be replaced in
    -- isolation: swapping one breaks every seal after it.
    prev_hash TEXT,
    -- SHA-256(prev_hash || segment_hash).
    rolling_hash TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    sealed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_seals_last_seq ON audit_seals (last_seq);
