package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// validateEnrichment checks that a classified VaultItem has all required
// enrichment fields populated. Returns an error reason string, or "" if valid.
func validateEnrichment(item domain.VaultItem) string {
	if item.EnrichmentStatus != "ready" {
		return "enrichment_status must be 'ready'"
	}
	if item.ContentL0 == "" {
		return "content_l0 is required"
	}
	if item.ContentL1 == "" {
		return "content_l1 is required"
	}
	if len(item.Embedding) == 0 {
		return "embedding is required"
	}
	return ""
}

// StagingHandler exposes staging inbox endpoints for universal
// content ingestion — CLI, connectors, Telegram, D2D, and admin.
type StagingHandler struct {
	Staging port.StagingInbox
	Devices *service.DeviceService // for device role lookup
}

// ingestRequest is the JSON body for POST /v1/staging/ingest.
type ingestRequest struct {
	ConnectorID    string `json:"connector_id"`
	Source         string `json:"source"`
	SourceID       string `json:"source_id"`
	Type           string `json:"type"`
	Summary        string `json:"summary"`
	Body           string `json:"body"`
	Sender         string `json:"sender"`
	Metadata       string `json:"metadata"`
	// Provenance fields — accepted from trusted callers (Brain/admin),
	// overridden for external callers (device/connector).
	IngressChannel string `json:"ingress_channel"`
	OriginDID      string `json:"origin_did"`
	OriginKind     string `json:"origin_kind"`
}

// HandleIngest handles POST /v1/staging/ingest. It accepts raw content
// from any authorized source and stores it in the staging inbox for
// Brain classification. Provenance fields are server-derived from
// auth context — external callers cannot spoof them.
func (h *StagingHandler) HandleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req ingestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	// Derive provenance from auth context — override caller-supplied values
	// for external callers (device/connector). Only trusted service-key
	// callers (Brain) can set these explicitly.
	ingressChannel, originDID, originKind, producerID, provenanceErr := h.deriveProvenance(r, req)
	if provenanceErr != "" {
		http.Error(w, `{"error":"`+provenanceErr+`"}`, http.StatusBadRequest)
		return
	}

	item := domain.StagingItem{
		ConnectorID:    req.ConnectorID,
		Source:         req.Source,
		SourceID:       req.SourceID,
		Type:           req.Type,
		Summary:        req.Summary,
		Body:           req.Body,
		Sender:         req.Sender,
		Metadata:       req.Metadata,
		IngressChannel: ingressChannel,
		OriginDID:      originDID,
		OriginKind:     originKind,
		ProducerID:     producerID,
	}

	id, err := h.Staging.Ingest(r.Context(), item)
	if err != nil {
		clientError(w, "ingest failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":     id,
		"staged": true,
	})
}

// deriveProvenance sets ingress provenance from auth context.
// Device/connector callers get server-overridden values.
// Brain (service key) can set them explicitly for relay (Telegram/D2D in Phase 2+).
func (h *StagingHandler) deriveProvenance(r *http.Request, req ingestRequest) (channel, did, kind, producer, errMsg string) {
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	agentDID, _ := r.Context().Value(middleware.AgentDIDKey).(string)
	tokenKind, _ := r.Context().Value(middleware.TokenKindKey).(string)

	switch {
	case callerType == "agent":
		// Device-scoped caller (CLI / OpenClaw agent)
		channel = domain.IngressCLI
		did = agentDID
		// Look up device role to determine origin_kind
		kind = domain.OriginUser
		if h.Devices != nil && agentDID != "" {
			dev, err := h.Devices.GetDeviceByDID(r.Context(), agentDID)
			if err == nil && dev != nil && dev.Role == domain.DeviceRoleAgent {
				kind = domain.OriginAgent
			}
		}
		producer = "cli:" + agentDID

	case tokenKind == "service":
		// Service key caller — check service identity
		serviceID, _ := r.Context().Value(middleware.ServiceIDKey).(string)
		isBrain := serviceID == "brain" || serviceID == "core"
		if isBrain && req.IngressChannel != "" {
			// Only Brain can relay provenance (Telegram/D2D in Phase 2+).
			// Connectors cannot claim to be telegram.
			channel = req.IngressChannel
			did = req.OriginDID
			kind = req.OriginKind
			if req.ConnectorID != "" {
				producer = "connector:" + req.ConnectorID
			} else {
				producer = channel + ":" + did
			}
		} else if req.ConnectorID != "" {
			// Connector ingest (with explicit connector_id)
			channel = domain.IngressConnector
			did = serviceID
			kind = domain.OriginService
			producer = "connector:" + req.ConnectorID
		} else if isBrain {
			// Brain internal (no connector_id, no relay channel)
			channel = domain.IngressBrain
			did = "brain"
			kind = domain.OriginService
			producer = "brain:system"
		} else {
			// Non-Brain service caller without connector_id — reject.
			// Connectors must always provide connector_id.
			errMsg = "connector_id is required for connector ingestion"
			return
		}

	default:
		// Admin (CLIENT_TOKEN) or unknown
		channel = domain.IngressAdmin
		did = "admin"
		kind = domain.OriginUser
		producer = "admin:system"
	}

	slog.Info("staging.ingest.provenance",
		"channel", channel,
		"origin_did", did,
		"origin_kind", kind,
		"producer_id", producer,
	)
	return
}

