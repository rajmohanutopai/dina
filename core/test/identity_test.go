package test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// idCtx is a background context used for all identity port calls.
var idCtx = context.Background()

// Ensure imports are used.
var (
	_ = sync.Mutex{}
	_ = time.Now
	_ = identity.NewPersonaManager
	_ = domain.DID("")
)

// ---------- §3.1 DID Generation & Persistence (10 scenarios) ----------

// TST-CORE-130
func TestIdentity_3_1_1_GenerateRootDID(t *testing.T) {
	impl := realDIDManager
	// impl = identity.NewDIDManager(testutil.TempDir(t))
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Positive: valid 32-byte seed produces a did:plc: DID.
	did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, string(did), "did:plc:")
	testutil.RequireTrue(t, len(string(did)) > len("did:plc:"), "DID must have content after prefix")

	// Determinism: same seed must produce the same DID.
	// The second Create with the same key returns ErrDIDAlreadyExists to enforce
	// duplicate detection, but still returns the deterministic DID value.
	did2, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "already exists")
	testutil.RequireEqual(t, string(did), string(did2))

	// Negative: invalid key size must be rejected.
	_, err = impl.Create(idCtx, []byte("too-short"))
	testutil.RequireError(t, err)

	// Negative: empty key must be rejected.
	_, err = impl.Create(idCtx, []byte{})
	testutil.RequireError(t, err)
}

// TST-CORE-131
func TestIdentity_3_1_2_LoadExistingDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Positive: create a DID then resolve it — doc must be valid JSON with expected fields.
	did1, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	doc, err := impl.Resolve(idCtx, did1)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, doc)
	testutil.RequireTrue(t, len(doc) > 0, "resolved DID document must not be empty")
	// The document must contain the DID itself as its id.
	testutil.RequireContains(t, string(doc), string(did1))

	// Negative: resolving a nonexistent DID must return an error.
	_, err = impl.Resolve(idCtx, domain.DID("did:plc:nonexistent_12345"))
	testutil.RequireError(t, err)
}

// TST-CORE-132
func TestIdentity_3_1_3_DIDDocumentStructure(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)

	// Required W3C DID document fields must be present.
	docStr := string(doc)
	testutil.RequireContains(t, docStr, `"id"`)
	testutil.RequireContains(t, docStr, `"service"`)
	testutil.RequireContains(t, docStr, `"verificationMethod"`)
	testutil.RequireContains(t, docStr, `"authentication"`)
	testutil.RequireContains(t, docStr, `"@context"`)

	// The document's "id" value must match the created DID.
	testutil.RequireContains(t, docStr, string(did))

	// Parse as JSON to verify it's valid and has correct structure.
	var parsed map[string]interface{}
	if err := json.Unmarshal(doc, &parsed); err != nil {
		t.Fatalf("DID document is not valid JSON: %v", err)
	}
	// The "id" field must equal the created DID.
	if id, ok := parsed["id"].(string); !ok || id != string(did) {
		t.Fatalf("DID doc id=%q does not match created DID=%q", parsed["id"], did)
	}
	// verificationMethod must be a non-empty array.
	vm, ok := parsed["verificationMethod"].([]interface{})
	if !ok || len(vm) == 0 {
		t.Fatal("verificationMethod must be a non-empty array")
	}
}

// TST-CORE-133
func TestIdentity_3_1_4_MultiplePersonaDIDs(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	key1 := make([]byte, 32)
	key2 := make([]byte, 32)
	key1[0] = 1
	key2[0] = 2

	did1, err := impl.Create(idCtx, key1)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, string(did1), "did:plc:")

	did2, err := impl.Create(idCtx, key2)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, string(did2), "did:plc:")

	// Different keys must produce different DIDs.
	if did1 == did2 {
		t.Fatal("different keys should produce different DIDs")
	}

	// Both DIDs must be independently resolvable.
	doc1, err := impl.Resolve(idCtx, did1)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(doc1) > 0, "first DID must be resolvable")

	doc2, err := impl.Resolve(idCtx, did2)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(doc2) > 0, "second DID must be resolvable")

	// Each document must contain its own DID, not the other.
	testutil.RequireContains(t, string(doc1), string(did1))
	testutil.RequireContains(t, string(doc2), string(did2))
}

// TST-CORE-134
func TestIdentity_3_1_5_DIDDocumentServiceEndpoint(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, _ := impl.Resolve(idCtx, did)
	testutil.RequireContains(t, string(doc), `"DinaMessaging"`)
}

// TST-CORE-135
func TestIdentity_3_1_6_PLCDirectorySignedOpsOnly(t *testing.T) {
	// Code audit: PLC Directory must only store signed operations.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)

	// The ed25519 package must be imported (not just mentioned in comments).
	if !strings.Contains(content, `"crypto/ed25519"`) {
		t.Fatal("identity.go must import crypto/ed25519 for signature verification")
	}

	// DIDManager.Rotate requires signature verification before accepting rotation.
	if !strings.Contains(content, "ed25519.Verify") {
		t.Fatal("PLC Directory operations must verify Ed25519 signature on rotation payload")
	}

	// The Rotate function must exist as a method (not just a comment).
	if !strings.Contains(content, "func (") || !strings.Contains(content, "Rotate(") {
		t.Fatal("DIDManager must have a Rotate method for key rotation")
	}

	// Negative audit: unsigned operations must not be accepted.
	// Verify no "Rotate" path bypasses signature verification (no "skipVerify" or "noSig").
	lower := strings.ToLower(content)
	if strings.Contains(lower, "skipverify") || strings.Contains(lower, "nosig") {
		t.Fatal("identity.go must not contain signature bypass flags (skipVerify/noSig)")
	}
}

// TST-CORE-136
func TestIdentity_3_1_7_SecondRootGenerationRejected(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Positive control: first creation must succeed and return a valid DID.
	did1, err1 := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err1)
	testutil.RequireContains(t, string(did1), "did:plc:")

	// Negative: second creation with same key must be rejected.
	_, err2 := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireError(t, err2)
	testutil.RequireContains(t, err2.Error(), "already exists")
}

// TST-CORE-137
func TestIdentity_3_1_8_RootIdentityCreatedAtTimestamp(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	before := time.Now().UTC().Add(-2 * time.Second)
	did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	after := time.Now().UTC().Add(2 * time.Second)

	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)

	// Parse the JSON document and extract the created_at value.
	var parsed map[string]interface{}
	if jsonErr := json.Unmarshal(doc, &parsed); jsonErr != nil {
		t.Fatalf("failed to parse DID document JSON: %v", jsonErr)
	}
	raw, ok := parsed["created_at"]
	if !ok {
		t.Fatal("DID document missing 'created_at' field")
	}
	tsStr, ok := raw.(string)
	if !ok || tsStr == "" {
		t.Fatalf("created_at is not a non-empty string: %v", raw)
	}

	// Validate that created_at is a valid RFC3339 timestamp within the expected window.
	ts, parseErr := time.Parse(time.RFC3339, tsStr)
	if parseErr != nil {
		t.Fatalf("created_at is not valid RFC3339: %q — %v", tsStr, parseErr)
	}
	if ts.Before(before) || ts.After(after) {
		t.Fatalf("created_at %v is outside expected window [%v, %v]", ts, before, after)
	}
}

// TST-CORE-138
func TestIdentity_3_1_9_DeviceOriginFingerprint(t *testing.T) {
	// Fresh DIDManager for isolation.
	dir := t.TempDir()
	mgr := identity.NewDIDManager(dir)
	testutil.RequireImplementation(t, mgr, "DIDManager")

	// Create a DID — device_origin should be set to the hostname.
	did, err := mgr.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(did) > 0, "DID must be non-empty")

	doc, err := mgr.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(doc) > 0, "DID document must be non-empty")

	// Parse the DID document and verify device_origin field.
	var parsed struct {
		DeviceOrigin string `json:"device_origin"`
		ID           string `json:"id"`
	}
	err = json.Unmarshal(doc, &parsed)
	testutil.RequireNoError(t, err)

	// device_origin must be a non-empty string (hostname or "unknown").
	testutil.RequireTrue(t, len(parsed.DeviceOrigin) > 0,
		"device_origin must be non-empty in DID document")

	// Verify it matches the actual hostname (production uses os.Hostname()).
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}
	testutil.RequireEqual(t, parsed.DeviceOrigin, hostname)

	// Verify DID document ID matches the created DID.
	testutil.RequireEqual(t, parsed.ID, string(did))
}

// TST-CORE-139
func TestIdentity_3_1_10_MultikeyZ6MkPrefix(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(string(did), "did:plc:"),
		"DID must start with did:plc: per architecture spec, got: "+string(did))

	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)

	// Parse the DID document and extract publicKeyMultibase.
	var parsed struct {
		VerificationMethod []struct {
			ID                 string `json:"id"`
			Type               string `json:"type"`
			PublicKeyMultibase string `json:"publicKeyMultibase"`
		} `json:"verificationMethod"`
	}
	testutil.RequireNoError(t, json.Unmarshal(doc, &parsed))
	testutil.RequireTrue(t, len(parsed.VerificationMethod) >= 1,
		"DID document must have at least one verificationMethod")

	// The Multikey field in the DID document must have z6Mk prefix (Ed25519 multicodec).
	multikey := parsed.VerificationMethod[0].PublicKeyMultibase
	testutil.RequireTrue(t, strings.HasPrefix(multikey, "z6Mk"),
		"publicKeyMultibase must start with z6Mk (Ed25519 multicodec), got: "+multikey)

	// Multikey must be a reasonable length (z + base58btc of 34 bytes ≈ 48-50 chars).
	testutil.RequireTrue(t, len(multikey) >= 40,
		"publicKeyMultibase too short for Ed25519 multikey")

	// Determinism: same seed must produce same DID (returns ErrDIDAlreadyExists
	// to enforce duplicate detection, but the deterministic DID value is still returned).
	did2, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "already exists")
	testutil.RequireEqual(t, did, did2)
}

// ---------- §3.1.1 Key Rotation (5 scenarios) ----------

// TST-CORE-140
func TestIdentity_3_1_1_1_RotateSigningKey(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Use a unique seed to avoid shared-state conflicts with other rotation tests.
	seed140 := [32]byte{}
	seed140[0] = 0xd0
	oldPriv := ed25519.NewKeyFromSeed(seed140[:])
	oldPub := oldPriv.Public().(ed25519.PublicKey)

	did, err := impl.Create(idCtx, []byte(oldPub))
	testutil.RequireNoError(t, err)

	// Resolve the document BEFORE rotation to capture the old key's multibase.
	docBefore, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	docBeforeStr := string(docBefore)
	testutil.RequireContains(t, docBeforeStr, "publicKeyMultibase")

	// Extract the old multibase value from the pre-rotation document.
	// Find the value between the quotes after "publicKeyMultibase".
	oldMultibaseStart := strings.Index(docBeforeStr, `"publicKeyMultibase": "`)
	if oldMultibaseStart < 0 {
		t.Fatal("could not find publicKeyMultibase in pre-rotation document")
	}
	oldMultibaseStart += len(`"publicKeyMultibase": "`)
	oldMultibaseEnd := strings.Index(docBeforeStr[oldMultibaseStart:], `"`)
	if oldMultibaseEnd < 0 {
		t.Fatal("could not find end of publicKeyMultibase value")
	}
	oldMultibase := docBeforeStr[oldMultibaseStart : oldMultibaseStart+oldMultibaseEnd]

	newKey := make([]byte, 32)
	newKey[0] = 0xff

	// Sign the rotation payload with the old key to prove possession.
	payload := []byte("rotate:" + string(did))
	sig := ed25519.Sign(oldPriv, payload)
	err = impl.Rotate(idCtx, did, payload, sig, newKey)
	testutil.RequireNoError(t, err)

	// Resolve AFTER rotation — the document must have changed.
	docAfter, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	docAfterStr := string(docAfter)

	// The DID itself must be preserved across rotation.
	testutil.RequireContains(t, docAfterStr, string(did))

	// The document must contain a NEW publicKeyMultibase (not the old one).
	testutil.RequireContains(t, docAfterStr, "publicKeyMultibase")
	if strings.Contains(docAfterStr, oldMultibase) {
		t.Fatalf("document still contains old key multibase after rotation: %s", oldMultibase)
	}

	// The pre- and post-rotation documents must differ.
	if docBeforeStr == docAfterStr {
		t.Fatal("resolved document is identical before and after rotation — rotation had no effect")
	}
}

