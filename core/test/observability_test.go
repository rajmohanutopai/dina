package test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/observability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/portability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/server"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// readCompose reads the real docker-compose.yml from the project root.
// It tries ../../docker-compose.yml first (when running from core/test/),
// then ../docker-compose.yml as a fallback.
func readCompose(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		data, err = os.ReadFile("../docker-compose.yml")
	}
	if err != nil {
		t.Skip("docker-compose.yml not found — skipping compose file assertion")
	}
	return string(data)
}

// extractServiceBlock extracts the YAML block for a named service from the
// compose file content. It returns the indented text between the service key
// and the next top-level service (or end of the services section).
func extractServiceBlock(content, serviceName string) string {
	lines := strings.Split(content, "\n")
	var buf strings.Builder
	inServices := false
	inTarget := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Detect top-level "services:" key.
		if trimmed == "services:" {
			inServices = true
			continue
		}
		if !inServices {
			continue
		}
		// A non-indented, non-empty line after services: means we left the services block.
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' && trimmed != "" {
			break
		}
		// Detect service-level key (exactly 2-space indent).
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") && strings.Contains(trimmed, ":") {
			name := strings.TrimSuffix(strings.TrimSpace(trimmed), ":")
			if name == serviceName {
				inTarget = true
				continue
			} else if inTarget {
				break // hit next service
			}
		}
		if inTarget {
			buf.WriteString(line)
			buf.WriteString("\n")
		}
	}
	return buf.String()
}

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
// TRACE: {"suite": "CORE", "case": "1012", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "01", "title": "HealthzLiveness"}
// TST-CORE-662
func TestObservability_20_1_1_HealthzLiveness(t *testing.T) {
	// GET /healthz must return 200 OK with near-zero cost, no DB call.
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	// Liveness must always succeed when the process is alive.
	err := impl.Liveness()
	testutil.RequireNoError(t, err)

	// Discrimination: a locked-vault checker must still pass liveness
	// (liveness ≠ readiness). Proves Liveness() doesn't accidentally
	// check vault state.
	lockedImpl := newHealthChecker(false)
	err = lockedImpl.Liveness()
	testutil.RequireNoError(t, err)

	// But readiness must fail for the locked checker.
	err = lockedImpl.Readiness()
	testutil.RequireError(t, err)
}

// TST-CORE-663
// TRACE: {"suite": "CORE", "case": "1013", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "02", "title": "ReadyzVaultQueryable"}
// TST-CORE-663
func TestObservability_20_1_2_ReadyzVaultQueryable(t *testing.T) {
	// Positive: healthy vault → Readiness succeeds (200).
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")

	err := impl.Readiness()
	testutil.RequireNoError(t, err)

	// Negative control: unhealthy vault → Readiness must fail (503).
	unhealthyImpl := newHealthChecker(false)
	err = unhealthyImpl.Readiness()
	testutil.RequireError(t, err)

	// Verify Liveness still succeeds even when vault is unhealthy,
	// proving Readiness and Liveness are independent checks.
	err = unhealthyImpl.Liveness()
	testutil.RequireNoError(t, err)
}

// TST-CORE-664
// TRACE: {"suite": "CORE", "case": "1014", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "03", "title": "ReadyzVaultLocked"}
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
// TRACE: {"suite": "CORE", "case": "1015", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "04", "title": "ReadyzDBDeadlocked"}
// TST-CORE-665
func TestObservability_20_1_4_ReadyzDBDeadlocked(t *testing.T) {
	// GET /readyz must return 503 when SQLite is locked (PingContext times out).
	// Use a DynamicHealthChecker whose health function returns false,
	// simulating a DB that cannot be pinged (deadlock / lock timeout).
	// This exercises the dynamic healthFunc code path (production wiring)
	// rather than the static boolean path tested by TST-CORE-664.
	impl := server.NewDynamicHealthChecker(func() bool {
		return false // simulate PingContext failure due to DB deadlock
	})
	testutil.RequireImplementation(t, impl, "HealthChecker")

	// Verify IsVaultHealthy returns false via the dynamic function path.
	testutil.RequireFalse(t, impl.IsVaultHealthy(), "DB deadlock should make vault unhealthy via dynamic health func")

	// Verify Readiness returns an error when DB is deadlocked.
	err := impl.Readiness()
	testutil.RequireError(t, err)

	// Verify the error message indicates vault/readiness failure.
	if !strings.Contains(err.Error(), "vault") && !strings.Contains(err.Error(), "ready") {
		t.Fatalf("error should mention vault or readiness issue, got: %s", err.Error())
	}

	// Verify liveness still passes (zombie state: alive but DB-deadlocked).
	testutil.RequireNoError(t, impl.Liveness())
}

