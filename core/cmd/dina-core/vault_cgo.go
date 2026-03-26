//go:build cgo

package main

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// newVaultBackend returns a SQLCipher-backed vault adapter when CGO is available.
// This provides encrypted-at-rest storage with FTS5 full-text search.
func newVaultBackend(dir string) vaultBackend {
	return sqlite.NewVaultAdapter(dir)
}

// newBackupMgr returns a backup manager for the SQLCipher vault.
func newBackupMgr(_ vaultBackend) port.BackupManager {
	return &sqliteBackupStub{}
}

// newAuditLogger returns a SQLite-backed audit logger using the identity database.
func newAuditLogger(backend vaultBackend) port.VaultAuditLogger {
	return sqlite.NewSQLiteAuditLogger(backend.(*sqlite.VaultAdapter).Pool())
}

// newStagingInbox returns a durable SQLite-backed staging inbox using identity.sqlite.
func newStagingInbox(
	backend vaultBackend,
	isPersonaOpen func(string) bool,
	storeToVault func(ctx context.Context, persona string, item domain.VaultItem) (string, error),
) port.StagingInbox {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewStagingInbox(pool, isPersonaOpen, storeToVault)
}

// newPendingReasonStore returns a SQLite-backed pending reason store using identity.sqlite.
func newPendingReasonStore(backend vaultBackend) port.PendingReasonStore {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewPendingReasonStore(pool)
}

// newContactDirectory returns a SQLite-backed contact directory using identity.sqlite.
func newContactDirectory(backend vaultBackend) contactDirectoryFull {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewSQLiteContactDirectory(pool)
}

// newReminderScheduler returns a SQLite-backed reminder scheduler using identity.sqlite.
func newReminderScheduler(backend vaultBackend) port.ReminderScheduler {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewSQLiteReminderScheduler(pool)
}

// newTraceStore returns a SQLite-backed trace store using identity.sqlite.
func newTraceStore(backend vaultBackend) port.TraceStore {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewTraceStore(pool.DB("identity"))
}

// newScenarioPolicyManager returns a SQLite-backed scenario policy manager.
func newScenarioPolicyManager(backend vaultBackend) port.ScenarioPolicyManager {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewScenarioPolicyManager(pool)
}

// newD2DOutboxManager returns a SQLite-backed D2D outbox manager.
func newD2DOutboxManager(backend vaultBackend) port.OutboxManager {
	pool := backend.(*sqlite.VaultAdapter).Pool()
	return sqlite.NewD2DOutboxManager(pool)
}

// readAdminKV reads an admin config value from the general persona's KV store.
// Keys are stored as "kv:admin:<key>" in the vault_items table.
// Returns "" if the key is not found or the general persona is not open.
func readAdminKV(backend vaultBackend, key string) string {
	va, ok := backend.(*sqlite.VaultAdapter)
	if !ok {
		return ""
	}
	db := va.Pool().DB("general")
	if db == nil {
		return ""
	}
	var body string
	err := db.QueryRow(
		"SELECT body FROM vault_items WHERE id = ? AND deleted = 0",
		"kv:admin:"+key,
	).Scan(&body)
	if err != nil {
		return ""
	}
	return body
}
