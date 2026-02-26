package service

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ---------------------------------------------------------------------------
// Mocks for TransportService tests
// ---------------------------------------------------------------------------

// mockOutboxManager implements port.OutboxManager for testing.
type mockOutboxManager struct {
	mu       sync.Mutex
	messages []domain.OutboxMessage
	nextID   int
}

func newMockOutboxManager() *mockOutboxManager {
	return &mockOutboxManager{}
}

func (m *mockOutboxManager) Enqueue(_ context.Context, msg domain.OutboxMessage) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if msg.ID == "" {
		m.nextID++
		msg.ID = fmt.Sprintf("outbox-%d", m.nextID)
	}
	msg.Status = "pending"
	if msg.CreatedAt == 0 {
		msg.CreatedAt = time.Now().Unix()
	}
	m.messages = append(m.messages, msg)
	return msg.ID, nil
}

func (m *mockOutboxManager) MarkDelivered(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID {
			m.messages[i].Status = "delivered"
			return nil
		}
	}
	return fmt.Errorf("not found")
}

func (m *mockOutboxManager) MarkFailed(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID {
			m.messages[i].Status = "failed"
			m.messages[i].Retries++
			backoff := int64(30) << uint(m.messages[i].Retries)
			m.messages[i].NextRetry = time.Now().Unix() + backoff
			return nil
		}
	}
	return fmt.Errorf("not found")
}

func (m *mockOutboxManager) Requeue(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID && m.messages[i].Status == "failed" {
			m.messages[i].Status = "pending"
			m.messages[i].Retries = 0
			m.messages[i].NextRetry = 0
			return nil
		}
	}
	return fmt.Errorf("not found")
}

func (m *mockOutboxManager) PendingCount(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, msg := range m.messages {
		if msg.Status == "pending" {
			count++
		}
	}
	return count, nil
}

func (m *mockOutboxManager) ListPending(_ context.Context) ([]domain.OutboxMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().Unix()
	var pending []domain.OutboxMessage
	for _, msg := range m.messages {
		if (msg.Status == "pending" || msg.Status == "failed") && msg.NextRetry <= now {
			pending = append(pending, msg)
		}
	}
	return pending, nil
}

func (m *mockOutboxManager) getByID(msgID string) *domain.OutboxMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, msg := range m.messages {
		if msg.ID == msgID {
			cp := msg
			return &cp
		}
	}
	return nil
}

// setMessageForTest directly sets a message in the outbox for test setup.
func (m *mockOutboxManager) setMessageForTest(msg domain.OutboxMessage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Replace if exists.
	for i := range m.messages {
		if m.messages[i].ID == msg.ID {
			m.messages[i] = msg
			return
		}
	}
	m.messages = append(m.messages, msg)
}

// mockTransportClock implements port.Clock for testing.
type mockTransportClock struct{}

