-- Apply only on deployments with the trash tables, after sensitivity_core.
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
