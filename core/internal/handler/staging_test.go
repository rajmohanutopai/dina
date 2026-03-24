package handler

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/service"

	"github.com/mr-tron/base58"
)

// ==========================================================================
// Staging Handler Tests — Provenance Derivation
// 8 scenarios verifying that server-derived provenance is correct for each
// caller type: CLI user, CLI agent, Brain relay, connector, Brain internal,
// non-Brain service (rejected), admin, and full HandleIngest 202 flow.
// ==========================================================================

// --------------------------------------------------------------------------
// 1. TestDeriveProvenance_DeviceUser — callerType=agent with user-role
//    device. Expect channel=cli, kind=user.
// --------------------------------------------------------------------------

func TestDeriveProvenance_DeviceUser(t *testing.T) {
	h := &StagingHandler{Devices: nil} // no device service → defaults to user

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "agent")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "did:key:z6MkTestUser")
	r = r.WithContext(ctx)

	req := ingestRequest{Source: "gmail", SourceID: "msg-001", Summary: "test"}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != domain.IngressCLI {
		t.Errorf("channel: got %q, want %q", channel, domain.IngressCLI)
	}
	if did != "did:key:z6MkTestUser" {
		t.Errorf("did: got %q, want %q", did, "did:key:z6MkTestUser")
	}
	if kind != domain.OriginUser {
		t.Errorf("kind: got %q, want %q", kind, domain.OriginUser)
	}
	if producer != "cli:did:key:z6MkTestUser" {
		t.Errorf("producer: got %q, want %q", producer, "cli:did:key:z6MkTestUser")
	}
}

// --------------------------------------------------------------------------
// 2. TestDeriveProvenance_DeviceAgent — callerType=agent with agent-role
//    device. Expect channel=cli, kind=agent.
// --------------------------------------------------------------------------

func TestDeriveProvenance_DeviceAgent(t *testing.T) {
	// Create a real PairingManager + DeviceService with an agent-role device.
	pm := pairing.NewManager(pairing.DefaultConfig())
	ctx := context.Background()

	code, _, err := pm.GenerateCode(ctx)
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}

	// Generate a valid Ed25519 key and encode as multibase.
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	multicodec := append([]byte{0xed, 0x01}, pub...)
	multibase := "z" + base58.Encode(multicodec)
	agentDID := "did:key:" + multibase

	_, _, err = pm.CompletePairingWithKey(ctx, code, "OpenClaw Bot", multibase, domain.DeviceRoleAgent)
	if err != nil {
		t.Fatalf("CompletePairingWithKey: %v", err)
	}

	devSvc := service.NewDeviceService(pm, nil, nil)
	h := &StagingHandler{Devices: devSvc}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	rctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "agent")
	rctx = context.WithValue(rctx, middleware.AgentDIDKey, agentDID)
	r = r.WithContext(rctx)

	req := ingestRequest{Source: "gmail", SourceID: "msg-001", Summary: "test"}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != domain.IngressCLI {
		t.Errorf("channel: got %q, want %q", channel, domain.IngressCLI)
	}
	if did != agentDID {
		t.Errorf("did: got %q, want %q", did, agentDID)
	}
	if kind != domain.OriginAgent {
		t.Errorf("kind: got %q, want %q", kind, domain.OriginAgent)
	}
	if producer != "cli:"+agentDID {
		t.Errorf("producer: got %q, want %q", producer, "cli:"+agentDID)
	}
}

// --------------------------------------------------------------------------
// 3. TestDeriveProvenance_BrainRelay — Brain (service key, serviceID=brain)
//    with explicit ingress_channel. Expect relay passthrough.
// --------------------------------------------------------------------------

func TestDeriveProvenance_BrainRelay(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "brain")
	r = r.WithContext(ctx)

	req := ingestRequest{
		IngressChannel: "telegram",
		OriginDID:      "did:plc:user123",
		OriginKind:     "user",
		Summary:        "Telegram message",
	}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != "telegram" {
		t.Errorf("channel: got %q, want %q", channel, "telegram")
	}
	if did != "did:plc:user123" {
		t.Errorf("did: got %q, want %q", did, "did:plc:user123")
	}
	if kind != "user" {
		t.Errorf("kind: got %q, want %q", kind, "user")
	}
	if producer != "telegram:did:plc:user123" {
		t.Errorf("producer: got %q, want %q", producer, "telegram:did:plc:user123")
	}
}

