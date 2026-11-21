-- Existing CMS databases only; fresh installs include this in the baseline.
-- Holds that end by themselves, and holds placed by plugins (record_holds in
-- src/core/schema.sql). A hold past its keep_until date no longer stops a purge.
ALTER TABLE record_holds ADD COLUMN placed_by_plugin TEXT;
ALTER TABLE record_holds ADD COLUMN keep_until TEXT CHECK (keep_until IS NULL OR keep_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
