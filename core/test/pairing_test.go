package test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"

	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §10 — Device Pairing
// ==========================================================================
// Covers §10.1 (QR Pairing Flow), §10.2 (Device Registration),
// §10.3 (Token Issuance), §10.4 (Numeric Code), §10.5 (Expiry).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §10.1 QR Pairing Flow (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-520
// TRACE: {"suite": "CORE", "case": "1055", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "01", "title": "GenerateCode"}
func TestPairing_10_1_1_GenerateCode(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// GenerateCode should produce a non-empty code and a 32-byte secret.
	code, secret, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, code != "", "pairing code must not be empty")
	testutil.RequireTrue(t, len(secret) == 32, "pairing secret must be exactly 32 bytes (256-bit entropy)")

	// Code must be a 6-digit numeric string (Architecture §10: "6-digit pairing code").
	digitPattern := regexp.MustCompile(`^[0-9]{6}$`)
	testutil.RequireTrue(t, digitPattern.MatchString(code), "pairing code must be a 6-digit numeric string")

	// Round-trip: generated code must be usable for CompletePairing.
	clientToken, tokenID, err := impl.CompletePairing(context.Background(), code, "test-device")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, clientToken != "", "CompletePairing must return a non-empty client token")
	testutil.RequireTrue(t, tokenID != "", "CompletePairing must return a non-empty token ID")

	// Negative control: same code cannot be reused (single-use).
	_, _, err = impl.CompletePairing(context.Background(), code, "test-device-2")
	if err == nil {
		t.Fatal("pairing code must be single-use — second CompletePairing must fail")
	}
}

// TST-CORE-520
// TRACE: {"suite": "CORE", "case": "1056", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "02", "title": "GenerateCodeUniqueness"}
func TestPairing_10_1_2_GenerateCodeUniqueness(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Two consecutive code generations must produce different codes AND secrets.
	code1, secret1, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)
	code2, secret2, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	if code1 == code2 {
		t.Fatal("pairing codes must be unique across generations")
	}

	// Secrets must also differ (independent CSPRNG draws).
	if bytes.Equal(secret1, secret2) {
		t.Fatal("pairing secrets must be unique — independent random draws")
	}

	// Both codes must be independently usable (proves separate internal state).
	token1, _, err := impl.CompletePairing(context.Background(), code1, "device-A")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, token1 != "", "first code must be independently completable")

	token2, _, err := impl.CompletePairing(context.Background(), code2, "device-B")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, token2 != "", "second code must be independently completable")

	// Tokens must also be unique.
	if token1 == token2 {
		t.Fatal("CLIENT_TOKENs from different pairings must be unique")
	}
}

// TST-CORE-520
// TRACE: {"suite": "CORE", "case": "1057", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "03", "title": "GenerateCodeEntropy"}
func TestPairing_10_1_3_GenerateCodeEntropy(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Positive: the pairing secret must have sufficient entropy (at least 16 bytes).
	code1, secret1, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(secret1) >= 16, "pairing secret must be at least 16 bytes for sufficient entropy")
	testutil.RequireTrue(t, len(code1) > 0, "pairing code must be non-empty")

	// Negative: a second GenerateCode must produce a DIFFERENT secret (randomness).
	code2, secret2, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	if bytes.Equal(secret1, secret2) {
		t.Fatal("two pairing secrets must differ (crypto/rand uniqueness)")
	}
	if code1 == code2 {
		t.Fatal("two pairing codes must differ")
	}

	// Positive: secret length must be exactly 32 bytes (256-bit entropy per production code).
	testutil.RequireEqual(t, len(secret1), 32)
	testutil.RequireEqual(t, len(secret2), 32)
}

