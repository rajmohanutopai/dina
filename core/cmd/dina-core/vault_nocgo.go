//go:build !cgo

package main

import (
	"log/slog"

	"github.com/anthropics/dina/core/internal/adapter/vault"
	"github.com/anthropics/dina/core/internal/port"
)

// newVaultBackend returns an in-memory vault when CGO is unavailable.
// This is a development/testing fallback — no encryption at rest.
func newVaultBackend(dir string) vaultBackend {
	slog.Warn("CGO disabled — using in-memory vault (no encryption at rest)")
	return vault.NewManager(dir)
}

// newBackupMgr returns a backup manager backed by the in-memory vault.
func newBackupMgr(v vaultBackend) port.BackupManager {
	return vault.NewBackupManager(v.(*vault.Manager))
}
