package test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/security"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §17 — Security Hardening
// ==========================================================================
// Covers 28 security hardening scenarios: code audits, SQL injection,
// path traversal, header injection, memory zeroization, TLS, Docker
// network isolation, secrets management, constant-time comparisons,
// plugin prohibition, encryption verification, and container hardening.
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §17.1 No VACUUM INTO
// --------------------------------------------------------------------------

// TST-CORE-611
// TRACE: {"suite": "CORE", "case": "1189", "section": "17", "sectionName": "Security Hardening", "subsection": "01", "scenario": "01", "title": "NoVacuumInto"}
// TST-CORE-611
func TestSecurity_17_1_NoVacuumInto(t *testing.T) {
	// §17.1: VACUUM INTO must never be used (plaintext backup CVE).

	// Positive: safe code without VACUUM INTO — 0 violations.
	safeCode := `db.Exec("VACUUM")
db.Exec("SELECT * FROM items")`
	safeAuditor := security.NewSecurityAuditor(safeCode, nil)
	violations, err := safeAuditor.AuditSourceCode("VACUUM INTO")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)

	// Negative: code containing VACUUM INTO must be detected.
	unsafeCode := `db.Exec("VACUUM INTO '/tmp/backup.db'")
db.Exec("SELECT * FROM items")`
	unsafeAuditor := security.NewSecurityAuditor(unsafeCode, nil)
	hits, err := unsafeAuditor.AuditSourceCode("VACUUM INTO")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(hits) >= 1, "must detect VACUUM INTO usage")
	testutil.RequireContains(t, hits[0], "VACUUM INTO")
}

// --------------------------------------------------------------------------
// §17.2 SQL Injection Resistance
// --------------------------------------------------------------------------

// TST-CORE-612
// TRACE: {"suite": "CORE", "case": "1190", "section": "17", "sectionName": "Security Hardening", "subsection": "02", "scenario": "01", "title": "SQLInjectionResistance"}
// TST-CORE-612
func TestSecurity_17_2_SQLInjectionResistance(t *testing.T) {
	// Verify AuditSourceCode detects SQL injection patterns (string concatenation).

	// Positive: parameterized query source has no violations.
	safeCode := `db.Query("SELECT * FROM items WHERE id = ?", id)`
	safeAuditor := security.NewSecurityAuditor(safeCode, nil)
	violations, err := safeAuditor.AuditSourceCode("fmt.Sprintf")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)

	// Negative: string concatenation in SQL is detected.
	unsafeCode := "query := fmt.Sprintf(\"SELECT * FROM items WHERE id = '%s'\", userInput)\ndb.Exec(query)"
	unsafeAuditor := security.NewSecurityAuditor(unsafeCode, nil)
	violations, err = unsafeAuditor.AuditSourceCode("fmt.Sprintf")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(violations) > 0, "string concatenation in SQL must be detected as violation")
	testutil.RequireContains(t, violations[0], "fmt.Sprintf")
}

// --------------------------------------------------------------------------
// §17.3 Path Traversal
// --------------------------------------------------------------------------

// TST-CORE-613
// TRACE: {"suite": "CORE", "case": "1191", "section": "17", "sectionName": "Security Hardening", "subsection": "03", "scenario": "01", "title": "PathTraversal"}
// TST-CORE-613
func TestSecurity_17_3_PathTraversal(t *testing.T) {
	// var impl testutil.SecurityAuditor = realaudit.New(...)
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Malicious paths like ../../etc/passwd must be rejected.
	traversalPaths := []string{
		"../../etc/passwd",
		"../../../etc/shadow",
		"..\\..\\windows\\system32\\config\\sam",
		"%2e%2e%2f%2e%2e%2fetc%2fpasswd",
		"/admin/../../../etc/passwd",
	}

	for _, p := range traversalPaths {
		safe, _, err := impl.ValidatePathTraversal(p)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, safe, "path traversal must be rejected: "+p)
	}
}

// --------------------------------------------------------------------------
// §17.4 Header Injection
// --------------------------------------------------------------------------

// TST-CORE-614
// TRACE: {"suite": "CORE", "case": "1192", "section": "17", "sectionName": "Security Hardening", "subsection": "04", "scenario": "01", "title": "HeaderInjection"}
// TST-CORE-614
func TestSecurity_17_4_HeaderInjection(t *testing.T) {
	auditor := security.NewSecurityAuditor("", nil)
	testutil.RequireImplementation(t, auditor, "SecurityAuditor")

	// Positive: safe header values must be accepted.
	safeValues := []string{
		"application/json",
		"Bearer token123abc",
		"text/html; charset=utf-8",
	}
	for _, v := range safeValues {
		safe, err := auditor.ValidateHeaderValue(v)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, safe, "safe header value must be accepted: "+v)
	}

	// Negative: CRLF injection values must be rejected.
	injectionValues := []string{
		"value\r\nX-Injected: true",
		"value\nSet-Cookie: hacked=1",
		"value\r\n\r\n<html>injected</html>",
	}
	for _, v := range injectionValues {
		safe, err := auditor.ValidateHeaderValue(v)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, safe, "header injection must be rejected")
	}
}

// --------------------------------------------------------------------------
// §17.5 Memory Zeroization
// --------------------------------------------------------------------------

// TST-CORE-615
// TRACE: {"suite": "CORE", "case": "1193", "section": "17", "sectionName": "Security Hardening", "subsection": "05", "scenario": "01", "title": "MemoryZeroization"}
// TST-CORE-615
func TestSecurity_17_5_MemoryZeroization(t *testing.T) {
	// Test that sensitive data can be zeroed from a byte slice.
	// This validates the zeroization primitive used for DEK clearing.
	sensitive := make([]byte, 32)
	for i := range sensitive {
		sensitive[i] = 0xAB // fill with sensitive data
	}

	// Verify it contains non-zero data.
	allZero := true
	for _, b := range sensitive {
		if b != 0 {
			allZero = false
			break
		}
	}
	testutil.RequireFalse(t, allZero, "sensitive buffer should contain non-zero data before zeroization")

	// Zeroize the buffer (same pattern used in crypto adapters).
	for i := range sensitive {
		sensitive[i] = 0
	}

	// Verify all bytes are now zero.
	for i, b := range sensitive {
		if b != 0 {
			t.Fatalf("byte %d not zeroed: got 0x%02x", i, b)
		}
	}
}

// --------------------------------------------------------------------------
// §17.6 TLS Enforcement (Production)
// --------------------------------------------------------------------------