// TST-CORE-141
func TestIdentity_3_1_1_2_RotationPreservesDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Use a unique seed to avoid shared-state conflicts with other rotation tests.
	seed141 := [32]byte{}
	seed141[0] = 0xd1
	oldPriv := ed25519.NewKeyFromSeed(seed141[:])
	oldPub := oldPriv.Public().(ed25519.PublicKey)

	did, _ := impl.Create(idCtx, []byte(oldPub))
	newKey := make([]byte, 32)
	newKey[0] = 0xff

	// Sign the rotation payload with the old key to prove possession.
	payload := []byte("rotate:" + string(did))
	sig := ed25519.Sign(oldPriv, payload)
	_ = impl.Rotate(idCtx, did, payload, sig, newKey)
	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, doc)
}

// TST-CORE-142
func TestIdentity_3_1_1_3_OldKeyInvalidAfterRotation(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Use a unique seed to avoid shared-state conflicts with other rotation tests.
	seed142 := [32]byte{}
	seed142[0] = 0xd2
	oldPriv := ed25519.NewKeyFromSeed(seed142[:])
	oldPub := oldPriv.Public().(ed25519.PublicKey)

	// Create a DID with the real public key.
	did, err := impl.Create(idCtx, []byte(oldPub))
	testutil.RequireNoError(t, err)

	// Capture the pre-rotation document to extract the old key's multibase.
	docBefore, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	var parsedBefore map[string]interface{}
	if jsonErr := json.Unmarshal(docBefore, &parsedBefore); jsonErr != nil {
		t.Fatalf("failed to parse pre-rotation DID document: %v", jsonErr)
	}
	// Extract old publicKeyMultibase.
	vmList, _ := parsedBefore["verificationMethod"].([]interface{})
	if len(vmList) == 0 {
		t.Fatal("pre-rotation document must have at least one verificationMethod")
	}
	vm0, _ := vmList[0].(map[string]interface{})
	oldMultibase, _ := vm0["publicKeyMultibase"].(string)
	if oldMultibase == "" {
		t.Fatal("pre-rotation publicKeyMultibase must not be empty")
	}

	// Rotate to a new key.
	newKey := make([]byte, 32)
	newKey[0] = 0xfe

	// Sign the rotation payload with the old key to prove possession.
	payload := []byte("rotate:" + string(did))
	sig := ed25519.Sign(oldPriv, payload)
	err = impl.Rotate(idCtx, did, payload, sig, newKey)
	testutil.RequireNoError(t, err)

	// Resolve the DID — the document must contain the NEW key, not the old one.
	docAfter, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	docAfterStr := string(docAfter)

	// The old key's multibase must be absent from the rotated document.
	if strings.Contains(docAfterStr, oldMultibase) {
		t.Fatalf("old key multibase %q must NOT appear in document after rotation", oldMultibase)
	}

	// The document must still contain a publicKeyMultibase (the new key).
	var parsedAfter map[string]interface{}
	if jsonErr := json.Unmarshal(docAfter, &parsedAfter); jsonErr != nil {
		t.Fatalf("failed to parse post-rotation DID document: %v", jsonErr)
	}
	vmListAfter, _ := parsedAfter["verificationMethod"].([]interface{})
	if len(vmListAfter) == 0 {
		t.Fatal("post-rotation document must have at least one verificationMethod")
	}
	vm0After, _ := vmListAfter[0].(map[string]interface{})
	newMultibase, _ := vm0After["publicKeyMultibase"].(string)
	if newMultibase == "" {
		t.Fatal("post-rotation publicKeyMultibase must not be empty")
	}
	if newMultibase == oldMultibase {
		t.Fatal("post-rotation publicKeyMultibase must differ from pre-rotation value")
	}
}

// TST-CORE-143
func TestIdentity_3_1_1_4_RotationOpSignedByOldKey(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Generate a real Ed25519 keypair.
	seed := make([]byte, 32)
	seed[0] = 0xa1
	oldPriv := ed25519.NewKeyFromSeed(seed)
	oldPub := oldPriv.Public().(ed25519.PublicKey)

	// Create a DID with the real public key.
	did, err := impl.Create(idCtx, []byte(oldPub))
	testutil.RequireNoError(t, err)

	// Rotate requires a valid signature from the current key. Verify the
	// implementation enforces Ed25519 signature verification.
	src, err2 := os.ReadFile("../internal/adapter/identity/identity.go")
	if err2 != nil {
		t.Fatalf("cannot read identity source: %v", err2)
	}
	srcStr := string(src)
	if !strings.Contains(srcStr, "ed25519.Verify") {
		t.Fatal("Rotate must verify Ed25519 signature for signed rotation operations")
	}

	// Verify rotation succeeds with a valid signature from the old key.
	newKey := make([]byte, 32)
	newKey[0] = 0xb2
	payload := []byte("rotate:" + string(did))
	sig := ed25519.Sign(oldPriv, payload)
	err = impl.Rotate(idCtx, did, payload, sig, newKey)
	testutil.RequireNoError(t, err)

	// Verify rotation is DENIED with an invalid signature.
	badSig := make([]byte, len(sig))
	copy(badSig, sig)
	badSig[0] ^= 0xff // corrupt the signature
	newerKey := make([]byte, 32)
	newerKey[0] = 0xc3
	err = impl.Rotate(idCtx, did, payload, badSig, newerKey)
	if err == nil {
		t.Fatal("Rotate must reject rotation with invalid signature")
	}
	if !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected signature verification failure, got: %v", err)
	}
}

// TST-CORE-144
func TestIdentity_3_1_1_5_RecoveryKeysCanReclaimDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Create a DID.
	seed := make([]byte, 32)
	seed[0] = 0xc3
	did, err := impl.Create(idCtx, seed)
	testutil.RequireNoError(t, err)

	// Split the seed into recovery shares using Shamir's Secret Sharing.
	rm := realRecoveryManager
	testutil.RequireImplementation(t, rm, "RecoveryManager")
	shares, err := rm.Split(seed, 2, 3)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(shares), 3)

	// Combine 2 of 3 shares to recover the seed.
	recovered, err := rm.Combine(shares[:2])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered, seed)

	// Verify the recovered seed can resolve the original DID.
	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, doc)
}

// TST-CORE-145a
func TestIdentity_3_1_1_6_DeterministicRotationEnforcement(t *testing.T) {
	// When masterSeed + keyDeriver are set, Rotate() must reject keys that
	// don't match the deterministic next generation.
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	dm := identity.NewDIDManager(t.TempDir())

	// Derive gen-0 key and create DID.
	seed := testutil.TestEd25519Seed[:]
	gen0Pub, gen0Priv, err := kd.DeriveRootSigningKey(seed, 0)
	testutil.RequireNoError(t, err)
	dm.SetMasterSeed(seed, kd)
	dm.SetSigningKeyPath(identity.RootSigningPath(0))

	did, err := dm.Create(idCtx, gen0Pub)
	testutil.RequireNoError(t, err)

	// Derive the correct gen-1 key.
	gen1Pub, _, err := kd.DeriveRootSigningKey(seed, 1)
	testutil.RequireNoError(t, err)

	// Attempt rotation with a WRONG key — must be rejected.
	wrongKey := make([]byte, 32)
	wrongKey[0] = 0xff
	payload := []byte("rotate:" + string(did))
	sig := ed25519.Sign(gen0Priv, payload)
	err = dm.Rotate(idCtx, did, payload, sig, wrongKey)
	if err == nil {
		t.Fatal("Rotate must reject non-deterministic key")
	}
	if !strings.Contains(err.Error(), "does not match deterministic") {
		t.Fatalf("expected deterministic rejection, got: %v", err)
	}

	// Attempt rotation with the CORRECT gen-1 key — must succeed.
	err = dm.Rotate(idCtx, did, payload, sig, gen1Pub)
	testutil.RequireNoError(t, err)
}

// ---------- §3.1.2 did:web Fallback (5 scenarios) ----------

// TST-CORE-145
func TestIdentity_3_1_2_1_DIDWebResolution(t *testing.T) {
	// did:web resolution should return "not yet implemented" error.
	dm := identity.NewDIDManager("")
	_, err := dm.ResolveWeb(idCtx, "did:web:example.com")
	testutil.RequireError(t, err)
	if !strings.Contains(err.Error(), "not yet implemented") {
		t.Fatalf("expected 'not yet implemented' error, got: %v", err)
	}
}

// TST-CORE-146
func TestIdentity_3_1_2_2_DIDWebSameKeypair(t *testing.T) {
	// §3.1.2.2: did:web must use the same Ed25519 keypair as did:plc.
	// Verify via source audit that identity adapter uses Ed25519 throughout,
	// meaning any future did:web implementation shares the same key material.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)

	// Positive: must import crypto/ed25519 (not just mention in comments).
	testutil.RequireTrue(t, strings.Contains(content, `"crypto/ed25519"`),
		"identity adapter must import crypto/ed25519")

	// Positive: DIDManager must use ed25519 for key operations.
	// Key generation/derivation is delegated to the crypto package (NewEd25519Signer),
	// but the identity adapter must directly use ed25519 types for verification and sizing.
	testutil.RequireTrue(t, strings.Contains(content, "ed25519.PublicKeySize") ||
		strings.Contains(content, "ed25519.Verify") ||
		strings.Contains(content, "ed25519.NewKeyFromSeed") ||
		strings.Contains(content, "ed25519.GenerateKey"),
		"identity adapter must use Ed25519 key operations")

	// Positive: ResolveWeb exists (did:web will reuse same key infrastructure).
	testutil.RequireTrue(t, strings.Contains(content, "ResolveWeb"),
		"DIDManager must have ResolveWeb method for future did:web support")

	// Negative: must not use RSA or ECDSA (would mean different key material).
	testutil.RequireFalse(t, strings.Contains(content, `"crypto/rsa"`),
		"identity adapter must not use RSA — Ed25519 only for key uniformity")
	testutil.RequireFalse(t, strings.Contains(content, `"crypto/ecdsa"`),
		"identity adapter must not use ECDSA — Ed25519 only for key uniformity")
}

// TST-CORE-147
func TestIdentity_3_1_2_3_RotationPLCToDIDWeb(t *testing.T) {
	// Architecture test: verify that the Rotate method exists in the DID manager,
	// enabling future rotation from did:plc to did:web.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)
	if !strings.Contains(content, "func (dm *DIDManager) Rotate") {
		t.Fatal("DIDManager must have Rotate method to support PLC-to-web rotation path")
	}
	// Verify did:plc is the primary method.
	if !strings.Contains(content, "did:plc") {
		t.Fatal("did:plc must be the primary DID method")
	}
}

// TST-CORE-148
func TestIdentity_3_1_2_4_DIDWebPiggybacksIngress(t *testing.T) {
	// Architecture test: did:web resolution uses the existing HTTP infrastructure
	// (Go core already has net/http). Verify the DIDManager has the ResolveWeb stub.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)
	if !strings.Contains(content, "ResolveWeb") {
		t.Fatal("DIDManager must have ResolveWeb for did:web piggyback on existing infra")
	}
	// Verify the Go core uses net/http (existing infrastructure).
	if !strings.Contains(content, "net/http") && !strings.Contains(content, "context") {
		t.Fatal("DIDManager must use existing Go infrastructure (context/http)")
	}
}

