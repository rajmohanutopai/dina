package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ReasonHandler proxies reasoning requests to Brain with proper service-key auth.
// Supports async approval-wait-resume: when Brain needs persona approval, Core
// creates a PendingReasonRecord, returns 202, and resumes after approval.
type ReasonHandler struct {
	Brain          port.BrainClient
	PendingReasons port.PendingReasonStore // optional — nil disables async approval
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
		// GH1: Log full error server-side; return generic message to caller.
		// err.Error() may contain vault context, model output, or PII.
		slog.Warn("reason.failed", "error", err)
		http.Error(w, `{"error":"reasoning failed"}`, http.StatusBadGateway)
		return
	}

	// Check if Brain returned pending_approval (async approval-wait-resume).
	if result != nil && result.Status == domain.ReasonPendingApproval {
		h.handlePendingApproval(w, r, result, req.Prompt, agentDID, sessionName, source)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handlePendingApproval creates a PendingReasonRecord and returns 202.
func (h *ReasonHandler) handlePendingApproval(
	w http.ResponseWriter, r *http.Request,
	result *domain.ReasonResult,
	prompt, agentDID, sessionName, source string,
) {
	if h.PendingReasons == nil {
		// Fallback: no pending store configured — return 403 like before
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "approval_required",
			"message": "Access requires approval. A notification has been sent.",
		})
		return
	}

	// Generate request ID
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, `{"error":"failed to generate request ID"}`, http.StatusInternalServerError)
		return
	}
	requestID := "reason-" + hex.EncodeToString(idBytes)

	// Determine the caller DID for binding
	callerDID := agentDID
	if callerDID == "" {
		callerDID, _ = r.Context().Value(middleware.AgentDIDKey).(string)
	}
	if callerDID == "" {
		callerDID = "admin"
	}

	// Build request metadata (only non-sensitive fields needed for replay)
	meta, _ := json.Marshal(map[string]string{
		"prompt":       prompt,
		"source":       source,
		"agent_did":    agentDID,
		"session":      sessionName,
		"persona_tier": result.Persona, // Brain puts the blocked persona here
	})

	now := time.Now().Unix()
	record := domain.PendingReasonRecord{
		RequestID:   requestID,
		CallerDID:   callerDID,
		SessionName: sessionName,
		ApprovalID:  result.ApprovalID,
		Status:      domain.ReasonPendingApproval,
		RequestMeta: string(meta),
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + int64(domain.DefaultPendingReasonTTL),
	}

	if err := h.PendingReasons.Create(r.Context(), record); err != nil {
		slog.Error("pending_reason: create failed", "error", err)
		// Fallback to 403
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "approval_required",
			"message": "Access requires approval. A notification has been sent.",
		})
		return
	}

	slog.Info("pending_reason: created",
		"request_id", requestID,
		"approval_id", result.ApprovalID,
		"persona", result.Persona,
		"caller", callerDID,
	)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(domain.ReasonAccepted{
		RequestID:  requestID,
		ApprovalID: result.ApprovalID,
		Persona:    result.Persona,
		Status:     domain.ReasonPendingApproval,
		Message:    fmt.Sprintf("Approval required for %s persona. A notification has been sent.", result.Persona),
	})
}

// HandleReasonResult handles POST /v1/reason/{id}/result.
// Called by Brain after completing a resumed reasoning request.
// Brain-only endpoint (service key auth required).
func (h *ReasonHandler) HandleReasonResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	if h.PendingReasons == nil {
		http.Error(w, `{"error":"async reasoning not configured"}`, http.StatusNotImplemented)
		return
	}

	// Extract request_id from path: /v1/reason/{id}/result
	path := r.URL.Path
	path = strings.TrimPrefix(path, "/v1/reason/")
	requestID := strings.TrimSuffix(path, "/result")
	if requestID == "" {
		http.Error(w, `{"error":"request_id is required"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		Status     string `json:"status"`
		Content    string `json:"content"`
		Model      string `json:"model"`
		Error      string `json:"error"`
		ApprovalID string `json:"approval_id"` // for second-approval cycle
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	status := body.Status
	if status == "" {
		status = domain.ReasonComplete
	}

	result := ""
	if body.Content != "" {
		resultJSON, _ := json.Marshal(map[string]interface{}{
			"content": body.Content,
			"model":   body.Model,
		})
		result = string(resultJSON)
	}

	if err := h.PendingReasons.UpdateStatus(r.Context(), requestID, status, result, body.Error); err != nil {
		http.Error(w, `{"error":"update failed"}`, http.StatusInternalServerError)
		return
	}

	// If cycling back to pending_approval (second persona), update approval_id
	// so HandleApprove can find and resume this request again.
	if status == domain.ReasonPendingApproval && body.ApprovalID != "" {
		_ = h.PendingReasons.UpdateApprovalID(r.Context(), requestID, body.ApprovalID)
	}

	slog.Info("pending_reason: result submitted",
		"request_id", requestID,
		"status", status,
	)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleReasonStatus handles GET /api/v1/reason/{id}/status.
// Caller-bound: only the original requester can read the result.
func (h *ReasonHandler) HandleReasonStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	if h.PendingReasons == nil {
		http.Error(w, `{"error":"async reasoning not configured"}`, http.StatusNotImplemented)
		return
	}

	// Extract request_id from path: /api/v1/reason/{id}/status
	path := r.URL.Path
	// Strip /api/v1/reason/ prefix and /status suffix
	path = strings.TrimPrefix(path, "/api/v1/reason/")
	requestID := strings.TrimSuffix(path, "/status")
	if requestID == "" || requestID == path {
		http.Error(w, `{"error":"request_id is required"}`, http.StatusBadRequest)
		return
	}

	// Get caller DID for access control
	callerDID, _ := r.Context().Value(middleware.AgentDIDKey).(string)
	if callerDID == "" {
		callerDID = "admin"
	}

	record, err := h.PendingReasons.GetByID(r.Context(), requestID, callerDID)
	if err != nil {
		if strings.Contains(err.Error(), "access denied") {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}
		http.Error(w, `{"error":"status check failed"}`, http.StatusInternalServerError)
		return
	}
	if record == nil {
		http.Error(w, `{"error":"request not found"}`, http.StatusNotFound)
		return
	}

	// Build response
	resp := domain.ReasonStatusResponse{
		RequestID: record.RequestID,
		Status:    record.Status,
		Error:     record.Error,
	}

	// If complete, include the result
	if record.Status == domain.ReasonComplete && record.Result != "" {
		var resultData map[string]interface{}
		if json.Unmarshal([]byte(record.Result), &resultData) == nil {
			if content, ok := resultData["content"].(string); ok {
				resp.Content = content
			}
			if model, ok := resultData["model"].(string); ok {
				resp.Model = model
			}
			if ti, ok := resultData["tokens_in"].(float64); ok {
				resp.TokensIn = int(ti)
			}
			if to, ok := resultData["tokens_out"].(float64); ok {
				resp.TokensOut = int(to)
			}
			if vcu, ok := resultData["vault_context_used"].(bool); ok {
				resp.VaultContextUsed = vcu
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
