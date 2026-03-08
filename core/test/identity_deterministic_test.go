package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §33 — Deterministic Identity, Vector Security, Static Audits
// ==========================================================================
// Covers TST-CORE-1106 through TST-CORE-1116: deterministic identity state
// (corrupt metadata fail-closed, generation persistence, rotation rejection,
// branch isolation), vector security lifecycle (unlock/lock/restart hydration,
// no plaintext vector files), and static deployment/security audits (no :latest
// tags, no unexpected public routes, no plaintext vector patterns).
// ==========================================================================

// --------------------------------------------------------------------------
// §33.1 Deterministic Identity State
// --------------------------------------------------------------------------

// TST-CORE-1106
func TestDeterministicIdentity_CorruptMetadataFailsClosed(t *testing.T) {
	// Write corrupt JSON to identity metadata file, attempt to load,
	// expect error (not silent generation).
	dir := testutil.TempDir(t)
	identityDir := filepath.Join(dir, "identity")
	if err := os.MkdirAll(identityDir, 0700); err != nil {
		t.Fatalf("failed to create identity dir: %v", err)
	}

	// Write corrupt JSON that is not valid.
	corruptData := []byte(`{{{not valid json!!!`)
	metadataPath := filepath.Join(identityDir, "did_metadata.json")
	if err := os.WriteFile(metadataPath, corruptData, 0600); err != nil {
		t.Fatalf("failed to write corrupt metadata: %v", err)
	}

	// Create a DIDManager pointing at this directory and attempt to load.
	mgr := identity.NewDIDManager(dir)
	meta, err := mgr.LoadDIDMetadata()

	// Must return an error, not silently generate a new identity.
	testutil.RequireError(t, err)
	testutil.RequireNil(t, meta)
}

// TST-CORE-1107
func TestDeterministicIdentity_GenerationPersistsAcrossRestart(t *testing.T) {
	// Derive a key at generation N, persist to temp dir, reload,
	// verify same generation is recovered.
	dir := testutil.TempDir(t)

	// Create first manager, set generation and signing path, create a DID.
	mgr1 := identity.NewDIDManager(dir)
	mgr1.SetSigningKeyPath("m/9999'/0'/0'")
	mgr1.SetSigningGeneration(0)

	ctx := idCtx
	did, err := mgr1.Create(ctx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, string(did) != "", "DID must not be empty")

	// Verify generation is 0.
	gen := mgr1.SigningGeneration()
	testutil.RequireEqual(t, gen, 0)

	// Load metadata from disk with a fresh manager (simulating restart).
	mgr2 := identity.NewDIDManager(dir)
	meta, err := mgr2.LoadDIDMetadata()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, meta)

	// Verify the generation persisted correctly.
	testutil.RequireEqual(t, meta.SigningGeneration, 0)
	testutil.RequireEqual(t, meta.SigningKeyPath, "m/9999'/0'/0'")
}

// TST-CORE-1108
func TestDeterministicIdentity_RejectsNonNextGeneration(t *testing.T) {
	// Attempt rotation with a key that doesn't match next generation,
	// expect error.
	dir := testutil.TempDir(t)
	deriver := dinacrypto.NewSLIP0010Deriver()
	keyDeriver := dinacrypto.NewKeyDeriver(deriver)

	// Create DID at generation 0.
	mgr := identity.NewDIDManager(dir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")
	mgr.SetSigningGeneration(0)
	mgr.SetMasterSeed(testutil.TestMnemonicSeed, keyDeriver)

	ctx := idCtx
	_, currentPriv, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'/0'")
	testutil.RequireNoError(t, err)

	did, err := mgr.Create(ctx, currentPriv[32:]) // public key is last 32 bytes of Ed25519 private key
	testutil.RequireNoError(t, err)

	// Derive a key from a WRONG generation (generation 5 instead of 1).
	wrongPub, _, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'/5'")
	testutil.RequireNoError(t, err)

	// Sign the rotation payload with the current private key.
	rotationPayload := []byte("rotate-to-wrong-generation")
	signer := dinacrypto.NewEd25519Signer()
	sig, err := signer.Sign(currentPriv, rotationPayload)
	testutil.RequireNoError(t, err)

	// Attempt rotation — should be rejected because wrongPub is gen 5, not gen 1.
	err = mgr.Rotate(ctx, did, rotationPayload, sig, wrongPub)
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, strings.Contains(err.Error(), "rotation denied"),
		"error should indicate rotation was denied")
}

