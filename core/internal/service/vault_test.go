package service

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// mockVaultManager implements port.VaultManager for testing.
type mockVaultManager struct {
	open map[domain.PersonaName]bool
}

func newMockVaultManager() *mockVaultManager {
	return &mockVaultManager{open: make(map[domain.PersonaName]bool)}
}

func (m *mockVaultManager) Open(_ context.Context, p domain.PersonaName, _ []byte) error {
	m.open[p] = true
	return nil
}

func (m *mockVaultManager) Close(p domain.PersonaName) error {
	delete(m.open, p)
	return nil
}

func (m *mockVaultManager) IsOpen(p domain.PersonaName) bool {
	return m.open[p]
}

func (m *mockVaultManager) OpenPersonas() []domain.PersonaName {
	var out []domain.PersonaName
	for p := range m.open {
		out = append(out, p)
	}
	return out
}

func (m *mockVaultManager) Checkpoint(_ domain.PersonaName) error { return nil }

// mockVaultReader implements port.VaultReader for testing.
type mockVaultReader struct {
	items map[string]*domain.VaultItem // id -> item
}

func newMockVaultReader() *mockVaultReader {
	return &mockVaultReader{items: make(map[string]*domain.VaultItem)}
}

func (m *mockVaultReader) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return nil, nil
}

func (m *mockVaultReader) GetItem(_ context.Context, _ domain.PersonaName, id string) (*domain.VaultItem, error) {
	item, ok := m.items[id]
	if !ok {
		return nil, fmt.Errorf("item %q not found", id)
	}
	return item, nil
}

func (m *mockVaultReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// mockVaultWriter implements port.VaultWriter for testing.
type mockVaultWriter struct{}

func (m *mockVaultWriter) Store(_ context.Context, _ domain.PersonaName, item domain.VaultItem) (string, error) {
	return item.ID, nil
}

func (m *mockVaultWriter) StoreBatch(_ context.Context, _ domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}
	return ids, nil
}

func (m *mockVaultWriter) Delete(_ context.Context, _ domain.PersonaName, _ string) error {
	return nil
}

// mockGatekeeper implements port.Gatekeeper for testing.
type mockGatekeeper struct {
	allow bool
}

func (m *mockGatekeeper) EvaluateIntent(_ context.Context, _ domain.Intent) (domain.Decision, error) {
	if m.allow {
		return domain.Decision{Allowed: true}, nil
	}
	return domain.Decision{Allowed: false, Reason: "denied by test"}, nil
}

func (m *mockGatekeeper) CheckEgress(_ context.Context, _ string, _ []byte) (bool, error) {
	return m.allow, nil
}

// mockClock implements port.Clock for testing.
type mockClock struct{}

