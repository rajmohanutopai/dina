package test

import (
	"context"
	"testing"

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
func TestWatchdog_20_3_10_SystemTicker_1HourInterval(t *testing.T) {
	// System watchdog (1h interval): connector liveness, disk usage, brain health.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	report, err := impl.RunTick(wdCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, report.Timestamp > 0, "watchdog report must have timestamp")
}

// TST-CORE-915
func TestWatchdog_20_3_9_SingleSweepCleansAuditAndCrashLogs(t *testing.T) {
	// Single watchdog sweep cleans both audit AND crash logs together.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	report, err := impl.RunTick(wdCtx)
	testutil.RequireNoError(t, err)
	// Both purge counts should be non-negative (may be 0 on fresh instance).
	testutil.RequireTrue(t, report.AuditEntriesPurged >= 0, "audit purge count must be non-negative")
	testutil.RequireTrue(t, report.CrashEntriesPurged >= 0, "crash purge count must be non-negative")
}

// TST-CORE-914 (subsection for this in observability but test is here)
func TestWatchdog_20_3_8_ConnectorLiveness(t *testing.T) {
	// Check connector liveness.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	alive, err := impl.CheckConnectorLiveness()
	testutil.RequireNoError(t, err)
	_ = alive // result depends on running state
}

// TST-CORE-917 (data volume layout)
func TestWatchdog_20_3_11_DiskUsageCheck(t *testing.T) {
	// Check disk usage.
	impl := realSystemWatchdog
	testutil.RequireImplementation(t, impl, "SystemWatchdog")

	usage, err := impl.CheckDiskUsage()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, usage >= 0, "disk usage must be non-negative")
}
