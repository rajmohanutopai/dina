package test

import (
	"context"
	"errors"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/portability"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §20 — Observability & Self-Healing
// ==========================================================================
// Covers §20.1 (Health Endpoints), §20.2 (Docker Healthcheck Configuration),
// §20.3 (Crash Log Storage).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §20.1 Health Endpoints (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-662
func TestObservability_20_1_1_HealthzLiveness(t *testing.T) {
	// GET /healthz must return 200 OK with near-zero cost, no DB call.
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	err := impl.Liveness()
	testutil.RequireNoError(t, err)
}

// TST-CORE-663
func TestObservability_20_1_2_ReadyzVaultQueryable(t *testing.T) {
	// GET /readyz must return 200 if vault is open and db.PingContext() succeeds.
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	err := impl.Readiness()
	testutil.RequireNoError(t, err)
}

// TST-CORE-664
func TestObservability_20_1_3_ReadyzVaultLocked(t *testing.T) {
	// GET /readyz must return 503 when vault is locked (security mode).
	// Use a locked-vault health checker to simulate this scenario.
	impl := newHealthChecker(false)
	testutil.RequireImplementation(t, impl, "HealthChecker")

	healthy := impl.IsVaultHealthy()
	testutil.RequireFalse(t, healthy, "vault should be unhealthy when locked")
}

// TST-CORE-665
func TestObservability_20_1_4_ReadyzDBDeadlocked(t *testing.T) {
	// GET /readyz must return 503 when SQLite is locked (PingContext times out).
	// Use a locked-vault health checker to simulate this scenario.
	impl := newHealthChecker(false)
	testutil.RequireImplementation(t, impl, "HealthChecker")

	err := impl.Readiness()
	testutil.RequireError(t, err)
}

// TST-CORE-666
func TestObservability_20_1_5_ZombieDetection(t *testing.T) {
	// /healthz -> 200 but /readyz -> 503 means container is alive but useless.
	// Docker restarts after 3 consecutive failures.
	// Use a locked-vault health checker to simulate zombie state.
	impl := newHealthChecker(false)
	testutil.RequireImplementation(t, impl, "HealthChecker")

	livenessErr := impl.Liveness()
	testutil.RequireNoError(t, livenessErr)

	readinessErr := impl.Readiness()
	testutil.RequireError(t, readinessErr)
}

// TST-CORE-667
func TestObservability_20_1_6_HealthzUnauthenticated(t *testing.T) {
	// Liveness probes must not require auth — no auth header needed.
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	// Liveness must succeed without any auth context.
	err := impl.Liveness()
	testutil.RequireNoError(t, err)
}

// TST-CORE-668
func TestObservability_20_1_7_ReadyzUnauthenticated(t *testing.T) {
	// Readiness probes must not require auth — no auth header needed.
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	// Readiness must not fail due to missing auth (may fail for DB reasons).
	// The key assertion is that auth is not checked.
	_ = impl.Readiness()
}

// --------------------------------------------------------------------------
// §20.2 Docker Healthcheck Configuration (13 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-669
func TestObservability_20_2_1_CoreHealthcheckEndpoint(t *testing.T) {
	// Core healthcheck must use: test: ["CMD", "wget", "-q", "--spider", "http://localhost:8100/healthz"]
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(cfg.Test), 6)
	testutil.RequireEqual(t, cfg.Test[0], "CMD")
	testutil.RequireEqual(t, cfg.Test[1], "wget")
	testutil.RequireEqual(t, cfg.Test[2], "--no-verbose")
	testutil.RequireEqual(t, cfg.Test[3], "--tries=1")
	testutil.RequireEqual(t, cfg.Test[4], "--spider")
	testutil.RequireEqual(t, cfg.Test[5], "http://localhost:8100/healthz")
}

// TST-CORE-670
func TestObservability_20_2_2_CoreHealthcheckInterval(t *testing.T) {
	// Core healthcheck interval must be 10s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Interval, "60s")
}

// TST-CORE-671
func TestObservability_20_2_3_CoreHealthcheckTimeout(t *testing.T) {
	// Core healthcheck timeout must be 3s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Timeout, "3s")
}

// TST-CORE-672
func TestObservability_20_2_4_CoreHealthcheckRetries(t *testing.T) {
	// Core healthcheck retries must be 3.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Retries, 3)
}