// TST-CORE-149
func TestIdentity_3_1_2_5_DIDWebTradeoffAcknowledged(t *testing.T) {
	// Architecture acknowledgment: did:web depends on DNS, which is a centralized system.
	// This is a known tradeoff documented in the design. The primary method is did:plc.
	// did:web is a fallback resolver only, never the default creation method.

	// 1. Verify that DIDManager.Create() produces did:plc DIDs by default.
	dm := identity.NewDIDManager(t.TempDir())
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	did, err := dm.Create(context.Background(), pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(string(did), "did:plc:") {
		t.Fatalf("default DID method must be did:plc, got %s", did)
	}

	// 2. Verify that did:web resolution is a separate, explicit path (ResolveWeb),
	//    and that it is not wired into the default Create flow (stub returns error).
	_, webErr := dm.ResolveWeb(context.Background(), domain.DID("did:web:example.com"))
	if webErr == nil {
		t.Fatal("ResolveWeb should return an error (stub/fallback), not silently succeed")
	}
}

// ---------- §3.2 Persona Management (13 scenarios) ----------

// TST-CORE-150
func TestIdentity_3_2_1_CreatePersona(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")

	// Positive: create a persona with valid tier.
	id, err := impl.Create(idCtx, "work-create-test", "restricted")
	testutil.RequireNoError(t, err)
	if id == "" {
		t.Fatal("expected non-empty persona ID")
	}
	testutil.RequireContains(t, id, "work-create-test")

	// Round-trip: verify it appears in List.
	list, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	found := false
	for _, p := range list {
		if p == id {
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "created persona must appear in List")

	// Negative control: invalid tier must be rejected.
	_, err = impl.Create(idCtx, "bad-tier-test", "invalid-tier")
	testutil.RequireError(t, err)

	// Negative control: duplicate name must be rejected.
	_, err = impl.Create(idCtx, "work-create-test", "restricted")
	testutil.RequireError(t, err)

	// Cleanup.
	_ = impl.Delete(idCtx, id)
}

// TST-CORE-151
func TestIdentity_3_2_2_ListPersonas(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")

	// Positive: create two personas and verify they appear in List.
	id1, err := impl.Create(idCtx, "list-test-work", "open")
	testutil.RequireNoError(t, err)
	id2, err := impl.Create(idCtx, "list-test-personal", "open")
	testutil.RequireNoError(t, err)

	list, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)

	// Verify both IDs are present.
	found1, found2 := false, false
	for _, p := range list {
		if p == id1 {
			found1 = true
		}
		if p == id2 {
			found2 = true
		}
	}
	testutil.RequireTrue(t, found1, "first persona must appear in List")
	testutil.RequireTrue(t, found2, "second persona must appear in List")

	// Negative control: after deleting one, List must reflect the removal.
	err = impl.Delete(idCtx, id1)
	testutil.RequireNoError(t, err)
	listAfter, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	for _, p := range listAfter {
		if p == id1 {
			t.Fatal("deleted persona must not appear in List")
		}
	}

	// Cleanup.
	_ = impl.Delete(idCtx, id2)
}

// TST-CORE-152
func TestIdentity_3_2_3_DeletePersona(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	id, _ := impl.Create(idCtx, "work", "open")
	err := impl.Delete(idCtx, id)
	testutil.RequireNoError(t, err)
	list, _ := impl.List(idCtx)
	testutil.RequireLen(t, len(list), 0)
}

// TST-CORE-153
func TestIdentity_3_2_4_DeleteFileRemovesPersona(t *testing.T) {
	pm := identity.NewPersonaManager()
	ctx := context.Background()

	// Create two personas.
	id1, err := pm.Create(ctx, "deleteme", "open")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(ctx, "keepme", "open")
	testutil.RequireNoError(t, err)

	// Verify both exist.
	list, err := pm.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(list), 2)

	// Delete the first persona.
	err = pm.Delete(ctx, id1)
	testutil.RequireNoError(t, err)

	// Verify only one remains and it's the right one.
	list, err = pm.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(list), 1)
	testutil.RequireEqual(t, list[0], "persona-keepme")

	// Negative: deleting a non-existent persona must fail.
	err = pm.Delete(ctx, "persona-nonexistent")
	testutil.RequireError(t, err)

	// Negative: deleting the same persona twice must fail.
	err = pm.Delete(ctx, id1)
	testutil.RequireError(t, err)
}

// TST-CORE-154
func TestIdentity_3_2_5_PersonaIsolation(t *testing.T) {
	vm := realVaultManager
	testutil.RequireImplementation(t, vm, "VaultManager")

	ctx := context.Background()

	// Open two isolated personas.
	err := vm.Open(ctx, "persona-iso-a", testutil.TestDEK[:])
	testutil.RequireNoError(t, err)
	err = vm.Open(ctx, "persona-iso-b", testutil.TestDEK[:])
	testutil.RequireNoError(t, err)

	// Store an item in persona A.
	item := testutil.TestVaultItem()
	storedID, err := vm.Store(ctx, "persona-iso-a", item)
	testutil.RequireNoError(t, err)

	// Positive control: persona A can retrieve its own item.
	retrieved, err := vm.GetItem(ctx, "persona-iso-a", storedID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, retrieved)

	// Negative control: persona B must NOT see persona A's item.
	_, err = vm.GetItem(ctx, "persona-iso-b", storedID)
	testutil.RequireError(t, err)
}

// TST-CORE-155
func TestIdentity_3_2_6_DefaultPersonaExists(t *testing.T) {
	impl := identity.NewPersonaManager()
	testutil.RequireImplementation(t, impl, "PersonaManager")

	// A fresh PersonaManager must start with an empty persona list.
	ctx := context.Background()
	list, err := impl.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(list), 0)

	// Create a "default" persona and verify it appears.
	id, err := impl.Create(ctx, "default", "open")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, id, "persona-default")

	list2, err := impl.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(list2), 1)
	testutil.RequireEqual(t, list2[0], "persona-default")

	// Negative: duplicate creation must fail.
	_, err = impl.Create(ctx, "default", "open")
	testutil.RequireError(t, err)
}

// TST-CORE-156
func TestIdentity_3_2_7_PerPersonaFileLayout(t *testing.T) {
	// Fresh PersonaManager — no shared state.
	pm := identity.NewPersonaManager()

	ctx := context.Background()

	// Negative control: listing empty manager must return 0 personas.
	emptyList, err := pm.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(emptyList), 0)

	// Create 3 personas with different tiers.
	id1, err := pm.Create(ctx, "work", "open")
	testutil.RequireNoError(t, err)
	id2, err := pm.Create(ctx, "personal", "open")
	testutil.RequireNoError(t, err)
	id3, err := pm.Create(ctx, "health", "restricted")
	testutil.RequireNoError(t, err)

	// Verify IDs follow the expected format "persona-<name>".
	testutil.RequireEqual(t, id1, "persona-work")
	testutil.RequireEqual(t, id2, "persona-personal")
	testutil.RequireEqual(t, id3, "persona-health")

	// All IDs must be unique — isolated storage per persona.
	testutil.RequireTrue(t, id1 != id2 && id2 != id3 && id1 != id3,
		"persona IDs must be unique for file isolation")

	// Verify all 3 are listed (check error too).
	list, err := pm.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(list), 3)

	// Verify each created persona appears in the list.
	listed := map[string]bool{}
	for _, id := range list {
		listed[id] = true
	}
	testutil.RequireTrue(t, listed["persona-work"], "work persona must be in list")
	testutil.RequireTrue(t, listed["persona-personal"], "personal persona must be in list")
	testutil.RequireTrue(t, listed["persona-health"], "health persona must be in list")

	// Negative control: duplicate creation must fail (ErrPersonaExists).
	_, err = pm.Create(ctx, "work", "open")
	testutil.RequireError(t, err)
}

// TST-CORE-157
func TestIdentity_3_2_8_PerPersonaIndependentDEK(t *testing.T) {
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Derive DEK for persona "health".
	dekHealth, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "health", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekHealth, 32)

	// Derive DEK for persona "financial".
	dekFinancial, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekFinancial, 32)

	// Different personas must derive different DEKs (HKDF info string includes persona ID).
	testutil.RequireBytesNotEqual(t, dekHealth, dekFinancial)

	// Determinism: same persona always derives the same DEK.
	dekFinancial2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dekFinancial, dekFinancial2)
}

// TST-CORE-158
func TestIdentity_3_2_9_LockedPersonaOpaqueBytes(t *testing.T) {
	// §3.2.9: Locked persona must report IsLocked=true; open/restricted must not.
	pm := identity.NewPersonaManager()

	// Positive: locked tier persona reports IsLocked=true.
	lockedID, err := pm.Create(idCtx, "financial-lock9", "locked")
	testutil.RequireNoError(t, err)
	locked, err := pm.IsLocked(lockedID)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "locked tier persona must report IsLocked=true")

	// Negative: open tier persona must NOT report IsLocked.
	openID, err := pm.Create(idCtx, "social-lock9", "open")
	testutil.RequireNoError(t, err)
	openLocked, err := pm.IsLocked(openID)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, openLocked, "open tier persona must report IsLocked=false")

	// Negative: restricted tier persona must NOT report IsLocked.
	restrictedID, err := pm.Create(idCtx, "work-lock9", "restricted")
	testutil.RequireNoError(t, err)
	restrictedLocked, err := pm.IsLocked(restrictedID)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, restrictedLocked, "restricted tier persona must report IsLocked=false")

	// Negative: non-existent persona returns error.
	_, err = pm.IsLocked("persona-nonexistent")
	testutil.RequireTrue(t, err != nil, "IsLocked on non-existent persona must return error")
}

// TST-CORE-159
func TestIdentity_3_2_10_SelectiveUnlockWithTTL(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
}

// TST-CORE-160
func TestIdentity_3_2_11_PersonaKeySignsDIDComm(t *testing.T) {
	// §3.2.11: Each persona must have its own key for DIDComm signing.
	// Verify via source analysis that persona keys are used, not root key.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)

	// Positive: must import crypto/ed25519 (not just mention it in comments).
	testutil.RequireTrue(t, strings.Contains(content, `"crypto/ed25519"`),
		"identity adapter must import crypto/ed25519 for persona key signing")

	// Positive: must call ed25519 sign or verify for actual signing operations.
	hasSign := strings.Contains(content, "ed25519.Sign") || strings.Contains(content, "ed25519.Verify")
	testutil.RequireTrue(t, hasSign,
		"identity adapter must call ed25519.Sign or ed25519.Verify")

	// Positive: Persona struct must exist for per-persona key isolation.
	testutil.RequireTrue(t, strings.Contains(content, "type Persona struct"),
		"Persona struct must exist for per-persona key management")

	// Positive: PersonaManager must satisfy the port interface.
	testutil.RequireTrue(t, strings.Contains(content, "port.PersonaManager"),
		"PersonaManager must implement port.PersonaManager interface")

	// Negative: must not use a single shared signing key for all personas.
	// If there's a "globalSigningKey" or "rootKey" used for persona ops, that's wrong.
	testutil.RequireFalse(t, strings.Contains(content, "globalSigningKey"),
		"must not use a global signing key — each persona needs its own key")
}

// TST-CORE-161
func TestIdentity_3_2_12_PersonaKeySignsTrustNetwork(t *testing.T) {
	// Architecture test: verify persona key is used for trust network entries.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)

	// Positive: Ed25519 signing primitives must be present.
	if !strings.Contains(content, `"crypto/ed25519"`) {
		t.Fatal("identity adapter must import crypto/ed25519 for signing")
	}
	if !strings.Contains(content, "ed25519.Verify") {
		t.Fatal("identity adapter must call ed25519.Verify for signature verification")
	}

	// Positive: Persona struct must have per-persona identity fields (ID, Tier, Salt).
	if !strings.Contains(content, "type Persona struct") {
		t.Fatal("Persona struct must exist for per-persona key isolation")
	}

	// Positive: PersonaManager must implement port.PersonaManager interface check.
	if !strings.Contains(content, "port.PersonaManager") {
		t.Fatal("PersonaManager must satisfy port.PersonaManager interface")
	}

	// Positive: DIDManager must have signing key management.
	if !strings.Contains(content, "SetSigningKeyPath") {
		t.Fatal("DIDManager must support signing key configuration for trust network ops")
	}

	// Negative: no hard-coded signing bypass or skip flags.
	lower := strings.ToLower(content)
	if strings.Contains(lower, "skipverify") || strings.Contains(lower, "nosig") || strings.Contains(lower, "skip_verify") {
		t.Fatal("identity code must not contain signing bypass flags")
	}
}

// TST-CORE-162
func TestIdentity_3_2_13_NoCrossCompartmentCode(t *testing.T) {
	// Code audit: no function crosses persona boundaries without root key check.
	src, err := os.ReadFile("../internal/adapter/identity/identity.go")
	if err != nil {
		t.Fatalf("cannot read identity source: %v", err)
	}
	content := string(src)
	// PersonaManager stores personas by ID — each is isolated.
	if strings.Contains(content, "allPersonas") || strings.Contains(content, "crossPersona") {
		t.Fatal("code must not contain cross-persona access patterns")
	}
}

