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
      -- Contact policy is keyed by person_id, not DID: you trust a
      -- person across their devices/identities, so trust/sharing
      -- policy lives once per person (people graph hub). The DID-to-
      -- person mapping lives in person_identities; getContact(did)
      -- resolves did -> person_id -> contacts. See
      -- docs/IDENTITY_HUB_REDESIGN.md §3.4.
      CREATE TABLE IF NOT EXISTS contacts (
        person_id TEXT PRIMARY KEY,
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
        person_id TEXT NOT NULL REFERENCES contacts(person_id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_contact_aliases_person ON contact_aliases(person_id);

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

      -- A durable boundary makes an intentional retention sweep
      -- distinguishable from an attacker/corrupt writer deleting the head of
      -- the hash chain. There is exactly one row for the current retained
      -- suffix. No row means the chain must still begin at sequence 1/genesis.
      CREATE TABLE IF NOT EXISTS audit_retention_checkpoint (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        first_retained_seq INTEGER NOT NULL CHECK (first_retained_seq >= 1),
        anchor_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        did TEXT NOT NULL DEFAULT '',
        public_key_multibase TEXT NOT NULL,
        device_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'rich',
        -- Item C — agent_scope ('coding' | 'runner') stamped at pairing for an
        -- agent/plugin device; NULL for a non-agent (rich/thin/cli) device.
        scope TEXT,
        auth_type TEXT NOT NULL DEFAULT 'ed25519',
        last_seen INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        -- Round-15 #8: constrain the flag at the storage layer so a foreign
        -- writer can't persist a non-canonical value that hydrates fail-open.
        revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
      );

      -- Round-10 #19: one row per key. public_key_multibase is NOT NULL and a
      -- device mints its own keypair, so it is one-key-per-device — a UNIQUE
      -- index makes getByPublicKey/getByDID deterministic (no duplicate rows a
      -- crash/second-writer could create) and lets register's INSERT OR REPLACE
      -- resolve a key conflict by replacing. (did is derived from the key, so
      -- uniqueness on the key implies it; did keeps a plain index since it can
      -- be '' on a legacy/mock row.)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_pubkey ON paired_devices(public_key_multibase);
      CREATE INDEX IF NOT EXISTS idx_devices_did ON paired_devices(did);

      -- Item D — durable coding-agent sessions (DID-bound lease). Backs the
      -- in-memory SessionRegistry so a session survives a Core restart; boot
      -- reconciles from here and reaps any lapsed lease. ended_at IS NULL ⇒ live.
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        agent_did TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_principal
        ON agent_sessions(agent_did, host_session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended
        ON agent_sessions(ended_at);

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
        -- message is part of the dedup identity: without it two distinct
        -- manual reminders at the same time + persona (empty source_item_id,
        -- kind=manual) collide and the second is dropped. Mirrors dedupKey()
        -- in reminders/service.ts — keep the two in lockstep.
        UNIQUE(source_item_id, kind, due_at, persona, message)
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
    // Service-discovery (commit f3a1bc7) — local service configuration.
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
        origin TEXT CHECK (origin IN ('','telegram','api','d2d','admin','system','cli','dinamobile','agent')),
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
  {
    // Scratchpad — cognitive checkpointing for multi-step reasoning
    // tasks (nudge pipeline, agent-action approvals, crash-report
    // staging). One row per task_id via UPSERT; Brain's
    // `ScratchpadService` writes `checkpoint` / reads `resume` /
    // deletes via `clear`. Stale rows auto-expire on read (24h TTL);
    // optional sweeper drops them in bulk.
    //
    // Schema fields match Python's `brain/src/service/scratchpad.py`
    // + `core/internal/adapter/sqlite/scratchpad.go` contract:
    //   - task_id: stable id (correlates with dina_tasks.id; or a
    //     pseudo id like "__proposals__" for long-lived maps).
    //   - step: 1-based step number most-recently completed; step=0
    //     is the delete marker the Python service writes on clear;
    //     step=-1 is the crash-report stamp.
    //   - context: JSON blob of accumulated reasoning state.
    version: 4,
    name: 'scratchpad',
    sql: `
      CREATE TABLE IF NOT EXISTS scratchpad (
        task_id    TEXT    PRIMARY KEY,
        step       INTEGER NOT NULL,
        context    TEXT    NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      -- Sweeper index: find rows whose updated_at fell behind the
      -- 24h TTL boundary. Partial-scan friendly.
      CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at
        ON scratchpad(updated_at ASC)
    `,
  },
  {
    // People-graph — the canonical identity hub (see
    // docs/IDENTITY_HUB_REDESIGN.md). A *person* is the stable entity;
    // identifiers point to it (many-to-one) and facts attach to it.
    // Four tables sit alongside `contacts`:
    //
    //   - `people` is the canonical entity layer. It carries NO DID
    //     column — a person may have zero, one, or many identities
    //     (a DID per device, plus future email/phone/handle). Those
    //     live in `person_identities`. This covers humans the user
    //     knows about (relatives, kids, public figures) who don't have
    //     a Dina account, as well as paired contacts across multiple
    //     devices/channels. `status` (suggested/confirmed/rejected) +
    //     `created_from` (llm/manual/imported/user) drive the curation
    //     flow over LLM-extracted person mentions.
    //   - `person_identities` is the canonical link layer: each row
    //     binds one identifier `(identity_type, identity_value)` to a
    //     `person_id`. `UNIQUE(identity_type, identity_value)` enforces
    //     "one identifier maps to exactly one person." Identities can
    //     rotate (new DID after key rotation) without orphaning the
    //     person's facts. Hot path: resolve sender DID → person on
    //     every D2D arrival before vault enrichment.
    //   - `person_surfaces` is the multi-alias index — one person can
    //     own many surfaces ("Sancho", "Sanch", "Mr. Garcia") with
    //     per-surface confidence + status. `source_item_id` records
    //     which vault item taught Dina about this surface, for
    //     provenance and retraction.
    //   - `person_extraction_log` dedups extractor runs by
    //     (item, extractor_version, fingerprint) so re-running the
    //     LLM with the same content doesn't duplicate surfaces.
    //
    // Greenfield install — no backfill from `contacts`. New contacts
    // get a `people` row + a `person_identities` DID row created at
    // pair time by the contact service; the LLM-driven extractor
    // populates additional people from staged content.
    version: 5,
    name: 'people_graph',
    sql: `
      CREATE TABLE IF NOT EXISTS people (
        person_id         TEXT PRIMARY KEY,
        -- Entity class so the same identity spine holds non-human
        -- counterparts (a clinic, a bank, a service/agent DID, a
        -- shared device) without forcing them into human-only
        -- behaviour. Modelling hook only, NOT permission logic --
        -- admission still depends on contact policy + message type.
        -- One of: human | org | service | device | agent | group.
        entity_type       TEXT NOT NULL DEFAULT 'human',
        canonical_name    TEXT NOT NULL DEFAULT '',
        relationship_hint TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT 'suggested',
        created_from      TEXT NOT NULL DEFAULT 'llm',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      ) WITHOUT ROWID;

      -- Canonical identifier to person link. Many identities map to
      -- one person; one identifier maps to exactly one person (the
      -- UNIQUE constraint). identity_type is one of:
      -- did | email | phone | handle | device.
      CREATE TABLE IF NOT EXISTS person_identities (
        identity_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id         TEXT NOT NULL,
        identity_type     TEXT NOT NULL,
        identity_value    TEXT NOT NULL,
        verified          INTEGER NOT NULL DEFAULT 0,
        primary_identity  INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        UNIQUE(identity_type, identity_value)
      );

      -- Hot path: resolve (type,value) to a person record (used on
      -- every D2D arrival before vault enrichment).
      CREATE INDEX IF NOT EXISTS idx_person_identities_lookup
        ON person_identities(identity_type, identity_value);
      CREATE INDEX IF NOT EXISTS idx_person_identities_person
        ON person_identities(person_id);

      CREATE TABLE IF NOT EXISTS person_surfaces (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id          TEXT NOT NULL,
        surface            TEXT NOT NULL,
        normalized_surface TEXT NOT NULL,
        surface_type       TEXT NOT NULL DEFAULT 'name',
        status             TEXT NOT NULL DEFAULT 'suggested',
        confidence         TEXT NOT NULL DEFAULT 'medium',
        source_item_id     TEXT NOT NULL DEFAULT '',
        source_excerpt     TEXT NOT NULL DEFAULT '',
        extractor_version  TEXT NOT NULL DEFAULT '',
        created_from       TEXT NOT NULL DEFAULT 'llm',
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      -- "Sancho" → person_id resolution; used on every D2D arrival,
      -- briefing render, vault-search-by-mention.
      CREATE INDEX IF NOT EXISTS idx_person_surfaces_normalized
        ON person_surfaces(normalized_surface);
      CREATE INDEX IF NOT EXISTS idx_person_surfaces_person
        ON person_surfaces(person_id, normalized_surface);
      -- For clearExcerptsForItem when a vault item is deleted.
      CREATE INDEX IF NOT EXISTS idx_person_surfaces_source
        ON person_surfaces(source_item_id);

      CREATE TABLE IF NOT EXISTS person_extraction_log (
        source_item_id    TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        fingerprint       TEXT NOT NULL,
        applied_at        INTEGER NOT NULL,
        PRIMARY KEY (source_item_id, extractor_version, fingerprint)
      ) WITHOUT ROWID
    `,
  },
  {
    // Durable D2D outbox (issues.txt §1). Mobile is not a server: an
    // in-memory queue loses every queued outbound D2D on app kill/
    // background, breaking service-query, approvals, and task handoff.
    // This table is the SQLCipher-backed source of truth.
    //
    // Design: store the SEMANTIC payload (target_did + message_type +
    // body_json), NOT the sealed wire bytes. The recipient's DID
    // document / MsgBox endpoint / X25519 pubkey are re-resolved and
    // the envelope re-sealed at retry time — so a recipient key
    // rotation or endpoint change doesn't strand a queued message
    // (issues.txt: "Resolve DID document / MsgBox endpoint at retry
    // time"). See packages/core/src/transport/outbox_repository.ts.
    //
    // State machine: pending → sending (leased) → sent | failed → dead.
    //   - claimDue() flips due pending/failed rows to 'sending' with a
    //     lease_until so two drainers can't ship the same row.
    //   - markSent/markFailed/markDead are terminal/backoff updates.
    //   - resetStaleSending() reclaims 'sending' rows whose lease
    //     expired (a crash mid-send) back to 'pending' on boot.
    //
    // The partial UNIQUE on idempotency_key (non-terminal rows only)
    // makes enqueue idempotent on a stable message/query id while
    // still letting a later message reuse the key once the prior one
    // is sent/dead — mirrors idx_workflow_idem.
    version: 6,
    name: 'd2d_outbox',
    sql: `
      CREATE TABLE IF NOT EXISTS d2d_outbox (
        id TEXT PRIMARY KEY,
        target_did TEXT NOT NULL,
        message_type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        idempotency_key TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        lease_until INTEGER,
        expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_d2d_outbox_due
        ON d2d_outbox(state, next_attempt_at);

      CREATE INDEX IF NOT EXISTS idx_d2d_outbox_target
        ON d2d_outbox(target_did);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_d2d_outbox_idem_active
        ON d2d_outbox(idempotency_key)
        WHERE idempotency_key IS NOT NULL
          AND state IN ('pending', 'sending', 'failed');
    `,
  },
  {
    // Durable agent persona grants (issues.txt §2). Agent-safety critical:
    // when an out-of-process agent (dina-agent / OpenClaw, over MsgBox)
    // asks for locked/sensitive persona data, Dina creates an approval
    // workflow task and returns `approval_required` WITHOUT reading the
    // vault. On approval a row is written here — a durable, scoped grant
    // bound to the exact (agent_did, persona, mode). The agent then
    // retries and the deterministic `requireAgentPersonaAccess` check
    // finds the grant and allows the read. Because the grant is in
    // SQLCipher, the agent can resume after an app restart, and a
    // restart while the approval is still pending preserves safety (no
    // grant → no data).
    //
    // The approval workflow task (workflow_tasks) is the durable approval
    // OBJECT; this table is the durable RESULT of approval. `session_id` binds
    // the result to the canonical durable agent_sessions lifecycle row; session
    // end invalidates the authority and tombstones matching grants.
    //
    // scope_json holds the REQUESTED scope (e.g. the agent's query text),
    // never vault results. expires_at bounds the grant; revoked_at tombs
    // it. The partial index serves the hot `findActiveGrant` lookup.
    version: 7,
    name: 'agent_persona_grants',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_persona_grants (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        agent_did TEXT NOT NULL,
        persona TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
        scope_json TEXT NOT NULL,
        approval_task_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        -- PLG-28 #1: a grant is RESERVED (active=0) before the approval CAS
        -- commits and ACTIVATED (active=1) only after, so an agent retry can't
        -- find it findActive-gated during the awaited persona unlock window
        -- (TOCTOU on the vault-read gate). DEFAULT 1 keeps non-reserve callers
        -- active-on-insert.
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );

      CREATE INDEX IF NOT EXISTS idx_agent_grants_active
        ON agent_persona_grants(agent_did, persona, expires_at)
        WHERE revoked_at IS NULL;
    `,
  },
  {
    // Multi-listing service config — reshape the single-row `service_config`
    // key-value table into a per-rkey `service_configs` catalog. ONE local row
    // == ONE published `com.dinakernel.service.profile/<rkey>` record; `rkey`
    // is the join key (the same rkey carried by a listing's `service_uri`).
    //
    // Greenfield: services hasn't shipped, so we DROP the old v2 table outright
    // (no data preservation). The v2 migration block above is left intact —
    // applied migrations are immutable; this v8 supersedes it. A fresh DB runs
    // v2 then v8 (creates `service_config`, drops it, creates `service_configs`);
    // an existing dev DB jumps straight to v8.
    //
    //   config_json        — the ServiceConfig JSON for THIS listing (the rkey
    //                        lives in the row key, NOT inside the JSON).
    //   publication_*      — durable publication receipt + retry state.
    version: 8,
    name: 'service_configs_per_rkey',
    sql: `
      DROP TABLE IF EXISTS service_config;

      CREATE TABLE IF NOT EXISTS service_configs (
        rkey TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        publication_state TEXT NOT NULL DEFAULT 'pending'
          CHECK(publication_state IN ('pending', 'published', 'failed', 'not_published')),
        last_published_uri TEXT,
        last_published_cid TEXT,
        last_publish_error TEXT,
        last_publish_attempt_at INTEGER,
        next_publish_retry_at INTEGER
      ) WITHOUT ROWID;
    `,
  },
  {
    // known_only service offers received over D2D (`service.offer`). A provider
    // proactively shares a non-public listing with us; we persist it here as
    // CONTACT metadata (NOT vault content) so the resolver can surface "my
    // contact offers capability X" before falling back to public discovery.
    //
    //   grant_id          — the provider-issued grant this offer delivers (PK;
    //                        the requester echoes it as service.query.grant_id).
    //   provider_did      — the sender DID = the `to_did` for the eventual
    //                        service.query, and the resolver's lookup key
    //                        (it maps a contact → DID → offers at read time).
    //                        Always set (the sender DID is on the envelope).
    //   person_id         — the contact, denormalised from the sender DID when
    //                        cheap to resolve; nullable (the resolver doesn't
    //                        depend on it — it queries by provider_did).
    //   capability        — canonical or namespaced custom NSID.
    //   service_uri       — the known_only listing's AT-URI (well-formed but
    //                        not network-resolvable); rides the service.query.
    //   *_schema_json     — the capability's params/result JSON Schema, carried
    //                        inline (no AppView/PDS to fetch it from).
    //   expires_at        — optional offer expiry (unix seconds).
    version: 9,
    name: 'contact_service_offers',
    sql: `
      CREATE TABLE IF NOT EXISTS contact_service_offers (
        grant_id TEXT PRIMARY KEY,
        provider_did TEXT NOT NULL,
        person_id TEXT,
        capability TEXT NOT NULL,
        service_uri TEXT NOT NULL,
        service_name TEXT NOT NULL DEFAULT '',
        schema_hash TEXT NOT NULL DEFAULT '',
        params_schema_json TEXT,
        result_schema_json TEXT,
        default_ttl_seconds INTEGER,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contact_offers_provider
        ON contact_service_offers(provider_did);
      CREATE INDEX IF NOT EXISTS idx_contact_offers_provider_capability
        ON contact_service_offers(provider_did, capability);
    `,
  },
  {
    // PROVIDER-side authorization for service invocation. A grant is the
    // authority that lets a specific grantee invoke a specific listing's
    // capability — the source of truth checked at ingress (NOT contact
    // membership, NOT service_uri possession). Independent of discoverability:
    // V1 enforces it for `known_only` listings, but the table is general so a
    // public/unlisted listing can require a grant later.
    //
    //   grant_id        — PK; the wire SELECTOR (echoed on service.offer /
    //                      service.query). NOT a secret — auth = grant_id AND
    //                      the transport-authenticated caller DID.
    //   grantee_did     — who may invoke; compared to authenticatedFromDID.
    //   service_rkey    — which listing.
    //   capability      — which capability (canonicalized on compare).
    //   grant_type      — V1: 'standing' (valid until expiry/revoke). The
    //                      discriminator for future types (quota/one_time/…).
    //   constraints_json — V1: null/{}; the future per-type extension surface.
    //   expires_at      — optional (unix seconds).
    //   revoked_at      — set to revoke; execution denies thereafter.
    //
    // (provider_did is implicit — this table lives in THIS node's identity DB,
    //  so the provider is always us, mirroring agent_persona_grants. Mutable
    //  usage state for quota/one_time is a future `service_grant_usage` table.)
    version: 10,
    name: 'service_grants',
    sql: `
      CREATE TABLE IF NOT EXISTS service_grants (
        grant_id TEXT PRIMARY KEY,
        grantee_did TEXT NOT NULL,
        service_rkey TEXT NOT NULL,
        capability TEXT NOT NULL,
        grant_type TEXT NOT NULL DEFAULT 'standing',
        constraints_json TEXT,
        expires_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_service_grants_grantee
        ON service_grants(grantee_did, service_rkey, capability)
        WHERE revoked_at IS NULL;
    `,
  },
  {
    // D2D quarantine durability — persist quarantined messages from unknown
    // senders so the Accept/Block actions survive an app restart. Without
    // this the in-memory quarantine store empties on boot, leaving the
    // re-rendered "Unknown sender" card's buttons dead (getQuarantined →
    // null). Body is held here (encrypted at rest) and never surfaced to the
    // chat layer until the user accepts — preserving the anti-spam hide.
    version: 11,
    name: 'd2d_quarantine',
    sql: `
      CREATE TABLE IF NOT EXISTS d2d_quarantine (
        id TEXT PRIMARY KEY,
        sender_did TEXT NOT NULL,
        message_type TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_quarantine_sender ON d2d_quarantine(sender_did);
      CREATE INDEX IF NOT EXISTS idx_quarantine_expires ON d2d_quarantine(expires_at);
    `,
  },
  {
    // Guided-demo data scope (docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md).
    // Adds `data_scope` to the identity-DB tables that hold user content or
    // user-visible state the guided demo writes to. The demo runs in an
    // isolated 'guided_demo:<run_id>' scope; everything else stays 'user'.
    // ALTER (not editing v1) because applied migrations are immutable here —
    // a new version is the only way every fresh AND existing DB gets the column.
    // Infra/security tables (contacts, paired_devices, service_grants,
    // agent_persona_grants, audit_log, kv_store, …) are deliberately NOT scoped
    // — see the design doc "Should Not Scope". person_identities/contacts are
    // not scoped in V1 because the demo's Emma has no DID/contact.
    version: 12,
    name: 'data_scope_identity',
    sql: `
      -- reminders: REBUILD (not ALTER) — data_scope must be part of the dedup
      -- UNIQUE key, because a demo reminder and a user reminder with identical
      -- content are DISTINCT rows in different scopes. SQLite can't ALTER a
      -- UNIQUE constraint, so we recreate the table. Existing rows → 'user'.
      -- Keep this UNIQUE list in lockstep with dedupKey() in reminders/service.ts.
      CREATE TABLE reminders_v12 (
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
        data_scope TEXT NOT NULL DEFAULT 'user',
        UNIQUE(source_item_id, kind, due_at, persona, message, data_scope)
      );
      INSERT INTO reminders_v12
        (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at, data_scope)
        SELECT id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at, 'user'
        FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_v12 RENAME TO reminders;
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE completed=0;
      CREATE INDEX IF NOT EXISTS idx_reminders_persona ON reminders(persona);
      CREATE INDEX IF NOT EXISTS idx_reminders_short_id ON reminders(short_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_scope ON reminders(data_scope);

      ALTER TABLE chat_messages ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE staging_inbox ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE people ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE person_surfaces ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';

      CREATE INDEX IF NOT EXISTS idx_chat_messages_scope ON chat_messages(data_scope);
      CREATE INDEX IF NOT EXISTS idx_staging_scope ON staging_inbox(data_scope);
      CREATE INDEX IF NOT EXISTS idx_people_scope ON people(data_scope);
      CREATE INDEX IF NOT EXISTS idx_person_surfaces_scope ON person_surfaces(data_scope);
    `,
  },
  {
    // staging_inbox: fold data_scope into the dedup UNIQUE key. v12 added the
    // column but left UNIQUE(producer_id, source, source_id) — so the SAME
    // (producer, source, source_id) ingested in BOTH the user scope and a
    // guided-demo scope collided: the second scope's row was silently dropped
    // (INSERT OR IGNORE), so it was never created or claimed in that scope.
    // SQLite can't ALTER a UNIQUE constraint, so rebuild (same pattern as the
    // reminders v12 rebuild). Existing rows keep their v12-assigned data_scope.
    version: 13,
    name: 'staging_inbox_scope_dedup',
    sql: `
      CREATE TABLE staging_inbox_v13 (
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
        data_scope TEXT NOT NULL DEFAULT 'user',
        UNIQUE(producer_id, source, source_id, data_scope)
      );
      INSERT INTO staging_inbox_v13
        (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, classified_item, error, approval_id, data_scope)
        SELECT id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, classified_item, error, approval_id, data_scope
        FROM staging_inbox;
      DROP TABLE staging_inbox;
      ALTER TABLE staging_inbox_v13 RENAME TO staging_inbox;
      CREATE INDEX IF NOT EXISTS idx_staging_status ON staging_inbox(status);
      CREATE INDEX IF NOT EXISTS idx_staging_expires ON staging_inbox(expires_at);
      CREATE INDEX IF NOT EXISTS idx_staging_scope ON staging_inbox(data_scope);
    `,
  },
  {
    // PeerLens review publishing as a durable job state machine
    // (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md). One row == one review's full
    // publish lifecycle (queued → publishing → published | failed | discarded),
    // replacing the old KV `peerlens_outbox` row + in-memory mirror split. The
    // row is the single source of truth; chat card + Outbox screen project from
    // it. `claimed_at`/`claim_expires_at` are the worker lease that lets a row
    // whose owner crashed mid-publish be reclaimed (idempotent via the stable
    // `rkey`). `thread_id`/`draft_id` back-reference the originating inline chat
    // draft so the card can find its job. `data_scope` is always 'user' (jobs
    // must survive guided-demo teardown; the worker refuses to drain in demo
    // scope) — stamped explicitly, NOT via the scope helper.
    version: 14,
    name: 'peerlens_publish_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS peerlens_publish_jobs (
        job_id             TEXT PRIMARY KEY,
        owner_did          TEXT NOT NULL,
        rkey               TEXT NOT NULL,
        record_json        TEXT NOT NULL,
        draft_json         TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','publishing','published','failed','discarded')),
        attempts           INTEGER NOT NULL DEFAULT 0,
        last_error_code    TEXT,
        last_error_message TEXT,
        next_attempt_at    INTEGER,
        claimed_at         INTEGER,
        claim_expires_at   INTEGER,
        thread_id          TEXT,
        draft_id           TEXT,
        published_uri      TEXT,
        published_cid      TEXT,
        data_scope         TEXT NOT NULL DEFAULT 'user',
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ppj_owner_status ON peerlens_publish_jobs(owner_did, status);
      CREATE INDEX IF NOT EXISTS idx_ppj_draft        ON peerlens_publish_jobs(thread_id, draft_id);
      CREATE INDEX IF NOT EXISTS idx_ppj_lease        ON peerlens_publish_jobs(status, claim_expires_at);
    `,
  },
  {
    // Durable persona registry. Personas were in-memory only — a vault the
    // user created via the app vanished on restart because boot re-seeds
    // ONLY the code-defined defaults (onboarding/default_personas.ts). This
    // table is the source of truth for USER-created personas; builtins stay
    // code-seeded so their classifier descriptions stay in lockstep
    // cross-stack, so `is_builtin` is carried but hydrate skips builtin
    // rows. Written by createPersona({persist:true}); read by
    // hydratePersonas() on unlock before the boot open-loop. See
    // packages/core/src/persona/repository.ts.
    version: 15,
    name: 'personas',
    sql: `
      CREATE TABLE IF NOT EXISTS personas (
        name TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID
    `,
  },
  {
    // OWNER-PRIVATE contact-service decision log (CONTACT_SERVICES_ARCHITECTURE.md
    // §2/§10). The grantor's quiet, reviewable record of every inbound
    // `service.grant_request` and how policy responded — "Alonso's Dina asked
    // for availability_coordination — auto-declined by policy". It exists so the
    // owner can spot a mis-tiered contact WITHOUT creating social leakage.
    //
    // Privacy invariant: this is sensitive relationship metadata. It lives in
    // THIS node's encrypted identity DB, is NEVER sent to / synced to / derivable
    // by the requester, and is a LOG (read in Activity), never a push. It is
    // distinct from the infra `audit_log` (debugging) — this one is the
    // product-visible surface.
    //
    //   id            — PK, monotonic surrogate (rowid).
    //   requester_did — who asked (the relay-authed from_did).
    //   capability    — the capability requested (canonical).
    //   decision      — granted | auto_declined | prompt_shown | prompt_timed_out | error.
    //   reason        — short non-PII policy tag (e.g. closeness=unknown, no_talk_listing).
    //   created_at    — unix seconds.
    version: 16,
    name: 'contact_service_decisions',
    sql: `
      CREATE TABLE IF NOT EXISTS contact_service_decisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        requester_did TEXT NOT NULL,
        capability    TEXT NOT NULL,
        decision      TEXT NOT NULL
                        CHECK (decision IN ('granted','auto_declined','prompt_shown','prompt_timed_out','error')),
        reason        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_csd_created ON contact_service_decisions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_csd_requester ON contact_service_decisions(requester_did, created_at DESC);
    `,
  },
  {
    // v17 — workflow lease-token + retry-budget columns and the
    // `outcome_unknown` terminal state (PLUGIN_ARCHITECTURE.md §9.1,
    // §9.5).
    //
    //   claim_id         — random token minted per claim; heartbeat /
    //                      progress / complete / fail CAS against it, so
    //                      a stale execution's completion loses the race
    //                      instead of overwriting a newer attempt.
    //   attempt          — claims consumed by this task's logical
    //                      execution. Advances ON CLAIM (a lease reclaim
    //                      IS a new attempt); execution_id and
    //                      idempotency_key in the payload stay fixed.
    //   first_claimed_at — anchors the §9.1 retry window (ms).
    //
    // The partial-unique idempotency index is REBUILT because its
    // exclusion list is the terminal-state set: without adding
    // `outcome_unknown`, a §9.5 reconciliation re-dispatch (new task,
    // same idempotency_key where the capability supports it) would
    // collide with the parked outcome_unknown row. ALTERs are additive;
    // applied migrations above stay immutable.
    version: 17,
    name: 'workflow_claim_tokens',
    sql: `
      ALTER TABLE workflow_tasks ADD COLUMN claim_id TEXT;
      ALTER TABLE workflow_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workflow_tasks ADD COLUMN first_claimed_at INTEGER;

      DROP INDEX IF EXISTS idx_workflow_idem;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_idem
        ON workflow_tasks(idempotency_key)
        WHERE idempotency_key IS NOT NULL
          AND state NOT IN ('completed','failed','cancelled','outcome_unknown','recorded');
    `,
  },
  {
    // v18 — the plugin dynamic registry (PLUGIN_ARCHITECTURE.md §6, §8).
    //
    // plugin_installs — one row per install. `install_id` is the stable
    //   local anchor everything hangs off (lane, vault, grants, config);
    //   `(publisher_did, plugin_id)` is IDENTITY — indexed, deliberately
    //   NOT unique (multi-install is legitimate: two homes, two stores).
    //   `current_cid` is version state; the pinned normalized manifest
    //   rides in manifest_json (the stored form IS the validated/hashed
    //   form, §8.1). Pending-update fields make the §14 dual-boundary
    //   policy persistable, not just conceptual.
    //
    // plugin_grants — standing approvals keyed
    //   (install_id, capability, approved_scope_hash): scope growth
    //   changes the hash, nothing matches, re-consent is STRUCTURAL.
    //   constraints_json is the versioned §8 constraint object; usage
    //   is consumed per LOGICAL EXECUTION via plugin_grant_uses
    //   (execution_id UNIQUE per grant → idempotent lease-recovery
    //   retries never consume a second use).
    //
    // plugin_decisions — owner-private decision log (the
    //   contact_service_decisions v16 pattern: owner-visible, never
    //   brain/LLM-readable).
    //
    // plugin_capability_stats — invocation counters for the first-N
    //   card rule (§8: HIGH capabilities card the first 3 invocations
    //   even after a standing approval exists).
    version: 18,
    name: 'plugin_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_installs (
        install_id        TEXT PRIMARY KEY,
        publisher_did     TEXT NOT NULL,
        plugin_id         TEXT NOT NULL,
        label             TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL
                            CHECK (status IN ('pending','active','paused','revoked')),
        execution_mode    TEXT NOT NULL CHECK (execution_mode IN ('interpreted','runner')),
        current_cid       TEXT NOT NULL,
        current_version   TEXT NOT NULL,
        manifest_json     TEXT NOT NULL,
        install_scope_hash TEXT NOT NULL,
        capability_hashes_json TEXT NOT NULL,
        behavior_hash     TEXT NOT NULL,
        presentation_hash TEXT NOT NULL,
        trust_anchor_json TEXT NOT NULL,
        device_did        TEXT,
        config_revision   INTEGER NOT NULL DEFAULT 1,
        -- Round-9 #16: WHY an install was paused, so resume can tell an
        -- owner-initiated pause (plainly resumable) from a device-revoke /
        -- restore / advisory hold that requires re-pair / re-consent / advisory
        -- resolution. NULL = legacy / not-yet-set (treated as owner-resumable).
        pause_reason      TEXT
                            CHECK (pause_reason IS NULL
                                   OR pause_reason IN ('manual','device_revoked','restore','advisory')),
        pending_cid       TEXT,
        pending_behavior_hash TEXT,
        -- NOTE: 'x IN (NULL, ...)' is a no-op CHECK (NULL member makes the
        -- expression NULL, which CHECK treats as pass) — hence IS NULL OR.
        pending_decision  TEXT
                            CHECK (pending_decision IS NULL
                                   OR pending_decision IN ('awaiting_consent','awaiting_behavior_approval')),
        pending_expires_at INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_installs_identity
        ON plugin_installs(publisher_did, plugin_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_installs_device
        ON plugin_installs(device_did);

      CREATE TABLE IF NOT EXISTS plugin_grants (
        grant_id          TEXT PRIMARY KEY,
        install_id        TEXT NOT NULL REFERENCES plugin_installs(install_id) ON DELETE CASCADE,
        capability        TEXT NOT NULL,
        approved_scope_hash TEXT NOT NULL,
        grant_type        TEXT NOT NULL CHECK (grant_type IN ('once','window','standing')),
        constraints_json  TEXT,
        expires_at        INTEGER,
        revoked_at        INTEGER,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_grants_key
        ON plugin_grants(install_id, capability, approved_scope_hash);

      CREATE TABLE IF NOT EXISTS plugin_grant_uses (
        grant_id     TEXT NOT NULL REFERENCES plugin_grants(grant_id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL,
        used_at      INTEGER NOT NULL,
        -- Round-11 #1: the digest of the CONSTRAINT-RELEVANT invocation params
        -- (resource + value) that this execution_id was FIRST authorized under.
        -- The idempotent-replay path (same execution_id re-authorizes without a
        -- second consume) must re-bind to the same params; a replay carrying a
        -- different resource/value is a distinct invocation masquerading as a
        -- lease-recovery retry to skip the constraint checks. NULL only for
        -- pre-Round-11 rows (none exist pre-launch).
        invocation_digest TEXT,
        PRIMARY KEY (grant_id, execution_id)
      );

      CREATE TABLE IF NOT EXISTS plugin_decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        install_id  TEXT NOT NULL,
        capability  TEXT NOT NULL DEFAULT '',
        decision    TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_decisions_install
        ON plugin_decisions(install_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS plugin_capability_stats (
        install_id  TEXT NOT NULL,
        capability  TEXT NOT NULL,
        invocations INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (install_id, capability)
      );
    `,
  },
  {
    version: 19,
    name: 'plugin_installs_unique_active_device',
    // A device DID resolves to callerType 'plugin' and its lane is looked
    // up by device_did; if two ACTIVE installs shared a device the claim
    // routing would be nondeterministic (the old lookup was LIMIT 1 with
    // no ordering). Enforce at most one active install per device at the
    // DB level so a double-activation fails loudly instead of routing to
    // an arbitrary lane. Partial: pending/paused/revoked rows and
    // device-less installs are unconstrained.
    //
    // PLG-29 #8: ALSO enforce at most one PENDING install per device. The
    // active index left `bindPendingDevice` as a read-then-write (pre-check
    // `hasOtherNonRevokedOnDevice`, then UPDATE) — two writers could each pass
    // the pre-check and bind the SAME device to different pending installs, so a
    // later decline/revoke on one durably revokes the shared device and kills the
    // other's runner. A pending-scoped unique index makes the losing bind fail at
    // the DB (converted to a `false` return via try/catch), closing the race.
    // We deliberately do NOT extend uniqueness across paused/active together: the
    // device-revoke-and-repair flow (and a restore) intentionally lets a paused
    // `device_revoked` install and a freshly-activated install share a device
    // (registry F9 / P1-3), and `listByDeviceDid` disables them all on revoke.
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_installs_active_device
        ON plugin_installs(device_did)
        WHERE device_did IS NOT NULL AND status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_installs_pending_device
        ON plugin_installs(device_did)
        WHERE device_did IS NOT NULL AND status = 'pending';
    `,
  },
  {
    version: 20,
    name: 'interactive_runs',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §5/§13. The run *control state*
    // store (Tier-0). Message payloads live envelope-encrypted elsewhere
    // (ISVC-2), never as Tier-0 plaintext. `transport` is frozen `pull` in V1;
    // the push_* columns exist for the deferred push transports (§7.1). No
    // `persona_lock_epoch` — every guard is against current state (§5).
    sql: `
      CREATE TABLE IF NOT EXISTS interactive_runs (
        run_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        service_uri TEXT NOT NULL,
        provider_did TEXT NOT NULL,
        persona TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'pull'
          CHECK (transport IN ('pull','push_reserved','push_open')),
        push_grant_ref TEXT,
        provider_grant_id TEXT,
        provider_grant_expires_at_sec INTEGER,
        interval_ms INTEGER,
        next_fetch_at INTEGER,
        queue_cap INTEGER NOT NULL,
        action_risk_ceiling TEXT NOT NULL
          CHECK (action_risk_ceiling IN ('SAFE','MODERATE','HIGH')),
        priority_ceiling TEXT NOT NULL
          CHECK (priority_ceiling IN ('fiduciary','solicited','engagement')),
        classify_timeout_ms INTEGER NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
        on_stop TEXT NOT NULL DEFAULT 'cancel_pending'
          CHECK (on_stop IN ('cancel_pending','finish_pending')),
        erasure_mode TEXT NOT NULL DEFAULT 'logical_deletion'
          CHECK (erasure_mode IN ('backup_resistant','logical_deletion')),
        paused_reason TEXT,
        stop_on_command INTEGER NOT NULL DEFAULT 1 CHECK (stop_on_command IN (0,1)),
        max_count INTEGER,
        max_count_basis TEXT NOT NULL DEFAULT 'decided'
          CHECK (max_count_basis IN ('produced','decided')),
        stop_on_exhaustion INTEGER NOT NULL DEFAULT 1 CHECK (stop_on_exhaustion IN (0,1)),
        expires_at INTEGER NOT NULL,
        drain_deadline_ms INTEGER NOT NULL DEFAULT 60000,
        drain_deadline_at INTEGER,
        drain_cause TEXT
          CHECK (drain_cause IN ('cancel_pending','finish_pending','count','exhaustion','expiry')),
        drain_strength TEXT CHECK (drain_strength IN ('permissive','fencing')),
        config_version INTEGER NOT NULL DEFAULT 0,
        fetch_cursor INTEGER,
        last_commit_at INTEGER,
        produced_count INTEGER NOT NULL DEFAULT 0,
        decided_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active','paused','draining','completed','stopped','expired')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- At most one LIVE run per owner idempotency key (§12.5 durable idem).
      CREATE UNIQUE INDEX IF NOT EXISTS uq_interactive_runs_live_idem
        ON interactive_runs(idempotency_key)
        WHERE state NOT IN ('completed','stopped','expired');

      -- Sweeper scan of non-terminal runs by TTL / deadline.
      CREATE INDEX IF NOT EXISTS idx_interactive_runs_state_expiry
        ON interactive_runs(state, expires_at);
    `,
  },
  {
    version: 21,
    name: 'interactive_run_payloads',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §13. The envelope-encrypted
    // payload store + the per-payload leaf erasure key store.
    //
    // NO Tier-0 plaintext: `blob` is AEAD-ciphertext under a per-payload data
    // key; `wrapped_key` is that data key wrapped for confidentiality (persona
    // DEK) AND under a per-payload leaf erasure key held in `run_erasure_keys`.
    // Crypto-shred = delete the leaf key (works while the persona is locked;
    // deleting the blob row alone is NOT the erasure guarantee, §20). `state`
    // is the blob registry that serializes publish vs orphan-GC.
    sql: `
      CREATE TABLE IF NOT EXISTS run_payload_blobs (
        payload_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        persona TEXT NOT NULL,
        content_id TEXT NOT NULL,
        blob BLOB NOT NULL,
        wrapped_key BLOB NOT NULL,
        state TEXT NOT NULL DEFAULT 'prepared'
          CHECK (state IN ('prepared','published','abandoned')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_payload_blobs_run ON run_payload_blobs(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_payload_blobs_state ON run_payload_blobs(state);

      -- The leaf erasure-key store (logical_deletion backend on the shipping
      -- stack; a hardened non-backed backend replaces this to earn
      -- backup_resistant crypto-shred, §13/§20).
      CREATE TABLE IF NOT EXISTS run_erasure_keys (
        payload_id TEXT PRIMARY KEY,
        key BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 22,
    name: 'run_reservations',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§13. The atomic bounded-queue
    // admission slot. `reserved`+`held_by_lock` are the OPEN reservations that
    // count toward `outstanding`. `content_digest` is present from admission so
    // push dedup can key on it (§7.1). No lock epoch — guards are current-state.
    sql: `
      CREATE TABLE IF NOT EXISTS run_reservations (
        reservation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'reserved'
          CHECK (state IN ('reserved','committed','released','held_by_lock','response_lost','skipped')),
        message_id TEXT,
        dedup_key TEXT,
        content_digest TEXT,
        sealed_response_ref TEXT,
        held_message_json TEXT,
        error_reason TEXT,
        error_at INTEGER,
        lease_expires_at INTEGER,
        query_correlation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_reservations_run_state
        ON run_reservations(run_id, state);
      CREATE INDEX IF NOT EXISTS idx_run_reservations_lease
        ON run_reservations(state, lease_expires_at);
      -- R5-01 — the durable locked-arrival spool (§7/§13): Core-sealed ciphertext
      -- staged BEFORE a held_by_lock commit; peek/ack two-phase drain on unlock.
      CREATE TABLE IF NOT EXISTS run_spool (
        spool_id TEXT PRIMARY KEY,
        blob BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        -- Round-C C-02 — the spool row IS the durable cleanup owner: it names the
        -- staging leaf key that protects this blob, written BEFORE the key so a
        -- crash before the reservation/receipt adopts the ref still leaves a
        -- record the orphan GC can use to destroy the (unique, non-derivable)
        -- key before deleting the blob. Null for legacy rows.
        staged_key_id TEXT
      );
    `,
  },
  {
    version: 23,
    name: 'run_messages_and_classification',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §6.3/§9.1/§12.6. Per-message
    // lifecycle metadata (payload lives envelope-encrypted, §13) + the durable
    // pull classification job (Brain's only run touch-point).
    sql: `
      CREATE TABLE IF NOT EXISTS run_messages (
        message_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        reservation_id TEXT,
        dedup_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('informational','action')),
        action_type TEXT,
        risk_class TEXT,
        state TEXT NOT NULL DEFAULT 'enqueued'
          CHECK (state IN ('enqueued','classification_pending','classified','deny','acknowledged',
            'approved','risk_pending','risk_authorized','policy_refused','dispatch_pending','sending',
            'dispatched','completed','failed','outcome_unknown','cancelled','expired')),
        decision TEXT CHECK (decision IN ('approve','deny','acknowledge')),
        decision_revision INTEGER NOT NULL DEFAULT 0,
        delegation_id TEXT,
        expires_at INTEGER NOT NULL,
        payload_ref TEXT,
        -- The provider-signed, plaintext-verified content digest (card_digest,
        -- E76-05/06). Stable content identity for same-dedup content-mismatch
        -- rejection + the classify-view's content_digest (NOT the randomized
        -- ciphertext id in payload_ref).
        content_digest TEXT,
        tier_candidate INTEGER,
        final_tier INTEGER,
        tier_source TEXT CHECK (tier_source IN ('action_base','brain_candidate','classify_timeout_ceiling')),
        reconciliation_evidence TEXT NOT NULL DEFAULT '[]',
        -- CA-3 (§13) — bounded terminal retention. When a message reaches a
        -- terminal state its payload's per-payload leaf erasure key is
        -- crypto-shredded past a bounded audit/replay window (not held until
        -- WHOLE-run termination). NULL = not-yet-stamped; positive = shred due
        -- at that ms; 0 = already shredded (drains the sweep). Payload-bearing
        -- terminal rows only.
        shred_after INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_messages_run_state ON run_messages(run_id, state);
      CREATE INDEX IF NOT EXISTS idx_run_messages_delegation ON run_messages(delegation_id);
      CREATE INDEX IF NOT EXISTS idx_run_messages_shred ON run_messages(shred_after);

      CREATE TABLE IF NOT EXISTS run_classification_jobs (
        message_id TEXT PRIMARY KEY,
        message_revision INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','classified','timed_out','cancelled','expired')),
        lease_token TEXT,
        lease_expires_at INTEGER,
        tier_candidate INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_classification_jobs_pending
        ON run_classification_jobs(state, lease_expires_at);
    `,
  },
  {
    version: 24,
    name: 'run_completion_receipts',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §6.2. Provider-signed completion
    // keyed by delegation_id; the two-step idempotent-CAS advancement backing
    // store. `verified_pending` receipts are re-advanced by the recovery pass.
    sql: `
      CREATE TABLE IF NOT EXISTS run_completion_receipts (
        delegation_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed','failed')),
        result_card_ref TEXT,
        -- R3-01 — the SIGNED result-card digest, first-writer-immutable: a second
        -- completion for this delegation carrying a different digest is a conflict
        -- (rejected before any card is stored), so a card signed for one outcome can
        -- never be attached to another. Null when the completion carried no card.
        result_card_digest TEXT,
        -- Round-A A-04 (§13) — a result card that arrived while its persona was
        -- LOCKED is device-sealed into the run spool; this ref (JSON: spool id +
        -- digest + staged key id) points at the staged copy until the unlock
        -- replay re-wraps it under the persona DEK and attaches result_card_ref.
        result_card_staged_ref TEXT,
        receipt_state TEXT NOT NULL DEFAULT 'verified_pending'
          CHECK (receipt_state IN ('verified_pending','advanced')),
        issued_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_completion_receipts_pending
        ON run_completion_receipts(receipt_state, received_at);
    `,
  },
  {
    version: 25,
    name: 'run_command_receipts',
    // docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §12.5. Durable per-command
    // idempotency: a replayed old command returns the stored response without
    // re-executing (so a replayed `resume` can't undo a newer `pause`).
    sql: `
      CREATE TABLE IF NOT EXISTS run_command_receipts (
        receipt_key TEXT PRIMARY KEY,
        owner_principal TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        route TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 26,
    name: 'push_subscriptions',
    // docs/PUSH_SERVICES_ARCHITECTURE.md §6/§15. The subscriber-authored,
    // standing, revocable, persona-scoped, rate-budgeted push authorization —
    // the only thing that admits an inbound push (default-deny). Holds the grant
    // gate + the local config/counters (rate bucket + cry-wolf/suspicion).
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        provider_did TEXT NOT NULL,
        service_uri TEXT NOT NULL,
        push_capability TEXT NOT NULL,
        persona TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        condition_ref TEXT NOT NULL,
        condition_json TEXT NOT NULL DEFAULT '{}',
        priority_ceiling TEXT NOT NULL DEFAULT 'engagement'
          CHECK (priority_ceiling IN ('engagement','solicited','fiduciary')),
        rate_budget_tokens INTEGER NOT NULL,
        rate_window_seconds INTEGER NOT NULL,
        rate_tokens_remaining INTEGER NOT NULL,
        rate_window_started_at INTEGER NOT NULL,
        fulfilment TEXT NOT NULL DEFAULT 'push'
          CHECK (fulfilment IN ('push','poll','push_with_poll_fallback')),
        poll_interval_seconds INTEGER,
        delivery_evidence TEXT NOT NULL DEFAULT 'none'
          CHECK (delivery_evidence IN ('none','trigger_evidence_required')),
        cry_wolf_dismissals INTEGER NOT NULL DEFAULT 0,
        suspicion_score INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_persona ON push_subscriptions(persona);
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_auth
        ON push_subscriptions(provider_did, service_uri, push_capability) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 27,
    name: 'notification_log',
    // R4-03 — the DURABLE notification inbox. Brain's inbox store
    // (packages/brain/src/notifications/inbox.ts) dual-writes through
    // `NotificationLogRepository` so watch/push/reminder/approval notifications
    // survive restart and Tier-3 items reach the daily briefing. `data_scope`
    // keeps a guided-demo notification purgeable on demo teardown (never
    // surviving the demo in the durable log). Timestamps are caller-supplied
    // epoch ms (JS Date.now()), matching every other Tier-0 table.
    sql: `
      CREATE TABLE IF NOT EXISTS notification_log (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        read_at INTEGER,
        source_id TEXT NOT NULL,
        deep_link TEXT,
        expires_at INTEGER,
        data_scope TEXT NOT NULL DEFAULT 'user'
      );
      CREATE INDEX IF NOT EXISTS idx_notification_log_fired ON notification_log(fired_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notification_log_scope ON notification_log(data_scope);
    `,
  },
  {
    version: 28,
    name: 'connected_agent_gating',
    // CONNECTED_AGENT_GATING_AND_BRAIN.md Phase 1. The policy is owned by Core,
    // not the host adapter. Session-bound authority provenance preserves the
    // non-owner Full-Supervision floor when work runs inside an otherwise
    // owner-facing coding session. `agent_sessions` was folded into v1 after
    // early Home Nodes had already applied that version, so v28 must create the
    // pre-v28 shape itself before adding the authority column.
    sql: `
      CREATE TABLE IF NOT EXISTS agent_gating_policies (
        agent_did TEXT PRIMARY KEY,
        profile TEXT NOT NULL
          CHECK (profile IN ('network_protection','sensitive_boundaries','full_supervision')),
        policy_version INTEGER NOT NULL,
        selected_by_owner_did TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_gating_policies_updated
        ON agent_gating_policies(updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        agent_did TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_principal
        ON agent_sessions(agent_did, host_session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended
        ON agent_sessions(ended_at);

      ALTER TABLE agent_sessions ADD COLUMN authority_origin_json TEXT;
    `,
  },
  {
    version: 29,
    name: 'connected_agent_reasoning',
    // CONNECTED_AGENT_GATING_AND_BRAIN.md Phases 2/3. The identity database is
    // SQLCipher-backed, so short-lived input/context projections are encrypted
    // at rest. workflow_tasks stores only opaque ids and hashes.
    sql: `
      CREATE TABLE IF NOT EXISTS reasoning_backends (
        backend_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
          CHECK (kind IN ('connected_host','internal_brain','local_model','remote_provider')),
        principal_did TEXT NOT NULL,
        allowed_task_kinds_json TEXT NOT NULL,
        max_sensitivity TEXT NOT NULL
          CHECK (max_sensitivity IN ('public','personal','sensitive')),
        availability TEXT NOT NULL
          CHECK (availability IN ('foreground','always_on')),
        model_class TEXT,
        policy_version INTEGER NOT NULL,
        selected_by_owner_did TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reasoning_backends_principal
        ON reasoning_backends(principal_did, enabled, revoked_at);

      CREATE TABLE IF NOT EXISTS reasoning_projections (
        projection_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('input','context')),
        owner_did TEXT NOT NULL,
        purpose TEXT NOT NULL,
        sensitivity TEXT NOT NULL
          CHECK (sensitivity IN ('public','personal','sensitive')),
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        scrubbed INTEGER NOT NULL CHECK (scrubbed IN (0,1)),
        allowed_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reasoning_projections_task
        ON reasoning_projections(task_id, kind);
      CREATE INDEX IF NOT EXISTS idx_reasoning_projections_expiry
        ON reasoning_projections(expires_at);

      CREATE TABLE IF NOT EXISTS reasoning_context_tickets (
        ticket_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL,
        backend_id TEXT NOT NULL REFERENCES reasoning_backends(backend_id),
        principal_did TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        purpose TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        input_projection_id TEXT NOT NULL REFERENCES reasoning_projections(projection_id),
        context_projection_id TEXT REFERENCES reasoning_projections(projection_id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_ticket_claim
        ON reasoning_context_tickets(task_id, claim_id);
      CREATE INDEX IF NOT EXISTS idx_reasoning_ticket_expiry
        ON reasoning_context_tickets(expires_at);
    `,
  },
  {
    version: 30,
    name: 'reasoning_ticket_session_binding',
    // A connected-host context ticket is authority from one exact Core
    // session, not a reusable credential for every future session held by the
    // same paired DID. Managed always-on workers store NULL.
    sql: `
      ALTER TABLE reasoning_context_tickets ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_reasoning_ticket_session
        ON reasoning_context_tickets(session_id, revoked_at);
    `,
  },
  {
    version: 31,
    name: 'commerce_stores',
    // Commerce Pack durable stores (docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md
    // §9.9/§9.11/§15.5/§16.2). Five tables:
    //
    // commerce_order_refs — the supplier-side order-reference/idempotency
    // store. BOTH identities are unique per buyer ((buyerDid, purchaseOrderId)
    // and (buyerDid, idempotencyKey)); a key arriving under the other order is
    // a typed conflict, never aliasing. `state` is reserved-until-decided;
    // `effect_phase` is written to 'effect_started' BEFORE the first external
    // boundary attempt, so crash recovery can never time out (and refund) a
    // reservation whose external order may exist. `pinned_major` routes
    // prior-major lifecycle requests to the retained handler set (§9.13).
    // acknowledgement_json is the recorded SIGNED acknowledgement — every
    // terminal outcome, including rejections, persists it for replay.
    //
    // commerce_quote_heads — supplier-side CAS at signing: one row per
    // quoteId holding the current head digest/revision plus the immutable
    // maxUses and validity window; `voided` implements §16.2 restore voiding
    // (capacity is never resurrected from a backup).
    //
    // commerce_quote_uses — provisional use holds keyed on the consuming
    // order, mirroring plugin_grant_uses: held -> committed (accepted) or
    // refunded (every rejection / counterproposal), so a stale-revision
    // rejection never bricks the current revision's re-approval.
    //
    // commerce_status_heads — supplier-side status-chain CAS (§9.11): a
    // conforming supplier cannot emit two valid successors of one status.
    //
    // commerce_receipts — the Core-owned durable commercial memory (§16.2):
    // canonical quote chain, orders, acknowledgements, status chain,
    // cancellations, reconciliation and restore-fence events with their
    // verification evidence. Workflow rows stay the execution engine;
    // receipts survive plugin pause/revoke/uninstall.
    //
    // commerce_epoch_watermarks — counterparty-side restore fence (§16.2):
    // highest supplierEpoch seen per supplier DID; a newly signed record
    // below the watermark is rejected as a stale pre-restore signer.
    //
    // Timestamps are caller-supplied epoch ms, matching every other Tier-0
    // table. TEXT epoch/sequence columns carry canonical integer STRINGS
    // (the wire form) — comparisons happen in JS via BigInt, never SQL.
    sql: `
      -- commerce_buyer_orders — the BUYER's side of an ambiguous outcome
      -- (§12.7). Separate from commerce_order_refs, which is the supplier's:
      -- the two describe one trade from opposite ends and disagree on purpose
      -- (a supplier's record says what it committed to, a buyer's says what it
      -- has been able to learn), so one table holding both would have to pick
      -- a winner. poll_count is persisted because §12.7 requires the
      -- received_unresolved loop to survive a buyer restart — an in-memory
      -- counter would reset on relaunch, which is exactly the crash that lost
      -- the acknowledgement in the first place.
      -- commerce_settings — buyer and supplier policy (§18.2, §18.3). ONE ROW
      -- PER KIND: a node acts as one buyer and one supplier, and an id column
      -- would invite a second profile nothing knows how to choose between.
      -- Validated on READ as well as write, because these settings gate
      -- refusals and the row is editable by anything with the database open.
      -- Credentials never land here: §18.3 asks for credential STATUS.
      CREATE TABLE IF NOT EXISTS commerce_settings (
        kind TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL
      );

      -- commerce_credentials — connector material (8.3, WS-9.3). THE ONE
      -- PLACE a connector secret is allowed to be. It lives here, in Tier 0,
      -- because identity.sqlite is SQLCipher over a DEK derived from the
      -- master seed: the same encryption at rest that protects the vault. The
      -- material column is read by exactly one function (useSecret), which
      -- hands it to a callback and never returns it; every other reader names
      -- the status columns explicitly, so a SELECT * can never carry a secret
      -- into a log. last_result is DERIVED from brokered calls rather than
      -- typed by an owner, because a credential status somebody typed stopped
      -- being true the moment the other end rotated theirs.
      -- commerce_idempotency_evidence — 15.5, WS-9.4. What a connector has
      -- PROVEN about the external system, keyed per (resource, operation):
      -- proving an ERP deduplicates submit_purchase_order says nothing about
      -- cancel_purchase_order, and a store keyed only by connector would let
      -- one probe authorise retries on operations nobody tested. probe_json
      -- is NULL when the connector merely declared idempotency, which 15.5
      -- says is not evidence — automatic resubmission stays disabled and the
      -- ambiguity resolves through 12.7. A row that will not parse reads as
      -- absent, which fails toward that same default.
      CREATE TABLE IF NOT EXISTS commerce_idempotency_evidence (
        resource TEXT NOT NULL,
        operation TEXT NOT NULL,
        declared_retention_ms INTEGER NOT NULL,
        probe_json TEXT,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (resource, operation)
      );

      CREATE TABLE IF NOT EXISTS commerce_credentials (
        resource TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        material TEXT NOT NULL,
        rotated_at_ms INTEGER NOT NULL,
        last_result TEXT NOT NULL DEFAULT 'never_used',
        last_checked_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS commerce_buyer_orders (
        supplier_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        -- §12.7: what the QUESTION needs, stored with the order. poll_count is
        -- a column because the spec requires the re-poll loop to survive a
        -- restart, and the loop cannot ask anything without the order digest
        -- and idempotency key. Storing the count and not these made the loop
        -- durable in name only: after a restart the buyer knew it should ask
        -- and could not say what about.
        order_digest TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        -- The protocol version the order was sent at; a reconcile request
        -- must match it exactly (§9.13).
        protocol_version TEXT NOT NULL DEFAULT '',
        -- WHERE to ask. A supplier may offer commerce on a non-default
        -- listing, and a service query with no service_uri is checked against
        -- the default one — so without this the re-poll would be refused by
        -- exactly the suppliers who run more than one listing.
        service_rkey TEXT NOT NULL DEFAULT '',
        -- The row's version, for compare-and-swap. Every write is load →
        -- await → write, so without it the SLOWEST writer wins: a send
        -- completing after a re-poll settled the order would overwrite a
        -- terminal acknowledgement with an outcome_unknown.
        revision INTEGER NOT NULL DEFAULT 0,
        -- §9.12/§20.4: what an ANSWER about this order must match. Without
        -- these the buyer validated an acknowledgement's shape and its own
        -- digest and then believed it, so a supplier could answer the question
        -- about one order with the acknowledgement for another and have it
        -- stored as the settled commercial evidence.
        quote_digest TEXT NOT NULL DEFAULT '',
        quote_id TEXT NOT NULL DEFAULT '',
        buyer_did TEXT NOT NULL DEFAULT '',
        bound_supplier_did TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        acknowledgement_json TEXT,
        next_poll_at_ms INTEGER,
        poll_count INTEGER NOT NULL DEFAULT 0,
        resubmission_authorized INTEGER NOT NULL DEFAULT 0,
        protocol_fault TEXT,
        -- §12.7/§16.2 — the VERIFIED envelope that carried the
        -- acknowledgement, stored as JSON with envelopeId and signature. This
        -- makes a later never_received ILLEGAL. Without it the buyer presents
        -- nothing, the supplier's denial is legal, and never_received is the
        -- one answer that authorises a resubmission -- a duplicate order.
        --
        -- Nullable: an order settled with no transport evidence (an
        -- in-process double) stores none, and the honest consequence is that
        -- its never_received stays legal.
        ack_evidence_json TEXT,
        -- The order lines AS SENT, kept because §9.11's cumulative-snapshot
        -- rule is checked by the RECEIVER and cannot be checked without them.
        -- This is the buyer's own document, not a counterparty claim, so
        -- there is no trust question in storing it -- only a completeness
        -- one: verifyStatusLines handed an empty list rejects every status
        -- that carries lines, which would turn ordinary dispatch into a fork.
        order_lines_json TEXT,
        PRIMARY KEY (supplier_did, purchase_order_id)
      );

      -- commerce_buyer_status_records -- the BUYER's verified copy of the
      -- supplier's signed status chain (§9.11 fork detection, §16.2 fences).
      --
      -- EVERY ACCEPTED RECORD, not just the head. A §16.2 restore fence may
      -- name a strict ANCESTOR of the buyer's head, and verifyRestoreFence
      -- takes the whole held chain to decide whether the named predecessor is
      -- in it. A head-only store could not answer that, so it would have to
      -- either refuse every fence or accept any of them.
      --
      -- THE PRIMARY KEY IS THE CAS. Two concurrent ingests of the same
      -- sequence cannot both insert, so a supplier that emits two successors
      -- of one head has exactly one of them recorded and the other detected
      -- as the fork it is.
      -- commerce_buyer_quotes -- the BUYER's verified copy of each supplier's
      -- signed quote chain (§9.8 revisions, §25.3 buyer-side fork detection).
      --
      -- SEPARATE FROM commerce_quotes, which is the SUPPLIER's ledger and
      -- carries use holds: capacity this node is SELLING. One table holding
      -- both would show a buyer's received quotes on the owner's "quotes I
      -- issued" screen, and would have to pick a winner between two records
      -- that describe one negotiation from opposite ends.
      --
      -- EVERY REVISION, not just the head, for the same reason the buyer's
      -- status chain keeps every record: succession is checked link by link,
      -- so a buyer handed revision 5 while holding revision 2 can neither
      -- verify it nor honestly call it a fork.
      --
      -- THE PRIMARY KEY IS THE CAS. Two concurrent ingests of one revision
      -- cannot both insert, so a supplier emitting two successors of one head
      -- has exactly one recorded and the other detected as the fork it is.
      CREATE TABLE IF NOT EXISTS commerce_buyer_quotes (
        supplier_did TEXT NOT NULL,
        quote_id TEXT NOT NULL,
        -- Canonical string on the wire; the integer is what orders the chain.
        -- Comparing '10' with '9' as text picks the wrong head.
        quote_revision TEXT NOT NULL,
        revision_num INTEGER NOT NULL,
        quote_digest TEXT NOT NULL,
        record_json TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (supplier_did, quote_id, revision_num)
      );

      -- commerce_buyer_quote_requests -- what THIS node asked, retained so it
      -- can check what comes back.
      --
      -- §9.8 gives the buyer two checks nobody else can make: that an arriving
      -- quote's request_digest is the request this node actually sent, and
      -- that its priced_delivery_projection_digest is the projection this node
      -- priced against. Both compare a quote to something only the buyer
      -- holds, and until this table there was nowhere to hold it — so
      -- verifySignedQuoteForBuyer existed with no caller and the §20.4
      -- bait-and-switch control was unreachable.
      --
      -- The whole request body is kept, not just its digest. The digest proves
      -- the supplier SAW the request; only the body can show whether the
      -- quote's lines correspond to it, which is what catches an invented line
      -- id or a substitution the buyer forbade.
      CREATE TABLE IF NOT EXISTS commerce_buyer_quote_requests (
        request_id TEXT PRIMARY KEY,
        supplier_did TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        -- Denormalised so the §9.8 projection check needs no re-parse.
        projection_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );

      -- §15.2 — the approval material Core MINTED when the card was shown.
      --
      -- The binding is only worth having if the two sides of the comparison
      -- come from different places. A submit that carried both the order and
      -- the approval payload proved only that its caller was self-consistent:
      -- a client that re-planned the order simply rebuilt both halves and the
      -- check passed. So Core keeps the approved order here and the submit
      -- names it by id.
      --
      -- The PAYLOAD is not stored, only its digest: the payload is a pure
      -- function of (order, context), so keeping it as well would be a second
      -- copy to disagree with the first. Reads rebuild it and compare, which
      -- makes a row edited in the store read as absent.
      CREATE TABLE IF NOT EXISTS commerce_order_approvals (
        approval_id TEXT PRIMARY KEY,
        supplier_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        approval_digest TEXT NOT NULL,
        order_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        service_rkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        -- Single use. Set by a CAS so two taps on one card cannot both send.
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS commerce_buyer_status_records (
        supplier_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        -- Canonical string form on the wire; the integer is what orders the
        -- chain. Both are stored so neither has to be re-derived: comparing
        -- '10' with '9' as text picks the wrong head.
        sequence TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        status_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL,
        -- The verified envelope that delivered this record, same shape and
        -- same reason as commerce_buyer_orders.ack_evidence_json. §12.7's
        -- reconcile presents held STATUS receipts alongside the
        -- acknowledgement, and a record with no envelope is a record the
        -- buyer cannot attribute.
        evidence_json TEXT,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (supplier_did, purchase_order_id, sequence_num)
      );

      CREATE TABLE IF NOT EXISTS commerce_order_refs (
        buyer_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        order_digest TEXT NOT NULL,
        quote_id TEXT NOT NULL,
        quote_digest TEXT NOT NULL,
        -- §9.13: the EXACT protocol version of the order that opened this
        -- conversation, not just its major. Every continuation record for
        -- this order is emitted at this version, and a lifecycle request
        -- must match it exactly. Storing only the major let a 1.1 order
        -- receive 1.0 continuation records, so schema hashes and record
        -- interpretation could disagree inside one chain. The major is
        -- derived from this when drain counting needs it.
        pinned_version TEXT NOT NULL,
        -- §9.13: the plugin manifest CID serving this supplier at admission,
        -- or '' when no plugin served the order. A lifecycle request must be
        -- parsed under the contract the order was opened against, and after a
        -- plugin update the install's CURRENT manifest is no longer that
        -- contract. pinned_version says which protocol major; this says
        -- which manifest implements it, and it is the key the
        -- drain-authorization table already uses.
        serving_manifest_cid TEXT NOT NULL DEFAULT '',
        -- §16.4: WHICH INSTALL served this order, alongside the manifest CID
        -- above. The two answer different questions and only one of them
        -- survives a plugin update: after an update the CID moves on while the
        -- install id does not, so "does this install still owe anybody
        -- anything" cannot be answered by the CID. Without it the uninstall
        -- obligation count was node-wide, which over-refuses on a node running
        -- more than one commerce plugin — safe, but it made an operator resolve
        -- another pack's orders to remove this one.
        serving_install_id TEXT NOT NULL DEFAULT '',
        -- §16.2: the commerce epoch this order was ADMITTED under. Chain
        -- creation needs it: at genesis there is no head to compare against,
        -- so "does this order predate the restore" can only be answered by
        -- the order itself. Without it a restored node re-signs a divergent
        -- sequence-0 record and forks against the genesis the buyer holds.
        admitted_epoch TEXT NOT NULL DEFAULT '1',
        -- §16.2: set when an order reference was rebuilt from a counterparty's
        -- held evidence rather than admitted here. Such an order is missing its
        -- lines, quote context and external state, so this node must not sign a
        -- first status for it until the per-order reconciliation ceremony runs.
        -- A distinct FLAG rather than an epoch sentinel: "was re-adopted" and
        -- "belongs to an older generation" are different facts, and at epoch 1
        -- there is no lower epoch to encode the first one with.
        reconciliation_required INTEGER NOT NULL DEFAULT 0,
        -- §16.2/§9.11: set when the buyer that presented this order's held
        -- evidence ALSO presented verifiable status receipts — proving it
        -- holds a status chain this node lost. Such an order must never be
        -- given a fresh genesis: a second sequence-0 record differs from the
        -- one the buyer holds (different epoch, different timestamp, so a
        -- different digest), and §9.11 requires the buyer to reject a
        -- duplicate sequence with a different digest. The order would be
        -- stranded by the very ceremony meant to rescue it, with neither side
        -- able to say why. The flag makes chain creation refuse and names the
        -- fence path instead.
        readopted_chain_evidence INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'reserved'
          CHECK (state IN ('reserved', 'decided')),
        effect_phase TEXT NOT NULL DEFAULT 'pre_effect'
          CHECK (effect_phase IN ('pre_effect', 'effect_started')),
        acknowledgement_json TEXT,
        external_ref TEXT,
        decision_deadline_at INTEGER,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        PRIMARY KEY (buyer_did, purchase_order_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_order_refs_idem
        ON commerce_order_refs(buyer_did, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_commerce_order_refs_reserved
        ON commerce_order_refs(state, effect_phase, decision_deadline_at)
        WHERE state = 'reserved';

      -- commerce_catalog_pointers — what THIS node has actually published
      -- (§10.2, WS-7.8). One row per catalog, because the pointer IS the
      -- mutable head and a second row would be a second head.
      --
      -- WHY THE NODE KEEPS ITS OWN COPY. The pointer lives in the repo, and
      -- reading it back needs a network round trip on a surface an owner opens
      -- to see what they sell. Worse, the CAS the next publication needs is the
      -- CID of the row currently there — asking the CALLER to carry it means
      -- the caller is the authority on this node's own publication history,
      -- which is a fact this node should not have to be told.
      CREATE TABLE IF NOT EXISTS commerce_catalog_pointers (
        catalog_id TEXT PRIMARY KEY,
        -- The pointer record as published, so the owner card can render what
        -- was said rather than a summary of it.
        pointer_json TEXT NOT NULL,
        -- The repo CID of that row: the swap value the NEXT publication CASes
        -- on. Empty only in the impossible case of a write that reported none.
        pointer_cid TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL DEFAULT '',
        withdrawn INTEGER NOT NULL DEFAULT 0,
        published_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commerce_quote_heads (
        quote_id TEXT PRIMARY KEY,
        buyer_did TEXT NOT NULL,
        head_digest TEXT NOT NULL,
        head_revision TEXT NOT NULL,
        max_uses TEXT NOT NULL DEFAULT '1',
        valid_until INTEGER NOT NULL,
        supplier_epoch TEXT NOT NULL,
        voided INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_quote_heads_live
        ON commerce_quote_heads(valid_until)
        WHERE voided = 0;

      CREATE TABLE IF NOT EXISTS commerce_quote_uses (
        quote_id TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'held'
          CHECK (state IN ('held', 'committed', 'refunded')),
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        PRIMARY KEY (quote_id, purchase_order_id)
      );

      -- §15.2b — decisions a supplier pack has made and a human has not yet
      -- agreed to. Beside the other durable commercial memory rather than in
      -- the workflow engine: losing this row strands a reserved order with a
      -- buyer waiting, which is a different cost from losing a prompt.
      CREATE TABLE IF NOT EXISTS commerce_pending_decisions (
        buyer_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        -- The runner's answer VERBATIM. Settlement replays exactly these
        -- bytes, so a pack that revises its proposal after the owner has been
        -- shown one cannot have the new answer signed under the old consent.
        runner_result_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (buyer_did, purchase_order_id)
      );

      CREATE TABLE IF NOT EXISTS commerce_status_heads (
        buyer_did TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        head_digest TEXT NOT NULL,
        head_sequence TEXT NOT NULL,
        state TEXT NOT NULL,
        supplier_epoch TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        -- Epoch ms at which a delivered head stops being work (§9.11), or
        -- NULL when the state carries no window. DENORMALISED onto the head
        -- because the terminality question is asked by callers that hold no
        -- receipt: continuity release and uninstall both need "is this chain
        -- finished", and without the deadline here they counted every
        -- delivered order as unfinished FOR EVER -- pinning prior manifest
        -- CIDs alive and blocking uninstall on orders that completed
        -- normally.
        dispute_window_ends_at INTEGER,
        PRIMARY KEY (buyer_did, purchase_order_id)
      );

      -- §3.4 (WS-3.4) — the extension-operation broker's durable ledger.
      --
      -- A plugin runner never holds Dina's authority. It PROPOSES a typed
      -- host operation; the proposal is recorded here BEFORE anything is
      -- permitted or executed, so a crash between any two steps leaves a
      -- readable state rather than an effect nobody can account for. The
      -- schema digests are pinned at proposal time: a later adapter update
      -- cannot silently reinterpret a recorded history.
      CREATE TABLE IF NOT EXISTS plugin_extension_proposals (
        proposal_id TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation_name TEXT NOT NULL,
        params_json TEXT NOT NULL,
        params_schema_digest TEXT NOT NULL,
        result_schema_digest TEXT NOT NULL,
        -- proposed -> permitted -> executing -> {completed | failed | outcome_unknown}
        -- proposed -> {refused | cancelled}
        state TEXT NOT NULL,
        refusal_reason TEXT,
        result_json TEXT,
        -- One proposal per (install, idempotency key): a runner that retries
        -- after a lost response must not produce a second effect.
        idempotency_key TEXT NOT NULL,
        -- The envelope of the CLAIM that proposed this, retained when the
        -- proposal parks for an owner. Resolving it later needs the source to
        -- build the follow-up that carries the verified result back to the
        -- runner, and a parked proposal outlives the process that made it --
        -- so without this column an owner-facing decision had nothing to act
        -- on and every carded proposal was unresolvable.
        source_envelope_json TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        settled_at INTEGER,
        UNIQUE (install_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_ext_proposals_state
        ON plugin_extension_proposals (state, created_at);

      CREATE TABLE IF NOT EXISTS commerce_receipts (
        record_digest TEXT PRIMARY KEY,
        domain TEXT NOT NULL
          CHECK (domain IN (
            'projection', 'request', 'quote', 'terms', 'order',
            'acknowledgement', 'status', 'cancellation', 'result',
            'epoch', 'restore_fence_event'
          )),
        buyer_did TEXT NOT NULL DEFAULT '',
        quote_id TEXT NOT NULL DEFAULT '',
        purchase_order_id TEXT NOT NULL DEFAULT '',
        record_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_receipts_order
        ON commerce_receipts(buyer_did, purchase_order_id);
      CREATE INDEX IF NOT EXISTS idx_commerce_receipts_quote
        ON commerce_receipts(quote_id);

      CREATE TABLE IF NOT EXISTS commerce_epoch_watermarks (
        supplier_did TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Drain authorizations (§9.13): after an atomic rebind, the claim
      -- guard admits prior-CID tasks ONLY through a live entry here.
      -- 'drain' entries cover already-created tasks until the drain
      -- deadline; 'lifecycle_continuity' entries admit NEW lifecycle
      -- tasks (order_status / order_reconcile / cancel_order) bound to
      -- non-terminal prior-major orders, released once the last such
      -- order is terminal. Each row pins the AUTHORIZED prior values
      -- the guard validates the envelope against (the current manifest
      -- no longer matches by construction). Live authority — never
      -- exported.
      CREATE TABLE IF NOT EXISTS plugin_drain_authorizations (
        install_id TEXT NOT NULL,
        previous_cid TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('drain', 'lifecycle_continuity')),
        approved_scope_hash TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        action_class TEXT NOT NULL,
        effects_idempotency TEXT NOT NULL,
        result_schema_json TEXT NOT NULL,
        params_schema_json TEXT NOT NULL DEFAULT 'null',
        max_context_items INTEGER,
        -- §9.13 — the protocol version the PRIOR manifest declared.
        --
        -- A lifecycle continuation across a major must be answered by the code
        -- that took the order, not by whatever is installed now. Without this
        -- the row said which CID was authorized and nothing about which
        -- CONTRACT it speaks, so a continuation dispatched to the current
        -- adapter and a runner had no way to know it was answering for an
        -- older major. Empty for rows written before the column existed.
        prior_version TEXT NOT NULL DEFAULT '',
        -- Which KINDS the prior capability was consented for (JSON array).
        --
        -- The claim guard skips its whole consent block for a drained task,
        -- because the capability may have left the current manifest entirely
        -- and the drain entry is the consent proof. But the entry recorded no
        -- kinds, so the one check inside that block with an authority meaning
        -- went with it: an ingress task may dispatch only a capability
        -- consented as provider, and every other plugin task requires
        -- tool. A continuity lane opened for a provider capability admitted
        -- a tool envelope, and the reverse. Empty array for rows written
        -- before this column existed, which the guard reads as "cannot tell"
        -- and refuses rather than waves through.
        authorized_kinds_json TEXT NOT NULL DEFAULT '[]',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (install_id, previous_cid, capability_id, kind)
      );

      -- commerce_catalog_drafts — the photo-catalog lane's durable state
      -- (docs/PHOTO_CATALOG_LANE.md §6, §10 item 8).
      --
      -- ONE ROW IS ONE PUBLICATION ATTEMPT, from extracted rows through to a
      -- published pointer. It exists because the lane suspends twice on a
      -- human: once at confirm, once at the snapshot review — and a design
      -- that held those in memory would lose an owner's approval to an app
      -- restart and then rebuild different bytes, which is the one thing the
      -- approval is supposed to prevent.
      --
      -- WHY THE ASSEMBLED ITEMS ARE STORED AND NOT RECOMPUTED. Publish takes
      -- a draft id and no item list, so the items Core signs are the items
      -- Core stored. Recomputing them at publish would reopen exactly the gap
      -- the draft id closes: a caller could not substitute a set, but a
      -- rebuild could substitute itself.
      CREATE TABLE IF NOT EXISTS commerce_catalog_drafts (
        draft_id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL,
        -- created | confirmed | prepared | approved | published. Enforced in
        -- code, stored here so a restart does not lose where the draft was —
        -- without this column the "persisted state machine" persists no state.
        state TEXT NOT NULL,
        -- owner_authored | source_parsed | model_derived. CORE ASSIGNS THIS
        -- from the entry point used; the caller never states it, because a
        -- class that exempts a draft from confirmation is worth forging.
        -- Defaults to the strictest so an unestablished class demands a
        -- receipt rather than skipping one.
        provenance_class TEXT NOT NULL DEFAULT 'model_derived',
        -- How every bare identifier in these rows is READ. Stored because
        -- repair (§5 step 4) re-imports the stored rows, and re-importing them
        -- under a different scheme would silently reinterpret the catalog.
        default_scheme TEXT NOT NULL DEFAULT 'sku',
        -- §5: where a model produced the values, the extraction that produced
        -- them. Empty on the classes that infer nothing. Held per DRAFT rather
        -- than per field because one draft is one extraction, and 20 copies of
        -- one string is not more provenance.
        -- Set while a publication is in flight, so an edit racing the two
        -- network writes is refused rather than silently overwritten. Zero
        -- means unclaimed; a claim older than the TTL is treated as abandoned
        -- so a process that died mid-publish cannot brick the draft.
        publish_claimed_at_ms INTEGER NOT NULL DEFAULT 0,
        -- WHOSE claim it is. Age alone cannot answer that: two publications
        -- overlapping past the TTL would each clear the other's, and a clock
        -- that moves backwards makes an expiry unreachable.
        publish_claim_token TEXT NOT NULL DEFAULT '',
        extraction_model TEXT NOT NULL DEFAULT '',
        extraction_schema_version TEXT NOT NULL DEFAULT '',
        -- §2.1 (photo lanes): the ordered manifest capture produced —
        -- {artifact_id, content_hash, page_index}[] — never raw bytes, which
        -- live in commerce_image_artifacts. Empty on non-photo drafts.
        extraction_manifest_json TEXT NOT NULL DEFAULT '',
        -- The extraction commitment digest (catalog lane domain). A SECOND
        -- digest beside receipt_digest, never a widening of its preimage.
        extraction_digest TEXT NOT NULL DEFAULT '',
        -- The versioned extraction-binding record {draft_id, content_revision,
        -- extraction_digest} — the chain link checked at confirm, prepare and
        -- publish, because commitments that verify alone prove nothing about
        -- belonging together.
        extraction_binding_json TEXT NOT NULL DEFAULT '',
        -- Monotonic over CONTENT only: rows, findings, per-field provenance
        -- and assembled items. Core's own bookkeeping writes (the receipt, the
        -- held bytes, the approval) do NOT bump it — a rule that fired on its
        -- own writes would invalidate every publication.
        content_revision INTEGER NOT NULL DEFAULT 0,
        rows_json TEXT NOT NULL DEFAULT '[]',
        findings_json TEXT NOT NULL DEFAULT '[]',
        -- Per field: proposed | accepted | edited | not_model_derived, with the
        -- model and schema version where a model produced it.
        provenance_json TEXT NOT NULL DEFAULT '{}',
        items_json TEXT NOT NULL DEFAULT '[]',
        -- Minted ONCE at assembly and never re-derived. A rebuild that re-mints
        -- either changes the canonical bytes and so the snapshot digest, which
        -- breaks an approval the owner already gave.
        generated_at_iso TEXT NOT NULL DEFAULT '',
        item_revision TEXT NOT NULL DEFAULT '',
        -- The content receipt: Core mints it, Core keeps it, no caller ever
        -- presents one. Carries the content revision it was taken at.
        receipt_digest TEXT NOT NULL DEFAULT '',
        receipt_revision INTEGER NOT NULL DEFAULT -1,
        -- Held across the owner's review: the built snapshot and its pages,
        -- the CAS value, and the approval. All four carry the content revision
        -- they were built from, and any edit voids them together.
        held_snapshot_json TEXT NOT NULL DEFAULT '',
        held_pages_json TEXT NOT NULL DEFAULT '',
        -- The pointer the builder MADE, not one reassembled at publish time.
        -- previous_snapshot_digest and service_rkey live only on the pointer,
        -- so a rebuild drops the chain link and the listing binding: the repo
        -- accepts the write and AppView then refuses it for a broken chain.
        held_pointer_json TEXT NOT NULL DEFAULT '',
        held_pointer_cid TEXT NOT NULL DEFAULT '',
        held_revision INTEGER NOT NULL DEFAULT -1,
        approved_digest TEXT NOT NULL DEFAULT '',
        approved_revision INTEGER NOT NULL DEFAULT -1,
        -- Set once the pointer write is accepted. A publish against a terminal
        -- draft returns this rather than starting a second publication.
        publication_json TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_commerce_catalog_drafts_catalog
        ON commerce_catalog_drafts(catalog_id, updated_at_ms DESC);

      -- commerce_image_egress_authorizations — §3's Hop-1 gate (photo lanes).
      --
      -- ONE ROW IS ONE PERMITTED TRANSMISSION. The broker is the only holder
      -- of a vision-provider credential, and it acts only against a row here:
      -- single-use (consumed by CAS), expiring, pinned to a provider, a
      -- purpose, and the exact content hashes of the pages that may leave.
      -- An authorization is not advisory — the data plane refuses bytes whose
      -- hash the row does not name, so approving {hash, provider, purpose}
      -- and transmitting something else is not a reachable sequence.
      CREATE TABLE IF NOT EXISTS commerce_image_egress_authorizations (
        authorization_id TEXT PRIMARY KEY,
        -- catalog_extraction | order_extraction. The schema the seam speaks
        -- is derived from this, never chosen by the caller at egress time.
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        -- The ordered manifest's page hashes, JSON array of hex64. The gate
        -- re-hashes the actual outgoing bytes against these immediately
        -- before the broker is handed anything.
        content_hashes_json TEXT NOT NULL,
        max_bytes INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        -- 0 = unconsumed. Consumption is a single-statement CAS: two racing
        -- extractions cannot both transmit under one authorization.
        consumed_at_ms INTEGER NOT NULL DEFAULT 0
      );

      -- commerce_image_artifacts — §6's defined artifact (photo lanes).
      --
      -- The photograph lives HERE, in the same encrypted store as the draft
      -- that owns it — never as raw bytes in a draft row, and deliberately
      -- not behind a persona lock: the repair screen must always have the
      -- photograph beside the values, which is the screens' whole point.
      -- The trade is named in the design: always-available-for-review,
      -- protected by the store's SQLCipher encryption at rest, riding in
      -- backups — which is why the byte ceiling is hard and erasure is tied
      -- to the draft's.
      --
      -- BYTES ARE STORED POST-INGEST ONLY: bounded, header-checked, fully
      -- re-encoded with EXIF dropped. content_hash is over the STORED bytes,
      -- and it is what egress authorizations pin.
      CREATE TABLE IF NOT EXISTS commerce_image_artifacts (
        artifact_id TEXT PRIMARY KEY,
        -- Which draft owns this page. Erasure is transactional with the
        -- draft; an artifact with no living draft is a sweep candidate.
        owner_draft_id TEXT NOT NULL,
        -- catalog | order. Two draft aggregates, one artifact store.
        lane TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        mime TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        bytes BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_commerce_image_artifacts_draft
        ON commerce_image_artifacts(owner_draft_id, page_index);

      -- commerce_sku_assignments — §4.2's reservation ledger (photo lanes).
      --
      -- ONE ROW IS ONE CLAIMED IDENTIFIER, scoped to the ISSUER because the
      -- protocol identity the importer builds is (issuer_did, scheme, value).
      -- The rule is a CLAIM, not a check: every identifier entering a clean
      -- draft — minted, inherited, seller-edited, or source-provided —
      -- atomically claims here under the product's immutable assignment_id.
      -- A claim the same assignment already holds succeeds idempotently
      -- (an SKU edit and a republication both); a claim another assignment
      -- holds refuses, naming the owning catalog.
      --
      -- LIFECYCLE: a claim whose assignment has NEVER been published is
      -- released when its draft is erased or abandoned (nothing public
      -- references it); a published claim survives for ever. The high-water
      -- mark below never rewinds, so "never re-issued" holds for minted
      -- values across releases.
      CREATE TABLE IF NOT EXISTS commerce_sku_assignments (
        issuer_did TEXT NOT NULL,
        scheme TEXT NOT NULL,
        value TEXT NOT NULL,
        -- Immutable internal product identity — minted once when a row
        -- first becomes a product, NEVER derived from anything the seller
        -- can edit (productIdentity() includes the SKU value, which is
        -- exactly what an edit changes).
        assignment_id TEXT NOT NULL,
        -- v1: a photo-lane product belongs to ONE catalog. A claim from a
        -- second catalog refuses, naming this one.
        catalog_id TEXT NOT NULL,
        -- The draft currently holding the claim — release-by-draft reads it.
        draft_id TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (issuer_did, scheme, value)
      );

      CREATE INDEX IF NOT EXISTS idx_commerce_sku_assignments_draft
        ON commerce_sku_assignments(draft_id);

      -- The per-issuer mint counter. Monotonic, never rewound — a release
      -- frees the CLAIM, never the number.
      CREATE TABLE IF NOT EXISTS commerce_sku_highwater (
        issuer_did TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL
      );

      -- commerce_order_drafts — the BUYER lane's aggregate (photo-commerce
      -- design §5.1). Its OWN store beside (not inside) the catalog
      -- draft's: an order line is not a CatalogItem, and forcing one
      -- through those readers erases it.
      --
      -- ONE ROW IS ONE PHOTOGRAPHED PAGE — the whole page, however many
      -- suppliers its lines resolve across. Lines, requirements and
      -- conversations live as JSON documents validated fail-closed on
      -- read; top-level state is DERIVED from them, never stored beside
      -- them where the two could disagree.
      CREATE TABLE IF NOT EXISTS commerce_order_drafts (
        draft_id TEXT PRIMARY KEY,
        -- The ordered manifest {artifact_id, content_hash, page_index}[]
        -- — the photographs live in commerce_image_artifacts under this
        -- draft's id, lane 'order'.
        manifest_json TEXT NOT NULL DEFAULT '[]',
        extraction_model TEXT NOT NULL DEFAULT '',
        extraction_schema_version TEXT NOT NULL DEFAULT '',
        -- The §2.1 extraction commitment digest (order-draft domain). The
        -- vouch receipt commits it, which is what chains a ceremony to
        -- THESE photographed lines.
        extraction_digest TEXT NOT NULL DEFAULT '',
        -- Lines: text, parsed hints, per-field provenance, resolution
        -- state, assignment generation, vouch entry, evidence record ref.
        lines_json TEXT NOT NULL DEFAULT '[]',
        -- Requirements, BOTH kinds: transmitted (delivery date,
        -- destination) and draft-local (the free text never transmitted).
        requirements_json TEXT NOT NULL DEFAULT '[]',
        -- Per-supplier conversations: request + digest, quote heads,
        -- accepted quote, approval id, submission state, snapshots.
        conversations_json TEXT NOT NULL DEFAULT '[]',
        -- §5.1: bumped ONLY by confirm ceremonies — never by repairs
        -- (which bump line generations), never by Core bookkeeping.
        ceremony_counter INTEGER NOT NULL DEFAULT 0,
        -- Explicit abandonment; submitted conversations stay immutable
        -- history inside conversations_json.
        abandoned INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `,
  },
  {
    version: 32,
    name: 'audit_retention_checkpoint',
    // This table was first added by editing the v1 block in place, which only
    // ever runs on a FRESH database — every vault that existed before the
    // edit (dev nodes, upgrading phones) then died at boot in
    // hydrateAuditState with "no such table". Applied migrations are
    // immutable, so existing databases get it here; IF NOT EXISTS keeps the
    // fresh-database path (v1 already created it) harmless.
    sql: `
      CREATE TABLE IF NOT EXISTS audit_retention_checkpoint (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        first_retained_seq INTEGER NOT NULL CHECK (first_retained_seq >= 1),
        anchor_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
        -- The author/sender resolved to a canonical person_id (people
        -- graph, identity.sqlite). Set for inbound D2D items where the
        -- sender DID resolved to a person; '' for owner-authored items.
        -- Cross-file reference (people live in identity.sqlite) — no
        -- SQL FK across SQLCipher files. See IDENTITY_HUB_REDESIGN §3.5.
        author_person_id TEXT NOT NULL DEFAULT '',
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(type);
      CREATE INDEX IF NOT EXISTS idx_vault_items_timestamp ON vault_items(timestamp);
      CREATE INDEX IF NOT EXISTS idx_vault_items_deleted ON vault_items(deleted);
      CREATE INDEX IF NOT EXISTS idx_vault_items_sender ON vault_items(sender);
      CREATE INDEX IF NOT EXISTS idx_vault_items_retrieval ON vault_items(retrieval_policy);
      CREATE INDEX IF NOT EXISTS idx_vault_items_author
        ON vault_items(author_person_id) WHERE author_person_id != '';

      -- Canonical recall link: which people a vault item is *about*.
      -- The structured replacement for name/FTS-only recall — inbound
      -- D2D resolves sender DID → person_id → this table → the notes
      -- remembered about that person. person_id references the people
      -- graph in identity.sqlite (separate file — no SQL FK).
      -- See IDENTITY_HUB_REDESIGN §3.6.
      CREATE TABLE IF NOT EXISTS vault_item_subjects (
        item_id    TEXT NOT NULL,
        person_id  TEXT NOT NULL,
        relation   TEXT NOT NULL DEFAULT 'about',
        confidence TEXT NOT NULL DEFAULT 'medium',
        source     TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, person_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_vault_item_subjects_person
        ON vault_item_subjects(person_id);

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
  {
    // People-graph companion: index on `vault_items.contact_did` so
    // person-keyed enrichment queries ("facts about Sancho") are
    // O(log n). The reminder planner runs this lookup on every D2D
    // arrival; without an index it's a full vault scan.
    //
    // Composite (contact_did, deleted, timestamp DESC) covers the
    // canonical query: WHERE contact_did = ? AND deleted = 0
    // ORDER BY timestamp DESC. SQLite picks it for the WHERE clause
    // and the ordering term in one step.
    version: 2,
    name: 'vault_contact_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_vault_items_contact_did
        ON vault_items(contact_did, deleted, timestamp DESC)
        WHERE contact_did != ''
    `,
  },
  {
    // Guided-demo data scope (docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md).
    // Adds `data_scope` to the persona vault tables the demo writes. The FTS5
    // triggers reference specific columns only, so adding a column to
    // vault_items doesn't touch them. ALTER (not editing v1) — applied
    // migrations are immutable.
    version: 3,
    name: 'data_scope_persona',
    sql: `
      ALTER TABLE vault_items ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE vault_item_subjects ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'user';

      CREATE INDEX IF NOT EXISTS idx_vault_items_scope ON vault_items(data_scope);
      CREATE INDEX IF NOT EXISTS idx_vault_item_subjects_scope ON vault_item_subjects(data_scope);
    `,
  },
];