// --------------------------------------------------------------------------
// §10.2 Device Registration (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-521
// TRACE: {"suite": "CORE", "case": "1058", "section": "10", "sectionName": "Device Pairing", "subsection": "02", "scenario": "01", "title": "CompletePairingSuccess"}
func TestPairing_10_2_1_CompletePairingSuccess(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Generate a code, then complete pairing with that code.
	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	clientToken, tokenID, err := impl.CompletePairing(context.Background(), code, "My Phone")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, clientToken != "", "CLIENT_TOKEN must be returned on successful pairing")
	testutil.RequireTrue(t, tokenID != "", "tokenID must be returned on successful pairing")

	// CLIENT_TOKEN must be hex-encoded 32 bytes = 64 hex chars.
	hexPattern := regexp.MustCompile(`^[0-9a-f]{64}$`)
	testutil.RequireTrue(t, hexPattern.MatchString(clientToken),
		"CLIENT_TOKEN must be 64-char lowercase hex (32 bytes)")

	// Device must appear in the device registry.
	devices, err := impl.ListDevices(context.Background())
	testutil.RequireNoError(t, err)
	found := false
	for _, d := range devices {
		if d.TokenID == tokenID && d.Name == "My Phone" {
			found = true
			testutil.RequireFalse(t, d.Revoked, "newly paired device must not be revoked")
			testutil.RequireTrue(t, d.CreatedAt > 0, "CreatedAt must be set")
		}
	}
	testutil.RequireTrue(t, found, "paired device must appear in ListDevices with correct name and tokenID")
}

// TST-CORE-523
// TRACE: {"suite": "CORE", "case": "1059", "section": "10", "sectionName": "Device Pairing", "subsection": "02", "scenario": "02", "title": "CompletePairingInvalidCode"}
func TestPairing_10_2_2_CompletePairingInvalidCode(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Completing pairing with an invalid/unused code should fail.
	_, _, err := impl.CompletePairing(context.Background(), "invalid-code-999", "My Phone")
	testutil.RequireError(t, err)
}

// TST-CORE-521
// TRACE: {"suite": "CORE", "case": "1060", "section": "10", "sectionName": "Device Pairing", "subsection": "02", "scenario": "03", "title": "DeviceNameRecorded"}
func TestPairing_10_2_3_DeviceNameRecorded(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Negative: before pairing, device list must be empty.
	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices), 0)

	// Pair a device with a specific name.
	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	clientToken, _, err := impl.CompletePairing(ctx, code, "Living Room Tablet")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, clientToken != "", "CLIENT_TOKEN must be returned")

	// Positive: the device name must appear in the device registry.
	devices, err = impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices), 1)
	testutil.RequireEqual(t, devices[0].Name, "Living Room Tablet")
}

// --------------------------------------------------------------------------
// §10.3 Token Issuance (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-530
// TRACE: {"suite": "CORE", "case": "1061", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "04", "title": "TokenLengthAndEntropy"}
func TestPairing_10_1_4_TokenLengthAndEntropy(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// The CLIENT_TOKEN issued during pairing must be at least 32 bytes
	// (64 hex chars) from crypto/rand.
	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	clientToken, _, err := impl.CompletePairing(context.Background(), code, "Test Device")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(clientToken) >= 64, "CLIENT_TOKEN must be at least 64 hex chars (32 bytes)")
}

// TST-CORE-530
// TRACE: {"suite": "CORE", "case": "1062", "section": "10", "sectionName": "Device Pairing", "subsection": "03", "scenario": "02", "title": "TokenUniquePerDevice"}
func TestPairing_10_3_2_TokenUniquePerDevice(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Pair two devices.
	code1, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	token1, id1, err := impl.CompletePairing(ctx, code1, "Device A")
	testutil.RequireNoError(t, err)

	code2, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	token2, id2, err := impl.CompletePairing(ctx, code2, "Device B")
	testutil.RequireNoError(t, err)

	// Positive: tokens must be unique.
	if token1 == token2 {
		t.Fatal("CLIENT_TOKENs must be unique per device pairing")
	}

	// Positive: token IDs must also be unique.
	if id1 == id2 {
		t.Fatal("token IDs must be unique per device")
	}

	// Positive: both tokens must be 64-char lowercase hex (32 bytes).
	hexPattern := regexp.MustCompile(`^[0-9a-f]{64}$`)
	testutil.RequireTrue(t, hexPattern.MatchString(token1), "token1 must be 64-char hex")
	testutil.RequireTrue(t, hexPattern.MatchString(token2), "token2 must be 64-char hex")

	// Verify both devices are registered.
	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices), 2)
}