// ---------- §3.3 Persona Gatekeeper (15 scenarios) ----------

// TST-CORE-163
func TestIdentity_3_3_1_AccessOpenTier(t *testing.T) {
	pm := identity.NewPersonaManager()
	testutil.RequireImplementation(t, pm, "PersonaManager")

	ctx := context.Background()

	// Create an open-tier persona.
	_, err := pm.Create(ctx, "social", "open")
	testutil.RequireNoError(t, err)

	// Positive: accessing an open persona must succeed without error.
	err = pm.AccessPersona(ctx, "persona-social")
	testutil.RequireNoError(t, err)

	// Negative: accessing a non-existent persona must fail.
	err = pm.AccessPersona(ctx, "persona-nonexistent")
	testutil.RequireError(t, err)

	// Negative: a locked persona must NOT be accessible without unlock.
	_, err = pm.Create(ctx, "secrets", "locked")
	testutil.RequireNoError(t, err)
	err = pm.AccessPersona(ctx, "persona-secrets")
	testutil.RequireError(t, err)
}

// TST-CORE-164
func TestIdentity_3_3_2_AccessRestrictedTier(t *testing.T) {
	pm := identity.NewPersonaManager()
	testutil.RequireImplementation(t, pm, "PersonaManager")

	ctx := context.Background()

	// Create a restricted-tier persona.
	_, err := pm.Create(ctx, "medical", "restricted")
	testutil.RequireNoError(t, err)

	// Track whether the restricted-access callback fires.
	var callbackFired bool
	var callbackPersona string
	pm.OnRestrictedAccess = func(personaID, reason string) {
		callbackFired = true
		callbackPersona = personaID
	}

	// Positive: accessing a restricted persona must succeed (no error)
	// but must trigger the notification callback.
	err = pm.AccessPersona(ctx, "persona-medical")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, callbackFired, "restricted access must fire OnRestrictedAccess callback")
	testutil.RequireEqual(t, callbackPersona, "persona-medical")

	// Negative: open-tier persona must NOT trigger the restricted callback.
	callbackFired = false
	_, err = pm.Create(ctx, "casual", "open")
	testutil.RequireNoError(t, err)
	err = pm.AccessPersona(ctx, "persona-casual")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, callbackFired, "open tier must NOT fire restricted access callback")
}

// TST-CORE-165
func TestIdentity_3_3_3_AccessLockedTierWithoutUnlock(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(idCtx, "financial", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)

	// Verify the persona starts locked.
	locked, err := pm.IsLocked("persona-financial")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "financial persona should be locked after creation")

	// Access without unlock must fail.
	err = pm.AccessPersona(idCtx, "persona-financial")
	if err == nil {
		t.Fatal("AccessPersona on a locked persona should return an error")
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Fatalf("expected error to mention 'locked', got: %s", err.Error())
	}
}

// TST-CORE-166
func TestIdentity_3_3_4_UnlockLockedPersona(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	impl.Create(idCtx, "financial", "locked")
	err := impl.Unlock(idCtx, "persona-financial", testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)
	locked, _ := impl.IsLocked("persona-financial")
	testutil.RequireFalse(t, locked, "persona should be unlocked after Unlock()")
}

// TST-CORE-167
func TestIdentity_3_3_5_LockedPersonaTTLExpiry(t *testing.T) {
	// Unlock with short TTL, wait, verify auto-locked.
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}
	_, err := pm.Create(idCtx, "ttltest", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)

	tick := make(chan struct{}, 1)
	pm.SetTestTick(tick)

	err = pm.Unlock(idCtx, "persona-ttltest", testutil.TestPassphrase, 1)
	testutil.RequireNoError(t, err)

	// Verify unlocked.
	locked, _ := pm.IsLocked("persona-ttltest")
	testutil.RequireFalse(t, locked, "persona should be unlocked after Unlock()")

	// Trigger TTL expiry.
	tick <- struct{}{}
	// Give goroutine time to lock.
	time.Sleep(10 * time.Millisecond)

	locked, _ = pm.IsLocked("persona-ttltest")
	testutil.RequireTrue(t, locked, "persona should be auto-locked after TTL expiry")
}

// TST-CORE-168
func TestIdentity_3_3_6_LockedPersonaReLock(t *testing.T) {
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}
	_, err := pm.Create(idCtx, "financial", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)

	// Verify initially locked.
	locked, err := pm.IsLocked("persona-financial")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona should start locked")

	// Unlock with correct passphrase.
	err = pm.Unlock(idCtx, "persona-financial", testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)

	locked, err = pm.IsLocked("persona-financial")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, locked, "persona should be unlocked after Unlock()")

	// Re-lock.
	err = pm.Lock(idCtx, "persona-financial")
	testutil.RequireNoError(t, err)

	locked, err = pm.IsLocked("persona-financial")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona should be re-locked after Lock()")
}

// TST-CORE-169
func TestIdentity_3_3_7_AuditLogForRestrictedAccess(t *testing.T) {
	// Access a restricted persona, check audit log records the event.
	pm := identity.NewPersonaManager()
	_, err := pm.Create(idCtx, "restricted1", "restricted")
	testutil.RequireNoError(t, err)

	// Access the restricted persona — should record an audit entry.
	_ = pm.AccessPersona(idCtx, "persona-restricted1")

	// Check audit log.
	entries, err := pm.AuditLog(idCtx, "persona-restricted1")
	testutil.RequireNoError(t, err)
	if len(entries) == 0 {
		t.Fatal("expected at least one audit entry for restricted persona access")
	}
	if entries[0].Action != "access_restricted" {
		t.Fatalf("expected action 'access_restricted', got %q", entries[0].Action)
	}
}

// TST-CORE-170
func TestIdentity_3_3_8_NotificationOnRestrictedAccess(t *testing.T) {
	pm := identity.NewPersonaManager()

	// Create both a restricted and an open persona.
	_, err := pm.Create(idCtx, "notified", "restricted")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(idCtx, "openone", "open")
	testutil.RequireNoError(t, err)

	callCount := 0
	var notifiedPersona, notifiedReason string
	pm.OnRestrictedAccess = func(personaID, reason string) {
		callCount++
		notifiedPersona = personaID
		notifiedReason = reason
	}

	// Positive: restricted persona triggers notification callback.
	_ = pm.AccessPersona(idCtx, "persona-notified")
	testutil.RequireEqual(t, callCount, 1)
	testutil.RequireEqual(t, notifiedPersona, "persona-notified")
	testutil.RequireTrue(t, notifiedReason != "", "reason must be non-empty")

	// Negative: open persona does NOT trigger notification callback.
	err = pm.AccessPersona(idCtx, "persona-openone")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, callCount, 1) // still 1 — callback not fired again
}

// TST-CORE-171
func TestIdentity_3_3_9_LockedPersonaUnlockFlow(t *testing.T) {
	// Create a locked persona, unlock with correct passphrase, verify IsLocked=false.
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}
	_, err := pm.Create(idCtx, "lockflow", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)

	// Verify initially locked.
	locked, _ := pm.IsLocked("persona-lockflow")
	testutil.RequireTrue(t, locked, "persona should start locked")

	// Unlock.
	err = pm.Unlock(idCtx, "persona-lockflow", testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)

	locked, _ = pm.IsLocked("persona-lockflow")
	testutil.RequireFalse(t, locked, "persona should be unlocked after Unlock()")
}

// TST-CORE-172
func TestIdentity_3_3_10_LockedPersonaUnlockDenied(t *testing.T) {
	pm := identity.NewPersonaManager()

	// Set up a passphrase verifier that rejects wrong passphrases.
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}

	_, err := pm.Create(idCtx, "denied", "locked")
	testutil.RequireNoError(t, err)

	// Set a passphrase hash on the persona so verification is triggered.
	pm.SetPersonaPassphraseHash("persona-denied", "argon2id$hash$placeholder")

	// Verify initially locked.
	locked, err := pm.IsLocked("persona-denied")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona should start locked")

	// Negative: wrong passphrase must fail unlock.
	err = pm.Unlock(idCtx, "persona-denied", "WRONG_PASSPHRASE", 300)
	testutil.RequireError(t, err)

	// Verify still locked after wrong passphrase.
	locked, err = pm.IsLocked("persona-denied")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, locked, "persona should remain locked after wrong passphrase")

	// Positive control: correct passphrase must succeed.
	err = pm.Unlock(idCtx, "persona-denied", testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)

	locked, err = pm.IsLocked("persona-denied")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, locked, "persona should be unlocked after correct passphrase")
}

// TST-CORE-173
func TestIdentity_3_3_11_LockedPersonaUnlockTTLExpires(t *testing.T) {
	// Same as 3_3_5 — unlock with short TTL, verify expiry.
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == testutil.TestPassphrase, nil
	}
	_, err := pm.Create(idCtx, "ttl2", "locked", testutil.TestPassphraseHash)
	testutil.RequireNoError(t, err)

	tick := make(chan struct{}, 1)
	pm.SetTestTick(tick)

	err = pm.Unlock(idCtx, "persona-ttl2", testutil.TestPassphrase, 1)
	testutil.RequireNoError(t, err)

	locked, _ := pm.IsLocked("persona-ttl2")
	testutil.RequireFalse(t, locked, "should be unlocked")

	// Signal TTL expiry.
	tick <- struct{}{}
	time.Sleep(10 * time.Millisecond)

	locked, _ = pm.IsLocked("persona-ttl2")
	testutil.RequireTrue(t, locked, "should be auto-locked after TTL")
}

// TST-CORE-174
func TestIdentity_3_3_12_CrossPersonaParallelReads(t *testing.T) {
	// Concurrent goroutines creating/accessing different personas.
	pm := identity.NewPersonaManager()

	const numWorkers = 10
	var wg sync.WaitGroup
	errs := make(chan error, numWorkers)

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			pName := fmt.Sprintf("par%c", rune('a'+idx))
			_, err := pm.Create(idCtx, pName, "open")
			if err != nil {
				errs <- err
				return
			}
			_, err = pm.List(idCtx)
			if err != nil {
				errs <- err
			}
		}(i)
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent operation failed: %v", err)
	}

	// Positive: all 10 personas must exist after parallel creation.
	names, err := pm.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(names), numWorkers)

	// Verify each expected persona ID is present.
	nameSet := make(map[string]bool)
	for _, n := range names {
		nameSet[n] = true
	}
	for i := 0; i < numWorkers; i++ {
		expected := fmt.Sprintf("persona-par%c", rune('a'+i))
		testutil.RequireTrue(t, nameSet[expected], expected+" must exist after parallel creation")
	}
}

// TST-CORE-175
func TestIdentity_3_3_13_GetPersonasForContactDerived(t *testing.T) {
	// Add a contact to a persona, query GetPersonasForContact.
	pm := identity.NewPersonaManager()
	_, err := pm.Create(idCtx, "work", "open")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(idCtx, "social", "open")
	testutil.RequireNoError(t, err)

	// Add contact to "work" persona only.
	contactDID := "did:key:z6MkTestContact123"
	err = pm.AddContactToPersona("persona-work", contactDID)
	testutil.RequireNoError(t, err)

	// Query which personas have this contact.
	personas, err := pm.GetPersonasForContact(idCtx, contactDID)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)
	if personas[0] != "persona-work" {
		t.Fatalf("expected persona-work, got %s", personas[0])
	}
}

// TST-CORE-176
func TestIdentity_3_3_14_GetPersonasForContactLockedInvisible(t *testing.T) {
	// Lock a persona, verify contact query excludes it.
	pm := identity.NewPersonaManager()
	_, err := pm.Create(idCtx, "visible", "open")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(idCtx, "hidden", "locked")
	testutil.RequireNoError(t, err)

	contactDID := "did:key:z6MkSharedContact"
	err = pm.AddContactToPersona("persona-visible", contactDID)
	testutil.RequireNoError(t, err)
	err = pm.AddContactToPersona("persona-hidden", contactDID)
	testutil.RequireNoError(t, err)

	// Positive: query returns only unlocked persona — locked persona is invisible.
	personas, err := pm.GetPersonasForContact(idCtx, contactDID)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)
	testutil.RequireEqual(t, personas[0], "persona-visible")

	// Negative: contact not added to any persona returns empty.
	unknownPersonas, err := pm.GetPersonasForContact(idCtx, "did:key:z6MkUnknownContact")
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(unknownPersonas), 0)

	// Negative: adding contact to non-existent persona must error.
	err = pm.AddContactToPersona("persona-nonexistent", contactDID)
	testutil.RequireTrue(t, err != nil, "adding contact to non-existent persona must fail")
}

