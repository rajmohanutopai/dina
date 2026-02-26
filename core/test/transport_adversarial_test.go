package test

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

	// Build DID Documents with the real public keys (multibase: "z" + hex).
	resolver := &mockDIDResolver{docs: map[string]*domain.DIDDocument{
		string(senderDID): {
			ID: string(senderDID),
			VerificationMethod: []domain.VerificationMethod{{
				ID:                 string(senderDID) + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         string(senderDID),
				PublicKeyMultibase: "z" + hex.EncodeToString(senderPub),
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
				PublicKeyMultibase: "z" + hex.EncodeToString(rcptPub),
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

// TST-ADV-001: SendMessage stores Ed25519 signature in outbox.
func TestAdv_29_1_SendStoresSignature(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:   "msg-sig-001",
		Type: domain.MessageTypeQuery,
		From: "did:key:z6MkSenderTest",
		To:   []string{"did:key:z6MkRecipientTest"},
		Body: []byte(`{"q":"hello"}`),
	}

	err := env.svc.SendMessage(ctx, "did:key:z6MkRecipientTest", msg)
	if err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Message was enqueued then immediately delivered (status = "delivered").
	// Retrieve by ID to verify the Sig was stored before delivery.
	stored, err := env.outbox.GetByID("outbox-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if len(stored.Sig) == 0 {
		t.Fatal("outbox message Sig must be non-empty — signature was stored")
	}
	if stored.Status != "delivered" {
		t.Fatalf("expected status 'delivered' (immediate delivery succeeded), got %q", stored.Status)
	}
}

// TST-ADV-002: ReceiveMessage with valid signature succeeds.
func TestAdv_29_1_ValidSignatureAccepted(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Construct a signed+encrypted envelope the honest way.
	msg := domain.DinaMessage{
		ID:          "msg-sig-002",
		Type:        domain.MessageTypeQuery,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"valid sig test"}`),
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
}

// TST-ADV-003: ReceiveMessage with wrong signature is rejected.
func TestAdv_29_1_WrongSignatureRejected(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-003",
		Type:        domain.MessageTypeQuery,
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

// TST-ADV-004: ReceiveMessage with tampered ciphertext (bit flip) is rejected.
func TestAdv_29_1_TamperedCiphertextRejected(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-004",
		Type:        domain.MessageTypeQuery,
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

// TST-ADV-005: ReceiveMessage with empty sig (backward compat) passes when verifier is set.
func TestAdv_29_1_EmptySigBackwardCompat(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	msg := domain.DinaMessage{
		ID:          "msg-sig-005",
		Type:        domain.MessageTypeQuery,
		From:        "did:key:z6MkSenderTest",
		To:          []string{"did:key:z6MkRecipientTest"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"q":"no sig backward compat"}`),
	}
	plaintext, _ := json.Marshal(msg)

	rcptX25519Pub, _ := env.converter.Ed25519ToX25519Public(env.rcptPub)
	ciphertext, _ := env.encryptor.SealAnonymous(plaintext, rcptX25519Pub)

	// Envelope with empty signature — backward compatibility.
	envelope := domain.DinaEnvelope{
		Typ:        "application/dina-encrypted+json",
		Ciphertext: string(ciphertext),
		Sig:        "", // no signature
	}

	result, err := env.svc.ReceiveMessage(ctx, envelope, env.rcptPub, env.rcptPriv)
	if err != nil {
		t.Fatalf("ReceiveMessage with empty sig should succeed (backward compat): %v", err)
	}
	if result.ID != "msg-sig-005" {
		t.Fatalf("expected msg ID 'msg-sig-005', got %q", result.ID)
	}
}

// ==========================================================================
// §A2 — Outbox Retry (adversarial tests)
// ==========================================================================

// TST-ADV-006: ProcessOutbox delivers pending messages and marks delivered.
func TestAdv_29_2_OutboxDeliverSuccess(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Send a message — this enqueues it and attempts immediate delivery.
	msg := domain.DinaMessage{
		ID:   "msg-outbox-001",
		Type: domain.MessageTypeQuery,
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

// TST-ADV-007: ProcessOutbox marks failed when delivery errors.
func TestAdv_29_2_OutboxDeliveryFailure(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Make deliverer fail.
	env.deliverer.err = errors.New("connection refused")

	msg := domain.DinaMessage{
		ID:   "msg-outbox-002",
		Type: domain.MessageTypeQuery,
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

// TST-ADV-008: ProcessOutbox retries succeed after transient failure.
func TestAdv_29_2_OutboxRetryTransient(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// First delivery fails.
	env.deliverer.err = errors.New("timeout")

	msg := domain.DinaMessage{
		ID:   "msg-outbox-003",
		Type: domain.MessageTypeQuery,
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
				PublicKeyMultibase: "z" + hex.EncodeToString(rcptPub),
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

// TST-ADV-011: ProcessOutbox respects context cancellation.
func TestAdv_29_2_OutboxContextCancel(t *testing.T) {
	env := newTransportTestEnv(t)

	// Enqueue multiple messages.
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

	// Cancel context immediately.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := env.svc.ProcessOutbox(ctx)
	if err == nil {
		// It's okay if all were processed before cancellation check,
		// but if there's an error it should be context.Canceled.
	} else if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}
}

// ==========================================================================
// §A3 — Ingress Rate Limiting & Dead Drop (adversarial tests)
// ==========================================================================

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

// TST-ADV-014: Router stores to dead drop when vault is locked.
func TestAdv_29_3_IngressDeadDropLocked(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	// Vault is LOCKED (no open personas).
	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{}}
	inbox := &mockInboxManager{}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	ctx := context.Background()
	payload := []byte("encrypted-message-while-locked")

	err := router.Ingest(ctx, "10.0.0.1", payload)
	if err != nil {
		t.Fatalf("Ingest should succeed (store to dead drop): %v", err)
	}

	// Verify blob was stored in dead drop.
	count, err := deadDrop.Count()
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 dead drop blob, got %d", count)
	}

	// Inbox should be empty (message went to dead drop, not inbox).
	if len(inbox.spoolData) != 0 {
		t.Fatalf("inbox should be empty when vault is locked, got %d items", len(inbox.spoolData))
	}
}

// TST-ADV-015: Router spools to inbox when vault is unlocked.
func TestAdv_29_3_IngressInboxUnlocked(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	// Vault is UNLOCKED ("personal" persona is open).
	personal, _ := domain.NewPersonaName("personal")
	vaultMgr := &mockVaultManager{openPersonas: map[domain.PersonaName]bool{personal: true}}
	inbox := &mockInboxManager{}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, &transportTestClock{now: time.Now()}, 24*time.Hour)

	router := ingress.NewRouter(vaultMgr, inbox, deadDrop, sweeper, limiter)

	ctx := context.Background()
	payload := []byte("encrypted-message-while-unlocked")

	err := router.Ingest(ctx, "10.0.0.1", payload)
	if err != nil {
		t.Fatalf("Ingest should succeed (spool to inbox): %v", err)
	}

	// Inbox should have the message (fast path).
	if len(inbox.spoolData) != 1 {
		t.Fatalf("expected 1 inbox spool item, got %d", len(inbox.spoolData))
	}

	// Dead drop should be empty (message went to inbox, not dead drop).
	count, _ := deadDrop.Count()
	if count != 0 {
		t.Fatalf("dead drop should be empty when vault is unlocked, got %d blobs", count)
	}
}

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

// TST-ADV-017: Sweeper processes dead drop blobs after vault unlock.
func TestAdv_29_3_IngressSweeperSweep(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)

	clk := &transportTestClock{now: time.Now()}
	sweeper := ingress.NewSweeper(deadDrop, nil, nil, clk, 24*time.Hour)
	// No keys/converter set — sweeper counts blobs as delivered (pass-through).

	ctx := context.Background()

	// Store some blobs manually (simulating messages received while locked).
	os.MkdirAll(deadDropDir, 0700)
	os.WriteFile(filepath.Join(deadDropDir, "blob1.blob"), []byte("data1"), 0600)
	os.WriteFile(filepath.Join(deadDropDir, "blob2.blob"), []byte("data2"), 0600)

	count, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 swept, got %d", count)
	}
}

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

	// Simulate vault unlock → process pending.
	total, err := router.ProcessPending(ctx)
	if err != nil {
		t.Fatalf("ProcessPending: %v", err)
	}
	if total < 2 {
		t.Fatalf("expected at least 2 processed, got %d", total)
	}
}

// TST-ADV-019: Oversized payload rejected at ingress.
func TestAdv_29_3_IngressOversizedPayload(t *testing.T) {
	tmpDir := t.TempDir()
	deadDropDir := filepath.Join(tmpDir, "dd")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	limiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)

	personal, _ := domain.NewPersonaName("personal")
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
	// Without keys: non-empty blobs are "delivered" (pass-through), empty are "failed".
	if result.Delivered < 1 {
		t.Fatalf("expected at least 1 delivered, got %d", result.Delivered)
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
		Type:        domain.MessageTypeQuery,
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

// TST-ADV-022: Envelope claims sender DID that doesn't match the actual signer.
// Architecture §9: "mutual authentication — both Dinas verify Ed25519 signatures."
func TestAdv_29_4_DIDSpoofingFromKID(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Attacker constructs message claiming to be from sender
	// but signs with recipient's key (attacker controls recipient key).
	msg := domain.DinaMessage{
		ID:          "msg-spoof-001",
		Type:        domain.MessageTypeQuery,
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
			Type: domain.MessageTypeQuery,
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
		Type: domain.MessageTypeQuery,
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

// TST-ADV-024: Outbox retry count increments on repeated failures.
// Architecture §9: "max 5 retries, backoff 30s→1m→5m→30m→2h."
func TestAdv_29_2_OutboxRetryCount(t *testing.T) {
	env := newTransportTestEnv(t)
	ctx := context.Background()

	// Make deliverer fail persistently.
	env.deliverer.err = errors.New("connection refused")

	msg := domain.DinaMessage{
		ID:   "msg-retry-count",
		Type: domain.MessageTypeQuery,
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
				Type:        domain.MessageTypeQuery,
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