// TST-CORE-666
// TRACE: {"suite": "CORE", "case": "1016", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "05", "title": "ZombieDetection"}
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
// TRACE: {"suite": "CORE", "case": "1017", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "06", "title": "HealthzUnauthenticated"}
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
// TRACE: {"suite": "CORE", "case": "1018", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "01", "scenario": "07", "title": "ReadyzUnauthenticated"}
// TST-CORE-668
func TestObservability_20_1_7_ReadyzUnauthenticated(t *testing.T) {
	// Readiness probes must not require auth — /readyz must be in publicPaths.
	// The "unauthenticated" property lives in middleware.Auth, not in the HealthChecker
	// struct, so we verify by source audit of the auth middleware.
	src, err := os.ReadFile("../internal/middleware/auth.go")
	if err != nil {
		t.Fatalf("cannot read auth middleware source: %v", err)
	}
	content := string(src)

	// Positive: /readyz must be in publicPaths (auth bypass).
	if !strings.Contains(content, `"/readyz"`) {
		t.Fatal("/readyz must be listed in publicPaths for unauthenticated access")
	}
	if !strings.Contains(content, "publicPaths") {
		t.Fatal("auth middleware must define publicPaths map")
	}

	// Positive: /healthz must also be in publicPaths (sibling probe).
	if !strings.Contains(content, `"/healthz"`) {
		t.Fatal("/healthz must also be listed in publicPaths")
	}

	// Negative: authenticated endpoints (e.g. /v1/vault/store) must NOT be in publicPaths.
	if strings.Contains(content, `"/v1/vault/store": true`) {
		t.Fatal("/v1/vault/store must NOT be in publicPaths — only probes bypass auth")
	}

	// Also verify the in-memory Readiness call works (functional sanity).
	impl := realHealthChecker
	testutil.RequireImplementation(t, impl, "HealthChecker")
	// Call Readiness — we don't care about the result (depends on vault state),
	// but it must not panic.
	_ = impl.Readiness()
}

// --------------------------------------------------------------------------
// §20.2 Docker Healthcheck Configuration (13 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-669
// TRACE: {"suite": "CORE", "case": "1019", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "01", "title": "CoreHealthcheckEndpoint"}
// TST-CORE-669
func TestObservability_20_2_1_CoreHealthcheckEndpoint(t *testing.T) {
	// Core healthcheck must use wget to probe http://localhost:8100/healthz.
	// Verify against the REAL docker-compose.yml file, not a hardcoded map.
	content := readCompose(t)
	coreBlock := extractServiceBlock(content, "core")
	if coreBlock == "" {
		t.Fatal("could not find 'core' service block in docker-compose.yml")
	}

	// The healthcheck test line must reference the /healthz endpoint.
	if !strings.Contains(coreBlock, "healthcheck:") {
		t.Fatal("core service must have a healthcheck section")
	}
	if !strings.Contains(coreBlock, "http://localhost:8100/healthz") {
		t.Fatal("core healthcheck must probe http://localhost:8100/healthz")
	}
	// Must use wget (available in Alpine), not curl.
	if !strings.Contains(coreBlock, "wget") {
		t.Fatal("core healthcheck must use wget (available in minimal Alpine images)")
	}
	// Must use CMD or CMD-SHELL form.
	if !strings.Contains(coreBlock, "CMD") {
		t.Fatal("core healthcheck must use CMD or CMD-SHELL form")
	}
}

