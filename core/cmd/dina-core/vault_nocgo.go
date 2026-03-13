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
	if os.Getenv("DINA_ALLOW_INSECURE_VAULT") != "1" {
		slog.Error("CGO disabled — SQLCipher encryption at rest is unavailable. " +
			"Set DINA_ALLOW_INSECURE_VAULT=1 to override (NOT recommended for production)")
		os.Exit(1)
	}
	// SEC-HIGH-09: Block insecure vault in production even with the flag.
	env := os.Getenv("DINA_ENV")
	if env != "test" && env != "migration" && env != "development" {
		slog.Error("DINA_ALLOW_INSECURE_VAULT is not permitted outside test/development/migration",
			"DINA_ENV", env)
		os.Exit(1)
	}
	slog.Warn("CGO disabled — using in-memory vault (no encryption at rest)", "env", env)
	return vault.NewManager(dir)
}

// newBackupMgr returns a backup manager backed by the in-memory vault.
func newBackupMgr(v vaultBackend) port.BackupManager {
	return vault.NewBackupManager(v.(*vault.Manager))
}

// newAuditLogger returns an in-memory audit logger when CGO is unavailable.
func newAuditLogger(_ vaultBackend) port.VaultAuditLogger {
	return vault.NewAuditLogger()
}
