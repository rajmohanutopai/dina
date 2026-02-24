package test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"github.com/anthropics/dina/core/internal/adapter/auth"
	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	"github.com/anthropics/dina/core/test/testutil"

	"github.com/mr-tron/base58"
)

// ==========================================================================
// Ed25519 Signature Authentication Tests
// ==========================================================================
// Covers VerifySignature on the tokenValidator and the middleware integration
// with Ed25519 request signing (X-DID, X-Timestamp, X-Signature headers).
// ==========================================================================

// fixedClock returns a fixed time for deterministic signature tests.
type fixedClock struct {
	t time.Time
}

func (c *fixedClock) Now() time.Time                         { return c.t }
func (c *fixedClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (c *fixedClock) NewTicker(d time.Duration) *time.Ticker  { return time.NewTicker(d) }

var _ port.Clock = (*fixedClock)(nil)

// newSignatureTestValidator creates a tokenValidator with a test Ed25519 key pair registered.
func newSignatureTestValidator(t *testing.T) (*auth.DefaultTokenValidator, ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate Ed25519 keypair: %v", err)
	}

	// Construct did:key from public key.
	multicodec := append([]byte{0xed, 0x01}, pub...)
	encoded := base58.Encode(multicodec)
	did := "did:key:z" + encoded

	tv := auth.NewDefaultTokenValidator(testutil.TestBrainToken)
	tv.RegisterDeviceKey(did, pub, "device-sig-001")
	now := time.Now().UTC()
	tv.SetClock(&fixedClock{t: now})

	return tv, pub, priv, did
}

// signRequest builds the canonical signing payload and signs it.
func signRequest(priv ed25519.PrivateKey, method, path, timestamp string, body []byte) string {
	bodyHash := sha256Hex(body)
	payload := fmt.Sprintf("%s\n%s\n%s\n%s", method, path, timestamp, bodyHash)
	sig := ed25519.Sign(priv, []byte(payload))
	return hex.EncodeToString(sig)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// --------------------------------------------------------------------------
// Valid Signature
// --------------------------------------------------------------------------

func TestSignature_28_ValidSignature_Accepted(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"action":"remember","text":"hello"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	kind, identity, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	testutil.RequireEqual(t, identity, "device-sig-001")
}

func TestSignature_28_ValidSignature_EmptyBody(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	sigHex := signRequest(priv, "GET", "/v1/devices", timestamp, []byte{})

	kind, identity, err := tv.VerifySignature(did, "GET", "/v1/devices", timestamp, []byte{}, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	testutil.RequireEqual(t, identity, "device-sig-001")
}

// --------------------------------------------------------------------------
// Invalid Signature
// --------------------------------------------------------------------------

func TestSignature_28_InvalidSignature_Rejected(t *testing.T) {
	tv, _, _, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"action":"remember"}`)
	// Use a garbage signature.
	badSig := hex.EncodeToString(make([]byte, 64))

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, badSig)
	testutil.RequireError(t, err)
}

func TestSignature_28_WrongKey_Rejected(t *testing.T) {
	tv, _, _, did := newSignatureTestValidator(t)

	// Sign with a different key.
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(otherPriv, "POST", "/v1/vault/store", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedBody_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	originalBody := []byte(`{"action":"remember","text":"original"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, originalBody)

	// Verify with tampered body.
	tamperedBody := []byte(`{"action":"remember","text":"tampered"}`)
	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, tamperedBody, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedPath_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	// Verify with different path.
	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/delete", timestamp, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedMethod_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	// Verify with different method.
	_, _, err := tv.VerifySignature(did, "PUT", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// Replay Protection (Timestamp Window)
// --------------------------------------------------------------------------

func TestSignature_28_ExpiredTimestamp_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 6 minutes in the past (window is 5 minutes).
	expiredTime := time.Now().UTC().Add(-6 * time.Minute)
	timestamp := expiredTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "timestamp")
}

func TestSignature_28_FutureTimestamp_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 6 minutes in the future.
	futureTime := time.Now().UTC().Add(6 * time.Minute)
	timestamp := futureTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "timestamp")
}

func TestSignature_28_WithinWindow_Accepted(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 4 minutes ago (within the 5-minute window).
	recentTime := time.Now().UTC().Add(-4 * time.Minute)
	timestamp := recentTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	kind, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
}

func TestSignature_28_InvalidTimestampFormat_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	badTimestamp := "2026-02-24 10:18:22" // wrong format (space instead of T, no Z)
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", badTimestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", badTimestamp, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "timestamp")
}

// --------------------------------------------------------------------------
// Unknown / Revoked Device
// --------------------------------------------------------------------------

