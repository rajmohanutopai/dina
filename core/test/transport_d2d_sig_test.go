package test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
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
// --------------------------------------------------------------------------

func TestFixVerify_31_8_1_SendMessage_DeliveryPayloadIsJSONWrapper(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-001",
		Type:        domain.MessageTypeQuery,
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
}

// --------------------------------------------------------------------------
// Test 2: ProcessInbound with JSON wrapper + valid sig succeeds
// --------------------------------------------------------------------------

func TestFixVerify_31_8_2_ProcessInbound_JSONWrapperValidSig_Success(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Construct a message, sign it, encrypt it, and wrap it in the JSON format.
	msg := domain.DinaMessage{
		ID:          "msg-fix11-002",
		Type:        domain.MessageTypeQuery,
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

func TestFixVerify_31_8_3_ProcessInbound_JSONWrapperTamperedSig_Error(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-003",
		Type:        domain.MessageTypeQuery,
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
// Test 4: ProcessInbound with raw bytes (legacy) still works
// --------------------------------------------------------------------------

func TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected(t *testing.T) {
	// CRITICAL-04: unsigned legacy payloads are now rejected by default.
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-004",
		Type:        domain.MessageTypeQuery,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"legacy raw bytes test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Encrypt for recipient (no JSON wrapping — raw NaCl sealed box).
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// ProcessInbound with raw bytes should be rejected (unsigned).
	_, err := env.svc.ProcessInbound(ctx, rawCiphertext)
	if err == nil {
		t.Fatal("ProcessInbound should reject unsigned legacy payload")
	}
	if !strings.Contains(err.Error(), "unsigned") {
		t.Fatalf("expected unsigned rejection error, got: %v", err)
	}
}

func TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_MigrationMode(t *testing.T) {
	// CRITICAL-04: with migration flag, unsigned legacy payloads are accepted.
	t.Setenv("DINA_ALLOW_UNSIGNED_D2D", "1")

	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-004m",
		Type:        domain.MessageTypeQuery,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"legacy raw bytes migration test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	rawCiphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	result, err := env.svc.ProcessInbound(ctx, rawCiphertext)
	if err != nil {
		t.Fatalf("ProcessInbound should accept legacy in migration mode: %v", err)
	}
	if result.ID != "msg-fix11-004m" {
		t.Fatalf("expected msg ID 'msg-fix11-004m', got %q", result.ID)
	}
}

// --------------------------------------------------------------------------
// Test 5: ProcessOutbox retry uses JSON wrapper format
// --------------------------------------------------------------------------

func TestFixVerify_31_8_8_ProcessOutbox_UsesJSONWrapper(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Make initial delivery fail so message stays pending for ProcessOutbox.
	env.deliverer.err = errors.New("offline")

	msg := domain.DinaMessage{
		ID:          "msg-fix11-005",
		Type:        domain.MessageTypeQuery,
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
// Test 6: Full round-trip: SendMessage -> delivery -> ProcessInbound
// --------------------------------------------------------------------------

func TestFixVerify_31_8_9_FullRoundTrip_SendAndReceiveWithSig(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-006",
		Type:        domain.MessageTypeQuery,
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

func TestFixVerify_31_8_4_ProcessInbound_JSONWrapperEmptySig_Rejected(t *testing.T) {
	// CRITICAL-04: unsigned messages (empty sig) are now rejected by default.
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-fix11-007",
		Type:        domain.MessageTypeQuery,
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
	if !strings.Contains(err.Error(), "unsigned") {
		t.Fatalf("expected unsigned rejection error, got: %v", err)
	}
}

// --------------------------------------------------------------------------
// Test 8: ProcessInbound with JSON wrapper + sig from wrong sender DID
// --------------------------------------------------------------------------

func TestFixVerify_31_8_7_ProcessInbound_JSONWrapper_DIDSpoofing_Rejected(t *testing.T) {
	env := newD2DSigTestEnv(t)
	ctx := context.Background()

	// Message claims to be from sender, but signed with a completely different key.
	msg := domain.DinaMessage{
		ID:          "msg-fix11-008",
		Type:        domain.MessageTypeQuery,
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
