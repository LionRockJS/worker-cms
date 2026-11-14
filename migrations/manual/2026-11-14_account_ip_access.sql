-- Existing databases only; fresh installs include these columns in the baseline.
ALTER TABLE users ADD COLUMN ip_unrestricted INTEGER NOT NULL DEFAULT 0 CHECK(ip_unrestricted IN (0, 1));
ALTER TABLE roles ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]';
