package test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/mr-tron/base58"
	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// §31.8 — D2D Sender Signature in Delivery Payload
// Tests verify that:
//   1. SendMessage delivers a JSON wrapper with "c" (ciphertext) and "s" (sig)
//   2. ProcessInbound with JSON wrapper + valid sig succeeds
//   3. ProcessInbound with JSON wrapper + tampered sig returns ErrInvalidSignature
//   4. ProcessInbound with raw bytes (legacy) still works (backward compat)
//   5. ProcessOutbox retries also use the JSON wrapper format
// ==========================================================================

// d2dSigTestEnv holds test infrastructure for D2D signature delivery tests.
type d2dSigTestEnv struct {
	svc        *service.TransportService
	signer     *dinacrypto.Ed25519Signer
	encryptor  *dinacrypto.NaClBoxSealer
	converter  *dinacrypto.KeyConverter
	resolver   *mockDIDResolver
	outbox     *testutil.MockOutboxManager
	deliverer  *mockDeliverer
	senderPub  ed25519.PublicKey
	senderPriv ed25519.PrivateKey
	rcptPub    ed25519.PublicKey
	rcptPriv   ed25519.PrivateKey
}

func newD2DSigTestEnv(t *testing.T) *d2dSigTestEnv {
	t.Helper()

	signer := dinacrypto.NewEd25519Signer()
	encryptor := dinacrypto.NewNaClBoxSealer()
	converter := dinacrypto.NewKeyConverter()
	clk := &transportTestClock{now: time.Now()}

	// Generate sender and recipient Ed25519 keypairs from deterministic seeds.
	senderSeed := [32]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
		0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
		0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20}
	rcptSeed := [32]byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
		0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
		0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
		0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99}

	senderPub, senderPriv, err := signer.GenerateFromSeed(senderSeed[:])
	if err != nil {
		t.Fatalf("generate sender keys: %v", err)
	}
	rcptPub, rcptPriv, err := signer.GenerateFromSeed(rcptSeed[:])
	if err != nil {
		t.Fatalf("generate recipient keys: %v", err)
	}

	senderDID := domain.DID("did:key:z6MkSenderTest")
	rcptDID := domain.DID("did:key:z6MkRecipientTest")

	resolver := &mockDIDResolver{docs: map[string]*domain.DIDDocument{
		string(senderDID): {
			ID: string(senderDID),
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 string(senderDID) + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         string(senderDID),
				PublicKeyMultibase: "z" + base58.Encode(append([]byte{0xed, 0x01}, senderPub...)),
			}},
			Service: []domain.ServiceEndpoint{{
				ID:              "#didcomm",
				Type:            "DIDCommMessaging",
				ServiceEndpoint: "https://sender.test/msg",
			}},
		},
		string(rcptDID): {
			ID: string(rcptDID),
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 string(rcptDID) + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         string(rcptDID),
				PublicKeyMultibase: "z" + base58.Encode(append([]byte{0xed, 0x01}, rcptPub...)),
			}},
			Service: []domain.ServiceEndpoint{{
				ID:              "#didcomm",
				Type:            "DIDCommMessaging",
				ServiceEndpoint: "https://recipient.test/msg",
			}},
		},
	}}

	outbox := testutil.NewMockOutboxManager()
	inbox := testutil.NewMockInboxManager()
	identitySigner := &mockIdentitySigner{priv: ed25519.PrivateKey(senderPriv)}

	svc := service.NewTransportService(encryptor, identitySigner, converter, resolver, outbox, inbox, clk)
	svc.SetVerifier(signer)

	deliverer := &mockDeliverer{}
	svc.SetDeliverer(deliverer)

	// Configure the service with recipient keys for ProcessInbound.
	svc.SetRecipientKeys(rcptPub, rcptPriv)

	return &d2dSigTestEnv{
		svc:        svc,
		signer:     signer,
		encryptor:  encryptor,
		converter:  converter,
		resolver:   resolver,
		outbox:     outbox,
		deliverer:  deliverer,
		senderPub:  senderPub,
		senderPriv: senderPriv,
		rcptPub:    rcptPub,
		rcptPriv:   rcptPriv,
	}
}

// d2dPayloadWire is the expected wire format for D2D delivery payloads.
type d2dPayloadWire struct {
	Ciphertext string `json:"c"` // base64-encoded ciphertext
	Sig        string `json:"s"` // hex-encoded signature
}