// --------------------------------------------------------------------------
// 4. TestDeriveProvenance_BrainRelayWithConnectorID — Brain relay but with
//    connector_id set. Producer should use connector prefix.
// --------------------------------------------------------------------------

func TestDeriveProvenance_BrainRelayWithConnectorID(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "brain")
	r = r.WithContext(ctx)

	req := ingestRequest{
		IngressChannel: "connector",
		OriginDID:      "brain",
		OriginKind:     "service",
		ConnectorID:    "gmail-connector",
		Summary:        "Gmail fetch",
	}

	channel, _, _, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != "connector" {
		t.Errorf("channel: got %q, want %q", channel, "connector")
	}
	if producer != "connector:gmail-connector" {
		t.Errorf("producer: got %q, want %q", producer, "connector:gmail-connector")
	}
}

// --------------------------------------------------------------------------
// 5. TestDeriveProvenance_ConnectorService — Non-Brain service key with
//    connector_id. Expect channel=connector, did=serviceID.
// --------------------------------------------------------------------------

func TestDeriveProvenance_ConnectorService(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "openclaw")
	r = r.WithContext(ctx)

	req := ingestRequest{
		ConnectorID: "gmail-conn-1",
		Source:      "gmail",
		SourceID:    "msg-001",
		Summary:     "Connector ingest",
	}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != domain.IngressConnector {
		t.Errorf("channel: got %q, want %q", channel, domain.IngressConnector)
	}
	if did != "openclaw" {
		t.Errorf("did: got %q, want %q", did, "openclaw")
	}
	if kind != domain.OriginService {
		t.Errorf("kind: got %q, want %q", kind, domain.OriginService)
	}
	if producer != "connector:gmail-conn-1" {
		t.Errorf("producer: got %q, want %q", producer, "connector:gmail-conn-1")
	}
}

// --------------------------------------------------------------------------
// 6. TestDeriveProvenance_NonBrainServiceNoConnectorID — Non-Brain service
//    without connector_id. Must be REJECTED (error message returned).
// --------------------------------------------------------------------------

func TestDeriveProvenance_NonBrainServiceNoConnectorID(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "unknown-service")
	r = r.WithContext(ctx)

	req := ingestRequest{
		Source:   "gmail",
		SourceID: "msg-001",
		Summary:  "Spoofed ingest without connector_id",
	}

	_, _, _, _, errMsg := h.deriveProvenance(r, req)
	if errMsg == "" {
		t.Fatal("expected error for non-brain service without connector_id, got none")
	}
	if !strings.Contains(errMsg, "connector_id") {
		t.Errorf("error message should mention connector_id, got: %s", errMsg)
	}
}

// --------------------------------------------------------------------------
// 7. TestDeriveProvenance_BrainInternal — Brain service key without relay
//    or connector. Expect channel=brain, producer=brain:system.
// --------------------------------------------------------------------------

func TestDeriveProvenance_BrainInternal(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "brain")
	r = r.WithContext(ctx)

	req := ingestRequest{
		// No IngressChannel, no ConnectorID → Brain internal path
		Summary: "Brain-generated content",
	}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != domain.IngressBrain {
		t.Errorf("channel: got %q, want %q", channel, domain.IngressBrain)
	}
	if did != "brain" {
		t.Errorf("did: got %q, want %q", did, "brain")
	}
	if kind != domain.OriginService {
		t.Errorf("kind: got %q, want %q", kind, domain.OriginService)
	}
	if producer != "brain:system" {
		t.Errorf("producer: got %q, want %q", producer, "brain:system")
	}
}

// --------------------------------------------------------------------------
// 8. TestDeriveProvenance_Admin — Default path (CLIENT_TOKEN / admin).
//    Expect channel=admin, producer=admin:system.
// --------------------------------------------------------------------------

func TestDeriveProvenance_Admin(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	// No CallerTypeKey="agent", no TokenKindKey="service" → default path

	req := ingestRequest{Summary: "Admin ingest"}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != domain.IngressAdmin {
		t.Errorf("channel: got %q, want %q", channel, domain.IngressAdmin)
	}
	if did != "admin" {
		t.Errorf("did: got %q, want %q", did, "admin")
	}
	if kind != domain.OriginUser {
		t.Errorf("kind: got %q, want %q", kind, domain.OriginUser)
	}
	if producer != "admin:system" {
		t.Errorf("producer: got %q, want %q", producer, "admin:system")
	}
}

