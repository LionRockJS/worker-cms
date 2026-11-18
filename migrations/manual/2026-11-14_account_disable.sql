-- Existing CMS databases only; fresh installs include this in the baseline.
ALTER TABLE users ADD COLUMN disabled_at DATETIME;
