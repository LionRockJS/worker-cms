-- Sensitivity is monotonic until a governed declassification workflow exists.
-- No foreign key: floors survive deletion, trashing and restoration of a UUID.
CREATE TABLE IF NOT EXISTS data_class_floors (
  container_kind TEXT NOT NULL,
  container_key TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level IN (1, 2)),
  PRIMARY KEY(container_kind, container_key)
);
CREATE TABLE IF NOT EXISTS page_sensitivity_floors (
  uuid TEXT PRIMARY KEY NOT NULL,
  level INTEGER NOT NULL CHECK(level IN (1, 2))
);

CREATE VIEW IF NOT EXISTS sensitivity_page_sources AS
SELECT p.uuid, f.level, f.container_kind, f.container_key FROM pages p
JOIN data_class_floors f ON f.container_kind = 'page_type' AND f.container_key = COALESCE(p.page_type, 'default')
UNION ALL
SELECT p.uuid, f.level, f.container_kind, f.container_key FROM page_tags pt
JOIN pages p ON p.id = pt.page_id JOIN tags t ON t.id = pt.tag_id
JOIN data_class_floors f ON f.container_kind = 'taxonomy' AND f.container_key = COALESCE(t.taxonomy_slug, 'default');

CREATE TRIGGER IF NOT EXISTS sensitivity_class_insert AFTER INSERT ON data_classes
WHEN NEW.class IN ('pii', 'phi') AND NEW.container_kind IN ('page_type', 'taxonomy', 'media_prefix', 'plugin', 'table')
AND length(trim(NEW.container_key)) > 0
BEGIN
  INSERT INTO data_class_floors (container_kind, container_key, level)
  VALUES (NEW.container_kind, NEW.container_key, CASE NEW.class WHEN 'phi' THEN 2 ELSE 1 END)
  ON CONFLICT(container_kind, container_key) DO UPDATE SET level = MAX(data_class_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_class_update AFTER UPDATE ON data_classes
WHEN NEW.class IN ('pii', 'phi') AND NEW.container_kind IN ('page_type', 'taxonomy', 'media_prefix', 'plugin', 'table')
AND length(trim(NEW.container_key)) > 0
BEGIN
  INSERT INTO data_class_floors (container_kind, container_key, level)
  VALUES (NEW.container_kind, NEW.container_key, CASE NEW.class WHEN 'phi' THEN 2 ELSE 1 END)
  ON CONFLICT(container_kind, container_key) DO UPDATE SET level = MAX(data_class_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_page_insert AFTER INSERT ON pages BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE uuid = NEW.uuid GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_page_update AFTER UPDATE OF page_type, uuid ON pages BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level) SELECT NEW.uuid, level FROM page_sensitivity_floors WHERE uuid = OLD.uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE uuid = NEW.uuid GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_link_insert AFTER INSERT ON page_tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE uuid = (SELECT uuid FROM pages WHERE id = NEW.page_id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_link_update AFTER UPDATE OF tag_id, page_id ON page_tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE uuid = (SELECT uuid FROM pages WHERE id = NEW.page_id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_tag_update AFTER UPDATE OF taxonomy_slug ON tags BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE uuid IN (SELECT p.uuid FROM pages p JOIN page_tags pt ON pt.page_id = p.id WHERE pt.tag_id = NEW.id) GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_policy_insert AFTER INSERT ON data_class_floors BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE container_kind = NEW.container_kind AND container_key = NEW.container_key GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_policy_update AFTER UPDATE ON data_class_floors WHEN NEW.level > OLD.level BEGIN
  INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources WHERE container_kind = NEW.container_kind AND container_key = NEW.container_key GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
END;

-- Idempotent upgrade: retain all classifications still observable at migration.
CREATE TRIGGER IF NOT EXISTS sensitivity_tag_move_guard BEFORE UPDATE OF taxonomy_slug ON tags
WHEN COALESCE(OLD.taxonomy_slug, 'default') <> COALESCE(NEW.taxonomy_slug, 'default')
AND COALESCE((SELECT level FROM data_class_floors WHERE container_kind = 'taxonomy' AND container_key = COALESCE(OLD.taxonomy_slug, 'default')), 0)
  > COALESCE((SELECT level FROM data_class_floors WHERE container_kind = 'taxonomy' AND container_key = COALESCE(NEW.taxonomy_slug, 'default')), 0)
BEGIN
  SELECT RAISE(ABORT, 'sensitivity_reduction_requires_review');
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_taxonomy_rename AFTER UPDATE OF slug ON taxonomies
WHEN OLD.slug <> NEW.slug
BEGIN
  INSERT INTO data_class_floors (container_kind, container_key, level)
  SELECT 'taxonomy', NEW.slug, level FROM data_class_floors WHERE container_kind = 'taxonomy' AND container_key = OLD.slug
  ON CONFLICT(container_kind, container_key) DO UPDATE SET level = MAX(data_class_floors.level, excluded.level);
END;

CREATE TRIGGER IF NOT EXISTS sensitivity_retype_guard BEFORE UPDATE OF page_type ON pages
WHEN COALESCE(OLD.page_type, 'default') <> COALESCE(NEW.page_type, 'default')
AND COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid = OLD.uuid), 0)
  > COALESCE((SELECT level FROM data_class_floors WHERE container_kind = 'page_type' AND container_key = COALESCE(NEW.page_type, 'default')), 0)
BEGIN
  SELECT RAISE(ABORT, 'sensitivity_reduction_requires_review');
END;

INSERT INTO data_class_floors (container_kind, container_key, level)
SELECT container_kind, container_key, CASE class WHEN 'phi' THEN 2 ELSE 1 END FROM data_classes
WHERE class IN ('pii', 'phi') AND container_kind IN ('page_type', 'taxonomy', 'media_prefix', 'plugin', 'table')
AND length(trim(container_key)) > 0
ON CONFLICT(container_kind, container_key) DO UPDATE SET level = MAX(data_class_floors.level, excluded.level);
INSERT INTO page_sensitivity_floors (uuid, level)
  SELECT uuid, MAX(level) FROM sensitivity_page_sources  GROUP BY uuid
  ON CONFLICT(uuid) DO UPDATE SET level = MAX(page_sensitivity_floors.level, excluded.level);
