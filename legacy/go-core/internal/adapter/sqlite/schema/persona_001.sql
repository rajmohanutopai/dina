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
                        'document','bookmark','voice_memo','kv',
                        'contact','health_context','work_context',
                        'finance_context','family_context','trust_review',
                        'purchase_decision','relationship_note',
                        'medical_record','medical_note',
                        'trust_attestation')),
    source        TEXT NOT NULL DEFAULT '',
    source_id     TEXT NOT NULL DEFAULT '',
    contact_did   TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    metadata      TEXT NOT NULL DEFAULT '{}',
    embedding     BLOB,
    tags          TEXT NOT NULL DEFAULT '[]',
    timestamp     INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    deleted       INTEGER NOT NULL DEFAULT 0,
    -- Source trust & provenance (v3)
    sender            TEXT NOT NULL DEFAULT '',
    sender_trust      TEXT NOT NULL DEFAULT '',
    source_type       TEXT NOT NULL DEFAULT '',
    confidence        TEXT NOT NULL DEFAULT '',
    retrieval_policy  TEXT NOT NULL DEFAULT 'normal',
    contradicts       TEXT NOT NULL DEFAULT '',
    -- Tiered content L0/L1/L2 (v4)
    content_l0          TEXT NOT NULL DEFAULT '',
    content_l1          TEXT NOT NULL DEFAULT '',
    enrichment_status   TEXT NOT NULL DEFAULT 'pending',
    enrichment_version  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(type);
CREATE INDEX IF NOT EXISTS idx_vault_items_source ON vault_items(source, source_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_ts ON vault_items(timestamp);
CREATE INDEX IF NOT EXISTS idx_vault_items_contact ON vault_items(contact_did);
CREATE INDEX IF NOT EXISTS idx_vault_items_retrieval_policy ON vault_items(retrieval_policy);

-- FTS5 full-text search index on vault items
CREATE VIRTUAL TABLE IF NOT EXISTS vault_items_fts USING fts5(
    summary,
    body,
    tags,
    contact_did,
    content='vault_items',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS5 triggers for automatic sync
CREATE TRIGGER IF NOT EXISTS vault_items_ai AFTER INSERT ON vault_items BEGIN
    INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did)
    VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did);
END;

CREATE TRIGGER IF NOT EXISTS vault_items_ad AFTER DELETE ON vault_items BEGIN
    INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did)
    VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did);
END;

CREATE TRIGGER IF NOT EXISTS vault_items_au AFTER UPDATE ON vault_items BEGIN
    INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did)
    VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did);
    INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did)
    VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did);
END;

-- Staging area: temporary items before confirmation
CREATE TABLE IF NOT EXISTS staging (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    metadata      TEXT NOT NULL DEFAULT '{}',
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_staging_expires ON staging(expires_at);

-- Relationships: links between vault items
CREATE TABLE IF NOT EXISTS relationships (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id       TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
    to_id         TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
    rel_type      TEXT NOT NULL DEFAULT 'related'
        CHECK (rel_type IN ('related','reply_to','attachment','duplicate','thread')),
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    UNIQUE(from_id, to_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);

-- Embedding metadata: tracks which model version was used
CREATE TABLE IF NOT EXISTS embedding_meta (
    item_id       TEXT PRIMARY KEY REFERENCES vault_items(id) ON DELETE CASCADE,
    model_name    TEXT NOT NULL,
    model_version TEXT NOT NULL DEFAULT '',
    dimensions    INTEGER NOT NULL DEFAULT 768,
    embedded_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

-- Working memory: salience-ranked topic index (v5)
-- Each row is a named topic (entity or theme) with EWMA-decayed mention
-- counters at two timescales. Read at ToC-render time with decay applied
-- on the fly. See docs/WORKING_MEMORY_DESIGN.md.
CREATE TABLE IF NOT EXISTS topic_salience (
    topic             TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('entity','theme')),
    last_update       INTEGER NOT NULL,
    s_short           REAL NOT NULL DEFAULT 0,
    s_long            REAL NOT NULL DEFAULT 0,
    live_capability   TEXT NOT NULL DEFAULT '',
    live_provider_did TEXT NOT NULL DEFAULT '',
    sample_item_id    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_topic_salience_long ON topic_salience(s_long DESC);
CREATE INDEX IF NOT EXISTS idx_topic_salience_kind ON topic_salience(kind);

-- Topic aliases: variant → canonical mapping for canonicalisation.
-- Populated at extraction time by exact-match + stemmed lookup.
-- Embedding-similarity lookup (§6.2) is deferred to V2.
CREATE TABLE IF NOT EXISTS topic_aliases (
    variant    TEXT PRIMARY KEY,
    canonical  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_aliases_canonical ON topic_aliases(canonical);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version       INTEGER PRIMARY KEY,
    applied_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    description   TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO schema_version(version, description)
VALUES (1, 'Initial persona schema with vault_items, FTS5, staging, relationships');
INSERT OR IGNORE INTO schema_version(version, description)
VALUES (5, 'Working memory topic_salience + topic_aliases');