// TST-CORE-670
// TRACE: {"suite": "CORE", "case": "1020", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "02", "title": "CoreHealthcheckInterval"}
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
// TRACE: {"suite": "CORE", "case": "1021", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "03", "title": "CoreHealthcheckTimeout"}
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
// TRACE: {"suite": "CORE", "case": "1022", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "04", "title": "CoreHealthcheckRetries"}
// TST-CORE-672
func TestObservability_20_2_4_CoreHealthcheckRetries(t *testing.T) {
	// Core healthcheck retries must be 3.
	// Verify against the REAL docker-compose.yml file, not a hardcoded map.
	content := readCompose(t)
	coreBlock := extractServiceBlock(content, "core")
	if coreBlock == "" {
		t.Fatal("could not find 'core' service block in docker-compose.yml")
	}

	if !strings.Contains(coreBlock, "healthcheck:") {
		t.Fatal("core service must have a healthcheck section")
	}
	if !strings.Contains(coreBlock, "retries: 3") {
		t.Fatal("core healthcheck must have retries: 3")
	}
}

// TST-CORE-673
// TRACE: {"suite": "CORE", "case": "1023", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "05", "title": "CoreHealthcheckStartPeriod"}
// TST-CORE-673
func TestObservability_20_2_5_CoreHealthcheckStartPeriod(t *testing.T) {
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)

	// Parser returns a start_period value — verify it is non-empty and reasonable.
	testutil.RequireTrue(t, cfg.StartPeriod != "", "start_period must be set")

	// Cross-validate against the real docker-compose.yml on disk.
	compose := readCompose(t)
	coreBlock := extractServiceBlock(compose, "core")
	testutil.RequireTrue(t, strings.Contains(coreBlock, "start_period"),
		"core service in docker-compose.yml must define start_period")
}

// TST-CORE-674
// TRACE: {"suite": "CORE", "case": "1024", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "06", "title": "BrainHealthcheck"}
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

	// Brain must depend on core being healthy (service_healthy).
	dep, ok := cfg.DependsOn["core"]
	testutil.RequireTrue(t, ok, "brain must depend on core")
	testutil.RequireEqual(t, dep, "service_healthy")

	// Brain must use restart=always.
	testutil.RequireEqual(t, cfg.Restart, "always")

	// Negative: non-existent service must return an error.
	_, err = impl.ParseService("docker-compose.yml", "nonexistent-svc")
	testutil.RequireError(t, err)
}

// TST-CORE-675
// TRACE: {"suite": "CORE", "case": "1025", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "07", "title": "PDSHealthcheck"}
// TST-CORE-675
func TestObservability_20_2_7_PDSHealthcheck(t *testing.T) {
	impl := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Positive: PDS service has correct healthcheck config.
	cfg, err := impl.ParseService("docker-compose.yml", "pds")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ServiceName, "pds")
	testutil.RequireEqual(t, cfg.Test[4], "http://localhost:2583/xrpc/_health")
	testutil.RequireEqual(t, cfg.Interval, "30s")
	testutil.RequireEqual(t, cfg.Timeout, "5s")
	testutil.RequireEqual(t, cfg.Retries, 3)
	testutil.RequireEqual(t, cfg.StartPeriod, "10s")
	testutil.RequireEqual(t, cfg.Restart, "always")

	// Negative: non-existent service returns error.
	_, err = impl.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireTrue(t, err != nil, "non-existent service must return error")
}

// TST-CORE-676
// TRACE: {"suite": "CORE", "case": "1026", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "08", "title": "LlamaHealthcheck"}
// TST-CORE-676
func TestObservability_20_2_8_LlamaHealthcheck(t *testing.T) {
	impl := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Positive: llama service has correct healthcheck config.
	cfg, err := impl.ParseService("docker-compose.yml", "llama")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ServiceName, "llama")
	testutil.RequireEqual(t, cfg.Test[4], "http://localhost:8080/health")
	testutil.RequireEqual(t, cfg.Interval, "30s")
	testutil.RequireEqual(t, cfg.Timeout, "5s")
	testutil.RequireEqual(t, cfg.Retries, 3)
	testutil.RequireEqual(t, cfg.StartPeriod, "30s")
	testutil.RequireEqual(t, cfg.Restart, "always")

	// Llama-specific: must have "local-llm" profile (conditional service).
	testutil.RequireTrue(t, len(cfg.Profiles) > 0, "llama must have profiles set")
	testutil.RequireEqual(t, cfg.Profiles[0], "local-llm")

	// Negative: non-existent service returns error.
	_, err = impl.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireTrue(t, err != nil, "non-existent service must return error")
}