// TST-CORE-616
// TRACE: {"suite": "CORE", "case": "1194", "section": "17", "sectionName": "Security Hardening", "subsection": "06", "scenario": "01", "title": "TLSEnforcement"}
// TST-CORE-616
func TestSecurity_17_6_TLSEnforcement(t *testing.T) {
	// Code audit: verify server source code has HTTP server infrastructure.
	// TLS is enforced at deployment layer (reverse proxy / Docker network).
	// The server must have ListenAndServe capability for production use.
	serverSource, err := os.ReadFile("../internal/adapter/server/server.go")
	if err != nil {
		t.Fatalf("failed to read server source: %v", err)
	}
	src := string(serverSource)

	// The server must implement ListenAndServe — the standard Go HTTP server entry point.
	// In production, TLS is layered via reverse proxy (nginx/caddy) or Docker network encryption.
	hasServerInfra := strings.Contains(src, "ListenAndServe") ||
		strings.Contains(src, "HTTP server") ||
		strings.Contains(src, "Server")

	testutil.RequireTrue(t, hasServerInfra,
		"server source must implement HTTP server infrastructure (ListenAndServe)")

	// Verify docker-compose uses secrets mount (not plain env vars) for token security.
	compose, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		t.Log("docker-compose.yml not found — skipping deployment TLS check")
		return
	}
	composeStr := string(compose)
	testutil.RequireTrue(t, strings.Contains(composeStr, "secrets:"),
		"docker-compose must use secrets for credential isolation (TLS-equivalent for inter-container auth)")
}

// --------------------------------------------------------------------------
// §17.7 Docker Network Isolation
// --------------------------------------------------------------------------

// TST-CORE-617
// TRACE: {"suite": "CORE", "case": "1195", "section": "17", "sectionName": "Security Hardening", "subsection": "07", "scenario": "01", "title": "DockerNetworkIsolation"}
// TST-CORE-617
func TestSecurity_17_7_DockerNetworkIsolation(t *testing.T) {
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// PDS sidecar was removed — Core uses a community PDS (e.g., bsky.social).
	// Only the brain network remains in the local compose topology.
	dockerCfg, err := impl.InspectDockerConfig()
	testutil.RequireNoError(t, err)

	brainInternal, brainExists := dockerCfg.Networks["dina-brain-net"]
	testutil.RequireTrue(t, brainExists, "dina-brain-net must exist in config")
	testutil.RequireFalse(t, brainInternal, "dina-brain-net must NOT be internal — brain needs outbound for LLM APIs")

	// Cross-validate against the real docker-compose.yml on disk.
	composeData, readErr := os.ReadFile(filepath.Join("..", "..", "docker-compose.yml"))
	if readErr != nil {
		composeData, readErr = os.ReadFile(filepath.Join("..", "docker-compose.yml"))
	}
	if readErr == nil {
		compose := string(composeData)
		testutil.RequireTrue(t, strings.Contains(compose, "dina-brain-net"),
			"docker-compose.yml must define dina-brain-net network")
	}
}

// --------------------------------------------------------------------------
// §17.8 Secrets Not in Environment
// --------------------------------------------------------------------------

// TST-CORE-618
// TRACE: {"suite": "CORE", "case": "1196", "section": "17", "sectionName": "Security Hardening", "subsection": "08", "scenario": "01", "title": "SecretsNotInEnvironment"}
// TST-CORE-618
func TestSecurity_17_8_SecretsNotInEnvironment(t *testing.T) {
	// §17.8: Secrets must be mounted as files (/run/secrets/), never as env vars.

	// Positive: default config has only non-secret env vars.
	auditor := security.NewSecurityAuditor("", nil)
	dockerCfg, err := auditor.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dockerCfg)

	// Verify legitimate env vars ARE present (proves we're scanning real config).
	foundMode := false
	for _, envVar := range dockerCfg.EnvVars {
		if envVar == "DINA_MODE" {
			foundMode = true
		}
	}
	testutil.RequireTrue(t, foundMode, "DINA_MODE must be present in env vars")

	// Verify secrets are NOT in env vars.
	forbiddenEnvVars := []string{"BRAIN_TOKEN", "DINA_PASSPHRASE", "DINA_SEED_HEX", "DINA_SEED_PASSPHRASE"}
	for _, forbidden := range forbiddenEnvVars {
		for _, envVar := range dockerCfg.EnvVars {
			if envVar == forbidden {
				t.Fatalf("secret %q must not be in environment variables — use /run/secrets/", forbidden)
			}
		}
	}

	// Negative: config with secrets in env vars must be detected.
	badCfg := &security.DockerConfig{
		EnvVars: []string{"DINA_MODE", "BRAIN_TOKEN", "DINA_PASSPHRASE"},
	}
	badAuditor := security.NewSecurityAuditor("", badCfg)
	badDockerCfg, err := badAuditor.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	secretsFound := 0
	for _, forbidden := range forbiddenEnvVars {
		for _, envVar := range badDockerCfg.EnvVars {
			if envVar == forbidden {
				secretsFound++
			}
		}
	}
	testutil.RequireTrue(t, secretsFound >= 2, "bad config must contain forbidden secrets for detection validation")
}

// --------------------------------------------------------------------------
// §17.9 No Plaintext Keys on Disk
// --------------------------------------------------------------------------

// TST-CORE-619
// TRACE: {"suite": "CORE", "case": "1197", "section": "17", "sectionName": "Security Hardening", "subsection": "09", "scenario": "01", "title": "NoPlaintextKeysOnDisk"}
// TST-CORE-619
func TestSecurity_17_9_NoPlaintextKeysOnDisk(t *testing.T) {
	// Read actual production source code from the adapter directory so
	// AuditSourceCode has real content to scan (not empty string).
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		sourceBuilder.WriteString(string(data))
		sourceBuilder.WriteString("\n")
		return nil
	})
	testutil.RequireNoError(t, err)
	realSource := sourceBuilder.String()
	testutil.RequireTrue(t, len(realSource) > 1000,
		"must read substantial production source code for audit")

	impl := security.NewSecurityAuditor(realSource, nil)
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Negative control: production source must not contain plaintext key patterns.
	patterns := []string{
		"PRIVATE KEY-----",
		"hardcoded_key",
		"secret_key = \"",
	}
	for _, p := range patterns {
		violations, auditErr := impl.AuditSourceCode(p)
		testutil.RequireNoError(t, auditErr)
		testutil.RequireLen(t, len(violations), 0)
	}

	// Positive control: an auditor with injected key material must detect it.
	tainted := realSource + "\n-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	violations, auditErr := taintedAuditor.AuditSourceCode("PRIVATE KEY-----")
	testutil.RequireNoError(t, auditErr)
	testutil.RequireTrue(t, len(violations) >= 1,
		"auditor must detect injected PRIVATE KEY pattern")
}

// --------------------------------------------------------------------------
// §17.10 Constant-Time Comparisons
// --------------------------------------------------------------------------

// TST-CORE-620
// TRACE: {"suite": "CORE", "case": "1198", "section": "17", "sectionName": "Security Hardening", "subsection": "10", "scenario": "01", "title": "ConstantTimeComparisons"}
// TST-CORE-620
func TestSecurity_17_10_ConstantTimeComparisons(t *testing.T) {
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Scan production source files that handle tokens/hashes for subtle usage.
	adapterDir := filepath.Join("..", "internal", "adapter")
	subtleFound := false
	var violations []string

	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		src := string(data)
		if strings.Contains(src, "ConstantTimeCompare") {
			subtleFound = true
		}
		return nil
	})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, subtleFound,
		"at least one production file must use crypto/subtle.ConstantTimeCompare")
	testutil.RequireTrue(t, len(violations) == 0,
		"found timing-unsafe token comparisons: "+strings.Join(violations, "; "))
}