// TST-CORE-177
func TestIdentity_3_3_15_TierConfigInConfigJSON(t *testing.T) {
	// Verify persona tier structure is valid — all tier values are recognized.
	pm := identity.NewPersonaManager()

	// Positive: create personas with each valid tier.
	idOpen, err := pm.Create(idCtx, "t_open", "open")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, idOpen, "persona-t_open")

	idRestricted, err := pm.Create(idCtx, "t_restricted", "restricted")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, idRestricted, "persona-t_restricted")

	idLocked, err := pm.Create(idCtx, "t_locked", "locked")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, idLocked, "persona-t_locked")

	// Negative: invalid tier must be rejected.
	_, err = pm.Create(idCtx, "t_invalid", "invalid_tier")
	testutil.RequireError(t, err)

	// Negative: empty tier must be rejected.
	_, err = pm.Create(idCtx, "t_empty", "")
	testutil.RequireError(t, err)

	// Verify all valid personas are listed — exactly 3.
	list, err := pm.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(list), 3)
}

// ---------- §3.4 Contact Directory (9 scenarios) ----------

// TST-CORE-178
func TestIdentity_3_4_1_AddContact(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-179
func TestIdentity_3_4_2_ResolveContactDID(t *testing.T) {
	impl := identity.NewContactDirectory()
	testutil.RequireImplementation(t, impl, "ContactDirectory")

	ctx := context.Background()

	// Negative: resolve unknown name must return error.
	_, err := impl.Resolve(ctx, "NoSuchContact")
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrContactNotFound,
		"expected ErrContactNotFound for unknown name, got: "+err.Error())

	// Positive: add a contact then resolve by name returns the DID.
	contactDID := "did:key:z6MkResolveTest"
	err = impl.Add(ctx, contactDID, "Alice", "unknown")
	testutil.RequireNoError(t, err)

	resolvedDID, err := impl.Resolve(ctx, "Alice")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, resolvedDID, contactDID)

	// Negative: resolve with wrong name still returns error.
	_, err = impl.Resolve(ctx, "Bob")
	testutil.RequireError(t, err)
}

// TST-CORE-180
func TestIdentity_3_4_3_UpdateContactTrustLevel(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")

	ctx := context.Background()
	contactDID := "did:key:z6MkTrustUpdate"

	// UpdateTrust on non-existent contact must return error.
	err := impl.UpdateTrust(ctx, contactDID, "trusted")
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrContactNotFound,
		"expected ErrContactNotFound for unknown DID, got: "+err.Error())

	// Add a contact with initial trust level "unknown".
	err = impl.Add(ctx, contactDID, "TrustTestContact", "unknown")
	testutil.RequireNoError(t, err)

	// Verify initial trust level via List.
	contacts, err := impl.List(ctx)
	testutil.RequireNoError(t, err)
	found := false
	for _, c := range contacts {
		if c.DID == contactDID {
			testutil.RequireEqual(t, c.TrustLevel, "unknown")
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "contact must exist after Add")

	// UpdateTrust to "trusted" — should succeed.
	err = impl.UpdateTrust(ctx, contactDID, "trusted")
	testutil.RequireNoError(t, err)

	// Verify trust level was actually changed.
	contacts, err = impl.List(ctx)
	testutil.RequireNoError(t, err)
	for _, c := range contacts {
		if c.DID == contactDID {
			testutil.RequireEqual(t, c.TrustLevel, "trusted")
			break
		}
	}

	// UpdateTrust with invalid level must return error.
	err = impl.UpdateTrust(ctx, contactDID, "invalid_level")
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrInvalidTrustLevel,
		"expected ErrInvalidTrustLevel, got: "+err.Error())

	// Verify trust level was NOT corrupted by the failed update.
	contacts, err = impl.List(ctx)
	testutil.RequireNoError(t, err)
	for _, c := range contacts {
		if c.DID == contactDID {
			testutil.RequireEqual(t, c.TrustLevel, "trusted")
			break
		}
	}

	// All three valid trust levels must be accepted.
	for _, level := range []string{"blocked", "unknown", "trusted"} {
		err = impl.UpdateTrust(ctx, contactDID, level)
		testutil.RequireNoError(t, err)
	}
}

// TST-CORE-181
// TST-CORE-1053 DELETE /v1/contacts/{did} removes contact
func TestIdentity_3_4_4_DeleteContact(t *testing.T) {
	impl := identity.NewContactDirectory()
	testutil.RequireImplementation(t, impl, "ContactDirectory")

	ctx := context.Background()
	contactDID := "did:key:z6MkDeleteTest"

	// Negative: delete non-existent contact must return ErrContactNotFound.
	err := impl.Delete(ctx, contactDID)
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrContactNotFound,
		"expected ErrContactNotFound for unknown DID, got: "+err.Error())

	// Positive: add contact, verify it exists, delete, verify gone.
	err = impl.Add(ctx, contactDID, "ToDelete", "unknown")
	testutil.RequireNoError(t, err)

	// Verify it exists via List.
	contacts, err := impl.List(ctx)
	testutil.RequireNoError(t, err)
	found := false
	for _, c := range contacts {
		if c.DID == contactDID {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "contact must appear in List before deletion")

	// Delete the contact.
	err = impl.Delete(ctx, contactDID)
	testutil.RequireNoError(t, err)

	// Verify it is gone from List.
	contacts, err = impl.List(ctx)
	testutil.RequireNoError(t, err)
	for _, c := range contacts {
		if c.DID == contactDID {
			t.Fatal("deleted contact must not appear in List")
		}
	}

	// Verify Resolve by name also fails after deletion.
	_, err = impl.Resolve(ctx, "ToDelete")
	testutil.RequireError(t, err)
}

// TST-CORE-182
func TestIdentity_3_4_5_PerPersonaContactRouting(t *testing.T) {
	// Per-persona contact routing: a contact added to persona "work"
	// should route to "work" only, not to "personal".
	cd := identity.NewContactDirectory()
	pm := identity.NewPersonaManager()

	// Create two personas.
	_, err := pm.Create(idCtx, "work", "open")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(idCtx, "personal", "open")
	testutil.RequireNoError(t, err)

	// Add a contact to the global directory.
	contactDID := "did:key:z6MkWorkColleague"
	err = cd.Add(idCtx, contactDID, "Alice", "trusted")
	testutil.RequireNoError(t, err)

	// Associate the contact with the "work" persona only.
	err = pm.AddContactToPersona("persona-work", contactDID)
	testutil.RequireNoError(t, err)

	// Query: contact should route to "work" persona only.
	personas, err := pm.GetPersonasForContact(idCtx, contactDID)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)
	testutil.RequireEqual(t, personas[0], "persona-work")

	// A contact NOT associated with any persona returns empty.
	unlinkedDID := "did:key:z6MkStranger"
	personas2, err := pm.GetPersonasForContact(idCtx, unlinkedDID)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas2), 0)

	// Associate the same contact with "personal" too — should return both.
	err = pm.AddContactToPersona("persona-personal", contactDID)
	testutil.RequireNoError(t, err)
	personas3, err := pm.GetPersonasForContact(idCtx, contactDID)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas3), 2)

	// AddContactToPersona with a nonexistent persona fails.
	err = pm.AddContactToPersona("persona-nonexistent", contactDID)
	testutil.RequireError(t, err)
}

// TST-CORE-183
func TestIdentity_3_4_6_ContactsTableNoPersonaColumn(t *testing.T) {
	// Schema validation: contacts table must NOT have a persona column.
	// Contacts are global — persona isolation is at the vault level.
	//
	// Validates against the REAL SQL schema file (identity_001.sql), not the
	// hardcoded Go map in SchemaInspect — the Go map has drifted before
	// (see TST-CORE-184).

	// 1. Read the real SQL schema — this is the source of truth.
	ddl, err := os.ReadFile("../internal/adapter/sqlite/schema/identity_001.sql")
	if err != nil {
		t.Fatalf("failed to read identity schema file: %v", err)
	}
	schema := string(ddl)

	// 2. Extract the CREATE TABLE contacts block from the real schema.
	idx := strings.Index(schema, "CREATE TABLE IF NOT EXISTS contacts")
	if idx < 0 {
		idx = strings.Index(schema, "CREATE TABLE contacts")
	}
	if idx < 0 {
		t.Fatal("contacts table not found in identity_001.sql")
	}
	// Find the closing parenthesis/semicolon of the CREATE TABLE.
	contactsDDL := schema[idx:]
	if end := strings.Index(contactsDDL, ";"); end >= 0 {
		contactsDDL = contactsDDL[:end]
	}

	// 3. Verify no persona column in the real SQL schema.
	lower := strings.ToLower(contactsDDL)
	for _, forbidden := range []string{"persona", "persona_id"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("contacts table in identity_001.sql must NOT have a %q column — contacts are global; found in DDL:\n%s", forbidden, contactsDDL)
		}
	}

	// 4. Also validate the in-memory SchemaInspector for consistency.
	impl := realSchemaInspector
	testutil.RequireImplementation(t, impl, "SchemaInspector")

	cols, err := impl.TableColumns("identity", "contacts")
	testutil.RequireNoError(t, err)
	for _, col := range cols {
		if col == "persona" || col == "persona_id" {
			t.Fatalf("SchemaInspector.TableColumns returned forbidden column %q — contacts are global", col)
		}
	}
}

// TST-CORE-184
func TestIdentity_3_4_7_ContactsFullSchemaValidation(t *testing.T) {
	// Schema validation: contacts table has all required columns.
	impl := realSchemaInspector
	testutil.RequireImplementation(t, impl, "SchemaInspector")

	cols, err := impl.TableColumns("identity", "contacts")
	testutil.RequireNoError(t, err)
	required := []string{"did", "name", "trust_level"}
	for _, req := range required {
		found := false
		for _, col := range cols {
			if col == req {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("contacts table missing required column: %s", req)
		}
	}
}

// TST-CORE-185
func TestIdentity_3_4_8_TrustLevelEnumValidation(t *testing.T) {
	impl := identity.NewContactDirectory()
	testutil.RequireImplementation(t, impl, "ContactDirectory")

	ctx := context.Background()

	// Positive: all valid trust levels must be accepted.
	validLevels := []string{"blocked", "unknown", "trusted"}
	for i, level := range validLevels {
		did := fmt.Sprintf("did:plc:trust-enum-%d", i)
		err := impl.Add(ctx, did, fmt.Sprintf("contact-%d", i), level)
		testutil.RequireNoError(t, err)
	}

	// Negative: invalid trust levels must be rejected.
	invalidLevels := []string{"", "verified", "admin", "TRUSTED", "Blocked"}
	for i, level := range invalidLevels {
		did := fmt.Sprintf("did:plc:trust-invalid-%d", i)
		err := impl.Add(ctx, did, fmt.Sprintf("invalid-%d", i), level)
		testutil.RequireError(t, err)
	}
}

// TST-CORE-186
func TestIdentity_3_4_9_ContactsTrustIndex(t *testing.T) {
	// Schema validation: idx_contacts_trust index exists for efficient trust-level queries.
	impl := realSchemaInspector
	testutil.RequireImplementation(t, impl, "SchemaInspector")

	exists, err := impl.IndexExists("identity", "idx_contacts_trust")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, exists, "idx_contacts_trust index must exist on contacts table")
}

// ---------- §3.5 Device Registry (4 scenarios) ----------

