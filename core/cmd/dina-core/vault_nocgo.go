//go:build !cgo

package main

import (
	"log/slog"
	"os"

	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// newVaultBackend returns an in-memory vault when CGO is unavailable.
// This is a development/testing fallback — no encryption at rest.
func newVaultBackend(dir string) vaultBackend {
	if os.Getenv("DINA_TEST_MODE") != "true" && os.Getenv("DINA_ALLOW_INSECURE_VAULT") != "1" {
		slog.Error("CGO disabled — SQLCipher encryption at rest is unavailable. " +
			"Set DINA_ALLOW_INSECURE_VAULT=1 to override (NOT recommended for production)")
		os.Exit(1)
	}
	slog.Warn("CGO disabled — using in-memory vault (no encryption at rest)")
	return vault.NewManager(dir)
}

// newBackupMgr returns a backup manager backed by the in-memory vault.
func newBackupMgr(v vaultBackend) port.BackupManager {
	return vault.NewBackupManager(v.(*vault.Manager))
}