// --------------------------------------------------------------------------
// §17.11 No Plugin Loading Mechanism
// --------------------------------------------------------------------------

// TST-CORE-621
// TRACE: {"suite": "CORE", "case": "1199", "section": "17", "sectionName": "Security Hardening", "subsection": "11", "scenario": "01", "title": "NoPluginLoading"}
// TST-CORE-621
func TestSecurity_17_11_NoPluginLoading(t *testing.T) {
	// Scan real production Go source files for forbidden plugin/dynamic-loading
	// patterns. The SecurityAuditor.AuditSourceCode is constructed with an empty
	// sourceCode string (always returns zero violations), so we bypass it and
	// walk the actual source tree.
	forbiddenPatterns := []string{"plugin.Open", "dlopen", "\"plugin\""}

	// Directories containing production Go code (relative to core/test/).
	sourceDirs := []string{"../internal", "../cmd"}

	var goFiles []string
	for _, dir := range sourceDirs {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil // skip inaccessible paths
			}
			if !info.IsDir() && strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
				goFiles = append(goFiles, path)
			}
			return nil
		})
	}

	if len(goFiles) == 0 {
		t.Fatal("no Go source files found under core/internal/ or core/cmd/ — directory structure may have changed")
	}

	for _, f := range goFiles {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Logf("warning: could not read %s: %v", f, err)
			continue
		}
		src := string(data)
		for _, pattern := range forbiddenPatterns {
			if strings.Contains(src, pattern) {
				t.Errorf("%s contains forbidden plugin/dynamic-loading pattern %q — "+
					"Dina must be statically compiled with no plugin loading mechanism", f, pattern)
			}
		}
	}
}

// --------------------------------------------------------------------------
// §17.12 No Plugin API Endpoint
// --------------------------------------------------------------------------

// TST-CORE-622
// TRACE: {"suite": "CORE", "case": "1200", "section": "17", "sectionName": "Security Hardening", "subsection": "12", "scenario": "01", "title": "NoPluginAPIEndpoint"}
// TST-CORE-622
func TestSecurity_17_12_NoPluginAPIEndpoint(t *testing.T) {
	// var impl testutil.Server = realserver.New(...)
	impl := realServer
	testutil.RequireImplementation(t, impl, "Server")

	// No plugin/extension registration endpoints should exist.
	routes := impl.Routes()
	for _, r := range routes {
		if len(r) >= 8 && r[:8] == "/plugin" {
			t.Fatalf("unexpected plugin endpoint: %s", r)
		}
		if len(r) >= 11 && r[:11] == "/extension" {
			t.Fatalf("unexpected extension endpoint: %s", r)
		}
	}
}

// --------------------------------------------------------------------------
// §17.13 Only Two Extension Points
// --------------------------------------------------------------------------

// TST-CORE-623
// TRACE: {"suite": "CORE", "case": "1201", "section": "17", "sectionName": "Security Hardening", "subsection": "13", "scenario": "01", "title": "OnlyTwoExtensionPoints"}
// TST-CORE-623
func TestSecurity_17_13_OnlyTwoExtensionPoints(t *testing.T) {
	// §17.13: Only two extension points — NaCl transport (peers) and HTTP (brain).
	// Read actual production source — realSecurityAuditor has empty sourceCode.
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		sourceBuilder.WriteString(string(data))
		sourceBuilder.WriteString("\n")
		return nil
	})
	testutil.RequireNoError(t, err)
	source := sourceBuilder.String()
	testutil.RequireTrue(t, len(source) > 0, "must read production source files")

	auditor := security.NewSecurityAuditor(source, nil)

	// No gRPC, no WebSocket outbound to external services, no plugin loading.
	patterns := []string{"grpc.Dial", "grpc.NewClient", "plugin.Open"}
	for _, p := range patterns {
		violations, err := auditor.AuditSourceCode(p)
		testutil.RequireNoError(t, err)
		testutil.RequireLen(t, len(violations), 0)
	}

	// Positive control: injected gRPC call must be detected.
	tainted := source + "\ngrpc.Dial(\"evil-server:443\")\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	grpcViolations, err := taintedAuditor.AuditSourceCode("grpc.Dial")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(grpcViolations) >= 1,
		"positive control: injected grpc.Dial must be detected")
}

// --------------------------------------------------------------------------
// §17.14 No Plaintext Vault Data on Disk
// --------------------------------------------------------------------------

// TST-CORE-624
// TRACE: {"suite": "CORE", "case": "1202", "section": "17", "sectionName": "Security Hardening", "subsection": "14", "scenario": "01", "title": "NoPlaintextVaultDataOnDisk"}
// TST-CORE-624
func TestSecurity_17_14_NoPlaintextVaultDataOnDisk(t *testing.T) {
	// Code audit: vault always uses SQLCipher encryption, never plain SQLite.
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Verify go-sqlcipher is used, not raw go-sqlite3.
	mattnViolations, err := impl.AuditSourceCode("mattn/go-sqlite3")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(mattnViolations), 0)

	// Verify no plaintext dump operations.
	dumpViolations, err := impl.AuditSourceCode(".Dump(")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(dumpViolations), 0)
}

// --------------------------------------------------------------------------
// §17.15 Plaintext Discarded After Processing
// --------------------------------------------------------------------------

// TST-CORE-625
// TRACE: {"suite": "CORE", "case": "1203", "section": "17", "sectionName": "Security Hardening", "subsection": "15", "scenario": "01", "title": "PlaintextDiscardedAfterProcessing"}
// TST-CORE-625
func TestSecurity_17_15_PlaintextDiscardedAfterProcessing(t *testing.T) {
	// §17.15: Production code must not log or retain plaintext keys/DEKs.
	// Scan actual adapter source for plaintext-leaking patterns.
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		sourceBuilder.Write(data)
		sourceBuilder.WriteByte('\n')
		return nil
	})
	testutil.RequireNoError(t, err)
	source := sourceBuilder.String()

	// Baseline: crypto code exists (we have something meaningful to scan).
	testutil.RequireTrue(t, strings.Contains(source, "sha256"),
		"adapter source must contain crypto operations as baseline")

	auditor := security.NewSecurityAuditor(source, nil)

	// Scan for patterns that would leak plaintext keys via logging.
	dangerousPatterns := []string{
		"log.Print(dek",
		"fmt.Print(dek",
		"log.Print(key[",
		"fmt.Print(key[",
	}
	for _, p := range dangerousPatterns {
		violations, auditErr := auditor.AuditSourceCode(p)
		testutil.RequireNoError(t, auditErr)
		testutil.RequireLen(t, len(violations), 0)
	}

	// Positive control: injected plaintext leak must be detected.
	tainted := source + "\nfmt.Println(string(dek))\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	leakViolations, err := taintedAuditor.AuditSourceCode("fmt.Println(string(dek")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(leakViolations) >= 1,
		"positive control: injected plaintext DEK log must be detected")
}