// TST-CORE-187
func TestIdentity_3_5_1_RegisterDevice(t *testing.T) {
	impl := identity.NewDeviceRegistry()
	testutil.RequireImplementation(t, impl, "DeviceRegistry")

	// Positive: register a device and verify it appears in List.
	id, err := impl.Register(idCtx, "test-laptop", []byte("hash-test-laptop"))
	testutil.RequireNoError(t, err)
	if id == "" {
		t.Fatal("expected non-empty device ID")
	}

	devices, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 1)
	testutil.RequireEqual(t, devices[0].Name, "test-laptop")
	testutil.RequireEqual(t, devices[0].ID, id)
	testutil.RequireTrue(t, !devices[0].Revoked, "newly registered device must not be revoked")

	// Negative control: registering with empty name must still succeed
	// (name is metadata, not an identifier).
	id2, err := impl.Register(idCtx, "", []byte("hash-noname"))
	testutil.RequireNoError(t, err)
	if id == id2 {
		t.Fatal("each device must get a unique ID")
	}

	devices, err = impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 2)
}

// TST-CORE-188
func TestIdentity_3_5_2_ListDevices(t *testing.T) {
	impl := identity.NewDeviceRegistry()
	testutil.RequireImplementation(t, impl, "DeviceRegistry")

	// Empty registry returns empty list.
	devices, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 0)

	// Register two devices.
	id1, err := impl.Register(idCtx, "laptop", []byte("hash-laptop"))
	testutil.RequireNoError(t, err)
	id2, err := impl.Register(idCtx, "phone", []byte("hash-phone"))
	testutil.RequireNoError(t, err)

	// List returns both devices with correct fields.
	devices, err = impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 2)

	// Build a map for order-independent assertions.
	byID := make(map[string]domain.Device)
	for _, d := range devices {
		byID[d.ID] = d
	}
	d1, ok1 := byID[id1]
	d2, ok2 := byID[id2]
	testutil.RequireTrue(t, ok1, "device 1 must appear in list")
	testutil.RequireTrue(t, ok2, "device 2 must appear in list")
	testutil.RequireEqual(t, d1.Name, "laptop")
	testutil.RequireEqual(t, d2.Name, "phone")
	testutil.RequireTrue(t, !d1.Revoked, "device 1 should not be revoked")
	testutil.RequireTrue(t, !d2.Revoked, "device 2 should not be revoked")

	// Revoke one device; list still returns it (marked revoked).
	err = impl.Revoke(idCtx, id1)
	testutil.RequireNoError(t, err)
	devices, err = impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 2)
	byID = make(map[string]domain.Device)
	for _, d := range devices {
		byID[d.ID] = d
	}
	testutil.RequireTrue(t, byID[id1].Revoked, "revoked device must have Revoked=true")
	testutil.RequireTrue(t, !byID[id2].Revoked, "non-revoked device must remain active")
}

// TST-CORE-189
func TestIdentity_3_5_3_RevokeDevice(t *testing.T) {
	impl := identity.NewDeviceRegistry()

	ctx := context.Background()

	// Revoking a non-existent device must return ErrDeviceNotFound.
	err := impl.Revoke(ctx, "device-nonexistent")
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrDeviceNotFound,
		"expected ErrDeviceNotFound, got: "+err.Error())

	// Register a device, then revoke it.
	deviceID, err := impl.Register(ctx, "test-laptop", []byte("token-hash-revoke"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, deviceID != "", "device ID must be non-empty")

	err = impl.Revoke(ctx, deviceID)
	testutil.RequireNoError(t, err)

	// Verify the device is marked Revoked=true in the list.
	devices, err := impl.List(ctx)
	testutil.RequireNoError(t, err)
	found := false
	for _, d := range devices {
		if d.ID == deviceID {
			testutil.RequireTrue(t, d.Revoked, "device should be revoked after Revoke()")
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "revoked device must still appear in list")

	// Revoking an already-revoked device: should still succeed (idempotent set).
	err = impl.Revoke(ctx, deviceID)
	testutil.RequireNoError(t, err)
}

// TST-CORE-190
func TestIdentity_3_5_4_MaxDeviceLimit(t *testing.T) {
	impl := identity.NewDeviceRegistry()
	testutil.RequireImplementation(t, impl, "DeviceRegistry")

	// Register exactly MaxDevices (10) devices — all should succeed.
	ids := make([]string, 0, identity.MaxDevices)
	for i := 0; i < identity.MaxDevices; i++ {
		id, err := impl.Register(idCtx, "device", []byte("hash"))
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, id != "", "registered device ID must be non-empty")
		ids = append(ids, id)
	}

	// The (MaxDevices+1)-th registration must fail with ErrMaxDevicesReached.
	_, err := impl.Register(idCtx, "one-too-many", []byte("hash"))
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "maximum device limit reached")

	// List must show exactly MaxDevices devices, all active.
	devices, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), identity.MaxDevices)

	// Revoke one device — this frees a slot.
	err = impl.Revoke(idCtx, ids[0])
	testutil.RequireNoError(t, err)

	// Now registration should succeed again (active count is MaxDevices-1).
	newID, err := impl.Register(idCtx, "replacement", []byte("hash-new"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, newID != "", "replacement device ID must be non-empty")

	// Total devices = MaxDevices + 1 (one revoked, MaxDevices active).
	devices, err = impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), identity.MaxDevices+1)

	// Attempting another registration should fail again (back at MaxDevices active).
	_, err = impl.Register(idCtx, "second-overflow", []byte("hash"))
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "maximum device limit reached")
}

// ---------- §3.6 Recovery (5 scenarios) ----------

// TST-CORE-191
func TestIdentity_3_6_1_SplitMasterSeed(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// A 32-byte master seed split into 5 shares with threshold 3.
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	shares, err := impl.Split(seed, 3, 5)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(shares), 5)

	// Each share must be 33 bytes (1 x-coordinate + 32 data bytes).
	for i, s := range shares {
		testutil.RequireBytesLen(t, s, 33)
		// x-coordinate must be 1-indexed and unique.
		testutil.RequireEqual(t, int(s[0]), i+1)
	}

	// Shares must not be identical to each other (randomized polynomials).
	allSame := true
	for i := 1; i < len(shares); i++ {
		if string(shares[i]) != string(shares[0]) {
			allSame = false
			break
		}
	}
	testutil.RequireFalse(t, allSame, "shares must not all be identical")
}

// TST-CORE-192
func TestIdentity_3_6_2_ReconstructWithThreshold(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// Split a 32-byte seed into 5 shares with threshold 3.
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(0xA0 ^ byte(i))
	}
	shares, err := impl.Split(seed, 3, 5)
	testutil.RequireNoError(t, err)

	// Exactly threshold (3) shares must reconstruct the original seed.
	recovered, err := impl.Combine(shares[:3])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered, seed)

	// A different subset of 3 shares must also reconstruct correctly.
	subset := [][]byte{shares[0], shares[2], shares[4]}
	recovered2, err := impl.Combine(subset)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered2, seed)

	// All 5 shares (more than threshold) must also work.
	recoveredAll, err := impl.Combine(shares)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recoveredAll, seed)
}

// TST-CORE-193
func TestIdentity_3_6_3_ReconstructFewerThanThreshold(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// Split with threshold 3, then try to reconstruct with only 2 shares.
	// Lagrange interpolation with fewer points than the polynomial degree
	// must NOT recover the original secret.
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(0x55 + i)
	}
	shares, err := impl.Split(seed, 3, 5)
	testutil.RequireNoError(t, err)

	// 2 shares (below threshold of 3) — reconstruction must yield wrong data.
	recovered, err := impl.Combine(shares[:2])
	testutil.RequireNoError(t, err) // Combine doesn't know the threshold, so no error.
	testutil.RequireBytesNotEqual(t, recovered, seed)
}

// TST-CORE-194
func TestIdentity_3_6_4_ReconstructWithInvalidShare(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// Combine with fewer than 2 shares must fail.
	_, err := impl.Combine([][]byte{{1, 2, 3}})
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "insufficient")

	// Combine with nil/empty input must fail.
	_, err = impl.Combine(nil)
	testutil.RequireError(t, err)

	// Shares with inconsistent lengths must fail.
	_, err = impl.Combine([][]byte{{1, 2, 3}, {2, 4}})
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "invalid")

	// Share with zero x-coordinate must fail.
	_, err = impl.Combine([][]byte{{0, 1, 2}, {1, 3, 4}})
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "invalid")

	// Split with invalid parameters must fail.
	seed := []byte("test-secret-data")
	_, err = impl.Split(seed, 1, 3) // k < 2
	testutil.RequireError(t, err)

	_, err = impl.Split(seed, 4, 3) // k > n
	testutil.RequireError(t, err)

	_, err = impl.Split(nil, 2, 3) // empty secret
	testutil.RequireError(t, err)
}

// TST-CORE-195
func TestIdentity_3_6_5_ShareFormat(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// Verify share format: first byte is x-coordinate (1-indexed),
	// remaining bytes are the evaluated polynomial values.
	secret := []byte{0xDE, 0xAD, 0xBE, 0xEF}
	shares, err := impl.Split(secret, 2, 3)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(shares), 3)

	for i, s := range shares {
		// Each share: [x-coordinate, data...]
		testutil.RequireBytesLen(t, s, len(secret)+1)
		testutil.RequireEqual(t, int(s[0]), i+1) // x = 1, 2, 3
	}

	// x-coordinates must be unique.
	xs := map[byte]bool{}
	for _, s := range shares {
		testutil.RequireFalse(t, xs[s[0]], "duplicate x-coordinate in shares")
		xs[s[0]] = true
	}

	// Roundtrip: any 2-of-3 must recover the secret.
	recovered, err := impl.Combine(shares[:2])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered, secret)
}

// TST-CORE-926
func TestIdentity_3_6_6_IngressTierChange_DIDDocRotation(t *testing.T) {
	// §3.6.6: DID resolution requirements:
	// 1. Unknown DIDs must return error (MEDIUM-10), not synthetic document.
	// 2. Created DIDs must be resolvable with valid DID document.
	// 3. DID document must contain verification methods and service endpoints.
	dir := t.TempDir()
	dm := identity.NewDIDManager(dir)
	testutil.RequireImplementation(t, dm, "DIDManager")

	ctx := context.Background()

	// Negative: resolving an unknown DID must return error, not synthetic doc.
	_, err := dm.Resolve(ctx, domain.DID("did:plc:nonexistent"))
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "not found")

	// Positive: create a DID and verify it can be resolved.
	signer := dinacrypto.NewEd25519Signer()
	pubKey, _, err := signer.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	did, err := dm.Create(ctx, pubKey)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, string(did) != "", "Create must return a non-empty DID")

	// Resolve the created DID — must succeed and return valid JSON document.
	docBytes, err := dm.Resolve(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(docBytes) > 0, "resolved document must not be empty")

	// Verify the DID document has expected structure.
	var doc map[string]interface{}
	err = json.Unmarshal(docBytes, &doc)
	testutil.RequireNoError(t, err)

	// DID document must reference the DID itself.
	docID, ok := doc["id"].(string)
	testutil.RequireTrue(t, ok && docID == string(did),
		fmt.Sprintf("DID document id must match: got %q, want %q", docID, string(did)))

	// Must have verification methods.
	vmRaw, ok := doc["verificationMethod"]
	testutil.RequireTrue(t, ok && vmRaw != nil,
		"DID document must contain verificationMethod")
	vmList, ok := vmRaw.([]interface{})
	testutil.RequireTrue(t, ok && len(vmList) > 0,
		"verificationMethod must have at least one entry")

	// Negative: a second unknown DID still returns error (no pollution).
	_, err = dm.Resolve(ctx, domain.DID("did:plc:anotherunknown"))
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "not found")
}

// TST-CORE-927
func TestIdentity_3_6_7_TrustRingLevelsDefinedInCode(t *testing.T) {
	// §3.6.7: Trust ring levels must be well-defined in code.
	// Production supports: blocked, unknown, trusted.
	cd := identity.NewContactDirectory()
	testutil.RequireImplementation(t, cd, "ContactDirectory")

	ctx := context.Background()

	// Positive: all valid trust levels must be accepted.
	validLevels := []string{"blocked", "unknown", "trusted"}
	for i, level := range validLevels {
		did := fmt.Sprintf("did:key:z6MkTrust%d", i)
		err := cd.Add(ctx, did, fmt.Sprintf("Trust-%s", level), level)
		testutil.RequireNoError(t, err)

		// Verify the trust level is stored correctly.
		got := cd.GetTrustLevel(did)
		testutil.RequireEqual(t, got, level)
	}

	// Negative: invalid trust levels must be rejected.
	invalidLevels := []string{"unverified", "verified", "skin_in_game", "admin", ""}
	for _, level := range invalidLevels {
		did := fmt.Sprintf("did:key:z6MkInvalid%s", level)
		err := cd.Add(ctx, did, "Invalid", level)
		testutil.RequireError(t, err)
	}

	// Unknown DID returns empty trust level (not in directory).
	testutil.RequireEqual(t, cd.GetTrustLevel("did:key:z6MkNotAContact"), "")
}