// --------------------------------------------------------------------------
// §10.4 Numeric Code (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-523
// TRACE: {"suite": "CORE", "case": "1063", "section": "10", "sectionName": "Device Pairing", "subsection": "04", "scenario": "01", "title": "NumericCodeFormat"}
func TestPairing_10_4_1_NumericCodeFormat(t *testing.T) {
	// Generate a pairing code and verify it matches the expected format.
	// Architecture §10: "Core generates 6-digit pairing code (expires in 5 minutes)".
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(code) == 6, "pairing code must be exactly 6 digits")

	// Verify the code is all digits (0-9).
	digitPattern := regexp.MustCompile(`^[0-9]{6}$`)
	testutil.RequireTrue(t, digitPattern.MatchString(code),
		"pairing code must be a 6-digit numeric string")

	// Verify the code is in the valid range (100000-999999, no leading zeros).
	testutil.RequireTrue(t, code[0] != '0',
		"pairing code must not have a leading zero (range 100000-999999)")
}

// TST-CORE-524
// TRACE: {"suite": "CORE", "case": "1064", "section": "10", "sectionName": "Device Pairing", "subsection": "04", "scenario": "02", "title": "NumericCodeBruteForceResistance"}
func TestPairing_10_4_2_NumericCodeBruteForceResistance(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Generate two codes to verify entropy and uniqueness.
	code1, secret1, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	code2, secret2, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	// The 6-digit code itself has ~20 bits of entropy (900,000 combinations).
	// Brute-force resistance comes from rate limiting + 5-minute TTL, not
	// code entropy alone. The underlying 32-byte secret has 256 bits.
	testutil.RequireTrue(t, len(code1) == 6, "pairing code must be exactly 6 digits")
	testutil.RequireTrue(t, len(code2) == 6, "pairing code must be exactly 6 digits")

	// The cryptographic secret (used for key derivation) must have full entropy.
	testutil.RequireTrue(t, len(secret1) == 32, "secret must be 32 bytes (256-bit entropy)")
	testutil.RequireTrue(t, len(secret2) == 32, "secret must be 32 bytes (256-bit entropy)")

	// Negative: two independent codes must differ (random generation).
	// Note: with 900,000 combinations there is a small collision probability,
	// but two consecutive CSPRNG draws should differ in practice.
	testutil.RequireTrue(t, code1 != code2, "two generated codes must be distinct")

	combinations := 900000.0
	t.Logf("pairing code length=6 digits, combinations=%.0f, secret entropy=256 bits",
		combinations)
}

// --------------------------------------------------------------------------
// §10.4.3 Code Collision Handling
// --------------------------------------------------------------------------

// TST-CORE-524b
// TRACE: {"suite": "CORE", "case": "1065", "section": "10", "sectionName": "Device Pairing", "subsection": "04", "scenario": "03", "title": "CodeCollisionRetry"}
func TestPairing_10_4_3_CodeCollisionRetry(t *testing.T) {
	// Verify that GenerateCode retries on collision and returns
	// ErrCodeCollision only after exhausting retries.
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Positive: generate many codes — all must be unique (collision handling works).
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		code, _, err := impl.GenerateCode(ctx)
		testutil.RequireNoError(t, err)
		if seen[code] {
			t.Fatalf("duplicate pairing code %q at iteration %d — collision handling failed", code, i)
		}
		seen[code] = true
	}

	// Positive: ErrCodeCollision sentinel exists and is a distinct error.
	testutil.RequireTrue(t, pairing.ErrCodeCollision != nil, "ErrCodeCollision must be defined")
	testutil.RequireTrue(t, pairing.ErrCodeCollision != pairing.ErrTooManyPendingCodes,
		"ErrCodeCollision must be distinct from ErrTooManyPendingCodes")
}

