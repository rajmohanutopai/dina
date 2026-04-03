package test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/adapter/server"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"

	"github.com/mr-tron/base58"
)

// ============================================================================
// TEST_PLAN §32 — Security Fix Verification (Batch 5)
// ============================================================================
// SEC-MED-09 (Inbound Hard Cap), SEC-MED-11 (Nonce Double-Buffer),
// SEC-MED-12 (Per-DID Rate), SEC-MED-13 (Pairing Cap), SEC-MED-14 (WellKnown)
// ============================================================================

// --------------------------------------------------------------------------
// §32.1 Nonce Cache Double-Buffer (SEC-MED-11) — 4 scenarios
// --------------------------------------------------------------------------

// TST-CORE-1058
// TRACE: {"suite": "CORE", "case": "0516", "section": "32", "sectionName": "Security Fix Verification", "subsection": "01", "scenario": "01", "title": "ReplaySignatureRejected"}
func TestSecFix_32_1_1_ReplaySignatureRejected(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body := []byte(`{"action":"remember","text":"test-replay"}`)
	sigHex, nonce := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body)

	// First use should succeed.
	kind, identity, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	testutil.RequireEqual(t, identity, "device-sig-001")

	// Replay the same signature — must be rejected.
	_, _, err = tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce, body, sigHex)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "replayed")
}

// TST-CORE-1059
// TRACE: {"suite": "CORE", "case": "0517", "section": "32", "sectionName": "Security Fix Verification", "subsection": "01", "scenario": "02", "title": "DifferentSignaturesAccepted"}
func TestSecFix_32_1_2_DifferentSignaturesAccepted(t *testing.T) {
	tv, _, priv, did := newSignatureTestValidator(t)

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	body1 := []byte(`{"action":"remember","text":"body1"}`)
	body2 := []byte(`{"action":"remember","text":"body2"}`)
	sig1, nonce1 := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body1)
	sig2, nonce2 := signRequest(priv, "POST", "/v1/vault/store", "", timestamp, body2)

	kind1, identity1, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce1, body1, sig1)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind1, domain.TokenClient)
	testutil.RequireEqual(t, identity1, "device-sig-001")

	kind2, identity2, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", timestamp, nonce2, body2, sig2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind2, domain.TokenClient)
	testutil.RequireEqual(t, identity2, "device-sig-001")
}

// TST-CORE-1060
// TRACE: {"suite": "CORE", "case": "0518", "section": "32", "sectionName": "Security Fix Verification", "subsection": "01", "scenario": "03", "title": "DoubleBufferRotation"}
func TestSecFix_32_1_3_DoubleBufferRotation(t *testing.T) {
	tv := auth.NewDefaultTokenValidator()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	multicodec := append([]byte{0xed, 0x01}, pub...)
	did := "did:key:z" + base58.Encode(multicodec)
	tv.RegisterDeviceKey(did, pub, "device-rotation")

	// Set clock to a fixed time.
	now := time.Now().UTC()
	clk := &fixedClock{t: now}
	tv.SetClock(clk)

	// Sign and verify a request at time T.
	ts := now.Format("2006-01-02T15:04:05Z")
	body := []byte(`{"test":"rotation"}`)
	sig, nonce := signRequest(priv, "GET", "/v1/vault/query", "", ts, body)

	_, _, err = tv.VerifySignature(did, "GET", "/v1/vault/query", "", ts, nonce, body, sig)
	testutil.RequireNoError(t, err)

	// Advance the clock by maxClockSkew + 1 second (triggers rotation).
	clk.t = now.Add(5*time.Minute + 1*time.Second)
	newTS := clk.t.Format("2006-01-02T15:04:05Z")

	// New request with a new signature should succeed (triggers rotation).
	body2 := []byte(`{"test":"after-rotation"}`)
	sig2, nonce2 := signRequest(priv, "GET", "/v1/vault/query", "", newTS, body2)
	_, _, err = tv.VerifySignature(did, "GET", "/v1/vault/query", "", newTS, nonce2, body2, sig2)
	testutil.RequireNoError(t, err)

	// The original signature's timestamp is now >5min old, so it falls outside
	// the acceptable clock-skew window. Defense-in-depth: even if the nonce
	// cache didn't catch it, the timestamp check would reject it.
	_, _, err = tv.VerifySignature(did, "GET", "/v1/vault/query", "", ts, nonce, body, sig)
	testutil.RequireError(t, err)
	// Either "replayed signature" (nonce cache) or "timestamp outside acceptable window"
	// (clock skew) — both are valid rejection reasons for a stale replay.

	// Verify the second request's signature is also protected against replay.
	_, _, err = tv.VerifySignature(did, "GET", "/v1/vault/query", "", newTS, nonce2, body2, sig2)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "replayed")
}

