-- Core upgrade for existing installations; no data deletion. Apply once,
-- before deploying the code that reads the column: ADD COLUMN cannot be
-- written idempotently, and the session queries fail closed without it.
ALTER TABLE sessions ADD COLUMN last_activity_at DATETIME;
-- Carry each session's current idle deadline over unchanged: the previous
-- code measured inactivity from the last rotation. Neither extends nor ends
-- a session at rollout.
UPDATE sessions SET last_activity_at = COALESCE(rotated_at, created_at) WHERE last_activity_at IS NULL;
