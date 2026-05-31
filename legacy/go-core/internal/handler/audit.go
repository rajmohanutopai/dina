package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// AuditHandler exposes the audit log via HTTP for Brain and admin clients.
type AuditHandler struct {
	Auditor port.VaultAuditLogger
}

// auditAppendRequest is the JSON body for POST /v1/audit/append.
type auditAppendRequest struct {
	Action    string `json:"action"`
	Persona   string `json:"persona"`
	Requester string `json:"requester"`
	QueryType string `json:"query_type"`
	Reason    string `json:"reason"`
	Metadata  string `json:"metadata"`
}

// HandleAppend handles POST /v1/audit/append — write an audit entry.
func (h *AuditHandler) HandleAppend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req auditAppendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Action == "" {
		http.Error(w, `{"error":"action is required"}`, http.StatusBadRequest)
		return
	}

	entry := domain.VaultAuditEntry{
		Action:    req.Action,
		Persona:   req.Persona,
		Requester: req.Requester,
		QueryType: req.QueryType,
		Reason:    req.Reason,
		Metadata:  req.Metadata,
	}

	id, err := h.Auditor.Append(r.Context(), entry)
	if err != nil {
		http.Error(w, `{"error":"audit append failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
}

// auditEntryJSON is the JSON representation of a single audit entry.
type auditEntryJSON struct {
	ID        int64  `json:"id"`
	Timestamp string `json:"timestamp"`
	Persona   string `json:"persona"`
	Action    string `json:"action"`
	Requester string `json:"requester"`
	QueryType string `json:"query_type"`
	Reason    string `json:"reason"`
	Metadata  string `json:"metadata"`
}

// HandleQuery handles GET /v1/audit/query — read audit entries.
func (h *AuditHandler) HandleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 200 {
		limit = 200
	}

	filter := domain.VaultAuditFilter{
		Action:    q.Get("action"),
		Persona:   q.Get("persona"),
		Requester: q.Get("requester"),
		After:     q.Get("after"),
		Before:    q.Get("before"),
		Limit:     limit,
	}

	entries, err := h.Auditor.Query(r.Context(), filter)
	if err != nil {
		http.Error(w, `{"error":"audit query failed"}`, http.StatusInternalServerError)
		return
	}

	out := make([]auditEntryJSON, 0, len(entries))
	for _, e := range entries {
		out = append(out, auditEntryJSON{
			ID:        e.ID,
			Timestamp: e.Timestamp,
			Persona:   e.Persona,
			Action:    e.Action,
			Requester: e.Requester,
			QueryType: e.QueryType,
			Reason:    e.Reason,
			Metadata:  e.Metadata,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"entries": out})
}
