-- Page policies survive trash and restore, which preserve the page UUID.
-- A missing or disabled policy retains legacy role-based access.
CREATE TABLE IF NOT EXISTS page_access_policies (
    page_uuid TEXT PRIMARY KEY NOT NULL,
    owner_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    group_role TEXT,
    mode INTEGER NOT NULL CHECK (
        mode BETWEEN 0 AND 666 AND mode / 100 IN (0, 4, 6)
        AND mode / 10 % 10 IN (0, 4, 6) AND mode % 10 IN (0, 4, 6)
    ),
    revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS page_edit_grants (
    page_uuid TEXT NOT NULL REFERENCES page_access_policies(page_uuid) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (page_uuid, user_id)
);
CREATE INDEX IF NOT EXISTS idx_page_edit_grants_user ON page_edit_grants(user_id, page_uuid);