func (m *mockTransportClock) Now() time.Time                         { return time.Now() }
func (m *mockTransportClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (m *mockTransportClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

// mockEncryptor implements port.Encryptor for testing (pass-through).
type mockEncryptor struct{}

func (m *mockEncryptor) SealAnonymous(plaintext, _ []byte) ([]byte, error) { return plaintext, nil }
func (m *mockEncryptor) OpenAnonymous(ciphertext, _, _ []byte) ([]byte, error) {
	return ciphertext, nil
}

// mockIdentitySigner implements port.IdentitySigner for testing.
type mockIdentitySigner struct{}

func (m *mockIdentitySigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return []byte("mock-sig"), nil
}
func (m *mockIdentitySigner) PublicKey() ed25519.PublicKey { return ed25519.PublicKey([]byte("mock-pub-key-32bytes-long-enough")) }

// mockKeyConverter implements port.KeyConverter for testing.
type mockKeyConverter struct{}

func (m *mockKeyConverter) Ed25519ToX25519Private(priv []byte) ([]byte, error) { return priv, nil }
func (m *mockKeyConverter) Ed25519ToX25519Public(pub []byte) ([]byte, error)   { return pub, nil }

// mockDIDResolver implements port.DIDResolver for testing.
type mockDIDResolver struct {
	docs map[string]*domain.DIDDocument
}

func newMockDIDResolver() *mockDIDResolver {
	return &mockDIDResolver{docs: make(map[string]*domain.DIDDocument)}
}

func (m *mockDIDResolver) Resolve(_ context.Context, did domain.DID) (*domain.DIDDocument, error) {
	doc, ok := m.docs[string(did)]
	if !ok {
		return nil, fmt.Errorf("DID not found: %s", did)
	}
	return doc, nil
}

func (m *mockDIDResolver) InvalidateCache(did domain.DID) {
	delete(m.docs, string(did))
}

// mockInboxManager implements port.InboxManager for testing.
type mockInboxManager struct{}

func (m *mockInboxManager) CheckIPRate(_ string) bool                       { return true }
func (m *mockInboxManager) CheckGlobalRate() bool                           { return true }
func (m *mockInboxManager) CheckPayloadSize(_ []byte) bool                  { return true }
func (m *mockInboxManager) Spool(_ context.Context, _ []byte) (string, error) { return "spool-1", nil }
func (m *mockInboxManager) SpoolSize() (int64, error)                       { return 0, nil }
func (m *mockInboxManager) ProcessSpool(_ context.Context) (int, error)     { return 0, nil }
func (m *mockInboxManager) DrainSpool(_ context.Context) ([][]byte, error)  { return nil, nil }

// mockDeliverer implements port.Deliverer for testing.
type mockDeliverer struct {
	deliverErr error
	delivered  []string // endpoints that received deliveries
}

func (m *mockDeliverer) Deliver(_ context.Context, endpoint string, _ []byte) error {
	if m.deliverErr != nil {
		return m.deliverErr
	}
	m.delivered = append(m.delivered, endpoint)
	return nil
}

// ---------------------------------------------------------------------------
// Helper to build a TransportService for testing
// ---------------------------------------------------------------------------

func newTestTransportService(outbox *mockOutboxManager, deliverer *mockDeliverer, resolver *mockDIDResolver) *TransportService {
	svc := NewTransportService(
		&mockEncryptor{},
		&mockIdentitySigner{},
		&mockKeyConverter{},
		resolver,
		outbox,
		&mockInboxManager{},
		&mockTransportClock{},
	)
	if deliverer != nil {
		svc.SetDeliverer(deliverer)
	}
	return svc
}

// ---------------------------------------------------------------------------
// Tests: Outbox Retry Logic (Fix 3)
// ---------------------------------------------------------------------------

func TestProcessOutbox_FailedMessageRetriedAfterBackoff(t *testing.T) {
	// A failed message whose NextRetry has elapsed should be picked up
	// by ProcessOutbox and retried (delivered successfully).
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{}

	recipientDID := "did:key:z6MkRetryTarget"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://retry-target.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// Enqueue and then mark as failed with a past NextRetry (backoff elapsed).
	outbox.setMessageForTest(domain.OutboxMessage{
		ID:        "retry-msg-001",
		ToDID:     recipientDID,
		Payload:   []byte("encrypted-payload"),
		Sig:       []byte("sig"),
		Status:    "failed",
		Retries:   2,
		NextRetry: time.Now().Unix() - 10, // backoff has elapsed
		CreatedAt: time.Now().Unix(),
	})

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 1 {
		t.Errorf("expected 1 processed, got %d", processed)
	}

	// The message should be marked as delivered.
	msg := outbox.getByID("retry-msg-001")
	if msg == nil {
		t.Fatal("message not found")
	}
	if msg.Status != "delivered" {
		t.Errorf("expected status 'delivered', got %q", msg.Status)
	}
}

func TestProcessOutbox_MaxRetriesSkipped(t *testing.T) {
	// A message with Retries >= 5 should be skipped (dead-letter).
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{}

	recipientDID := "did:key:z6MkDeadLetter"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://dead-letter.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// Set up a message with 5 retries (dead-letter threshold).
	outbox.setMessageForTest(domain.OutboxMessage{
		ID:        "dead-letter-001",
		ToDID:     recipientDID,
		Payload:   []byte("encrypted-payload"),
		Sig:       []byte("sig"),
		Status:    "failed",
		Retries:   5,
		NextRetry: time.Now().Unix() - 10, // backoff has elapsed
		CreatedAt: time.Now().Unix(),
	})

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 1 {
		t.Errorf("expected 1 processed (skipped), got %d", processed)
	}

	// No delivery should have been attempted.
	if len(deliverer.delivered) != 0 {
		t.Errorf("expected 0 deliveries for dead-letter message, got %d", len(deliverer.delivered))
	}

	// The message should still be in failed state (not touched).
	msg := outbox.getByID("dead-letter-001")
	if msg == nil {
		t.Fatal("message not found")
	}
	if msg.Status != "failed" {
		t.Errorf("expected dead-letter message to remain 'failed', got %q", msg.Status)
	}
	if msg.Retries != 5 {
		t.Errorf("expected retries to remain 5, got %d", msg.Retries)
	}
}

func TestProcessOutbox_SuccessfulRetryMarksDelivered(t *testing.T) {
	// A failed message that is successfully retried should be marked as delivered.
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{} // deliverer succeeds

	recipientDID := "did:key:z6MkSuccessRetry"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://success-retry.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// A message that failed once but backoff has elapsed.
	outbox.setMessageForTest(domain.OutboxMessage{
		ID:        "success-retry-001",
		ToDID:     recipientDID,
		Payload:   []byte("encrypted-payload"),
		Sig:       []byte("sig"),
		Status:    "failed",
		Retries:   1,
		NextRetry: time.Now().Unix() - 1,
		CreatedAt: time.Now().Unix(),
	})

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 1 {
		t.Errorf("expected 1 processed, got %d", processed)
	}

	msg := outbox.getByID("success-retry-001")
	if msg == nil {
		t.Fatal("message not found")
	}
	if msg.Status != "delivered" {
		t.Errorf("expected status 'delivered' after successful retry, got %q", msg.Status)
	}
}

func TestProcessOutbox_RetryCountIncrementsOnFailure(t *testing.T) {
	// When a retry fails, the retry count should increment.
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{deliverErr: fmt.Errorf("connection refused")} // delivery fails

	recipientDID := "did:key:z6MkFailRetry"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://fail-retry.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// A message that failed twice, backoff has elapsed, ready for retry.
	outbox.setMessageForTest(domain.OutboxMessage{
		ID:        "fail-retry-001",
		ToDID:     recipientDID,
		Payload:   []byte("encrypted-payload"),
		Sig:       []byte("sig"),
		Status:    "failed",
		Retries:   2,
		NextRetry: time.Now().Unix() - 1,
		CreatedAt: time.Now().Unix(),
	})

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 1 {
		t.Errorf("expected 1 processed, got %d", processed)
	}

	msg := outbox.getByID("fail-retry-001")
	if msg == nil {
		t.Fatal("message not found")
	}
	if msg.Status != "failed" {
		t.Errorf("expected status 'failed' after failed retry, got %q", msg.Status)
	}
	if msg.Retries != 3 {
		t.Errorf("expected retries to increment to 3, got %d", msg.Retries)
	}
}

func TestProcessOutbox_MessagesAboveMaxRetriesNeverDelivered(t *testing.T) {
	// Messages with retries 5, 6, 10 should all be skipped.
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{}

	recipientDID := "did:key:z6MkHighRetries"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://high-retries.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// Create messages with various high retry counts.
	for i, retries := range []int{5, 6, 10} {
		outbox.setMessageForTest(domain.OutboxMessage{
			ID:        fmt.Sprintf("high-retries-%d", i),
			ToDID:     recipientDID,
			Payload:   []byte("encrypted-payload"),
			Sig:       []byte("sig"),
			Status:    "failed",
			Retries:   retries,
			NextRetry: time.Now().Unix() - 1,
			CreatedAt: time.Now().Unix(),
		})
	}

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 3 {
		t.Errorf("expected 3 processed (all skipped), got %d", processed)
	}

	// No deliveries should have been attempted.
	if len(deliverer.delivered) != 0 {
		t.Errorf("expected 0 deliveries, got %d", len(deliverer.delivered))
	}
}

func TestProcessOutbox_RetryBelowMaxIsProcessed(t *testing.T) {
	// Messages with retries < 5 should be processed (attempted).
	outbox := newMockOutboxManager()
	resolver := newMockDIDResolver()
	deliverer := &mockDeliverer{} // delivery succeeds

	recipientDID := "did:key:z6MkBelowMax"
	resolver.docs[recipientDID] = &domain.DIDDocument{
		ID: recipientDID,
		VerificationMethod: []domain.VerificationMethod{
			{ID: recipientDID + "#key-1", PublicKeyMultibase: "z" + "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://below-max.dina.local/didcomm"},
		},
	}

	svc := newTestTransportService(outbox, deliverer, resolver)

	// Messages with retries 0 through 4 should all be attempted.
	for i := 0; i < 5; i++ {
		outbox.setMessageForTest(domain.OutboxMessage{
			ID:        fmt.Sprintf("below-max-%d", i),
			ToDID:     recipientDID,
			Payload:   []byte("encrypted-payload"),
			Sig:       []byte("sig"),
			Status:    "failed",
			Retries:   i,
			NextRetry: time.Now().Unix() - 1,
			CreatedAt: time.Now().Unix(),
		})
	}

	processed, err := svc.ProcessOutbox(context.Background())
	if err != nil {
		t.Fatalf("ProcessOutbox returned error: %v", err)
	}
	if processed != 5 {
		t.Errorf("expected 5 processed, got %d", processed)
	}

	// All 5 should have been delivered.
	if len(deliverer.delivered) != 5 {
		t.Errorf("expected 5 deliveries, got %d", len(deliverer.delivered))
	}
}