// TST-CORE-1061
// TRACE: {"suite": "CORE", "case": "0519", "section": "32", "sectionName": "Security Fix Verification", "subsection": "01", "scenario": "04", "title": "SafetyValveUnderLoad"}
func TestSecFix_32_1_4_SafetyValveUnderLoad(t *testing.T) {
	tv := auth.NewDefaultTokenValidator()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	multicodec := append([]byte{0xed, 0x01}, pub...)
	did := "did:key:z" + base58.Encode(multicodec)
	tv.RegisterDeviceKey(did, pub, "device-valve")

	now := time.Now().UTC()
	clk := &fixedClock{t: now}
	tv.SetClock(clk)

	// Generate many unique signatures. Verify system stays functional.
	ts := now.Format("2006-01-02T15:04:05Z")
	for i := 0; i < 1000; i++ {
		body := []byte(fmt.Sprintf(`{"i":%d}`, i))
		sig, nonce := signRequest(priv, "POST", "/v1/vault/store", "", ts, body)
		_, _, err := tv.VerifySignature(did, "POST", "/v1/vault/store", "", ts, nonce, body, sig)
		testutil.RequireNoError(t, err)
	}

	// System should still be functional — no 429 errors, no panics.
	body := []byte(`{"final":"check"}`)
	sig, nonce := signRequest(priv, "POST", "/v1/vault/store", "", ts, body)
	_, _, err = tv.VerifySignature(did, "POST", "/v1/vault/store", "", ts, nonce, body, sig)
	testutil.RequireNoError(t, err)
}

// --------------------------------------------------------------------------
// §32.2 Inbound Message Hard Cap (SEC-MED-09) — 2 scenarios
// --------------------------------------------------------------------------

// TST-CORE-1062
// TRACE: {"suite": "CORE", "case": "0520", "section": "32", "sectionName": "Security Fix Verification", "subsection": "02", "scenario": "01", "title": "InboundCapEnforced"}
func TestSecFix_32_2_1_InboundCapEnforced(t *testing.T) {
	env := newTransportTestEnv(t)

	// The production hard cap is maxInboundMessages = 10000 (SEC-MED-09).
	const cap = 10000

	// Fill the inbox to exactly the cap.
	for i := 0; i < cap; i++ {
		msg := &domain.DinaMessage{
			Type: "com.dina.test",
			ID:   fmt.Sprintf("msg-%d", i),
			Body: []byte(fmt.Sprintf("body-%d", i)),
		}
		env.svc.StoreInbound(msg)
	}

	msgs := env.svc.GetInbound()
	testutil.RequireEqual(t, len(msgs), cap)

	// Verify ordering is preserved at capacity.
	testutil.RequireEqual(t, msgs[0].ID, "msg-0")
	testutil.RequireEqual(t, msgs[cap-1].ID, fmt.Sprintf("msg-%d", cap-1))

	// Store one more message beyond the cap — should trigger FIFO eviction
	// of the oldest message (msg-0), keeping total at cap.
	env.svc.StoreInbound(&domain.DinaMessage{
		Type: "com.dina.test",
		ID:   "msg-overflow",
		Body: []byte("overflow"),
	})

	msgs = env.svc.GetInbound()
	testutil.RequireEqual(t, len(msgs), cap)

	// The oldest message (msg-0) should have been evicted.
	testutil.RequireEqual(t, msgs[0].ID, "msg-1")

	// The overflow message should be at the end.
	testutil.RequireEqual(t, msgs[cap-1].ID, "msg-overflow")
}

// TST-CORE-1063
// TRACE: {"suite": "CORE", "case": "0521", "section": "32", "sectionName": "Security Fix Verification", "subsection": "02", "scenario": "02", "title": "InboundClearWorks"}
func TestSecFix_32_2_2_InboundClearWorks(t *testing.T) {
	env := newTransportTestEnv(t)

	for i := 0; i < 10; i++ {
		msg := &domain.DinaMessage{Type: "com.dina.test", ID: fmt.Sprintf("msg-%d", i)}
		env.svc.StoreInbound(msg)
	}

	testutil.RequireEqual(t, len(env.svc.GetInbound()), 10)
	env.svc.ClearInbound()
	testutil.RequireEqual(t, len(env.svc.GetInbound()), 0)
}

