/**
 * SQL schema definitions for identity and persona databases.
 *
 * Identity DB migrations: contacts, audit, devices, reminders, staging, KV.
 * Persona DB migrations: vault_items + FTS5.
 *
 * Source: packages/fixtures/schema/identity_001.sql, persona_001.sql
 */

import type { Migration } from './migration';

// ---------------------------------------------------------------
// Identity DB migrations
// ---------------------------------------------------------------

export const IDENTITY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_identity_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS contacts (
        did TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'unknown',
        sharing_tier TEXT NOT NULL DEFAULT 'summary',
        relationship TEXT NOT NULL DEFAULT 'unknown',
        data_responsibility TEXT NOT NULL DEFAULT 'external',
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        -- PC-CORE-02: user-asserted "this is my go-to contact for X"
        -- category bindings (e.g. '["dental","tax"]'). Replaces the
        -- auto-enriched live_capability path that stamped AppView
        -- capability data onto topic memories. NOT NULL DEFAULT '[]'
        -- so reads never need a null-check. See
        -- docs/WORKING_MEMORY_DESIGN.md §6.1.
        preferred_for TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS contact_aliases (
        alias_normalized TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES contacts(did) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_contact_aliases_did ON contact_aliases(did);

      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);

      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        did TEXT NOT NULL DEFAULT '',
        public_key_multibase TEXT NOT NULL,
        device_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'rich',
        auth_type TEXT NOT NULL DEFAULT 'ed25519',
        last_seen INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_devices_pubkey ON paired_devices(public_key_multibase);
      CREATE INDEX IF NOT EXISTS idx_devices_did ON paired_devices(did);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        persona TEXT NOT NULL DEFAULT 'general',
        kind TEXT NOT NULL DEFAULT 'manual',
        source_item_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        recurring TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        completed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(source_item_id, kind, due_at, persona)
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE completed=0;
      CREATE INDEX IF NOT EXISTS idx_reminders_persona ON reminders(persona);
      CREATE INDEX IF NOT EXISTS idx_reminders_short_id ON reminders(short_id);

      CREATE TABLE IF NOT EXISTS staging_inbox (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        producer_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'received',
        persona TEXT NOT NULL DEFAULT '',
        retry_count INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        source_hash TEXT NOT NULL DEFAULT '',
        classified_item TEXT,
        error TEXT,
        approval_id TEXT,
        UNIQUE(producer_id, source, source_id)
      );

      CREATE INDEX IF NOT EXISTS idx_staging_status ON staging_inbox(status);
      CREATE INDEX IF NOT EXISTS idx_staging_expires ON staging_inbox(expires_at);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID
    `,
  },
  {
    // Bus Driver Scenario (commit f3a1bc7) — local service configuration.
    // Schema is key-value; a single 'self' row carries the operator's
    // JSON-encoded service profile. See service/service_config.ts.
    version: 2,
    name: 'service_config',
    sql: `
      CREATE TABLE IF NOT EXISTS service_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID
    `,
  },
  {
    // WS2 Workflow Tasks (commit 9c01611) — durable single-item work model
    // used for service queries, approvals, delegations, timers, watches.
    // Mirrors main dina's `core/internal/adapter/sqlite/workflow.go`.
    //
    // Index notes:
    //   - Partial unique on idempotency_key (non-terminal rows only) lets
    //     terminal/active tasks share the same natural key without UNIQUE
    //     collisions. Matches Go's `idx_workflow_idem`.
    //   - `(kind, state, expires_at)` serves the sweeper's "list expiring
    //     approval tasks" query.
    //   - `correlation_id` index serves `GetByCorrelationId` / `FindServiceQueryTask`.
    //
    // workflow_events carries delivery-attempt fields so the event fanout
    // can be retried when Brain is offline or crashes mid-tick.
    version: 3,
    name: 'workflow_tasks',
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        correlation_id TEXT,
        parent_id TEXT,
        proposal_id TEXT,
        priority TEXT NOT NULL,
        description TEXT NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        result_summary TEXT NOT NULL DEFAULT '',
        policy TEXT NOT NULL DEFAULT '',
        error TEXT,
        requested_runner TEXT,
        assigned_runner TEXT,
        agent_did TEXT,
        run_id TEXT,
        progress_note TEXT,
        lease_expires_at INTEGER,
        origin TEXT CHECK (origin IN ('','telegram','api','d2d','admin','system','cli')),
        session_name TEXT,
        idempotency_key TEXT,
        expires_at INTEGER,
        next_run_at INTEGER,
        recurrence TEXT,
        internal_stash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_idem
        ON workflow_tasks(idempotency_key)
        WHERE idempotency_key IS NOT NULL
          AND state NOT IN ('completed','failed','cancelled','recorded');

      CREATE INDEX IF NOT EXISTS idx_workflow_tasks_kind_state_expiry
        ON workflow_tasks(kind, state, expires_at);

      CREATE INDEX IF NOT EXISTS idx_workflow_tasks_correlation
        ON workflow_tasks(correlation_id);

      CREATE TABLE IF NOT EXISTS workflow_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        event_kind TEXT NOT NULL,
        needs_delivery INTEGER NOT NULL DEFAULT 0,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        next_delivery_at INTEGER,
        delivering_until INTEGER,
        delivered_at INTEGER,
        acknowledged_at INTEGER,
        delivery_failed INTEGER NOT NULL DEFAULT 0,
        details TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_events_task_at
        ON workflow_events(task_id, at DESC);

      CREATE INDEX IF NOT EXISTS idx_workflow_events_delivery
        ON workflow_events(needs_delivery, next_delivery_at)
        WHERE needs_delivery = 1;

      -- Chat messages (review #14). Greenfield schema — no migration
      -- from the prior in-memory-only design. Stored per thread so the
      -- UI can list a single conversation efficiently.
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          TEXT    PRIMARY KEY,
        thread_id   TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        content     TEXT    NOT NULL DEFAULT '',
        metadata    TEXT    NOT NULL DEFAULT '{}',  -- JSON
        sources     TEXT    NOT NULL DEFAULT '[]',  -- JSON array
        timestamp   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_ts
        ON chat_messages(thread_id, timestamp ASC)
    `,
  },
];