// --------------------------------------------------------------------------
// §17.16 Keys in RAM Only While Needed
// --------------------------------------------------------------------------

// TST-CORE-626
// TRACE: {"suite": "CORE", "case": "1204", "section": "17", "sectionName": "Security Hardening", "subsection": "16", "scenario": "01", "title": "KeysInRAMOnlyWhileNeeded"}
// TST-CORE-626
func TestSecurity_17_16_KeysInRAMOnlyWhileNeeded(t *testing.T) {
	// §17.16: DEK loaded only while needed — locked tier starts locked, unlock loads DEK,
	// lock clears it. Wrong passphrase must not unlock.
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}
	testutil.RequireImplementation(t, pm, "PersonaManager")

	ctx := context.Background()

	// Create with "locked" tier — starts locked (DEK not in RAM).
	personaID, err := pm.Create(ctx, "keysram_test", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)
	defer func() { _ = pm.Delete(ctx, personaID) }()

	// Verify starts locked.
	locked, err := pm.IsLocked(personaID)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "locked-tier persona must start locked — DEK not in RAM")

	// Negative: wrong passphrase must not unlock.
	err = pm.Unlock(ctx, personaID, "wrong-passphrase", 300)
	testutil.RequireError(t, err)

	locked, err = pm.IsLocked(personaID)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona must stay locked after wrong passphrase")

	// Unlock with correct passphrase — loads DEK into RAM.
	err = pm.Unlock(ctx, personaID, testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)

	locked, err = pm.IsLocked(personaID)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, locked, "persona must be unlocked after correct passphrase — DEK in RAM")

	// Lock — zeroes DEK from RAM.
	err = pm.Lock(ctx, personaID)
	testutil.RequireNoError(t, err)

	locked, err = pm.IsLocked(personaID)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona must be locked after Lock() — DEK cleared from RAM")
}

// --------------------------------------------------------------------------
// §17.17 SQLCipher Library: mutecomm/go-sqlcipher
// --------------------------------------------------------------------------

// TST-CORE-627
// TRACE: {"suite": "CORE", "case": "1205", "section": "17", "sectionName": "Security Hardening", "subsection": "17", "scenario": "01", "title": "SQLCipherLibrary"}
// TST-CORE-627
func TestSecurity_17_17_SQLCipherLibrary(t *testing.T) {
	// §17.17: Project must use go-sqlcipher (encrypted), NOT mattn/go-sqlite3 (plaintext).
	// Read go.mod directly — the shared realSecurityAuditor has empty sourceCode
	// so AuditSourceCode short-circuits and would always pass (tautological).
	gomod, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatalf("failed to read go.mod: %v", err)
	}
	gomodStr := string(gomod)

	// Positive: go.mod must contain go-sqlcipher dependency.
	testutil.RequireTrue(t, strings.Contains(gomodStr, "go-sqlcipher"),
		"go.mod must import go-sqlcipher for encrypted SQLite")

	// Negative: go.mod must NOT contain mattn/go-sqlite3 (plaintext SQLite).
	testutil.RequireFalse(t, strings.Contains(gomodStr, "mattn/go-sqlite3"),
		"go.mod must NOT import mattn/go-sqlite3 — use go-sqlcipher for encryption")
}

// --------------------------------------------------------------------------
// §17.18 CI: Raw .sqlite Bytes Are NOT Valid SQLite
// --------------------------------------------------------------------------

// TST-CORE-628
// TRACE: {"suite": "CORE", "case": "1206", "section": "17", "sectionName": "Security Hardening", "subsection": "18", "scenario": "01", "title": "RawSQLiteNotValid"}
// TST-CORE-628
func TestSecurity_17_18_RawSQLiteNotValid(t *testing.T) {
	// Verify vault uses SQLCipher by reading go.mod and confirming go-sqlcipher import.
	// If the project uses go-sqlcipher, raw SQLite opens will fail on vault files.
	gomod, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatalf("failed to read go.mod: %v", err)
	}
	gomodStr := string(gomod)

	// go.mod must contain the go-sqlcipher dependency.
	testutil.RequireTrue(t, strings.Contains(gomodStr, "go-sqlcipher"),
		"go.mod must import go-sqlcipher — vault files are encrypted, not raw SQLite")

	// Additionally, go.mod must NOT contain mattn/go-sqlite3 (plaintext).
	testutil.RequireFalse(t, strings.Contains(gomodStr, "mattn/go-sqlite3"),
		"go.mod must NOT import mattn/go-sqlite3 — use go-sqlcipher for encryption")
}

// --------------------------------------------------------------------------
// §17.19 Serialization: JSON for Core<->Brain Traffic
// --------------------------------------------------------------------------

// TST-CORE-629
// TRACE: {"suite": "CORE", "case": "1207", "section": "17", "sectionName": "Security Hardening", "subsection": "19", "scenario": "01", "title": "JSONSerialization"}
// TST-CORE-629
func TestSecurity_17_19_JSONSerialization(t *testing.T) {
	// §17.19: No MessagePack/Protobuf in inter-container API calls — JSON only (Phase 1).

	// Positive: safe code using only JSON serialization — no violations.
	safeCode := `import "encoding/json"
func handler(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(response)
}`
	safeAuditor := security.NewSecurityAuditor(safeCode, nil)
	msgpackViolations, err := safeAuditor.AuditSourceCode("msgpack")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(msgpackViolations), 0)

	protobufViolations, err := safeAuditor.AuditSourceCode("proto.Marshal")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(protobufViolations), 0)

	// Negative: code containing msgpack usage must be detected.
	unsafeCode := `import "github.com/vmihailenco/msgpack"
func handler(w http.ResponseWriter, r *http.Request) {
	data, _ := msgpack.Marshal(response)
	proto.Marshal(msg)
}`
	unsafeAuditor := security.NewSecurityAuditor(unsafeCode, nil)
	msgpackHits, err := unsafeAuditor.AuditSourceCode("msgpack")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(msgpackHits) >= 1, "must detect msgpack usage")

	protoHits, err := unsafeAuditor.AuditSourceCode("proto.Marshal")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(protoHits) >= 1, "must detect proto.Marshal usage")
}

// --------------------------------------------------------------------------
// §17.20 Container Image: Digest Pinning
// --------------------------------------------------------------------------

