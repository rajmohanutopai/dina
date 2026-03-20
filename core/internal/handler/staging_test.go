package handler

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