// --------------------------------------------------------------------------
// §32.3 Per-DID Rate Enforcement (SEC-MED-12) — 2 scenarios
// --------------------------------------------------------------------------

// TST-CORE-1064
// TRACE: {"suite": "CORE", "case": "0522", "section": "32", "sectionName": "Security Fix Verification", "subsection": "03", "scenario": "01", "title": "PerDIDRateIsolation"}
func TestSecFix_32_3_1_PerDIDRateIsolation(t *testing.T) {
	// Create a fresh InboxManager with a low per-DID rate limit so we can
	// actually exhaust one DID's quota and verify the other is unaffected.
	cfg := transport.DefaultInboxConfig()
	cfg.DIDRateLimit = 5
	impl := transport.NewInboxManager(cfg)

	// Exhaust DID-A's rate limit (5 allowed, 6th should be rejected).
	for i := 0; i < 5; i++ {
		testutil.RequireTrue(t, impl.CheckDIDRate("did:key:z6MkIsolationA"),
			fmt.Sprintf("DID-A request %d should pass", i))
	}
	testutil.RequireFalse(t, impl.CheckDIDRate("did:key:z6MkIsolationA"),
		"DID-A should be rate-limited after exhausting quota")

	// DID-B must have an independent counter — all 5 should pass despite
	// DID-A being fully exhausted (proves per-DID isolation).
	for i := 0; i < 5; i++ {
		testutil.RequireTrue(t, impl.CheckDIDRate("did:key:z6MkIsolationB"),
			fmt.Sprintf("DID-B request %d should pass (isolation from DID-A)", i))
	}
	// And DID-B should also hit its own limit at the 6th call.
	testutil.RequireFalse(t, impl.CheckDIDRate("did:key:z6MkIsolationB"),
		"DID-B should be rate-limited after exhausting its own quota")
}

// TST-CORE-1065
// TRACE: {"suite": "CORE", "case": "0523", "section": "32", "sectionName": "Security Fix Verification", "subsection": "03", "scenario": "02", "title": "RateLimitResetAfterWindow"}
func TestSecFix_32_3_2_RateLimitResetAfterWindow(t *testing.T) {
	impl := realInboxManager

	// Exhaust DID rate limit.
	for i := 0; i < 200; i++ {
		impl.CheckDIDRate("did:key:z6MkResetTest")
	}
	testutil.RequireFalse(t, impl.CheckDIDRate("did:key:z6MkResetTest"),
		"DID should be rate-limited after exhaustion")

	// Reset counters (simulating new time window).
	impl.ResetRateLimits()

	// After reset, the same DID should pass again.
	testutil.RequireTrue(t, impl.CheckDIDRate("did:key:z6MkResetTest"),
		"DID should pass after rate limit reset")
}

// --------------------------------------------------------------------------
// §32.4 Pairing Code Hard Cap (SEC-MED-13) — 4 scenarios
// --------------------------------------------------------------------------

// TST-CORE-1066
// TRACE: {"suite": "CORE", "case": "0524", "section": "32", "sectionName": "Security Fix Verification", "subsection": "04", "scenario": "01", "title": "HardCapEnforced"}
func TestSecFix_32_4_1_HardCapEnforced(t *testing.T) {
	cfg := pairing.Config{
		CodeTTL: 10 * time.Minute,
		NodeDID: "did:test:hardcap",
		WsURL:   "wss://test/ws",
	}
	pm := pairing.NewManager(cfg)
	ctx := context.Background()

	// Generate exactly maxPendingCodes (100) — all should succeed.
	for i := 0; i < 100; i++ {
		_, _, err := pm.GenerateCode(ctx)
		if err != nil {
			t.Fatalf("code %d should succeed, got: %v", i, err)
		}
	}

	// The 101st should fail with ErrTooManyPendingCodes.
	_, _, err := pm.GenerateCode(ctx)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "too many pending")
}