// claimRequest is the JSON body for POST /v1/staging/claim.
type claimRequest struct {
	Limit int `json:"limit"`
}

// HandleClaim handles POST /v1/staging/claim. Brain calls this to claim
// received items for classification.
func (h *StagingHandler) HandleClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req claimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	limit := req.Limit
	if limit <= 0 {
		limit = 10
	}

	items, err := h.Staging.Claim(r.Context(), limit, time.Duration(domain.DefaultLeaseDuration)*time.Second)
	if err != nil {
		clientError(w, "claim failed", http.StatusInternalServerError, err)
		return
	}

	// Return empty array instead of null when no items claimed.
	if items == nil {
		items = []domain.StagingItem{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": items})
}

// resolveRequest is the JSON body for POST /v1/staging/resolve.
// Supports single-target (target_persona + classified_item) and
// multi-target (targets array) for cross-persona content.
type resolveRequest struct {
	ID             string                 `json:"id"`
	TargetPersona  string                 `json:"target_persona"`
	ClassifiedItem domain.VaultItem       `json:"classified_item"`
	Targets        []domain.ResolveTarget `json:"targets"`
}

// HandleResolve handles POST /v1/staging/resolve. Brain calls this after
// classifying an item to route it to the correct persona vault(s).
func (h *StagingHandler) HandleResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req resolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.ID == "" {
		http.Error(w, `{"error":"missing id"}`, http.StatusBadRequest)
		return
	}

	// Validate enrichment: items must arrive fully enriched (L0+L1+embedding).
	// Hard reject incomplete items — the invariant is "no partial records in vault".
	if len(req.Targets) == 0 && req.TargetPersona != "" {
		if reason := validateEnrichment(req.ClassifiedItem); reason != "" {
			slog.Warn("staging.resolve: enrichment validation failed",
				"id", req.ID, "reason", reason)
			http.Error(w, `{"error":"`+reason+`"}`, http.StatusBadRequest)
			return
		}
	}
	for _, t := range req.Targets {
		if reason := validateEnrichment(t.ClassifiedItem); reason != "" {
			slog.Warn("staging.resolve: multi-target enrichment validation failed",
				"id", req.ID, "persona", t.Persona, "reason", reason)
			http.Error(w, `{"error":"`+reason+`"}`, http.StatusBadRequest)
			return
		}
	}

	// Multi-target resolve (cross-persona content).
	if len(req.Targets) > 0 {
		if err := h.Staging.ResolveMulti(r.Context(), req.ID, req.Targets); err != nil {
			clientError(w, "resolve failed", http.StatusInternalServerError, err)
			return
		}
	} else if req.TargetPersona != "" {
		// Single-target resolve.
		if err := h.Staging.Resolve(r.Context(), req.ID, req.TargetPersona, req.ClassifiedItem); err != nil {
			clientError(w, "resolve failed", http.StatusInternalServerError, err)
			return
		}
	} else {
		http.Error(w, `{"error":"missing target_persona or targets"}`, http.StatusBadRequest)
		return
	}

	// Determine the resulting status.
	status := "stored"
	pending, _ := h.Staging.ListByStatus(r.Context(), domain.StagingPendingUnlock, 1000)
	for _, item := range pending {
		if item.ID == req.ID {
			status = domain.StagingPendingUnlock
			break
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": req.ID, "status": status})
}

// failRequest is the JSON body for POST /v1/staging/fail.
type failRequest struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// HandleFail handles POST /v1/staging/fail. Brain calls this when
// classification fails for a staging item.
func (h *StagingHandler) HandleFail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req failRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.ID == "" {
		http.Error(w, `{"error":"missing id"}`, http.StatusBadRequest)
		return
	}

	if err := h.Staging.MarkFailed(r.Context(), req.ID, req.Error); err != nil {
		clientError(w, "mark failed failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": req.ID, "status": domain.StagingFailed})
}