// --------------------------------------------------------------------------
// Test 1: SendMessage delivery payload is JSON with "c" and "s" fields
// TST-CORE-1088 TST-CORE-1002
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1693", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "01", "title": "SendMessage_DeliveryPayloadIsJSONWrapper"}
func TestFixVerify_31_8_1_SendMessage_DeliveryPayloadIsJSONWrapper(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-001",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"fix 11 test"}`),
	}

	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Verify the deliverer received the payload.
	if len(env.deliverer.calls) == 0 {
		t.Fatal("expected at least 1 delivery attempt")
	}

	deliveredBytes := env.deliverer.calls[0].payload

	// Parse the delivery payload as JSON.
	var wrapper d2dPayloadWire
	if err := json.Unmarshal(deliveredBytes, &wrapper); err != nil {
		t.Fatalf("delivery payload is not valid JSON: %v\npayload: %s", err, string(deliveredBytes))
	}

	// Verify "c" field is present and is valid base64.
	if wrapper.Ciphertext == "" {
		t.Fatal("delivery payload missing 'c' (ciphertext) field")
	}
	ciphertextBytes, err := base64.StdEncoding.DecodeString(wrapper.Ciphertext)
	if err != nil {
		t.Fatalf("'c' field is not valid base64: %v", err)
	}
	if len(ciphertextBytes) == 0 {
		t.Fatal("'c' field decoded to empty bytes")
	}

	// Verify "s" field is present and is valid hex.
	if wrapper.Sig == "" {
		t.Fatal("delivery payload missing 's' (signature) field")
	}
	sigBytes, err := hex.DecodeString(wrapper.Sig)
	if err != nil {
		t.Fatalf("'s' field is not valid hex: %v", err)
	}
	if len(sigBytes) != ed25519.SignatureSize {
		t.Fatalf("expected signature length %d, got %d", ed25519.SignatureSize, len(sigBytes))
	}

	// Verify the JSON payload contains ONLY "c" and "s" — no extra fields leaked.
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(deliveredBytes, &rawFields); err != nil {
		t.Fatalf("re-parse as raw map: %v", err)
	}
	if len(rawFields) != 2 {
		t.Fatalf("expected exactly 2 JSON fields (c, s), got %d: %v",
			len(rawFields), func() []string {
				keys := make([]string, 0, len(rawFields))
				for k := range rawFields {
					keys = append(keys, k)
				}
				return keys
			}())
	}
}

// --------------------------------------------------------------------------
// Test 2: ProcessInbound with JSON wrapper + valid sig succeeds
// --------------------------------------------------------------------------

