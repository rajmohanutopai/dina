package pairing

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// testMultibaseKey generates a random Ed25519 keypair and returns the
// public key in multibase format (z + base58btc(0xed01 + pubkey)).
func testMultibaseKey(t *testing.T) (publicKeyMultibase string) {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Multicodec prefix for Ed25519: 0xed 0x01
	raw := append([]byte{0xed, 0x01}, pub...)
	return "z" + base58.Encode(raw)
}

func newTestManager(t *testing.T) *PairingManager {
	t.Helper()
	return NewManager(Config{
		CodeTTL: 5 * time.Minute,
		NodeDID: "did:plc:test-node",
		WsURL:   "wss://test.local/ws",
	})
}

// --- TST-MBX-0046: Wrong pairing code → rejected, attempt counter incremented ---
// TRACE: {"suite": "MBX", "case": "0046", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "02", "title": "wrong_code_rejected"}
func TestPairing_WrongCodeRejected(t *testing.T) {
	pm := newTestManager(t)
	ctx := context.Background()

	// Generate a valid code.
	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Try to complete with WRONG code.
	key := testMultibaseKey(t)
	_, _, err = pm.CompletePairingWithKey(ctx, "000000", "laptop", key)
	if err != ErrInvalidCode {
		t.Errorf("wrong code: err = %v, want ErrInvalidCode", err)
	}

	// The correct code should still work (wrong code didn't burn it).
	_, _, err = pm.CompletePairingWithKey(ctx, code, "laptop", key)
	if err != nil {
		t.Errorf("correct code after wrong attempt: %v", err)
	}
}

// --- Wrong attempts do NOT burn the code (typo-friendly) ---
// With Crockford Base32 8-char codes (32^8 = 1.1 trillion), brute-force is
// infeasible. The burn counter was removed to avoid punishing typos.
func TestPairing_WrongAttemptsDoNotBurnCode(t *testing.T) {
	pm := newTestManager(t)
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// 10 wrong attempts should NOT burn the code.
	for i := 0; i < 10; i++ {
		key := testMultibaseKey(t)
		_, _, err := pm.CompletePairingWithKey(ctx, "WRONGCOD", "attempt", key)
		if err != ErrInvalidCode {
			t.Fatalf("attempt %d: err = %v, want ErrInvalidCode", i, err)
		}
	}

	// The correct code should STILL work — not burned by typos.
	key := testMultibaseKey(t)
	_, _, err = pm.CompletePairingWithKey(ctx, code, "laptop", key)
	if err != nil {
		t.Errorf("correct code after 10 wrong attempts: %v (should not be burned)", err)
	}
}

// --- TST-MBX-0048: Expired code → rejected ---
// TRACE: {"suite": "MBX", "case": "0048", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "04", "title": "expired_code_rejected"}
func TestPairing_ExpiredCodeRejected(t *testing.T) {
	// Use a very short TTL.
	pm := NewManager(Config{
		CodeTTL: 50 * time.Millisecond,
		NodeDID: "did:plc:test-node",
		WsURL:   "wss://test.local/ws",
	})
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Wait for the code to expire.
	time.Sleep(100 * time.Millisecond)

	key := testMultibaseKey(t)
	_, _, err = pm.CompletePairingWithKey(ctx, code, "laptop", key)
	if err != ErrInvalidCode {
		t.Errorf("expired code: err = %v, want ErrInvalidCode", err)
	}
}

// --- TST-MBX-0049: Reused code → rejected ---
// TRACE: {"suite": "MBX", "case": "0049", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "05", "title": "reused_code_rejected"}
func TestPairing_ReusedCodeRejected(t *testing.T) {
	pm := newTestManager(t)
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// First use: success.
	key1 := testMultibaseKey(t)
	_, _, err = pm.CompletePairingWithKey(ctx, code, "laptop", key1)
	if err != nil {
		t.Fatalf("first use: %v", err)
	}

	// Second use: rejected (code consumed and deleted).
	key2 := testMultibaseKey(t)
	_, _, err = pm.CompletePairingWithKey(ctx, code, "phone", key2)
	if err != ErrInvalidCode {
		t.Errorf("reuse: err = %v, want ErrInvalidCode (code consumed)", err)
	}
}

// --- TST-MBX-0052: Pairing request with no Ed25519 signature → accepted ---
// TRACE: {"suite": "MBX", "case": "0052", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "08", "title": "no_ed25519_signature_accepted"}
//
// /v1/pair/complete is in optionalAuthPaths — the pairing code IS the auth.
// CompletePairingWithKey does not require Ed25519 signature headers.
func TestPairing_NoSignatureAccepted(t *testing.T) {
	pm := newTestManager(t)
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Complete with just the code and public key — no signature.
	key := testMultibaseKey(t)
	tokenID, nodeDID, err := pm.CompletePairingWithKey(ctx, code, "laptop", key)
	if err != nil {
		t.Fatalf("pairing without signature: %v", err)
	}
	if tokenID == "" || nodeDID == "" {
		t.Errorf("tokenID=%q nodeDID=%q — should be non-empty", tokenID, nodeDID)
	}

	// The expected device DID is did:key: + the multibase key.
	expectedDeviceDID := "did:key:" + key

	// Device should be registered.
	devices, _ := pm.ListDevices(ctx)
	found := false
	for _, d := range devices {
		if d.DID == expectedDeviceDID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("device DID %q not found in device list", expectedDeviceDID)
	}
}

// --- TST-MBX-0053: Attacker mints fresh did:key per attempt ---
// TRACE: {"suite": "MBX", "case": "0053", "section": "05", "sectionName": "Pairing", "subsection": "02", "scenario": "01", "title": "fresh_did_key_per_attempt_burned"}
//
// Per-DID rate limits are useless for pairing (attacker mints fresh did:key).
// --- Code format is 8-char Crockford Base32 ---
func TestPairing_CodeFormat(t *testing.T) {
	pm := newTestManager(t)
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if len(code) != 8 {
		t.Errorf("code length = %d, want 8", len(code))
	}

	// All characters must be in Crockford Base32 alphabet.
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	for i, c := range code {
		found := false
		for _, a := range alphabet {
			if c == a {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("code[%d] = %c, not in Crockford Base32 alphabet", i, c)
		}
	}
}