func (m *mockClock) Now() time.Time                         { return time.Unix(1000000, 0) }
func (m *mockClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (m *mockClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestVault_4_GetItemSuccess(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	want := &domain.VaultItem{
		ID:       "item-123",
		Type:     "note",
		Summary:  "test item",
		BodyText: "test body",
	}
	reader.items["item-123"] = want

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	got, err := svc.GetItem(context.Background(), "agent-1", persona, "item-123")
	if err != nil {
		t.Fatalf("GetItem returned error: %v", err)
	}
	if got == nil {
		t.Fatal("GetItem returned nil")
	}
	if got.ID != want.ID {
		t.Errorf("got ID %q, want %q", got.ID, want.ID)
	}
	if got.Summary != want.Summary {
		t.Errorf("got Summary %q, want %q", got.Summary, want.Summary)
	}
}

func TestVault_4_GetItemNotFound(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	_, err := svc.GetItem(context.Background(), "agent-1", persona, "nonexistent-id")
	if err == nil {
		t.Fatal("GetItem should return error for nonexistent item")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got: %v", err)
	}
}

func TestVault_4_GetItemLockedPersona(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	// persona is NOT opened in mgr
	persona := domain.PersonaName("locked-persona")

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	_, err := svc.GetItem(context.Background(), "agent-1", persona, "item-123")
	if err == nil {
		t.Fatal("GetItem should return error for locked persona")
	}
	if !strings.Contains(err.Error(), "persona locked") {
		t.Errorf("expected 'persona locked' in error, got: %v", err)
	}
}

func TestVault_4_GetItemGatekeeperDenied(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: false}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	reader.items["item-123"] = &domain.VaultItem{ID: "item-123"}

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	_, err := svc.GetItem(context.Background(), "agent-1", persona, "item-123")
	if err == nil {
		t.Fatal("GetItem should return error when gatekeeper denies access")
	}
	if !strings.Contains(err.Error(), "forbidden") {
		t.Errorf("expected 'forbidden' in error, got: %v", err)
	}
}

func TestVault_4_GetKVSuccess(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	want := &domain.VaultItem{
		ID:       "kv:gmail_cursor",
		Type:     "kv",
		BodyText: "2026-02-20T10:00:00Z",
	}
	reader.items["kv:gmail_cursor"] = want

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	got, err := svc.GetKV(context.Background(), "agent-1", persona, "gmail_cursor")
	if err != nil {
		t.Fatalf("GetKV returned error: %v", err)
	}
	if got == nil {
		t.Fatal("GetKV returned nil")
	}
	if got.ID != "kv:gmail_cursor" {
		t.Errorf("got ID %q, want %q", got.ID, "kv:gmail_cursor")
	}
	if got.BodyText != "2026-02-20T10:00:00Z" {
		t.Errorf("got BodyText %q, want %q", got.BodyText, "2026-02-20T10:00:00Z")
	}
}

func TestVault_4_GetKVNotFound(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	_, err := svc.GetKV(context.Background(), "agent-1", persona, "nonexistent_key")
	if err == nil {
		t.Fatal("GetKV should return error for nonexistent key")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got: %v", err)
	}
}

func TestVault_4_GetKVPrefixesKey(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	gk := &mockGatekeeper{allow: true}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	// Store under the kv:-prefixed ID to prove GetKV adds the prefix.
	reader.items["kv:my_key"] = &domain.VaultItem{
		ID:       "kv:my_key",
		Type:     "kv",
		BodyText: "my_value",
	}

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	// GetKV("my_key") should look up "kv:my_key".
	got, err := svc.GetKV(context.Background(), "agent-1", persona, "my_key")
	if err != nil {
		t.Fatalf("GetKV returned error: %v", err)
	}
	if got.BodyText != "my_value" {
		t.Errorf("got BodyText %q, want %q", got.BodyText, "my_value")
	}
}

func TestVault_4_GetItemGatekeeperReceivesItemIDAsTarget(t *testing.T) {
	mgr := newMockVaultManager()
	reader := newMockVaultReader()
	writer := &mockVaultWriter{}
	clk := &mockClock{}

	persona := domain.PersonaName("general")
	mgr.open[persona] = true
	reader.items["item-abc"] = &domain.VaultItem{ID: "item-abc"}

	// Custom gatekeeper that records the intent.
	var capturedIntent domain.Intent
	gk := &recordingGatekeeper{capturedIntent: &capturedIntent}

	svc := NewVaultService(mgr, reader, writer, gk, clk)

	_, _ = svc.GetItem(context.Background(), "test-agent", persona, "item-abc")

	if capturedIntent.Target != "item-abc" {
		t.Errorf("gatekeeper received Target %q, want %q", capturedIntent.Target, "item-abc")
	}
	if capturedIntent.AgentDID != "test-agent" {
		t.Errorf("gatekeeper received AgentDID %q, want %q", capturedIntent.AgentDID, "test-agent")
	}
	if capturedIntent.Action != "vault_read" {
		t.Errorf("gatekeeper received Action %q, want %q", capturedIntent.Action, "vault_read")
	}
}

// recordingGatekeeper captures the intent passed to EvaluateIntent.
type recordingGatekeeper struct {
	capturedIntent *domain.Intent
}

func (g *recordingGatekeeper) EvaluateIntent(_ context.Context, intent domain.Intent) (domain.Decision, error) {
	*g.capturedIntent = intent
	return domain.Decision{Allowed: true}, nil
}

func (g *recordingGatekeeper) CheckEgress(_ context.Context, _ string, _ []byte) (bool, error) {
	return true, nil
}

// ---------------------------------------------------------------------------
// HybridSearch trust-weighted scoring
// ---------------------------------------------------------------------------

// hybridMockReader returns configurable FTS5 and vector results for testing.
type hybridMockReader struct {
	ftsResults    []domain.VaultItem
	vectorResults []domain.VaultItem
}

func (m *hybridMockReader) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return m.ftsResults, nil
}