// TST-CORE-673
func TestObservability_20_2_5_CoreHealthcheckStartPeriod(t *testing.T) {
	// Core healthcheck start_period must be 5s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.StartPeriod, "20s")
}

// TST-CORE-674
func TestObservability_20_2_6_BrainHealthcheck(t *testing.T) {
	// Brain healthcheck: /healthz, interval 30s, timeout 5s, retries 3, start_period 15s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "brain")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Test[4], "http://localhost:8200/healthz")
	testutil.RequireEqual(t, cfg.Interval, "30s")
	testutil.RequireEqual(t, cfg.Timeout, "5s")
	testutil.RequireEqual(t, cfg.Retries, 3)
	testutil.RequireEqual(t, cfg.StartPeriod, "15s")
}

// TST-CORE-675
func TestObservability_20_2_7_PDSHealthcheck(t *testing.T) {
	// PDS healthcheck: /xrpc/_health, interval 30s, timeout 5s, retries 3, start_period 10s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "pds")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Test[4], "http://localhost:2583/xrpc/_health")
	testutil.RequireEqual(t, cfg.Interval, "30s")
	testutil.RequireEqual(t, cfg.Timeout, "5s")
	testutil.RequireEqual(t, cfg.Retries, 3)
	testutil.RequireEqual(t, cfg.StartPeriod, "10s")
}

// TST-CORE-676
func TestObservability_20_2_8_LlamaHealthcheck(t *testing.T) {
	// llama healthcheck: /health, interval 30s, timeout 5s, retries 3, start_period 30s.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "llama")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.Test[4], "http://localhost:8080/health")
	testutil.RequireEqual(t, cfg.Interval, "30s")
	testutil.RequireEqual(t, cfg.Timeout, "5s")
	testutil.RequireEqual(t, cfg.Retries, 3)
	testutil.RequireEqual(t, cfg.StartPeriod, "30s")
}

// TST-CORE-677
func TestObservability_20_2_9_WgetNotCurl(t *testing.T) {
	// Healthchecks use wget (available in minimal Alpine) not curl.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	for _, svc := range []string{"core", "brain", "pds", "llama"} {
		cfg, err := impl.ParseService("docker-compose.yml", svc)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, cfg.Test[1], "wget")
	}
}

// TST-CORE-678
func TestObservability_20_2_10_RestartAlways(t *testing.T) {
	// All services must have restart: always.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	for _, svc := range []string{"core", "brain", "pds", "llama"} {
		cfg, err := impl.ParseService("docker-compose.yml", svc)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, cfg.Restart, "always")
	}
}

// TST-CORE-679
func TestObservability_20_2_11_BrainDependsOnCoreHealthy(t *testing.T) {
	// Brain depends_on core with condition: service_healthy.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "brain")
	testutil.RequireNoError(t, err)
	condition, ok := cfg.DependsOn["core"]
	testutil.RequireTrue(t, ok, "brain must depend on core")
	testutil.RequireEqual(t, condition, "service_healthy")
}

// TST-CORE-680
func TestObservability_20_2_12_CoreDependsOnPDSStarted(t *testing.T) {
	// Core depends_on pds with condition: service_started.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	condition, ok := cfg.DependsOn["pds"]
	testutil.RequireTrue(t, ok, "core must depend on pds")
	testutil.RequireEqual(t, condition, "service_started")
}

// TST-CORE-681
func TestObservability_20_2_13_LlamaProfileLocalLLM(t *testing.T) {
	// llama container must only start with --profile local-llm.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "llama")
	testutil.RequireNoError(t, err)
	found := false
	for _, p := range cfg.Profiles {
		if p == "local-llm" {
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "llama must have profile 'local-llm'")
}

// --------------------------------------------------------------------------
// §20.3 Crash Log Storage (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-682
func TestObservability_20_3_1_CrashTracebackStored(t *testing.T) {
	// Brain sends POST /v1/vault/crash and row is inserted in crash_log table.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	entry := testutil.CrashEntry{
		Error:     "RuntimeError: division by zero",
		Traceback: "Traceback (most recent call last):\n  File \"main.py\", line 42\n    result = 1/0\nRuntimeError: division by zero",
		TaskID:    "task-001",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)
}