// --------------------------------------------------------------------------
// 9. TestDeriveProvenance_ConnectorSpoofTelegram — Non-Brain service key
//    trying to set ingress_channel=telegram. Must NOT pass through —
//    only Brain can relay provenance.
// --------------------------------------------------------------------------

func TestDeriveProvenance_ConnectorSpoofTelegram(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "malicious-connector")
	r = r.WithContext(ctx)

	req := ingestRequest{
		IngressChannel: "telegram",      // attempting to spoof
		ConnectorID:    "gmail-conn-1",   // has connector_id, so won't be rejected
		Source:         "gmail",
		SourceID:       "msg-001",
	}

	channel, _, _, _, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	// Non-Brain service with connector_id → forced to "connector" channel,
	// NOT the spoofed "telegram".
	if channel != domain.IngressConnector {
		t.Errorf("channel: got %q, want %q — non-Brain cannot relay telegram provenance",
			channel, domain.IngressConnector)
	}
}

// --------------------------------------------------------------------------
// 10. TestHandleIngest_MethodNotAllowed — GET request returns 405.
// --------------------------------------------------------------------------

func TestHandleIngest_MethodNotAllowed(t *testing.T) {
	h := &StagingHandler{Staging: nil, Devices: nil}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/ingest", nil)
	rec := httptest.NewRecorder()

	h.HandleIngest(rec, r)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

// --------------------------------------------------------------------------
// 11. TestHandleIngest_InvalidJSON — malformed JSON returns 400.
// --------------------------------------------------------------------------

func TestHandleIngest_InvalidJSON(t *testing.T) {
	h := &StagingHandler{Staging: nil, Devices: nil}

	r := httptest.NewRequest(http.MethodPost, "/v1/staging/ingest",
		strings.NewReader("{invalid json"))
	rec := httptest.NewRecorder()

	h.HandleIngest(rec, r)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected %d, got %d", http.StatusBadRequest, rec.Code)
	}
}

// --------------------------------------------------------------------------
// 12. TestDeriveProvenance_CoreServiceRelays — serviceID="core" can also
//     relay provenance (same as brain).
// --------------------------------------------------------------------------

func TestDeriveProvenance_CoreServiceRelays(t *testing.T) {
	h := &StagingHandler{Devices: nil}

	r := httptest.NewRequest("POST", "/v1/staging/ingest", nil)
	ctx := context.WithValue(r.Context(), middleware.TokenKindKey, "service")
	ctx = context.WithValue(ctx, middleware.ServiceIDKey, "core")
	r = r.WithContext(ctx)

	req := ingestRequest{
		IngressChannel: "d2d",
		OriginDID:      "did:plc:peer456",
		OriginKind:     "remote_dina",
	}

	channel, did, kind, producer, errMsg := h.deriveProvenance(r, req)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if channel != "d2d" {
		t.Errorf("channel: got %q, want %q", channel, "d2d")
	}
	if did != "did:plc:peer456" {
		t.Errorf("did: got %q, want %q", did, "did:plc:peer456")
	}
	if kind != "remote_dina" {
		t.Errorf("kind: got %q, want %q", kind, "remote_dina")
	}
	if producer != "d2d:did:plc:peer456" {
		t.Errorf("producer: got %q, want %q", producer, "d2d:did:plc:peer456")
	}
}

// --------------------------------------------------------------------------
// 13. TestHandleClaim_MethodNotAllowed — GET on /v1/staging/claim returns 405.
// --------------------------------------------------------------------------

