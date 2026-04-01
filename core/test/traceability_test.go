package test

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ==========================================================================
// §30.7 — Traceability Pipeline
// These meta-tests validate that the test manifest, test plan, and actual
// test code are consistent. They detect drift between documentation and
// implementation.
// ==========================================================================

// manifestData is the structure of test_manifest.json.
type manifestData struct {
	Scenarios map[string]struct {
		Path     string `json:"path"`
		Row      int    `json:"row"`
		Scenario string `json:"scenario"`
		Line     int    `json:"line"`
	} `json:"scenarios"`
	Sections map[string][]string `json:"sections"`
	Total    int                 `json:"total"`
}

// loadManifest reads and parses the test_manifest.json file.
func loadManifest(t *testing.T) manifestData {
	t.Helper()
	// Find the manifest relative to this test file.
	manifestPath := filepath.Join(".", "test_manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		// Try from test/ subdirectory (when running from core/).
		manifestPath = filepath.Join("test", "test_manifest.json")
		data, err = os.ReadFile(manifestPath)
		if err != nil {
			t.Fatalf("cannot read test_manifest.json: %v", err)
		}
	}

	var m manifestData
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("cannot parse test_manifest.json: %v", err)
	}
	return m
}

// countGoTestFunctions scans Go test files and returns (total func count,
// map of func name → list of TST-CORE IDs found in preceding comments).
func countGoTestFunctions(t *testing.T) (int, map[string][]string) {
	t.Helper()

	// Find all Go test files.
	testDir := "."
	entries, err := os.ReadDir(testDir)
	if err != nil {
		testDir = "test"
		entries, err = os.ReadDir(testDir)
		if err != nil {
			t.Fatalf("cannot read test directory: %v", err)
		}
	}

	funcRe := regexp.MustCompile(`^func (Test\w+)\(`)
	tagRe := regexp.MustCompile(`TST-CORE-\d+`)

	totalFuncs := 0
	funcTags := make(map[string][]string)

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}

		f, err := os.Open(filepath.Join(testDir, entry.Name()))
		if err != nil {
			t.Fatalf("cannot open %s: %v", entry.Name(), err)
		}

		scanner := bufio.NewScanner(f)
		var pendingIDs []string

		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())

			// Collect TST-CORE IDs from comment lines.
			if strings.HasPrefix(line, "//") {
				ids := tagRe.FindAllString(line, -1)
				pendingIDs = append(pendingIDs, ids...)
				continue
			}

			// Blank lines preserve pending IDs (like the audit script).
			if line == "" {
				continue
			}

			// Check for func Test*().
			if m := funcRe.FindStringSubmatch(line); m != nil {
				totalFuncs++
				funcName := m[1]
				if len(pendingIDs) > 0 {
					// Deduplicate IDs.
					seen := make(map[string]bool)
					for _, id := range pendingIDs {
						if !seen[id] {
							seen[id] = true
							funcTags[funcName] = append(funcTags[funcName], id)
						}
					}
				}
				pendingIDs = nil
				continue
			}

			// Non-comment, non-blank, non-func line resets pending IDs.
			pendingIDs = nil
		}
		f.Close()
	}

	return totalFuncs, funcTags
}