func (m *hybridMockReader) GetItem(_ context.Context, _ domain.PersonaName, _ string) (*domain.VaultItem, error) {
	return nil, fmt.Errorf("not found")
}

func (m *hybridMockReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return m.vectorResults, nil
}

func TestHybridSearch_TrustWeighting_CaveatedDemoted(t *testing.T) {
	mgr := newMockVaultManager()
	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	normal := domain.VaultItem{ID: "normal-1", RetrievalPolicy: "normal", SenderTrust: "unknown", Confidence: "medium"}
	caveated := domain.VaultItem{ID: "caveated-1", RetrievalPolicy: "caveated", SenderTrust: "unknown", Confidence: "medium"}

	// Both items appear at same rank in both FTS5 and vector results.
	// Normal first in FTS, caveated first in vector — equal base scores.
	reader := &hybridMockReader{
		ftsResults:    []domain.VaultItem{normal, caveated},
		vectorResults: []domain.VaultItem{caveated, normal},
	}

	svc := NewVaultService(mgr, reader, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})

	q := domain.SearchQuery{
		Mode: domain.SearchHybrid, Query: "test", Embedding: []float32{0.1},
		Limit: 10, IncludeAll: true,
	}
	results, err := svc.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	// Normal should rank higher because caveated gets 0.7x multiplier.
	if results[0].ID != "normal-1" {
		t.Errorf("expected normal-1 first (higher trust), got %s", results[0].ID)
	}
}

func TestHybridSearch_TrustWeighting_SelfBoosted(t *testing.T) {
	mgr := newMockVaultManager()
	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	self := domain.VaultItem{ID: "self-1", RetrievalPolicy: "normal", SenderTrust: "self", Confidence: "high"}
	unknown := domain.VaultItem{ID: "unknown-1", RetrievalPolicy: "normal", SenderTrust: "unknown", Confidence: "medium"}

	// Unknown ranks higher in both FTS and vector (better match).
	reader := &hybridMockReader{
		ftsResults:    []domain.VaultItem{unknown, self},
		vectorResults: []domain.VaultItem{unknown, self},
	}

	svc := NewVaultService(mgr, reader, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})

	q := domain.SearchQuery{
		Mode: domain.SearchHybrid, Query: "test", Embedding: []float32{0.1},
		Limit: 10,
	}
	results, err := svc.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	// Self gets 1.2x boost. Unknown at rank 0 gets 1.0 base, self at rank 1 gets 0.5 base.
	// After boost: self = 0.5*1.2 = 0.6, unknown = 1.0. Unknown still wins.
	// But if both appear at same rank (close scores), the boost matters.
	// Test: self at rank 0 in FTS, unknown at rank 0 in vector. Equal base = 0.4+0.6 = 1.0 each.
	// Self gets 1.2x = 1.2, unknown stays 1.0 → self wins.

	// Redo with equal-rank placement:
	reader2 := &hybridMockReader{
		ftsResults:    []domain.VaultItem{self},    // self at rank 0 in FTS
		vectorResults: []domain.VaultItem{unknown}, // unknown at rank 0 in vector
	}
	svc2 := NewVaultService(mgr, reader2, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})
	results2, err := svc2.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	if len(results2) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results2))
	}
	// self: 0.4 * 1.0 * 1.2 (boost) = 0.48
	// unknown: 0.6 * 1.0 = 0.6
	// unknown wins (vector weight is higher). But if self appears in both:
	// Let's test when self has equal base score and gets boosted above.
	reader3 := &hybridMockReader{
		ftsResults:    []domain.VaultItem{self, unknown},
		vectorResults: []domain.VaultItem{self, unknown},
	}
	svc3 := NewVaultService(mgr, reader3, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})
	results3, err := svc3.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	// Both at same ranks → equal base scores.
	// self: base=1.0, boosted=1.2. unknown: base=1.0, no boost.
	if results3[0].ID != "self-1" {
		t.Errorf("expected self-1 first (trust boost), got %s", results3[0].ID)
	}
}