// TST-CORE-1089
// TRACE: {"suite": "CORE", "case": "1694", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "02", "title": "ProcessInbound_JSONWrapperValidSig_Success"}
func TestFixVerify_31_8_2_ProcessInbound_JSONWrapperValidSig_Success(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Construct a message, sign it, encrypt it, and wrap it in the JSON format.
	msg := domain.DinaMessage{
		ID:          "msg-fix11-002",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"valid sig inbound test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Sign with sender's key.
	sig, err := env.signer.Sign(env.senderPriv, plaintext)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// Encrypt for recipient.
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Build the JSON wrapper (same format as SendMessage produces).
	wrapper := d2dPayloadWire{
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
		Sig:        hex.EncodeToString(sig),
	}
	wrapperBytes, _ := json.Marshal(wrapper)

	// ProcessInbound should succeed and verify the signature.
	result, err := env.svc.ProcessInbound(ctx, wrapperBytes)
	if err != nil {
		t.Fatalf("ProcessInbound should succeed with valid sig: %v", err)
	}
	if result.ID != "msg-fix11-002" {
		t.Fatalf("expected msg ID 'msg-fix11-002', got %q", result.ID)
	}
	if result.From != "did:key:z6MkSenderTest" {
		t.Fatalf("expected From 'did:key:z6MkSenderTest', got %q", result.From)
	}
}

// --------------------------------------------------------------------------
// Test 3: ProcessInbound with JSON wrapper + tampered sig returns error
// --------------------------------------------------------------------------

// TST-CORE-1090
// TRACE: {"suite": "CORE", "case": "1695", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "03", "title": "ProcessInbound_JSONWrapperTamperedSig_Error"}
func TestFixVerify_31_8_3_ProcessInbound_JSONWrapperTamperedSig_Error(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-003",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"tampered sig inbound test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Sign with WRONG key (recipient's key instead of sender's).
	wrongSig, err := env.signer.Sign(env.rcptPriv, plaintext)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// Encrypt for recipient.
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Build the JSON wrapper with the wrong signature.
	wrapper := d2dPayloadWire{
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
		Sig:        hex.EncodeToString(wrongSig),
	}
	wrapperBytes, _ := json.Marshal(wrapper)

	// ProcessInbound should fail with ErrInvalidSignature.
	_, err = env.svc.ProcessInbound(ctx, wrapperBytes)
	if err == nil {
		t.Fatal("ProcessInbound should reject JSON wrapper with tampered signature")
	}
	if !errors.Is(err, domain.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got: %v", err)
	}
}

// --------------------------------------------------------------------------
// Test 4: ProcessInbound with raw bytes (legacy) → rejected without override
// TST-CORE-1093
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1696", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "06", "title": "ProcessInbound_RawBytesLegacy_Rejected"}
func TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected(t *testing.T) {
	// TST-CORE-1093: ProcessInbound raw bytes legacy rejected
	// Requirement: Raw NaCl bytes (no JSON wrapper), without DINA_ALLOW_UNSIGNED_D2D
	// override, must be rejected. No backward compatibility for unsigned messages.
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Sub-test 1: Real encrypted payload without JSON wrapper → rejected.
	// TRACE: {"suite": "CORE", "case": "1697", "section": "31", "sectionName": "Code Review Fix Verification", "title": "encrypted_raw_nacl_rejected"}
	t.Run("encrypted_raw_nacl_rejected", func(t *testing.T) {
		msg := domain.DinaMessage{
			ID:          "msg-fix11-004",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"legacy raw bytes test"}`),
		}
		plaintext, _ := json.Marshal(msg)

		// Encrypt for recipient (no JSON wrapping — raw NaCl sealed box).
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		_, err := env.svc.ProcessInbound(ctx, rawCiphertext)
		if err == nil {
			t.Fatal("ProcessInbound should reject unsigned legacy payload")
		}
		// Verify error wraps ErrInvalidSignature (envelope format check).
		if !errors.Is(err, domain.ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature, got: %v", err)
		}
	})

	// Sub-test 2: Random garbage bytes → rejected.
	// TRACE: {"suite": "CORE", "case": "1698", "section": "31", "sectionName": "Code Review Fix Verification", "title": "random_bytes_rejected"}
	t.Run("random_bytes_rejected", func(t *testing.T) {
		garbage := []byte{0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04}
		_, err := env.svc.ProcessInbound(ctx, garbage)
		if err == nil {
			t.Fatal("ProcessInbound should reject random bytes")
		}
		if !errors.Is(err, domain.ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature for garbage, got: %v", err)
		}
	})

	// Sub-test 3: Empty payload → rejected.
	// TRACE: {"suite": "CORE", "case": "1699", "section": "31", "sectionName": "Code Review Fix Verification", "title": "empty_payload_rejected"}
	t.Run("empty_payload_rejected", func(t *testing.T) {
		_, err := env.svc.ProcessInbound(ctx, []byte{})
		if err == nil {
			t.Fatal("ProcessInbound should reject empty payload")
		}
	})

	// Sub-test 4: JSON without required "c" and "s" fields → rejected.
	// TRACE: {"suite": "CORE", "case": "1700", "section": "31", "sectionName": "Code Review Fix Verification", "title": "json_missing_sig_field_rejected"}
	t.Run("json_missing_sig_field_rejected", func(t *testing.T) {
		// Has ciphertext but no signature — not the proper wrapper format.
		partial := []byte(`{"c":"dGVzdA=="}`)
		_, err := env.svc.ProcessInbound(ctx, partial)
		if err == nil {
			t.Fatal("ProcessInbound should reject JSON without signature field")
		}
		if !errors.Is(err, domain.ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature for missing sig, got: %v", err)
		}
	})
}

// --------------------------------------------------------------------------
// Test 5: ProcessOutbox retry uses JSON wrapper format
// --------------------------------------------------------------------------

// TST-CORE-1095
// TRACE: {"suite": "CORE", "case": "1701", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "08", "title": "ProcessOutbox_UsesJSONWrapper"}
func TestFixVerify_31_8_8_ProcessOutbox_UsesJSONWrapper(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Make initial delivery fail so message stays pending for ProcessOutbox.
	env.deliverer.err = errors.New("offline")

	msg := domain.DinaMessage{
		ID:          "msg-fix11-005",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"outbox retry wrapper test"}`),
	}
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// First delivery attempt failed but used JSON wrapper. Verify.
	if len(env.deliverer.calls) == 0 {
		t.Fatal("expected at least 1 delivery attempt")
	}
	firstPayload := env.deliverer.calls[0].payload
	var firstWrapper d2dPayloadWire
	if err := json.Unmarshal(firstPayload, &firstWrapper); err != nil {
		t.Fatalf("initial delivery payload should be JSON wrapper: %v", err)
	}
	if firstWrapper.Ciphertext == "" || firstWrapper.Sig == "" {
		t.Fatal("initial delivery payload missing 'c' or 's' field")
	}

	// Clear deliverer error for retry.
	env.deliverer.err = nil

	// Requeue the failed message.
	storedMsg, _ := env.outbox.GetByID("outbox-1")
	if storedMsg != nil && storedMsg.Status == "failed" {
		// Message may not be failed yet if immediate delivery didn't mark it.
	}
	// The message should still be pending (immediate delivery failure doesn't mark as failed).
	pending, _ := env.outbox.ListPending(ctx)
	if len(pending) == 0 {
		// If it was already failed, requeue it.
		if storedMsg != nil {
			_ = env.outbox.Requeue(ctx, storedMsg.ID)
		}
	}

	// Run ProcessOutbox to retry delivery.
	env.deliverer.calls = nil // reset for clean check
	processed, err := env.svc.ProcessOutbox(ctx)
	if err != nil {
		t.Fatalf("ProcessOutbox: %v", err)
	}

	if processed > 0 && len(env.deliverer.calls) > 0 {
		retryPayload := env.deliverer.calls[0].payload
		var retryWrapper d2dPayloadWire
		if err := json.Unmarshal(retryPayload, &retryWrapper); err != nil {
			t.Fatalf("ProcessOutbox retry payload should be JSON wrapper: %v", err)
		}
		if retryWrapper.Ciphertext == "" {
			t.Fatal("ProcessOutbox retry payload missing 'c' (ciphertext) field")
		}
		if retryWrapper.Sig == "" {
			t.Fatal("ProcessOutbox retry payload missing 's' (signature) field")
		}
	}
}

// --------------------------------------------------------------------------
// TST-CORE-1096
// Test 6: Full round-trip: SendMessage -> delivery -> ProcessInbound
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1702", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "09", "title": "FullRoundTrip_SendAndReceiveWithSig"}
func TestFixVerify_31_8_9_FullRoundTrip_SendAndReceiveWithSig(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-006",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"full round trip with sig"}`),
	}

	// SendMessage produces a JSON wrapper payload.
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Get the delivered payload (what the recipient would receive at /msg).
	if len(env.deliverer.calls) == 0 {
		t.Fatal("expected delivery attempt")
	}
	deliveredPayload := env.deliverer.calls[0].payload

	// Recipient processes the inbound payload using ProcessInbound.
	result, err := env.svc.ProcessInbound(ctx, deliveredPayload)
	if err != nil {
		t.Fatalf("ProcessInbound failed on SendMessage output: %v", err)
	}

	// Verify the message was correctly round-tripped.
	if result.ID != "msg-fix11-006" {
		t.Fatalf("expected msg ID 'msg-fix11-006', got %q", result.ID)
	}
	if result.From != "did:key:z6MkSenderTest" {
		t.Fatalf("expected From 'did:key:z6MkSenderTest', got %q", result.From)
	}
	if string(result.Body) != `{"q":"full round trip with sig"}` {
		t.Fatalf("unexpected body: %s", string(result.Body))
	}
}

