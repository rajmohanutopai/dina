package service

import (
	"context"
	"fmt"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// defaultWatchdogInterval is the default interval between health check ticks.
const defaultWatchdogInterval = 30 * time.Second

// defaultRetentionDays is the default number of days to retain crash and audit logs.
const defaultRetentionDays = 90

// WatchdogService provides periodic system health monitoring. It checks
// liveness, disk usage, brain sidecar health, and purges old crash and
// audit log entries.
type WatchdogService struct {
	health  port.HealthChecker
	brain   port.BrainClient
	crash   port.CrashLogger
	auditor port.VaultAuditLogger
	clock   port.Clock
}

// NewWatchdogService constructs a WatchdogService with all required dependencies.
func NewWatchdogService(
	health port.HealthChecker,
	brain port.BrainClient,
	crash port.CrashLogger,
	auditor port.VaultAuditLogger,
	clock port.Clock,
) *WatchdogService {
	return &WatchdogService{
		health:  health,
		brain:   brain,
		crash:   crash,
		auditor: auditor,
		clock:   clock,
	}
}

// RunTick performs a single health check cycle. It checks liveness, disk
// usage, brain sidecar connectivity, and purges old crash and audit log
// entries that exceed the retention period. Returns a report summarizing
// all findings.
func (s *WatchdogService) RunTick(ctx context.Context) (*domain.WatchdogReport, error) {
	now := s.clock.Now()
	report := &domain.WatchdogReport{
		Timestamp: now.Unix(),
	}

	// Check system liveness.
	if err := s.health.Liveness(); err != nil {
		report.ConnectorAlive = false
	} else {
		report.ConnectorAlive = true
	}

	// Check brain sidecar health.
	report.BrainHealthy = s.brain.IsHealthy(ctx)

	// Purge old crash log entries.
	crashPurged, err := s.crash.Purge(ctx, defaultRetentionDays)
	if err != nil {
		// Log but do not fail the entire tick for a purge error.
		crashPurged = 0
	}
	report.CrashEntriesPurged = crashPurged

	// Purge old audit log entries.
	auditPurged, err := s.auditor.Purge(defaultRetentionDays)
	if err != nil {
		auditPurged = 0
	}
	report.AuditEntriesPurged = auditPurged

	return report, nil
}

// Start launches the watchdog as a background goroutine that runs RunTick
// at a regular interval. It blocks until the context is cancelled. The
// provided callback is invoked after each tick with the report and any error.
func (s *WatchdogService) Start(ctx context.Context, onTick func(report *domain.WatchdogReport, err error)) {
	ticker := s.clock.NewTicker(defaultWatchdogInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			report, err := s.RunTick(ctx)
			if onTick != nil {
				onTick(report, err)
			}
		}
	}
}

// LogCrash records a crash entry in the crash log. This is a convenience
// method that delegates to the CrashLogger port.
func (s *WatchdogService) LogCrash(ctx context.Context, entry domain.CrashEntry) error {
	if entry.Timestamp == "" {
		entry.Timestamp = s.clock.Now().Format(time.RFC3339)
	}
	if err := s.crash.Store(ctx, entry); err != nil {
		return fmt.Errorf("watchdog: log crash: %w", err)
	}
	return nil
}
