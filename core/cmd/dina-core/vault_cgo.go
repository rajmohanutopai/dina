//go:build cgo

package main

import (
	"github.com/anthropics/dina/core/internal/adapter/sqlite"
	"github.com/anthropics/dina/core/internal/port"
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