// --------------------------------------------------------------------------
// §10.5 Expiry (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-522
// TRACE: {"suite": "CORE", "case": "1066", "section": "10", "sectionName": "Device Pairing", "subsection": "05", "scenario": "01", "title": "CodeExpiresAfterTTL"}
func TestPairing_10_5_1_CodeExpiresAfterTTL(t *testing.T) {
	// Use a very short TTL so we can test expiry in a unit test.
	cfg := pairing.DefaultConfig()
	cfg.CodeTTL = 1 * time.Millisecond
	impl := pairing.NewManager(cfg)
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Positive: a fresh code with normal TTL works immediately.
	normalCfg := pairing.DefaultConfig()
	normalCfg.CodeTTL = 5 * time.Minute
	normalImpl := pairing.NewManager(normalCfg)
	freshCode, _, err := normalImpl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	clientToken, _, err := normalImpl.CompletePairing(ctx, freshCode, "Fresh Device")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, clientToken != "", "code should be valid before expiry")

	// Negative: generate a code with 1ms TTL, wait for expiry, pairing must fail.
	expiredCode, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	time.Sleep(5 * time.Millisecond)
	_, _, err = impl.CompletePairing(ctx, expiredCode, "Late Device")
	testutil.RequireTrue(t, err != nil, "pairing with expired code must fail")
}

// TST-CORE-525
// TRACE: {"suite": "CORE", "case": "1067", "section": "10", "sectionName": "Device Pairing", "subsection": "06", "scenario": "01", "title": "CodeSingleUse"}
func TestPairing_10_6_CodeSingleUse(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Generate a code and complete pairing once.
	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	token, tokenID, err := impl.CompletePairing(ctx, code, "First Device")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, token != "", "first pairing must return a CLIENT_TOKEN")
	testutil.RequireTrue(t, tokenID != "", "first pairing must return a token ID")

	// Positive: the device must appear in the device list.
	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices), 1)

	// Negative: second attempt with the SAME code must fail (single-use).
	_, _, err = impl.CompletePairing(ctx, code, "Second Device")
	testutil.RequireError(t, err)

	// Verify that the second failed attempt did NOT register another device.
	devices2, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices2), 1)
}

// --------------------------------------------------------------------------
// §10 row 7 — Concurrent Pairing Codes
// --------------------------------------------------------------------------

// TST-CORE-526
// TRACE: {"suite": "CORE", "case": "1068", "section": "10", "sectionName": "Device Pairing", "subsection": "07", "scenario": "01", "title": "ConcurrentPairingCodes"}
func TestPairing_10_7_ConcurrentPairingCodes(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Generate two codes before completing either — both must be valid simultaneously.
	code1, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	code2, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	testutil.RequireTrue(t, code1 != code2, "concurrent codes must be distinct")

	// Both codes should complete pairing independently.
	token1, _, err := impl.CompletePairing(ctx, code1, "Phone")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, token1 != "", "first concurrent code must yield a token")

	token2, _, err := impl.CompletePairing(ctx, code2, "Tablet")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, token2 != "", "second concurrent code must yield a token")

	testutil.RequireTrue(t, token1 != token2, "tokens from concurrent codes must differ")

	// Positive: both devices must appear in the device list with correct names.
	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(devices), 2)
	names := map[string]bool{devices[0].Name: true, devices[1].Name: true}
	testutil.RequireTrue(t, names["Phone"], "Phone device must be in list")
	testutil.RequireTrue(t, names["Tablet"], "Tablet device must be in list")
}

