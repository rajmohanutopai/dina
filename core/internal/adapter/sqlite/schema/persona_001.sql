-- persona_001.sql — Per-persona encrypted database schema
-- One SQLCipher database per persona, keyed with persona DEK.
-- Applied when a new persona is created.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Vault items: the core data store
CREATE TABLE IF NOT EXISTS vault_items (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL
        CHECK (type IN ('email','message','event','note','photo',
                        'email_draft','cart_handover','contact_card',
                        'document','bookmark','voice_memo')),
    source        TEXT NOT NULL DEFAULT '',
    source_id     TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    metadata      TEXT NOT NULL DEFAULT '{}',
    tags          TEXT NOT NULL DEFAULT '[]',
    timestamp     INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(type);
CREATE INDEX IF NOT EXISTS idx_vault_items_source ON vault_items(source, source_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_ts ON vault_items(timestamp);

-- FTS5 full-text search index on vault items
CREATE VIRTUAL TABLE IF NOT EXISTS vault_items_fts USING fts5(
    summary,
    body,
    tags,
    content='vault_items',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS5 triggers for automatic sync
CREATE TRIGGER IF NOT EXISTS vault_items_ai AFTER INSERT ON vault_items BEGIN
    INSERT INTO vault_items_fts(rowid, summary, body, tags)
    VALUES (new.rowid, new.summary, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS vault_items_ad AFTER DELETE ON vault_items BEGIN
    INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags)
    VALUES ('delete', old.rowid, old.summary, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS vault_items_au AFTER UPDATE ON vault_items BEGIN
    INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags)
    VALUES ('delete', old.rowid, old.summary, old.body, old.tags);
    INSERT INTO vault_items_fts(rowid, summary, body, tags)
    VALUES (new.rowid, new.summary, new.body, new.tags);
END;

-- Vector embeddings (sqlite-vec)
-- Note: Requires sqlite-vec extension loaded at runtime
-- CREATE VIRTUAL TABLE IF NOT EXISTS vault_items_vec USING vec0(
--     embedding float[384],
--     item_id text
-- );

-- Staging area: temporary items before confirmation
CREATE TABLE IF NOT EXISTS staging (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    metadata      TEXT NOT NULL DEFAULT '{}',
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_staging_expires ON staging(expires_at);

-- Relationships: links between vault items
CREATE TABLE IF NOT EXISTS relationships (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id       TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
    to_id         TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
    rel_type      TEXT NOT NULL DEFAULT 'related'
        CHECK (rel_type IN ('related','reply_to','attachment','duplicate','thread')),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(from_id, to_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);

-- Embedding metadata: tracks which model version was used
CREATE TABLE IF NOT EXISTS embedding_meta (
    item_id       TEXT PRIMARY KEY REFERENCES vault_items(id) ON DELETE CASCADE,
    model_name    TEXT NOT NULL,
    model_version TEXT NOT NULL DEFAULT '',
    dimensions    INTEGER NOT NULL DEFAULT 384,
    embedded_at   INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version       INTEGER PRIMARY KEY,
    applied_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    description   TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO schema_version(version, description)
VALUES (1, 'Initial persona schema with vault_items, FTS5, staging, relationships');
