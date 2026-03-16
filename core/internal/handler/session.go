package handler

import (
	"encoding/json"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// SessionHandler exposes agent session management endpoints.
type SessionHandler struct {
	Sessions port.AgentSessionManager
}

type startSessionReq struct {
	Name string `json:"name"`
}

// HandleStartSession handles POST /v1/session/start.
func (h *SessionHandler) HandleStartSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req startSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}

	agentDID, _ := r.Context().Value(middleware.AgentDIDKey).(string)
	if agentDID == "" {
		http.Error(w, `{"error":"agent DID not found in context"}`, http.StatusUnauthorized)
		return
	}

	sess, err := h.Sessions.StartSession(r.Context(), agentDID, req.Name)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusConflict)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(sess)
}

type endSessionReq struct {
	Name string `json:"name"`
}

// HandleEndSession handles POST /v1/session/end.
func (h *SessionHandler) HandleEndSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req endSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}

	agentDID, _ := r.Context().Value(middleware.AgentDIDKey).(string)
	if err := h.Sessions.EndSession(r.Context(), agentDID, req.Name); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ended", "name": req.Name})
}

// HandleListSessions handles GET /v1/sessions.
func (h *SessionHandler) HandleListSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	agentDID, _ := r.Context().Value(middleware.AgentDIDKey).(string)
	sessions, err := h.Sessions.ListSessions(r.Context(), agentDID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	// Ensure empty list is [] not null in JSON
	if sessions == nil {
		sessions = []domain.AgentSession{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"sessions": sessions})
}