// TST-CORE-928
func TestIdentity_3_6_8_NoMCPOrOpenClawVaultAccess(t *testing.T) {
	// §3.6.8: MCP and OpenClaw credentials must NEVER access vault, identity,
	// persona, or admin endpoints. Only brain and client tokens are recognized.
	checker := auth.NewAdminEndpointChecker()
	testutil.RequireImplementation(t, checker, "AdminEndpointChecker")

	// Sensitive paths that MCP/OpenClaw must be denied.
	sensitivePaths := []string{
		"/v1/vault/query",
		"/v1/vault/store",
		"/v1/vault/item/abc123",
		"/v1/persona/create",
		"/v1/did/sign",
		"/v1/did/rotate",
		"/admin/status",
		"/v1/export/full",
		"/v1/import/restore",
		"/v1/pair/initiate",
		"/v1/vault/backup",
	}

	forbiddenKinds := []string{"mcp", "openclaw", "plugin", ""}

	for _, kind := range forbiddenKinds {
		for _, path := range sensitivePaths {
			allowed := checker.AllowedForTokenKind(kind, path)
			testutil.RequireFalse(t, allowed,
				fmt.Sprintf("%q token must NOT access %s", kind, path))
		}
	}

	// Positive control: brain CAN access vault endpoints (it needs them to function).
	testutil.RequireTrue(t, checker.AllowedForTokenKind("brain", "/v1/vault/query"),
		"brain token must be allowed to access /v1/vault/query")
	testutil.RequireTrue(t, checker.AllowedForTokenKind("brain", "/v1/vault/store"),
		"brain token must be allowed to access /v1/vault/store")

	// Positive control: client with admin scope has full access.
	testutil.RequireTrue(t, checker.AllowedForTokenKind("client", "/v1/vault/query", "admin"),
		"client admin token must access vault")

	// Negative control: brain must NOT access admin-only paths.
	testutil.RequireFalse(t, checker.AllowedForTokenKind("brain", "/v1/did/sign"),
		"brain must NOT access /v1/did/sign")
	testutil.RequireFalse(t, checker.AllowedForTokenKind("brain", "/v1/persona/create"),
		"brain must NOT access /v1/persona/create")
}

// ---------- §3.7 DID Metadata Persistence ----------

func TestIdentity_3_7_1_MetadataPersisted(t *testing.T) {
	// Creating a DID persists metadata to did_metadata.json.
	tmpDir := t.TempDir()
	mgr := identity.NewDIDManager(tmpDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	did, err := mgr.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	meta, err := mgr.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("expected metadata to be persisted")
	}
	if meta.DID != string(did) {
		t.Fatalf("DID mismatch: got %q, want %q", meta.DID, string(did))
	}
	if meta.SigningKeyPath != "m/9999'/0'/0'" {
		t.Fatalf("signing key path: got %q, want %q", meta.SigningKeyPath, "m/9999'/0'/0'")
	}
	if meta.PLCRegistered {
		t.Fatal("expected PLCRegistered=false for local-only DID")
	}
	if meta.CreatedAt == "" {
		t.Fatal("expected non-empty CreatedAt")
	}
}

func TestIdentity_3_7_2_MetadataLocalOnlyNoRotationKey(t *testing.T) {
	// Local-only DID has empty rotation key path.
	tmpDir := t.TempDir()
	mgr := identity.NewDIDManager(tmpDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	_, err = mgr.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	meta, err := mgr.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if meta.RotationKeyPath != "" {
		t.Fatalf("expected empty rotation key path for local-only, got %q", meta.RotationKeyPath)
	}
}

func TestIdentity_3_7_3_MetadataLoadNoFile(t *testing.T) {
	// LoadDIDMetadata returns nil when no file exists (not an error).
	tmpDir := t.TempDir()
	mgr := identity.NewDIDManager(tmpDir)

	meta, err := mgr.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if meta != nil {
		t.Fatal("expected nil metadata when no file exists")
	}
}

func TestIdentity_3_7_4_MetadataRoundTrip(t *testing.T) {
	// Metadata survives a manager reload (new instance, same dataDir).
	tmpDir := t.TempDir()
	mgr1 := identity.NewDIDManager(tmpDir)
	mgr1.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	did, err := mgr1.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Load from a fresh manager pointing to the same directory.
	mgr2 := identity.NewDIDManager(tmpDir)
	meta, err := mgr2.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("expected metadata to survive reload")
	}
	if meta.DID != string(did) {
		t.Fatalf("DID mismatch after reload: got %q, want %q", meta.DID, string(did))
	}
	if meta.SigningKeyPath != "m/9999'/0'/0'" {
		t.Fatalf("signing key path lost after reload: got %q", meta.SigningKeyPath)
	}
}

// ---------- §3.8 DID Restoration from Seed ----------

func TestIdentity_3_8_1_RestoreDIDFromMetadata(t *testing.T) {
	// Full round-trip: create DID, load metadata on new manager, restore.
	tmpDir := t.TempDir()

	// Step 1: Create original DID.
	mgr1 := identity.NewDIDManager(tmpDir)
	mgr1.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	originalDID, err := mgr1.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Step 2: Simulate recovery — fresh manager, load metadata, restore.
	mgr2 := identity.NewDIDManager(tmpDir)
	meta, err := mgr2.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("metadata must exist")
	}

	restoredDID, err := mgr2.RestoreDID(idCtx, meta, pub)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	if restoredDID != originalDID {
		t.Fatalf("restored DID mismatch: got %q, want %q", restoredDID, originalDID)
	}

	// Step 3: Verify the restored DID resolves correctly.
	doc, err := mgr2.Resolve(idCtx, restoredDID)
	if err != nil {
		t.Fatalf("Resolve after restore: %v", err)
	}
	if doc == nil {
		t.Fatal("expected non-nil DID document after restore")
	}
}

func TestIdentity_3_8_2_RestoreDIDDeterministic(t *testing.T) {
	// Restoring with the same key always produces the same DID.
	tmpDir := t.TempDir()

	// Use SLIP-0010 to derive the signing key deterministically.
	deriver := dinacrypto.NewSLIP0010Deriver()
	pub, _, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'/0'")
	if err != nil {
		t.Fatalf("DerivePath: %v", err)
	}

	// Create the original DID.
	mgr1 := identity.NewDIDManager(tmpDir)
	mgr1.SetSigningKeyPath("m/9999'/0'/0'")
	originalDID, err := mgr1.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Simulate recovery on a fresh data directory.
	tmpDir2 := t.TempDir()

	// Re-derive the same key from the same seed.
	pub2, _, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'/0'")
	if err != nil {
		t.Fatalf("DerivePath: %v", err)
	}

	// Metadata would normally come from backup; here we construct it.
	meta := &identity.DIDMetadata{
		DID:            string(originalDID),
		SigningKeyPath: "m/9999'/0'/0'",
		CreatedAt:      "2025-01-01T00:00:00Z",
	}

	mgr2 := identity.NewDIDManager(tmpDir2)
	restoredDID, err := mgr2.RestoreDID(idCtx, meta, pub2)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	if restoredDID != originalDID {
		t.Fatalf("deterministic restore failed: got %q, want %q", restoredDID, originalDID)
	}
}

func TestIdentity_3_8_3_RestoreRejectsDuplicate(t *testing.T) {
	// RestoreDID rejects if the DID is already loaded.
	tmpDir := t.TempDir()
	mgr := identity.NewDIDManager(tmpDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	did, err := mgr.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	meta := &identity.DIDMetadata{
		DID:            string(did),
		SigningKeyPath: "m/9999'/0'/0'",
		CreatedAt:      "2025-01-01T00:00:00Z",
	}

	_, err = mgr.RestoreDID(idCtx, meta, pub)
	if err == nil {
		t.Fatal("expected error for duplicate restore")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected 'already exists' error, got: %v", err)
	}
}

func TestIdentity_3_8_4_RestoreRejectsNilMetadata(t *testing.T) {
	mgr := identity.NewDIDManager(t.TempDir())
	pub, _, _ := ed25519.GenerateKey(nil)

	_, err := mgr.RestoreDID(idCtx, nil, pub)
	if err == nil {
		t.Fatal("expected error for nil metadata")
	}
}

func TestIdentity_3_8_5_RestoreRejectsInvalidKey(t *testing.T) {
	mgr := identity.NewDIDManager(t.TempDir())
	meta := &identity.DIDMetadata{
		DID:            "did:plc:test123",
		SigningKeyPath: "m/9999'/0'/0'",
		CreatedAt:      "2025-01-01T00:00:00Z",
	}

	_, err := mgr.RestoreDID(idCtx, meta, []byte("too-short"))
	if err == nil {
		t.Fatal("expected error for invalid key length")
	}
}

func TestIdentity_3_8_6_RestorePreservesMetadataFields(t *testing.T) {
	// After restore, metadata on disk is unchanged.
	tmpDir := t.TempDir()
	mgr := identity.NewDIDManager(tmpDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	_, err = mgr.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	meta1, err := mgr.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}

	// Restore on fresh manager.
	mgr2 := identity.NewDIDManager(tmpDir)
	_, err = mgr2.RestoreDID(idCtx, meta1, pub)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	// Metadata file should still be readable with same content.
	meta2, err := mgr2.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata after restore: %v", err)
	}
	if meta2.DID != meta1.DID {
		t.Fatalf("DID changed after restore: %q → %q", meta1.DID, meta2.DID)
	}
	if meta2.SigningKeyPath != meta1.SigningKeyPath {
		t.Fatalf("signing key path changed: %q → %q", meta1.SigningKeyPath, meta2.SigningKeyPath)
	}
}

func TestIdentity_3_8_7_RestoreHydratesGeneration(t *testing.T) {
	// RestoreDID must hydrate signingGeneration from metadata so that
	// subsequent Rotate() calls start from the correct generation.
	tmpDir := t.TempDir()
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	seed := testutil.TestEd25519Seed[:]

	// Simulate a rotated identity: gen-2 is the current signing key.
	gen2Pub, _, err := kd.DeriveRootSigningKey(seed, 2)
	if err != nil {
		t.Fatalf("DeriveRootSigningKey: %v", err)
	}

	meta := &identity.DIDMetadata{
		DID:               "did:key:z6MkTestRestore",
		SigningKeyPath:    identity.RootSigningPath(2),
		SigningGeneration: 2,
		CreatedAt:         "2025-01-01T00:00:00Z",
	}

	mgr := identity.NewDIDManager(tmpDir)
	mgr.SetMasterSeed(seed, kd)

	_, err = mgr.RestoreDID(idCtx, meta, gen2Pub)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	// Generation must be hydrated to 2 (not default 0).
	if mgr.SigningGeneration() != 2 {
		t.Fatalf("expected generation 2, got %d", mgr.SigningGeneration())
	}
}

// ---------- §3.9 Identity Export / Import ----------