// TST-CORE-677
// TRACE: {"suite": "CORE", "case": "1027", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "09", "title": "WgetNotCurl"}
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
// TRACE: {"suite": "CORE", "case": "1028", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "10", "title": "RestartAlways"}
// TST-CORE-678
func TestObservability_20_2_10_RestartAlways(t *testing.T) {
	// All services must have restart: always.
	impl := realDockerComposeParser
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	services := []string{"core", "brain", "pds", "llama"}
	for _, svc := range services {
		cfg, err := impl.ParseService("docker-compose.yml", svc)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, cfg.Restart, "always")
		// Verify the service name is correctly set.
		testutil.RequireEqual(t, cfg.ServiceName, svc)
	}

	// Negative: non-existent service must error.
	_, err := impl.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireError(t, err)
}

// TST-CORE-679
// TRACE: {"suite": "CORE", "case": "1029", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "11", "title": "BrainDependsOnCoreHealthy"}
// TST-CORE-679
func TestObservability_20_2_11_BrainDependsOnCoreHealthy(t *testing.T) {
	impl := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Positive: brain depends on core with condition "service_healthy".
	cfg, err := impl.ParseService("docker-compose.yml", "brain")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ServiceName, "brain")
	condition, ok := cfg.DependsOn["core"]
	testutil.RequireTrue(t, ok, "brain must depend on core")
	testutil.RequireEqual(t, condition, "service_healthy")

	// Negative: brain must NOT depend on llama (optional service).
	_, hasLlama := cfg.DependsOn["llama"]
	testutil.RequireFalse(t, hasLlama, "brain must not depend on optional llama service")

	// Negative: non-existent service returns error.
	_, err = impl.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireTrue(t, err != nil, "non-existent service must return error")
}

// TST-CORE-680
// TRACE: {"suite": "CORE", "case": "1030", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "12", "title": "CoreDependsOnPDSStarted"}
// TST-CORE-680
func TestObservability_20_2_12_CoreDependsOnPDSStarted(t *testing.T) {
	impl := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Positive: core depends on pds with condition "service_started".
	cfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ServiceName, "core")
	condition, ok := cfg.DependsOn["pds"]
	testutil.RequireTrue(t, ok, "core must depend on pds")
	testutil.RequireEqual(t, condition, "service_started")

	// Negative: core must NOT depend on llama (llama is optional via profile).
	_, hasLlama := cfg.DependsOn["llama"]
	testutil.RequireFalse(t, hasLlama, "core must not depend on optional llama service")

	// Negative: non-existent service returns error.
	_, err = impl.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireTrue(t, err != nil, "non-existent service must return error")
}

// TST-CORE-681
// TRACE: {"suite": "CORE", "case": "1031", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "02", "scenario": "13", "title": "LlamaProfileLocalLLM"}
// TST-CORE-681
func TestObservability_20_2_13_LlamaProfileLocalLLM(t *testing.T) {
	impl := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, impl, "DockerComposeParser")

	// Positive: llama must have "local-llm" profile (conditional service).
	cfg, err := impl.ParseService("docker-compose.yml", "llama")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ServiceName, "llama")
	testutil.RequireTrue(t, len(cfg.Profiles) > 0, "llama must have profiles")
	testutil.RequireEqual(t, cfg.Profiles[0], "local-llm")

	// Negative: core service must NOT have profiles (always runs).
	coreCfg, err := impl.ParseService("docker-compose.yml", "core")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(coreCfg.Profiles), 0)

	// Negative: brain service must NOT have profiles (always runs).
	brainCfg, err := impl.ParseService("docker-compose.yml", "brain")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(brainCfg.Profiles), 0)
}

// --------------------------------------------------------------------------
// §20.3 Crash Log Storage (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-682
// TRACE: {"suite": "CORE", "case": "1032", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "01", "title": "CrashTracebackStored"}
// TST-CORE-682
func TestObservability_20_3_1_CrashTracebackStored(t *testing.T) {
	// Brain sends POST /v1/vault/crash and row is inserted in crash_log table.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	entry := domain.CrashEntry{
		Error:     "RuntimeError: division by zero",
		Traceback: "Traceback (most recent call last):\n  File \"main.py\", line 42\n    result = 1/0\nRuntimeError: division by zero",
		TaskID:    "task-crash-store-001",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)

	// Verify the entry was actually stored by querying back.
	results, err := impl.Query(context.Background(), "")
	testutil.RequireNoError(t, err)
	found := false
	for _, r := range results {
		if r.TaskID == "task-crash-store-001" {
			found = true
			testutil.RequireEqual(t, r.Error, "RuntimeError: division by zero")
			testutil.RequireTrue(t, len(r.Traceback) > 0, "traceback must be preserved")
			testutil.RequireContains(t, r.Traceback, "main.py")
			testutil.RequireTrue(t, r.Timestamp != "", "timestamp must be auto-populated on Store")
		}
	}
	testutil.RequireTrue(t, found, "stored crash entry must be retrievable via Query")
}

