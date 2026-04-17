//go:build cgo

// Package sqlite provides SQLCipher-encrypted database access for dina-core.
//
// Each persona has its own SQLCipher database file, keyed with a per-persona
// DEK derived from the master seed. The identity database uses its own DEK.
//
// Usage:
//
//	pool := sqlite.NewPool("/data/vault")
//	err := pool.Open("general", dek)  // opens personal.sqlite with DEK
//	db := pool.DB("general")          // returns *sql.DB
//	pool.Close("general")             // zeroes DEK, closes connection
package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	_ "github.com/mutecomm/go-sqlcipher/v4"
)

//go:embed schema/identity_001.sql
var identitySchema string

//go:embed schema/persona_001.sql
var personaSchema string

// Pool manages a set of SQLCipher database connections, one per persona.
type Pool struct {
	mu   sync.RWMutex
	dir  string
	dbs  map[string]*sql.DB
	deks map[string][]byte // personaID -> DEK (zeroed on close)
}

// NewPool returns a new connection pool rooted at dir.
func NewPool(dir string) *Pool {
	return &Pool{
		dir:  dir,
		dbs:  make(map[string]*sql.DB),
		deks: make(map[string][]byte),
	}
}

// Open opens (or creates) a SQLCipher database for the given persona.
// The DEK is used as the PRAGMA key. Schema is applied on first open.
func (p *Pool) Open(persona string, dek []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if _, ok := p.dbs[persona]; ok {
		return nil // already open
	}

	dbPath := filepath.Join(p.dir, persona+".sqlite")
	keyHex := hex.EncodeToString(dek)

	// SQLCipher DSN: pragma_key via URI parameter.
	dsn := fmt.Sprintf("file:%s?_pragma_key=x'%s'&_pragma_cipher_page_size=4096&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL",
		dbPath, keyHex)

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return fmt.Errorf("sqlite: open %q: %w", persona, err)
	}

	// Verify we can actually query (catches wrong-key errors).
	if err := db.PingContext(context.Background()); err != nil {
		db.Close()
		return fmt.Errorf("sqlite: ping %q: %w", persona, err)
	}

	// Apply schema. identity gets identity schema, everything else gets persona schema.
	schema := personaSchema
	if persona == "identity" {
		schema = identitySchema
	}
	if _, err := db.ExecContext(context.Background(), schema); err != nil {
		db.Close()
		return fmt.Errorf("sqlite: schema %q: %w", persona, err)
	}

	// Run migrations for existing databases.
	if persona == "identity" {
		if err := migrateIdentity(db); err != nil {
			db.Close()
			return fmt.Errorf("sqlite: migrate identity: %w", err)
		}
	} else {
		if err := migratePersona(db, persona); err != nil {
			db.Close()
			return fmt.Errorf("sqlite: migrate %q: %w", persona, err)
		}
	}

	// Store DEK copy for potential re-key operations.
	dekCopy := make([]byte, len(dek))
	copy(dekCopy, dek)

	p.dbs[persona] = db
	p.deks[persona] = dekCopy
	return nil
}

// DB returns the *sql.DB for a persona. Returns nil if not open.
func (p *Pool) DB(persona string) *sql.DB {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.dbs[persona]
}

// IsOpen reports whether a persona database is currently open.
func (p *Pool) IsOpen(persona string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.dbs[persona]
	return ok
}

// Close closes the database for a persona and zeroes the DEK from memory.
func (p *Pool) Close(persona string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	db, ok := p.dbs[persona]
	if !ok {
		return nil
	}

	err := db.Close()

	// Zero the DEK.
	if dek, ok := p.deks[persona]; ok {
		for i := range dek {
			dek[i] = 0
		}
		delete(p.deks, persona)
	}

	delete(p.dbs, persona)
	return err
}

// CloseAll closes all open databases and zeroes all DEKs.
func (p *Pool) CloseAll() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	var firstErr error
	for persona, db := range p.dbs {
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		if dek, ok := p.deks[persona]; ok {
			for i := range dek {
				dek[i] = 0
			}
		}
	}

	p.dbs = make(map[string]*sql.DB)
	p.deks = make(map[string][]byte)
	return firstErr
}

