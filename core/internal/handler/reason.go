package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ReasonHandler proxies reasoning requests to Brain with proper service-key auth.
// This is the persona-blind entry point for agents — Brain decides which
// personas to search via its LLM function-calling tools.
//
// The handler forwards the originating agent's DID and session name to Brain
// so that when Brain calls Core's vault APIs, the access is attributed to
// the correct agent and session (for approval/grant enforcement).
type ReasonHandler struct {
	Brain port.BrainClient
}

type reasonRequest struct {
	Prompt string `json:"prompt"`
}

// HandleReason handles POST /api/v1/reason.
func (h *ReasonHandler) HandleReason(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req reasonRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Prompt == "" {
		http.Error(w, `{"error":"prompt is required"}`, http.StatusBadRequest)
		return
	}

	// Determine caller context for Brain.
	// Agents: forward DID + session for per-agent access control.
	// Admin/user: forward source="admin" so Brain treats it as user-originated
	//             (enables auto-unlock of sensitive personas).
	var agentDID, sessionName, source string
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	switch callerType {
	case "agent":
		agentDID, _ = r.Context().Value(middleware.AgentDIDKey).(string)
		sessionName, _ = r.Context().Value(middleware.SessionNameKey).(string)
	case "user":
		source = "admin"
	}

	var result *domain.ReasonResult
	var err error
	if agentDID != "" {
		result, err = h.Brain.ReasonWithContext(r.Context(), req.Prompt, agentDID, sessionName)
	} else {
		result, err = h.Brain.ReasonAsUser(r.Context(), req.Prompt, source)
	}
	if err != nil {
		// If Brain returned approval_required, forward as 403 to the CLI
		// so the approval UX triggers properly.
		if strings.Contains(err.Error(), "approval_required") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{
				"error":   "approval_required",
				"message": "Access requires approval. A notification has been sent.",
			})
			return
		}
		http.Error(w, `{"error":"reasoning failed: `+err.Error()+`"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