// TST-CORE-1067
// TRACE: {"suite": "CORE", "case": "0525", "section": "32", "sectionName": "Security Fix Verification", "subsection": "04", "scenario": "02", "title": "CompletePairingFreesSlot"}
func TestSecFix_32_4_2_CompletePairingFreesSlot(t *testing.T) {
	cfg := pairing.Config{
		CodeTTL: 10 * time.Minute,
		NodeDID: "did:test:freeslot",
		WsURL:   "wss://test/ws",
	}
	pm := pairing.NewManager(cfg)
	ctx := context.Background()

	// Fill up to the cap.
	var firstCode string
	for i := 0; i < 100; i++ {
		code, _, err := pm.GenerateCode(ctx)
		testutil.RequireNoError(t, err)
		if i == 0 {
			firstCode = code
		}
	}

	// Cap reached — next should fail.
	_, _, err := pm.GenerateCode(ctx)
	testutil.RequireError(t, err)

	// Complete pairing with the first code — frees a slot.
	_, _, err = pm.CompletePairing(ctx, firstCode, "FreeSlotDevice")
	testutil.RequireNoError(t, err)

	// Now we can generate one more code.
	_, _, err = pm.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
}

// TST-CORE-1068
// TRACE: {"suite": "CORE", "case": "0526", "section": "32", "sectionName": "Security Fix Verification", "subsection": "04", "scenario": "03", "title": "PurgeExpiredCodesFreesSlots"}
func TestSecFix_32_4_3_PurgeExpiredCodesFreesSlots(t *testing.T) {
	cfg := pairing.Config{
		CodeTTL: 1 * time.Millisecond,
		NodeDID: "did:test:purge",
		WsURL:   "wss://test/ws",
	}
	pm := pairing.NewManager(cfg)
	ctx := context.Background()

	// Generate 50 codes.
	for i := 0; i < 50; i++ {
		_, _, err := pm.GenerateCode(ctx)
		testutil.RequireNoError(t, err)
	}

	// Wait for codes to expire.
	time.Sleep(10 * time.Millisecond)

	// Purge should remove all expired codes.
	purged := pm.PurgeExpiredCodes()
	testutil.RequireEqual(t, purged, 50)

	// After purge, we should be able to generate new codes.
	_, _, err := pm.GenerateCode(ctx)
	testutil.RequireNoError(t, err)
}

// TST-CORE-1069
// TRACE: {"suite": "CORE", "case": "0527", "section": "32", "sectionName": "Security Fix Verification", "subsection": "04", "scenario": "04", "title": "ImmediateCleanupOnUse"}
func TestSecFix_32_4_4_ImmediateCleanupOnUse(t *testing.T) {
	cfg := pairing.Config{
		CodeTTL: 10 * time.Minute,
		NodeDID: "did:test:cleanup",
		WsURL:   "wss://test/ws",
	}
	pm := pairing.NewManager(cfg)
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	testutil.RequireNoError(t, err)

	// Complete pairing.
	_, _, err = pm.CompletePairing(ctx, code, "CleanupDevice")
	testutil.RequireNoError(t, err)

	// Attempting to pair again should fail with "invalid" (code gone), not "already used".
	_, _, err = pm.CompletePairing(ctx, code, "AttemptReuse")
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "invalid")
}

// --------------------------------------------------------------------------
// §32.5 WellKnown Idempotency (SEC-MED-14) — 1 scenario
// --------------------------------------------------------------------------

// TST-CORE-1070
// TRACE: {"suite": "CORE", "case": "0528", "section": "32", "sectionName": "Security Fix Verification", "subsection": "05", "scenario": "01", "title": "WellKnownIdempotent"}
func TestSecFix_32_5_1_WellKnownIdempotent(t *testing.T) {
	impl := realATProtoDiscovery
	testutil.RequireImplementation(t, impl, "ATProtoDiscovery")

	// Positive: first call should return a DID with correct prefix.
	did1, err := impl.GetATProtoDID()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(did1) > 0, "DID must not be empty")
	testutil.RequireContains(t, did1, "did:")

	// Idempotency: second call returns the same DID.
	did2, err := impl.GetATProtoDID()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, did1, did2)

	// Negative: ATProtoDiscovery with empty rootDID must return error.
	var emptyImpl testutil.ATProtoDiscovery = server.NewATProtoDiscovery("")
	_, err = emptyImpl.GetATProtoDID()
	testutil.RequireError(t, err)

	// HasRootDID must reflect the state accurately.
	testutil.RequireTrue(t, impl.HasRootDID(), "configured instance must have root DID")
	testutil.RequireFalse(t, emptyImpl.HasRootDID(), "empty instance must not have root DID")
}