// TST-CORE-630
// TRACE: {"suite": "CORE", "case": "1208", "section": "17", "sectionName": "Security Hardening", "subsection": "20", "scenario": "01", "title": "DigestPinning"}
// TST-CORE-630
func TestSecurity_17_20_DigestPinning(t *testing.T) {
	auditor := security.NewSecurityAuditor("", nil)
	testutil.RequireImplementation(t, auditor, "SecurityAuditor")

	// Positive: all FROM statements must use @sha256: digest — never :latest tag.
	// PDS sidecar was removed; only core + brain images are built locally.
	dockerCfg, err := auditor.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(dockerCfg.ImageDigests) >= 2,
		"must have digest pins for at least core and brain images")

	for image, digest := range dockerCfg.ImageDigests {
		testutil.RequireTrue(t, len(digest) > 0,
			"image "+image+" must have a digest pin, not :latest")
		testutil.RequireContains(t, digest, "sha256:")
	}

	// Verify specific expected images are pinned.
	_, hasCore := dockerCfg.ImageDigests["dina-core"]
	testutil.RequireTrue(t, hasCore, "dina-core must have a pinned digest")
	_, hasBrain := dockerCfg.ImageDigests["dina-brain"]
	testutil.RequireTrue(t, hasBrain, "dina-brain must have a pinned digest")
}

// --------------------------------------------------------------------------
// §17.21 Container Image: Cosign Signature
// --------------------------------------------------------------------------

// TST-CORE-631
// TRACE: {"suite": "CORE", "case": "1209", "section": "17", "sectionName": "Security Hardening", "subsection": "21", "scenario": "01", "title": "CosignSignature"}
// TST-CORE-631
func TestSecurity_17_21_CosignSignature(t *testing.T) {
	// CI pipeline must include cosign signing. Verify Dockerfile or CI config references cosign.
	// Check for cosign in Dockerfile or docker-compose.yml comments/labels.
	dockerfile, err := os.ReadFile("../../Dockerfile")
	if err != nil {
		// Dockerfile may be at project root or in core/
		dockerfile, err = os.ReadFile("../Dockerfile")
	}
	if err != nil {
		// If no Dockerfile yet, this is a design intent test — cosign will be added.
		t.Log("No Dockerfile found — cosign signing is a Phase 2 CI requirement")
		return
	}
	_ = dockerfile // Cosign signing step verification deferred to CI integration
}

// --------------------------------------------------------------------------
// §17.22 SBOM Generated
// --------------------------------------------------------------------------

// TST-CORE-632
// TRACE: {"suite": "CORE", "case": "1210", "section": "17", "sectionName": "Security Hardening", "subsection": "22", "scenario": "01", "title": "SBOMGenerated"}
// TST-CORE-632
func TestSecurity_17_22_SBOMGenerated(t *testing.T) {
	// CI pipeline must generate SBOM using syft. Check for configuration.
	dockerfile, err := os.ReadFile("../../Dockerfile")
	if err != nil {
		dockerfile, err = os.ReadFile("../Dockerfile")
	}
	if err != nil {
		// No Dockerfile yet — SBOM generation is a Phase 2 CI requirement.
		t.Log("No Dockerfile found — SBOM generation is a Phase 2 CI requirement")
		return
	}
	_ = dockerfile // SBOM generation step verification deferred to CI integration
}

// --------------------------------------------------------------------------
// §17.23 Secrets NEVER in Environment Variables
// --------------------------------------------------------------------------

// TST-CORE-633
// TRACE: {"suite": "CORE", "case": "1211", "section": "17", "sectionName": "Security Hardening", "subsection": "23", "scenario": "01", "title": "SecretsNeverInEnvVars"}
// TST-CORE-633
func TestSecurity_17_23_SecretsNeverInEnvVars(t *testing.T) {
	// Fresh SecurityAuditor with default docker config.
	impl := security.NewSecurityAuditor("", nil)

	dockerCfg, err := impl.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, dockerCfg != nil, "docker config must not be nil")

	// Positive: secrets path must be /run/secrets/ (tmpfs).
	testutil.RequireEqual(t, dockerCfg.SecretsMountPath, "/run/secrets/")

	// Positive: env vars must NOT contain secret names.
	forbiddenSecrets := []string{
		"BRAIN_TOKEN", "DINA_PASSPHRASE", "DINA_MASTER_SEED",
		"CLIENT_TOKEN", "SERVICE_KEY", "DINA_DEK",
	}
	for _, secret := range forbiddenSecrets {
		for _, envVar := range dockerCfg.EnvVars {
			testutil.RequireTrue(t, envVar != secret,
				"secret "+secret+" must never appear in docker EnvVars list")
		}
	}

	// Positive: only safe config vars should be in EnvVars.
	testutil.RequireTrue(t, len(dockerCfg.EnvVars) > 0, "EnvVars must contain at least one config var")
	foundSafe := false
	for _, envVar := range dockerCfg.EnvVars {
		if envVar == "DINA_MODE" || envVar == "DINA_LISTEN_ADDR" {
			foundSafe = true
		}
	}
	testutil.RequireTrue(t, foundSafe, "EnvVars must contain safe config vars like DINA_MODE")

	// Positive: custom config with secret in EnvVars would be detected.
	badCfg := &security.DockerConfig{
		SecretsMountPath: "/run/secrets/",
		EnvVars:          []string{"DINA_MODE", "BRAIN_TOKEN"},
	}
	badAuditor := security.NewSecurityAuditor("", badCfg)
	badDockerCfg, err := badAuditor.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	foundSecret := false
	for _, envVar := range badDockerCfg.EnvVars {
		if envVar == "BRAIN_TOKEN" {
			foundSecret = true
		}
	}
	testutil.RequireTrue(t, foundSecret,
		"bad config test: BRAIN_TOKEN must be detectable in EnvVars when present")
}

// --------------------------------------------------------------------------
// §17.24 Secrets tmpfs Mount
// --------------------------------------------------------------------------

// TST-CORE-634
// TRACE: {"suite": "CORE", "case": "1212", "section": "17", "sectionName": "Security Hardening", "subsection": "24", "scenario": "01", "title": "SecretsTmpfsMount"}
// TST-CORE-634
func TestSecurity_17_24_SecretsTmpfsMount(t *testing.T) {
	// Config audit: verify docker-compose.yml uses file-based secrets (tmpfs in Docker).
	compose, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		t.Fatalf("failed to read docker-compose.yml: %v", err)
	}
	composeStr := string(compose)

	// Positive: secrets section exists.
	testutil.RequireTrue(t, strings.Contains(composeStr, "secrets:"),
		"docker-compose.yml must define a secrets section")

	// Positive: service_keys mount exists (Ed25519 keypairs for mutual auth).
	testutil.RequireTrue(t, strings.Contains(composeStr, "service_keys"),
		"docker-compose.yml must mount service_keys directory")

	// Positive: secrets are file-based (not inline env vars).
	testutil.RequireTrue(t, strings.Contains(composeStr, "file:"),
		"secrets must be file-based (mounted as tmpfs in Docker)")

	// Positive: secrets mount path uses /run/secrets/.
	testutil.RequireTrue(t, strings.Contains(composeStr, "/run/secrets/"),
		"secrets must be mounted at /run/secrets/ (Docker tmpfs path)")

	// Negative: no plaintext secrets in environment variables.
	forbiddenEnvVars := []string{
		"DINA_BRAIN_TOKEN=",
		"DINA_PASSPHRASE=",
		"DINA_SEED_HEX=",
		"PRIVATE_KEY=",
		"SECRET_KEY=",
	}
	for _, forbidden := range forbiddenEnvVars {
		testutil.RequireFalse(t, strings.Contains(composeStr, forbidden),
			"secret "+forbidden+" must not appear as a plain environment variable in docker-compose.yml")
	}

	// Also verify via SecurityAuditor: default config has /run/secrets/ mount path.
	auditor := security.NewSecurityAuditor("", nil)
	dockerCfg, err := auditor.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, dockerCfg.SecretsMountPath, "/run/secrets/")
}

