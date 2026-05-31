package test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ctx is a background context used for all watchdog test calls.
var wdCtx = context.Background()

// ==========================================================================
// TEST_PLAN §20 — System Watchdog (1-hour ticker)
// ==========================================================================
// Covers the system watchdog that runs every hour to check connector
// liveness, disk usage, brain health, and purge old audit/crash logs.
// ==========================================================================

// TST-CORE-916
// TRACE: {"suite": "CORE", "case": "2039", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "10", "title": "SystemTicker_1HourInterval"}
func TestWatchdog_20_3_10_SystemTicker_1HourInterval(t *testing.T) {
	// System watchdog (1h interval): connector liveness, disk usage, brain health.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	beforeCall := time.Now().Unix()
	report, err := impl.RunTick(wdCtx)
	afterCall := time.Now().Unix()
	testutil.RequireNoError(t, err)

	// Timestamp must be within the call window, not just > 0.
	testutil.RequireTrue(t, report.Timestamp >= beforeCall && report.Timestamp <= afterCall,
		fmt.Sprintf("timestamp %d not in [%d,%d]", report.Timestamp, beforeCall, afterCall))

	// Verify wired values are reflected in the report.
	testutil.RequireTrue(t, report.ConnectorAlive, "connector should be alive (wired to true)")
	testutil.RequireTrue(t, report.BrainHealthy, "brain should be healthy (wired to true)")
	testutil.RequireEqual(t, report.DiskUsageBytes, int64(1000000))

	// Purge counts must be non-negative (actual value depends on seeded state).
	testutil.RequireTrue(t, report.AuditEntriesPurged >= 0, "audit purge count must be non-negative")
	testutil.RequireTrue(t, report.CrashEntriesPurged >= 0, "crash purge count must be non-negative")
}

// TST-CORE-915
// TRACE: {"suite": "CORE", "case": "2040", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "09", "title": "SingleSweepCleansAuditAndCrashLogs"}
func TestWatchdog_20_3_9_SingleSweepCleansAuditAndCrashLogs(t *testing.T) {
	// Single watchdog sweep cleans both audit AND crash logs together.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	ctx := context.Background()

	// Seed an old crash entry (timestamp well beyond the 90-day retention).
	oldTimestamp := "2020-01-01T00:00:00Z"
	err := realCrashLogger.Store(ctx, domain.CrashEntry{
		Timestamp: oldTimestamp,
		Error:     "old crash for purge test",
	})
	testutil.RequireNoError(t, err)

	// Seed an old audit entry (timestamp well beyond the 90-day retention).
	_, err = realVaultAuditLogger.Append(ctx, domain.VaultAuditEntry{
		Timestamp: oldTimestamp,
		Action:    "test_old_audit",
		Persona:   "test",
		Requester: "watchdog_test",
	})
	testutil.RequireNoError(t, err)

	report, err := impl.RunTick(wdCtx)
	testutil.RequireNoError(t, err)

	// After seeding old entries, both purge counts must be > 0.
	testutil.RequireTrue(t, report.AuditEntriesPurged > 0, "audit purge count must be > 0 after seeding old entries")
	testutil.RequireTrue(t, report.CrashEntriesPurged > 0, "crash purge count must be > 0 after seeding old entries")
}

// TST-CORE-914 (subsection for this in observability but test is here)
// TRACE: {"suite": "CORE", "case": "2041", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "08", "title": "ConnectorLiveness"}
func TestWatchdog_20_3_8_ConnectorLiveness(t *testing.T) {
	// Check connector liveness.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	alive, err := impl.CheckConnectorLiveness()
	testutil.RequireNoError(t, err)
	_ = alive // result depends on running state
}

// TST-CORE-917 (data volume layout)
// TRACE: {"suite": "CORE", "case": "2042", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "11", "title": "DiskUsageCheck"}
func TestWatchdog_20_3_11_DiskUsageCheck(t *testing.T) {
	// Check disk usage.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	usage, err := impl.CheckDiskUsage()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, usage >= 0, "disk usage must be non-negative")
}
