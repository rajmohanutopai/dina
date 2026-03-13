package handler

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mr-tron/base58"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// ---------------------------------------------------------------------------
// Stubs that satisfy the port interfaces needed by TransportService
// ---------------------------------------------------------------------------

// stubEncryptor passes through plaintext unchanged (no real crypto).
type stubEncryptor struct{}

func (s *stubEncryptor) SealAnonymous(plaintext, recipientPub []byte) ([]byte, error) {
	return plaintext, nil
}
func (s *stubEncryptor) OpenAnonymous(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error) {
	return ciphertext, nil
}

var _ port.Encryptor = (*stubEncryptor)(nil)

// stubIdentitySigner returns a zero signature and a dummy public key.
type stubIdentitySigner struct{}

func (s *stubIdentitySigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return make([]byte, 64), nil
}
func (s *stubIdentitySigner) PublicKey() ed25519.PublicKey {
	return make(ed25519.PublicKey, 32)
}

var _ port.IdentitySigner = (*stubIdentitySigner)(nil)

// stubKeyConverter returns zero-filled keys.
type stubKeyConverter struct{}

func (s *stubKeyConverter) Ed25519ToX25519Public(pub []byte) ([]byte, error) {
	return make([]byte, 32), nil
}
func (s *stubKeyConverter) Ed25519ToX25519Private(priv []byte) ([]byte, error) {
	return make([]byte, 32), nil
}

var _ port.KeyConverter = (*stubKeyConverter)(nil)

// stubDIDResolver returns an empty DID document.
type stubDIDResolver struct{}

func (s *stubDIDResolver) Resolve(_ context.Context, did domain.DID) (*domain.DIDDocument, error) {
	id := string(did)
	return &domain.DIDDocument{
		ID: id,
		VerificationMethod: []domain.VerificationMethod{
			{
				ID:                 id + "#key-1",
				Type:               "Ed25519VerificationKey2020",
				Controller:         id,
				PublicKeyMultibase: testSenderMultibase,
			},
		},
	}, nil
}
func (s *stubDIDResolver) InvalidateCache(_ domain.DID) {}

var _ port.DIDResolver = (*stubDIDResolver)(nil)

// stubOutboxManager does nothing.
type stubOutboxManager struct{}

func (s *stubOutboxManager) Enqueue(_ context.Context, _ domain.OutboxMessage) (string, error) {
	return "id", nil
}
func (s *stubOutboxManager) MarkDelivered(_ context.Context, _ string) error { return nil }
func (s *stubOutboxManager) MarkFailed(_ context.Context, _ string) error    { return nil }
func (s *stubOutboxManager) Requeue(_ context.Context, _ string) error       { return nil }
func (s *stubOutboxManager) PendingCount(_ context.Context) (int, error)     { return 0, nil }
func (s *stubOutboxManager) ListPending(_ context.Context) ([]domain.OutboxMessage, error) {
	return nil, nil
}

var _ port.OutboxManager = (*stubOutboxManager)(nil)

// stubInboxManager tracks spool calls.
type stubInboxManager struct {
	spoolCount int
}

func (s *stubInboxManager) CheckIPRate(_ string) bool      { return true }
func (s *stubInboxManager) CheckGlobalRate() bool          { return true }
func (s *stubInboxManager) CheckPayloadSize(_ []byte) bool { return true }
func (s *stubInboxManager) Spool(_ context.Context, _ []byte) (string, error) {
	s.spoolCount++
	return "spool-id", nil
}
func (s *stubInboxManager) SpoolSize() (int64, error)                      { return 0, nil }
func (s *stubInboxManager) ProcessSpool(_ context.Context) (int, error)    { return 0, nil }
func (s *stubInboxManager) DrainSpool(_ context.Context) ([][]byte, error) { return nil, nil }

var _ port.InboxManager = (*stubInboxManager)(nil)

// stubClock returns the current time.
type stubClock struct{}

