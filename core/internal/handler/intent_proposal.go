package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// IntentProposalHandler proxies intent proposal lifecycle operations
// between admin/agent clients and Brain's guardian. It provides the HTTP
// surface for the proposal approval flow.
//
// Access control:
//   - Admin (CLIENT_TOKEN): can list, approve, deny all proposals
//   - Agent device (Ed25519): can poll status of its own proposals only
//   - Agents cannot approve/deny — only admin can
type IntentProposalHandler struct {
	// Brain forwards events to Brain's guardian via ProcessEventWithContext.
	Brain interface {
		ProcessEventWithContext(ctx context.Context, event []byte) ([]byte, error)
	}

	// BrainHTTP fetches data from Brain's HTTP API (proposals endpoint).
	BrainHTTP interface {
		GetProposalStatus(proposalID string) ([]byte, error)
		ListProposals() ([]byte, error)
	}

	// DelegatedTasks queues linked delegated tasks on approval.
	// May be nil if CGO is unavailable.
	DelegatedTasks port.DelegatedTaskStore
}

// HandleApprove handles POST /v1/intent/proposals/{id}/approve.
// Admin only — sends intent_approved event to Brain, then queues any linked delegated task.
func (h *IntentProposalHandler) HandleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Admin only.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "admin" && callerType != "user" {
		jsonError(w, "only admin can approve intent proposals", http.StatusForbidden)
		return
	}

	proposalID := extractPathParam(r.URL.Path, "/v1/intent/proposals/", "/approve")
	if proposalID == "" {
		jsonError(w, "proposal_id required", http.StatusBadRequest)
		return
	}

	event, _ := json.Marshal(map[string]interface{}{
		"type": "intent_approved",
		"payload": map[string]string{
			"proposal_id": proposalID,
		},
	})

	resp, err := h.Brain.ProcessEventWithContext(r.Context(), event)
	if err != nil {
		jsonError(w, "brain unavailable", http.StatusBadGateway)
		return
	}

	// Redundant idempotent queue — Guardian already queues in _handle_intent_approved,
	// but this catches the case where Core's endpoint is called directly (dina-admin).
	if h.DelegatedTasks != nil {
		if qErr := h.DelegatedTasks.QueueByProposalID(r.Context(), proposalID); qErr != nil {
			slog.Warn("delegated_task.queue_on_approve_failed",
				"proposal_id", proposalID, "error", qErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(resp)
}

// HandleDeny handles POST /v1/intent/proposals/{id}/deny.
// Admin only — sends intent_denied event to Brain.
func (h *IntentProposalHandler) HandleDeny(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "admin" && callerType != "user" {
		jsonError(w, "only admin can deny intent proposals", http.StatusForbidden)
		return
	}

	proposalID := extractPathParam(r.URL.Path, "/v1/intent/proposals/", "/deny")
	if proposalID == "" {
		jsonError(w, "proposal_id required", http.StatusBadRequest)
		return
	}

	var body struct {
		Reason string `json:"reason"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	event, _ := json.Marshal(map[string]interface{}{
		"type": "intent_denied",
		"payload": map[string]interface{}{
			"proposal_id": proposalID,
			"reason":      body.Reason,
		},
	})

	resp, err := h.Brain.ProcessEventWithContext(r.Context(), event)
	if err != nil {
		jsonError(w, "brain unavailable", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(resp)
}

// HandleStatus handles GET /v1/intent/proposals/{id}/status.
// Agent devices can query their own proposals; admin can query any.
func (h *IntentProposalHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	proposalID := extractLastSegment(r.URL.Path, "/v1/intent/proposals/")
	// Strip trailing /status if present
	proposalID = strings.TrimSuffix(proposalID, "/status")
	if proposalID == "" {
		jsonError(w, "proposal_id required", http.StatusBadRequest)
		return
	}

	if h.BrainHTTP == nil {
		jsonError(w, "proposal status not available", http.StatusServiceUnavailable)
		return
	}

	resp, err := h.BrainHTTP.GetProposalStatus(proposalID)
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			jsonError(w, "unknown proposal_id", http.StatusNotFound)
		} else {
			jsonError(w, "brain unavailable", http.StatusBadGateway)
		}
		return
	}

	// Ownership check: agent devices can only see their own proposals.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "admin" && callerType != "user" {
		// Get caller identity from X-DID (signature auth) or context (bearer auth).
		callerDID := r.Header.Get("X-DID")
		if callerDID == "" {
			if deviceID, ok := r.Context().Value(middleware.AgentDIDKey).(string); ok && deviceID != "" {
				callerDID = "device:" + deviceID
			}
		}
		if callerDID != "" {
			var proposal struct {
				AgentDID string `json:"agent_did"`
			}
			json.Unmarshal(resp, &proposal)
			if proposal.AgentDID != "" && proposal.AgentDID != callerDID {
				jsonError(w, "forbidden: not your proposal", http.StatusForbidden)
				return
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(resp)
}

// HandleList handles GET /v1/intent/proposals. Admin only.
func (h *IntentProposalHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "admin" && callerType != "user" {
		jsonError(w, "admin only", http.StatusForbidden)
		return
	}

	if h.BrainHTTP == nil {
		jsonError(w, "proposal listing not available", http.StatusServiceUnavailable)
		return
	}

	resp, err := h.BrainHTTP.ListProposals()
	if err != nil {
		jsonError(w, "brain unavailable", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(resp)
}

// extractPathParam extracts the value between prefix and suffix in a URL path.
func extractPathParam(path, prefix, suffix string) string {
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	if idx := strings.Index(rest, suffix); idx >= 0 {
		return rest[:idx]
	}
	return rest
}

// extractLastSegment returns the portion of path after the given prefix,
// with any trailing slash removed.
func extractLastSegment(path, prefix string) string {
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimRight(path[len(prefix):], "/")
}