// --------------------------------------------------------------------------
// §10.1 Device Management (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-527
// TRACE: {"suite": "CORE", "case": "1069", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "01", "title": "ListPairedDevices"}
func TestPairing_10_1_ListPairedDevices(t *testing.T) {
	// var impl testutil.PairingManager = realpairing.NewManager(...)
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Pair three devices, then list — should return all three with
	// token_id, device_name, last_seen, created_at, revoked fields.
	for _, name := range []string{"Phone", "Tablet", "Laptop"} {
		code, _, err := impl.GenerateCode(context.Background())
		testutil.RequireNoError(t, err)
		_, _, err = impl.CompletePairing(context.Background(), code, name)
		testutil.RequireNoError(t, err)
	}

	devices, err := impl.ListDevices(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(devices) >= 3, "must list at least 3 paired devices")

	for _, d := range devices {
		testutil.RequireTrue(t, d.TokenID != "", "device must have a token_id")
		testutil.RequireTrue(t, d.Name != "", "device must have a name")
		testutil.RequireTrue(t, d.CreatedAt > 0, "device must have created_at")
	}
}

// TST-CORE-528
// TRACE: {"suite": "CORE", "case": "1070", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "01", "title": "RevokeDevice"}
func TestPairing_10_1_RevokeDevice(t *testing.T) {
	// Use a fresh PairingManager to avoid shared-state pollution from other tests.
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Pair a device and capture its tokenID directly from CompletePairing.
	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)
	_, tokenID, err := impl.CompletePairing(context.Background(), code, "iPad")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, tokenID != "", "tokenID must be returned from CompletePairing")

	// Verify the device is listed and not yet revoked.
	devices, err := impl.ListDevices(context.Background())
	testutil.RequireNoError(t, err)
	found := false
	for _, d := range devices {
		if d.TokenID == tokenID {
			found = true
			testutil.RequireTrue(t, !d.Revoked, "device must not be revoked before RevokeDevice")
			testutil.RequireTrue(t, d.Name == "iPad", "device name must match")
		}
	}
	testutil.RequireTrue(t, found, "paired device must appear in ListDevices before revocation")

	// Revoke the device by its known tokenID.
	err = impl.RevokeDevice(context.Background(), tokenID)
	testutil.RequireNoError(t, err)

	// Verify revocation: the device must be found and marked revoked.
	devices, err = impl.ListDevices(context.Background())
	testutil.RequireNoError(t, err)
	foundRevoked := false
	for _, d := range devices {
		if d.TokenID == tokenID {
			foundRevoked = true
			testutil.RequireTrue(t, d.Revoked, "revoked device must have revoked=true")
		}
	}
	testutil.RequireTrue(t, foundRevoked, "revoked device must still appear in ListDevices")

	// Negative case: revoking the same device again must return an error.
	err = impl.RevokeDevice(context.Background(), tokenID)
	testutil.RequireError(t, err)

	// Negative case: revoking a non-existent device must return an error.
	err = impl.RevokeDevice(context.Background(), "tok-nonexistent-999")
	testutil.RequireError(t, err)
}

// TST-CORE-529
// TRACE: {"suite": "CORE", "case": "1071", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "01", "title": "PairCompletionResponseFields"}
func TestPairing_10_1_PairCompletionResponseFields(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")

	ctx := context.Background()

	// Positive: pair completion response must include all required fields.
	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	resp, err := impl.CompletePairingFull(ctx, code, "Phone")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(resp.ClientToken) >= 64, "client_token must be at least 64 hex chars")
	testutil.RequireTrue(t, resp.TokenID != "", "response must include token_id")
	testutil.RequireTrue(t, strings.HasPrefix(resp.NodeDID, "did:"), "node_did must be a DID")
	testutil.RequireTrue(t, strings.HasPrefix(resp.WsURL, "wss://"), "ws_url must start with wss://")

	// Verify hex format of client_token.
	matched, _ := regexp.MatchString(`^[0-9a-f]+$`, resp.ClientToken)
	testutil.RequireTrue(t, matched, "client_token must be lowercase hex")

	// Negative: invalid code must fail CompletePairingFull.
	_, err = impl.CompletePairingFull(ctx, "invalid-code-xyz", "BadDevice")
	testutil.RequireTrue(t, err != nil, "invalid code must fail")
}