// Checkpoint forces a WAL checkpoint (TRUNCATE mode) so that all committed
// data is written into the main database file. This ensures os.ReadFile on
// the .sqlite file returns complete data, which is critical before export.
// Returns nil if the persona is not currently open (nothing to checkpoint).
func (p *Pool) Checkpoint(persona string) error {
	p.mu.RLock()
	defer p.mu.RUnlock()

	db, ok := p.dbs[persona]
	if !ok {
		return nil // not open — nothing to checkpoint
	}
	_, err := db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil {
		return fmt.Errorf("sqlite: checkpoint %q: %w", persona, err)
	}
	return nil
}

// OpenPersonas returns the list of currently open persona names.
func (p *Pool) OpenPersonas() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()

	names := make([]string, 0, len(p.dbs))
	for name := range p.dbs {
		names = append(names, name)
	}
	return names
}

// migratePersona applies incremental migrations to an existing persona database.
// Each migration checks its precondition before running, making them idempotent.
func migratePersona(db *sql.DB, persona string) error {
	ctx := context.Background()

	// --- Migration v2: add contact_did column + rebuild FTS5 ---
	// Check if contact_did column already exists.
	if !hasColumn(db, "vault_items", "contact_did") {
		slog.Info("sqlite: applying migration v2 (contact_did)", "persona", persona)

		// Add the column with a default empty string.
		if _, err := db.ExecContext(ctx,
			`ALTER TABLE vault_items ADD COLUMN contact_did TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("v2: add contact_did column: %w", err)
		}

		// Drop old FTS5 table and triggers, then recreate with contact_did.
		stmts := []string{
			`DROP TRIGGER IF EXISTS vault_items_ai`,
			`DROP TRIGGER IF EXISTS vault_items_ad`,
			`DROP TRIGGER IF EXISTS vault_items_au`,
			`DROP TABLE IF EXISTS vault_items_fts`,
			`CREATE VIRTUAL TABLE vault_items_fts USING fts5(
				summary, body, tags, contact_did,
				content='vault_items', content_rowid='rowid',
				tokenize='unicode61 remove_diacritics 2')`,
			// Rebuild FTS5 content from existing rows.
			`INSERT INTO vault_items_fts(vault_items_fts) VALUES('rebuild')`,
			// Recreate triggers.
			`CREATE TRIGGER vault_items_ai AFTER INSERT ON vault_items BEGIN
				INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did)
				VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did);
			END`,
			`CREATE TRIGGER vault_items_ad AFTER DELETE ON vault_items BEGIN
				INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did)
				VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did);
			END`,
			`CREATE TRIGGER vault_items_au AFTER UPDATE ON vault_items BEGIN
				INSERT INTO vault_items_fts(vault_items_fts, rowid, summary, body, tags, contact_did)
				VALUES ('delete', old.rowid, old.summary, old.body, old.tags, old.contact_did);
				INSERT INTO vault_items_fts(rowid, summary, body, tags, contact_did)
				VALUES (new.rowid, new.summary, new.body, new.tags, new.contact_did);
			END`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("v2: rebuild FTS5: %w", err)
			}
		}

		// Record migration.
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (2, 'Add contact_did to vault_items and FTS5')`)

		slog.Info("sqlite: migration v2 complete", "persona", persona)
	}

	// --- Migration v3: source trust & provenance columns ---
	if !hasColumn(db, "vault_items", "sender") {
		slog.Info("sqlite: applying migration v3 (source trust)", "persona", persona)

		stmts := []string{
			`ALTER TABLE vault_items ADD COLUMN sender TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN sender_trust TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN source_type TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN confidence TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN retrieval_policy TEXT NOT NULL DEFAULT 'normal'`,
			`ALTER TABLE vault_items ADD COLUMN contradicts TEXT NOT NULL DEFAULT ''`,
			`CREATE INDEX IF NOT EXISTS idx_vault_items_retrieval_policy ON vault_items(retrieval_policy)`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("v3: source trust: %w", err)
			}
		}
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (3, 'Add source trust and provenance columns')`)

		slog.Info("sqlite: migration v3 complete", "persona", persona)
	}

	// --- Migration v4: tiered content L0/L1/L2 + enrichment tracking ---
	if !hasColumn(db, "vault_items", "content_l0") {
		slog.Info("sqlite: applying migration v4 (tiered content)", "persona", persona)

		stmts := []string{
			`ALTER TABLE vault_items ADD COLUMN content_l0 TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN content_l1 TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE vault_items ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending'`,
			`ALTER TABLE vault_items ADD COLUMN enrichment_version TEXT NOT NULL DEFAULT ''`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("v4: tiered content: %w", err)
			}
		}
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (4, 'Add tiered content L0/L1 and enrichment tracking')`)

		slog.Info("sqlite: migration v4 complete", "persona", persona)
	}

	return nil
}

// migrateIdentity applies incremental migrations to identity.sqlite.
// Each migration checks its precondition before running, making them idempotent.
func migrateIdentity(db *sql.DB) error {
	ctx := context.Background()

	// Ensure schema_version table exists (added in identity_001.sql update).
	db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
		description TEXT NOT NULL DEFAULT ''
	)`)

	// --- Identity migration v2: contact provenance + reminder lineage ---
	if !hasColumn(db, "contacts", "source") {
		slog.Info("sqlite: applying identity migration v2 (contact provenance + reminder lineage)")

		stmts := []string{
			// Contact provenance
			`ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE contacts ADD COLUMN source_confidence TEXT NOT NULL DEFAULT 'high'`,
			`ALTER TABLE contacts ADD COLUMN last_contact INTEGER NOT NULL DEFAULT 0`,
			// Reminder lineage
			`ALTER TABLE reminders ADD COLUMN source_item_id TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE reminders ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE reminders ADD COLUMN persona TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE reminders ADD COLUMN timezone TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE reminders ADD COLUMN kind TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE reminders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				if !isAlterColumnExists(err) {
					return fmt.Errorf("identity v2: %w", err)
				}
			}
		}
		// Dedup index for reminders: same source item + kind + time + persona = one reminder.
		db.ExecContext(ctx,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_dedup ON reminders(source_item_id, kind, due_at, persona)`)

		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (2, 'Contact provenance and reminder lineage')`)

		slog.Info("sqlite: identity migration v2 complete")
	}

	// --- Identity migration v3: pending_reason table ---
	if !hasTable(db, "pending_reason") {
		slog.Info("sqlite: applying identity migration v3 (pending_reason table)")

		_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS pending_reason (
			request_id    TEXT PRIMARY KEY,
			caller_did    TEXT NOT NULL,
			session_name  TEXT DEFAULT '',
			approval_id   TEXT NOT NULL,
			status        TEXT NOT NULL DEFAULT 'pending_approval',
			request_meta  TEXT NOT NULL DEFAULT '{}',
			result        TEXT DEFAULT '',
			error         TEXT DEFAULT '',
			created_at    INTEGER NOT NULL,
			updated_at    INTEGER NOT NULL,
			expires_at    INTEGER NOT NULL
		)`)
		if err != nil {
			return fmt.Errorf("identity v3: create pending_reason: %w", err)
		}
		db.ExecContext(ctx,
			`CREATE INDEX IF NOT EXISTS idx_pending_reason_approval ON pending_reason(approval_id)`)
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (3, 'Pending reason table for async approval-wait-resume')`)

		slog.Info("sqlite: identity migration v3 complete")
	}

	// --- Identity migration v5: request trace table ---
	if !hasTable(db, "request_trace") {
		slog.Info("sqlite: applying identity migration v5 (request_trace table)")

		_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS request_trace (
			id        INTEGER PRIMARY KEY AUTOINCREMENT,
			req_id    TEXT NOT NULL,
			ts_ms     INTEGER NOT NULL,
			step      TEXT NOT NULL,
			component TEXT NOT NULL,
			detail    TEXT NOT NULL DEFAULT '{}'
		)`)
		if err != nil {
			return fmt.Errorf("identity v5: create request_trace: %w", err)
		}
		db.ExecContext(ctx,
			`CREATE INDEX IF NOT EXISTS idx_request_trace_req_id ON request_trace(req_id)`)
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (5, 'Request trace table for cross-service debugging')`)

		slog.Info("sqlite: identity migration v5 complete")
	}

	// --- Identity migration v6: scenario_policies, d2d_outbox, contacts.sharing_rules ---
	if !hasTable(db, "scenario_policies") {
		slog.Info("sqlite: applying identity migration v6 (D2D v1 scenario policies + outbox)")

		stmts := []string{
			// Per-contact, per-scenario send/receive policy.
			`CREATE TABLE IF NOT EXISTS scenario_policies (
				contact_did TEXT NOT NULL,
				scenario    TEXT NOT NULL,
				tier        TEXT NOT NULL DEFAULT 'deny_by_default'
					CHECK (tier IN ('standing_policy','explicit_once','deny_by_default')),
				updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				PRIMARY KEY (contact_did, scenario)
			)`,
			// Durable outbox for D2D v1 messages.
			`CREATE TABLE IF NOT EXISTS d2d_outbox (
				id          TEXT PRIMARY KEY,
				to_did      TEXT NOT NULL,
				msg_type    TEXT NOT NULL,
				payload     BLOB NOT NULL,
				sig         BLOB NOT NULL DEFAULT '',
				status      TEXT NOT NULL DEFAULT 'pending'
					CHECK (status IN ('pending','pending_approval','sending','delivered','failed')),
				approval_id TEXT NOT NULL DEFAULT '',
				priority    INTEGER NOT NULL DEFAULT 5,
				retries     INTEGER NOT NULL DEFAULT 0,
				next_retry  INTEGER NOT NULL DEFAULT 0,
				created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			)`,
			`CREATE INDEX IF NOT EXISTS idx_d2d_outbox_status ON d2d_outbox(status, next_retry)`,
			`CREATE INDEX IF NOT EXISTS idx_d2d_outbox_to_did ON d2d_outbox(to_did)`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("identity v6: %w", err)
			}
		}

		// Add sharing_rules column to contacts if missing.
		// (contacts table is created by identity_001.sql which predates this column)
		if !hasColumn(db, "contacts", "sharing_rules") {
			if _, err := db.ExecContext(ctx,
				`ALTER TABLE contacts ADD COLUMN sharing_rules TEXT NOT NULL DEFAULT '{}'`); err != nil {
				if !isAlterColumnExists(err) {
					return fmt.Errorf("identity v6: add sharing_rules: %w", err)
				}
			}
		}

		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (6, 'D2D v1: scenario_policies, d2d_outbox, contacts.sharing_rules')`)

		slog.Info("sqlite: identity migration v6 complete")
	}

	// --- Identity migration v4: staging provenance columns ---
	if !hasColumn(db, "staging_inbox", "ingress_channel") {
		slog.Info("sqlite: applying identity migration v4 (staging provenance)")

		for _, col := range []string{
			`ALTER TABLE staging_inbox ADD COLUMN ingress_channel TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE staging_inbox ADD COLUMN origin_did TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE staging_inbox ADD COLUMN origin_kind TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE staging_inbox ADD COLUMN producer_id TEXT NOT NULL DEFAULT ''`,
		} {
			if _, err := db.ExecContext(ctx, col); err != nil {
				// Column may already exist — ignore "duplicate column" errors.
				if !isAlterColumnExists(err) {
					return fmt.Errorf("identity v4: %w", err)
				}
			}
		}

		// Backfill producer_id from connector_id for existing items.
		db.ExecContext(ctx,
			`UPDATE staging_inbox SET ingress_channel='connector', producer_id='connector:'||connector_id WHERE producer_id='' AND connector_id!=''`)

		// Drop old dedup index and create new one.
		db.ExecContext(ctx, `DROP INDEX IF EXISTS idx_staging_inbox_dedup`)
		db.ExecContext(ctx,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_inbox_dedup ON staging_inbox(producer_id, source, source_id)`)

		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (4, 'Staging provenance columns + dedup by producer_id')`)

		slog.Info("sqlite: identity migration v4 complete")
	}

	// --- Identity migration v7: delegated_tasks (agent task queue) ---
	if !hasTable(db, "delegated_tasks") {
		slog.Info("sqlite: applying identity migration v7 (delegated_tasks)")

		_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS delegated_tasks (
			id               TEXT PRIMARY KEY,
			proposal_id      TEXT NOT NULL DEFAULT '',
			session_name     TEXT NOT NULL DEFAULT '',
			description      TEXT NOT NULL,
			origin           TEXT NOT NULL DEFAULT 'telegram'
				CHECK (origin IN ('telegram','admin','cli','api')),
			status           TEXT NOT NULL DEFAULT 'created'
				CHECK (status IN ('created','pending_approval','queued','claimed',
				                  'running','completed','failed','cancelled','expired')),
			agent_did        TEXT NOT NULL DEFAULT '',
			lease_expires_at INTEGER NOT NULL DEFAULT 0,
			run_id           TEXT NOT NULL DEFAULT '',
			idempotency_key  TEXT NOT NULL DEFAULT '',
			result_summary   TEXT NOT NULL DEFAULT '',
			progress_note    TEXT NOT NULL DEFAULT '',
			error            TEXT NOT NULL DEFAULT '',
			created_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
			updated_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
		) WITHOUT ROWID`)
		if err != nil {
			return fmt.Errorf("identity v7: create delegated_tasks: %w", err)
		}

		db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_dt_status ON delegated_tasks(status, created_at)`)
		db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_dt_proposal ON delegated_tasks(proposal_id)`)
		db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_dt_lease ON delegated_tasks(lease_expires_at)
			WHERE status IN ('claimed','running')`)

		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (7, 'Delegated task queue for agent delegation')`)

		slog.Info("sqlite: identity migration v7 complete")
	}

	// --- Identity migration v8: contact relationship + data responsibility ---
	// Per-column guards so a partial crash leaves the schema repairable on next start.
	v8Applied := false
	if !hasColumn(db, "contacts", "relationship") {
		if _, err := db.ExecContext(ctx, `ALTER TABLE contacts ADD COLUMN relationship TEXT NOT NULL DEFAULT 'unknown'`); err != nil {
			if !isAlterColumnExists(err) {
				return fmt.Errorf("identity v8: add relationship: %w", err)
			}
		}
		v8Applied = true
	}
	if !hasColumn(db, "contacts", "data_responsibility") {
		if _, err := db.ExecContext(ctx, `ALTER TABLE contacts ADD COLUMN data_responsibility TEXT NOT NULL DEFAULT 'external'`); err != nil {
			if !isAlterColumnExists(err) {
				return fmt.Errorf("identity v8: add data_responsibility: %w", err)
			}
		}
		v8Applied = true
	}
	if !hasColumn(db, "contacts", "responsibility_explicit") {
		if _, err := db.ExecContext(ctx, `ALTER TABLE contacts ADD COLUMN responsibility_explicit INTEGER NOT NULL DEFAULT 0`); err != nil {
			if !isAlterColumnExists(err) {
				return fmt.Errorf("identity v8: add responsibility_explicit: %w", err)
			}
		}
		v8Applied = true
	}
	if v8Applied {
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (8, 'Contact relationship and data responsibility')`)
		slog.Info("sqlite: identity migration v8 complete")
	} else if hasColumn(db, "contacts", "relationship") &&
		hasColumn(db, "contacts", "data_responsibility") &&
		hasColumn(db, "contacts", "responsibility_explicit") {
		// Repair: all columns exist but version row may be missing (crash after ALTERs, before INSERT).
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (8, 'Contact relationship and data responsibility')`)
	}

	// --- Identity migration v9: contact_aliases table ---
	if !hasTable(db, "contact_aliases") {
		slog.Info("sqlite: applying identity migration v9 (contact_aliases)")
		_, err := db.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS contact_aliases (
				contact_did      TEXT NOT NULL,
				alias            TEXT NOT NULL,
				normalized_alias TEXT NOT NULL,
				source           TEXT NOT NULL DEFAULT 'manual',
				created_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				PRIMARY KEY (contact_did, normalized_alias)
			) WITHOUT ROWID`)
		if err != nil {
			return fmt.Errorf("identity v9: create contact_aliases: %w", err)
		}
		db.ExecContext(ctx,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_normalized ON contact_aliases(normalized_alias)`)
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (9, 'Contact aliases table')`)
		slog.Info("sqlite: identity migration v9 complete")
	}

	// --- Identity migration v11: delegated task runner fields ---
	if !hasColumn(db, "delegated_tasks", "requested_runner") {
		slog.Info("sqlite: applying identity migration v11 (task runner fields)")
		for _, stmt := range []string{
			`ALTER TABLE delegated_tasks ADD COLUMN requested_runner TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE delegated_tasks ADD COLUMN assigned_runner TEXT NOT NULL DEFAULT ''`,
		} {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				if !isAlterColumnExists(err) {
					return fmt.Errorf("identity v11: %w", err)
				}
			}
		}
		// Repair: if assigned_runner exists but version row missing.
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (11, 'Delegated task runner fields')`)
		slog.Info("sqlite: identity migration v11 complete")
	} else if hasColumn(db, "delegated_tasks", "assigned_runner") {
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (11, 'Delegated task runner fields')`)
	}

	// --- Identity migration v10: people + person_surfaces tables ---
	if !hasTable(db, "people") {
		slog.Info("sqlite: applying identity migration v10 (person memory)")
		stmts := []string{
			`CREATE TABLE IF NOT EXISTS people (
				person_id         TEXT PRIMARY KEY,
				canonical_name    TEXT DEFAULT '',
				contact_did       TEXT DEFAULT '',
				relationship_hint TEXT DEFAULT '',
				status            TEXT NOT NULL DEFAULT 'suggested',
				created_from      TEXT NOT NULL DEFAULT 'llm',
				created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			) WITHOUT ROWID`,
			`CREATE TABLE IF NOT EXISTS person_surfaces (
				id                  INTEGER PRIMARY KEY AUTOINCREMENT,
				person_id           TEXT NOT NULL,
				surface             TEXT NOT NULL,
				normalized_surface  TEXT NOT NULL,
				surface_type        TEXT NOT NULL DEFAULT 'name',
				status              TEXT NOT NULL DEFAULT 'suggested',
				confidence          TEXT NOT NULL DEFAULT 'medium',
				source_item_id      TEXT DEFAULT '',
				source_excerpt      TEXT DEFAULT '',
				extractor_version   TEXT NOT NULL DEFAULT '',
				created_from        TEXT NOT NULL DEFAULT 'llm',
				created_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			)`,
			`CREATE INDEX IF NOT EXISTS idx_person_surface_normalized ON person_surfaces(normalized_surface)`,
			`CREATE INDEX IF NOT EXISTS idx_person_surface_person ON person_surfaces(person_id, normalized_surface)`,
			`CREATE INDEX IF NOT EXISTS idx_person_surface_source ON person_surfaces(source_item_id)`,
			`CREATE TABLE IF NOT EXISTS person_extraction_log (
				source_item_id    TEXT NOT NULL,
				extractor_version TEXT NOT NULL,
				fingerprint       TEXT NOT NULL,
				applied_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				PRIMARY KEY (source_item_id, extractor_version, fingerprint)
			) WITHOUT ROWID`,
		}
		for _, stmt := range stmts {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("identity v10: %w", err)
			}
		}
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (10, 'Person memory layer')`)
		slog.Info("sqlite: identity migration v10 complete")
	}

	// --- Identity migration v12: service_config table ---
	if !hasTable(db, "service_config") {
		slog.Info("sqlite: applying identity migration v12 (service_config table)")
		if _, err := db.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS service_config (
				key         TEXT PRIMARY KEY,
				value       TEXT NOT NULL,
				updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			)
		`); err != nil {
			return fmt.Errorf("identity v12: %w", err)
		}
		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (12, 'Service config table')`)
		slog.Info("sqlite: identity migration v12 complete")
	}

	// --- Identity migration v13: workflow_tasks replaces delegated_tasks ---
	if !hasTable(db, "workflow_tasks") {
		slog.Info("sqlite: applying identity migration v13 (workflow_tasks + workflow_events)")

		// Migrate delegated_tasks → workflow_tasks if the old table exists.
		if hasTable(db, "delegated_tasks") {
			slog.Info("sqlite: migrating delegated_tasks to workflow_tasks")
			// Create workflow_tasks first (below), then migrate rows, then drop.
			defer func() {
				// Migrate existing delegated tasks as kind=delegation.
				_, migErr := db.ExecContext(ctx, `
					INSERT OR IGNORE INTO workflow_tasks
						(id, kind, state, priority, description, payload, result_summary,
						 error, requested_runner, assigned_runner, agent_did, run_id,
						 progress_note, lease_expires_at, origin, session_name,
						 created_at, updated_at)
					SELECT
						id, 'delegation', status, 'normal', description, payload, result_summary,
						error, requested_runner, assigned_runner, agent_did, run_id,
						progress_note, lease_expires_at, origin, session_name,
						created_at, updated_at
					FROM delegated_tasks
				`)
				if migErr != nil {
					slog.Warn("sqlite: delegated_tasks migration failed (non-fatal)", "error", migErr)
				} else {
					db.ExecContext(ctx, `DROP TABLE IF EXISTS delegated_tasks`)
					slog.Info("sqlite: delegated_tasks migrated and dropped")
				}
			}()
		}

		for _, stmt := range []string{
			`CREATE TABLE IF NOT EXISTS workflow_tasks (
				id               TEXT PRIMARY KEY,
				kind             TEXT NOT NULL,
				state            TEXT NOT NULL DEFAULT 'created'
					CHECK (state IN ('created','pending','queued','claimed','running','awaiting',
									 'pending_approval','scheduled','completed','failed','cancelled','recorded')),
				correlation_id   TEXT,
				parent_id        TEXT,
				proposal_id      TEXT,
				priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('user_blocking','normal','background')),
				description      TEXT NOT NULL DEFAULT '',
				payload          TEXT NOT NULL DEFAULT '{}',
				payload_type     TEXT NOT NULL DEFAULT '',
				result           TEXT,
				result_summary   TEXT NOT NULL DEFAULT '',
				policy           TEXT NOT NULL DEFAULT '{}',
				error            TEXT NOT NULL DEFAULT '',
				requested_runner TEXT NOT NULL DEFAULT '',
				assigned_runner  TEXT NOT NULL DEFAULT '',
				agent_did        TEXT NOT NULL DEFAULT '',
				run_id           TEXT NOT NULL DEFAULT '',
				progress_note    TEXT NOT NULL DEFAULT '',
				lease_expires_at INTEGER,
				origin           TEXT NOT NULL DEFAULT '' CHECK (origin IN ('','telegram','api','d2d','admin','system','cli')),
				session_name     TEXT NOT NULL DEFAULT '',
				idempotency_key  TEXT,
				expires_at       INTEGER,
				next_run_at      INTEGER,
				recurrence       TEXT,
				internal_stash   TEXT,
				created_at       INTEGER NOT NULL,
				updated_at       INTEGER NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_state ON workflow_tasks(state, next_run_at)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_kind ON workflow_tasks(kind)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_payload_type ON workflow_tasks(payload_type) WHERE payload_type != ''`,
			`CREATE INDEX IF NOT EXISTS idx_wf_correlation ON workflow_tasks(correlation_id)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_proposal ON workflow_tasks(proposal_id) WHERE proposal_id IS NOT NULL`,
			`CREATE INDEX IF NOT EXISTS idx_wf_expires ON workflow_tasks(expires_at) WHERE expires_at IS NOT NULL`,
			`CREATE INDEX IF NOT EXISTS idx_wf_lease ON workflow_tasks(lease_expires_at) WHERE lease_expires_at IS NOT NULL`,
			`CREATE INDEX IF NOT EXISTS idx_wf_agent ON workflow_tasks(agent_did) WHERE agent_did != ''`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_idem_active ON workflow_tasks(idempotency_key)
				WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
				AND state NOT IN ('completed','failed','cancelled','recorded')`,
			`CREATE TABLE IF NOT EXISTS workflow_events (
				event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id           TEXT NOT NULL REFERENCES workflow_tasks(id),
				at                INTEGER NOT NULL,
				event_kind        TEXT NOT NULL,
				needs_delivery    INTEGER NOT NULL DEFAULT 0,
				delivery_attempts INTEGER NOT NULL DEFAULT 0,
				next_delivery_at  INTEGER,
				delivering_until  INTEGER,
				delivered_at      INTEGER,
				acknowledged_at   INTEGER,
				delivery_failed   INTEGER NOT NULL DEFAULT 0,
				details           TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_events_task ON workflow_events(task_id)`,
			`CREATE INDEX IF NOT EXISTS idx_wf_events_deliverable ON workflow_events(next_delivery_at)
				WHERE needs_delivery = 1 AND acknowledged_at IS NULL AND delivery_failed = 0 AND delivery_attempts < 3`,
		} {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("identity v13: %w", err)
			}
		}

		// Enable foreign keys for this connection (required for workflow_events FK).
		db.ExecContext(ctx, `PRAGMA foreign_keys = ON`)

		db.ExecContext(ctx,
			`INSERT OR IGNORE INTO schema_version(version, description) VALUES (13, 'Workflow tasks replace delegated tasks')`)
		slog.Info("sqlite: identity migration v13 complete")
	}

	// --- Identity migration v14: workflow_tasks.payload_type column ---
	// Lets the response-bridge reconciler find service_query_execution tasks
	// via an indexed column lookup instead of a fragile LIKE over payload
	// JSON that breaks on Python/Go serialiser spacing differences.
	if hasTable(db, "workflow_tasks") && !hasColumn(db, "workflow_tasks", "payload_type") {
		slog.Info("sqlite: applying identity migration v14 (workflow_tasks.payload_type)")
		for _, stmt := range []string{
			`ALTER TABLE workflow_tasks ADD COLUMN payload_type TEXT NOT NULL DEFAULT ''`,
			`CREATE INDEX IF NOT EXISTS idx_wf_payload_type ON workflow_tasks(payload_type) WHERE payload_type != ''`,
		} {
			if _, err := db.ExecContext(ctx, stmt); err != nil && !isAlterColumnExists(err) {
				return fmt.Errorf("identity v14: %w", err)
			}
		}
		slog.Info("sqlite: identity migration v14 complete")
	}

	return nil
}

// isAlterColumnExists checks if the error is a "duplicate column" error from ALTER TABLE.
func isAlterColumnExists(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "duplicate column") ||
		strings.Contains(err.Error(), "already exists"))
}

// hasTable checks whether a table exists in the database.
func hasTable(db *sql.DB, table string) bool {
	var name string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
	).Scan(&name)
	return err == nil && name == table
}

// validMigrationTables is the whitelist of tables that hasColumn may inspect.
// VT1: PRAGMA table_info() cannot be parameterised, so the table name is
// interpolated into SQL. Restricting to known tables prevents injection.
var validMigrationTables = map[string]bool{
	"vault_items":       true,
	"contacts":          true,
	"staging_inbox":     true,
	"reminders":         true,
	"audit_log":         true,
	"workflow_tasks":    true,
	"pending_reason":    true,
	"scenario_policies": true,
	"d2d_outbox":        true,
	"delegated_tasks":   true,
}

// hasColumn checks whether a table has a specific column.
func hasColumn(db *sql.DB, table, column string) bool {
	// VT1: Reject unknown table names to prevent SQL injection via PRAGMA.
	if !validMigrationTables[table] {
		return false
	}
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			continue
		}
		if strings.EqualFold(name, column) {
			return true
		}
	}
	return false
}
