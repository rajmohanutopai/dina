package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
)

// ApprovalHandler provides unified approval endpoints at /v1/approvals/.
// Delegates to PersonaHandler for the actual approve/deny/list logic.
// The old /v1/persona/{approve,deny,approvals} routes remain as aliases.
type ApprovalHandler struct {
	Persona *PersonaHandler
}

// HandleList handles GET /v1/approvals — list all pending approvals.
func (h *ApprovalHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	h.Persona.HandleListApprovals(w, r)
}

// HandleApprove handles POST /v1/approvals/{id}/approve.
// Extracts the approval ID from the URL path and delegates to PersonaHandler.
// CXH1: Only admin-scoped callers can approve — devices are blocked.
func (h *ApprovalHandler) HandleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// CXH1: Block device-scoped callers from approving their own requests.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType == "agent" {
		http.Error(w, `{"error":"forbidden","message":"approval mutations require admin access"}`, http.StatusForbidden)
		return
	}

	approvalID := extractApprovalID(r.URL.Path, "/approve")
	if approvalID == "" {
		http.Error(w, `{"error":"approval id is required in path"}`, http.StatusBadRequest)
		return
	}

	// Read scope from body. CXH1: reject malformed JSON — never silently
	// default to permissive values on parse failure.
	var body struct {
		Scope     string `json:"scope"`
		GrantedBy string `json:"granted_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if body.Scope == "" {
		body.Scope = "session"
	}
	if body.GrantedBy == "" {
		body.GrantedBy = "dina-admin"
	}

	// Build a synthetic request body and delegate to PersonaHandler.HandleApprove.
	h.delegateApproveOrDeny(w, r, approvalID, body.Scope, body.GrantedBy, true)
}

// HandleDeny handles POST /v1/approvals/{id}/deny.
// CXH1: Only admin-scoped callers can deny — devices are blocked.
func (h *ApprovalHandler) HandleDeny(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// CXH1: Block device-scoped callers from denying requests.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType == "agent" {
		http.Error(w, `{"error":"forbidden","message":"approval mutations require admin access"}`, http.StatusForbidden)
		return
	}

	approvalID := extractApprovalID(r.URL.Path, "/deny")
	if approvalID == "" {
		http.Error(w, `{"error":"approval id is required in path"}`, http.StatusBadRequest)
		return
	}

	h.delegateApproveOrDeny(w, r, approvalID, "", "", false)
}

// delegateApproveOrDeny calls the PersonaHandler's approve/deny logic directly,
// bypassing re-parsing of the request body.
func (h *ApprovalHandler) delegateApproveOrDeny(
	w http.ResponseWriter, r *http.Request,
	id, scope, grantedBy string, approve bool,
) {
	if h.Persona.Approvals == nil {
		http.Error(w, `{"error":"approvals not configured"}`, http.StatusNotImplemented)
		return
	}

	if approve {
		h.approveByID(w, r, id, scope, grantedBy)
	} else {
		h.denyByID(w, r, id)
	}
}

// approveByID approves an approval request by ID. Same logic as PersonaHandler.HandleApprove
// but with the ID extracted from the URL path rather than the request body.
func (h *ApprovalHandler) approveByID(w http.ResponseWriter, r *http.Request, id, scope, grantedBy string) {
	p := h.Persona

	// Get persona from the approval request before approving (need it for vault open).
	pending, _ := p.Approvals.ListPending(r.Context())
	var approvedPersona string
	for _, pr := range pending {
		if pr.ID == id {
			approvedPersona = pr.PersonaID
			break
		}
	}

	if err := p.Approvals.ApproveRequest(r.Context(), id, scope, grantedBy); err != nil {
		// GH4: generic error to caller; details logged server-side.
		slog.Warn("approval.approve_failed", "id", id, "error", err)
		http.Error(w, `{"error":"approval not found or already resolved"}`, http.StatusNotFound)
		return
	}

	p.completeApproval(r, id, approvedPersona)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "approved", "id": id})
}

func (h *ApprovalHandler) denyByID(w http.ResponseWriter, r *http.Request, id string) {
	p := h.Persona

	if err := p.Approvals.DenyRequest(r.Context(), id); err != nil {
		// GH4: generic error to caller; details logged server-side.
		slog.Warn("approval.deny_failed", "id", id, "error", err)
		http.Error(w, `{"error":"approval not found or already resolved"}`, http.StatusNotFound)
		return
	}

	// Mark any pending reason requests for this approval as denied.
	p.markPendingReasonsDenied(id)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "denied", "id": id})
}

// extractApprovalID extracts the approval ID from a URL path like
// /v1/approvals/{id}/approve or /v1/approvals/{id}/deny.
func extractApprovalID(path, suffix string) string {
	path = strings.TrimPrefix(path, "/v1/approvals/")
	path = strings.TrimSuffix(path, suffix)
	path = strings.TrimSuffix(path, "/")
	if path == "" || strings.Contains(path, "/") {
		return ""
	}
	return path
}
