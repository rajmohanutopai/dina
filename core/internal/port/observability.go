package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// HealthChecker provides liveness and readiness probes.
type HealthChecker interface {
	Liveness() error
	Readiness() error
	IsVaultHealthy() bool
}

// CrashLogger stores crash reports in the vault.
type CrashLogger interface {
	Store(ctx context.Context, entry domain.CrashEntry) error
	Query(ctx context.Context, since string) ([]domain.CrashEntry, error)
	Purge(ctx context.Context, retentionDays int) (int64, error)
}

// LogAuditor validates that log lines comply with the no-PII policy.
type LogAuditor interface {
	ParseLine(line string) (*domain.LogEntry, error)
	ContainsPII(line string) (bool, string, error)
	SanitizeCrash(traceback string) string
}

// SystemWatchdog performs periodic health checks and cleanup.
type SystemWatchdog interface {
	RunTick(ctx context.Context) (*domain.WatchdogReport, error)
	CheckDiskUsage() (int64, error)
	CheckBrainHealth(ctx context.Context) (bool, error)
}