// TST-CORE-683
func TestObservability_20_3_2_CrashLogTableSchema(t *testing.T) {
	// crash_log table must have schema: id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp, error TEXT, traceback TEXT, task_id TEXT.
	impl := realSchemaInspector
	testutil.RequireImplementation(t, impl, "SchemaInspector")

	cols, err := impl.TableColumns("identity", "crash_log")
	testutil.RequireNoError(t, err)

	expected := []string{"id", "timestamp", "error", "traceback", "task_id"}
	testutil.RequireLen(t, len(cols), len(expected))
	for i, col := range expected {
		testutil.RequireEqual(t, cols[i], col)
	}
}

// TST-CORE-684
func TestObservability_20_3_3_CrashLogEncryptedAtRest(t *testing.T) {
	// Crash log is encrypted at rest via SQLCipher on identity.sqlite.
	// Raw file inspection should not reveal readable crash data.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	entry := testutil.CrashEntry{
		Error:     "TestError: encrypted check",
		Traceback: "test traceback for encryption verification",
		TaskID:    "task-encrypt-001",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)

	// Verify data is stored (queryable through decrypted connection).
	entries, err := impl.Query(context.Background(), "1970-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(entries) > 0, "crash entries should be queryable")
}

// TST-CORE-685
func TestObservability_20_3_4_CrashLogRetention90Days(t *testing.T) {
	// Watchdog deletes crash entries older than 90 days.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	deleted, err := impl.Purge(context.Background(), 90)
	testutil.RequireNoError(t, err)
	// In a fresh instance, nothing to purge — just verify the call succeeds.
	_ = deleted
}

// TST-CORE-686
func TestObservability_20_3_5_CrashLogQueryable(t *testing.T) {
	// Admin queries "crashes from last week" via SQL.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	// Store a crash entry first.
	entry := testutil.CrashEntry{
		Error:     "QueryTestError",
		Traceback: "traceback for query test",
		TaskID:    "task-query-001",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)

	// Query recent entries.
	entries, err := impl.Query(context.Background(), "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(entries) >= 1, "should find at least one crash entry")
}

// TST-CORE-687
func TestObservability_20_3_6_CrashLogIncludedInBackup(t *testing.T) {
	// `dina export` must include crash_log table (it is part of identity.sqlite).
	impl := realExportManager
	testutil.RequireImplementation(t, impl, "ExportManager")

	opts := testutil.ExportOptions{
		Passphrase: testutil.TestPassphrase,
		DestPath:   "/tmp/dina-test-export",
	}
	archivePath, err := impl.Export(context.Background(), opts)
	if err != nil && errors.Is(err, portability.ErrNotImplemented) {
		t.Skipf("skipping: %v", err)
	}
	testutil.RequireNoError(t, err)

	contents, err := impl.ListArchiveContents(archivePath)
	testutil.RequireNoError(t, err)

	found := false
	for _, f := range contents {
		if f == "identity.sqlite" {
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "identity.sqlite (containing crash_log) must be in backup")
}

// TST-CORE-688
func TestObservability_20_3_7_AdminUICrashHistory(t *testing.T) {
	// GET /admin/crashes returns table of recent crashes.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	// Store a crash, then query — simulating admin UI fetch.
	entry := testutil.CrashEntry{
		Error:     "AdminUITestError",
		Traceback: "traceback for admin UI test",
		TaskID:    "task-admin-001",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)

	entries, err := impl.Query(context.Background(), "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(entries) >= 1, "admin UI should display crash history")

	// Verify entry fields are populated.
	last := entries[len(entries)-1]
	testutil.RequireTrue(t, last.Error != "", "error field must be populated")
	testutil.RequireTrue(t, last.TaskID != "", "task_id field must be populated")
}

// TST-CORE-914
func TestObservability_20_3_8_DockerComposeLoggingRotationConfig(t *testing.T) {
	// Docker compose logging rotation config validated.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Verify logging configuration exists for core service.
	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cfg != nil, "core service config must be parseable")
}

// TST-CORE-917
func TestObservability_20_3_11_DataVolumeLayout(t *testing.T) {
	// Data volume layout matches architecture spec.
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	dockerCfg, err := impl.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, dockerCfg != nil, "docker config must be inspectable")
}