func (s *stubClock) Now() time.Time                         { return time.Now() }
func (s *stubClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (s *stubClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

var _ port.Clock = (*stubClock)(nil)

// stubVerifier accepts all signatures. Used to isolate handler tests from crypto internals.
type stubVerifier struct{}

func (s *stubVerifier) GenerateFromSeed(_ []byte) ([]byte, []byte, error) {
	return make([]byte, 32), make([]byte, 64), nil
}
func (s *stubVerifier) Sign(_ []byte, _ []byte) ([]byte, error) {
	return make([]byte, 64), nil
}
func (s *stubVerifier) Verify(_ []byte, _ []byte, _ []byte) (bool, error) {
	return true, nil
}

var _ port.Signer = (*stubVerifier)(nil)

// mockVaultManager controls the vault open/closed state for testing.
type mockVaultManager struct {
	open bool
}

func (m *mockVaultManager) Open(_ context.Context, _ domain.PersonaName, _ []byte) error { return nil }
func (m *mockVaultManager) Close(_ domain.PersonaName) error                             { return nil }
func (m *mockVaultManager) IsOpen(_ domain.PersonaName) bool                             { return m.open }
func (m *mockVaultManager) OpenPersonas() []domain.PersonaName                           { return nil }
func (m *mockVaultManager) Checkpoint(_ domain.PersonaName) error                        { return nil }

var _ port.VaultManager = (*mockVaultManager)(nil)

// ---------------------------------------------------------------------------
// Helper: build a minimal TransportService with all stubs
// ---------------------------------------------------------------------------

func newTestTransportService(inbox *stubInboxManager) *service.TransportService {
	ts := service.NewTransportService(
		&stubEncryptor{},
		&stubIdentitySigner{},
		&stubKeyConverter{},
		&stubDIDResolver{},
		&stubOutboxManager{},
		inbox,
		&stubClock{},
	)
	// Set recipient keys so ProcessInbound _could_ work if called.
	ts.SetRecipientKeys(make([]byte, 32), make([]byte, 64))
	ts.SetVerifier(&stubVerifier{})
	return ts
}

var (
	testSenderMultibase = func() string {
		key := append([]byte{0xed, 0x01}, make([]byte, 32)...)
		return "z" + base58.Encode(key)
	}()
	testSenderDID = "did:key:" + testSenderMultibase
)

func wrapEnvelope(t *testing.T, msg domain.DinaMessage) []byte {
	t.Helper()
	plain, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	env, err := json.Marshal(map[string]string{
		"c": base64.StdEncoding.EncodeToString(plain),
		"s": hex.EncodeToString(make([]byte, 64)),
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return env
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestHandleIngestNaCl_IngressRouter_NoDuplicate verifies that when the
// IngressRouter is wired, HandleIngestNaCl does NOT call
// ProcessInbound/StoreInbound on the TransportService. Before the fix,
// the handler called both IngressRouter.Ingest AND Transport.ProcessInbound,
// creating duplicate messages when the vault was unlocked.
func TestTransport_7_IngestNaClIngressRouterNoDuplicate(t *testing.T) {
	inbox := &stubInboxManager{}
	ts := newTestTransportService(inbox)

	// Build an IngressRouter with an unlocked vault so Ingest succeeds
	// via the fast path (spool).
	tmpDir := t.TempDir()
	dd := ingress.NewDeadDrop(tmpDir, 100, 10*1024*1024)
	limiter := ingress.NewRateLimiter(100, time.Minute, 1000, 500*1024*1024, dd)
	sweeper := ingress.NewSweeper(dd, &stubEncryptor{}, &stubDIDResolver{}, &stubClock{}, 24*time.Hour)
	vm := &mockVaultManager{open: true}
	router := ingress.NewRouter(vm, inbox, dd, sweeper, limiter)

	h := &MessageHandler{
		Transport:     ts,
		IngressRouter: router,
	}

	// Build a valid DinaMessage JSON. With the stub encryptor (passthrough),
	// if ProcessInbound were called it would succeed and store a message.
	msgJSON, _ := json.Marshal(domain.DinaMessage{
		Type: domain.MessageTypeQuery,
		To:   []string{"did:key:z6MkTest"},
		Body: []byte("hello"),
	})

	req := httptest.NewRequest(http.MethodPost, "/msg", bytes.NewReader(msgJSON))
	req.RemoteAddr = "127.0.0.1:12345"
	rec := httptest.NewRecorder()

	h.HandleIngestNaCl(rec, req)

	// Verify 202 Accepted.
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}

	// KEY ASSERTION: Transport.GetInbound() must be EMPTY.
	// Before the fix, this would contain one message from the duplicate
	// ProcessInbound+StoreInbound call.
	inbound := ts.GetInbound()
	if len(inbound) != 0 {
		t.Fatalf("expected 0 inbound messages (no duplicate), got %d", len(inbound))
	}

	// Verify the message was spooled via the IngressRouter's fast path.
	if inbox.spoolCount != 1 {
		t.Fatalf("expected 1 spool call via IngressRouter, got %d", inbox.spoolCount)
	}
}

// TestHandleIngestNaCl_NoIngressRouter_DirectPath verifies that without an
// IngressRouter, the fallback direct path still works (ProcessInbound is called).
func TestTransport_7_IngestNaClNoIngressRouterDirectPath(t *testing.T) {
	inbox := &stubInboxManager{}
	ts := newTestTransportService(inbox)

	h := &MessageHandler{
		Transport:     ts,
		IngressRouter: nil, // no ingress router
	}

	// Build a valid signed-envelope payload.
	env := wrapEnvelope(t, domain.DinaMessage{
		ID:   "msg-1",
		From: testSenderDID,
		Type: domain.MessageTypeQuery,
		To:   []string{"did:key:z6MkTest"},
		Body: []byte("hello"),
	})

	req := httptest.NewRequest(http.MethodPost, "/msg", bytes.NewReader(env))
	rec := httptest.NewRecorder()

	h.HandleIngestNaCl(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}

	// Without IngressRouter, the direct path should decrypt and store.
	inbound := ts.GetInbound()
	if len(inbound) != 1 {
		t.Fatalf("expected 1 inbound message via direct path, got %d", len(inbound))
	}
}

// TestHandleIngestNaCl_EmptyBody verifies that an empty body returns 400.
func TestTransport_7_IngestNaClEmptyBody(t *testing.T) {
	ts := newTestTransportService(&stubInboxManager{})
	h := &MessageHandler{Transport: ts}

	req := httptest.NewRequest(http.MethodPost, "/msg", bytes.NewReader(nil))
	rec := httptest.NewRecorder()

	h.HandleIngestNaCl(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty body, got %d", rec.Code)
	}
}

// TestHandleIngestNaCl_IngressRouter_LockedVault verifies that when the vault
// is locked, messages go to the dead drop (not the inbox spool) and there is
// no duplicate processing.
func TestTransport_7_IngestNaClIngressRouterLockedVault(t *testing.T) {
	inbox := &stubInboxManager{}
	ts := newTestTransportService(inbox)

	tmpDir := t.TempDir()
	dd := ingress.NewDeadDrop(tmpDir, 100, 10*1024*1024)
	limiter := ingress.NewRateLimiter(100, time.Minute, 1000, 500*1024*1024, dd)
	sweeper := ingress.NewSweeper(dd, &stubEncryptor{}, &stubDIDResolver{}, &stubClock{}, 24*time.Hour)
	vm := &mockVaultManager{open: false} // locked
	router := ingress.NewRouter(vm, inbox, dd, sweeper, limiter)

	h := &MessageHandler{
		Transport:     ts,
		IngressRouter: router,
	}

	body := []byte("encrypted-blob-data")
	req := httptest.NewRequest(http.MethodPost, "/msg", bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.1:9999"
	rec := httptest.NewRecorder()

	h.HandleIngestNaCl(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}

	// Message should be in dead drop, NOT in inbox spool.
	if inbox.spoolCount != 0 {
		t.Fatalf("expected 0 spool calls (vault locked), got %d", inbox.spoolCount)
	}

	// No duplicate via ProcessInbound.
	if len(ts.GetInbound()) != 0 {
		t.Fatalf("expected 0 inbound messages, got %d", len(ts.GetInbound()))
	}

	// Dead drop should have the blob.
	ddCount, err := dd.Count()
	if err != nil {
		t.Fatalf("dead drop count error: %v", err)
	}
	if ddCount != 1 {
		t.Fatalf("expected 1 dead drop blob, got %d", ddCount)
	}
}

// TestProcessPending_EmptySpoolAndDeadDrop verifies that ProcessPending
// returns zero and no error when both the dead drop and inbox spool are empty.
func TestTransport_7_ProcessPendingEmptySpoolAndDeadDrop(t *testing.T) {
	inbox := &stubInboxManager{}
	tmpDir := t.TempDir()
	dd := ingress.NewDeadDrop(tmpDir, 100, 10*1024*1024)
	limiter := ingress.NewRateLimiter(100, time.Minute, 1000, 500*1024*1024, dd)
	sweeper := ingress.NewSweeper(dd, &stubEncryptor{}, &stubDIDResolver{}, &stubClock{}, 24*time.Hour)
	vm := &mockVaultManager{open: true}
	router := ingress.NewRouter(vm, inbox, dd, sweeper, limiter)

	n, err := router.ProcessPending(context.Background())
	if err != nil {
		t.Fatalf("ProcessPending error: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 processed (empty spool), got %d", n)
	}
}

// TestProcessPending_SweepsDeadDrop verifies that ProcessPending drains
// all dead drop blobs. With the stub encryptor the raw bytes pass through
// decryption, but json.Unmarshal will fail on non-JSON data so the blobs
// are consumed (removed) but not delivered. The key assertion is that blobs
// are cleared from the spool after the sweep.
func TestTransport_7_ProcessPendingSweepsDeadDrop(t *testing.T) {
	inbox := &stubInboxManager{}
	ts := newTestTransportService(inbox)
	tmpDir := t.TempDir()
	dd := ingress.NewDeadDrop(tmpDir, 100, 10*1024*1024)
	limiter := ingress.NewRateLimiter(100, time.Minute, 1000, 500*1024*1024, dd)
	sweeper := ingress.NewSweeper(dd, &stubEncryptor{}, &stubDIDResolver{}, &stubClock{}, 24*time.Hour)
	sweeper.SetTransport(ts)
	vm := &mockVaultManager{open: true}
	router := ingress.NewRouter(vm, inbox, dd, sweeper, limiter)

	// Store valid signed envelopes in the dead drop.
	for i := 0; i < 3; i++ {
		env := wrapEnvelope(t, domain.DinaMessage{
			ID:   fmt.Sprintf("msg-%d", i),
			From: testSenderDID,
			Type: domain.MessageTypeQuery,
			To:   []string{"did:key:z6MkTest"},
			Body: []byte("hello"),
		})
		if err := dd.Store(context.Background(), env); err != nil {
			t.Fatalf("Store blob %d: %v", i, err)
		}
	}

	count, _ := dd.Count()
	if count != 3 {
		t.Fatalf("expected 3 blobs before sweep, got %d", count)
	}

	// ProcessPending should sweep all blobs.
	_, err := router.ProcessPending(context.Background())
	if err != nil {
		t.Fatalf("ProcessPending error: %v", err)
	}

	// All blobs should have been consumed (read + removed) by the sweeper.
	postCount, _ := dd.Count()
	if postCount != 0 {
		t.Fatalf("expected 0 blobs after sweep, got %d", postCount)
	}
}
