-- ============================================================
-- Manual migration: audit_events, the audit/access stream.
--
-- The table's permanent home is src/core/schema.sql, which the baseline (0001)
-- is generated from — that covers fresh databases. This file creates it on a
-- database that already applied the baseline, and is written as CREATE ... IF
-- NOT EXISTS so applying it after a regenerated baseline is a no-op rather
-- than an error.
--
-- It lives under migrations/manual/ because migrations/ carries the baseline
-- and `*_enable_*` files only (test/migration-contract.test.ts enforces that),
-- and a core table has no feature to enable. Wrangler's migrations_dir does not
-- descend into this directory, so apply it by hand to every existing database:
--
--   wrangler d1 execute <db> --remote --file migrations/manual/2026-10-29_audit_events.sql
--
-- Delete it once every database has it; the baseline is the permanent home.
--
-- audit_log is deliberately left alone. Nothing writes to it after this
-- change; its rows stay readable as history until the retention sweep
-- (phase 3) expires them. There is no backfill: the old rows cannot gain the
-- request context the new envelope carries, and rewriting a live audit trail
-- is worse than keeping two readable generations of it.
--
-- See docs/access-logging-design-2026-10-29.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- orders events written in the same millisecond
    event_id TEXT NOT NULL UNIQUE,           -- uuid; the same id in D1, the archive and any SIEM
    occurred_at TEXT NOT NULL,               -- ISO-8601 UTC with ms, set in code, never CURRENT_TIMESTAMP
    event_class TEXT NOT NULL,               -- 'auth' | 'read' | 'mutation' | 'export' | 'admin'
    data_class TEXT NOT NULL DEFAULT 'none', -- 'none' | 'pii' | 'phi'; set once containers are classified
    retention_class TEXT NOT NULL,           -- what the retention sweep goes by
    action TEXT NOT NULL,                    -- e.g. 'page.create', 'auth.login', 'media.upload'
    outcome TEXT NOT NULL DEFAULT 'success', -- 'success' | 'denied' | 'error'
    actor_user_id TEXT,                      -- internal user id only, never an email
    actor_roles TEXT,                        -- role snapshot at the time; forensic, not identifying
    acting_via TEXT,                         -- contributor/plugin id when one is acting
    session_sid TEXT,                        -- JWTPayload.sid, so a session can be traced or revoked
    request_id TEXT,                         -- CF-Ray
    source_ip TEXT,
    user_agent TEXT,
    target_type TEXT,                        -- 'page' | 'media' | 'tag' | 'user' | 'query' | ...
    target_id TEXT,                          -- the single target, kept scalar so it is indexable
    target_ids TEXT,                         -- JSON array when there are many, capped
    target_count INTEGER,                    -- authoritative even when target_ids is capped
    container_key TEXT,                      -- the classified container this touched
    query_fingerprint TEXT,                  -- hash of search criteria; never the raw terms
    detail TEXT                              -- small JSON (slug, filename); never content bodies
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events (target_type, target_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_retention ON audit_events (retention_class, occurred_at);
