//go:build cgo

package main

import (
	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
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