// --------------------------------------------------------------------------
// Device Role Tests (CompletePairingWithKey + GetDeviceByDID)
// --------------------------------------------------------------------------

// genMultibase generates a fresh Ed25519 keypair and returns the multibase
// public key string and the corresponding DID.
func genMultibase(t *testing.T) (multibase, did string) {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	testutil.RequireNoError(t, err)
	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase = "z" + base58.Encode(multicodec)
	did = "did:key:" + multibase
	return
}

// TestPairing_DeviceRole_DefaultIsUser — CompletePairingWithKey without
// explicit role defaults to "user".
// TRACE: {"suite": "CORE", "case": "1072", "section": "10", "sectionName": "Device Pairing", "subsection": "18", "scenario": "01", "title": "Pairing_DeviceRole_DefaultIsUser"}
func TestPairing_DeviceRole_DefaultIsUser(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	multibase, did := genMultibase(t)
	tokenID, _, err := impl.CompletePairingWithKey(ctx, code, "My Phone", multibase)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, tokenID != "", "must return tokenID")

	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 1)
	testutil.RequireEqual(t, devices[0].DID, did)
	testutil.RequireEqual(t, devices[0].Role, domain.DeviceRoleUser)
	testutil.RequireEqual(t, devices[0].AuthType, "ed25519")
}

// TestPairing_DeviceRole_ExplicitAgent — CompletePairingWithKey with
// role="agent" records agent role.
// TRACE: {"suite": "CORE", "case": "1073", "section": "10", "sectionName": "Device Pairing", "subsection": "19", "scenario": "01", "title": "Pairing_DeviceRole_ExplicitAgent"}
func TestPairing_DeviceRole_ExplicitAgent(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	multibase, did := genMultibase(t)
	tokenID, _, err := impl.CompletePairingWithKey(ctx, code, "OpenClaw Agent", multibase, domain.DeviceRoleAgent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, tokenID != "", "must return tokenID")

	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 1)
	testutil.RequireEqual(t, devices[0].DID, did)
	testutil.RequireEqual(t, devices[0].Role, domain.DeviceRoleAgent)
}

// TestPairing_DeviceRole_MixedRoles — pair two devices, one user and one
// agent. Verify both appear with correct roles in ListDevices.
// TRACE: {"suite": "CORE", "case": "1074", "section": "10", "sectionName": "Device Pairing", "subsection": "20", "scenario": "01", "title": "Pairing_DeviceRole_MixedRoles"}
func TestPairing_DeviceRole_MixedRoles(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	// Pair user device
	code1, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	mb1, did1 := genMultibase(t)
	_, _, err = impl.CompletePairingWithKey(ctx, code1, "My Phone", mb1)
	testutil.RequireNoError(t, err)

	// Pair agent device
	code2, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
	mb2, did2 := genMultibase(t)
	_, _, err = impl.CompletePairingWithKey(ctx, code2, "Bot", mb2, domain.DeviceRoleAgent)
	testutil.RequireNoError(t, err)

	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 2)

	roles := map[string]string{}
	for _, d := range devices {
		roles[d.DID] = d.Role
	}
	testutil.RequireEqual(t, roles[did1], domain.DeviceRoleUser)
	testutil.RequireEqual(t, roles[did2], domain.DeviceRoleAgent)
}