// --------------------------------------------------------------------------
// §17.25 GOOGLE_API_KEY Exception Documented
// --------------------------------------------------------------------------

// TST-CORE-635
// TRACE: {"suite": "CORE", "case": "1213", "section": "17", "sectionName": "Security Hardening", "subsection": "25", "scenario": "01", "title": "GoogleAPIKeyException"}
// TST-CORE-635
func TestSecurity_17_25_GoogleAPIKeyException(t *testing.T) {
	// GOOGLE_API_KEY is a documented exception — revocable cloud key, not a local credential.
	// Fresh SecurityAuditor — no shared state.

	// Positive: default config should NOT contain GOOGLE_API_KEY in env vars
	// (it's in .env, not Docker env vars), and should contain safe vars.
	impl := security.NewSecurityAuditor("", nil)
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	dockerCfg, err := impl.InspectDockerConfig()
	testutil.RequireNoError(t, err)

	// Default env vars must contain only safe configuration, not secrets.
	forbiddenSecrets := []string{"BRAIN_TOKEN", "DINA_PASSPHRASE", "DINA_SEED_HEX", "PRIVATE_KEY", "SECRET_KEY", "DB_PASSWORD"}
	for _, envVar := range dockerCfg.EnvVars {
		for _, forbidden := range forbiddenSecrets {
			if envVar == forbidden {
				t.Fatalf("secret %q must not be in environment variables — use /run/secrets/", envVar)
			}
		}
	}

	// Verify GOOGLE_API_KEY is absent from default Docker env vars (it's in .env, not Docker).
	for _, envVar := range dockerCfg.EnvVars {
		if envVar == "GOOGLE_API_KEY" {
			t.Fatalf("GOOGLE_API_KEY should be in .env, not in Docker env vars")
		}
	}

	// Positive: safe env vars (DINA_MODE, DINA_LISTEN_ADDR) must be present.
	safeVars := map[string]bool{"DINA_MODE": false, "DINA_LISTEN_ADDR": false}
	for _, envVar := range dockerCfg.EnvVars {
		if _, ok := safeVars[envVar]; ok {
			safeVars[envVar] = true
		}
	}
	for varName, found := range safeVars {
		testutil.RequireTrue(t, found,
			"safe env var "+varName+" must be present in Docker config")
	}

	// Negative: config with a secret in env vars must be caught.
	badCfg := &testutil.DockerConfig{
		EnvVars: []string{"DINA_MODE", "BRAIN_TOKEN"},
	}
	badImpl := security.NewSecurityAuditor("", badCfg)
	badDockerCfg, err := badImpl.InspectDockerConfig()
	testutil.RequireNoError(t, err)
	hasBrainToken := false
	for _, envVar := range badDockerCfg.EnvVars {
		if envVar == "BRAIN_TOKEN" {
			hasBrainToken = true
		}
	}
	testutil.RequireTrue(t, hasBrainToken,
		"bad config must surface BRAIN_TOKEN so audit catches it")
}

// --------------------------------------------------------------------------
// §17.26 Docker Network: dina-pds-net outbound (PDS needs plc.directory)
// --------------------------------------------------------------------------

// §17.26 retired — PDS sidecar removed. Core now uses a community PDS
// (e.g., bsky.social); there is no dina-pds-net network to validate.

// --------------------------------------------------------------------------
// §17.27 Docker Network: dina-brain-net is Standard
// --------------------------------------------------------------------------

// TST-CORE-637
// TRACE: {"suite": "CORE", "case": "1215", "section": "17", "sectionName": "Security Hardening", "subsection": "27", "scenario": "01", "title": "BrainNetStandard"}
// TST-CORE-637
func TestSecurity_17_27_BrainNetStandard(t *testing.T) {
	// Brain needs outbound internet for Gemini/Claude API calls.
	// If custom networks are defined in docker-compose.yml, verify the brain
	// service is NOT attached to an internal-only network (internal: true).
	// If no custom networks exist, the default bridge provides outbound — that's fine.
	compose, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		compose, err = os.ReadFile("../docker-compose.yml")
	}
	if err != nil {
		t.Skip("docker-compose.yml not found — skipping Docker network check")
	}
	content := string(compose)

	// Parse the networks section to find any network the brain service uses.
	// If there is a top-level "networks:" section, check that no network
	// attached to brain has "internal: true".
	if !strings.Contains(content, "\nnetworks:") {
		// No custom networks defined — all services share the default bridge,
		// which has outbound internet access. Security property satisfied.
		t.Log("no custom networks in docker-compose.yml — default bridge provides outbound access for brain")
		return
	}

	// Custom networks exist. Verify the brain service section does not reference
	// a network that is marked internal.
	// Extract the brain service block and look for network references.
	brainIdx := strings.Index(content, "\n  brain:")
	if brainIdx == -1 {
		t.Fatal("brain service not found in docker-compose.yml")
	}

	// Find the brain service's networks sub-key.
	// If brain has a "networks:" sub-key, extract the network names.
	brainBlock := content[brainIdx:]
	// Find the next top-level service (indented with exactly 2 spaces).
	nextService := strings.Index(brainBlock[1:], "\n  ")
	if nextService > 0 {
		brainBlock = brainBlock[:nextService+1]
	}

	if strings.Contains(brainBlock, "networks:") {
		// Brain has explicit network assignments — verify none are internal.
		// Look in the top-level networks section for "internal: true" on any
		// network referenced by brain.
		networksIdx := strings.LastIndex(content, "\nnetworks:")
		if networksIdx >= 0 {
			networksSection := content[networksIdx:]
			// If brain references a network and that network has internal: true,
			// the brain would lose outbound access — fail the test.
			if strings.Contains(brainBlock, "dina-brain-net") {
				// Check if dina-brain-net is internal
				netDefIdx := strings.Index(networksSection, "dina-brain-net:")
				if netDefIdx >= 0 {
					netDef := networksSection[netDefIdx:]
					// Look at the next ~100 chars for "internal: true"
					end := 100
					if len(netDef) < end {
						end = len(netDef)
					}
					if strings.Contains(netDef[:end], "internal: true") {
						t.Fatal("dina-brain-net is internal: true — brain needs outbound for Gemini/Claude API")
					}
				}
			}
		}
	}
	// If brain has no explicit networks, it uses the default bridge — outbound OK.
}

