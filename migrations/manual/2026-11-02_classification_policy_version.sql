-- Apply after sensitivity-floor upgrades, before deploying version-aware code.

-- Classification policy generation: changes, including change-and-restore,
-- invalidate previously resolved mutation classifications.
CREATE TABLE IF NOT EXISTS classification_policy_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 0)
);
INSERT OR IGNORE INTO classification_policy_version (id, version) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS classification_version_data_classes_insert AFTER INSERT ON data_classes BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS classification_version_data_classes_update AFTER UPDATE ON data_classes BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS classification_version_data_classes_delete AFTER DELETE ON data_classes BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS classification_version_data_class_floors_insert AFTER INSERT ON data_class_floors BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS classification_version_data_class_floors_update AFTER UPDATE ON data_class_floors BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS classification_version_data_class_floors_delete AFTER DELETE ON data_class_floors BEGIN
  UPDATE classification_policy_version SET version = version + 1 WHERE id = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Classification version unavailable') END;
END;
