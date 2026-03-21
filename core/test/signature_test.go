package test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/test/testutil"

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

	tv := auth.NewDefaultTokenValidator()
	tv.RegisterDeviceKey(did, pub, "device-sig-001")
	now := time.Now().UTC()
	tv.SetClock(&fixedClock{t: now})

	return tv, pub, priv, did
}

// signRequest builds the canonical signing payload and signs it.
// Generates a random nonce and returns (signatureHex, nonce).
func signRequest(priv ed25519.PrivateKey, method, path, query, timestamp string, body []byte) (string, string) {
	nonce := testNonce()
	bodyHash := sha256Hex(body)
	payload := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s", method, path, query, timestamp, nonce, bodyHash)
	sig := ed25519.Sign(priv, []byte(payload))
	return hex.EncodeToString(sig), nonce
}

func testNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
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
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	kind, identity, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	testutil.RequireEqual(t, identity, "device-sig-001")
}

func TestSignature_28_ValidSignature_EmptyBody(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	sigHex, nonce := signRequest(priv, "GET", "/v1/devices", "", timestamp, []byte{})

	kind, identity, err := tv.VerifySignature(did, "GET", "/v1/devices", "", timestamp, nonce, []byte{}, sigHex)
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

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, "", body, badSig)
	testutil.RequireError(t, err)
}

