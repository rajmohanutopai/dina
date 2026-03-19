package handler

import (
	"encoding/json"
	"net/http"
	"strings"
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
func (h *ApprovalHandler) HandleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	approvalID := extractApprovalID(r.URL.Path, "/approve")
	if approvalID == "" {
		http.Error(w, `{"error":"approval id is required in path"}`, http.StatusBadRequest)
		return
	}

	// Read optional scope from body (default: session).
	var body struct {
		Scope     string `json:"scope"`
		GrantedBy string `json:"granted_by"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
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
func (h *ApprovalHandler) HandleDeny(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
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
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	// Open the vault for the approved persona if not already open.
	p.openVaultForApproval(r, approvedPersona)

	// Trigger resume for any pending reason requests linked to this approval.
	if p.PendingReasons != nil && p.Brain != nil {
		go p.resumePendingReasons(id)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "approved", "id": id})
}

func (h *ApprovalHandler) denyByID(w http.ResponseWriter, r *http.Request, id string) {
	p := h.Persona

	if err := p.Approvals.DenyRequest(r.Context(), id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
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