// ---------------------------------------------------------------
// Persona DB migrations
// ---------------------------------------------------------------

export const PERSONA_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_persona_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS vault_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'note',
        source TEXT NOT NULL DEFAULT '',
        source_id TEXT NOT NULL DEFAULT '',
        contact_did TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        content_l0 TEXT NOT NULL DEFAULT '',
        content_l1 TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sender TEXT NOT NULL DEFAULT '',
        sender_trust TEXT NOT NULL DEFAULT 'unknown',
        source_type TEXT NOT NULL DEFAULT '',
        confidence TEXT NOT NULL DEFAULT 'medium',
        retrieval_policy TEXT NOT NULL DEFAULT 'normal',
        contradicts TEXT NOT NULL DEFAULT '',
        enrichment_status TEXT NOT NULL DEFAULT 'pending',
        enrichment_version TEXT NOT NULL DEFAULT '',
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(type);
      CREATE INDEX IF NOT EXISTS idx_vault_items_timestamp ON vault_items(timestamp);
      CREATE INDEX IF NOT EXISTS idx_vault_items_deleted ON vault_items(deleted);
      CREATE INDEX IF NOT EXISTS idx_vault_items_sender ON vault_items(sender);
      CREATE INDEX IF NOT EXISTS idx_vault_items_retrieval ON vault_items(retrieval_policy);

      CREATE VIRTUAL TABLE IF NOT EXISTS vault_items_fts USING fts5(
        summary, body, tags, contact_did, content_l0, content_l1,
        content='vault_items', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS vault_items_ai AFTER INSERT ON vault_items BEGIN
        INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did, content_l0, content_l1)
        VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did, new.content_l0, new.content_l1);
      END;

      CREATE TRIGGER IF NOT EXISTS vault_items_ad AFTER DELETE ON vault_items BEGIN
        INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did, content_l0, content_l1)
        VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did, old.content_l0, old.content_l1);
      END;

      CREATE TRIGGER IF NOT EXISTS vault_items_au AFTER UPDATE ON vault_items BEGIN
        INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did, content_l0, content_l1)
        VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did, old.content_l0, old.content_l1);
        INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did, content_l0, content_l1)
        VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did, new.content_l0, new.content_l1);
      END;

      -- Working-memory salience index (WM-CORE-01).
      -- One row per canonical topic per persona. No persona column —
      -- each persona keeps its own SQLCipher file. Fed by ingest-time
      -- Brain.topic_extractor → POST /v1/memory/topic/touch; read by
      -- the intent classifier via GET /v1/memory/toc.
      -- Design doc §4 (data model), §5 (scoring), §6.1 (capability
      -- bindings now live on contacts — Contact.preferredFor).
      CREATE TABLE IF NOT EXISTS topic_salience (
        topic          TEXT    PRIMARY KEY,
        kind           TEXT    NOT NULL CHECK (kind IN ('entity','theme')),
        last_update    INTEGER NOT NULL,
        s_short        REAL    NOT NULL DEFAULT 0,
        s_long         REAL    NOT NULL DEFAULT 0,
        sample_item_id TEXT    NOT NULL DEFAULT ''
      );

      -- The repository top() prefilters by stored s_long desc; this
      -- index backs the prefilter so we do not table-scan.
      CREATE INDEX IF NOT EXISTS idx_topic_salience_long
        ON topic_salience(s_long DESC);

      CREATE INDEX IF NOT EXISTS idx_topic_salience_kind
        ON topic_salience(kind);

      -- Variant -> canonical alias map (design doc section 6.2).
      -- Populated lazily by resolveAlias tier-2b when a stemmed
      -- variant matches an existing canonical row.
      CREATE TABLE IF NOT EXISTS topic_aliases (
        variant    TEXT PRIMARY KEY,
        canonical  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_topic_aliases_canonical
        ON topic_aliases(canonical)
    `,
  },
];
