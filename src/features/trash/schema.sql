-- Feature: trash — soft-delete holding area with full version history.
-- feature: trash
-- Without it, page deletes must be hard deletes.

-- Trash Pages
CREATE TABLE IF NOT EXISTS trash_pages(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    weight INTEGER DEFAULT 5,
    start DATETIME,
    end DATETIME,
    -- IANA tz name or UTC offset (e.g. 'Asia/Hong_Kong', '+0800') for start/end.
    timezone TEXT,
    page_type TEXT,
    lect TEXT,
    page_id INTEGER,
    -- Original draft parent id, retained so a trashed child can be restored
    -- under a parent that remains live (page_id references another trash row).
    source_page_id INTEGER,
    creator INTEGER,
    editors TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- Trash Page Tags
CREATE TABLE IF NOT EXISTS trash_page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- Trash Page Versions – mirrors page_versions for trashed pages so deleting
-- a page no longer loses its history and a restore brings every version back.
CREATE TABLE IF NOT EXISTS trash_page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trash_page_versions_page_id ON trash_page_versions(page_id);
CREATE INDEX IF NOT EXISTS idx_trash_pages_source_page_id ON trash_pages(source_page_id);

CREATE TRIGGER IF NOT EXISTS trash_pages_updated_at AFTER UPDATE ON trash_pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trash_page_tags_updated_at AFTER UPDATE ON trash_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

-- Feature-owned history capture; core never depends on optional trash tables.
CREATE VIEW IF NOT EXISTS sensitivity_trash_sources AS
SELECT p.uuid, f.level, f.container_kind, f.container_key FROM trash_pages p
JOIN data_class_floors f ON f.container_kind = 'page_type' AND f.container_key = COALESCE(p.page_type, 'default')
UNION ALL
SELECT p.uuid, f.level, f.container_kind, f.container_key FROM trash_page_tags pt
JOIN trash_pages p ON p.id = pt.page_id JOIN tags t ON t.id = pt.tag_id
JOIN data_class_floors f ON f.container_kind = 'taxonomy' AND f.container_key = COALESCE(t.taxonomy_slug, 'default');

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_page_insert AFTER INSERT ON trash_pages BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE uuid = NEW.uuid GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_page_update AFTER UPDATE OF page_type, uuid ON trash_pages BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level) SELECT NEW.uuid, level FROM page_sensitivity_floors WHERE uuid = OLD.uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE uuid = NEW.uuid GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_link_insert AFTER INSERT ON trash_page_tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE uuid = (SELECT uuid FROM trash_pages WHERE id = NEW.page_id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_link_update AFTER UPDATE OF tag_id, page_id ON trash_page_tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE uuid = (SELECT uuid FROM trash_pages WHERE id = NEW.page_id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_tag_update AFTER UPDATE OF taxonomy_slug ON tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE uuid IN (SELECT p.uuid FROM trash_pages p JOIN trash_page_tags pt ON pt.page_id = p.id WHERE pt.tag_id = NEW.id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_policy_insert AFTER INSERT ON data_class_floors BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE container_kind = NEW.container_kind AND container_key = NEW.container_key GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_trash_policy_update AFTER UPDATE ON data_class_floors WHEN NEW.level > OLD.level BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources WHERE container_kind = NEW.container_kind AND container_key = NEW.container_key GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_trash_sources  GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