// TST-CORE-1109
func TestDeterministicIdentity_PLCBranchIsolated(t *testing.T) {
	// Derive keys from PLC branch, persona branch, service branch using
	// SLIP-0010, verify no collision (all 32-byte outputs differ).
	deriver := dinacrypto.NewSLIP0010Deriver()
	seed := testutil.TestMnemonicSeed

	// PLC recovery branch: m/9999'/2'/0'
	plcPub, _, err := deriver.DerivePath(seed, "m/9999'/2'/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, plcPub, 32)

	// Persona branch (consumer): m/9999'/1'/0'/0'
	personaPub, _, err := deriver.DerivePath(seed, "m/9999'/1'/0'/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, personaPub, 32)

	// Service auth branch (core): m/9999'/3'/0'
	servicePub, _, err := deriver.DerivePath(seed, "m/9999'/3'/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, servicePub, 32)

	// Root signing branch: m/9999'/0'/0'
	rootPub, _, err := deriver.DerivePath(seed, "m/9999'/0'/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, rootPub, 32)

	// Verify all four branches produce different keys (no collision).
	keys := map[string][]byte{
		"plc":     plcPub,
		"persona": personaPub,
		"service": servicePub,
		"root":    rootPub,
	}
	names := []string{"plc", "persona", "service", "root"}
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			testutil.RequireBytesNotEqual(t, keys[names[i]], keys[names[j]])
		}
	}
}

// --------------------------------------------------------------------------
// §33.2 Vector Security Lifecycle
// --------------------------------------------------------------------------

// vectorSecurityImpl is a placeholder for the vector security implementation.
// Set to nil until the real implementation is wired in.
var vectorSecurityImpl interface{} = nil

// TST-CORE-1110
func TestVectorSecurity_UnlockHydratesHNSW(t *testing.T) {
	// Unlock persona, verify search returns results (index was hydrated).
	// Use mock vault with stored embeddings.
	impl := vectorSecurityImpl
	testutil.RequireImplementation(t, impl, "VectorSecurity")

	// When wired, this test will:
	// 1. Store embeddings in a mock vault (pre-populated SQLCipher data).
	// 2. Unlock the persona.
	// 3. Verify that HNSW index is hydrated from SQLCipher.
	// 4. Perform a search and verify results are returned.
	t.Fatal("implementation pending — test body ready for wiring")
}

// TST-CORE-1111
func TestVectorSecurity_LockDestroysIndex(t *testing.T) {
	// Unlock, verify search works, lock, verify search fails/empty.
	impl := vectorSecurityImpl
	testutil.RequireImplementation(t, impl, "VectorSecurity")

	// When wired, this test will:
	// 1. Unlock persona — HNSW index hydrated.
	// 2. Search — returns results.
	// 3. Lock persona — in-memory HNSW index destroyed.
	// 4. Search again — must fail or return empty (index gone).
	t.Fatal("implementation pending — test body ready for wiring")
}

// TST-CORE-1112
func TestVectorSecurity_NoPlaintextVectorFiles(t *testing.T) {
	// After indexing, scan temp dir for .bin/.idx/.hnswlib files, assert
	// none found.
	impl := vectorSecurityImpl
	testutil.RequireImplementation(t, impl, "VectorSecurity")

	// When wired, this test will:
	// 1. Create a temp dir, configure vector store to use it.
	// 2. Store embeddings, build index.
	// 3. Walk the temp dir tree looking for .bin, .idx, .hnswlib files.
	// 4. Assert none found — vectors live only in SQLCipher + RAM.
	dir := testutil.TempDir(t)
	_ = dir

	t.Fatal("implementation pending — test body ready for wiring")
}

// TST-CORE-1113
func TestVectorSecurity_RestartRebuildsFromSQLCipher(t *testing.T) {
	// Store embeddings, "restart" (clear in-memory state), unlock,
	// search still works.
	impl := vectorSecurityImpl
	testutil.RequireImplementation(t, impl, "VectorSecurity")

	// When wired, this test will:
	// 1. Unlock persona, store embeddings with vectors.
	// 2. Search — verify results.
	// 3. Lock persona (clears in-memory HNSW).
	// 4. Re-unlock (simulates restart — rebuilds index from SQLCipher).
	// 5. Search again — same results as step 2.
	t.Fatal("implementation pending — test body ready for wiring")
}

// --------------------------------------------------------------------------
// §33.3 Static Deployment and Security Audits
// --------------------------------------------------------------------------

// TST-CORE-1114
func TestStaticAudit_NoLatestTags(t *testing.T) {
	// Read docker-compose*.yml files, scan for :latest in image references,
	// assert none found.
	projectRoot := filepath.Join("..", "..")

	composeFiles, err := filepath.Glob(filepath.Join(projectRoot, "docker-compose*.yml"))
	if err != nil {
		t.Fatalf("failed to glob docker-compose files: %v", err)
	}

	// Also check deploy/ subdirectories.
	deployComposeFiles, err := filepath.Glob(filepath.Join(projectRoot, "deploy", "*", "docker-compose*.yml"))
	if err == nil {
		composeFiles = append(composeFiles, deployComposeFiles...)
	}

	if len(composeFiles) == 0 {
		t.Skip("no docker-compose*.yml files found — skipping :latest tag audit")
	}

	for _, f := range composeFiles {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("failed to read %s: %v", f, err)
		}

		lines := strings.Split(string(data), "\n")
		for lineNum, line := range lines {
			trimmed := strings.TrimSpace(line)
			// Skip comments.
			if strings.HasPrefix(trimmed, "#") {
				continue
			}
			// Look for image: references with :latest tag.
			if strings.Contains(trimmed, "image:") && strings.Contains(trimmed, ":latest") {
				t.Errorf("%s:%d — :latest tag found in image reference: %s",
					filepath.Base(f), lineNum+1, trimmed)
			}
		}
	}
}

// TST-CORE-1115
func TestStaticAudit_NoUnexpectedPublicRoutes(t *testing.T) {
	// Enumerate routes from the server implementation, compare against
	// documented API surface.
	serverSource, err := os.ReadFile("../internal/adapter/server/server.go")
	if err != nil {
		t.Fatalf("failed to read server.go: %v", err)
	}
	src := string(serverSource)

	// The documented API surface: all routes that should exist.
	documentedRoutes := map[string]bool{
		"/healthz":                    true,
		"/readyz":                     true,
		"/.well-known/atproto-did":    true,
		"/metrics":                    true,
		"/admin/sync-status":          true,
		"/v1/vault/query":             true,
		"/v1/vault/store":             true,
		"/v1/vault/store/batch":       true,
		"/v1/vault/item/:id":          true,
		"/v1/vault/crash":             true,
		"/v1/vault/kv/:key":           true,
		"/v1/task/ack":                true,
		"/v1/did":                     true,
		"/v1/did/sign":                true,
		"/v1/did/verify":              true,
		"/v1/did/rotate":              true,
		"/v1/personas":                true,
		"/v1/contacts":                true,
		"/v1/devices":                 true,
		"/v1/msg/send":                true,
		"/v1/msg/inbox":               true,
		"/v1/msg/:id/ack":             true,
		"/v1/pair/initiate":           true,
		"/v1/pair/complete":           true,
		"/v1/pii/scrub":              true,
		"/v1/notify":                  true,
		"/v1/trust/query":             true,
		"/v1/trust/publish":           true,
	}

	// Extract route strings from source code — look for quoted route patterns.
	lines := strings.Split(src, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Look for route registration patterns: "/v1/...", "/healthz", etc.
		if !strings.Contains(trimmed, `"/"`) && !strings.Contains(trimmed, `"/v1/`) &&
			!strings.Contains(trimmed, `"/healthz"`) && !strings.Contains(trimmed, `"/readyz"`) &&
			!strings.Contains(trimmed, `"/metrics"`) && !strings.Contains(trimmed, `"/.well-known`) &&
			!strings.Contains(trimmed, `"/admin/`) {
			continue
		}
		// Skip comments.
		if strings.HasPrefix(trimmed, "//") {
			continue
		}

		// Extract quoted strings that look like routes.
		for _, segment := range strings.Split(trimmed, `"`) {
			if len(segment) > 0 && segment[0] == '/' {
				route := segment
				if !documentedRoutes[route] {
					// Some known non-route strings to ignore.
					if strings.Contains(route, "/run/secrets") ||
						strings.Contains(route, "/var/") ||
						strings.Contains(route, "/etc/") ||
						strings.HasSuffix(route, ".json") ||
						strings.HasSuffix(route, ".go") {
						continue
					}
					t.Errorf("unexpected route found in server.go: %q — not in documented API surface", route)
				}
			}
		}
	}

	// Verify the source code contains route registration infrastructure.
	testutil.RequireTrue(t, strings.Contains(src, "routes"),
		"server.go must contain route registration infrastructure")
}

// TST-CORE-1116
func TestStaticAudit_NoPlaintextVectorPatterns(t *testing.T) {
	// Scan Go source files for mmap, .hnswlib, .faiss patterns, assert
	// none found.
	goSourceDir := filepath.Join("..", "internal")

	goFiles, err := filepath.Glob(filepath.Join(goSourceDir, "**", "*.go"))
	if err != nil {
		t.Logf("nested glob not supported, using manual walk")
	}

	// filepath.Glob does not support ** recursion in all Go versions.
	// Walk the directory tree manually.
	goFiles = nil
	err = filepath.Walk(goSourceDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip inaccessible paths
		}
		if !info.IsDir() && strings.HasSuffix(path, ".go") {
			goFiles = append(goFiles, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("failed to walk source directory: %v", err)
	}

	if len(goFiles) == 0 {
		t.Fatal("no Go source files found under core/internal/ — directory structure may have changed")
	}

	// Forbidden patterns that indicate plaintext vector storage on disk.
	forbiddenPatterns := []string{
		"mmap",
		".hnswlib",
		".faiss",
		"hnswlib.Index",
		"faiss.Index",
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
				// Exclude test files and comments that document the pattern.
				if strings.HasSuffix(f, "_test.go") {
					continue
				}
				t.Errorf("%s contains forbidden plaintext vector pattern %q — "+
					"vectors must live in SQLCipher + RAM only, never as plaintext files",
					f, pattern)
			}
		}
	}
}