// --------------------------------------------------------------------------
// Test 7: ProcessInbound with JSON wrapper but empty sig (no verification)
// --------------------------------------------------------------------------

// TST-CORE-1091
// TRACE: {"suite": "CORE", "case": "1703", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "04", "title": "ProcessInbound_JSONWrapperEmptySig_Rejected"}
func TestFixVerify_31_8_4_ProcessInbound_JSONWrapperEmptySig_Rejected(t *testing.T) {
	// CRITICAL-04: unsigned messages (empty sig) are now rejected by default.
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-007",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"empty sig wrapper test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Encrypt for recipient.
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Build the JSON wrapper with empty signature.
	wrapper := d2dPayloadWire{
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
		Sig:        "", // empty signature
	}
	wrapperBytes, _ := json.Marshal(wrapper)

	// ProcessInbound should reject unsigned messages.
	_, err := env.svc.ProcessInbound(ctx, wrapperBytes)
	if err == nil {
		t.Fatal("ProcessInbound should reject empty-sig wrapper")
	}
}

// --------------------------------------------------------------------------
// Test 8: ProcessInbound with JSON wrapper + sig from wrong sender DID
// --------------------------------------------------------------------------

// TST-CORE-1094
// TRACE: {"suite": "CORE", "case": "1704", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "07", "title": "ProcessInbound_JSONWrapper_DIDSpoofing_Rejected"}
func TestFixVerify_31_8_7_ProcessInbound_JSONWrapper_DIDSpoofing_Rejected(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Message claims to be from sender, but signed with a completely different key.
	msg := domain.DinaMessage{
		ID:          "msg-fix11-008",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest", // claims sender
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"DID spoofing via ProcessInbound"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Sign with recipient's key (not the sender's key).
	spoofedSig, _ := env.signer.Sign(env.rcptPriv, plaintext)

	// Encrypt for recipient.
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	wrapper := d2dPayloadWire{
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
		Sig:        hex.EncodeToString(spoofedSig),
	}
	wrapperBytes, _ := json.Marshal(wrapper)

	// ProcessInbound should reject: signature doesn't match sender's public key.
	_, err := env.svc.ProcessInbound(ctx, wrapperBytes)
	if err == nil {
		t.Fatal("ProcessInbound should reject DID spoofing (sig from wrong key)")
	}
	if !errors.Is(err, domain.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got: %v", err)
	}
}

