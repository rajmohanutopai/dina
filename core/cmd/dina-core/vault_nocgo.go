//go:build !cgo

package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/taskqueue"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/domain"
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

// newStagingInbox returns an in-memory staging inbox (no CGO — dev/test only).
func newStagingInbox(
	_ vaultBackend,
	isPersonaOpen func(string) bool,
	storeToVault func(ctx context.Context, persona string, item domain.VaultItem) (string, error),
) port.StagingInbox {
	return vault.NewStagingInbox(isPersonaOpen, storeToVault)
}

// newPendingReasonStore returns nil in no-CGO mode (async approval disabled).
func newPendingReasonStore(_ vaultBackend) port.PendingReasonStore {
	return nil
}

// newContactDirectory returns an in-memory contact directory (no CGO — dev/test only).
func newContactDirectory(_ vaultBackend) contactDirectoryFull {
	return identity.NewContactDirectory()
}

// newReminderScheduler returns an in-memory reminder scheduler (no CGO — dev/test only).
func newReminderScheduler(_ vaultBackend) port.ReminderScheduler {
	return taskqueue.NewReminderScheduler()
}

// newTraceStore returns nil in no-CGO mode (tracing disabled).
func newTraceStore(_ vaultBackend) port.TraceStore {
	return nil
}

// newScenarioPolicyManager returns nil in no-CGO mode (scenario policies disabled).
func newScenarioPolicyManager(_ vaultBackend) port.ScenarioPolicyManager {
	return nil
}

// newD2DOutboxManager returns the in-memory outbox manager in no-CGO mode.
func newD2DOutboxManager(_ vaultBackend) port.OutboxManager {
	return transport.NewOutboxManager(100)
}

// newDelegatedTaskStore returns nil in no-CGO mode.
func newDelegatedTaskStore(_ vaultBackend) port.DelegatedTaskStore {
	return nil
}

// readAdminKV is a no-op in no-CGO mode (in-memory vault has no persistence).
func readAdminKV(_ vaultBackend, _ string) string {
	return ""
}
