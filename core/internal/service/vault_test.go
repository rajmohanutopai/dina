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