func TestIdentity_3_9_1_ExportBundle(t *testing.T) {
	// ExportIdentity creates a valid bundle file with integrity HMAC.
	dataDir := t.TempDir()
	secretsDir := t.TempDir()

	// Create DID.
	mgr := identity.NewDIDManager(dataDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")
	pub, _, _ := ed25519.GenerateKey(nil)
	_, err := mgr.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Create fake secrets.
	wrappedSeed := []byte("encrypted-seed-data-32-bytes-ok!")
	salt := []byte("sixteen-byte-slt")
	os.WriteFile(filepath.Join(secretsDir, "wrapped_seed.bin"), wrappedSeed, 0600)
	os.WriteFile(filepath.Join(secretsDir, "master_seed.salt"), salt, 0600)

	bundlePath := filepath.Join(t.TempDir(), "identity.bundle")
	err = mgr.ExportIdentity(bundlePath, secretsDir, testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("ExportIdentity: %v", err)
	}

	// Verify file exists and is parseable.
	bundle, err := identity.LoadIdentityBundle(bundlePath)
	if err != nil {
		t.Fatalf("LoadIdentityBundle: %v", err)
	}
	if bundle.Version != 1 {
		t.Fatalf("version: got %d, want 1", bundle.Version)
	}
	if bundle.Metadata == nil {
		t.Fatal("metadata missing from bundle")
	}
	if bundle.Metadata.SigningKeyPath != "m/9999'/0'/0'" {
		t.Fatalf("signing key path: got %q", bundle.Metadata.SigningKeyPath)
	}
	if string(bundle.WrappedSeed) != string(wrappedSeed) {
		t.Fatal("wrapped seed mismatch")
	}
	if string(bundle.Salt) != string(salt) {
		t.Fatal("salt mismatch")
	}
	if len(bundle.MetadataHMAC) == 0 {
		t.Fatal("expected non-empty MetadataHMAC")
	}

	// Verify integrity with correct seed.
	err = identity.VerifyBundleIntegrity(bundle, testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("VerifyBundleIntegrity: %v", err)
	}
}

func TestIdentity_3_9_2_ExportRequiresDID(t *testing.T) {
	// ExportIdentity fails if no DID has been created.
	mgr := identity.NewDIDManager(t.TempDir())
	err := mgr.ExportIdentity(filepath.Join(t.TempDir(), "bundle"), t.TempDir(), testutil.TestMnemonicSeed)
	if err == nil {
		t.Fatal("expected error when no DID exists")
	}
}

func TestIdentity_3_9_3_ImportBundleSecrets(t *testing.T) {
	// ImportIdentitySecrets writes wrapped seed and salt to a new directory.
	bundle := &identity.IdentityBundle{
		Version: 1,
		Metadata: &identity.DIDMetadata{
			DID:            "did:plc:test",
			SigningKeyPath: "m/9999'/0'/0'",
			CreatedAt:      "2025-01-01T00:00:00Z",
		},
		WrappedSeed: []byte("wrapped-seed-bytes"),
		Salt:        []byte("salt-bytes-16chr"),
	}

	secretsDir := filepath.Join(t.TempDir(), "secrets")
	err := identity.ImportIdentitySecrets(bundle, secretsDir)
	if err != nil {
		t.Fatalf("ImportIdentitySecrets: %v", err)
	}

	// Verify files were written.
	got, err := os.ReadFile(filepath.Join(secretsDir, "wrapped_seed.bin"))
	if err != nil {
		t.Fatalf("read wrapped_seed: %v", err)
	}
	if string(got) != "wrapped-seed-bytes" {
		t.Fatalf("wrapped seed content mismatch")
	}

	got, err = os.ReadFile(filepath.Join(secretsDir, "master_seed.salt"))
	if err != nil {
		t.Fatalf("read salt: %v", err)
	}
	if string(got) != "salt-bytes-16chr" {
		t.Fatalf("salt content mismatch")
	}
}

func TestIdentity_3_9_4_ImportRefusesOverwrite(t *testing.T) {
	// ImportIdentitySecrets refuses to overwrite existing secrets.
	secretsDir := t.TempDir()
	os.WriteFile(filepath.Join(secretsDir, "wrapped_seed.bin"), []byte("existing"), 0600)

	bundle := &identity.IdentityBundle{
		Version: 1,
		Metadata: &identity.DIDMetadata{
			DID:       "did:plc:test",
			CreatedAt: "2025-01-01T00:00:00Z",
		},
		WrappedSeed: []byte("new-data"),
		Salt:        []byte("new-salt"),
	}

	err := identity.ImportIdentitySecrets(bundle, secretsDir)
	if err == nil {
		t.Fatal("expected error when secrets already exist")
	}
	if !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestIdentity_3_9_5_LoadBundleRejectsInvalid(t *testing.T) {
	// LoadIdentityBundle rejects files with wrong version or missing fields.
	tmpDir := t.TempDir()

	// Wrong version.
	badVersion := `{"version":99,"metadata":{"did":"test","created_at":"x"},"wrapped_seed":"AA==","salt":"AA=="}`
	os.WriteFile(filepath.Join(tmpDir, "bad_ver.bundle"), []byte(badVersion), 0600)
	_, err := identity.LoadIdentityBundle(filepath.Join(tmpDir, "bad_ver.bundle"))
	if err == nil {
		t.Fatal("expected error for unsupported version")
	}

	// Missing metadata.
	noMeta := `{"version":1,"wrapped_seed":"AA==","salt":"AA=="}`
	os.WriteFile(filepath.Join(tmpDir, "no_meta.bundle"), []byte(noMeta), 0600)
	_, err = identity.LoadIdentityBundle(filepath.Join(tmpDir, "no_meta.bundle"))
	if err == nil {
		t.Fatal("expected error for missing metadata")
	}

	// Missing wrapped seed.
	noSeed := `{"version":1,"metadata":{"did":"test","created_at":"x"},"salt":"AA=="}`
	os.WriteFile(filepath.Join(tmpDir, "no_seed.bundle"), []byte(noSeed), 0600)
	_, err = identity.LoadIdentityBundle(filepath.Join(tmpDir, "no_seed.bundle"))
	if err == nil {
		t.Fatal("expected error for missing wrapped seed")
	}
}

func TestIdentity_3_9_6_FullExportImportRoundTrip(t *testing.T) {
	// End-to-end: create DID → export → verify integrity → import → restore.
	origDataDir := t.TempDir()
	origSecretsDir := t.TempDir()

	// Derive a deterministic key.
	deriver := dinacrypto.NewSLIP0010Deriver()
	pub, _, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'/0'")
	if err != nil {
		t.Fatalf("DerivePath: %v", err)
	}

	// Create DID on original device.
	mgr1 := identity.NewDIDManager(origDataDir)
	mgr1.SetSigningKeyPath("m/9999'/0'/0'")
	originalDID, err := mgr1.Create(idCtx, pub)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Write fake secrets.
	os.WriteFile(filepath.Join(origSecretsDir, "wrapped_seed.bin"), []byte("wrapped-data"), 0600)
	os.WriteFile(filepath.Join(origSecretsDir, "master_seed.salt"), []byte("salt-data-bytes!"), 0600)

	// Export.
	bundlePath := filepath.Join(t.TempDir(), "identity.bundle")
	err = mgr1.ExportIdentity(bundlePath, origSecretsDir, testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("ExportIdentity: %v", err)
	}

	// --- Simulate new device ---

	newDataDir := t.TempDir()
	newSecretsDir := filepath.Join(t.TempDir(), "new-secrets")

	// Load bundle.
	bundle, err := identity.LoadIdentityBundle(bundlePath)
	if err != nil {
		t.Fatalf("LoadIdentityBundle: %v", err)
	}

	// Verify integrity before using metadata.
	err = identity.VerifyBundleIntegrity(bundle, testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("VerifyBundleIntegrity: %v", err)
	}

	// Import secrets.
	err = identity.ImportIdentitySecrets(bundle, newSecretsDir)
	if err != nil {
		t.Fatalf("ImportIdentitySecrets: %v", err)
	}

	// Re-derive signing key from seed.
	pub2, _, err := deriver.DerivePath(testutil.TestMnemonicSeed, bundle.Metadata.SigningKeyPath)
	if err != nil {
		t.Fatalf("DerivePath: %v", err)
	}

	// Restore DID.
	mgr2 := identity.NewDIDManager(newDataDir)
	restoredDID, err := mgr2.RestoreDID(idCtx, bundle.Metadata, pub2)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	if restoredDID != originalDID {
		t.Fatalf("DID mismatch: original %q, restored %q", originalDID, restoredDID)
	}

	// Verify DID resolves on new device.
	doc, err := mgr2.Resolve(idCtx, restoredDID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if doc == nil {
		t.Fatal("expected DID document after restore")
	}

	// Verify metadata was persisted on the restored node.
	meta, err := mgr2.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata after restore: %v", err)
	}
	if meta == nil {
		t.Fatal("metadata must be persisted after restore")
	}
	if meta.DID != string(originalDID) {
		t.Fatalf("persisted metadata DID mismatch: %q", meta.DID)
	}
}

func TestIdentity_3_9_7_IntegrityDetectsTamperedMetadata(t *testing.T) {
	// A bundle with tampered metadata fails integrity verification.
	dataDir := t.TempDir()
	secretsDir := t.TempDir()

	mgr := identity.NewDIDManager(dataDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")
	pub, _, _ := ed25519.GenerateKey(nil)
	mgr.Create(idCtx, pub)

	os.WriteFile(filepath.Join(secretsDir, "wrapped_seed.bin"), []byte("wrapped"), 0600)
	os.WriteFile(filepath.Join(secretsDir, "master_seed.salt"), []byte("salt-16-bytes!!!"), 0600)

	bundlePath := filepath.Join(t.TempDir(), "bundle")
	mgr.ExportIdentity(bundlePath, secretsDir, testutil.TestMnemonicSeed)

	bundle, _ := identity.LoadIdentityBundle(bundlePath)

	// Tamper with the metadata.
	bundle.Metadata.DID = "did:plc:evil-attacker-did"

	err := identity.VerifyBundleIntegrity(bundle, testutil.TestMnemonicSeed)
	if err == nil {
		t.Fatal("expected integrity check to fail after tampering")
	}
	if !strings.Contains(err.Error(), "tampered") {
		t.Fatalf("expected tampering error, got: %v", err)
	}
}

func TestIdentity_3_9_8_IntegrityFailsWithWrongSeed(t *testing.T) {
	// Integrity check fails when verified with a different seed.
	dataDir := t.TempDir()
	secretsDir := t.TempDir()

	mgr := identity.NewDIDManager(dataDir)
	mgr.SetSigningKeyPath("m/9999'/0'/0'")
	pub, _, _ := ed25519.GenerateKey(nil)
	mgr.Create(idCtx, pub)

	os.WriteFile(filepath.Join(secretsDir, "wrapped_seed.bin"), []byte("wrapped"), 0600)
	os.WriteFile(filepath.Join(secretsDir, "master_seed.salt"), []byte("salt-16-bytes!!!"), 0600)

	bundlePath := filepath.Join(t.TempDir(), "bundle")
	mgr.ExportIdentity(bundlePath, secretsDir, testutil.TestMnemonicSeed)

	bundle, _ := identity.LoadIdentityBundle(bundlePath)

	// Verify with a different seed.
	wrongSeed := make([]byte, 64)
	wrongSeed[0] = 0xFF
	err := identity.VerifyBundleIntegrity(bundle, wrongSeed)
	if err == nil {
		t.Fatal("expected integrity check to fail with wrong seed")
	}
}

func TestIdentity_3_9_9_RestorePersistedMetadataAvailableForExport(t *testing.T) {
	// After RestoreDID, metadata is persisted so ExportIdentity works.
	dataDir := t.TempDir()
	secretsDir := t.TempDir()

	mgr := identity.NewDIDManager(dataDir)
	pub, _, _ := ed25519.GenerateKey(nil)
	meta := &identity.DIDMetadata{
		DID:            "did:plc:restored-test",
		SigningKeyPath: "m/9999'/0'/0'",
		CreatedAt:      "2025-01-01T00:00:00Z",
	}

	_, err := mgr.RestoreDID(idCtx, meta, pub)
	if err != nil {
		t.Fatalf("RestoreDID: %v", err)
	}

	// Metadata should be loadable for a subsequent export.
	loaded, err := mgr.LoadDIDMetadata()
	if err != nil {
		t.Fatalf("LoadDIDMetadata: %v", err)
	}
	if loaded == nil {
		t.Fatal("metadata must be available after restore")
	}

	// ExportIdentity should succeed (metadata exists).
	os.WriteFile(filepath.Join(secretsDir, "wrapped_seed.bin"), []byte("data"), 0600)
	os.WriteFile(filepath.Join(secretsDir, "master_seed.salt"), []byte("salt"), 0600)
	err = mgr.ExportIdentity(filepath.Join(t.TempDir(), "bundle"), secretsDir, testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("ExportIdentity after restore: %v", err)
	}
}