// TestPairing_GetDeviceByDID_Found — GetDeviceByDID returns the correct
// device with all fields populated.
// TRACE: {"suite": "CORE", "case": "1075", "section": "10", "sectionName": "Device Pairing", "subsection": "21", "scenario": "01", "title": "Pairing_GetDeviceByDID_Found"}
func TestPairing_GetDeviceByDID_Found(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	multibase, did := genMultibase(t)
	tokenID, _, err := impl.CompletePairingWithKey(ctx, code, "Paired Device", multibase, domain.DeviceRoleAgent)
	testutil.RequireNoError(t, err)

	device, err := impl.GetDeviceByDID(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, device != nil, "device must be found by DID")
	testutil.RequireEqual(t, device.DID, did)
	testutil.RequireEqual(t, device.TokenID, tokenID)
	testutil.RequireEqual(t, device.Name, "Paired Device")
	testutil.RequireEqual(t, device.Role, domain.DeviceRoleAgent)
	testutil.RequireEqual(t, device.AuthType, "ed25519")
	testutil.RequireTrue(t, device.CreatedAt > 0, "CreatedAt must be set")
	testutil.RequireTrue(t, !device.Revoked, "device must not be revoked")
}

// TestPairing_GetDeviceByDID_NotFound — GetDeviceByDID returns nil for
// unknown DID (no error).
// TRACE: {"suite": "CORE", "case": "1076", "section": "10", "sectionName": "Device Pairing", "subsection": "22", "scenario": "01", "title": "Pairing_GetDeviceByDID_NotFound"}
func TestPairing_GetDeviceByDID_NotFound(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	device, err := impl.GetDeviceByDID(ctx, "did:key:z6MkNonExistent")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, device == nil, "nonexistent DID must return nil, not error")
}

// TestPairing_GetDeviceByDID_Revoked — GetDeviceByDID returns revoked
// devices (revoked flag=true, not nil).
// TRACE: {"suite": "CORE", "case": "1077", "section": "10", "sectionName": "Device Pairing", "subsection": "23", "scenario": "01", "title": "Pairing_GetDeviceByDID_Revoked"}
func TestPairing_GetDeviceByDID_Revoked(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	multibase, did := genMultibase(t)
	tokenID, _, err := impl.CompletePairingWithKey(ctx, code, "To Revoke", multibase)
	testutil.RequireNoError(t, err)

	err = impl.RevokeDevice(ctx, tokenID)
	testutil.RequireNoError(t, err)

	device, err := impl.GetDeviceByDID(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, device != nil, "revoked device must still be findable by DID")
	testutil.RequireTrue(t, device.Revoked, "device must be marked as revoked")
}

// TestPairing_DeviceRole_TokenPairDefaultsUser — Token-based pairing
// (CompletePairing) should default role to "user".
// TRACE: {"suite": "CORE", "case": "1078", "section": "10", "sectionName": "Device Pairing", "subsection": "24", "scenario": "01", "title": "Pairing_DeviceRole_TokenPairDefaultsUser"}
func TestPairing_DeviceRole_TokenPairDefaultsUser(t *testing.T) {
	impl := pairing.NewManager(pairing.DefaultConfig())
	testutil.RequireImplementation(t, impl, "PairingManager")
	ctx := context.Background()

	code, _, err := impl.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	_, _, err = impl.CompletePairing(ctx, code, "Token Device")
	testutil.RequireNoError(t, err)

	devices, err := impl.ListDevices(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(devices), 1)
	// Token-paired devices default to "user" role.
	testutil.RequireEqual(t, devices[0].Role, domain.DeviceRoleUser)
}

// TST-CORE-895
// TRACE: {"suite": "CORE", "case": "1079", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "05", "title": "DeviceTypeRecorded"}
func TestPairing_10_1_5_DeviceTypeRecorded(t *testing.T) {
	t.Skip("Stub: device type recording not yet implemented. Current test only verifies code generation, not device type persistence.")
}

// TST-CORE-896
// TRACE: {"suite": "CORE", "case": "1080", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "06", "title": "mDNS_AutoDiscoveryBroadcast"}
func TestPairing_10_1_6_mDNS_AutoDiscoveryBroadcast(t *testing.T) {
	t.Skip("Stub: mDNS auto-discovery not yet implemented. Current test only verifies ListDevices exists, not broadcast behavior.")
}