func TestSignature_28_UnknownDID_Rejected(t *testing.T) {
	tv, _, priv, _ := newSignatureTestValidator(t)

	unknownDID := "did:key:zUnknownDeviceDID1234567890"
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	_, _, err := tv.VerifySignature(unknownDID, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_RevokedDevice_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Revoke the device.
	tv.RevokeDeviceKey(did)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex := signRequest(priv, "POST", "/v1/vault/store", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "revoked")
}

// --------------------------------------------------------------------------
// Signature Encoding
// --------------------------------------------------------------------------

func TestSignature_28_MalformedSignatureHex_Rejected(t *testing.T) {
	tv, _, _, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", timestamp, body, "not-valid-hex!!!")
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "signature")
}

// --------------------------------------------------------------------------
// Pairing with Ed25519 Public Key
// --------------------------------------------------------------------------

func TestPairing_28_CompletePairingWithKey_Success(t *testing.T) {
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	// Generate a keypair and multibase-encode the public key.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	testutil.RequireNoError(t, err)

	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase := "z" + base58.Encode(multicodec)

	// Generate a pairing code.
	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	// Complete pairing with the public key.
	deviceID, nodeDID, err := impl.CompletePairingWithKey(context.Background(), code, "test-cli-device", multibase)
	testutil.RequireNoError(t, err)

	if deviceID == "" {
		t.Fatal("expected non-empty device ID")
	}
	if nodeDID == "" {
		t.Fatal("expected non-empty node DID")
	}
}

func TestPairing_28_CompletePairingWithKey_InvalidCode(t *testing.T) {
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase := "z" + base58.Encode(multicodec)

	_, _, err := impl.CompletePairingWithKey(context.Background(), "invalid-code", "test-device", multibase)
	testutil.RequireError(t, err)
}

func TestPairing_28_CompletePairingWithKey_InvalidMultibase(t *testing.T) {
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	// Invalid multibase: missing z prefix.
	_, _, err = impl.CompletePairingWithKey(context.Background(), code, "test-device", "notMultibase")
	testutil.RequireError(t, err)
}

func TestPairing_28_CompletePairingWithKey_CodeAlreadyUsed(t *testing.T) {
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase := "z" + base58.Encode(multicodec)

	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	// First use succeeds.
	_, _, err = impl.CompletePairingWithKey(context.Background(), code, "device-1", multibase)
	testutil.RequireNoError(t, err)

	// Second use with same code fails.
	pub2, _, _ := ed25519.GenerateKey(rand.Reader)
	multicodec2 := append([]byte{0xed, 0x01}, pub2...)
	multibase2 := "z" + base58.Encode(multicodec2)

	_, _, err = impl.CompletePairingWithKey(context.Background(), code, "device-2", multibase2)
	testutil.RequireError(t, err)
}

func TestPairing_28_CompletePairingWithKey_DeviceAppearsInList(t *testing.T) {
	impl := realPairingManager
	testutil.RequireImplementation(t, impl, "PairingManager")

	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase := "z" + base58.Encode(multicodec)

	code, _, err := impl.GenerateCode(context.Background())
	testutil.RequireNoError(t, err)

	deviceID, _, err := impl.CompletePairingWithKey(context.Background(), code, "my-cli-device", multibase)
	testutil.RequireNoError(t, err)

	// List devices and find the newly registered one.
	devices, err := impl.ListDevices(context.Background())
	testutil.RequireNoError(t, err)

	found := false
	for _, d := range devices {
		if d.TokenID == deviceID && d.Name == "my-cli-device" {
			found = true
			testutil.RequireFalse(t, d.Revoked, "newly paired device should not be revoked")
			break
		}
	}
	if !found {
		t.Fatalf("device %q not found in device list after pairing with key", deviceID)
	}
}

// --------------------------------------------------------------------------
// Middleware Integration (Ed25519 → Bearer Fallback)
// --------------------------------------------------------------------------

func TestSignature_28_MockValidator_FallsBackToBearerToken(t *testing.T) {
	// MockTokenValidator.VerifySignature always rejects.
	// This verifies the middleware pattern: if X-DID headers are absent,
	// the middleware falls back to Bearer token auth.
	mock := testutil.NewMockTokenValidator()
	mock.ClientTokens["test-token"] = "device-001"

	// Bearer auth works.
	kind, identity, err := mock.IdentifyToken("test-token")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	testutil.RequireEqual(t, identity, "device-001")

	// Signature auth rejects (mock always rejects).
	_, _, err = mock.VerifySignature("did:key:zTest", "GET", "/", "2026-01-01T00:00:00Z", nil, "aabb")
	testutil.RequireError(t, err)
}