func TestHandleClaim_MethodNotAllowed(t *testing.T) {
	h := &StagingHandler{Staging: nil}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/claim", nil)
	rec := httptest.NewRecorder()

	h.HandleClaim(rec, r)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

// --------------------------------------------------------------------------
// 14. TestHandleResolve_MissingID — resolve without ID returns 400.
// --------------------------------------------------------------------------

func TestHandleResolve_MissingID(t *testing.T) {
	h := &StagingHandler{Staging: nil}

	body := `{"target_persona":"general","classified_item":{}}`
	r := httptest.NewRequest(http.MethodPost, "/v1/staging/resolve",
		strings.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleResolve(rec, r)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected %d, got %d", http.StatusBadRequest, rec.Code)
	}
	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["error"] != "missing id" {
		t.Errorf("error: got %q, want %q", resp["error"], "missing id")
	}
}

// --------------------------------------------------------------------------
// 15. TestHandleFail_MethodNotAllowed — GET on /v1/staging/fail returns 405.
// --------------------------------------------------------------------------

func TestHandleFail_MethodNotAllowed(t *testing.T) {
	h := &StagingHandler{Staging: nil}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/fail", nil)
	rec := httptest.NewRecorder()

	h.HandleFail(rec, r)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

// ==========================================================================
// HandleStatus Tests
// Verifies GET /v1/staging/status/{id}: 200 with persona, 200 without
// persona, 404 for unknown ID, 405 for non-GET, 400 for empty ID.
// Also verifies that resolveRequest.UserOrigin injects UserOriginatedKey
// into context via injectUserOrigin.
// ==========================================================================

// stubDetailedStagingInbox is a minimal port.StagingInbox implementation
// that also satisfies the detailedGetter interface used by HandleStatus.
// Controls GetStatus and GetStatusDetailed independently.
type stubDetailedStagingInbox struct {
	// GetStatusDetailed results, keyed by id.
	detailedStatus  map[string]string
	detailedPersona map[string]string
	// ids that should return error from GetStatusDetailed.
	notFound map[string]bool
}

func newStubDetailedInbox() *stubDetailedStagingInbox {
	return &stubDetailedStagingInbox{
		detailedStatus:  make(map[string]string),
		detailedPersona: make(map[string]string),
		notFound:        make(map[string]bool),
	}
}

// Satisfy port.StagingInbox (only GetStatus needs a real body for this stub;
// the rest panic if called — the tests covered here never call them).
func (s *stubDetailedStagingInbox) Ingest(_ context.Context, _ domain.StagingItem) (string, error) {
	panic("stub: Ingest not implemented")
}
func (s *stubDetailedStagingInbox) GetStatus(_ context.Context, id, _ string) (string, error) {
	if s.notFound[id] {
		return "", fmt.Errorf("staging: item %s not found", id)
	}
	status, ok := s.detailedStatus[id]
	if !ok {
		return "", fmt.Errorf("staging: item %s not found", id)
	}
	return status, nil
}
func (s *stubDetailedStagingInbox) Claim(_ context.Context, _ int, _ time.Duration) ([]domain.StagingItem, error) {
	panic("stub: Claim not implemented")
}
func (s *stubDetailedStagingInbox) Resolve(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: Resolve not implemented")
}
func (s *stubDetailedStagingInbox) ResolveMulti(_ context.Context, _ string, _ []domain.ResolveTarget) error {
	panic("stub: ResolveMulti not implemented")
}
func (s *stubDetailedStagingInbox) ExtendLease(_ context.Context, _ string, _ time.Duration) error {
	panic("stub: ExtendLease not implemented")
}
func (s *stubDetailedStagingInbox) MarkFailed(_ context.Context, _, _ string) error {
	panic("stub: MarkFailed not implemented")
}
func (s *stubDetailedStagingInbox) MarkPendingApproval(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: MarkPendingApproval not implemented")
}
func (s *stubDetailedStagingInbox) CreatePendingCopy(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: CreatePendingCopy not implemented")
}
func (s *stubDetailedStagingInbox) DrainPending(_ context.Context, _ string) (int, error) {
	panic("stub: DrainPending not implemented")
}
func (s *stubDetailedStagingInbox) Sweep(_ context.Context) (int, error) {
	panic("stub: Sweep not implemented")
}
func (s *stubDetailedStagingInbox) ListByStatus(_ context.Context, _ string, _ int) ([]domain.StagingItem, error) {
	panic("stub: ListByStatus not implemented")
}

// GetStatusDetailed satisfies the detailedGetter interface used by HandleStatus.
func (s *stubDetailedStagingInbox) GetStatusDetailed(_ context.Context, id string) (string, string, error) {
	if s.notFound[id] {
		return "", "", fmt.Errorf("staging: item %s not found", id)
	}
	status, ok := s.detailedStatus[id]
	if !ok {
		return "", "", fmt.Errorf("staging: item %s not found", id)
	}
	return status, s.detailedPersona[id], nil
}

// --------------------------------------------------------------------------
// 16. TestHandleStatus_ReturnsStatusAndPersona — stored item returns status
//     + persona in the response body.
// --------------------------------------------------------------------------

func TestHandleStatus_ReturnsStatusAndPersona(t *testing.T) {
	stub := newStubDetailedInbox()
	stub.detailedStatus["item-abc"] = domain.StagingStored
	stub.detailedPersona["item-abc"] = "general"

	h := &StagingHandler{Staging: stub}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/status/item-abc", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp["id"] != "item-abc" {
		t.Errorf("id: got %v, want item-abc", resp["id"])
	}
	if resp["status"] != domain.StagingStored {
		t.Errorf("status: got %v, want %s", resp["status"], domain.StagingStored)
	}
	if resp["persona"] != "general" {
		t.Errorf("persona: got %v, want general", resp["persona"])
	}
}

// --------------------------------------------------------------------------
// 17. TestHandleStatus_ReturnsStatusWithoutPersona — received item has no
//     target_persona yet; response must not include "persona" key.
// --------------------------------------------------------------------------

func TestHandleStatus_ReturnsStatusWithoutPersona(t *testing.T) {
	stub := newStubDetailedInbox()
	stub.detailedStatus["item-xyz"] = domain.StagingReceived
	// No persona entry → GetStatusDetailed returns empty string for persona.

	h := &StagingHandler{Staging: stub}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/status/item-xyz", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp["status"] != domain.StagingReceived {
		t.Errorf("status: got %v, want %s", resp["status"], domain.StagingReceived)
	}
	if _, hasPersona := resp["persona"]; hasPersona {
		t.Errorf("persona key must be absent for unresolved items, got %v", resp["persona"])
	}
}