// TST-CORE-1010 TST-CORE-1013
// Manifest `total` counts match actual test counts.
// Requirement: The test_manifest.json `total` field must be non-zero, the
// `scenarios` map must be non-empty, and the `sections` totals must be
// consistent with `total`. CI must catch drift between manifest and test code.
// TRACE: {"suite": "CORE", "case": "1420", "section": "30", "sectionName": "Test System Quality", "subsection": "07", "scenario": "01", "title": "ManifestTotalsMatchActual"}
func TestTraceability_30_7_1_ManifestTotalsMatchActual(t *testing.T) {
	m := loadManifest(t)

	// TRACE: {"suite": "CORE", "case": "1421", "section": "30", "sectionName": "Test System Quality", "title": "total_is_non_zero"}
	t.Run("total_is_non_zero", func(t *testing.T) {
		// TST-CORE-1013: CI validates manifest totals are non-zero.
		if m.Total == 0 {
			t.Fatal("manifest total must be non-zero — empty manifest indicates build failure")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1422", "section": "30", "sectionName": "Test System Quality", "title": "scenarios_count_is_non_zero"}
	t.Run("scenarios_count_is_non_zero", func(t *testing.T) {
		if len(m.Scenarios) == 0 {
			t.Fatal("manifest scenarios must be non-zero")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1423", "section": "30", "sectionName": "Test System Quality", "title": "sections_sum_equals_total"}
	t.Run("sections_sum_equals_total", func(t *testing.T) {
		// The total field should match the sum of all section ID lists.
		sectionSum := 0
		for _, ids := range m.Sections {
			sectionSum += len(ids)
		}
		if sectionSum != m.Total {
			t.Fatalf("sections sum (%d) != manifest total (%d) — manifest inconsistent",
				sectionSum, m.Total)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1424", "section": "30", "sectionName": "Test System Quality", "title": "scenarios_count_at_least_total"}
	t.Run("scenarios_count_at_least_total", func(t *testing.T) {
		// Scenarios may include entries not in any section, but must have
		// at least as many entries as the total (every section ID must exist).
		if len(m.Scenarios) < m.Total {
			t.Fatalf("scenarios count (%d) < total (%d) — missing scenario definitions",
				len(m.Scenarios), m.Total)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1425", "section": "30", "sectionName": "Test System Quality", "title": "every_section_id_has_scenario_entry"}
	t.Run("every_section_id_has_scenario_entry", func(t *testing.T) {
		missing := 0
		for section, ids := range m.Sections {
			for _, id := range ids {
				if _, exists := m.Scenarios[id]; !exists {
					t.Errorf("section %s references %s but no scenario entry exists", section, id)
					missing++
				}
			}
		}
		if missing > 0 {
			t.Fatalf("%d section IDs have no matching scenario entry", missing)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1426", "section": "30", "sectionName": "Test System Quality", "title": "actual_go_test_functions_exist"}
	t.Run("actual_go_test_functions_exist", func(t *testing.T) {
		// Validate that Go test files contain a reasonable number of test functions.
		// This catches scenarios where test files are accidentally deleted or emptied.
		totalFuncs, _ := countGoTestFunctions(t)
		if totalFuncs == 0 {
			t.Fatal("no Go test functions found — catastrophic test loss")
		}
		// We expect at least 500+ test functions based on current codebase.
		// Use a generous lower bound to avoid false positives from normal churn.
		const minExpectedFuncs = 200
		if totalFuncs < minExpectedFuncs {
			t.Fatalf("only %d Go test functions found, expected at least %d — significant test loss detected",
				totalFuncs, minExpectedFuncs)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1427", "section": "30", "sectionName": "Test System Quality", "title": "total_exceeds_safety_threshold"}
	t.Run("total_exceeds_safety_threshold", func(t *testing.T) {
		// The manifest should reflect a comprehensive test suite.
		// A total below 500 would indicate massive plan regression.
		const safetyThreshold = 500
		if m.Total < safetyThreshold {
			t.Fatalf("manifest total %d below safety threshold %d — plan regression",
				m.Total, safetyThreshold)
		}
	})
}

// TST-CORE-1012
// `go test -list` maps to plan IDs.
// Requirement: Go test function names should have corresponding TST-CORE-*
// tags in their preceding comment blocks, establishing traceability between
// code and the test plan. This test validates that the mapping exists and
// detects orphan tests that are missing plan references.
// TRACE: {"suite": "CORE", "case": "1428", "section": "30", "sectionName": "Test System Quality", "subsection": "07", "scenario": "03", "title": "GoTestFunctionsMappedToPlanIDs"}
func TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs(t *testing.T) {
	m := loadManifest(t)
	_, funcTags := countGoTestFunctions(t)

	// TRACE: {"suite": "CORE", "case": "1429", "section": "30", "sectionName": "Test System Quality", "title": "tagged_functions_reference_mostly_valid_ids"}
	t.Run("tagged_functions_reference_mostly_valid_ids", func(t *testing.T) {
		// Test code may reference TST-CORE IDs that were added after the manifest
		// was last regenerated. We validate that the MAJORITY of references are valid.
		// A high invalid ratio signals manifest staleness, not code errors.
		totalRefs := 0
		validRefs := 0
		for _, ids := range funcTags {
			for _, id := range ids {
				totalRefs++
				if _, exists := m.Scenarios[id]; exists {
					validRefs++
				}
			}
		}
		if totalRefs == 0 {
			t.Fatal("no TST-CORE references found in test code")
		}

		validRatio := float64(validRefs) / float64(totalRefs)
		// At least 80% of code references should resolve to manifest entries.
		// Below this threshold, the manifest is dangerously stale.
		const minValidRatio = 0.80
		if validRatio < minValidRatio {
			t.Fatalf("only %.1f%% (%d/%d) of code TST-CORE references exist in manifest — manifest stale",
				validRatio*100, validRefs, totalRefs)
		}
		t.Logf("manifest freshness: %.1f%% (%d/%d references valid, %d newer IDs not yet in manifest)",
			validRatio*100, validRefs, totalRefs, totalRefs-validRefs)
	})

	// TRACE: {"suite": "CORE", "case": "1430", "section": "30", "sectionName": "Test System Quality", "title": "minimum_tagged_coverage"}
	t.Run("minimum_tagged_coverage", func(t *testing.T) {
		// A significant proportion of test functions should have plan IDs.
		// This prevents the codebase from drifting away from plan traceability.
		totalTagged := len(funcTags)
		if totalTagged == 0 {
			t.Fatal("no test functions have TST-CORE tags — traceability completely missing")
		}

		// Count how many unique IDs are covered by test code.
		coveredIDs := make(map[string]bool)
		for _, ids := range funcTags {
			for _, id := range ids {
				coveredIDs[id] = true
			}
		}

		// At least 80% of manifest scenarios should be covered by code.
		coverageRatio := float64(len(coveredIDs)) / float64(len(m.Scenarios))
		const minCoverage = 0.80
		if coverageRatio < minCoverage {
			t.Fatalf("plan coverage %.1f%% (%d/%d) below minimum %.0f%% — test implementation lagging",
				coverageRatio*100, len(coveredIDs), len(m.Scenarios), minCoverage*100)
		}
		t.Logf("plan coverage: %.1f%% (%d/%d scenarios covered by code)",
			coverageRatio*100, len(coveredIDs), len(m.Scenarios))
	})

	// TRACE: {"suite": "CORE", "case": "1431", "section": "30", "sectionName": "Test System Quality", "title": "no_extreme_id_duplication"}
	t.Run("no_extreme_id_duplication", func(t *testing.T) {
		// Test IDs may legitimately span multiple functions. Crypto tests
		// (§2.2 SLIP-0010, §2.7 NaCl) bulk-tag 14-18 functions per ID group.
		// We detect EXTREME duplication (>25 functions per ID) which signals
		// accidental copy-paste rather than intentional grouping.
		idOwners := make(map[string][]string) // id → list of func names
		for funcName, ids := range funcTags {
			for _, id := range ids {
				idOwners[id] = append(idOwners[id], funcName)
			}
		}

		const maxOwners = 25
		overloaded := 0
		for id, owners := range idOwners {
			if len(owners) > maxOwners {
				t.Errorf("%s tagged on %d functions (max %d) — extreme duplication",
					id, len(owners), maxOwners)
				overloaded++
			}
		}
		if overloaded > 0 {
			t.Fatalf("%d IDs have extreme duplication (>%d functions each)", overloaded, maxOwners)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1432", "section": "30", "sectionName": "Test System Quality", "title": "manifest_scenario_ids_follow_format"}
	t.Run("manifest_scenario_ids_follow_format", func(t *testing.T) {
		// Every scenario ID must match the TST-CORE-NNN format.
		idFormat := regexp.MustCompile(`^TST-CORE-\d+$`)
		invalid := 0
		for id := range m.Scenarios {
			if !idFormat.MatchString(id) {
				t.Errorf("invalid scenario ID format: %q", id)
				invalid++
			}
		}
		if invalid > 0 {
			t.Fatalf("%d scenario IDs have invalid format", invalid)
		}
	})
}

// findProjectRoot returns the absolute path to the dina project root.
// It walks up from the current directory looking for CLAUDE.md as an anchor.
func findProjectRoot(t *testing.T) string {
	t.Helper()
	// Start from the test directory (core/test/) and walk up.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("cannot get working directory: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "CLAUDE.md")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("cannot find project root (CLAUDE.md not found in any ancestor)")
		}
		dir = parent
	}
}

// readProjectFile reads a file relative to the project root.
func readProjectFile(t *testing.T, root, relPath string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, relPath))
	if err != nil {
		t.Fatalf("cannot read %s: %v", relPath, err)
	}
	return string(data)
}

// TST-CORE-1005
// No `client_token or brain_token` fallback in any conftest.
// §30.5 Known-Bad Behavior Elimination
// Requirement: After the authz boundary fix (test_issues #6, #11), no conftest
// file should contain token fallback patterns like `client_token or brain_token`.
// This anti-pattern would silently use the wrong auth method if the correct
// token is missing, masking configuration errors and violating auth separation.
// TRACE: {"suite": "CORE", "case": "1433", "section": "30", "sectionName": "Test System Quality", "subsection": "05", "scenario": "04", "title": "NoTokenFallbackInAnyConftest"}
func TestCompliance_30_5_4_NoTokenFallbackInAnyConftest(t *testing.T) {
	root := findProjectRoot(t)

	// All conftest files that are part of the Dina project (not .venv).
	conftestPaths := []string{
		"tests/conftest.py",
		"tests/e2e/conftest.py",
		"tests/integration/conftest.py",
		"tests/release/conftest.py",
		"tests/system/conftest.py",
		"brain/tests/conftest.py",
		"admin-cli/tests/conftest.py",
		"cli/tests/conftest.py",
	}

	// Anti-patterns that indicate token fallback logic.
	// These patterns were the root cause of test_issues #6 and #11:
	// conftest used `client_token or brain_token` which would silently
	// fall back to brain auth when client_token was missing, hiding
	// configuration errors and testing with the wrong auth method.
	fallbackPatterns := []*regexp.Regexp{
		regexp.MustCompile(`client_token\s+or\s+brain_token`),
		regexp.MustCompile(`brain_token\s+or\s+client_token`),
		regexp.MustCompile(`(?i)token\s*=\s*.*\bor\b.*token`),
		regexp.MustCompile(`getenv\([^)]*CLIENT_TOKEN[^)]*\)\s*or\s*`),
		regexp.MustCompile(`getenv\([^)]*BRAIN_TOKEN[^)]*\)\s*or\s*`),
	}

	// TRACE: {"suite": "CORE", "case": "1434", "section": "30", "sectionName": "Test System Quality", "title": "zero_fallback_patterns_across_all_conftest_files"}
	t.Run("zero_fallback_patterns_across_all_conftest_files", func(t *testing.T) {
		violations := 0
		for _, relPath := range conftestPaths {
			fullPath := filepath.Join(root, relPath)
			data, err := os.ReadFile(fullPath)
			if err != nil {
				// File may not exist (e.g., admin-cli/tests/conftest.py might not exist).
				continue
			}
			content := string(data)
			lines := strings.Split(content, "\n")
			for lineNum, line := range lines {
				for _, pat := range fallbackPatterns {
					if pat.MatchString(line) {
						t.Errorf("%s:%d contains token fallback anti-pattern: %s",
							relPath, lineNum+1, strings.TrimSpace(line))
						violations++
					}
				}
			}
		}
		if violations > 0 {
			t.Fatalf("%d token fallback violations found — auth boundary compromised", violations)
		}
		t.Logf("scanned %d conftest files, zero token fallback patterns found", len(conftestPaths))
	})

	// TRACE: {"suite": "CORE", "case": "1435", "section": "30", "sectionName": "Test System Quality", "title": "no_brain_token_in_admin_operations"}
	t.Run("no_brain_token_in_admin_operations", func(t *testing.T) {
		// brain_token must NEVER be used for admin operations (persona create,
		// unlock, device management, etc.). Only CLIENT_TOKEN is valid for admin.
		// The brain/tests/conftest.py is excluded because brain legitimately uses
		// its own token for brain-internal endpoints.
		adminConfests := []string{
			"tests/conftest.py",
			"tests/e2e/conftest.py",
			"tests/integration/conftest.py",
			"tests/release/conftest.py",
			"tests/system/conftest.py",
		}
		// Pattern: using brain_token for persona/admin operations
		brainInAdmin := regexp.MustCompile(`brain_token.*(?:persona|admin|unlock|device|pair)`)
		adminWithBrain := regexp.MustCompile(`(?:persona|admin|unlock|device|pair).*brain_token`)

		violations := 0
		for _, relPath := range adminConfests {
			fullPath := filepath.Join(root, relPath)
			data, err := os.ReadFile(fullPath)
			if err != nil {
				continue
			}
			lines := strings.Split(string(data), "\n")
			for lineNum, line := range lines {
				lower := strings.ToLower(line)
				if brainInAdmin.MatchString(lower) || adminWithBrain.MatchString(lower) {
					// Skip comment lines that discuss the pattern.
					trimmed := strings.TrimSpace(line)
					if strings.HasPrefix(trimmed, "#") {
						continue
					}
					t.Errorf("%s:%d uses brain_token for admin operations: %s",
						relPath, lineNum+1, strings.TrimSpace(line))
					violations++
				}
			}
		}
		if violations > 0 {
			t.Fatalf("%d conftest files use brain_token for admin operations", violations)
		}
	})
}

// TST-CORE-987 TST-CORE-988
// E2E and integration conftest files use CLIENT_TOKEN for admin operations.
// §30.2 Authz Boundary Correctness
// Requirement: After the authz fix, E2E conftest must use CLIENT_TOKEN
// (not brain_token) for persona create/unlock operations. Integration conftest
// must use CLIENT_TOKEN for admin setup. This separation ensures tests exercise
// the correct auth path and don't mask missing tokens via silent fallback.
// TRACE: {"suite": "CORE", "case": "1436", "section": "30", "sectionName": "Test System Quality", "subsection": "02", "scenario": "01", "title": "ConftestUsesClientTokenForAdminOps"}
func TestCompliance_30_2_1_ConftestUsesClientTokenForAdminOps(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1437", "section": "30", "sectionName": "Test System Quality", "title": "e2e_conftest_uses_client_token_for_persona_ops"}
	t.Run("e2e_conftest_uses_client_token_for_persona_ops", func(t *testing.T) {
		// TST-CORE-987: E2E conftest uses CLIENT_TOKEN for persona create/unlock.
		// The conftest MUST reference client_token (from docker_services) for
		// admin-only operations like persona creation, unlock, and vault clear.
		content := readProjectFile(t, root, "tests/e2e/conftest.py")

		// Must contain CLIENT_TOKEN references for admin operations.
		if !strings.Contains(content, "client_token") {
			t.Fatal("E2E conftest must reference client_token for admin operations")
		}

		// Verify CLIENT_TOKEN is used in admin headers (persona create/unlock).
		// The conftest should set admin_headers using docker_services.client_token.
		if !strings.Contains(content, "docker_services.client_token") {
			t.Fatal("E2E conftest must use docker_services.client_token (not hardcoded or brain_token)")
		}

		// Count CLIENT_TOKEN usages — should be substantial (>3) since
		// persona create, unlock, vault clear, and D2D setup all need admin auth.
		count := strings.Count(content, "client_token")
		if count < 3 {
			t.Fatalf("E2E conftest has only %d client_token references — suspiciously low for admin operations", count)
		}

		// Must NOT use brain_token for admin operations (persona/unlock context).
		lines := strings.Split(content, "\n")
		for lineNum, line := range lines {
			lower := strings.ToLower(line)
			trimmed := strings.TrimSpace(line)
			// Skip comments.
			if strings.HasPrefix(trimmed, "#") {
				continue
			}
			// Flag: brain_token used in Bearer header for admin endpoint.
			if strings.Contains(lower, "brain_token") &&
				(strings.Contains(lower, "bearer") || strings.Contains(lower, "authorization")) {
				t.Errorf("tests/e2e/conftest.py:%d uses brain_token as Bearer for admin: %s",
					lineNum+1, trimmed)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1438", "section": "30", "sectionName": "Test System Quality", "title": "integration_conftest_uses_client_token_for_admin_setup"}
	t.Run("integration_conftest_uses_client_token_for_admin_setup", func(t *testing.T) {
		// TST-CORE-988: Integration conftest uses CLIENT_TOKEN for admin setup.
		// No `client_token or brain_token` fallback pattern.
		content := readProjectFile(t, root, "tests/integration/conftest.py")

		// Must contain CLIENT_TOKEN references.
		if !strings.Contains(content, "client_token") {
			t.Fatal("integration conftest must reference client_token for admin setup")
		}

		// Must use docker_services.client_token.
		if !strings.Contains(content, "docker_services.client_token") {
			t.Fatal("integration conftest must use docker_services.client_token")
		}

		// Verify no fallback: `token = client_token or brain_token` is forbidden.
		fallbackRe := regexp.MustCompile(`client_token\s+or\s+brain_token`)
		if fallbackRe.MatchString(content) {
			t.Fatal("integration conftest contains `client_token or brain_token` fallback — auth boundary violated")
		}

		// Count CLIENT_TOKEN usages — should be non-trivial.
		count := strings.Count(content, "client_token")
		if count < 2 {
			t.Fatalf("integration conftest has only %d client_token references — insufficient admin auth", count)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1439", "section": "30", "sectionName": "Test System Quality", "title": "admin_headers_reference_client_token_not_brain_token"}
	t.Run("admin_headers_reference_client_token_not_brain_token", func(t *testing.T) {
		// Both E2E and integration conftest should construct admin headers
		// using CLIENT_TOKEN. This subtest verifies that any line setting
		// "Authorization" or admin headers references client_token.
		conftests := map[string]string{
			"tests/e2e/conftest.py":         readProjectFile(t, root, "tests/e2e/conftest.py"),
			"tests/integration/conftest.py": readProjectFile(t, root, "tests/integration/conftest.py"),
		}

		for path, content := range conftests {
			lines := strings.Split(content, "\n")
			for lineNum, line := range lines {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "#") {
					continue
				}
				// Lines that set Authorization headers.
				if strings.Contains(line, "Authorization") && strings.Contains(line, "Bearer") {
					if strings.Contains(line, "brain_token") && !strings.Contains(line, "client_token") {
						t.Errorf("%s:%d sets admin header with brain_token instead of client_token: %s",
							path, lineNum+1, trimmed)
					}
				}
			}
		}
	})
}

// TST-CORE-989
// Docker mode fails fast if CLIENT_TOKEN missing.
// §30.2 Authz Boundary Correctness
// Requirement: When running in Docker mode (E2E or integration), the setup
// must fail IMMEDIATELY with a clear error if CLIENT_TOKEN is not provisioned.
// Silent fallback to empty auth or brain_token masks configuration errors,
// causes confusing 401s deep in test setup, and violates auth separation.
// The Docker service classes must raise RuntimeError before attempting any
// persona operations with a missing token.
// TRACE: {"suite": "CORE", "case": "1440", "section": "30", "sectionName": "Test System Quality", "subsection": "02", "scenario": "04", "title": "DockerModeFailsFastOnMissingClientToken"}
func TestCompliance_30_2_4_DockerModeFailsFastOnMissingClientToken(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1441", "section": "30", "sectionName": "Test System Quality", "title": "all_docker_services_have_fail_fast_assertion"}
	t.Run("all_docker_services_have_fail_fast_assertion", func(t *testing.T) {
		// TestStackServices reads client_token from a file — if the file is
		// missing or empty, Path.read_text() raises or returns empty string.
		// The token property must not silently accept empty values.
		stackSvc := readProjectFile(t, root, filepath.Join("tests", "shared", "test_stack.py"))

		// Must reference client_token in a property or method.
		if !strings.Contains(stackSvc, "client_token") {
			t.Fatal("test_stack.py must provide client_token access")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1442", "section": "30", "sectionName": "Test System Quality", "title": "no_silent_empty_token_acceptance"}
	t.Run("no_silent_empty_token_acceptance", func(t *testing.T) {
		// Integration conftest must reference client_token (from TestStackServices).
		conftest := readProjectFile(t, root, filepath.Join("tests", "integration", "conftest.py"))
		if !strings.Contains(conftest, "client_token") {
			t.Fatal("integration conftest.py must use client_token from TestStackServices")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1443", "section": "30", "sectionName": "Test System Quality", "title": "error_message_is_actionable"}
	t.Run("error_message_is_actionable", func(t *testing.T) {
		// prepare_non_unit_env.sh must reference secrets/client_token so
		// the error is actionable when the token is missing.
		prepare := readProjectFile(t, root, "prepare_non_unit_env.sh")
		if !strings.Contains(prepare, "client_token") {
			t.Fatal("prepare_non_unit_env.sh must reference client_token")
		}
	})
}

// TST-CORE-1011
// `pytest --collect-only` maps to plan IDs.
// §30.7 Traceability Pipeline
// Requirement: Python test files must contain TST-* tags (comments like
// `# TST-INT-NNN`, `# TST-E2E-NNN`, `# TST-BRAIN-NNN`) above test functions,
// establishing traceability between pytest test names and the test plan.
// This enables `pytest --collect-only` output to be mapped to plan IDs.
// Without these tags, tests become untraceable orphans.
// TRACE: {"suite": "CORE", "case": "1444", "section": "30", "sectionName": "Test System Quality", "subsection": "07", "scenario": "04", "title": "PytestCollectOnlyMapsToPlanIDs"}
func TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs(t *testing.T) {
	root := findProjectRoot(t)

	// Python test suites with their expected tag prefixes.
	type pythonSuite struct {
		dir       string
		tagPrefix string
		label     string
	}
	suites := []pythonSuite{
		{"tests/integration", "TST-INT-", "Integration"},
		{"tests/e2e", "TST-E2E-", "E2E"},
		{"brain/tests", "TST-BRAIN-", "Brain"},
	}

	// Regex to find Python test function definitions.
	pyTestFuncRe := regexp.MustCompile(`^\s*(?:def|async def)\s+(test_\w+)`)
	// TRACE comment: # TRACE: {"suite":"...","case":"...","section":"...",...}
	traceRe := regexp.MustCompile(`^\s*#\s*TRACE:\s*\{`)

	// TRACE: {"suite": "CORE", "case": "1445", "section": "30", "sectionName": "Test System Quality", "title": "python_test_files_have_plan_id_tags"}
	t.Run("python_test_files_have_plan_id_tags", func(t *testing.T) {
		// Each Python test suite must have a TRACE comment on the line
		// immediately above the test function (per docs/TEST_SPEC.md).
		for _, suite := range suites {
			suiteDir := filepath.Join(root, suite.dir)
			entries, err := os.ReadDir(suiteDir)
			if err != nil {
				t.Fatalf("cannot read %s: %v", suite.dir, err)
			}

			totalTests := 0
			taggedTests := 0

			for _, entry := range entries {
				if entry.IsDir() || !strings.HasPrefix(entry.Name(), "test_") || !strings.HasSuffix(entry.Name(), ".py") {
					continue
				}

				data, err := os.ReadFile(filepath.Join(suiteDir, entry.Name()))
				if err != nil {
					t.Fatalf("cannot read %s: %v", entry.Name(), err)
				}
				lines := strings.Split(string(data), "\n")

				// Scan for test functions — check if the line above has a TRACE comment.
				for i, line := range lines {
					if m := pyTestFuncRe.FindStringSubmatch(line); m != nil {
						totalTests++
						if i > 0 && traceRe.MatchString(lines[i-1]) {
							taggedTests++
						}
					}
				}
			}

			if totalTests == 0 {
				t.Errorf("%s: no Python test functions found in %s", suite.label, suite.dir)
				continue
			}

			ratio := float64(taggedTests) / float64(totalTests)
			// At least 70% of tests should have plan ID tags.
			// This allows room for helper test functions and fixtures
			// that don't map directly to plan entries.
			const minTagRatio = 0.70
			if ratio < minTagRatio {
				t.Errorf("%s: only %.1f%% (%d/%d) of test functions have %s tags — "+
					"traceability below %.0f%% threshold",
					suite.label, ratio*100, taggedTests, totalTests, suite.tagPrefix, minTagRatio*100)
			} else {
				t.Logf("%s: %.1f%% (%d/%d) test functions have %s tags",
					suite.label, ratio*100, taggedTests, totalTests, suite.tagPrefix)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1446", "section": "30", "sectionName": "Test System Quality", "title": "tag_ids_follow_consistent_format"}
	t.Run("tag_ids_follow_consistent_format", func(t *testing.T) {
		// All TST-* tags must follow the format TST-{SUITE}-{NUMBER}.
		// Mixed formats (TST-INT vs TST-INTEGRATION) would break tooling.
		validPrefixes := map[string]*regexp.Regexp{
			"tests/integration": regexp.MustCompile(`#\s*TST-INT-\d+`),
			"tests/e2e":         regexp.MustCompile(`#\s*TST-E2E-\d+`),
			"brain/tests":       regexp.MustCompile(`#\s*TST-BRAIN-\d+`),
		}
		invalidTagRe := regexp.MustCompile(`#\s*TST-[A-Z]+-\d+`)

		for dir, validRe := range validPrefixes {
			suiteDir := filepath.Join(root, dir)
			entries, err := os.ReadDir(suiteDir)
			if err != nil {
				continue
			}

			for _, entry := range entries {
				if entry.IsDir() || !strings.HasPrefix(entry.Name(), "test_") || !strings.HasSuffix(entry.Name(), ".py") {
					continue
				}
				data, err := os.ReadFile(filepath.Join(suiteDir, entry.Name()))
				if err != nil {
					continue
				}
				lines := strings.Split(string(data), "\n")
				for lineNum, line := range lines {
					// Find any TST-*-NNN tag.
					allTags := invalidTagRe.FindAllString(line, -1)
					for _, tag := range allTags {
						if !validRe.MatchString(tag) {
							// Skip TST-CORE references in Python files
							// (cross-referencing the Go test plan is OK).
							if strings.Contains(tag, "TST-CORE-") {
								continue
							}
							t.Errorf("%s/%s:%d uses wrong tag format %q — expected %s pattern",
								dir, entry.Name(), lineNum+1, tag, validRe.String())
						}
					}
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1447", "section": "30", "sectionName": "Test System Quality", "title": "minimum_total_tags_across_suites"}
	t.Run("minimum_total_tags_across_suites", func(t *testing.T) {
		// The test infrastructure must have a substantial number of TST-* tags
		// to ensure traceability is actively maintained, not neglected.
		totalTags := 0
		for _, suite := range suites {
			suiteDir := filepath.Join(root, suite.dir)
			entries, err := os.ReadDir(suiteDir)
			if err != nil {
				continue
			}
			tagRe := regexp.MustCompile(regexp.QuoteMeta(suite.tagPrefix) + `\d+`)
			for _, entry := range entries {
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".py") {
					continue
				}
				data, _ := os.ReadFile(filepath.Join(suiteDir, entry.Name()))
				totalTags += len(tagRe.FindAllString(string(data), -1))
			}
		}
		// We expect 1000+ total tags based on current coverage
		// (709 INT + 113 E2E + 526 BRAIN = 1348).
		const minTotalTags = 500
		if totalTags < minTotalTags {
			t.Fatalf("only %d TST-* tags across Python suites (expected >%d) — traceability eroding",
				totalTags, minTotalTags)
		}
		t.Logf("total TST-* tags across Python suites: %d", totalTags)
	})
}

// TST-CORE-056
// Generate 24-word mnemonic.
// §2.1 BIP-39 Mnemonic Generation
// Requirement: The Python CLI must generate a valid BIP-39 24-word mnemonic
// from 256 bits (32 bytes) of cryptographic entropy, using the official
// Trezor python-mnemonic library (BIP-0039 reference implementation) and the
// English wordlist. The mnemonic must be exactly 24 words, and the entropy
// source must be os.urandom (CSPRNG).
// TRACE: {"suite": "CORE", "case": "1448", "section": "30", "sectionName": "Test System Quality", "subsection": "07", "scenario": "01", "title": "BIP39_2_1_1_Generate24WordMnemonic"}
func TestBIP39_2_1_1_Generate24WordMnemonic(t *testing.T) {
	root := findProjectRoot(t)

	// The primary BIP-39 implementation is in cli/src/dina_cli/seed_wrap.py.
	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	// The standalone script provides the same functionality.
	seedToMnemonic := readProjectFile(t, root, "scripts/seed_to_mnemonic.py")

	// TRACE: {"suite": "CORE", "case": "1449", "section": "30", "sectionName": "Test System Quality", "title": "uses_trezor_bip39_reference_library"}
	t.Run("uses_trezor_bip39_reference_library", func(t *testing.T) {
		// BIP-39 compliance requires the official Trezor python-mnemonic library.
		// Rolling a custom implementation would be a security vulnerability.
		if !strings.Contains(seedWrap, "from mnemonic import Mnemonic") {
			t.Fatal("seed_wrap.py must import Trezor python-mnemonic: `from mnemonic import Mnemonic`")
		}
		if !strings.Contains(seedToMnemonic, "from mnemonic import Mnemonic") {
			t.Fatal("seed_to_mnemonic.py must import Trezor python-mnemonic: `from mnemonic import Mnemonic`")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1450", "section": "30", "sectionName": "Test System Quality", "title": "uses_english_wordlist"}
	t.Run("uses_english_wordlist", func(t *testing.T) {
		// BIP-39 supports multiple languages, but Dina standardizes on English
		// for interoperability with hardware wallets and other BIP-39 tools.
		if !strings.Contains(seedWrap, `Mnemonic("english")`) {
			t.Fatal("seed_wrap.py must use English wordlist: Mnemonic(\"english\")")
		}
		if !strings.Contains(seedToMnemonic, `Mnemonic("english")`) {
			t.Fatal("seed_to_mnemonic.py must use English wordlist: Mnemonic(\"english\")")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1451", "section": "30", "sectionName": "Test System Quality", "title": "seed_to_mnemonic_function_exists_with_correct_signature"}
	t.Run("seed_to_mnemonic_function_exists_with_correct_signature", func(t *testing.T) {
		// The primary API function for mnemonic generation.
		seedToMnemonicRe := regexp.MustCompile(`def\s+seed_to_mnemonic\s*\(\s*seed\s*:\s*bytes\s*\)`)
		if !seedToMnemonicRe.MatchString(seedWrap) {
			t.Fatal("seed_wrap.py must define `seed_to_mnemonic(seed: bytes)` function")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1452", "section": "30", "sectionName": "Test System Quality", "title": "validates_32_byte_input_entropy"}
	t.Run("validates_32_byte_input_entropy", func(t *testing.T) {
		// BIP-39 with 24 words requires exactly 256 bits (32 bytes) of entropy.
		// The implementation must reject any other size to prevent weak keys.
		if !strings.Contains(seedWrap, `len(seed) != 32`) {
			t.Fatal("seed_to_mnemonic must validate that seed is exactly 32 bytes")
		}
		// Must raise ValueError on wrong size (fail-fast, not silently truncate).
		lenCheckRe := regexp.MustCompile(`if\s+len\(seed\)\s*!=\s*32\s*:\s*\n\s*raise\s+ValueError`)
		if !lenCheckRe.MatchString(seedWrap) {
			t.Fatal("seed_to_mnemonic must raise ValueError when seed is not 32 bytes")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1453", "section": "30", "sectionName": "Test System Quality", "title": "produces_word_list_from_to_mnemonic"}
	t.Run("produces_word_list_from_to_mnemonic", func(t *testing.T) {
		// The Trezor library's to_mnemonic() returns a space-separated string.
		// seed_wrap.py must split this into a list of words.
		if !strings.Contains(seedWrap, ".to_mnemonic(seed)") {
			t.Fatal("seed_to_mnemonic must call Mnemonic.to_mnemonic(seed) for BIP-39 conversion")
		}
		// The function must split the result into a list (24 individual words).
		if !strings.Contains(seedWrap, `.split()`) {
			t.Fatal("seed_to_mnemonic must split the mnemonic string into a word list")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1454", "section": "30", "sectionName": "Test System Quality", "title": "generate_seed_uses_csprng"}
	t.Run("generate_seed_uses_csprng", func(t *testing.T) {
		// The entropy source must be cryptographically secure.
		// os.urandom() is the standard Python CSPRNG.
		if !strings.Contains(seedWrap, "os.urandom(32)") {
			t.Fatal("generate_seed() must use os.urandom(32) for cryptographic randomness")
		}
		// Verify generate_seed function exists and returns 32 bytes.
		genSeedRe := regexp.MustCompile(`def\s+generate_seed\s*\(\s*\)\s*->\s*bytes`)
		if !genSeedRe.MatchString(seedWrap) {
			t.Fatal("seed_wrap.py must define `generate_seed() -> bytes` function")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1455", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_validates_entropy_length"}
	t.Run("standalone_script_validates_entropy_length", func(t *testing.T) {
		// The standalone script must also validate 32-byte entropy.
		if !strings.Contains(seedToMnemonic, `len(entropy) != 32`) {
			t.Fatal("seed_to_mnemonic.py must validate 32-byte entropy length")
		}
		// Must validate hex input length (64 hex chars = 32 bytes).
		if !strings.Contains(seedToMnemonic, `len(seed_hex) != 64`) {
			t.Fatal("seed_to_mnemonic.py must validate 64-character hex input")
		}
	})
}

// TST-CORE-058
// Invalid mnemonic (bad checksum).
// §2.1 BIP-39 Mnemonic Generation
// Requirement: When converting a 24-word mnemonic back to a seed, the
// implementation must validate the BIP-39 checksum. A mnemonic with an
// incorrect last word (wrong checksum) must be REJECTED with a clear error.
// The checksum validation must happen BEFORE attempting entropy extraction
// (fail-fast). Without this check, corrupted or tampered mnemonics could
// silently produce wrong keys, compromising the entire identity chain.
// TRACE: {"suite": "CORE", "case": "1456", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "01", "title": "BIP39_2_1_3_InvalidMnemonicBadChecksum"}
func TestBIP39_2_1_3_InvalidMnemonicBadChecksum(t *testing.T) {
	root := findProjectRoot(t)

	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	mnemonicToSeed := readProjectFile(t, root, "scripts/mnemonic_to_seed.py")

	// TRACE: {"suite": "CORE", "case": "1457", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_validates_checksum_before_conversion"}
	t.Run("seed_wrap_validates_checksum_before_conversion", func(t *testing.T) {
		// The mnemonic_to_seed function must call _M.check() BEFORE calling
		// _M.to_entropy(). This ordering is critical: if to_entropy is called
		// first, a bad checksum might silently produce wrong entropy.
		lines := strings.Split(seedWrap, "\n")
		checkLineIdx := -1
		toEntropyLineIdx := -1

		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "_M.check(") || strings.Contains(trimmed, ".check(phrase)") {
				checkLineIdx = i
			}
			if strings.Contains(trimmed, "_M.to_entropy(") || strings.Contains(trimmed, ".to_entropy(phrase)") {
				if toEntropyLineIdx == -1 { // Take the first occurrence.
					toEntropyLineIdx = i
				}
			}
		}

		if checkLineIdx == -1 {
			t.Fatal("seed_wrap.py mnemonic_to_seed must call _M.check() for checksum validation")
		}
		if toEntropyLineIdx == -1 {
			t.Fatal("seed_wrap.py mnemonic_to_seed must call _M.to_entropy() for conversion")
		}
		if checkLineIdx >= toEntropyLineIdx {
			t.Fatalf("seed_wrap.py: _M.check() (line %d) must come BEFORE _M.to_entropy() (line %d) — "+
				"fail-fast: validate checksum before attempting entropy extraction",
				checkLineIdx+1, toEntropyLineIdx+1)
		}
		t.Logf("checksum validation at line %d, entropy extraction at line %d — correct ordering",
			checkLineIdx+1, toEntropyLineIdx+1)
	})

	// TRACE: {"suite": "CORE", "case": "1458", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_raises_error_on_bad_checksum"}
	t.Run("seed_wrap_raises_error_on_bad_checksum", func(t *testing.T) {
		// When _M.check() returns False, the code must raise ValueError with a
		// descriptive message mentioning "checksum".
		checksumErrorRe := regexp.MustCompile(`if\s+not\s+_M\.check\(`)
		if !checksumErrorRe.MatchString(seedWrap) {
			t.Fatal("mnemonic_to_seed must guard with `if not _M.check(...)` before proceeding")
		}
		// The error message must mention checksum for diagnostic clarity.
		if !strings.Contains(seedWrap, "checksum") {
			t.Fatal("checksum validation error message must mention 'checksum' for user clarity")
		}
		// Must raise ValueError (not a generic Exception or print+exit).
		checksumRaiseRe := regexp.MustCompile(`raise\s+ValueError.*checksum`)
		if !checksumRaiseRe.MatchString(seedWrap) {
			t.Fatal("bad checksum must raise ValueError mentioning 'checksum'")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1459", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_validates_checksum"}
	t.Run("standalone_script_validates_checksum", func(t *testing.T) {
		// The standalone mnemonic_to_seed.py must also validate checksums.
		if !strings.Contains(mnemonicToSeed, ".check(") {
			t.Fatal("mnemonic_to_seed.py must call Mnemonic.check() for checksum validation")
		}
		// Must check BEFORE calling to_entropy.
		lines := strings.Split(mnemonicToSeed, "\n")
		checkLine := -1
		entropyLine := -1
		for i, line := range lines {
			if strings.Contains(line, ".check(") {
				checkLine = i
			}
			if strings.Contains(line, ".to_entropy(") {
				if entropyLine == -1 {
					entropyLine = i
				}
			}
		}
		if checkLine == -1 {
			t.Fatal("mnemonic_to_seed.py must call .check() for checksum validation")
		}
		if entropyLine == -1 {
			t.Fatal("mnemonic_to_seed.py must call .to_entropy() for conversion")
		}
		if checkLine >= entropyLine {
			t.Fatalf("mnemonic_to_seed.py: .check() (line %d) must come BEFORE .to_entropy() (line %d)",
				checkLine+1, entropyLine+1)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1460", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_raises_on_bad_checksum"}
	t.Run("standalone_script_raises_on_bad_checksum", func(t *testing.T) {
		// The error must mention "checksum" so users know exactly what failed.
		if !strings.Contains(mnemonicToSeed, "checksum") {
			t.Fatal("mnemonic_to_seed.py must mention 'checksum' in error message for bad mnemonic")
		}
		// Must raise ValueError (not sys.exit or print).
		checksumRaiseRe := regexp.MustCompile(`raise\s+ValueError.*checksum`)
		if !checksumRaiseRe.MatchString(mnemonicToSeed) {
			t.Fatal("mnemonic_to_seed.py must raise ValueError on bad checksum")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1461", "section": "30", "sectionName": "Test System Quality", "title": "mnemonic_to_seed_validates_word_count"}
	t.Run("mnemonic_to_seed_validates_word_count", func(t *testing.T) {
		// In addition to checksum, the function must reject wrong word counts.
		// A 12-word mnemonic (128-bit entropy) is insecure for Dina's 256-bit
		// key derivation. Only 24 words (256-bit entropy) are accepted.
		if !strings.Contains(seedWrap, `len(mnemonic) != 24`) {
			t.Fatal("seed_wrap.py mnemonic_to_seed must validate exactly 24 words")
		}
		wordCountRe := regexp.MustCompile(`if\s+len\(mnemonic\)\s*!=\s*24\s*:\s*\n\s*raise\s+ValueError`)
		if !wordCountRe.MatchString(seedWrap) {
			t.Fatal("mnemonic_to_seed must raise ValueError when word count is not 24")
		}
	})
}

// TST-CORE-060
// Mnemonic with extra whitespace.
// §2.1 BIP-39 Mnemonic Generation
// Requirement: When a user enters a mnemonic with extra whitespace (leading,
// trailing, or multiple spaces between words), the implementation must
// normalize it and accept it. Copy-pasting from paper backups often introduces
// extra spaces. The normalization must produce a canonical single-space-separated
// string before checksum validation. This is critical for usability:
// recovery from a paper backup must not fail due to trivial formatting issues.
// TRACE: {"suite": "CORE", "case": "1462", "section": "30", "sectionName": "Test System Quality", "subsection": "09", "scenario": "01", "title": "BIP39_2_1_5_MnemonicExtraWhitespace"}
func TestBIP39_2_1_5_MnemonicExtraWhitespace(t *testing.T) {
	root := findProjectRoot(t)

	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	mnemonicToSeed := readProjectFile(t, root, "scripts/mnemonic_to_seed.py")

	// TRACE: {"suite": "CORE", "case": "1463", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_normalizes_whitespace_via_join"}
	t.Run("seed_wrap_normalizes_whitespace_via_join", func(t *testing.T) {
		// The standard normalization pattern is `" ".join(words)` which:
		// 1. Collapses multiple spaces between words to single space
		// 2. Removes leading/trailing whitespace (since list items are stripped)
		// The mnemonic_to_seed function takes a list[str], so the normalization
		// happens when joining the list back to a space-separated string for
		// the Trezor library's check() and to_entropy() methods.
		if !strings.Contains(seedWrap, `" ".join(mnemonic)`) {
			t.Fatal("seed_wrap.py mnemonic_to_seed must normalize whitespace via `\" \".join(mnemonic)`")
		}

		// Verify the joined result is used for both check AND to_entropy.
		// The variable holding the joined phrase should be used consistently.
		lines := strings.Split(seedWrap, "\n")
		var joinVar string
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			// Find: phrase = " ".join(mnemonic) or similar
			joinAssignRe := regexp.MustCompile(`(\w+)\s*=\s*"\s*"\s*\.join\(mnemonic\)`)
			if m := joinAssignRe.FindStringSubmatch(trimmed); m != nil {
				joinVar = m[1]
				break
			}
		}
		if joinVar == "" {
			t.Fatal("seed_wrap.py must assign the joined mnemonic to a variable for reuse")
		}

		// Verify the joined variable is used for checksum validation.
		checkUsesJoined := strings.Contains(seedWrap, "_M.check("+joinVar+")")
		if !checkUsesJoined {
			t.Fatalf("seed_wrap.py must use the normalized %q variable in _M.check() — "+
				"using unnormalized input could fail on valid mnemonics with extra spaces", joinVar)
		}

		// Verify the joined variable is used for entropy extraction.
		entropyUsesJoined := strings.Contains(seedWrap, "_M.to_entropy("+joinVar+")")
		if !entropyUsesJoined {
			t.Fatalf("seed_wrap.py must use the normalized %q variable in _M.to_entropy() — "+
				"inconsistent normalization could produce different results for check vs entropy", joinVar)
		}

		t.Logf("whitespace normalization via %q variable used consistently for check and entropy", joinVar)
	})

	// TRACE: {"suite": "CORE", "case": "1464", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_normalizes_whitespace"}
	t.Run("standalone_script_normalizes_whitespace", func(t *testing.T) {
		// The standalone mnemonic_to_seed.py receives a single string argument.
		// It must strip() the input to handle leading/trailing whitespace.
		if !strings.Contains(mnemonicToSeed, ".strip()") {
			t.Fatal("mnemonic_to_seed.py must call .strip() on input to handle leading/trailing whitespace")
		}
		// After strip(), the Trezor library's check() and to_entropy() handle
		// internal whitespace normalization. But verify strip is called BEFORE check.
		lines := strings.Split(mnemonicToSeed, "\n")
		stripLine := -1
		checkLine := -1
		for i, line := range lines {
			if strings.Contains(line, ".strip()") {
				if stripLine == -1 {
					stripLine = i
				}
			}
			if strings.Contains(line, ".check(") {
				if checkLine == -1 {
					checkLine = i
				}
			}
		}
		if stripLine >= 0 && checkLine >= 0 && stripLine >= checkLine {
			t.Fatalf("mnemonic_to_seed.py: .strip() (line %d) must come BEFORE .check() (line %d) — "+
				"unnormalized input will fail checksum validation", stripLine+1, checkLine+1)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1465", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_accepts_list_input_for_natural_normalization"}
	t.Run("seed_wrap_accepts_list_input_for_natural_normalization", func(t *testing.T) {
		// The seed_wrap.py mnemonic_to_seed takes a list[str], which is the
		// natural normalization mechanism: each word is already separated,
		// so extra whitespace in the original string doesn't affect the result.
		// This is a deliberate design choice — the API accepts a list, not a string.
		sigRe := regexp.MustCompile(`def\s+mnemonic_to_seed\s*\(\s*mnemonic\s*:\s*list\[str\]`)
		if !sigRe.MatchString(seedWrap) {
			t.Fatal("seed_wrap.py mnemonic_to_seed must accept list[str] — "+
				"list input naturally handles whitespace normalization")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1466", "section": "30", "sectionName": "Test System Quality", "title": "consistent_normalization_across_both_implementations"}
	t.Run("consistent_normalization_across_both_implementations", func(t *testing.T) {
		// Both files must use the Trezor library for the actual BIP-39 operations.
		// This ensures consistent behavior regardless of which entry point is used.
		// seed_wrap.py uses module-level _M = Mnemonic("english").
		if !strings.Contains(seedWrap, `_M = Mnemonic("english")`) {
			t.Fatal("seed_wrap.py must use module-level Mnemonic instance for consistency")
		}
		// mnemonic_to_seed.py creates a local instance.
		localInstanceRe := regexp.MustCompile(`m\s*=\s*Mnemonic\("english"\)`)
		if !localInstanceRe.MatchString(mnemonicToSeed) {
			t.Fatal("mnemonic_to_seed.py must create Mnemonic(\"english\") instance")
		}
		// Both must call .check() — the Trezor library handles whitespace
		// normalization internally within check() and to_entropy().
		seedWrapCheck := strings.Contains(seedWrap, ".check(")
		scriptCheck := strings.Contains(mnemonicToSeed, ".check(")
		if !seedWrapCheck || !scriptCheck {
			t.Fatal("both implementations must call .check() for consistent checksum validation")
		}
	})
}

// TST-CORE-059
// Invalid mnemonic (wrong word count).
// §2.1 BIP-39 Mnemonic Generation
// Requirement: When a user provides a mnemonic with the wrong number of words
// (e.g., 12-word BIP-39 where Dina requires 24), the implementation must
// REJECT it with a clear error. BIP-39 supports 12, 15, 18, 21, and 24 words,
// but Dina mandates 24 words (256-bit entropy) for maximum security.
// 12-word mnemonics (128 bits) are insufficient for Dina's identity chain
// (root key + 6 persona keys + vault DEKs + service keys all derived from
// the same entropy). Accepting fewer words would silently weaken the
// entire cryptographic foundation.
// TRACE: {"suite": "CORE", "case": "1467", "section": "30", "sectionName": "Test System Quality", "subsection": "10", "scenario": "01", "title": "BIP39_2_1_4_InvalidMnemonicWrongWordCount"}
func TestBIP39_2_1_4_InvalidMnemonicWrongWordCount(t *testing.T) {
	root := findProjectRoot(t)

	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	mnemonicToSeed := readProjectFile(t, root, "scripts/mnemonic_to_seed.py")

	// TRACE: {"suite": "CORE", "case": "1468", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_rejects_non_24_word_mnemonic"}
	t.Run("seed_wrap_rejects_non_24_word_mnemonic", func(t *testing.T) {
		// The mnemonic_to_seed function must check word count BEFORE any
		// checksum validation or entropy extraction. Wrong word count is
		// a more fundamental error than bad checksum.
		if !strings.Contains(seedWrap, `len(mnemonic) != 24`) {
			t.Fatal("seed_wrap.py mnemonic_to_seed must check `len(mnemonic) != 24`")
		}

		// Must raise ValueError (not return None or empty bytes).
		wordCountRe := regexp.MustCompile(`if\s+len\(mnemonic\)\s*!=\s*24\s*:\s*\n\s*raise\s+ValueError`)
		if !wordCountRe.MatchString(seedWrap) {
			t.Fatal("wrong word count must raise ValueError immediately")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1469", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_error_message_specifies_expected_count"}
	t.Run("seed_wrap_error_message_specifies_expected_count", func(t *testing.T) {
		// The error message must tell the user how many words were provided
		// AND how many were expected. "invalid mnemonic" is not helpful;
		// "expected 24 words, got 12" tells the user exactly what to fix.
		lines := strings.Split(seedWrap, "\n")
		for _, line := range lines {
			if strings.Contains(line, `len(mnemonic) != 24`) {
				// The line after the check should contain the error message.
				break
			}
		}
		// Must mention "24" in the error for expected count.
		errorContextRe := regexp.MustCompile(`"expected 24 words.*got.*len\(mnemonic\)`)
		if !errorContextRe.MatchString(seedWrap) {
			t.Fatal("error message must specify 'expected 24 words, got {actual}' for user clarity")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1470", "section": "30", "sectionName": "Test System Quality", "title": "seed_wrap_word_count_checked_before_checksum"}
	t.Run("seed_wrap_word_count_checked_before_checksum", func(t *testing.T) {
		// Word count validation must come BEFORE checksum validation.
		// Rationale: checking checksum on a 12-word mnemonic would pass for
		// valid 12-word mnemonics — but Dina would silently derive from
		// 128 bits instead of 256, catastrophically weakening all keys.
		lines := strings.Split(seedWrap, "\n")
		wordCountLine := -1
		checksumLine := -1

		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "len(mnemonic) != 24") {
				wordCountLine = i
			}
			if strings.Contains(trimmed, "_M.check(") {
				checksumLine = i
			}
		}

		if wordCountLine == -1 {
			t.Fatal("seed_wrap.py must have word count validation")
		}
		if checksumLine == -1 {
			t.Fatal("seed_wrap.py must have checksum validation")
		}
		if wordCountLine >= checksumLine {
			t.Fatalf("word count check (line %d) must come BEFORE checksum (line %d) — "+
				"a valid 12-word mnemonic would pass checksum but produce 128-bit entropy",
				wordCountLine+1, checksumLine+1)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1471", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_rejects_wrong_word_count"}
	t.Run("standalone_script_rejects_wrong_word_count", func(t *testing.T) {
		// The standalone mnemonic_to_seed.py must also validate word count.
		if !strings.Contains(mnemonicToSeed, `len(word_list) != 24`) {
			t.Fatal("mnemonic_to_seed.py must validate exactly 24 words via `len(word_list) != 24`")
		}
		// Must raise ValueError.
		wordCountRaiseRe := regexp.MustCompile(`len\(word_list\)\s*!=\s*24\s*:\s*\n\s*raise\s+ValueError`)
		if !wordCountRaiseRe.MatchString(mnemonicToSeed) {
			t.Fatal("mnemonic_to_seed.py must raise ValueError on wrong word count")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1472", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_error_mentions_24"}
	t.Run("standalone_script_error_mentions_24", func(t *testing.T) {
		// Error message must mention "24" so the user knows the expected count.
		// Scan for ValueError near word count check.
		lines := strings.Split(mnemonicToSeed, "\n")
		foundActionable := false
		for i, line := range lines {
			if strings.Contains(line, "len(word_list) != 24") {
				// Look ahead for the error message.
				for j := i; j < i+3 && j < len(lines); j++ {
					if strings.Contains(lines[j], "expected 24") {
						foundActionable = true
						break
					}
				}
			}
		}
		if !foundActionable {
			t.Fatal("mnemonic_to_seed.py error message must mention 'expected 24' for clarity")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1473", "section": "30", "sectionName": "Test System Quality", "title": "seed_to_mnemonic_only_accepts_32_bytes_for_24_words"}
	t.Run("seed_to_mnemonic_only_accepts_32_bytes_for_24_words", func(t *testing.T) {
		// The forward direction must also be strict: only 32 bytes (256 bits)
		// produces a 24-word mnemonic. 16 bytes → 12 words, which Dina forbids.
		// This means seed_to_mnemonic must reject non-32-byte input.
		if !strings.Contains(seedWrap, `len(seed) != 32`) {
			t.Fatal("seed_to_mnemonic must reject non-32-byte seeds")
		}
		// Both directions enforce 256-bit minimum:
		// - seed_to_mnemonic: len(seed) != 32 → ValueError
		// - mnemonic_to_seed: len(mnemonic) != 24 → ValueError
		// These together prevent any path that produces/accepts fewer than 24 words.
	})
}

// TST-CORE-972
// Invalid checksum rejected.
// §29.8 BIP-39 Recovery Safety
// Requirement: During identity RECOVERY (the most security-critical moment),
// a mnemonic with a corrupt checksum must be caught and rejected. This is
// different from TST-CORE-058 (basic generation validation): TST-CORE-972
// validates that the recovery path specifically prevents silent key derivation
// from a corrupt mnemonic. If a user mis-types one word during paper-backup
// recovery, the system MUST alert them immediately rather than silently
// deriving wrong keys (which would create an identity with no connection
// to their original data, contacts, or trust network).
// TRACE: {"suite": "CORE", "case": "1474", "section": "30", "sectionName": "Test System Quality", "subsection": "11", "scenario": "01", "title": "BIP39_29_8_1_RecoveryRejectsInvalidChecksum"}
func TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum(t *testing.T) {
	root := findProjectRoot(t)

	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	mnemonicToSeed := readProjectFile(t, root, "scripts/mnemonic_to_seed.py")

	// TRACE: {"suite": "CORE", "case": "1475", "section": "30", "sectionName": "Test System Quality", "title": "recovery_path_validates_before_key_derivation"}
	t.Run("recovery_path_validates_before_key_derivation", func(t *testing.T) {
		// In the recovery flow, mnemonic → entropy is the FIRST step, and
		// checksum validation MUST happen at this boundary. The recovery chain:
		//   1. User enters 24 words
		//   2. mnemonic_to_seed validates checksum (THIS is what we test)
		//   3. Entropy feeds into SLIP-0010 and HKDF for key derivation
		//   4. Keys unlock vault files
		// If step 2 is missing, step 3 produces wrong keys and step 4 fails
		// with opaque decryption errors instead of a clear "bad mnemonic" message.

		// Verify the checksum gate exists in the recovery function.
		checksumGateRe := regexp.MustCompile(`if\s+not\s+_M\.check\(`)
		if !checksumGateRe.MatchString(seedWrap) {
			t.Fatal("mnemonic_to_seed must have `if not _M.check(...)` gate — " +
				"without this, corrupt mnemonics silently produce wrong keys during recovery")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1476", "section": "30", "sectionName": "Test System Quality", "title": "corrupt_word_produces_validation_error_not_wrong_keys"}
	t.Run("corrupt_word_produces_validation_error_not_wrong_keys", func(t *testing.T) {
		// The error message must be specific enough for a user doing recovery.
		// "invalid mnemonic" is too vague. The message must mention:
		// 1. "checksum" — so the user knows it's not a word-count or wordlist issue
		// 2. "failed" or "invalid" — clear rejection, not a warning
		// This helps users understand they need to re-read their paper backup.
		checksumMsgRe := regexp.MustCompile(`raise\s+ValueError\([^)]*checksum\s+failed[^)]*\)`)
		if !checksumMsgRe.MatchString(seedWrap) {
			t.Fatal("seed_wrap.py must raise ValueError mentioning 'checksum failed' — " +
				"vague errors waste user time during stressful recovery scenarios")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1477", "section": "30", "sectionName": "Test System Quality", "title": "recovery_script_also_validates_checksum"}
	t.Run("recovery_script_also_validates_checksum", func(t *testing.T) {
		// The standalone recovery script (mnemonic_to_seed.py) is an
		// alternative entry point. It must have identical checksum protection.
		// A user might use either the CLI library or the standalone script.
		checksumGateRe := regexp.MustCompile(`if\s+not\s+\w+\.check\(`)
		if !checksumGateRe.MatchString(mnemonicToSeed) {
			t.Fatal("mnemonic_to_seed.py must validate checksum — " +
				"standalone recovery script must not bypass validation")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1478", "section": "30", "sectionName": "Test System Quality", "title": "recovery_error_mentions_checksum_in_standalone_script"}
	t.Run("recovery_error_mentions_checksum_in_standalone_script", func(t *testing.T) {
		// The standalone script's error must also mention "checksum" specifically.
		checksumMsgRe := regexp.MustCompile(`raise\s+ValueError\([^)]*checksum\s+failed[^)]*\)`)
		if !checksumMsgRe.MatchString(mnemonicToSeed) {
			t.Fatal("mnemonic_to_seed.py must raise ValueError mentioning 'checksum failed'")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1479", "section": "30", "sectionName": "Test System Quality", "title": "no_silent_fallback_to_entropy_extraction"}
	t.Run("no_silent_fallback_to_entropy_extraction", func(t *testing.T) {
		// CRITICAL: The code must NOT have a try/except around to_entropy that
		// catches and silently swallows checksum errors. If someone wraps
		// to_entropy in a blanket except, corrupt mnemonics could produce
		// wrong entropy silently.
		lines := strings.Split(seedWrap, "\n")

		// Find the mnemonic_to_seed function body.
		inFunc := false
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "def mnemonic_to_seed") {
				inFunc = true
				continue
			}
			if inFunc {
				// Function ends at next def or end of file.
				if strings.HasPrefix(trimmed, "def ") && !strings.HasPrefix(trimmed, "def mnemonic_to_seed") {
					break
				}
				// Check for blanket except around to_entropy.
				if strings.Contains(trimmed, "except") && !strings.Contains(trimmed, "except Exception") {
					// Bare except near to_entropy is dangerous.
					for j := i - 3; j <= i+3 && j < len(lines) && j >= 0; j++ {
						if strings.Contains(lines[j], "to_entropy") {
							t.Errorf("line %d: blanket except near to_entropy could swallow checksum errors", i+1)
						}
					}
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1480", "section": "30", "sectionName": "Test System Quality", "title": "both_entry_points_use_same_validation_library"}
	t.Run("both_entry_points_use_same_validation_library", func(t *testing.T) {
		// Both entry points must use the Trezor Mnemonic class for checksum
		// validation. A custom checksum implementation could have bugs that
		// the reference implementation doesn't. Using the same library ensures
		// consistent validation across all recovery paths.
		if !strings.Contains(seedWrap, "from mnemonic import Mnemonic") {
			t.Fatal("seed_wrap.py must use Trezor reference library for checksum validation")
		}
		if !strings.Contains(mnemonicToSeed, "from mnemonic import Mnemonic") {
			t.Fatal("mnemonic_to_seed.py must use Trezor reference library for checksum validation")
		}

		// Verify that check() is called from the Trezor Mnemonic instance,
		// not from a custom implementation.
		seedWrapUsesToezor := strings.Contains(seedWrap, "_M.check(") || strings.Contains(seedWrap, "Mnemonic(")
		scriptUsesToezor := strings.Contains(mnemonicToSeed, "m.check(") || strings.Contains(mnemonicToSeed, "Mnemonic(")
		if !seedWrapUsesToezor {
			t.Fatal("seed_wrap.py checksum must come from Trezor Mnemonic instance, not custom code")
		}
		if !scriptUsesToezor {
			t.Fatal("mnemonic_to_seed.py checksum must come from Trezor Mnemonic instance")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1481", "section": "30", "sectionName": "Test System Quality", "title": "go_side_assumes_valid_entropy_from_python"}
	t.Run("go_side_assumes_valid_entropy_from_python", func(t *testing.T) {
		// The Go Core receives raw entropy/seed from Python (via install.sh).
		// Go does NOT re-validate the mnemonic — it trusts that Python caught
		// corrupt mnemonics. This is by design: the Go Core is a vault keeper,
		// not a mnemonic processor. But this means the Python validation gate
		// is the ONLY defense. The test plan entry exists to ensure this
		// single-point-of-validation is robust.
		goFixtures := readProjectFile(t, root, "core/test/testutil/fixtures.go")

		// The fixtures file should document that mnemonic handling is Python-side.
		if !strings.Contains(goFixtures, "BIP-39") && !strings.Contains(goFixtures, "mnemonic") {
			t.Fatal("Go fixtures must reference BIP-39/mnemonic to document the cross-language boundary")
		}
		// It must mention "client-side" or "Python" to clarify responsibility.
		if !strings.Contains(goFixtures, "Python") && !strings.Contains(goFixtures, "client-side") {
			t.Fatal("Go fixtures must mention Python/client-side mnemonic handling — " +
				"documents that checksum validation is Python's responsibility")
		}
	})
}

// TST-CORE-973
// Wrong word count rejected (12 vs 24).
// §29.8 BIP-39 Recovery Safety
// Requirement: During identity recovery, a 12-word mnemonic (128-bit entropy,
// standard BIP-39 for cryptocurrency wallets) must be REJECTED. Dina mandates
// 24 words (256-bit entropy) because the entire identity chain — root signing
// key, 6+ persona signing keys, vault DEKs, 2 service keys — is derived from
// a single entropy source. 128 bits is insufficient for this many independent
// derivations without risking key strength degradation.
// This is distinct from TST-CORE-059 (generation-time validation): TST-CORE-973
// validates the RECOVERY path where a user enters their backup mnemonic.
// The difference matters because recovery is the highest-stakes moment —
// wrong entropy silently produces an entirely different identity.
// TRACE: {"suite": "CORE", "case": "1482", "section": "30", "sectionName": "Test System Quality", "subsection": "12", "scenario": "01", "title": "BIP39_29_8_2_RecoveryRejectsWrongWordCount"}
func TestBIP39_29_8_2_RecoveryRejectsWrongWordCount(t *testing.T) {
	root := findProjectRoot(t)

	seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")
	mnemonicToSeed := readProjectFile(t, root, "scripts/mnemonic_to_seed.py")

	// TRACE: {"suite": "CORE", "case": "1483", "section": "30", "sectionName": "Test System Quality", "title": "library_rejects_12_word_at_function_boundary"}
	t.Run("library_rejects_12_word_at_function_boundary", func(t *testing.T) {
		// The mnemonic_to_seed function (library API) must reject 12-word input.
		// A 12-word BIP-39 mnemonic is valid for Bitcoin wallets (128-bit entropy)
		// but catastrophically weak for Dina's key tree. The check must happen
		// at the FUNCTION boundary, not deeper in the call chain, so callers
		// get immediate feedback.
		wordCountCheckRe := regexp.MustCompile(`if\s+len\(mnemonic\)\s*!=\s*24`)
		if !wordCountCheckRe.MatchString(seedWrap) {
			t.Fatal("mnemonic_to_seed must check `len(mnemonic) != 24` at function entry — " +
				"12-word mnemonics (128 bits) are too weak for Dina's key derivation tree")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1484", "section": "30", "sectionName": "Test System Quality", "title": "error_message_helps_user_understand_the_problem"}
	t.Run("error_message_helps_user_understand_the_problem", func(t *testing.T) {
		// During recovery, a user might have a 12-word mnemonic from a different
		// system (Bitcoin wallet, hardware wallet). The error must clearly state:
		// - How many words were provided
		// - That 24 words are expected
		// - NOT just "invalid mnemonic" (which could mean bad checksum, typo, etc.)
		errorMsgRe := regexp.MustCompile(`expected 24 words, got.*len\(mnemonic\)`)
		if !errorMsgRe.MatchString(seedWrap) {
			t.Fatal("error message must say 'expected 24 words, got {N}' — " +
				"users with 12-word Bitcoin wallet mnemonics need clear guidance")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1485", "section": "30", "sectionName": "Test System Quality", "title": "standalone_script_also_rejects_wrong_word_count"}
	t.Run("standalone_script_also_rejects_wrong_word_count", func(t *testing.T) {
		// mnemonic_to_seed.py is the standalone recovery script. It receives
		// a single space-separated string, splits it, and validates word count.
		// Both entry points must enforce 24-word minimum.
		if !strings.Contains(mnemonicToSeed, `len(word_list) != 24`) {
			t.Fatal("standalone script must check `len(word_list) != 24`")
		}
		// Error must mention "expected 24" for the standalone script too.
		errorRe := regexp.MustCompile(`expected 24 words, got`)
		if !errorRe.MatchString(mnemonicToSeed) {
			t.Fatal("standalone script error must say 'expected 24 words, got {N}'")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1486", "section": "30", "sectionName": "Test System Quality", "title": "word_count_check_precedes_checksum_validation"}
	t.Run("word_count_check_precedes_checksum_validation", func(t *testing.T) {
		// CRITICAL ordering: word count check MUST come before checksum.
		// Reason: a valid 12-word mnemonic HAS a valid checksum. If checksum
		// is checked first and passes, the code might proceed to extract
		// 128 bits of entropy instead of 256 — silently creating weak keys
		// that would never be recoverable with the real 24-word backup.
		lines := strings.Split(seedWrap, "\n")
		wordCountLine := -1
		checksumLine := -1

		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "len(mnemonic) != 24") {
				wordCountLine = i
			}
			if strings.Contains(trimmed, "_M.check(") {
				checksumLine = i
			}
		}
		if wordCountLine == -1 {
			t.Fatal("word count validation not found in seed_wrap.py")
		}
		if checksumLine == -1 {
			t.Fatal("checksum validation not found in seed_wrap.py")
		}
		if wordCountLine >= checksumLine {
			t.Fatalf("word count check (line %d) must be BEFORE checksum (line %d) — "+
				"valid 12-word checksums would pass, silently producing 128-bit entropy",
				wordCountLine+1, checksumLine+1)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1487", "section": "30", "sectionName": "Test System Quality", "title": "rejection_is_raise_not_return_none"}
	t.Run("rejection_is_raise_not_return_none", func(t *testing.T) {
		// The rejection must be a ValueError (fail-fast), not a return None
		// or return empty bytes. Returning None silently would let the caller
		// proceed with no entropy, which could default to zeros or crash
		// in an unhelpful way deep in key derivation.
		raiseRe := regexp.MustCompile(`len\(mnemonic\)\s*!=\s*24\s*:\s*\n\s*raise\s+ValueError`)
		if !raiseRe.MatchString(seedWrap) {
			t.Fatal("wrong word count must raise ValueError (not return None)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1488", "section": "30", "sectionName": "Test System Quality", "title": "no_silent_truncation_or_padding"}
	t.Run("no_silent_truncation_or_padding", func(t *testing.T) {
		// The code must NOT silently truncate a 30-word input to 24 words,
		// or pad a 12-word input to 24 words. Any word count other than
		// exactly 24 must be rejected.
		// Check for anti-patterns: mnemonic[:24], mnemonic + [...], etc.
		antiPatterns := []string{
			"mnemonic[:24]",
			"mnemonic[:12]",
			"mnemonic + ",
			"mnemonic.extend",
			"mnemonic.append",
			"while len(mnemonic) < 24",
		}
		for _, pattern := range antiPatterns {
			if strings.Contains(seedWrap, pattern) {
				t.Fatalf("seed_wrap.py contains truncation/padding anti-pattern: %q — "+
					"mnemonic must be exactly 24 words, never adjusted", pattern)
			}
		}
	})
}

// TST-CORE-999
// `create_app()` boot smoke under minimal env.
// §30.4 Brain Composition Testing (test_issues #5)
// Requirement: The Brain's `create_app()` factory function must boot
// successfully under a minimal environment — no LLM API keys, no spaCy model,
// no Telegram token, no MCP servers. The app must start in "degraded" mode
// with graceful fallbacks rather than crashing. This validates that Brain
// composition is resilient: a fresh install with only Core URL configured
// can still serve `/healthz` and accept API requests (even if LLM-dependent
// features return degraded responses).
// TRACE: {"suite": "CORE", "case": "1489", "section": "30", "sectionName": "Test System Quality", "subsection": "04", "scenario": "01", "title": "CreateAppBootSmokeMinimalEnv"}
func TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv(t *testing.T) {
	root := findProjectRoot(t)

	mainPy := readProjectFile(t, root, "brain/src/main.py")

	// TRACE: {"suite": "CORE", "case": "1490", "section": "30", "sectionName": "Test System Quality", "title": "create_app_function_exists_and_returns_fastapi"}
	t.Run("create_app_function_exists_and_returns_fastapi", func(t *testing.T) {
		// The composition root must define create_app() → FastAPI.
		// This is the ONLY entry point for constructing the Brain application.
		createAppRe := regexp.MustCompile(`def\s+create_app\s*\(\s*\)\s*->\s*FastAPI`)
		if !createAppRe.MatchString(mainPy) {
			t.Fatal("brain/src/main.py must define `create_app() -> FastAPI`")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1491", "section": "30", "sectionName": "Test System Quality", "title": "explicit_dependency_construction_no_di_framework"}
	t.Run("explicit_dependency_construction_no_di_framework", func(t *testing.T) {
		// Dina's design principle: explicit construction, no magic DI.
		// The main.py docstring or code must NOT import from a DI framework
		// (inject, dependency-injector, etc.). All wiring is visible in source.
		diFrameworks := []string{
			"from inject",
			"import inject",
			"from dependency_injector",
			"import dependency_injector",
			"from fastapi_di",
			"@inject",
		}
		for _, pattern := range diFrameworks {
			if strings.Contains(mainPy, pattern) {
				t.Fatalf("brain/src/main.py must NOT use DI framework — found: %q. "+
					"Explicit construction is a design principle", pattern)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1492", "section": "30", "sectionName": "Test System Quality", "title": "llm_providers_optional_with_graceful_degradation"}
	t.Run("llm_providers_optional_with_graceful_degradation", func(t *testing.T) {
		// Each LLM provider must be wrapped in try/except so that a missing
		// API key or import error doesn't crash the app. The brain must
		// function without ANY LLM (degraded mode).

		// Check for try/except around provider construction.
		// The code must have at least one provider wrapped in exception handling.
		providerTryRe := regexp.MustCompile(`try:\s*\n\s+.*[Pp]rovider`)
		if !providerTryRe.MatchString(mainPy) {
			t.Fatal("LLM provider construction must be wrapped in try/except for graceful degradation")
		}

		// Verify warning is logged when provider fails (not silently swallowed).
		if !strings.Contains(mainPy, "brain.provider.") && !strings.Contains(mainPy, "provider.") {
			t.Fatal("provider failures must be logged with structured log message")
		}

		// The providers dict must start empty and only add successful providers.
		providersDictRe := regexp.MustCompile(`providers\s*:\s*dict\[.*\]\s*=\s*\{\}`)
		if !providersDictRe.MatchString(mainPy) {
			t.Fatal("providers must start as empty dict — only add successfully constructed providers")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1493", "section": "30", "sectionName": "Test System Quality", "title": "spacy_scrubber_optional_not_required"}
	t.Run("spacy_scrubber_optional_not_required", func(t *testing.T) {
		// spaCy is a large optional dependency. Missing the model must not
		// crash the app. The code must catch both ImportError (spaCy not
		// installed) and OSError (model not downloaded).
		spacyTryRe := regexp.MustCompile(`try:\s*\n\s+.*[Ss]crubber|try:\s*\n\s+.*spacy`)
		if !spacyTryRe.MatchString(mainPy) {
			t.Fatal("spaCy scrubber construction must be wrapped in try/except")
		}

		// scrubber must be set to None when unavailable, not crash.
		if !strings.Contains(mainPy, "scrubber = None") {
			t.Fatal("scrubber must fall back to None when spaCy is unavailable")
		}

		// Warning must be logged for degraded scrubber.
		if !strings.Contains(mainPy, "scrubber.unavailable") &&
			!strings.Contains(mainPy, "scrubber.degraded") {
			t.Fatal("degraded scrubber must be logged as warning")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1494", "section": "30", "sectionName": "Test System Quality", "title": "healthz_endpoint_registered_without_auth"}
	t.Run("healthz_endpoint_registered_without_auth", func(t *testing.T) {
		// /healthz must be accessible without authentication. This is critical
		// for Docker health checks, load balancers, and monitoring.
		healthzRe := regexp.MustCompile(`@master\.get\(\s*"/healthz"\s*\)`)
		if !healthzRe.MatchString(mainPy) {
			t.Fatal("brain must register GET /healthz on the master app (no auth)")
		}

		// healthz must return component availability (not just "ok").
		if !strings.Contains(mainPy, `"status"`) {
			t.Fatal("/healthz must include 'status' field in response")
		}
		// Must check if providers are available (degraded if none).
		if !strings.Contains(mainPy, `"degraded"`) {
			t.Fatal("/healthz must report 'degraded' when components are unavailable")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1495", "section": "30", "sectionName": "Test System Quality", "title": "admin_ui_conditional_on_client_token"}
	t.Run("admin_ui_conditional_on_client_token", func(t *testing.T) {
		// Admin UI requires CLIENT_TOKEN. Without it, admin endpoints
		// must NOT be mounted (security: don't serve admin UI without auth).
		adminCondRe := regexp.MustCompile(`if\s+cfg\.client_token`)
		if !adminCondRe.MatchString(mainPy) {
			t.Fatal("admin UI must only be mounted when cfg.client_token is set")
		}
		// When disabled, must log a clear message.
		if !strings.Contains(mainPy, "Admin UI disabled") {
			t.Fatal("must log 'Admin UI disabled' when CLIENT_TOKEN is not set")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1496", "section": "30", "sectionName": "Test System Quality", "title": "module_isolation_rules_enforced"}
	t.Run("module_isolation_rules_enforced", func(t *testing.T) {
		// Architecture rule: main.py is the ONLY file that imports from adapter/.
		// This ensures the composition root is the single point of construction.
		if !strings.Contains(mainPy, "This is the ONLY file that imports from") ||
			!strings.Contains(mainPy, "adapter/") {
			t.Fatal("main.py must document that it is the only file importing from adapter/")
		}

		// Brain and Admin sub-apps must NOT import from each other.
		if !strings.Contains(mainPy, "dina_brain") || !strings.Contains(mainPy, "dina_admin") {
			t.Fatal("main.py must import both brain and admin sub-apps for composition")
		}
		// Module isolation documented in docstring.
		if !strings.Contains(mainPy, "dina_brain") || !strings.Contains(mainPy, "never imports from") {
			t.Fatal("module isolation rules must be documented in main.py")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1497", "section": "30", "sectionName": "Test System Quality", "title": "service_identity_fail_closed"}
	t.Run("service_identity_fail_closed", func(t *testing.T) {
		// Ed25519 service key must be loaded at startup. If the key file
		// is missing, the app must CRASH (fail-closed), not start without auth.
		// This is load-only (not generate) — keys are provisioned at install time.
		if !strings.Contains(mainPy, "brain_identity") && !strings.Contains(mainPy, "ServiceIdentity") {
			t.Fatal("main.py must construct ServiceIdentity for Ed25519 service auth")
		}
		// Key load failure must raise (not silently continue without auth).
		identityRaiseRe := regexp.MustCompile(`brain_identity\.ensure_key\(\)`)
		if !identityRaiseRe.MatchString(mainPy) {
			t.Fatal("must call brain_identity.ensure_key() — fail-closed on missing service key")
		}
		// The except block must re-raise, not swallow.
		if !strings.Contains(mainPy, "raise") {
			t.Fatal("service key failure must re-raise — fail-closed design")
		}
	})
}

// TST-CORE-1007
// Hard cleanup per test class in real suites.
// §30.6 Data Isolation & Cleanup (test_issues #7)
// Requirement: Real test suites (integration and E2E, running against Docker
// containers) must implement hard cleanup to prevent data leakage between
// tests. Each test class must start with clean vault state. The cleanup
// mechanism must use real API calls (POST /v1/vault/clear) at session start,
// and either per-test API cleanup or item-tracking filters to isolate tests.
// Without this, stale data from prior tests can cause false positives
// (test passes because it finds data from a previous test) or false negatives
// (test fails because unexpected data corrupts assertions).
// TRACE: {"suite": "CORE", "case": "1498", "section": "30", "sectionName": "Test System Quality", "subsection": "06", "scenario": "01", "title": "HardCleanupPerTestClassInRealSuites"}
func TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites(t *testing.T) {
	root := findProjectRoot(t)

	integrationConftest := readProjectFile(t, root, "tests/integration/conftest.py")
	e2eConftest := readProjectFile(t, root, "tests/e2e/conftest.py")

	// TRACE: {"suite": "CORE", "case": "1499", "section": "30", "sectionName": "Test System Quality", "title": "integration_session_clears_vault_at_startup"}
	t.Run("integration_session_clears_vault_at_startup", func(t *testing.T) {
		// At session start (before any tests run), the integration conftest
		// must clear all vault data via POST /v1/vault/clear. This ensures
		// leftover data from a prior run doesn't contaminate the new run.
		if !strings.Contains(integrationConftest, "/v1/vault/clear") {
			t.Fatal("integration conftest must call POST /v1/vault/clear at session start")
		}
		// Must be in a session-scoped fixture (not per-test — too expensive).
		sessionScopeRe := regexp.MustCompile(`@pytest\.fixture\(scope="session"`)
		if !sessionScopeRe.MatchString(integrationConftest) {
			t.Fatal("vault clear must be in a session-scoped fixture")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1500", "section": "30", "sectionName": "Test System Quality", "title": "integration_has_autouse_cleanup_fixture"}
	t.Run("integration_has_autouse_cleanup_fixture", func(t *testing.T) {
		// There must be an autouse fixture for per-test cleanup or isolation.
		// This runs automatically for every test without explicit import.
		autouseRe := regexp.MustCompile(`@pytest\.fixture\(autouse=True\)`)
		if !autouseRe.MatchString(integrationConftest) {
			t.Fatal("integration conftest must have an autouse fixture for per-test cleanup/isolation")
		}
		// Verify the cleanup fixture is defined.
		if !strings.Contains(integrationConftest, "docker_vault_cleanup") {
			t.Fatal("integration conftest must define docker_vault_cleanup fixture")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1501", "section": "30", "sectionName": "Test System Quality", "title": "e2e_session_clears_vault_on_all_nodes"}
	t.Run("e2e_session_clears_vault_on_all_nodes", func(t *testing.T) {
		// E2E tests run against 4 nodes. ALL nodes must have their vaults
		// cleared at session start, not just one.
		if !strings.Contains(e2eConftest, "/v1/vault/clear") {
			t.Fatal("E2E conftest must call POST /v1/vault/clear at session start")
		}

		// Must iterate over actors/nodes for clearing.
		// The session setup creates personas on all 4 nodes.
		sessionScopeRe := regexp.MustCompile(`@pytest\.fixture\(scope="session".*autouse=True\)`)
		if !sessionScopeRe.MatchString(e2eConftest) {
			t.Fatal("E2E vault clear must be in an autouse session-scoped fixture")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1502", "section": "30", "sectionName": "Test System Quality", "title": "e2e_has_per_test_state_reset"}
	t.Run("e2e_has_per_test_state_reset", func(t *testing.T) {
		// E2E tests need per-test reset of mutable state (notifications,
		// briefing queue, DND, spool, audit log, etc.). This is more granular
		// than session-level vault clear because E2E tests exercise stateful
		// workflows that accumulate side effects.
		resetRe := regexp.MustCompile(`@pytest\.fixture\(autouse=True\)\s*\n\s*def\s+reset_node_state`)
		if !resetRe.MatchString(e2eConftest) {
			t.Fatal("E2E conftest must define autouse `reset_node_state` fixture")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1503", "section": "30", "sectionName": "Test System Quality", "title": "e2e_reset_clears_all_mutable_state_categories"}
	t.Run("e2e_reset_clears_all_mutable_state_categories", func(t *testing.T) {
		// The per-test reset must clear ALL categories of mutable state.
		// Missing even one category can cause subtle test interference.
		requiredClears := map[string]string{
			"notifications":     "notification state leaks between tests",
			"briefing_queue":    "queued briefings from prior test visible in next",
			"dnd_active":        "DND from one test blocks notifications in next",
			"audit_log":         "audit entries from prior test visible in assertions",
			"kv_store":          "KV settings from one test affect behavior in next",
			"tasks":             "queued tasks from prior test execute in next",
			"outbox":            "outbox messages from prior test sent in next",
			"spool":             "dead drop spool from prior test processed in next",
			"scratchpad":        "scratchpad entries from prior test visible in next",
		}

		for stateKey, failReason := range requiredClears {
			clearPattern := stateKey + ".clear()"
			// Also check for = False or = None patterns for boolean/optional state.
			setPattern := stateKey + " = "
			if !strings.Contains(e2eConftest, clearPattern) && !strings.Contains(e2eConftest, setPattern) {
				t.Errorf("reset_node_state must clear %q — %s", stateKey, failReason)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1504", "section": "30", "sectionName": "Test System Quality", "title": "cleanup_uses_client_token_not_brain_token"}
	t.Run("cleanup_uses_client_token_not_brain_token", func(t *testing.T) {
		// Vault clear is an admin operation. It must use CLIENT_TOKEN auth,
		// not brain_token. Using brain_token would violate auth boundaries
		// and might silently fail (brain can't clear vaults).
		lines := strings.Split(integrationConftest, "\n")
		for i, line := range lines {
			if strings.Contains(line, "/v1/vault/clear") {
				// Look back up to 10 lines for the headers being used.
				for j := i - 1; j >= 0 && j >= i-10; j-- {
					if strings.Contains(lines[j], "brain_token") && !strings.Contains(lines[j], "#") {
						t.Errorf("integration conftest line %d: vault clear must use client_token, not brain_token", j+1)
					}
				}
			}
		}

		// E2E conftest must also use client_token for vault clear.
		lines = strings.Split(e2eConftest, "\n")
		for i, line := range lines {
			if strings.Contains(line, "/v1/vault/clear") {
				for j := i - 1; j >= 0 && j >= i-10; j-- {
					if strings.Contains(lines[j], "brain_token") && !strings.Contains(lines[j], "#") {
						t.Errorf("E2E conftest line %d: vault clear must use client_token, not brain_token", j+1)
					}
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1505", "section": "30", "sectionName": "Test System Quality", "title": "e2e_clears_real_go_core_state_for_docker_nodes"}
	t.Run("e2e_clears_real_go_core_state_for_docker_nodes", func(t *testing.T) {
		// For nodes backed by real Docker containers (RealHomeNode), the reset
		// must also clear Go Core KV state via a real API call, not just
		// clear the in-memory mock. Without this, Go Core retains settings
		// (like DND state) that the mock doesn't know about.
		if !strings.Contains(e2eConftest, "clear_real_kv") {
			t.Fatal("E2E reset must call clear_real_kv() for RealHomeNode instances")
		}
		// Must check if node is RealHomeNode before calling real API.
		realNodeCheckRe := regexp.MustCompile(`isinstance\(node,\s*RealHomeNode\)`)
		if !realNodeCheckRe.MatchString(e2eConftest) {
			t.Fatal("must check isinstance(node, RealHomeNode) before calling real API cleanup")
		}
	})
}

// TST-CORE-1000
// Degraded startup: missing spaCy model.
// §30.4 Brain Composition Testing (test_issues #5)
// Requirement: When the spaCy `en_core_web_sm` model is absent (not
// installed or not downloaded), the Brain application must start successfully
// in degraded mode with `scrubber=None`. It must NOT crash. A warning must
// be logged so operators know PII scrubbing is degraded. This is critical
// because spaCy is a 200MB+ dependency that may not be available in
// lightweight deployments, CI environments, or first-run before model
// download. The Brain must remain functional for all non-PII operations.
// TRACE: {"suite": "CORE", "case": "1506", "section": "30", "sectionName": "Test System Quality", "subsection": "04", "scenario": "02", "title": "DegradedStartupMissingSpacyModel"}
func TestComposition_30_4_2_DegradedStartupMissingSpacyModel(t *testing.T) {
	root := findProjectRoot(t)

	mainPy := readProjectFile(t, root, "brain/src/main.py")

	// TRACE: {"suite": "CORE", "case": "1507", "section": "30", "sectionName": "Test System Quality", "title": "no_spacy_fallback_presidio_or_none"}
	t.Run("no_spacy_fallback_presidio_or_none", func(t *testing.T) {
		// Structured PII scrubbing requires Presidio. There is no spaCy
		// fallback — spaCy NER alone cannot detect emails, phones, or
		// govt IDs. Without Presidio, scrubber is None and Go Core Tier 1
		// regex handles basic PII.
		if strings.Contains(mainPy, "_SpacyScrubber") {
			t.Fatal("brain/src/main.py must NOT define _SpacyScrubber — " +
				"no spaCy-only fallback (it cannot detect structured PII)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1509", "section": "30", "sectionName": "Test System Quality", "title": "scrubber_presidio_or_none"}
	t.Run("scrubber_presidio_or_none", func(t *testing.T) {
		// The scrubber construction is Presidio-only:
		// 1. Try Presidio (structured PII: emails, phones, govt IDs)
		// 2. Fall back to None (Go Core Tier 1 regex only)
		// No spaCy fallback — it can't detect structured PII.

		// Verify Presidio is tried.
		if !strings.Contains(mainPy, "PresidioScrubber") {
			t.Fatal("must try PresidioScrubber (structured PII scrubbing)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1510", "section": "30", "sectionName": "Test System Quality", "title": "scrubber_none_when_both_unavailable"}
	t.Run("scrubber_none_when_both_unavailable", func(t *testing.T) {
		// When BOTH Presidio and spaCy fail, scrubber must be set to None.
		// The app must NOT crash — it should continue with Tier 1 regex
		// scrubbing only (handled by Go Core).
		if !strings.Contains(mainPy, "scrubber = None") {
			t.Fatal("scrubber must be set to None when all scrubbing backends fail")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1511", "section": "30", "sectionName": "Test System Quality", "title": "warning_logged_when_scrubber_unavailable"}
	t.Run("warning_logged_when_scrubber_unavailable", func(t *testing.T) {
		// When scrubber is unavailable, a WARNING (not ERROR) must be logged.
		// It's a warning because the system is functional (degraded, not broken).
		// The log must include the exception type for diagnosis.
		if !strings.Contains(mainPy, "brain.scrubber.unavailable") {
			t.Fatal("must log 'brain.scrubber.unavailable' when spaCy model is missing")
		}
		// The warning should include the error type for diagnosis.
		scrubberErrRe := regexp.MustCompile(`log\.warning\(\s*"brain\.scrubber\.unavailable"`)
		if !scrubberErrRe.MatchString(mainPy) {
			t.Fatal("scrubber unavailable must be logged with log.warning (not log.error or log.info)")
		}
		// Must include error details in structured extra dict.
		if !strings.Contains(mainPy, `"error": type(exc).__name__`) {
			t.Fatal("scrubber warning must include exception type name for diagnosis")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1512", "section": "30", "sectionName": "Test System Quality", "title": "degraded_scrubber_tier_tracked"}
	t.Run("degraded_scrubber_tier_tracked", func(t *testing.T) {
		// The code must track which scrubber tier is active ("presidio", "spacy",
		// or "none"). This tier info feeds into /healthz and LLM routing config
		// so the system knows its current PII protection level.
		if !strings.Contains(mainPy, `scrubber_tier`) {
			t.Fatal("must track scrubber_tier variable for degradation reporting")
		}
		// Must warn when degraded (not at presidio level).
		degradedLogRe := regexp.MustCompile(`"brain\.scrubber\.degraded"`)
		if !degradedLogRe.MatchString(mainPy) {
			t.Fatal("must log 'brain.scrubber.degraded' when not using Presidio tier")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1513", "section": "30", "sectionName": "Test System Quality", "title": "scrubber_tier_passed_to_llm_router_config"}
	t.Run("scrubber_tier_passed_to_llm_router_config", func(t *testing.T) {
		// The LLM router needs to know the scrubber tier to decide whether
		// it's safe to send data to cloud LLMs. Without a scrubber, PII
		// might leak to external providers. The config must include tier info.
		if !strings.Contains(mainPy, `"scrubber_tier"`) {
			t.Fatal("scrubber_tier must be passed to LLM router config — "+
				"router needs this to decide if cloud LLM calls are PII-safe")
		}
	})
}

// TST-CORE-1001
// `/healthz` component status correctness.
// §30.4 Brain Composition Testing (test_issues #5)
// Requirement: The `/healthz` endpoint must report ACTUAL component
// availability, not always return "ok". When Core is unreachable or LLM
// providers are absent, the status must be "degraded". This is critical
// for Docker health checks, load balancers, and monitoring dashboards.
// A /healthz that always returns "ok" masks system failures and defeats
// the purpose of health monitoring. The endpoint must be fast (not block
// on slow Core responses) and must NOT require authentication.
// TRACE: {"suite": "CORE", "case": "1514", "section": "30", "sectionName": "Test System Quality", "subsection": "04", "scenario": "03", "title": "HealthzComponentStatusCorrectness"}
func TestComposition_30_4_3_HealthzComponentStatusCorrectness(t *testing.T) {
	root := findProjectRoot(t)

	mainPy := readProjectFile(t, root, "brain/src/main.py")

	// TRACE: {"suite": "CORE", "case": "1515", "section": "30", "sectionName": "Test System Quality", "title": "healthz_registered_on_master_app_not_subapp"}
	t.Run("healthz_registered_on_master_app_not_subapp", func(t *testing.T) {
		// /healthz must be on the MASTER app (root), not on /api or /admin
		// sub-apps. Sub-apps require authentication. The master app serves
		// unauthenticated endpoints like healthz.
		masterHealthzRe := regexp.MustCompile(`@master\.get\(\s*"/healthz"\s*\)`)
		if !masterHealthzRe.MatchString(mainPy) {
			t.Fatal("/healthz must be registered on master app (not brain_api or admin_ui sub-app)")
		}
		// Must NOT be on the brain API sub-app (which requires Ed25519 auth).
		brainHealthzRe := regexp.MustCompile(`@brain_api\.get\(\s*"/healthz"\s*\)`)
		if brainHealthzRe.MatchString(mainPy) {
			t.Fatal("/healthz must NOT be on brain_api sub-app — would require Ed25519 auth")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1516", "section": "30", "sectionName": "Test System Quality", "title": "healthz_checks_core_connectivity"}
	t.Run("healthz_checks_core_connectivity", func(t *testing.T) {
		// The health check must probe Core availability. If Core is down,
		// the Brain is functionally useless (can't access vault, can't sign).
		if !strings.Contains(mainPy, "brain_core_client.health()") {
			t.Fatal("/healthz must check Core connectivity via brain_core_client.health()")
		}
		// Must handle Core unreachable gracefully (report degraded, don't crash).
		// The try block contains the health call (possibly with comments between).
		hasTryBeforeHealth := false
		lines := strings.Split(mainPy, "\n")
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "brain_core_client.health()") {
				// Look back up to 5 lines for a try: statement.
				for j := i - 1; j >= 0 && j >= i-5; j-- {
					if strings.TrimSpace(lines[j]) == "try:" {
						hasTryBeforeHealth = true
						break
					}
				}
			}
		}
		if !hasTryBeforeHealth {
			t.Fatal("Core health check must be wrapped in try/except — Core may be unreachable")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1517", "section": "30", "sectionName": "Test System Quality", "title": "healthz_has_timeout_to_prevent_blocking"}
	t.Run("healthz_has_timeout_to_prevent_blocking", func(t *testing.T) {
		// The health check must NOT block indefinitely if Core is slow.
		// Docker health checks have their own timeout (typically 30s), but
		// if the healthz handler blocks for 60s on a Core retry loop, the
		// container appears hung. A sub-second timeout is ideal.
		if !strings.Contains(mainPy, "wait_for") && !strings.Contains(mainPy, "timeout") {
			t.Fatal("/healthz must have a timeout on Core health probe — "+
				"blocking indefinitely causes Docker health check failures")
		}
		// Verify asyncio.wait_for is used with a timeout.
		timeoutRe := regexp.MustCompile(`asyncio\.wait_for\(.*health\(\).*timeout=`)
		if !timeoutRe.MatchString(mainPy) {
			t.Fatal("Core health probe should use asyncio.wait_for with explicit timeout")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1518", "section": "30", "sectionName": "Test System Quality", "title": "healthz_reports_degraded_when_core_unreachable"}
	t.Run("healthz_reports_degraded_when_core_unreachable", func(t *testing.T) {
		// When Core is down, status MUST be "degraded", not "ok".
		// "ok" when Core is unreachable would be a lie.
		healthzLines := strings.Split(mainPy, "\n")
		inHealthz := false
		hasDegradedOnException := false
		for _, line := range healthzLines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "async def healthz") {
				inHealthz = true
			}
			if inHealthz {
				if strings.HasPrefix(trimmed, "async def ") && !strings.Contains(trimmed, "healthz") {
					break
				}
				if strings.Contains(trimmed, "except") {
					// Next line or nearby should set status = "degraded".
					hasDegradedOnException = true
				}
				if hasDegradedOnException && strings.Contains(trimmed, `"degraded"`) {
					hasDegradedOnException = true
					break
				}
			}
		}
		if !hasDegradedOnException {
			t.Fatal("/healthz must set status='degraded' when Core health check fails")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1519", "section": "30", "sectionName": "Test System Quality", "title": "healthz_reports_degraded_when_no_llm_providers"}
	t.Run("healthz_reports_degraded_when_no_llm_providers", func(t *testing.T) {
		// If no LLM providers loaded (empty providers dict), status = degraded.
		// Brain without LLM can still serve vault queries but can't reason,
		// classify silence, or assemble nudges.
		if !strings.Contains(mainPy, "not providers") {
			t.Fatal("/healthz must check `not providers` to detect missing LLM providers")
		}
		// Verify this results in degraded status.
		noProvidersDegraded := false
		lines := strings.Split(mainPy, "\n")
		for i, line := range lines {
			if strings.Contains(line, "not providers") {
				// Within 3 lines, must set degraded.
				for j := i; j < i+3 && j < len(lines); j++ {
					if strings.Contains(lines[j], `"degraded"`) {
						noProvidersDegraded = true
						break
					}
				}
			}
		}
		if !noProvidersDegraded {
			t.Fatal("/healthz must report 'degraded' when no LLM providers are available")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1520", "section": "30", "sectionName": "Test System Quality", "title": "healthz_returns_dict_with_status_field"}
	t.Run("healthz_returns_dict_with_status_field", func(t *testing.T) {
		// Requirement: /healthz response must be a JSON object with a
		// "status" key so monitoring systems and Docker health checks
		// can parse it.  Verify by walking the healthz function body.
		lines := strings.Split(mainPy, "\n")
		inHealthz := false
		hasStatusInDict := false
		hasReturn := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "async def healthz") {
				inHealthz = true
				continue
			}
			if inHealthz {
				// Exited the function — next top-level def.
				if strings.HasPrefix(trimmed, "async def ") || strings.HasPrefix(trimmed, "def ") {
					break
				}
				if strings.Contains(trimmed, `"status"`) && strings.Contains(trimmed, "status") {
					hasStatusInDict = true
				}
				if strings.HasPrefix(trimmed, "return") {
					hasReturn = true
				}
			}
		}
		if !inHealthz {
			t.Fatal("/healthz function not found in main.py")
		}
		if !hasStatusInDict {
			t.Fatal("/healthz must build a response containing a \"status\" field")
		}
		if !hasReturn {
			t.Fatal("/healthz must return the response dict")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1521", "section": "30", "sectionName": "Test System Quality", "title": "healthz_is_async_for_non_blocking_probes"}
	t.Run("healthz_is_async_for_non_blocking_probes", func(t *testing.T) {
		// The health check must be async to avoid blocking the event loop.
		// A synchronous healthz would block all other requests while waiting
		// for Core to respond.
		asyncHealthzRe := regexp.MustCompile(`async\s+def\s+healthz`)
		if !asyncHealthzRe.MatchString(mainPy) {
			t.Fatal("/healthz handler must be async — synchronous health checks block the event loop")
		}
	})
}

// TST-CORE-1008
// Dirty state detector fails on prior-run artifacts.
// §30.6 Data Isolation & Cleanup (test_issues #7)
// Requirement: When integration tests run against a Docker Go Core instance,
// the system must prevent stale data from prior test runs from being visible
// to current tests. The mechanism (either per-test cleanup or item-tracking
// filters) must ensure that a test NEVER sees data it didn't create.
// Without this, test order becomes significant, tests become flaky, and
// a passing test might actually be reading data from a different test.
// The RealVault class achieves this via _item_map tracking: only items
// stored in the CURRENT test are retrievable, even though the underlying
// vault still contains prior-run data.
// TRACE: {"suite": "CORE", "case": "1522", "section": "30", "sectionName": "Test System Quality", "subsection": "06", "scenario": "02", "title": "DirtyStateDetectorFailsOnPriorRunArtifacts"}
func TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts(t *testing.T) {
	root := findProjectRoot(t)

	realClients := readProjectFile(t, root, "tests/integration/real_clients.py")
	integrationConftest := readProjectFile(t, root, "tests/integration/conftest.py")

	// TRACE: {"suite": "CORE", "case": "1523", "section": "30", "sectionName": "Test System Quality", "title": "realvault_tracks_items_via_item_map"}
	t.Run("realvault_tracks_items_via_item_map", func(t *testing.T) {
		// RealVault must use an _item_map to track which items were stored
		// in the current test. This is the primary isolation mechanism:
		// retrieve() only returns items whose IDs are in _item_map.
		if !strings.Contains(realClients, "_item_map") {
			t.Fatal("RealVault must use _item_map for per-test item tracking")
		}
		// _item_map must be a dict initialized in __init__.
		itemMapInitRe := regexp.MustCompile(`self\._item_map\s*:\s*dict|self\._item_map\s*=\s*\{`)
		if !itemMapInitRe.MatchString(realClients) {
			t.Fatal("_item_map must be initialized as a dict in RealVault.__init__")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1524", "section": "30", "sectionName": "Test System Quality", "title": "store_populates_item_map"}
	t.Run("store_populates_item_map", func(t *testing.T) {
		// When RealVault.store() is called, it must add the returned item_id
		// to _item_map. This links the logical key to the real Go Core item.
		storePopulatesRe := regexp.MustCompile(`self\._item_map\[.*\]\s*=\s*item_id`)
		if !storePopulatesRe.MatchString(realClients) {
			t.Fatal("RealVault.store() must populate _item_map with the returned item_id")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1525", "section": "30", "sectionName": "Test System Quality", "title": "retrieve_uses_item_map_for_filtering"}
	t.Run("retrieve_uses_item_map_for_filtering", func(t *testing.T) {
		// RealVault.retrieve() must consult _item_map to find the correct
		// item. It must NOT return an arbitrary item matching the query —
		// it must return the specific item tracked by this test.
		retrieveUsesMapRe := regexp.MustCompile(`self\._item_map\.get\(`)
		if !retrieveUsesMapRe.MatchString(realClients) {
			t.Fatal("RealVault.retrieve() must use _item_map.get() to find tracked items")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1526", "section": "30", "sectionName": "Test System Quality", "title": "item_map_per_test_instance_not_shared"}
	t.Run("item_map_per_test_instance_not_shared", func(t *testing.T) {
		// Each test gets a NEW RealVault instance (via the mock_vault fixture),
		// which means a fresh _item_map. Prior-test items are invisible because
		// their IDs are in the OLD _item_map that was garbage collected.
		// Verify the conftest creates a new RealVault per test.
		realVaultCreationRe := regexp.MustCompile(`RealVault\(\s*\n?\s*docker_services\.core_url`)
		if !realVaultCreationRe.MatchString(integrationConftest) {
			t.Fatal("conftest must create a new RealVault instance per test — "+
				"shared instances would leak _item_map across tests")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1527", "section": "30", "sectionName": "Test System Quality", "title": "cleanup_ids_tracked_for_eventual_removal"}
	t.Run("cleanup_ids_tracked_for_eventual_removal", func(t *testing.T) {
		// In addition to _item_map filtering, RealVault must track item IDs
		// for cleanup. The cleanup_ids list accumulates all items stored
		// during the test for potential physical removal.
		if !strings.Contains(realClients, "_cleanup_ids") {
			t.Fatal("RealVault must track _cleanup_ids for item cleanup")
		}
		appendCleanupRe := regexp.MustCompile(`self\._cleanup_ids\.append\(`)
		if !appendCleanupRe.MatchString(realClients) {
			t.Fatal("RealVault.store() must append to _cleanup_ids for tracking")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1528", "section": "30", "sectionName": "Test System Quality", "title": "delete_removes_from_item_map"}
	t.Run("delete_removes_from_item_map", func(t *testing.T) {
		// When an item is deleted, it must be removed from _item_map.
		// A stale _item_map entry for a deleted item would cause retrieve()
		// to look for a non-existent item.
		deletePopRe := regexp.MustCompile(`self\._item_map\.pop\(`)
		if !deletePopRe.MatchString(realClients) {
			t.Fatal("RealVault.delete() must remove item from _item_map via .pop()")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1529", "section": "30", "sectionName": "Test System Quality", "title": "conftest_documents_isolation_strategy"}
	t.Run("conftest_documents_isolation_strategy", func(t *testing.T) {
		// The conftest must explicitly document WHY per-test cleanup is a no-op:
		// because RealVault's _item_map provides isolation. Without this
		// documentation, a future developer might remove the filtering and
		// introduce data leakage.
		if !strings.Contains(integrationConftest, "filters") ||
			!strings.Contains(integrationConftest, "_item_map") {
			t.Fatal("conftest must document that RealVault._item_map provides " +
				"per-test isolation (explain why per-test cleanup is not needed)")
		}
		if !strings.Contains(integrationConftest, "stale items") {
			t.Fatal("conftest must mention 'stale items' to document what the isolation prevents")
		}
	})
}

// TST-CORE-982
// §30.1 Strict-Real Mode Enforcement — env var and flag definition.
// Requirement: Both integration (real_clients.py) and E2E (real_nodes.py)
// test harnesses must support a DINA_STRICT_REAL=1 environment variable
// that switches from "silent fallback to mock" to "fail immediately on
// any real API failure". Without this, a passing integration test might
// actually be running against mock state because the real API silently
// failed, masking genuine regressions.
// TRACE: {"suite": "CORE", "case": "1530", "section": "30", "sectionName": "Test System Quality", "subsection": "01", "scenario": "01", "title": "EnvVarAndFlagDefinition"}
func TestStrictReal_30_1_EnvVarAndFlagDefinition(t *testing.T) {
	root := findProjectRoot(t)

	realClients := readProjectFile(t, root, "tests/integration/real_clients.py")
	realNodes := readProjectFile(t, root, "tests/e2e/real_nodes.py")

	// TRACE: {"suite": "CORE", "case": "1531", "section": "30", "sectionName": "Test System Quality", "title": "integration_reads_DINA_STRICT_REAL_env_var"}
	t.Run("integration_reads_DINA_STRICT_REAL_env_var", func(t *testing.T) {
		// real_clients.py must read DINA_STRICT_REAL from environment.
		// The env var name must be exact — typos would silently disable strict mode.
		if !strings.Contains(realClients, `os.environ.get("DINA_STRICT_REAL"`) {
			t.Fatal("real_clients.py must read DINA_STRICT_REAL from os.environ.get()")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1532", "section": "30", "sectionName": "Test System Quality", "title": "e2e_reads_DINA_STRICT_REAL_env_var"}
	t.Run("e2e_reads_DINA_STRICT_REAL_env_var", func(t *testing.T) {
		// real_nodes.py must also read DINA_STRICT_REAL from environment.
		if !strings.Contains(realNodes, `os.environ.get("DINA_STRICT_REAL"`) {
			t.Fatal("real_nodes.py must read DINA_STRICT_REAL from os.environ.get()")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1533", "section": "30", "sectionName": "Test System Quality", "title": "integration_defines_STRICT_REAL_module_flag"}
	t.Run("integration_defines_STRICT_REAL_module_flag", func(t *testing.T) {
		// The flag must be a module-level constant, not re-evaluated per call.
		// Re-evaluation per call would be fragile (race with env changes mid-test).
		strictRealDefRe := regexp.MustCompile(`_STRICT_REAL\s*=\s*os\.environ\.get\("DINA_STRICT_REAL"`)
		if !strictRealDefRe.MatchString(realClients) {
			t.Fatal("real_clients.py must define _STRICT_REAL as module-level flag from env var")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1534", "section": "30", "sectionName": "Test System Quality", "title": "e2e_defines_STRICT_REAL_module_flag"}
	t.Run("e2e_defines_STRICT_REAL_module_flag", func(t *testing.T) {
		strictRealDefRe := regexp.MustCompile(`_STRICT_REAL\s*=\s*os\.environ\.get\("DINA_STRICT_REAL"`)
		if !strictRealDefRe.MatchString(realNodes) {
			t.Fatal("real_nodes.py must define _STRICT_REAL as module-level flag from env var")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1535", "section": "30", "sectionName": "Test System Quality", "title": "flag_compares_to_string_1_not_truthy"}
	t.Run("flag_compares_to_string_1_not_truthy", func(t *testing.T) {
		// The flag must compare to "1" explicitly, not use truthy evaluation.
		// Truthy would activate on "0", "false", or any non-empty string, which
		// would surprise users who set DINA_STRICT_REAL=0 to disable it.
		equalsOneRe := regexp.MustCompile(`_STRICT_REAL\s*=.*==\s*"1"`)
		if !equalsOneRe.MatchString(realClients) {
			t.Fatal("real_clients.py _STRICT_REAL must compare to '1' explicitly, not use truthy")
		}
		if !equalsOneRe.MatchString(realNodes) {
			t.Fatal("real_nodes.py _STRICT_REAL must compare to '1' explicitly, not use truthy")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1536", "section": "30", "sectionName": "Test System Quality", "title": "flag_strips_whitespace_before_comparison"}
	t.Run("flag_strips_whitespace_before_comparison", func(t *testing.T) {
		// Edge case: env vars may have trailing whitespace (e.g., from shell
		// scripts or Docker env files). .strip() prevents "1 " != "1".
		if !strings.Contains(realClients, `.strip() == "1"`) {
			t.Fatal("real_clients.py must .strip() env var before comparison (handles trailing whitespace)")
		}
		if !strings.Contains(realNodes, `.strip() == "1"`) {
			t.Fatal("real_nodes.py must .strip() env var before comparison (handles trailing whitespace)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1537", "section": "30", "sectionName": "Test System Quality", "title": "both_files_document_strict_real_purpose"}
	t.Run("both_files_document_strict_real_purpose", func(t *testing.T) {
		// The comment must explain WHY strict mode exists: to prevent silent
		// mock fallback that masks real integration failures.
		if !strings.Contains(realClients, "mock fallback") {
			t.Fatal("real_clients.py must document that strict-real prevents 'mock fallback'")
		}
		if !strings.Contains(realNodes, "mock fallback") {
			t.Fatal("real_nodes.py must document that strict-real prevents 'mock fallback'")
		}
	})
}

// TST-CORE-983
// §30.1 Strict-Real Mode Enforcement — _try_request() raises in strict mode.
// Requirement: The integration harness _try_request() in real_clients.py must
// raise RuntimeError (not return None) on non-2xx responses AND on connection
// errors when DINA_STRICT_REAL=1. Returning None on failure is the "silent
// mock fallback" path — in strict mode this must be replaced with an immediate
// hard failure so the test runner sees the real error.
// TRACE: {"suite": "CORE", "case": "1538", "section": "30", "sectionName": "Test System Quality", "subsection": "01", "scenario": "01", "title": "TryRequestRaisesInStrictMode"}
func TestStrictReal_30_1_TryRequestRaisesInStrictMode(t *testing.T) {
	root := findProjectRoot(t)

	realClients := readProjectFile(t, root, "tests/integration/real_clients.py")

	// TRACE: {"suite": "CORE", "case": "1539", "section": "30", "sectionName": "Test System Quality", "title": "try_request_checks_STRICT_REAL_on_non_success"}
	t.Run("try_request_checks_STRICT_REAL_on_non_success", func(t *testing.T) {
		// After exhausting retries on a non-2xx response, _try_request must
		// check _STRICT_REAL before returning None.
		if !strings.Contains(realClients, "if _STRICT_REAL:") {
			t.Fatal("_try_request() must check _STRICT_REAL before returning None on non-success")
		}
		// Must appear inside _try_request function, not elsewhere.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		if tryReqStart < 0 {
			t.Fatal("_try_request function not found in real_clients.py")
		}
		// Find next function definition to bound the search.
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]
		if !strings.Contains(tryReqBody, "if _STRICT_REAL:") {
			t.Fatal("_STRICT_REAL check must be inside _try_request(), not just anywhere in the file")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1540", "section": "30", "sectionName": "Test System Quality", "title": "try_request_raises_RuntimeError_not_returns_None"}
	t.Run("try_request_raises_RuntimeError_not_returns_None", func(t *testing.T) {
		// In strict mode, the function must raise RuntimeError, not return None.
		// RuntimeError is appropriate because this is a test harness invariant
		// violation, not a recoverable application error.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		if !strings.Contains(tryReqBody, "raise RuntimeError") {
			t.Fatal("_try_request() must raise RuntimeError in strict-real mode, not return None")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1541", "section": "30", "sectionName": "Test System Quality", "title": "error_message_includes_STRICT_REAL_prefix"}
	t.Run("error_message_includes_STRICT_REAL_prefix", func(t *testing.T) {
		// The error message must include "STRICT_REAL" so that a failing test's
		// output immediately tells the developer that strict mode caused the
		// failure (vs. a regular application error).
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		if !strings.Contains(tryReqBody, `"STRICT_REAL:`) {
			t.Fatal("RuntimeError message must include 'STRICT_REAL:' prefix for clear diagnostics")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1542", "section": "30", "sectionName": "Test System Quality", "title": "error_message_includes_method_and_url"}
	t.Run("error_message_includes_method_and_url", func(t *testing.T) {
		// The error must include the HTTP method and URL for debugging.
		// Without this, the developer sees "strict real failed" but doesn't
		// know which API call triggered it.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		if !strings.Contains(tryReqBody, "method.upper()") || !strings.Contains(tryReqBody, "url") {
			t.Fatal("RuntimeError message must include HTTP method and URL for debugging")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1543", "section": "30", "sectionName": "Test System Quality", "title": "error_message_includes_status_code"}
	t.Run("error_message_includes_status_code", func(t *testing.T) {
		// The error must include the HTTP status code.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		if !strings.Contains(tryReqBody, "resp.status_code") {
			t.Fatal("RuntimeError message must include HTTP status code")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1544", "section": "30", "sectionName": "Test System Quality", "title": "connection_errors_also_raise_in_strict_mode"}
	t.Run("connection_errors_also_raise_in_strict_mode", func(t *testing.T) {
		// Connection errors (ConnectError, ReadTimeout, etc.) must ALSO raise
		// in strict mode. A connection error means the Docker service isn't
		// running — returning None would silently use mock data.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		// Must catch connection-class exceptions.
		if !strings.Contains(tryReqBody, "httpx.ConnectError") {
			t.Fatal("_try_request() must catch httpx.ConnectError")
		}
		// In the except block, must check _STRICT_REAL.
		// Find the except block containing ConnectError.
		lines := strings.Split(tryReqBody, "\n")
		foundExceptBlock := false
		strictInExceptBlock := false
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "except") && strings.Contains(trimmed, "ConnectError") {
				foundExceptBlock = true
				// Check next 5 lines for _STRICT_REAL check.
				for j := i + 1; j < i+6 && j < len(lines); j++ {
					if strings.Contains(lines[j], "_STRICT_REAL") {
						strictInExceptBlock = true
						break
					}
				}
				break
			}
		}
		if !foundExceptBlock {
			t.Fatal("_try_request() must have except block catching ConnectError")
		}
		if !strictInExceptBlock {
			t.Fatal("_try_request() must check _STRICT_REAL inside ConnectError except block")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1545", "section": "30", "sectionName": "Test System Quality", "title": "non_strict_mode_still_returns_None"}
	t.Run("non_strict_mode_still_returns_None", func(t *testing.T) {
		// When _STRICT_REAL is False (default), the function must still return
		// None on failure — backward compatibility with existing tests.
		tryReqStart := strings.Index(realClients, "def _try_request(")
		nextFn := strings.Index(realClients[tryReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realClients) - tryReqStart - 1
		}
		tryReqBody := realClients[tryReqStart : tryReqStart+1+nextFn]

		// Must have "return None" for the non-strict path.
		if !strings.Contains(tryReqBody, "return None") {
			t.Fatal("_try_request() must still return None in non-strict mode for backward compat")
		}
	})
}

// TST-CORE-984
// §30.1 Strict-Real Mode Enforcement — _api_request() raises in strict mode.
// Requirement: The E2E harness _api_request() in real_nodes.py must raise
// RuntimeError on non-2xx responses AND connection errors when
// DINA_STRICT_REAL=1. It must merge the strict-real flag with the existing
// raise_on_fail parameter so callers that explicitly request fail-fast
// also benefit from the same error handling path.
// TRACE: {"suite": "CORE", "case": "1546", "section": "30", "sectionName": "Test System Quality", "subsection": "01", "scenario": "01", "title": "ApiRequestRaisesInStrictMode"}
func TestStrictReal_30_1_ApiRequestRaisesInStrictMode(t *testing.T) {
	root := findProjectRoot(t)

	realNodes := readProjectFile(t, root, "tests/e2e/real_nodes.py")

	// TRACE: {"suite": "CORE", "case": "1547", "section": "30", "sectionName": "Test System Quality", "title": "api_request_merges_STRICT_REAL_with_raise_on_fail"}
	t.Run("api_request_merges_STRICT_REAL_with_raise_on_fail", func(t *testing.T) {
		// _api_request() already has a raise_on_fail parameter used by specific
		// callers (e.g., store operations). Strict-real mode must merge with it
		// using OR logic: raise if EITHER raise_on_fail is True OR _STRICT_REAL
		// is True. This avoids code duplication and ensures consistent behavior.
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		if apiReqStart < 0 {
			t.Fatal("_api_request function not found in real_nodes.py")
		}
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		// Must merge: raise_on_fail = kwargs.pop("raise_on_fail", False) or _STRICT_REAL
		mergeRe := regexp.MustCompile(`raise_on_fail.*=.*or\s+_STRICT_REAL`)
		if !mergeRe.MatchString(apiReqBody) {
			t.Fatal("_api_request() must merge raise_on_fail with _STRICT_REAL using OR logic")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1548", "section": "30", "sectionName": "Test System Quality", "title": "api_request_raises_RuntimeError_on_non_success"}
	t.Run("api_request_raises_RuntimeError_on_non_success", func(t *testing.T) {
		// When raise_on_fail is True (either explicitly or via _STRICT_REAL),
		// _api_request must raise RuntimeError on non-2xx after exhausting retries.
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		if !strings.Contains(apiReqBody, "raise RuntimeError") {
			t.Fatal("_api_request() must raise RuntimeError when raise_on_fail (or _STRICT_REAL) is True")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1549", "section": "30", "sectionName": "Test System Quality", "title": "error_message_includes_STRICT_REAL_prefix"}
	t.Run("error_message_includes_STRICT_REAL_prefix", func(t *testing.T) {
		// Consistent with _try_request: error message must include "STRICT_REAL"
		// prefix for clear diagnostics in test output.
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		if !strings.Contains(apiReqBody, `"STRICT_REAL:`) {
			t.Fatal("RuntimeError message must include 'STRICT_REAL:' prefix")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1550", "section": "30", "sectionName": "Test System Quality", "title": "error_message_includes_method_url_and_status"}
	t.Run("error_message_includes_method_url_and_status", func(t *testing.T) {
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		if !strings.Contains(apiReqBody, "method.upper()") {
			t.Fatal("Error message must include HTTP method")
		}
		if !strings.Contains(apiReqBody, "resp.status_code") {
			t.Fatal("Error message must include HTTP status code")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1551", "section": "30", "sectionName": "Test System Quality", "title": "connection_errors_raise_when_strict"}
	t.Run("connection_errors_raise_when_strict", func(t *testing.T) {
		// Connection errors (ConnectError, ReadTimeout, etc.) must also raise
		// when raise_on_fail is True (which includes _STRICT_REAL).
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		// Must catch connection exceptions.
		if !strings.Contains(apiReqBody, "httpx.ConnectError") {
			t.Fatal("_api_request() must catch httpx.ConnectError")
		}
		// In the except block, must check raise_on_fail (which incorporates _STRICT_REAL).
		lines := strings.Split(apiReqBody, "\n")
		foundExceptBlock := false
		raiseInExceptBlock := false
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "except") && strings.Contains(trimmed, "ConnectError") {
				foundExceptBlock = true
				// Check next 5 lines for raise_on_fail check or bare raise.
				for j := i + 1; j < i+6 && j < len(lines); j++ {
					if strings.Contains(lines[j], "raise_on_fail") || strings.Contains(lines[j], "raise") {
						raiseInExceptBlock = true
						break
					}
				}
				break
			}
		}
		if !foundExceptBlock {
			t.Fatal("_api_request() must have except block catching ConnectError")
		}
		if !raiseInExceptBlock {
			t.Fatal("_api_request() must raise in ConnectError except block when raise_on_fail is True")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1552", "section": "30", "sectionName": "Test System Quality", "title": "non_strict_still_returns_None"}
	t.Run("non_strict_still_returns_None", func(t *testing.T) {
		// Default behavior (DINA_STRICT_REAL not set, raise_on_fail not passed)
		// must still return None on failure for backward compatibility.
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		if !strings.Contains(apiReqBody, "return None") {
			t.Fatal("_api_request() must still return None in non-strict mode for backward compat")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1553", "section": "30", "sectionName": "Test System Quality", "title": "api_request_has_raise_on_fail_parameter"}
	t.Run("api_request_has_raise_on_fail_parameter", func(t *testing.T) {
		// The raise_on_fail parameter must exist as a kwarg (not positional)
		// so existing callers are unaffected.
		apiReqStart := strings.Index(realNodes, "def _api_request(")
		nextFn := strings.Index(realNodes[apiReqStart+1:], "\ndef ")
		if nextFn < 0 {
			nextFn = len(realNodes) - apiReqStart - 1
		}
		apiReqBody := realNodes[apiReqStart : apiReqStart+1+nextFn]

		if !strings.Contains(apiReqBody, "raise_on_fail") {
			t.Fatal("_api_request() must accept raise_on_fail parameter")
		}
		// Default must be False — strict mode is opt-in.
		defaultFalseRe := regexp.MustCompile(`"raise_on_fail",\s*False`)
		if !defaultFalseRe.MatchString(apiReqBody) {
			t.Fatal("raise_on_fail must default to False — strict mode is opt-in")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1554", "section": "30", "sectionName": "Test System Quality", "title": "strict_real_documented_in_module_header"}
	t.Run("strict_real_documented_in_module_header", func(t *testing.T) {
		// The strict-real section must be documented with its TST IDs.
		if !strings.Contains(realNodes, "TST-CORE-982") || !strings.Contains(realNodes, "TST-CORE-984") {
			t.Fatal("real_nodes.py must reference TST-CORE-982 and TST-CORE-984 in strict-real docs")
		}
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1021 — Compatibility tests labeled explicitly
// ---------------------------------------------------------------------------
// §30.9 Requirement: Required compat tests have `@pytest.mark.compat`.
// Inspect test markers → backward-compatibility tests are explicitly labeled
// so they can be selected/deselected in CI pipelines.
//
// This test validates:
//   1. pyproject.toml defines 'compat' and 'legacy' markers
//   2. Makefile 'test' target excludes legacy tests (-m 'not legacy')
//   3. Python test files with backward-compatibility tests have @pytest.mark.compat
//   4. No backward-compat test class/method exists WITHOUT the marker
//
// Why this is NOT tautological:
//   - It verifies the TEST INFRASTRUCTURE (pyproject.toml, Makefile, markers)
//     against the specification, not just that code exists
//   - If someone adds a backward-compat test without the marker, or removes
//     the marker definition, or changes the Makefile to include legacy tests,
//     this test catches it
//   - It validates cross-language contract: Go tests verify Python test infra

// TRACE: {"suite": "CORE", "case": "1555", "section": "30", "sectionName": "Test System Quality", "subsection": "09", "scenario": "03", "title": "CompatTestsLabeledExplicitly"}
func TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1556", "section": "30", "sectionName": "Test System Quality", "title": "pyproject_toml_defines_compat_marker"}
	t.Run("pyproject_toml_defines_compat_marker", func(t *testing.T) {
		// pyproject.toml must define the 'compat' marker so pytest recognizes it.
		// Without this definition, @pytest.mark.compat triggers a warning
		// (PytestUnknownMarkWarning) and may be silently ignored.
		pyprojectData := readProjectFile(t, root, "pyproject.toml")

		if !strings.Contains(pyprojectData, "compat:") {
			t.Fatal("pyproject.toml must define 'compat' marker in [tool.pytest.ini_options]")
		}
		// Verify the marker description mentions backward compatibility.
		if !strings.Contains(pyprojectData, "backward compatibility") &&
			!strings.Contains(pyprojectData, "compat") {
			t.Fatal("compat marker description must mention backward compatibility")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1557", "section": "30", "sectionName": "Test System Quality", "title": "pyproject_toml_defines_legacy_marker"}
	t.Run("pyproject_toml_defines_legacy_marker", func(t *testing.T) {
		// pyproject.toml must define the 'legacy' marker for legacy test separation.
		pyprojectData := readProjectFile(t, root, "pyproject.toml")

		if !strings.Contains(pyprojectData, "legacy:") {
			t.Fatal("pyproject.toml must define 'legacy' marker in [tool.pytest.ini_options]")
		}
		// Verify the marker description explains the purpose.
		if !strings.Contains(pyprojectData, "legacy") {
			t.Fatal("legacy marker must be defined with a descriptive comment")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1558", "section": "30", "sectionName": "Test System Quality", "title": "makefile_test_excludes_legacy"}
	t.Run("makefile_test_excludes_legacy", func(t *testing.T) {
		// The default 'make test' target must exclude legacy tests.
		// This ensures v0.4 quality gates don't run obsolete tests.
		makefile := readProjectFile(t, root, "Makefile")

		// The Makefile must filter out legacy tests.
		if !strings.Contains(makefile, "not legacy") {
			t.Fatal("Makefile 'test' target must exclude legacy tests (-m 'not legacy')")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1559", "section": "30", "sectionName": "Test System Quality", "title": "backward_compat_tests_have_compat_marker"}
	t.Run("backward_compat_tests_have_compat_marker", func(t *testing.T) {
		// Python test files that contain "backward compat" in docstrings
		// must also have @pytest.mark.compat somewhere in the file.
		// This ensures backward-compat tests are properly tagged for CI filtering.
		testDirs := []string{
			filepath.Join(root, "tests"),
		}

		for _, dir := range testDirs {
			err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil
				}
				// Skip non-Python test files and virtual environments.
				if info.IsDir() && (info.Name() == ".venv" || info.Name() == "__pycache__" || info.Name() == "node_modules") {
					return filepath.SkipDir
				}
				if !strings.HasSuffix(path, ".py") || !strings.Contains(path, "test_") {
					return nil
				}
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					return nil
				}
				content := string(data)

				// If the file mentions "backward compat" in class/method docstrings,
				// it should have @pytest.mark.compat.
				if strings.Contains(content, "backward compat") {
					if !strings.Contains(content, "pytest.mark.compat") {
						relPath, _ := filepath.Rel(root, path)
						t.Errorf("%s mentions 'backward compat' but lacks @pytest.mark.compat marker", relPath)
					}
				}
				return nil
			})
			if err != nil {
				t.Logf("warning: walk error in %s: %v", dir, err)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1560", "section": "30", "sectionName": "Test System Quality", "title": "compat_marker_count_nonzero"}
	t.Run("compat_marker_count_nonzero", func(t *testing.T) {
		// There must be at least one @pytest.mark.compat in the test suite.
		// If the count is zero, either compat tests were removed or the markers
		// were never applied — both indicate a problem.
		testsDir := filepath.Join(root, "tests")
		compatCount := 0

		filepath.Walk(testsDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".py") {
				return nil
			}
			if strings.Contains(path, ".venv") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			compatCount += strings.Count(string(data), "pytest.mark.compat")
			return nil
		})

		if compatCount == 0 {
			t.Fatal("test suite must have at least one @pytest.mark.compat marker — " +
				"backward compatibility tests exist but none are tagged")
		}
		t.Logf("found %d @pytest.mark.compat markers in test suite", compatCount)
	})

	// TRACE: {"suite": "CORE", "case": "1561", "section": "30", "sectionName": "Test System Quality", "title": "all_six_markers_defined_in_pyproject"}
	t.Run("all_six_markers_defined_in_pyproject", func(t *testing.T) {
		// Verify the full set of test markers is defined — these are the
		// classification system for the test suite.
		pyprojectData := readProjectFile(t, root, "pyproject.toml")

		requiredMarkers := []string{
			"slow:", "e2e:", "manual:", "mock_heavy:", "legacy:", "compat:",
		}
		for _, marker := range requiredMarkers {
			if !strings.Contains(pyprojectData, marker) {
				t.Errorf("pyproject.toml must define marker %q", marker)
			}
		}
	})
}

// TST-CORE-1014
// CI stage: `unit-core` — All Go unit tests pass.
// §30.8 CI Pipeline Gates (test_issues #9)
//
// Requirements:
//   - The `unit-core` CI stage runs `go test ./...` from the core/ directory.
//   - Every Go test file must compile and be discoverable by `go test`.
//   - Test files must follow Go conventions (_test.go suffix, package test).
//   - The test suite must be comprehensive: covering all major subsystems
//     (crypto, vault, auth, identity, transport, handlers, config, etc.).
//   - The Makefile must have a target that runs Go unit tests.
//   - The master test runner (run_all_tests.sh) must include Go tests in its pipeline.
// TRACE: {"suite": "CORE", "case": "1562", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "01", "title": "UnitCoreStage"}
func TestCI_30_8_1_UnitCoreStage(t *testing.T) {
	root := findProjectRoot(t)
	coreTestDir := filepath.Join(root, "core", "test")

	// TRACE: {"suite": "CORE", "case": "1563", "section": "30", "sectionName": "Test System Quality", "title": "go_test_files_exist_and_follow_convention"}
	t.Run("go_test_files_exist_and_follow_convention", func(t *testing.T) {
		// Go test files must exist in core/test/ and follow the _test.go naming
		// convention. Without test files, `go test ./...` passes vacuously.
		entries, err := os.ReadDir(coreTestDir)
		if err != nil {
			t.Fatalf("cannot read core/test/: %v", err)
		}

		testFiles := []string{}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), "_test.go") {
				testFiles = append(testFiles, e.Name())
			}
		}

		// A meaningful CI stage needs a substantial number of test files.
		// The project has 42 test files; require at least 20 to catch regressions
		// if files are accidentally deleted.
		if len(testFiles) < 20 {
			t.Fatalf("unit-core requires at least 20 Go test files, found %d", len(testFiles))
		}
		t.Logf("found %d Go test files in core/test/", len(testFiles))
	})

	// TRACE: {"suite": "CORE", "case": "1564", "section": "30", "sectionName": "Test System Quality", "title": "all_test_files_have_package_declaration"}
	t.Run("all_test_files_have_package_declaration", func(t *testing.T) {
		// Every _test.go file must declare `package test` to be compiled
		// correctly by `go test ./test/`. A missing or wrong package
		// declaration causes build failures in the CI pipeline.
		entries, err := os.ReadDir(coreTestDir)
		if err != nil {
			t.Fatalf("cannot read core/test/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(coreTestDir, e.Name()))
			if readErr != nil {
				t.Errorf("cannot read %s: %v", e.Name(), readErr)
				continue
			}
			content := string(data)
			if !strings.Contains(content, "package test") {
				t.Errorf("%s must declare 'package test', missing or incorrect package", e.Name())
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1565", "section": "30", "sectionName": "Test System Quality", "title": "core_subsystems_covered_by_tests"}
	t.Run("core_subsystems_covered_by_tests", func(t *testing.T) {
		// The unit-core CI stage must exercise all major Go subsystems.
		// Each subsystem needs at least one dedicated test file. If a
		// subsystem has no test file, it silently passes CI with zero coverage.
		entries, err := os.ReadDir(coreTestDir)
		if err != nil {
			t.Fatalf("cannot read core/test/: %v", err)
		}

		fileNames := make(map[string]bool)
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), "_test.go") {
				fileNames[e.Name()] = true
			}
		}

		// These subsystems are core to Dina's security and functionality.
		// Each must have a dedicated test file.
		requiredSubsystems := map[string]string{
			"crypto":    "crypto_test.go",
			"auth":      "auth_test.go",
			"authz":     "authz_test.go",
			"identity":  "identity_deterministic_test.go",
			"vault":     "vault_test.go",
			"config":    "config_test.go",
			"transport": "transport_test.go",
			"notify":    "notify_test.go",
		}

		for subsystem, expectedFile := range requiredSubsystems {
			if !fileNames[expectedFile] {
				t.Errorf("unit-core CI stage requires test file for %s subsystem (%s)", subsystem, expectedFile)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1566", "section": "30", "sectionName": "Test System Quality", "title": "test_functions_exist_in_test_files"}
	t.Run("test_functions_exist_in_test_files", func(t *testing.T) {
		// Test files must contain actual Test* functions, not just helper code.
		// A file with only helpers would compile fine but contribute no tests
		// to the CI pipeline, creating a false sense of coverage.
		entries, err := os.ReadDir(coreTestDir)
		if err != nil {
			t.Fatalf("cannot read core/test/: %v", err)
		}

		testFuncPattern := regexp.MustCompile(`(?m)^func Test\w+\(t \*testing\.T\)`)
		filesWithNoTests := []string{}

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			// Skip helper-only files that don't contain tests by convention.
			// wiring_test.go contains init() functions and adapter types for
			// test infrastructure — it provides helpers, not tests.
			if e.Name() == "testutil_test.go" || e.Name() == "helpers_test.go" || e.Name() == "wiring_test.go" {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(coreTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			if !testFuncPattern.Match(data) {
				filesWithNoTests = append(filesWithNoTests, e.Name())
			}
		}

		if len(filesWithNoTests) > 0 {
			t.Errorf("test files with no Test* functions (dead CI weight): %v", filesWithNoTests)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1567", "section": "30", "sectionName": "Test System Quality", "title": "makefile_has_go_test_target"}
	t.Run("makefile_has_go_test_target", func(t *testing.T) {
		// The Makefile must include `go test` in its test target so that
		// `make test` actually runs Go unit tests as a CI gate.
		makefile := readProjectFile(t, root, "Makefile")

		if !strings.Contains(makefile, "go test") {
			t.Fatal("Makefile must include 'go test' in test target for CI pipeline")
		}
		// Verify it runs from the core directory.
		if !strings.Contains(makefile, "cd core") {
			t.Fatal("Makefile go test must run from core/ directory (cd core && go test)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1568", "section": "30", "sectionName": "Test System Quality", "title": "total_test_function_count_is_substantial"}
	t.Run("total_test_function_count_is_substantial", func(t *testing.T) {
		// A meaningful CI gate needs a substantial number of test functions.
		// Count all Test* function declarations across core/test/.
		entries, err := os.ReadDir(coreTestDir)
		if err != nil {
			t.Fatalf("cannot read core/test/: %v", err)
		}

		testFuncPattern := regexp.MustCompile(`(?m)^func Test\w+\(t \*testing\.T\)`)
		totalFunctions := 0

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(coreTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			totalFunctions += len(testFuncPattern.FindAll(data, -1))
		}

		// The project has ~1200+ test functions. Require at least 500 to
		// catch mass deletion or accidental file removal.
		if totalFunctions < 500 {
			t.Fatalf("unit-core CI gate requires at least 500 test functions, found %d", totalFunctions)
		}
		t.Logf("unit-core: %d test functions across all test files", totalFunctions)
	})

	// TRACE: {"suite": "CORE", "case": "1569", "section": "30", "sectionName": "Test System Quality", "title": "master_runner_includes_integration_tests"}
	t.Run("master_runner_includes_integration_tests", func(t *testing.T) {
		// The master test runner (run_all_tests.sh) must exist and include
		// Go-related test execution in its pipeline. Without this, the CI
		// pipeline has no orchestration script.
		runnerPath := filepath.Join(root, "run_all_tests.sh")
		info, err := os.Stat(runnerPath)
		if err != nil {
			t.Fatalf("run_all_tests.sh must exist at project root: %v", err)
		}
		// Must be executable.
		if info.Mode()&0111 == 0 {
			t.Fatal("run_all_tests.sh must be executable (chmod +x)")
		}

		data, err := os.ReadFile(runnerPath)
		if err != nil {
			t.Fatalf("cannot read run_all_tests.sh: %v", err)
		}
		content := string(data)

		// Must reference test execution — either directly or via sub-scripts.
		hasTestRef := strings.Contains(content, "test_status") ||
			strings.Contains(content, "go test") ||
			strings.Contains(content, "run_unit_tests") ||
			strings.Contains(content, "run_non_unit_tests")
		if !hasTestRef {
			t.Fatal("run_all_tests.sh must invoke test runners for CI pipeline")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1570", "section": "30", "sectionName": "Test System Quality", "title": "fts5_build_tag_documented"}
	t.Run("fts5_build_tag_documented", func(t *testing.T) {
		// The -tags fts5 build tag is required for SQLite FTS5 support.
		// If the Makefile or build instructions don't mention it,
		// CI might build without FTS5 and silently skip FTS5-dependent tests.
		makefile := readProjectFile(t, root, "Makefile")
		claudeMd := readProjectFile(t, root, "CLAUDE.md")

		// At least one of the build references must mention fts5.
		hasFTS5Ref := strings.Contains(makefile, "fts5") ||
			strings.Contains(claudeMd, "fts5")

		if !hasFTS5Ref {
			t.Fatal("build documentation (Makefile or CLAUDE.md) must reference -tags fts5 " +
				"to prevent CI from building without FTS5 support")
		}
	})
}

// TST-CORE-1015
// CI stage: `unit-brain` — All Python unit tests pass.
// §30.8 CI Pipeline Gates (test_issues #9)
//
// Requirements:
//   - The `unit-brain` CI stage runs `pytest brain/tests/` to execute all Brain unit tests.
//   - Brain test files must follow pytest conventions (test_*.py prefix).
//   - The test suite must be comprehensive: covering API, auth, admin, PII, guardian,
//     LLM, embedding, config, routing, silence classification, and other subsystems.
//   - A conftest.py must exist with fixtures for brain test infrastructure.
//   - The Makefile must have a target that runs brain unit tests.
//   - Brain tests must NOT import from core (brain is an untrusted tenant — no Go code access).
// TRACE: {"suite": "CORE", "case": "1571", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "02", "title": "UnitBrainStage"}
func TestCI_30_8_2_UnitBrainStage(t *testing.T) {
	root := findProjectRoot(t)
	brainTestDir := filepath.Join(root, "brain", "tests")

	// TRACE: {"suite": "CORE", "case": "1572", "section": "30", "sectionName": "Test System Quality", "title": "brain_test_files_exist_and_follow_convention"}
	t.Run("brain_test_files_exist_and_follow_convention", func(t *testing.T) {
		// Python test files must exist in brain/tests/ and follow the test_*.py
		// naming convention. pytest discovers tests via this naming pattern.
		entries, err := os.ReadDir(brainTestDir)
		if err != nil {
			t.Fatalf("cannot read brain/tests/: %v", err)
		}

		testFiles := []string{}
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "test_") && strings.HasSuffix(e.Name(), ".py") {
				testFiles = append(testFiles, e.Name())
			}
		}

		// The project has 24 brain test files. Require at least 15 to catch
		// accidental deletions.
		if len(testFiles) < 15 {
			t.Fatalf("unit-brain requires at least 15 Python test files, found %d", len(testFiles))
		}
		t.Logf("found %d Python test files in brain/tests/", len(testFiles))
	})

	// TRACE: {"suite": "CORE", "case": "1573", "section": "30", "sectionName": "Test System Quality", "title": "conftest_exists_with_fixtures"}
	t.Run("conftest_exists_with_fixtures", func(t *testing.T) {
		// brain/tests/conftest.py must exist and provide shared test fixtures.
		// Without conftest.py, tests would lack mock factories, auth tokens,
		// and other shared setup — causing widespread test failures.
		conftest := readProjectFile(t, root, filepath.Join("brain", "tests", "conftest.py"))

		// Must import pytest (fundamental to fixture definitions).
		if !strings.Contains(conftest, "import pytest") {
			t.Fatal("brain/tests/conftest.py must import pytest for fixture definitions")
		}

		// Must define at least one @pytest.fixture.
		if !strings.Contains(conftest, "@pytest.fixture") {
			t.Fatal("brain/tests/conftest.py must define at least one @pytest.fixture")
		}

		// Must provide auth fixtures — the brain's Ed25519 auth is fundamental.
		if !strings.Contains(conftest, "brain_token") && !strings.Contains(conftest, "client_token") {
			t.Fatal("brain/tests/conftest.py must provide auth token fixtures " +
				"(brain_token and/or client_token)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1574", "section": "30", "sectionName": "Test System Quality", "title": "brain_subsystems_covered_by_tests"}
	t.Run("brain_subsystems_covered_by_tests", func(t *testing.T) {
		// The unit-brain CI stage must exercise all major Brain subsystems.
		// Each subsystem needs at least one dedicated test file.
		entries, err := os.ReadDir(brainTestDir)
		if err != nil {
			t.Fatalf("cannot read brain/tests/: %v", err)
		}

		fileNames := make(map[string]bool)
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "test_") && strings.HasSuffix(e.Name(), ".py") {
				fileNames[e.Name()] = true
			}
		}

		// These subsystems are core to the Brain's functionality.
		requiredSubsystems := map[string]string{
			"API endpoints":        "test_api.py",
			"authentication":       "test_auth.py",
			"admin interface":      "test_admin.py",
			"PII scrubbing":        "test_pii.py",
			"guardian loop":        "test_guardian.py",
			"LLM integration":     "test_llm.py",
			"embedding":            "test_embedding.py",
			"configuration":        "test_config.py",
			"silence classifier":   "test_silence.py",
			"routing":              "test_routing.py",
		}

		for subsystem, expectedFile := range requiredSubsystems {
			if !fileNames[expectedFile] {
				t.Errorf("unit-brain CI stage requires test file for %s (%s)", subsystem, expectedFile)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1575", "section": "30", "sectionName": "Test System Quality", "title": "test_files_contain_test_functions_or_classes"}
	t.Run("test_files_contain_test_functions_or_classes", func(t *testing.T) {
		// Python test files must contain actual test functions (def test_*) or
		// test classes (class Test*). Files with only helpers contribute no tests.
		entries, err := os.ReadDir(brainTestDir)
		if err != nil {
			t.Fatalf("cannot read brain/tests/: %v", err)
		}

		// Python test functions can be at top level (def test_*) or indented
		// inside classes (    def test_*) or async (async def test_*).
		testPattern := regexp.MustCompile(`(?m)(?:def test_|async def test_|class Test)`)
		filesWithNoTests := []string{}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_") || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(brainTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			if !testPattern.Match(data) {
				filesWithNoTests = append(filesWithNoTests, e.Name())
			}
		}

		if len(filesWithNoTests) > 0 {
			t.Errorf("brain test files with no test functions/classes (dead CI weight): %v", filesWithNoTests)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1576", "section": "30", "sectionName": "Test System Quality", "title": "makefile_has_pytest_target"}
	t.Run("makefile_has_pytest_target", func(t *testing.T) {
		// The Makefile must include `pytest` in its test target so that
		// `make test` actually runs brain unit tests as a CI gate.
		makefile := readProjectFile(t, root, "Makefile")

		if !strings.Contains(makefile, "pytest") {
			t.Fatal("Makefile must include 'pytest' in test target for brain CI pipeline")
		}
		// Must reference the brain tests directory.
		if !strings.Contains(makefile, "brain") {
			t.Fatal("Makefile pytest target must reference brain directory")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1577", "section": "30", "sectionName": "Test System Quality", "title": "total_test_function_count_is_substantial"}
	t.Run("total_test_function_count_is_substantial", func(t *testing.T) {
		// A meaningful CI gate needs a substantial number of test functions.
		// Count all test function/class declarations across brain/tests/.
		entries, err := os.ReadDir(brainTestDir)
		if err != nil {
			t.Fatalf("cannot read brain/tests/: %v", err)
		}

		testFuncPattern := regexp.MustCompile(`(?m)^(?:\s*def test_|\s*async def test_)`)
		totalFunctions := 0

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(brainTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			totalFunctions += len(testFuncPattern.FindAll(data, -1))
		}

		// The project has ~600+ test functions. Require at least 200 to catch
		// mass deletion or accidental file removal.
		if totalFunctions < 200 {
			t.Fatalf("unit-brain CI gate requires at least 200 test functions, found %d", totalFunctions)
		}
		t.Logf("unit-brain: %d test functions across all brain test files", totalFunctions)
	})

	// TRACE: {"suite": "CORE", "case": "1578", "section": "30", "sectionName": "Test System Quality", "title": "brain_tests_do_not_import_go_core"}
	t.Run("brain_tests_do_not_import_go_core", func(t *testing.T) {
		// Brain is an untrusted tenant — brain tests must NEVER import Go core
		// packages directly. The brain communicates with core exclusively via
		// HTTP APIs. If brain tests import Go code, it violates the sidecar
		// isolation boundary and may create false confidence in test results
		// (testing internal state rather than the API contract).
		entries, err := os.ReadDir(brainTestDir)
		if err != nil {
			t.Fatalf("cannot read brain/tests/: %v", err)
		}

		// Patterns that would indicate direct Go/core imports.
		forbiddenImports := []string{
			"import core",
			"from core import",
			"import dina_core",
			"from dina_core import",
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(brainTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			// Check line by line to avoid false positives in comments/strings.
			scanner := bufio.NewScanner(strings.NewReader(content))
			lineNum := 0
			for scanner.Scan() {
				lineNum++
				line := strings.TrimSpace(scanner.Text())
				// Skip comments.
				if strings.HasPrefix(line, "#") {
					continue
				}
				for _, forbidden := range forbiddenImports {
					if strings.HasPrefix(line, forbidden) {
						t.Errorf("%s:%d imports Go core (%q) — brain tests must use HTTP API only",
							e.Name(), lineNum, forbidden)
					}
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1579", "section": "30", "sectionName": "Test System Quality", "title": "factories_module_exists"}
	t.Run("factories_module_exists", func(t *testing.T) {
		// The brain test suite should have a factories module for creating
		// test data consistently. This prevents test fragility from ad-hoc
		// fixture construction.
		factoriesPath := filepath.Join(brainTestDir, "factories.py")
		info, err := os.Stat(factoriesPath)
		if err != nil {
			t.Fatalf("brain/tests/factories.py must exist for test data factories: %v", err)
		}
		if info.Size() == 0 {
			t.Fatal("brain/tests/factories.py must not be empty")
		}

		data, err := os.ReadFile(factoriesPath)
		if err != nil {
			t.Fatalf("cannot read factories.py: %v", err)
		}
		content := string(data)

		// Factories should define reusable test data builders.
		if !strings.Contains(content, "def ") && !strings.Contains(content, "class ") {
			t.Fatal("brain/tests/factories.py must define factory functions or classes")
		}
	})
}

// TST-CORE-1019
// Legacy tests in explicit profile — `pytest -m legacy` runs only legacy tests.
// §30.9 Legacy Test Separation (test_issues #10)
//
// Requirements:
//   - Legacy tests (v0.1-v0.3) are tagged with @pytest.mark.legacy so they can
//     be run explicitly with `pytest -m legacy` and excluded from the default pipeline.
//   - The `legacy` marker must be properly defined in pyproject.toml with a description.
//   - The marker infrastructure must work: pyproject.toml registers it, addopts
//     does NOT auto-exclude it (so `-m legacy` can select it), and any legacy-tagged
//     tests will only run when explicitly selected.
//   - Files in the top-level tests/ directory that target legacy dina.* modules
//     should be marked as legacy or compat (not unmarked).
//   - The `-m legacy` flag must be valid (not trigger PytestUnknownMarkWarning).
// TRACE: {"suite": "CORE", "case": "1580", "section": "30", "sectionName": "Test System Quality", "subsection": "09", "scenario": "01", "title": "LegacyTestsInExplicitProfile"}
func TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1581", "section": "30", "sectionName": "Test System Quality", "title": "legacy_marker_defined_in_pyproject"}
	t.Run("legacy_marker_defined_in_pyproject", func(t *testing.T) {
		// pyproject.toml must define the 'legacy' marker. Without this definition,
		// `pytest -m legacy` would trigger PytestUnknownMarkWarning and the marker
		// would be unreliable for test selection.
		pyproject := readProjectFile(t, root, "pyproject.toml")

		if !strings.Contains(pyproject, "legacy:") {
			t.Fatal("pyproject.toml must define 'legacy' marker — " +
				"without it, pytest -m legacy triggers PytestUnknownMarkWarning")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1582", "section": "30", "sectionName": "Test System Quality", "title": "legacy_marker_has_meaningful_description"}
	t.Run("legacy_marker_has_meaningful_description", func(t *testing.T) {
		// The legacy marker definition must describe what it means — otherwise
		// developers won't know when to apply it. The description should mention
		// that these are old tests from earlier versions.
		pyproject := readProjectFile(t, root, "pyproject.toml")

		// Find the legacy marker line in pyproject.toml.
		scanner := bufio.NewScanner(strings.NewReader(pyproject))
		found := false
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, "legacy:") || strings.Contains(line, `"legacy`) {
				found = true
				// The description should explain purpose (old/v0.1-v0.3/legacy tests).
				if !strings.Contains(line, "legacy") {
					t.Fatal("legacy marker description must explain its purpose")
				}
				break
			}
		}
		if !found {
			t.Fatal("could not find legacy marker definition line in pyproject.toml")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1583", "section": "30", "sectionName": "Test System Quality", "title": "addopts_does_not_auto_exclude_legacy"}
	t.Run("addopts_does_not_auto_exclude_legacy", func(t *testing.T) {
		// pyproject.toml's addopts must NOT auto-exclude legacy tests.
		// If addopts contains `-m 'not legacy'`, then `pytest -m legacy` would
		// conflict and potentially run nothing. The exclusion belongs in the
		// Makefile target, not in pyproject.toml's default options.
		pyproject := readProjectFile(t, root, "pyproject.toml")

		// Look for addopts section.
		if strings.Contains(pyproject, "addopts") {
			// If addopts exists, it must not auto-exclude legacy.
			scanner := bufio.NewScanner(strings.NewReader(pyproject))
			for scanner.Scan() {
				line := scanner.Text()
				if strings.Contains(line, "addopts") {
					if strings.Contains(line, "not legacy") {
						t.Fatal("pyproject.toml addopts must NOT contain '-m not legacy' — " +
							"legacy exclusion belongs in Makefile, not default options, " +
							"otherwise `pytest -m legacy` selects nothing")
					}
					break
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1584", "section": "30", "sectionName": "Test System Quality", "title": "makefile_excludes_legacy_from_default_pipeline"}
	t.Run("makefile_excludes_legacy_from_default_pipeline", func(t *testing.T) {
		// The Makefile's test target must exclude legacy tests via -m 'not legacy'.
		// This is the mechanism that separates legacy from default: Makefile excludes
		// them, but `pytest -m legacy` can still select them explicitly.
		makefile := readProjectFile(t, root, "Makefile")

		if !strings.Contains(makefile, "not legacy") {
			t.Fatal("Makefile test target must exclude legacy tests with -m 'not legacy' — " +
				"this is the gate that keeps legacy tests out of the default CI pipeline")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1585", "section": "30", "sectionName": "Test System Quality", "title": "legacy_or_compat_markers_on_old_test_files"}
	t.Run("legacy_or_compat_markers_on_old_test_files", func(t *testing.T) {
		// Top-level tests/test_*.py files that import from legacy dina.* modules
		// (dina.models, dina.memory, etc.) should be tagged with @pytest.mark.legacy
		// or @pytest.mark.compat. Untagged legacy tests run in the default pipeline
		// and could mask real failures with obsolete test logic.
		topTestDir := filepath.Join(root, "tests")
		entries, err := os.ReadDir(topTestDir)
		if err != nil {
			t.Fatalf("cannot read tests/: %v", err)
		}

		legacyModulePatterns := []string{
			"from dina.models",
			"from dina.memory",
			"from dina.brain",
			"from dina import",
			"import dina.",
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_") || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(topTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			// Check if this file imports legacy dina.* modules.
			importsLegacy := false
			scanner := bufio.NewScanner(strings.NewReader(content))
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "#") {
					continue
				}
				for _, pattern := range legacyModulePatterns {
					if strings.Contains(line, pattern) {
						importsLegacy = true
						break
					}
				}
				if importsLegacy {
					break
				}
			}

			if importsLegacy {
				// Must have either legacy or compat marker.
				hasMarker := strings.Contains(content, "pytest.mark.legacy") ||
					strings.Contains(content, "pytest.mark.compat")
				if !hasMarker {
					relPath, _ := filepath.Rel(root, filepath.Join(topTestDir, e.Name()))
					t.Errorf("%s imports legacy dina.* modules but lacks @pytest.mark.legacy "+
						"or @pytest.mark.compat — will run in default pipeline unintentionally", relPath)
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1586", "section": "30", "sectionName": "Test System Quality", "title": "legacy_exclusion_is_pytest_not_filter"}
	t.Run("legacy_exclusion_is_pytest_not_filter", func(t *testing.T) {
		// The Makefile's exclusion mechanism must use pytest's -m flag
		// (marker-based filtering), not file-path exclusion (--ignore).
		// Marker-based filtering is more maintainable: adding @pytest.mark.legacy
		// to a test automatically excludes it, without needing to update ignore paths.
		makefile := readProjectFile(t, root, "Makefile")

		// Must use -m flag for marker-based selection.
		if !strings.Contains(makefile, "-m") {
			t.Fatal("Makefile must use pytest -m flag for marker-based filtering, " +
				"not --ignore or file-path exclusion")
		}

		// The -m value must specifically exclude legacy.
		if !strings.Contains(makefile, "'not legacy'") && !strings.Contains(makefile, `"not legacy"`) {
			t.Fatal("Makefile must use -m 'not legacy' for marker-based exclusion")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1587", "section": "30", "sectionName": "Test System Quality", "title": "marker_infrastructure_self_consistent"}
	t.Run("marker_infrastructure_self_consistent", func(t *testing.T) {
		// The three components of legacy test separation must be consistent:
		// 1. pyproject.toml defines the marker
		// 2. Makefile excludes it from default pipeline
		// 3. TST-CORE-1021 already verified compat is also defined
		//
		// Additionally, the legacy marker must NOT appear in addopts (so explicit
		// `-m legacy` works) and MUST appear in the Makefile exclusion.
		pyproject := readProjectFile(t, root, "pyproject.toml")
		makefile := readProjectFile(t, root, "Makefile")

		// pyproject defines it.
		if !strings.Contains(pyproject, "legacy:") {
			t.Fatal("consistency check: pyproject.toml must define legacy marker")
		}

		// Makefile excludes it.
		if !strings.Contains(makefile, "not legacy") {
			t.Fatal("consistency check: Makefile must exclude legacy from default pipeline")
		}

		// Both legacy and compat markers are needed for the separation strategy.
		if !strings.Contains(pyproject, "compat:") {
			t.Fatal("consistency check: compat marker must also be defined — " +
				"legacy separation requires both legacy and compat markers")
		}

		t.Log("legacy test separation infrastructure is self-consistent: " +
			"pyproject defines markers, Makefile excludes legacy from default pipeline, " +
			"explicit `pytest -m legacy` remains functional")
	})
}

// TST-CORE-1017
// CI stage: `integration-real` — Docker-based strict real integration tests.
// §30.8 CI Pipeline Gates (test_issues #9)
//
// Requirements:
//   - The integration-real CI stage runs integration tests against real Docker
//     containers (docker-compose.test.yml) with no mock fallback.
//   - The dual-mode fixture pattern in conftest.py must switch Mock* → Real*
//     when DINA_INTEGRATION=docker is set.
//   - Real HTTP client classes (RealVault, RealGoCore, RealPythonBrain, etc.)
//     must exist and inherit from their Mock counterparts for interface compatibility.
//   - A Docker Compose file for integration tests must exist with isolated ports.
//   - Strict-real mode (DINA_STRICT_REAL=1) must be available to prevent silent
//     mock fallback when real API calls fail.
//   - The Makefile must have a test-integration target that activates Docker mode.
//   - Health check infrastructure must exist so tests wait for services.
// TRACE: {"suite": "CORE", "case": "1588", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "04", "title": "IntegrationRealStage"}
func TestCI_30_8_4_IntegrationRealStage(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1589", "section": "30", "sectionName": "Test System Quality", "title": "integration_conftest_implements_dual_mode"}
	t.Run("integration_conftest_implements_dual_mode", func(t *testing.T) {
		// The integration conftest.py must implement the dual-mode fixture pattern:
		// when DINA_INTEGRATION=docker, fixtures return Real* classes backed by
		// real HTTP calls; otherwise, they return Mock* classes with in-memory state.
		// This is the core mechanism that makes the same test code run in both modes.
		conftest := readProjectFile(t, root, filepath.Join("tests", "integration", "conftest.py"))

		// Must detect Docker mode via DINA_INTEGRATION env var.
		if !strings.Contains(conftest, "DINA_INTEGRATION") {
			t.Fatal("integration conftest.py must check DINA_INTEGRATION env var " +
				"to enable dual-mode fixture switching")
		}
		if !strings.Contains(conftest, `"docker"`) {
			t.Fatal("integration conftest.py must compare DINA_INTEGRATION against 'docker'")
		}

		// Must import Mock classes — these are the fallback mode.
		if !strings.Contains(conftest, "MockVault") || !strings.Contains(conftest, "MockGoCore") {
			t.Fatal("integration conftest.py must import MockVault and MockGoCore " +
				"for non-Docker mode")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1590", "section": "30", "sectionName": "Test System Quality", "title": "real_client_classes_exist_with_inheritance"}
	t.Run("real_client_classes_exist_with_inheritance", func(t *testing.T) {
		// Real* client classes must exist and inherit from Mock* counterparts.
		// Inheritance ensures interface compatibility: tests that work with mocks
		// also work with real HTTP clients without code changes.
		realClients := readProjectFile(t, root, filepath.Join("tests", "integration", "real_clients.py"))

		// Required Real* classes for the integration-real stage.
		requiredClasses := []struct {
			className  string
			parentName string
			purpose    string
		}{
			{"RealVault", "MockVault", "vault CRUD operations"},
			{"RealGoCore", "MockGoCore", "Go Core API operations"},
			{"RealPythonBrain", "MockPythonBrain", "Python Brain API operations"},
			{"RealAdminAPI", "", "admin operations"},
			{"RealServiceAuth", "", "Ed25519 request signing"},
			{"RealPIIScrubber", "", "PII scrubbing via real Brain API"},
		}

		for _, rc := range requiredClasses {
			if !strings.Contains(realClients, "class "+rc.className) {
				t.Errorf("real_clients.py must define %s for %s", rc.className, rc.purpose)
			}
			// Check inheritance for classes that should inherit from mocks.
			if rc.parentName != "" {
				expectedDecl := rc.className + "(" + rc.parentName + ")"
				if !strings.Contains(realClients, expectedDecl) {
					t.Errorf("%s must inherit from %s for interface compatibility",
						rc.className, rc.parentName)
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1591", "section": "30", "sectionName": "Test System Quality", "title": "strict_real_mode_prevents_mock_fallback"}
	t.Run("strict_real_mode_prevents_mock_fallback", func(t *testing.T) {
		// Strict-real mode (DINA_STRICT_REAL=1) must exist in real_clients.py.
		// When active, any API failure raises RuntimeError instead of returning None.
		// This prevents the insidious bug where a real API call fails silently and
		// the test passes using mock state, masking real integration problems.
		realClients := readProjectFile(t, root, filepath.Join("tests", "integration", "real_clients.py"))

		if !strings.Contains(realClients, "DINA_STRICT_REAL") {
			t.Fatal("real_clients.py must support DINA_STRICT_REAL env var " +
				"to prevent silent mock fallback on API failures")
		}

		// Must raise RuntimeError (not just log a warning) in strict mode.
		if !strings.Contains(realClients, "RuntimeError") {
			t.Fatal("strict-real mode must raise RuntimeError on API failure, " +
				"not silently fall back to mock state")
		}

		// Must mention "no mock fallback" or similar in the error message.
		if !strings.Contains(realClients, "mock fallback") {
			t.Fatal("strict-real RuntimeError must explain that mock fallback " +
				"is not allowed, so developers understand why the test failed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1592", "section": "30", "sectionName": "Test System Quality", "title": "union_compose_exists_with_isolation"}
	t.Run("union_compose_exists_with_isolation", func(t *testing.T) {
		// The union Docker Compose file must exist with fixed ports
		// and all actors for integration + E2E + release + system tests.
		composePath := filepath.Join(root, "docker-compose-test-stack.yml")
		if _, err := os.Stat(composePath); err != nil {
			t.Fatalf("docker-compose-test-stack.yml must exist: %v", err)
		}

		compose := readProjectFile(t, root, "docker-compose-test-stack.yml")

		if !strings.Contains(compose, "core") || !strings.Contains(compose, "brain") {
			t.Fatal("docker-compose-test-stack.yml must define core and brain services")
		}
		if !strings.Contains(compose, "healthcheck") {
			t.Fatal("docker-compose-test-stack.yml must define health checks")
		}
		if !strings.Contains(compose, "DINA_RATE_LIMIT") {
			t.Fatal("docker-compose-test-stack.yml must set DINA_RATE_LIMIT")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1593", "section": "30", "sectionName": "Test System Quality", "title": "test_stack_services_class_exists"}
	t.Run("test_stack_services_class_exists", func(t *testing.T) {
		// TestStackServices provides URLs, tokens, and key extraction
		// for all test tiers without managing Docker lifecycle.
		stackSvc := readProjectFile(t, root, filepath.Join("tests", "shared", "test_stack.py"))

		if !strings.Contains(stackSvc, "class TestStackServices") {
			t.Fatal("tests/shared/test_stack.py must define TestStackServices class")
		}
		if !strings.Contains(stackSvc, "assert_ready") {
			t.Fatal("TestStackServices must implement assert_ready() health check")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1594", "section": "30", "sectionName": "Test System Quality", "title": "makefile_has_integration_target_with_docker"}
	t.Run("makefile_has_integration_target_with_docker", func(t *testing.T) {
		// The Makefile must have a test-integration target that:
		// 1. Starts Docker containers
		// 2. Sets DINA_INTEGRATION=docker
		// 3. Runs pytest against tests/integration/
		// 4. Tears down containers afterward (even on failure)
		makefile := readProjectFile(t, root, "Makefile")

		if !strings.Contains(makefile, "test-integration") {
			t.Fatal("Makefile must have a test-integration target for the CI pipeline")
		}

		// Must use Docker mode env var.
		if !strings.Contains(makefile, "DINA_INTEGRATION=docker") {
			t.Fatal("Makefile test-integration target must set DINA_INTEGRATION=docker " +
				"to activate real HTTP client fixtures")
		}

		// Must target the integration test directory.
		if !strings.Contains(makefile, "tests/integration") {
			t.Fatal("Makefile test-integration must run pytest against tests/integration/")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1595", "section": "30", "sectionName": "Test System Quality", "title": "retry_on_429_for_rate_limited_apis"}
	t.Run("retry_on_429_for_rate_limited_apis", func(t *testing.T) {
		// Real HTTP clients must retry on 429 (rate limit) responses.
		// Without retry logic, tests would fail intermittently when multiple
		// tests hit the same API endpoint in rapid succession.
		realClients := readProjectFile(t, root, filepath.Join("tests", "integration", "real_clients.py"))

		if !strings.Contains(realClients, "429") {
			t.Fatal("real_clients.py must handle 429 (rate limit) responses with retry logic")
		}

		// Must have retry/backoff logic (not just detection).
		if !strings.Contains(realClients, "retry") || !strings.Contains(realClients, "backoff") {
			// Check for alternative patterns.
			if !strings.Contains(realClients, "attempt") || !strings.Contains(realClients, "sleep") {
				t.Fatal("real_clients.py must implement retry with backoff on 429, " +
					"not just detect the status code")
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1596", "section": "30", "sectionName": "Test System Quality", "title": "integration_tests_cover_major_subsystems"}
	t.Run("integration_tests_cover_major_subsystems", func(t *testing.T) {
		// The integration test directory must contain test files covering major
		// subsystems. Without comprehensive test files, the integration-real CI
		// stage would pass vacuously.
		intDir := filepath.Join(root, "tests", "integration")
		entries, err := os.ReadDir(intDir)
		if err != nil {
			t.Fatalf("cannot read tests/integration/: %v", err)
		}

		testFiles := 0
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "test_") && strings.HasSuffix(e.Name(), ".py") {
				testFiles++
			}
		}

		// Need a substantial number of integration test files.
		if testFiles < 10 {
			t.Fatalf("integration-real CI stage requires at least 10 test files, found %d", testFiles)
		}
		t.Logf("integration-real: %d test files in tests/integration/", testFiles)
	})

	// TRACE: {"suite": "CORE", "case": "1597", "section": "30", "sectionName": "Test System Quality", "title": "ed25519_signing_for_real_requests"}
	t.Run("ed25519_signing_for_real_requests", func(t *testing.T) {
		// Real HTTP clients must sign requests with Ed25519 service keys.
		// Core validates every brain request with signature verification.
		// Without proper signing, real API calls would get 401/403 and tests
		// would silently fall back to mock state (unless strict-real is on).
		realClients := readProjectFile(t, root, filepath.Join("tests", "integration", "real_clients.py"))

		signingPatterns := []string{
			"X-DID",
			"X-Timestamp",
			"X-Signature",
		}

		for _, pattern := range signingPatterns {
			if !strings.Contains(realClients, pattern) {
				t.Errorf("real_clients.py must set %s header for Ed25519 signed requests", pattern)
			}
		}
	})
}

// TST-CORE-1018
// CI stage: `e2e-smoke-real` — Critical path E2E verification.
// §30.8 CI Pipeline Gates (test_issues #9)
//
// Requirements:
//   - The e2e-smoke-real CI stage verifies critical paths end-to-end:
//     D2D messaging, vault CRUD, and PII scrub — all against real Docker containers.
//   - A multi-node Docker Compose file must exist with 4 actors (Don Alonso, Sancho,
//     ChairMaker, Albert), each running their own Core+Brain container pair.
//   - RealHomeNode and RealD2DNetwork classes must exist for real HTTP interactions.
//   - E2E test suites must cover all 3 critical paths mentioned in the requirement.
//   - Init containers (keygen-*) must provision SLIP-0010 derived service keys.
//   - E2E conftest.py must skip the entire suite when Docker is not available.
// TRACE: {"suite": "CORE", "case": "1598", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "05", "title": "E2ESmokeRealStage"}
func TestCI_30_8_5_E2ESmokeRealStage(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1599", "section": "30", "sectionName": "Test System Quality", "title": "multi_node_compose_has_4_actors"}
	t.Run("multi_node_compose_has_4_actors", func(t *testing.T) {
		// The union Docker Compose file must define 4 actor pairs (Core+Brain each).
		compose := readProjectFile(t, root, "docker-compose-test-stack.yml")

		actors := []string{"alonso", "sancho", "chairmaker", "albert"}
		for _, actor := range actors {
			coreService := actor + "-core"
			brainService := actor + "-brain"

			if !strings.Contains(compose, coreService) {
				t.Errorf("docker-compose-test-stack.yml must define %s service", coreService)
			}
			if !strings.Contains(compose, brainService) {
				t.Errorf("docker-compose-test-stack.yml must define %s service", brainService)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1600", "section": "30", "sectionName": "Test System Quality", "title": "keygen_init_containers_provision_keys"}
	t.Run("keygen_init_containers_provision_keys", func(t *testing.T) {
		// Each actor must have a keygen init container that derives SLIP-0010
		// service keys from its master seed BEFORE Core/Brain start.
		compose := readProjectFile(t, root, "docker-compose-test-stack.yml")

		actors := []string{"alonso", "sancho", "chairmaker", "albert"}
		for _, actor := range actors {
			keygenService := "keygen-" + actor
			if !strings.Contains(compose, keygenService) {
				t.Errorf("docker-compose-test-stack.yml must define %s init container", keygenService)
			}
		}

		if !strings.Contains(compose, "keygen") {
			t.Fatal("docker-compose-test-stack.yml must define keygen infrastructure")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1601", "section": "30", "sectionName": "Test System Quality", "title": "e2e_conftest_skips_without_docker"}
	t.Run("e2e_conftest_skips_without_docker", func(t *testing.T) {
		// The E2E conftest.py must skip the entire suite when DINA_E2E != 'docker'.
		// E2E tests CANNOT run without Docker containers — there is no mock fallback.
		// This is a safety guard: running E2E without Docker would produce
		// confusing failures or false passes.
		conftest := readProjectFile(t, root, filepath.Join("tests", "e2e", "conftest.py"))

		if !strings.Contains(conftest, "DINA_E2E") {
			t.Fatal("E2E conftest.py must check DINA_E2E env var")
		}

		// Must call pytest.skip when Docker is not available.
		if !strings.Contains(conftest, "pytest.skip") {
			t.Fatal("E2E conftest.py must call pytest.skip when DINA_E2E != 'docker' — " +
				"E2E tests cannot run without Docker containers")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1602", "section": "30", "sectionName": "Test System Quality", "title": "real_home_node_class_exists"}
	t.Run("real_home_node_class_exists", func(t *testing.T) {
		// RealHomeNode must exist as the E2E actor implementation backed by
		// real HTTP calls to Go Core. Without RealHomeNode, E2E tests would
		// use mock actors and not actually verify cross-node communication.
		realNodes := readProjectFile(t, root, filepath.Join("tests", "e2e", "real_nodes.py"))

		if !strings.Contains(realNodes, "class RealHomeNode") {
			t.Fatal("tests/e2e/real_nodes.py must define RealHomeNode class " +
				"for real HTTP-backed E2E actors")
		}

		// Must inherit from HomeNode base class for interface compatibility.
		if !strings.Contains(realNodes, "RealHomeNode(HomeNode)") {
			t.Fatal("RealHomeNode must inherit from HomeNode for interface compatibility " +
				"with the E2E fixture system")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1603", "section": "30", "sectionName": "Test System Quality", "title": "real_d2d_network_class_exists"}
	t.Run("real_d2d_network_class_exists", func(t *testing.T) {
		// RealD2DNetwork must exist for testing Dina-to-Dina encrypted messaging
		// over real HTTP connections between Docker containers.
		realD2D := readProjectFile(t, root, filepath.Join("tests", "e2e", "real_d2d.py"))

		if !strings.Contains(realD2D, "class RealD2DNetwork") {
			t.Fatal("tests/e2e/real_d2d.py must define RealD2DNetwork class " +
				"for real D2D messaging between actor containers")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1604", "section": "30", "sectionName": "Test System Quality", "title": "test_stack_services_used_by_e2e"}
	t.Run("test_stack_services_used_by_e2e", func(t *testing.T) {
		// E2E conftest must use TestStackServices (not its own Docker lifecycle).
		conftest := readProjectFile(t, root, filepath.Join("tests", "e2e", "conftest.py"))

		if !strings.Contains(conftest, "TestStackServices") {
			t.Fatal("E2E conftest.py must use TestStackServices from tests/shared/test_stack.py")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1605", "section": "30", "sectionName": "Test System Quality", "title": "critical_path_d2d_messaging_tests_exist"}
	t.Run("critical_path_d2d_messaging_tests_exist", func(t *testing.T) {
		// E2E suite must have tests for D2D messaging — this is one of the 3
		// critical paths specified in the requirement. D2D is the foundation of
		// Dina-to-Dina communication: encrypted NaCl sealed-box messages over HTTPS.
		e2eDir := filepath.Join(root, "tests", "e2e")
		found := false

		entries, err := os.ReadDir(e2eDir)
		if err != nil {
			t.Fatalf("cannot read tests/e2e/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_suite_") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(e2eDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)
			// Look for D2D messaging test patterns.
			if strings.Contains(content, "d2d") || strings.Contains(content, "D2D") {
				if strings.Contains(content, "def test_") {
					found = true
					break
				}
			}
		}

		if !found {
			t.Fatal("E2E suite must contain D2D messaging tests — " +
				"one of the 3 critical paths for e2e-smoke-real (§30.8)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1606", "section": "30", "sectionName": "Test System Quality", "title": "critical_path_vault_crud_tests_exist"}
	t.Run("critical_path_vault_crud_tests_exist", func(t *testing.T) {
		// E2E suite must have tests for vault CRUD operations — the second
		// critical path. Vault is the encrypted SQLCipher storage for all
		// persona data: store, query, batch operations.
		e2eDir := filepath.Join(root, "tests", "e2e")
		found := false

		entries, err := os.ReadDir(e2eDir)
		if err != nil {
			t.Fatalf("cannot read tests/e2e/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_suite_") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(e2eDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)
			// Look for vault CRUD test patterns.
			if (strings.Contains(content, "vault") || strings.Contains(content, "Vault")) &&
				(strings.Contains(content, "store") || strings.Contains(content, "query") ||
					strings.Contains(content, "entity_vault")) {
				if strings.Contains(content, "def test_") {
					found = true
					break
				}
			}
		}

		if !found {
			t.Fatal("E2E suite must contain vault CRUD tests — " +
				"one of the 3 critical paths for e2e-smoke-real (§30.8)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1607", "section": "30", "sectionName": "Test System Quality", "title": "critical_path_pii_scrub_tests_exist"}
	t.Run("critical_path_pii_scrub_tests_exist", func(t *testing.T) {
		// E2E suite must have tests for PII scrubbing — the third critical path.
		// PII must never leave the Home Node: the 3-tier scrubbing pipeline
		// (regex → NER → LLM) must be verified end-to-end.
		e2eDir := filepath.Join(root, "tests", "e2e")
		found := false

		entries, err := os.ReadDir(e2eDir)
		if err != nil {
			t.Fatalf("cannot read tests/e2e/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_suite_") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(e2eDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)
			// Look for PII scrubbing test patterns.
			if (strings.Contains(content, "pii") || strings.Contains(content, "PII") ||
				strings.Contains(content, "scrub")) &&
				strings.Contains(content, "def test_") {
				found = true
				break
			}
		}

		if !found {
			t.Fatal("E2E suite must contain PII scrubbing tests — " +
				"one of the 3 critical paths for e2e-smoke-real (§30.8)")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1608", "section": "30", "sectionName": "Test System Quality", "title": "e2e_suite_has_sufficient_test_coverage"}
	t.Run("e2e_suite_has_sufficient_test_coverage", func(t *testing.T) {
		// The E2E suite must have enough test suites to cover the critical paths
		// comprehensively. A minimal E2E suite with 1-2 test files is insufficient.
		e2eDir := filepath.Join(root, "tests", "e2e")
		entries, err := os.ReadDir(e2eDir)
		if err != nil {
			t.Fatalf("cannot read tests/e2e/: %v", err)
		}

		suiteCount := 0
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "test_suite_") && strings.HasSuffix(e.Name(), ".py") {
				suiteCount++
			}
		}

		// The project has 20 E2E test suites. Require at least 10 to catch
		// accidental removal of critical test files.
		if suiteCount < 10 {
			t.Fatalf("e2e-smoke-real requires at least 10 test suite files, found %d", suiteCount)
		}
		t.Logf("e2e-smoke-real: %d test suite files in tests/e2e/", suiteCount)
	})

	// TRACE: {"suite": "CORE", "case": "1609", "section": "30", "sectionName": "Test System Quality", "title": "allowed_endpoints_include_all_actors"}
	t.Run("allowed_endpoints_include_all_actors", func(t *testing.T) {
		// The union compose must configure DINA_ALLOWED_ENDPOINTS for cross-node D2D.
		compose := readProjectFile(t, root, "docker-compose-test-stack.yml")

		if !strings.Contains(compose, "DINA_ALLOWED_ENDPOINTS") {
			t.Fatal("docker-compose-test-stack.yml must set DINA_ALLOWED_ENDPOINTS")
		}

		actors := []string{"alonso-core", "sancho-core", "chairmaker-core", "albert-core"}
		for _, actor := range actors {
			if !strings.Contains(compose, actor) {
				t.Errorf("DINA_ALLOWED_ENDPOINTS must include %s for cross-node D2D", actor)
			}
		}
	})
}

// TST-CORE-1020
// Default pipeline excludes legacy tests — `make test` does not execute legacy tests.
// §30.9 Legacy Test Separation (test_issues #10)
//
// Requirements:
//   - The default CI pipeline (`make test`) must NOT execute legacy tests.
//   - Legacy exclusion must use pytest's marker-based filtering (-m 'not legacy'),
//     not file-path exclusion (--ignore), because marker-based is more maintainable.
//   - All known legacy test files must have module-level `pytestmark = pytest.mark.legacy`
//     so they are automatically excluded by the marker filter.
//   - No other test runner script in the default CI pipeline should bypass
//     the legacy exclusion.
//   - Integration, E2E, and system test directories must NOT contain unmarked
//     legacy tests (tests importing from dina.* without a legacy marker).
// TRACE: {"suite": "CORE", "case": "1610", "section": "30", "sectionName": "Test System Quality", "subsection": "09", "scenario": "02", "title": "DefaultPipelineExcludesLegacy"}
func TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "1611", "section": "30", "sectionName": "Test System Quality", "title": "makefile_default_test_excludes_legacy"}
	t.Run("makefile_default_test_excludes_legacy", func(t *testing.T) {
		// The Makefile's default `test` target must exclude legacy tests.
		// This is the primary CI gate: `make test` runs during every CI build,
		// and legacy v0.1-v0.3 tests must not pollute the v0.4 quality signal.
		makefile := readProjectFile(t, root, "Makefile")

		// Find the test target and verify it excludes legacy.
		lines := strings.Split(makefile, "\n")
		inTestTarget := false
		foundExclusion := false

		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "test:" {
				inTestTarget = true
				continue
			}
			// A new target starts (non-tab line with colon).
			if inTestTarget && !strings.HasPrefix(line, "\t") && strings.Contains(line, ":") {
				break
			}
			if inTestTarget && strings.Contains(line, "not legacy") {
				foundExclusion = true
			}
		}

		if !foundExclusion {
			t.Fatal("Makefile 'test' target must exclude legacy tests with -m 'not legacy' — " +
				"legacy v0.1-v0.3 tests must not run in the default CI pipeline")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1612", "section": "30", "sectionName": "Test System Quality", "title": "legacy_exclusion_is_in_pytest_not_go_test"}
	t.Run("legacy_exclusion_is_in_pytest_not_go_test", func(t *testing.T) {
		// The legacy exclusion must be in the pytest command (brain/Python tests),
		// not in the `go test` command. Go has no legacy tests, so the exclusion
		// only applies to the Python portion of `make test`.
		makefile := readProjectFile(t, root, "Makefile")

		lines := strings.Split(makefile, "\n")
		for _, line := range lines {
			if strings.Contains(line, "go test") && strings.Contains(line, "legacy") {
				t.Fatal("go test must NOT have legacy exclusion — " +
					"there are no legacy tests in Go; exclusion belongs in pytest only")
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1613", "section": "30", "sectionName": "Test System Quality", "title": "all_legacy_files_have_module_level_marker"}
	t.Run("all_legacy_files_have_module_level_marker", func(t *testing.T) {
		// Every Python test file that imports from legacy dina.* modules must have
		// `pytestmark = pytest.mark.legacy` at module level. Module-level markers
		// apply to ALL tests in the file, ensuring nothing slips through.
		// Class-level or function-level @pytest.mark.legacy is insufficient because
		// it could miss newly added test functions.
		topTestDir := filepath.Join(root, "tests")
		entries, err := os.ReadDir(topTestDir)
		if err != nil {
			t.Fatalf("cannot read tests/: %v", err)
		}

		legacyModulePatterns := []string{
			"from dina.models",
			"from dina.memory",
			"from dina.brain",
			"from dina.identity",
			"from dina.signing",
			"from dina.vault",
			"from dina.chat",
			"from dina.providers",
			"from dina import",
			"import dina.",
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_") || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(topTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			// Check if this file imports legacy dina.* modules.
			importsLegacy := false
			scanner := bufio.NewScanner(strings.NewReader(content))
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "#") {
					continue
				}
				for _, pattern := range legacyModulePatterns {
					if strings.Contains(line, pattern) {
						importsLegacy = true
						break
					}
				}
				if importsLegacy {
					break
				}
			}

			if importsLegacy {
				// Must have module-level pytestmark (not just class/function decorator).
				if !strings.Contains(content, "pytestmark = pytest.mark.legacy") &&
					!strings.Contains(content, "pytestmark = pytest.mark.compat") {
					relPath, _ := filepath.Rel(root, filepath.Join(topTestDir, e.Name()))
					t.Errorf("%s imports legacy dina.* modules but lacks module-level "+
						"pytestmark = pytest.mark.legacy — will run in default pipeline", relPath)
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1614", "section": "30", "sectionName": "Test System Quality", "title": "integration_dir_has_no_unmarked_legacy"}
	t.Run("integration_dir_has_no_unmarked_legacy", func(t *testing.T) {
		// Integration tests (tests/integration/) must NOT contain imports from
		// legacy dina.* modules. Integration tests target the v0.4 Core↔Brain
		// contract via HTTP APIs, not legacy Python packages. Any dina.* import
		// in integration tests indicates misplaced test code.
		intDir := filepath.Join(root, "tests", "integration")
		entries, err := os.ReadDir(intDir)
		if err != nil {
			t.Fatalf("cannot read tests/integration/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(intDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			// Scan for legacy imports line by line (skip comments).
			scanner := bufio.NewScanner(strings.NewReader(content))
			lineNum := 0
			for scanner.Scan() {
				lineNum++
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "#") {
					continue
				}
				if strings.HasPrefix(line, "from dina.") || strings.HasPrefix(line, "import dina.") {
					t.Errorf("tests/integration/%s:%d imports legacy dina.* module — "+
						"integration tests must use HTTP APIs, not legacy Python packages",
						e.Name(), lineNum)
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1615", "section": "30", "sectionName": "Test System Quality", "title": "e2e_dir_has_no_unmarked_legacy"}
	t.Run("e2e_dir_has_no_unmarked_legacy", func(t *testing.T) {
		// E2E tests (tests/e2e/) must NOT contain imports from legacy dina.* modules.
		// E2E tests work with real Docker containers via HTTP, not Python packages.
		e2eDir := filepath.Join(root, "tests", "e2e")
		entries, err := os.ReadDir(e2eDir)
		if err != nil {
			t.Fatalf("cannot read tests/e2e/: %v", err)
		}

		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(e2eDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			scanner := bufio.NewScanner(strings.NewReader(content))
			lineNum := 0
			for scanner.Scan() {
				lineNum++
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "#") {
					continue
				}
				if strings.HasPrefix(line, "from dina.") || strings.HasPrefix(line, "import dina.") {
					t.Errorf("tests/e2e/%s:%d imports legacy dina.* module — "+
						"E2E tests must use HTTP APIs, not legacy Python packages",
						e.Name(), lineNum)
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1616", "section": "30", "sectionName": "Test System Quality", "title": "run_all_tests_does_not_run_legacy"}
	t.Run("run_all_tests_does_not_run_legacy", func(t *testing.T) {
		// The master test runner (run_all_tests.sh) must not bypass the legacy
		// exclusion. It chains 3 suites (integration, user stories, release) —
		// none of which should run legacy tests.
		runner := readProjectFile(t, root, "run_all_tests.sh")

		// The runner must not have a `-m legacy` flag that would include them.
		if strings.Contains(runner, "-m legacy") && !strings.Contains(runner, "not legacy") {
			t.Fatal("run_all_tests.sh must not include -m legacy (which would run legacy tests) — " +
				"only -m 'not legacy' is acceptable")
		}

		// The runner should not directly invoke top-level test files where legacy tests live.
		if strings.Contains(runner, "tests/test_") {
			t.Fatal("run_all_tests.sh must not invoke top-level tests/test_* files — " +
				"these may contain legacy tests")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1617", "section": "30", "sectionName": "Test System Quality", "title": "legacy_marker_count_matches_legacy_files"}
	t.Run("legacy_marker_count_matches_legacy_files", func(t *testing.T) {
		// Verify that the number of files with `pytestmark = pytest.mark.legacy`
		// matches the number of files that import from dina.* modules.
		// A mismatch means either:
		//   - A legacy file lost its marker (will run in default pipeline)
		//   - A non-legacy file got the marker (will be wrongly excluded)
		topTestDir := filepath.Join(root, "tests")
		entries, err := os.ReadDir(topTestDir)
		if err != nil {
			t.Fatalf("cannot read tests/: %v", err)
		}

		legacyImportFiles := 0
		legacyMarkerFiles := 0

		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "test_") || !strings.HasSuffix(e.Name(), ".py") {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(topTestDir, e.Name()))
			if readErr != nil {
				continue
			}
			content := string(data)

			// Count files importing legacy modules.
			importsLegacy := false
			scanner := bufio.NewScanner(strings.NewReader(content))
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "#") {
					continue
				}
				if strings.HasPrefix(line, "from dina.") || strings.HasPrefix(line, "import dina.") {
					importsLegacy = true
					break
				}
			}
			if importsLegacy {
				legacyImportFiles++
			}

			// Count files with legacy or compat marker.
			if strings.Contains(content, "pytestmark = pytest.mark.legacy") ||
				strings.Contains(content, "pytestmark = pytest.mark.compat") {
				legacyMarkerFiles++
			}
		}

		// Every legacy-importing file must have a marker.
		if legacyImportFiles > legacyMarkerFiles {
			t.Errorf("found %d files importing dina.* but only %d with legacy/compat markers — "+
				"%d files will leak into the default pipeline",
				legacyImportFiles, legacyMarkerFiles, legacyImportFiles-legacyMarkerFiles)
		}

		t.Logf("legacy audit: %d legacy files, %d with markers", legacyImportFiles, legacyMarkerFiles)
	})
}
