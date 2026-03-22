package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Tracer emits structured trace events for request debugging.
// Passed to middleware/handlers/services to record request flow steps.
// Nil-safe — all methods are no-ops when store is nil.
type Tracer struct {
	Store port.TraceStore
}

// Emit records a trace event for the current request.
// Extracts req_id from context. No-op if req_id is empty or store is nil.
func (t *Tracer) Emit(ctx context.Context, step, component string, detail map[string]string) {
	if t == nil || t.Store == nil {
		return
	}
	rid, _ := ctx.Value(middleware.RequestIDKey).(string)
	if rid == "" {
		return
	}
	detailJSON, _ := json.Marshal(detail)
	_ = t.Store.Append(rid, step, component, string(detailJSON))
}

// TraceHandler exposes GET /v1/trace/{req_id} for admin debugging.
type TraceHandler struct {
	Store port.TraceStore
}

// HandleQuery returns all trace events for a given request ID.
// Admin only — enforced at handler level + auth checker.
func (h *TraceHandler) HandleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Nil-safe: tracing disabled in no-CGO mode.
	if h.Store == nil {
		jsonError(w, "tracing not available (no-CGO mode)", http.StatusServiceUnavailable)
		return
	}

	// Admin-only enforcement at handler level.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "admin" && callerType != "user" {
		jsonError(w, "admin only", http.StatusForbidden)
		return
	}

	// Extract req_id from URL path: /v1/trace/{req_id}
	path := r.URL.Path
	reqID := strings.TrimPrefix(path, "/v1/trace/")
	reqID = strings.TrimRight(reqID, "/")
	if reqID == "" {
		jsonError(w, "req_id required", http.StatusBadRequest)
		return
	}

	events, err := h.Store.Query(r.Context(), reqID)
	if err != nil {
		jsonError(w, "trace query failed", http.StatusInternalServerError)
		return
	}

	// Parse detail strings into objects for structured output.
	type traceEvent struct {
		TsMs      int64            `json:"ts_ms"`
		Step      string           `json:"step"`
		Component string           `json:"component"`
		Detail    json.RawMessage  `json:"detail"`
	}

	out := make([]traceEvent, len(events))
	for i, e := range events {
		out[i] = traceEvent{
			TsMs:      e.TsMs,
			Step:      e.Step,
			Component: e.Component,
			Detail:    json.RawMessage(e.Detail),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"req_id": reqID,
		"events": out,
	})
}