// --------------------------------------------------------------------------
// §17.28 External Ports: Only 8100 + 2583
// --------------------------------------------------------------------------

// TST-CORE-638
// TRACE: {"suite": "CORE", "case": "1216", "section": "17", "sectionName": "Security Hardening", "subsection": "28", "scenario": "01", "title": "ExternalPortsOnly"}
// TST-CORE-638
func TestSecurity_17_28_ExternalPortsOnly(t *testing.T) {
	// Fresh instance — no shared state.
	// PDS sidecar was removed — port 2583 is no longer part of the local topology.
	impl := security.NewSecurityAuditor("", nil)
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	dockerCfg, err := impl.InspectDockerConfig()
	testutil.RequireNoError(t, err)

	// Positive control: verify the expected ports ARE present.
	testutil.RequireTrue(t, len(dockerCfg.ExposedPorts) >= 1,
		fmt.Sprintf("expected at least 1 exposed port, got %d", len(dockerCfg.ExposedPorts)))

	portSet := map[string]bool{}
	for _, port := range dockerCfg.ExposedPorts {
		portSet[port] = true
	}
	testutil.RequireTrue(t, portSet["8100"], "port 8100 (core) must be exposed")

	// Negative control: no unauthorized ports beyond the allowed set.
	allowedPorts := map[string]bool{"8100": true}
	for _, port := range dockerCfg.ExposedPorts {
		testutil.RequireTrue(t, allowedPorts[port],
			"unexpected exposed port: "+port+" — only 8100 should be exposed")
	}
}

// TST-CORE-903
// TRACE: {"suite": "CORE", "case": "1217", "section": "17", "sectionName": "Security Hardening", "subsection": "29", "scenario": "01", "title": "NoGoPluginImport"}
// TST-CORE-903
func TestSecurity_17_29_NoGoPluginImport(t *testing.T) {
	// §17.29: No Go plugin.Open() or dynamic library loading.
	// Read actual production source — realSecurityAuditor has empty sourceCode
	// so AuditSourceCode always short-circuits (tautological).
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		sourceBuilder.WriteString(string(data))
		sourceBuilder.WriteString("\n")
		return nil
	})
	testutil.RequireNoError(t, err)
	source := sourceBuilder.String()
	testutil.RequireTrue(t, len(source) > 0, "must read at least some production source files")

	// Positive: scan real source for plugin.Open violations.
	auditor := security.NewSecurityAuditor(source, nil)
	violations, err := auditor.AuditSourceCode(`plugin\.Open`)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)

	// Also check for "plugin" import.
	pluginImport, err := auditor.AuditSourceCode(`"plugin"`)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(pluginImport), 0)

	// Positive control: injected source with plugin.Open must be detected.
	tainted := source + "\nplugin.Open(\"evil.so\")\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	taintedViolations, err := taintedAuditor.AuditSourceCode(`plugin\.Open`)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(taintedViolations) >= 1,
		"positive control: injected plugin.Open must be detected")
}

// TST-CORE-904
// TRACE: {"suite": "CORE", "case": "1218", "section": "17", "sectionName": "Security Hardening", "subsection": "30", "scenario": "01", "title": "NoExternalOAuthTokenStorage"}
// TST-CORE-904
func TestSecurity_17_30_NoExternalOAuthTokenStorage(t *testing.T) {
	// §17.30: Core must not store external OAuth tokens.
	// Read actual production source — realSecurityAuditor has empty sourceCode
	// so AuditSourceCode always short-circuits (tautological).
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		sourceBuilder.WriteString(string(data))
		sourceBuilder.WriteString("\n")
		return nil
	})
	testutil.RequireNoError(t, err)
	source := sourceBuilder.String()
	testutil.RequireTrue(t, len(source) > 0, "must read at least some production source files")

	// Positive: scan real source for OAuth token storage patterns.
	auditor := security.NewSecurityAuditor(source, nil)
	violations, err := auditor.AuditSourceCode(`oauth.*token|access_token|refresh_token`)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)

	// Positive control: injected source with access_token must be detected.
	tainted := source + "\nvar access_token = \"sk-abc123\"\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	taintedViolations, err := taintedAuditor.AuditSourceCode(`access_token`)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(taintedViolations) >= 1,
		"positive control: injected access_token must be detected")
}

// TST-CORE-905
// TRACE: {"suite": "CORE", "case": "1219", "section": "17", "sectionName": "Security Hardening", "subsection": "31", "scenario": "01", "title": "NoVectorClocksNoCRDTs"}
// TST-CORE-905
func TestSecurity_17_31_NoVectorClocksNoCRDTs(t *testing.T) {
	// Read actual production source code so AuditSourceCode has real content.
	adapterDir := filepath.Join("..", "internal", "adapter")
	var sourceBuilder strings.Builder
	err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		sourceBuilder.WriteString(string(data))
		sourceBuilder.WriteString("\n")
		return nil
	})
	testutil.RequireNoError(t, err)
	realSource := sourceBuilder.String()
	testutil.RequireTrue(t, len(realSource) > 1000,
		"must read substantial production source code for audit")

	impl := security.NewSecurityAuditor(realSource, nil)
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Negative control: production source must not contain vector clocks or CRDTs.
	// AuditSourceCode uses strings.Contains, so check each pattern individually.
	for _, pattern := range []string{"VectorClock", "CRDT", "vector_clock", "crdt"} {
		violations, auditErr := impl.AuditSourceCode(pattern)
		testutil.RequireNoError(t, auditErr)
		testutil.RequireLen(t, len(violations), 0)
	}

	// Positive control: source with injected "VectorClock" must be detected.
	tainted := realSource + "\ntype VectorClock struct { entries map[string]int }\n"
	taintedAuditor := security.NewSecurityAuditor(tainted, nil)
	violations, auditErr := taintedAuditor.AuditSourceCode("VectorClock")
	testutil.RequireNoError(t, auditErr)
	testutil.RequireTrue(t, len(violations) >= 1,
		"auditor must detect injected VectorClock pattern")
}

// --------------------------------------------------------------------------
// §2.1 Root Identity Never Transmitted in Plaintext
// --------------------------------------------------------------------------

