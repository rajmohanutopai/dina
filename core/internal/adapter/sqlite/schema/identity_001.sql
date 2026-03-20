-- identity_001.sql — Identity database schema (one per installation)
-- Applied on first boot. All tables use WITHOUT ROWID where practical.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Contacts directory: DID-indexed
CREATE TABLE IF NOT EXISTS contacts (
    did           TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL DEFAULT '',
    trust_level   TEXT NOT NULL DEFAULT 'unknown'
        CHECK (trust_level IN ('blocked','unknown','verified','trusted')),
    sharing_tier  TEXT NOT NULL DEFAULT 'none'
        CHECK (sharing_tier IN ('none','summary','full','locked')),
    notes         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);

-- Audit log: append-only, hash-chained
CREATE TABLE IF NOT EXISTS audit_log (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,
    resource      TEXT NOT NULL DEFAULT '',
    detail        TEXT NOT NULL DEFAULT '',
    prev_hash     TEXT NOT NULL DEFAULT '',
    entry_hash    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);

-- Device tokens: paired devices
CREATE TABLE IF NOT EXISTS device_tokens (
    device_id     TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL,
    device_name   TEXT NOT NULL DEFAULT '',
    last_seen     INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    revoked       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Crash log: sanitized crash entries
CREATE TABLE IF NOT EXISTS crash_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    component     TEXT NOT NULL,
    message       TEXT NOT NULL,
    stack_hash    TEXT NOT NULL DEFAULT '',
    reported      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crash_log_ts ON crash_log(ts);

-- Key-value store: general purpose per-identity settings
CREATE TABLE IF NOT EXISTS kv_store (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

-- Scratchpad: cognitive checkpointing for multi-step reasoning
CREATE TABLE IF NOT EXISTS scratchpad (
    task_id       TEXT PRIMARY KEY,
    step          INTEGER NOT NULL DEFAULT 0,
    context       TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

-- Task queue: outbox pattern for async tasks
CREATE TABLE IF NOT EXISTS dina_tasks (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    payload       TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','failed','dead_letter')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    scheduled_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    started_at    INTEGER,
    completed_at  INTEGER,
    error         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_dina_tasks_status ON dina_tasks(status, scheduled_at);

-- Reminders: scheduled notifications
CREATE TABLE IF NOT EXISTS reminders (
    id            TEXT PRIMARY KEY,
    message       TEXT NOT NULL,
    due_at        INTEGER NOT NULL,
    recurring     TEXT NOT NULL DEFAULT ''
        CHECK (recurring IN ('','daily','weekly','monthly')),
    completed     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE completed = 0;

-- Staging inbox: global connector ingestion pipeline
CREATE TABLE IF NOT EXISTS staging_inbox (
    id                TEXT PRIMARY KEY,
    connector_id      TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    source_id         TEXT NOT NULL DEFAULT '',
    source_hash       TEXT NOT NULL DEFAULT '',
    type              TEXT NOT NULL DEFAULT '',
    summary           TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL DEFAULT '',
    sender            TEXT NOT NULL DEFAULT '',
    metadata          TEXT NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','classifying','stored','pending_unlock','failed')),
    target_persona    TEXT NOT NULL DEFAULT '',
    classified_item   TEXT NOT NULL DEFAULT '{}',
    error             TEXT NOT NULL DEFAULT '',
    retry_count       INTEGER NOT NULL DEFAULT 0,
    claimed_at        INTEGER NOT NULL DEFAULT 0,
    lease_until       INTEGER NOT NULL DEFAULT 0,
    expires_at        INTEGER NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    -- Ingress provenance (server-derived, never caller-supplied for external callers)
    ingress_channel   TEXT NOT NULL DEFAULT '',
    origin_did        TEXT NOT NULL DEFAULT '',
    origin_kind       TEXT NOT NULL DEFAULT '',
    producer_id       TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_inbox_dedup ON staging_inbox(producer_id, source, source_id);
CREATE INDEX IF NOT EXISTS idx_staging_inbox_status ON staging_inbox(status);
CREATE INDEX IF NOT EXISTS idx_staging_inbox_expires ON staging_inbox(expires_at);

-- Schema version tracking (same as persona vaults)
CREATE TABLE IF NOT EXISTS schema_version (
    version       INTEGER PRIMARY KEY,
    applied_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    description   TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO schema_version(version, description)
VALUES (1, 'Initial identity schema with contacts, devices, audit, KV, reminders, staging');