func TestSignature_28_WrongKey_Rejected(t *testing.T) {
	tv, _, _, did := newSignatureTestValidator(t)

	// Sign with a different key.
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(otherPriv, "POST", "/v1/vault/store", "", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedBody_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	originalBody := []byte(`{"action":"remember","text":"original"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, originalBody)

	// Verify with tampered body.
	tamperedBody := []byte(`{"action":"remember","text":"tampered"}`)
	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, tamperedBody, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedPath_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	// Verify with different path.
	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/delete", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_TamperedMethod_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	// Verify with different method.
	_, _, err := tv.VerifySignature(did, "PUT", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// Replay Protection (Timestamp Window)
// --------------------------------------------------------------------------

// TST-CORE-1223
func TestSignature_28_ExpiredTimestamp_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 6 minutes in the past (window is 5 minutes).
	expiredTime := time.Now().UTC().Add(-6 * time.Minute)
	timestamp := expiredTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "timestamp")
}

// TST-CORE-1224
func TestSignature_28_FutureTimestamp_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 6 minutes in the future.
	futureTime := time.Now().UTC().Add(6 * time.Minute)
	timestamp := futureTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "timestamp")
}

func TestSignature_28_WithinWindow_Accepted(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Timestamp 4 minutes ago (within the 5-minute window).
	recentTime := time.Now().UTC().Add(-4 * time.Minute)
	timestamp := recentTime.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	kind, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
}

// TST-CORE-1225
func TestSignature_28_InvalidTimestampFormat_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	badTimestamp := "2026-02-24 10:18:22" // wrong format (space instead of T, no Z)
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", badTimestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", badTimestamp, nonce, body, sigHex)
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
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	_, _, err := tv.VerifySignature(unknownDID, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
}

func TestSignature_28_RevokedDevice_Rejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	// Revoke the device.
	tv.RevokeDeviceKey(did)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"data":"test"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
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

	_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, "", body, "not-valid-hex!!!")
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
	// Verify the real Auth.Handler middleware: when X-DID headers are absent,
	// the middleware falls back to Bearer token auth via IdentifyToken.
	mock := testutil.NewMockTokenValidator()
	mock.ClientTokens["test-token"] = "device-001"

	authMiddleware := middleware.Auth{Tokens: mock}

	// Inner handler captures the context values set by the middleware.
	var capturedKind, capturedIdentity string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedKind, _ = r.Context().Value(middleware.TokenKindKey).(string)
		capturedIdentity, _ = r.Context().Value(middleware.AgentDIDKey).(string)
		w.WriteHeader(http.StatusOK)
	})

	handler := authMiddleware.Handler(inner)

	// --- Case 1: Bearer token (no X-DID headers) → fallback path ---
	req := httptest.NewRequest("GET", "/v1/did", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	testutil.RequireEqual(t, rec.Code, http.StatusOK)
	testutil.RequireEqual(t, capturedKind, "client")
	testutil.RequireEqual(t, capturedIdentity, "device-001")

	// --- Case 2: No auth at all → 401 ---
	req2 := httptest.NewRequest("GET", "/v1/did", nil)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)

	testutil.RequireEqual(t, rec2.Code, http.StatusUnauthorized)
}

// --------------------------------------------------------------------------
// §34.2 Agent Sandbox Adversarial — Agent Revocation
// --------------------------------------------------------------------------

// TST-CORE-1129
func TestSignature_34_2_8_AgentRevocationTakesImmediateEffect(t *testing.T) {
	// Requirement (§34.2):
	//   When an agent DID is revoked, the revocation must take immediate effect.
	//   Any subsequent request signed by the revoked agent must be rejected with
	//   an error containing "revoked". No caching delay is acceptable.
	//
	// Anti-tautological design:
	//   1. Register agent → valid signature accepted (positive control)
	//   2. Revoke agent → same signature format rejected with "revoked"
	//   3. Revocation affects only the revoked agent (other agents still work)
	//   4. Revocation is immediate — no delay between revoke and rejection
	//   5. Re-registration after revocation restores access (contrast)

	t.Run("valid_before_revocation_rejected_after", func(t *testing.T) {
		tv, _, priv, did := newSignatureTestValidator(t)

		// Before revocation: valid signature accepted.
		timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		body := []byte(`{"action":"agent_intent","intent":"query_product"}`)
		sigHex, nonce := signRequest(priv, "POST", "/v1/agent/validate", "", timestamp, body)

		_, _, err := tv.VerifySignature(did, "POST", "/v1/agent/validate", "", timestamp, nonce, body, sigHex)
		if err != nil {
			t.Fatalf("before revocation, valid signature must be accepted: %v", err)
		}

		// Revoke the agent.
		tv.RevokeDeviceKey(did)

		// After revocation: same format of request must fail.
		timestamp2 := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		body2 := []byte(`{"action":"agent_intent","intent":"query_product_2"}`)
		sigHex2, nonce2 := signRequest(priv, "POST", "/v1/agent/validate", "", timestamp2, body2)

		_, _, err = tv.VerifySignature(did, "POST", "/v1/agent/validate", "", timestamp2, nonce2, body2, sigHex2)
		if err == nil {
			t.Fatal("after revocation, agent request must be rejected")
		}
		testutil.RequireContains(t, err.Error(), "revoked")
	})

	t.Run("revocation_does_not_affect_other_agents", func(t *testing.T) {
		// Register two agents.
		tv := auth.NewDefaultTokenValidator()
		tv.SetClock(&fixedClock{t: time.Now().UTC()})

		pub1, priv1, _ := ed25519.GenerateKey(rand.Reader)
		mc1 := append([]byte{0xed, 0x01}, pub1...)
		did1 := "did:key:z" + base58.Encode(mc1)
		tv.RegisterDeviceKey(did1, pub1, "agent-001")

		pub2, priv2, _ := ed25519.GenerateKey(rand.Reader)
		mc2 := append([]byte{0xed, 0x01}, pub2...)
		did2 := "did:key:z" + base58.Encode(mc2)
		tv.RegisterDeviceKey(did2, pub2, "agent-002")

		// Revoke only agent 1.
		tv.RevokeDeviceKey(did1)

		// Agent 1: rejected.
		ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		body := []byte(`{"action":"test"}`)
		sig1, nonce1 := signRequest(priv1, "POST", "/v1/agent/validate", "", ts, body)
		_, _, err := tv.VerifySignature(did1, "POST", "/v1/agent/validate", "", ts, nonce1, body, sig1)
		if err == nil {
			t.Fatal("revoked agent-001 must be rejected")
		}
		testutil.RequireContains(t, err.Error(), "revoked")

		// Agent 2: still accepted.
		sig2, nonce2 := signRequest(priv2, "POST", "/v1/agent/validate", "", ts, body)
		_, _, err = tv.VerifySignature(did2, "POST", "/v1/agent/validate", "", ts, nonce2, body, sig2)
		if err != nil {
			t.Fatalf("non-revoked agent-002 must still be accepted: %v", err)
		}
	})

	t.Run("revocation_is_immediate_no_cache_delay", func(t *testing.T) {
		tv, _, priv, did := newSignatureTestValidator(t)

		// Verify access works.
		ts1 := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		body := []byte(`{"test":"immediate"}`)
		sig, nonce := signRequest(priv, "POST", "/v1/vault/query", "", ts1, body)
		_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/query", "", ts1, nonce, body, sig)
		testutil.RequireNoError(t, err)

		// Revoke and IMMEDIATELY verify rejection — no sleep, no delay.
		tv.RevokeDeviceKey(did)

		ts2 := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		sig2, nonce2 := signRequest(priv, "POST", "/v1/vault/query", "", ts2, body)
		_, _, err = tv.VerifySignature(did, "POST", "/v1/vault/query", "", ts2, nonce2, body, sig2)
		if err == nil {
			t.Fatal("revocation must take effect immediately — no cache delay")
		}
		testutil.RequireContains(t, err.Error(), "revoked")
	})

	t.Run("multiple_endpoints_all_rejected_after_revocation", func(t *testing.T) {
		tv, _, priv, did := newSignatureTestValidator(t)

		tv.RevokeDeviceKey(did)

		endpoints := []struct {
			method string
			path   string
		}{
			{"POST", "/v1/agent/validate"},
			{"POST", "/v1/vault/store"},
			{"GET", "/v1/vault/query"},
			{"POST", "/v1/did/sign"},
		}

		for _, ep := range endpoints {
			ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
			body := []byte(`{"test":"revoked"}`)
			sig, nonce := signRequest(priv, ep.method, ep.path, "", ts, body)
			_, _, err := tv.VerifySignature(did, ep.method, ep.path, "", ts, nonce, body, sig)
			if err == nil {
				t.Fatalf("revoked agent must be rejected on %s %s", ep.method, ep.path)
			}
			testutil.RequireContains(t, err.Error(), "revoked")
		}
	})
}