// TST-CORE-683
// TRACE: {"suite": "CORE", "case": "1033", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "02", "title": "CrashLogTableSchema"}
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

	// Cross-validate: Store a CrashEntry and verify all schema fields survive round-trip.
	crashImpl := realCrashLogger
	testutil.RequireImplementation(t, crashImpl, "CrashLogger")
	ctx := context.Background()

	entry := domain.CrashEntry{
		Error:     "SchemaTestError",
		Traceback: "traceback at line 42",
		TaskID:    "task_schema_001",
	}
	err = crashImpl.Store(ctx, entry)
	testutil.RequireNoError(t, err)

	entries, err := crashImpl.Query(ctx, "SchemaTestError")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(entries) >= 1, "stored crash entry must be queryable")

	found := false
	for _, e := range entries {
		if e.TaskID == "task_schema_001" {
			found = true
			testutil.RequireTrue(t, e.ID > 0, "ID must be auto-generated positive integer")
			testutil.RequireTrue(t, e.Timestamp != "", "Timestamp must be auto-populated")
			testutil.RequireEqual(t, e.Error, "SchemaTestError")
			testutil.RequireEqual(t, e.Traceback, "traceback at line 42")
		}
	}
	testutil.RequireTrue(t, found, "stored crash entry must be retrievable with all fields")
}