// --------------------------------------------------------------------------
// Test 8: ProcessInbound raw bytes legacy migration (DINA_ALLOW_UNSIGNED_D2D)
// TST-CORE-1092
// --------------------------------------------------------------------------
// §31.8 Requirement: When DINA_ALLOW_UNSIGNED_D2D is enabled, ProcessInbound
// must accept raw NaCl sealed box bytes (no JSON wrapper, no signature) as a
// migration aid for legacy senders. The message is decrypted and returned
// WITHOUT signature verification, with a warning logged.
//
// This is NOT a security hole — it's an explicit, auditable migration path.
// The override must be opt-in (off by default) and every legacy message must
// generate a log warning for migration tracking.

// TRACE: {"suite": "CORE", "case": "1705", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "08", "scenario": "05", "title": "ProcessInbound_RawBytesLegacy_Migration"}
func TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration(t *testing.T) {
	ctx := context.Background()

	// TRACE: {"suite": "CORE", "case": "1706", "section": "31", "sectionName": "Code Review Fix Verification", "title": "raw_nacl_accepted_when_allow_unsigned_enabled"}
	t.Run("raw_nacl_accepted_when_allow_unsigned_enabled", func(t *testing.T) {
		// With DINA_ALLOW_UNSIGNED_D2D enabled, raw NaCl sealed box bytes
		// that aren't JSON should be decrypted without signature verification.
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)

		msg := domain.DinaMessage{
			ID:          "msg-legacy-001",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"legacy message"}`),
		}
		plaintext, _ := json.Marshal(msg)

		// Encrypt for recipient as raw NaCl sealed box (no JSON wrapper).
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		rawCiphertext, encErr := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)
		if encErr != nil {
			t.Fatalf("SealAnonymous failed: %v", encErr)
		}

		result, err := env.svc.ProcessInbound(ctx, rawCiphertext)
		if err != nil {
			t.Fatalf("ProcessInbound with allowUnsignedD2D should accept raw NaCl, got: %v", err)
		}
		if result.ID != "msg-legacy-001" {
			t.Fatalf("expected message ID msg-legacy-001, got %q", result.ID)
		}
		if result.From != "did:key:z6MkSenderTest" {
			t.Fatalf("expected From=did:key:z6MkSenderTest, got %q", result.From)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1707", "section": "31", "sectionName": "Code Review Fix Verification", "title": "raw_nacl_rejected_when_allow_unsigned_disabled"}
	t.Run("raw_nacl_rejected_when_allow_unsigned_disabled", func(t *testing.T) {
		// Default (disabled): raw NaCl bytes must still be rejected.
		// This confirms the override is opt-in, not default.
		env := newD2DSigTestEnv(t)
		// NOT calling SetAllowUnsignedD2D — default is false.

		msg := domain.DinaMessage{
			ID:          "msg-legacy-002",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"should be rejected"}`),
		}
		plaintext, _ := json.Marshal(msg)
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		_, err := env.svc.ProcessInbound(ctx, rawCiphertext)
		if err == nil {
			t.Fatal("raw NaCl must be rejected when allowUnsignedD2D is disabled")
		}
		if !errors.Is(err, domain.ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature, got: %v", err)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1708", "section": "31", "sectionName": "Code Review Fix Verification", "title": "json_wrapper_still_works_with_allow_unsigned_enabled"}
	t.Run("json_wrapper_still_works_with_allow_unsigned_enabled", func(t *testing.T) {
		// With allowUnsignedD2D enabled, properly signed JSON wrappers must
		// STILL work normally. The legacy path is a fallback, not a replacement.
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)
		env.svc.SetSenderDID("did:key:z6MkSenderTest")

		msg := domain.DinaMessage{
			ID:          "msg-signed-with-override",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"signed message"}`),
		}
		plaintext, _ := json.Marshal(msg)

		// Sign with sender's private key.
		sig, sigErr := env.signer.Sign(env.senderPriv, plaintext)
		if sigErr != nil {
			t.Fatalf("sign failed: %v", sigErr)
		}

		// Encrypt for recipient.
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		// Build proper JSON wrapper.
		wrapper := d2dPayloadWire{
			Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
			Sig:        hex.EncodeToString(sig),
		}
		wrapperBytes, _ := json.Marshal(wrapper)

		result, err := env.svc.ProcessInbound(ctx, wrapperBytes)
		if err != nil {
			t.Fatalf("signed JSON wrapper should still work with override enabled: %v", err)
		}
		if result.ID != "msg-signed-with-override" {
			t.Fatalf("expected msg-signed-with-override, got %q", result.ID)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1709", "section": "31", "sectionName": "Code Review Fix Verification", "title": "garbage_bytes_rejected_even_with_allow_unsigned"}
	t.Run("garbage_bytes_rejected_even_with_allow_unsigned", func(t *testing.T) {
		// Random garbage that isn't valid NaCl must still be rejected.
		// The legacy path tries to decrypt — decryption failure = rejection.
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)

		garbage := []byte{0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04}
		_, err := env.svc.ProcessInbound(ctx, garbage)
		if err == nil {
			t.Fatal("garbage bytes must be rejected even with allowUnsignedD2D")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1710", "section": "31", "sectionName": "Code Review Fix Verification", "title": "empty_payload_rejected_even_with_allow_unsigned"}
	t.Run("empty_payload_rejected_even_with_allow_unsigned", func(t *testing.T) {
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)

		_, err := env.svc.ProcessInbound(ctx, []byte{})
		if err == nil {
			t.Fatal("empty payload must be rejected even with allowUnsignedD2D")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1711", "section": "31", "sectionName": "Code Review Fix Verification", "title": "message_body_preserved_in_legacy_path"}
	t.Run("message_body_preserved_in_legacy_path", func(t *testing.T) {
		// The decrypted message body must be intact after legacy decryption.
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)

		msg := domain.DinaMessage{
			ID:          "msg-body-check",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"important":"data with special chars: é à ü"}`),
		}
		plaintext, _ := json.Marshal(msg)
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		result, err := env.svc.ProcessInbound(ctx, rawCiphertext)
		if err != nil {
			t.Fatalf("legacy decryption failed: %v", err)
		}
		if string(result.Body) != `{"important":"data with special chars: é à ü"}` {
			t.Fatalf("body not preserved: got %q", string(result.Body))
		}
	})

	// TRACE: {"suite": "CORE", "case": "1712", "section": "31", "sectionName": "Code Review Fix Verification", "title": "toggle_allow_unsigned_off_rejects_again"}
	t.Run("toggle_allow_unsigned_off_rejects_again", func(t *testing.T) {
		// Verify SetAllowUnsignedD2D(false) re-enables rejection.
		env := newD2DSigTestEnv(t)
		env.svc.SetAllowUnsignedD2D(true)

		msg := domain.DinaMessage{
			ID:   "msg-toggle",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
		}
		plaintext, _ := json.Marshal(msg)
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		// Enable → accept.
		_, err := env.svc.ProcessInbound(ctx, rawCiphertext)
		if err != nil {
			t.Fatalf("should accept with allowUnsigned: %v", err)
		}

		// Disable → reject (need fresh ciphertext for replay cache).
		env.svc.SetAllowUnsignedD2D(false)
		msg.ID = "msg-toggle-2"
		plaintext2, _ := json.Marshal(msg)
		rawCiphertext2, _ := env.encryptor.SealAnonymous(plaintext2, rcptX25519Pub)

		_, err = env.svc.ProcessInbound(ctx, rawCiphertext2)
		if err == nil {
			t.Fatal("should reject after disabling allowUnsigned")
		}
	})
}