// --------------------------------------------------------------------------
// 18. TestHandleStatus_NotFound — unknown ID returns 404.
// --------------------------------------------------------------------------

func TestHandleStatus_NotFound(t *testing.T) {
	stub := newStubDetailedInbox()
	stub.notFound["missing-id"] = true

	h := &StagingHandler{Staging: stub}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/status/missing-id", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["error"] != "item not found" {
		t.Errorf("error: got %q, want \"item not found\"", resp["error"])
	}
}

// --------------------------------------------------------------------------
// 19. TestHandleStatus_MethodNotAllowed — non-GET method returns 405.
// --------------------------------------------------------------------------

func TestHandleStatus_MethodNotAllowed(t *testing.T) {
	h := &StagingHandler{Staging: nil}

	r := httptest.NewRequest(http.MethodPost, "/v1/staging/status/item-abc", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

// --------------------------------------------------------------------------
// 20. TestHandleStatus_EmptyID — request with no trailing ID returns 400.
// --------------------------------------------------------------------------

func TestHandleStatus_EmptyID(t *testing.T) {
	h := &StagingHandler{Staging: nil}

	// Path ends exactly at the prefix with no id segment.
	r := httptest.NewRequest(http.MethodGet, "/v1/staging/status/", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["error"] != "id is required" {
		t.Errorf("error: got %q, want \"id is required\"", resp["error"])
	}
}

// --------------------------------------------------------------------------
// 21. TestHandleStatus_FallbackToGetStatus — inbox without GetStatusDetailed
//     falls back to the base GetStatus method.
// --------------------------------------------------------------------------

// stubBasicStagingInbox implements port.StagingInbox WITHOUT GetStatusDetailed.
// HandleStatus must fall back to GetStatus in this case.
type stubBasicStagingInbox struct {
	statuses map[string]string
	notFound map[string]bool
}

func newStubBasicInbox() *stubBasicStagingInbox {
	return &stubBasicStagingInbox{
		statuses: make(map[string]string),
		notFound: make(map[string]bool),
	}
}

func (s *stubBasicStagingInbox) Ingest(_ context.Context, _ domain.StagingItem) (string, error) {
	panic("stub: Ingest not implemented")
}
func (s *stubBasicStagingInbox) GetStatus(_ context.Context, id, _ string) (string, error) {
	if s.notFound[id] {
		return "", fmt.Errorf("staging: item %s not found", id)
	}
	status, ok := s.statuses[id]
	if !ok {
		return "", fmt.Errorf("staging: item %s not found", id)
	}
	return status, nil
}
func (s *stubBasicStagingInbox) Claim(_ context.Context, _ int, _ time.Duration) ([]domain.StagingItem, error) {
	panic("stub: Claim not implemented")
}
func (s *stubBasicStagingInbox) Resolve(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: Resolve not implemented")
}
func (s *stubBasicStagingInbox) ResolveMulti(_ context.Context, _ string, _ []domain.ResolveTarget) error {
	panic("stub: ResolveMulti not implemented")
}
func (s *stubBasicStagingInbox) ExtendLease(_ context.Context, _ string, _ time.Duration) error {
	panic("stub: ExtendLease not implemented")
}
func (s *stubBasicStagingInbox) MarkFailed(_ context.Context, _, _ string) error {
	panic("stub: MarkFailed not implemented")
}
func (s *stubBasicStagingInbox) MarkPendingApproval(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: MarkPendingApproval not implemented")
}
func (s *stubBasicStagingInbox) CreatePendingCopy(_ context.Context, _, _ string, _ domain.VaultItem) error {
	panic("stub: CreatePendingCopy not implemented")
}
func (s *stubBasicStagingInbox) DrainPending(_ context.Context, _ string) (int, error) {
	panic("stub: DrainPending not implemented")
}
func (s *stubBasicStagingInbox) Sweep(_ context.Context) (int, error) {
	panic("stub: Sweep not implemented")
}
func (s *stubBasicStagingInbox) ListByStatus(_ context.Context, _ string, _ int) ([]domain.StagingItem, error) {
	panic("stub: ListByStatus not implemented")
}

func TestHandleStatus_FallbackToGetStatus(t *testing.T) {
	stub := newStubBasicInbox()
	stub.statuses["item-fallback"] = domain.StagingClassifying

	h := &StagingHandler{Staging: stub}

	r := httptest.NewRequest(http.MethodGet, "/v1/staging/status/item-fallback", nil)
	rec := httptest.NewRecorder()

	h.HandleStatus(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != domain.StagingClassifying {
		t.Errorf("status: got %v, want %s", resp["status"], domain.StagingClassifying)
	}
	// No persona key expected from fallback path.
	if _, hasPersona := resp["persona"]; hasPersona {
		t.Errorf("persona key must be absent when using fallback GetStatus path")
	}
}

// ==========================================================================
// UserOrigin on resolveRequest — verifies that injectUserOrigin is called
// with req.UserOrigin during HandleResolve, producing the expected context
// values (UserOriginatedKey and UserOriginKey).
//
// These tests exercise injectUserOrigin directly (already covered in
// vault_test.go) and confirm that HandleResolve passes UserOrigin through.
// The resolve handler integration is tested via the context propagation path.
// ==========================================================================

// --------------------------------------------------------------------------
// 22. TestResolveRequest_UserOriginTelegram — resolveRequest with
//     UserOrigin="telegram" and brain caller type injects UserOriginatedKey.
// --------------------------------------------------------------------------

func TestResolveRequest_UserOriginTelegram(t *testing.T) {
	// injectUserOrigin requires CallerType=brain.
	r := httptest.NewRequest("POST", "/v1/staging/resolve", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
	r = r.WithContext(ctx)

	// Simulate what HandleResolve does: call injectUserOrigin with UserOrigin.
	r = injectUserOrigin(r, "telegram")

	gotOriginated, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
	if !gotOriginated {
		t.Error("UserOriginatedKey must be true when user_origin=telegram from brain caller")
	}
	gotOrigin, _ := r.Context().Value(middleware.UserOriginKey).(string)
	if gotOrigin != "telegram" {
		t.Errorf("UserOriginKey: got %q, want \"telegram\"", gotOrigin)
	}
}

// --------------------------------------------------------------------------
// 23. TestResolveRequest_UserOriginEmpty — resolveRequest without UserOrigin
//     must NOT inject UserOriginatedKey into context.
// --------------------------------------------------------------------------

func TestResolveRequest_UserOriginEmpty(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/staging/resolve", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
	r = r.WithContext(ctx)

	// Empty UserOrigin → no injection.
	r = injectUserOrigin(r, "")

	gotOriginated, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
	if gotOriginated {
		t.Error("UserOriginatedKey must NOT be set when user_origin is empty")
	}
}

// --------------------------------------------------------------------------
// 24. TestResolveRequest_UserOriginNonBrainIgnored — non-brain caller with
//     UserOrigin must NOT inject UserOriginatedKey (security boundary).
// --------------------------------------------------------------------------

func TestResolveRequest_UserOriginNonBrainIgnored(t *testing.T) {
	for _, caller := range []string{"agent", "connector", "admin"} {
		r := httptest.NewRequest("POST", "/v1/staging/resolve", nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, caller)
		r = r.WithContext(ctx)

		r = injectUserOrigin(r, "telegram")

		gotOriginated, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
		if gotOriginated {
			t.Errorf("caller=%q: UserOriginatedKey must NOT be set for non-brain callers", caller)
		}
	}
}
