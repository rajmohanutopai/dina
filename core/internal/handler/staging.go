package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
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

// StagingHandler exposes staging inbox endpoints for the connector
// ingestion pipeline.
type StagingHandler struct {
	Staging port.StagingInbox
}

// ingestRequest is the JSON body for POST /v1/staging/ingest.
type ingestRequest struct {
	ConnectorID string `json:"connector_id"`
	Source      string `json:"source"`
	SourceID    string `json:"source_id"`
	Type        string `json:"type"`
	Summary     string `json:"summary"`
	Body        string `json:"body"`
	Sender      string `json:"sender"`
	Metadata    string `json:"metadata"`
}

// HandleIngest handles POST /v1/staging/ingest. It accepts a raw item from
// a connector and stores it in the staging inbox for Brain classification.
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

	item := domain.StagingItem{
		ConnectorID: req.ConnectorID,
		Source:      req.Source,
		SourceID:    req.SourceID,
		Type:        req.Type,
		Summary:     req.Summary,
		Body:        req.Body,
		Sender:      req.Sender,
		Metadata:    req.Metadata,
	}

	id, err := h.Staging.Ingest(r.Context(), item)
	if err != nil {
		clientError(w, "ingest failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id})
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