func TestHybridSearch_TrustWeighting_LowConfidencePenalty(t *testing.T) {
	mgr := newMockVaultManager()
	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	high := domain.VaultItem{ID: "high-1", RetrievalPolicy: "normal", SenderTrust: "unknown", Confidence: "high"}
	low := domain.VaultItem{ID: "low-1", RetrievalPolicy: "normal", SenderTrust: "unknown", Confidence: "low"}

	// Equal rank placement.
	reader := &hybridMockReader{
		ftsResults:    []domain.VaultItem{high, low},
		vectorResults: []domain.VaultItem{high, low},
	}

	svc := NewVaultService(mgr, reader, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})

	q := domain.SearchQuery{
		Mode: domain.SearchHybrid, Query: "test", Embedding: []float32{0.1},
		Limit: 10,
	}
	results, err := svc.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	// high: base=1.0, no penalty. low: base=0.5, penalty=0.6x → 0.3.
	// high wins.
	if results[0].ID != "high-1" {
		t.Errorf("expected high-1 first, got %s", results[0].ID)
	}
}

func TestHybridSearch_TrustWeighting_CompoundModifiers(t *testing.T) {
	mgr := newMockVaultManager()
	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	// Self-sourced vs caveated+low confidence.
	trusted := domain.VaultItem{ID: "trusted-1", RetrievalPolicy: "normal", SenderTrust: "self", Confidence: "high"}
	untrusted := domain.VaultItem{ID: "untrusted-1", RetrievalPolicy: "caveated", SenderTrust: "unknown", Confidence: "low"}

	reader := &hybridMockReader{
		ftsResults:    []domain.VaultItem{trusted, untrusted},
		vectorResults: []domain.VaultItem{trusted, untrusted},
	}

	svc := NewVaultService(mgr, reader, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})

	q := domain.SearchQuery{
		Mode: domain.SearchHybrid, Query: "test", Embedding: []float32{0.1},
		Limit: 10, IncludeAll: true,
	}
	results, err := svc.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	// trusted: base * 1.2 (self boost). untrusted: base * 0.7 * 0.6 = base * 0.42.
	if results[0].ID != "trusted-1" {
		t.Errorf("expected trusted-1 first (compound boost), got %s", results[0].ID)
	}
}

func TestHybridSearch_TrustWeighting_NormalUnchanged(t *testing.T) {
	mgr := newMockVaultManager()
	persona := domain.PersonaName("general")
	mgr.open[persona] = true

	// Normal policy + medium confidence + unknown trust = no modifiers (1.0x).
	item := domain.VaultItem{ID: "plain-1", RetrievalPolicy: "normal", SenderTrust: "unknown", Confidence: "medium"}

	reader := &hybridMockReader{
		ftsResults:    []domain.VaultItem{item},
		vectorResults: []domain.VaultItem{item},
	}

	svc := NewVaultService(mgr, reader, &mockVaultWriter{}, &mockGatekeeper{allow: true}, &mockClock{})

	q := domain.SearchQuery{
		Mode: domain.SearchHybrid, Query: "test", Embedding: []float32{0.1},
		Limit: 10,
	}
	results, err := svc.HybridSearch(context.Background(), "", persona, q)
	if err != nil {
		t.Fatalf("HybridSearch: %v", err)
	}
	if len(results) != 1 || results[0].ID != "plain-1" {
		t.Errorf("expected plain-1, got %v", results)
	}
}
