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
