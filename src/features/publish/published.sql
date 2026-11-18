-- ============================================================
-- Published content schema - applied to the published-only DB
--
-- This whole database belongs to the "d1" publish target. A deployment that
-- publishes only to R2, or to a plugin target, never reads it.
--
-- `pages` here is the same shape and the same name as the CMS database's own
-- table (src/core/schema.sql), so a published database can be handed to another
-- host as its working set: publish A → B, then B → C. Comments disambiguate the
-- two by binding — `PUBLISHED_DB.pages` is this one, `DB.pages` is the CMS's.
-- ============================================================

CREATE TABLE IF NOT EXISTS pages(
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
    creator INTEGER,
    editors TEXT
);

CREATE TABLE IF NOT EXISTS page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- Tag catalogue, mirrored from DB.tags by the publish path so a reader of this
-- database can resolve a page_tags link to a name, slug and taxonomy without a
-- second database to join against. Public sites group by tag, so the catalogue
-- ships; `taxonomies` deliberately does not — the grouping key a tag carries is
-- its `taxonomy_slug`, and the taxonomy's own name is an admin-side label.
--
-- The CMS stays the source of truth: tag create/update pushes here
-- (publishTagsToTargets), tag delete removes here (removeTagFromTargets). Same
-- name and shape as DB.tags, so the chain publish A → B → C keeps working.
CREATE TABLE IF NOT EXISTS tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    weight INTEGER DEFAULT 5,
    taxonomy_slug TEXT,
    -- Deliberately NOT a foreign key, unlike DB.tags.parent_tag: tags arrive
    -- here one admin edit at a time, in no particular order, so a child can be
    -- mirrored before its parent exists. Readers already tolerate a parent_tag
    -- that resolves to nothing, exactly as they do for pages.page_id.
    parent_tag INTEGER,
    lect TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_page_type_name ON pages(page_type, name);
CREATE INDEX IF NOT EXISTS idx_pages_page_type_slug ON pages(page_type, slug);
CREATE INDEX IF NOT EXISTS idx_pages_page_type_page_id ON pages(page_type, page_id);
CREATE INDEX IF NOT EXISTS idx_pages_page_type_created_at ON pages(page_type, created_at);
CREATE INDEX IF NOT EXISTS idx_pages_created_at_uuid ON pages(created_at, uuid);
CREATE INDEX IF NOT EXISTS idx_page_tags_page_id ON page_tags(page_id);
CREATE INDEX IF NOT EXISTS idx_page_tags_tag_id ON page_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tags_taxonomy_slug_weight_name ON tags(taxonomy_slug, weight, name);
CREATE INDEX IF NOT EXISTS idx_tags_parent_tag ON tags(parent_tag);

CREATE TRIGGER IF NOT EXISTS pages_updated_at AFTER UPDATE ON pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_tags_updated_at AFTER UPDATE ON page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tags_updated_at AFTER UPDATE ON tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