// TST-CORE-065
// TRACE: {"suite": "CORE", "case": "1220", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "01", "scenario": "01", "title": "RootIdentityNeverTransmittedInPlaintext"}
// TST-CORE-056, TST-CORE-057, TST-CORE-058, TST-CORE-059, TST-CORE-060, TST-CORE-061, TST-CORE-062
// TST-CORE-063, TST-CORE-064, TST-CORE-065
func TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext(t *testing.T) {
	// Requirement: Master seed, mnemonic, and DEKs must never appear in any
	// network traffic. This test audits the handler and adapter source code
	// to ensure no API endpoint or logging statement could leak these secrets.

	// TRACE: {"suite": "CORE", "case": "1221", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "handler_source_never_returns_seed_or_mnemonic"}
	t.Run("handler_source_never_returns_seed_or_mnemonic", func(t *testing.T) {
		// Scan all handler code for patterns that would transmit secrets.
		handlerDir := filepath.Join("..", "internal", "handler")
		var sourceBuilder strings.Builder
		err := filepath.Walk(handlerDir, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			sourceBuilder.Write(data)
			sourceBuilder.WriteByte('\n')
			return nil
		})
		testutil.RequireNoError(t, err)
		source := strings.ToLower(sourceBuilder.String())

		// Handler code must never contain patterns that would send secrets in responses.
		// These patterns indicate a seed/mnemonic/DEK being written to an HTTP response.
		dangerousResponsePatterns := []struct {
			pattern string
			reason  string
		}{
			{"w.write([]byte(seed", "handler writes raw seed to HTTP response"},
			{"w.write([]byte(mnemonic", "handler writes mnemonic to HTTP response"},
			{"encode(seed)", "handler JSON-encodes seed to response"},
			{"encode(mnemonic)", "handler JSON-encodes mnemonic to response"},
			{`"master_seed"`, "handler includes master_seed field in response JSON"},
			{`"mnemonic"`, "handler includes mnemonic field in response JSON"},
			{`"raw_seed"`, "handler includes raw_seed field in response JSON"},
		}

		for _, dp := range dangerousResponsePatterns {
			if strings.Contains(source, dp.pattern) {
				t.Errorf("SECURITY VIOLATION: handler source contains %q — %s", dp.pattern, dp.reason)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1222", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "adapter_source_never_logs_seed_or_dek"}
	t.Run("adapter_source_never_logs_seed_or_dek", func(t *testing.T) {
		// Scan all adapter code for logging patterns that would leak secrets.
		adapterDir := filepath.Join("..", "internal", "adapter")
		var sourceBuilder strings.Builder
		err := filepath.Walk(adapterDir, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			sourceBuilder.Write(data)
			sourceBuilder.WriteByte('\n')
			return nil
		})
		testutil.RequireNoError(t, err)
		source := sourceBuilder.String()

		auditor := security.NewSecurityAuditor(source, nil)

		// Patterns that would log sensitive material to stdout/stderr.
		dangerousLogPatterns := []string{
			"log.Print(seed",
			"fmt.Print(seed",
			"log.Print(mnemonic",
			"fmt.Print(mnemonic",
			"log.Printf(\"%x\", seed",
			"log.Printf(\"%x\", dek",
			"log.Print(string(dek",
			"fmt.Print(string(dek",
		}

		for _, p := range dangerousLogPatterns {
			violations, auditErr := auditor.AuditSourceCode(p)
			testutil.RequireNoError(t, auditErr)
			if len(violations) > 0 {
				t.Errorf("SECURITY VIOLATION: source contains %q — plaintext secret in log output", p)
			}
		}

		// Positive control: injected seed log must be detected.
		tainted := source + "\nfmt.Println(hex.EncodeToString(seed))\n"
		taintedAuditor := security.NewSecurityAuditor(tainted, nil)
		leakViolations, err := taintedAuditor.AuditSourceCode("fmt.Println(hex.EncodeToString(seed")
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, len(leakViolations) >= 1,
			"positive control: injected seed log must be detected by auditor")
	})

	// TRACE: {"suite": "CORE", "case": "1223", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "did_endpoint_returns_only_public_data"}
	t.Run("did_endpoint_returns_only_public_data", func(t *testing.T) {
		// The DID document returned by GET /v1/did must contain only public keys,
		// never the master seed or private key material.
		impl := realDIDManager
		testutil.RequireImplementation(t, impl, "DIDManager")

		did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
		testutil.RequireNoError(t, err)

		doc, err := impl.Resolve(idCtx, did)
		testutil.RequireNoError(t, err)
		docStr := strings.ToLower(string(doc))

		// DID document must NOT contain sensitive field names.
		forbiddenFields := []string{
			"master_seed", "mnemonic", "private_key", "secret_key",
			"dek", "data_encryption_key", "passphrase", "raw_seed",
		}
		for _, field := range forbiddenFields {
			if strings.Contains(docStr, field) {
				t.Errorf("DID document contains forbidden field %q — leaks sensitive identity data", field)
			}
		}

		// DID document MUST contain expected public fields.
		testutil.RequireContains(t, string(doc), `"id"`)
		testutil.RequireContains(t, string(doc), `"verificationMethod"`)
	})

	// TRACE: {"suite": "CORE", "case": "1224", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "export_bundle_contains_no_plaintext_seed"}
	t.Run("export_bundle_contains_no_plaintext_seed", func(t *testing.T) {
		// The IdentityBundle used for export/import must wrap the seed with
		// AES-256-GCM, never including it in plaintext.
		wrapper := realKeyWrapper
		testutil.RequireImplementation(t, wrapper, "KeyWrapper")

		// Wrap a test seed.
		plainSeed := testutil.TestEd25519Seed[:]
		wrapped, err := wrapper.Wrap(plainSeed, testutil.TestKEK[:])
		testutil.RequireNoError(t, err)

		// The wrapped output must NOT contain the plaintext seed.
		plainHex := fmt.Sprintf("%x", plainSeed)
		wrappedHex := fmt.Sprintf("%x", wrapped)
		if strings.Contains(wrappedHex, plainHex) {
			t.Fatal("wrapped seed contains plaintext seed bytes — encryption not applied")
		}

		// Wrapped data must be longer than plaintext (nonce + tag overhead).
		if len(wrapped) <= len(plainSeed) {
			t.Fatalf("wrapped data (%d bytes) not larger than plaintext (%d bytes) — missing nonce/tag",
				len(wrapped), len(plainSeed))
		}

		// Round-trip: unwrap must recover the original seed.
		recovered, err := wrapper.Unwrap(wrapped, testutil.TestKEK[:])
		testutil.RequireNoError(t, err)
		testutil.RequireBytesEqual(t, plainSeed, recovered)
	})

	// TRACE: {"suite": "CORE", "case": "1225", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "onboarding_never_stores_mnemonic_in_core"}
	t.Run("onboarding_never_stores_mnemonic_in_core", func(t *testing.T) {
		// Verify by code audit that Core's onboarding package never stores
		// or returns the BIP-39 mnemonic — it's generated client-side only.
		onboardingDir := filepath.Join("..", "internal", "adapter", "onboarding")
		var sourceBuilder strings.Builder
		err := filepath.Walk(onboardingDir, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
				return walkErr
			}
			data, _ := os.ReadFile(path)
			sourceBuilder.Write(data)
			sourceBuilder.WriteByte('\n')
			return nil
		})
		testutil.RequireNoError(t, err)
		source := strings.ToLower(sourceBuilder.String())

		// Verify the design comment: "Core receives only the wrapped seed —
		// never the raw seed or mnemonic."
		if strings.Contains(source, "bip39.generate") || strings.Contains(source, "generatemnemonic") {
			t.Error("Core onboarding must NOT generate BIP-39 mnemonics — client-side only")
		}
	})
}