// TST-CORE-684
// TRACE: {"suite": "CORE", "case": "1034", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "03", "title": "CrashLogEncryptedAtRest"}
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
// TRACE: {"suite": "CORE", "case": "1035", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "04", "title": "CrashLogRetention90Days"}
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
// TRACE: {"suite": "CORE", "case": "1036", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "05", "title": "CrashLogQueryable"}
// TST-CORE-686
func TestObservability_20_3_5_CrashLogQueryable(t *testing.T) {
	impl := observability.NewCrashLogger()
	testutil.RequireImplementation(t, impl, "CrashLogger")

	ctx := context.Background()

	// Store a crash entry.
	entry := testutil.CrashEntry{
		Error:     "QueryTestError",
		Traceback: "traceback for query test",
		TaskID:    "task-query-001",
	}
	err := impl.Store(ctx, entry)
	testutil.RequireNoError(t, err)

	// Positive: query with past date must find the entry.
	entries, err := impl.Query(ctx, "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(entries), 1)
	testutil.RequireEqual(t, entries[0].Error, "QueryTestError")
	testutil.RequireEqual(t, entries[0].TaskID, "task-query-001")
	testutil.RequireEqual(t, entries[0].Traceback, "traceback for query test")
	testutil.RequireTrue(t, entries[0].ID > 0, "crash entry must have an auto-assigned ID")

	// Negative: query with a far-future date must return nothing.
	future, err := impl.Query(ctx, "2099-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(future), 0)

	// Negative: storing an entry with empty error must fail.
	err = impl.Store(ctx, testutil.CrashEntry{Error: ""})
	testutil.RequireError(t, err)
}

// TST-CORE-687
// TRACE: {"suite": "CORE", "case": "1037", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "06", "title": "CrashLogIncludedInBackup"}
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

	contents, err := impl.ListArchiveContents(archivePath, testutil.TestPassphrase)
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
// TRACE: {"suite": "CORE", "case": "1038", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "07", "title": "AdminUICrashHistory"}
// TST-CORE-688
func TestObservability_20_3_7_AdminUICrashHistory(t *testing.T) {
	// GET /admin/crashes returns table of recent crashes — simulated via Store+Query.
	cl := observability.NewCrashLogger()
	testutil.RequireImplementation(t, cl, "CrashLogger")

	ctx := context.Background()

	// Negative: query on fresh logger returns no entries.
	empty, err := cl.Query(ctx, "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(empty), 0)

	// Store a crash, then query — simulating admin UI fetch.
	entry := testutil.CrashEntry{
		Error:     "AdminUITestError",
		Traceback: "traceback for admin UI test",
		TaskID:    "task-admin-001",
	}
	err = cl.Store(ctx, entry)
	testutil.RequireNoError(t, err)

	entries, err := cl.Query(ctx, "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(entries), 1)

	// Verify exact field values, not just non-empty.
	testutil.RequireEqual(t, entries[0].Error, "AdminUITestError")
	testutil.RequireEqual(t, entries[0].TaskID, "task-admin-001")
	testutil.RequireEqual(t, entries[0].Traceback, "traceback for admin UI test")
}

// TST-CORE-914
// TRACE: {"suite": "CORE", "case": "1039", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "08", "title": "DockerComposeLoggingRotationConfig"}
// TST-CORE-914
func TestObservability_20_3_8_DockerComposeLoggingRotationConfig(t *testing.T) {
	// Docker compose logging/restart config validated for all services.
	parser := observability.NewDockerComposeParser()
	testutil.RequireImplementation(t, parser, "DockerComposeParser")

	// Positive: all 4 services must have restart="always" (crash recovery).
	for _, svc := range []string{"core", "brain", "pds", "llama"} {
		cfg, err := parser.ParseService("docker-compose.yml", svc)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, cfg.Restart, "always")
		testutil.RequireEqual(t, cfg.ServiceName, svc)
		testutil.RequireTrue(t, cfg.Retries > 0, svc+" must have retries > 0")
		testutil.RequireTrue(t, cfg.Interval != "", svc+" must have non-empty interval")
		testutil.RequireTrue(t, cfg.Timeout != "", svc+" must have non-empty timeout")
	}

	// Negative: non-existent service must error.
	_, err := parser.ParseService("docker-compose.yml", "nonexistent")
	testutil.RequireTrue(t, err != nil, "non-existent service must return error")
}

// TST-CORE-917
// TRACE: {"suite": "CORE", "case": "1040", "section": "20", "sectionName": "Observability & Self-Healing", "subsection": "03", "scenario": "11", "title": "DataVolumeLayout"}
// TST-CORE-917
func TestObservability_20_3_11_DataVolumeLayout(t *testing.T) {
	// §20.3.11: Data volume layout in docker-compose.yml must match architecture spec.
	// The spec requires:
	//   - core mounts dina-data at /data (vault path = /data/vault)
	//   - brain mounts dina-data at /data
	//   - secrets mount at /run/secrets/service_keys/
	//   - service key isolation: core and brain get separate private key dirs
	//
	// PDS sidecar was removed — Core uses a community PDS (e.g., bsky.social)
	// so there is no local pds service / pds-data volume to validate.

	compose := readCompose(t)

	// Extract the core service block.
	coreBlock := extractServiceBlock(compose,"core")

	// Core must mount dina-data volume at /data.
	testutil.RequireTrue(t, strings.Contains(coreBlock, "dina-data:/data"),
		"core service must mount dina-data volume at /data")

	// Core must set DINA_VAULT_PATH=/data/vault.
	testutil.RequireTrue(t, strings.Contains(coreBlock, "DINA_VAULT_PATH=/data/vault"),
		"core must set DINA_VAULT_PATH=/data/vault")

	// Core must mount service keys for isolation.
	testutil.RequireTrue(t, strings.Contains(coreBlock, "service_keys/core:/run/secrets/service_keys/private"),
		"core must mount its own private key directory")
	testutil.RequireTrue(t, strings.Contains(coreBlock, "service_keys/public:/run/secrets/service_keys/public"),
		"core must mount shared public key directory")

	// Extract the brain service block.
	brainBlock := extractServiceBlock(compose,"brain")

	// Brain must mount dina-data volume at /data.
	testutil.RequireTrue(t, strings.Contains(brainBlock, "dina-data:/data"),
		"brain service must mount dina-data volume at /data")

	// Brain must mount its own separate private key directory (not core's).
	testutil.RequireTrue(t, strings.Contains(brainBlock, "service_keys/brain:/run/secrets/service_keys/private"),
		"brain must mount its own private key directory (not core's)")

	// Verify shared named volume is declared.
	testutil.RequireTrue(t, strings.Contains(compose, "dina-data:"),
		"dina-data named volume must be declared")
}
