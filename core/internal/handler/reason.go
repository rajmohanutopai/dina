package handler

import (
	"context"
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

// fastPathReasonWait is how long HandleReason blocks waiting for Brain to
// finish before returning 202 and letting the CLI poll. Short enough to feel
// snappy for trivial asks, long enough to avoid most polls.
const fastPathReasonWait = 3 * time.Second

// ReasonHandler proxies reasoning requests to Brain with proper service-key auth.
// Supports async approval-wait-resume: when Brain needs persona approval, Core
// creates a PendingReasonRecord, returns 202, and resumes after approval.
// SessionValidator validates that an agent session is real and active.
type SessionValidator func(sessionID, agentDID string) bool

type ReasonHandler struct {
	Brain            port.BrainClient
	PendingReasons   port.PendingReasonStore // optional — nil disables async approval
	ValidateSession  SessionValidator        // optional — nil skips validation
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
		// Validate session is real and active. Reject fake/ended sessions.
		if h.ValidateSession != nil && sessionName != "" {
			if !h.ValidateSession(sessionName, agentDID) {
				http.Error(w, `{"error":"session not found or not active"}`, http.StatusForbidden)
				return
			}
		}
	case "user", "admin":
		source = "admin"
	}

	// Run Brain in a background goroutine. The fast-path below waits a few
	// seconds for a quick answer; if Brain takes longer (e.g. service queries
	// over D2D), we persist a pending record and return 202 so the caller can
	// poll. This decouples the caller's transport timeout from Brain's work.
	type brainOutcome struct {
		result *domain.ReasonResult
		err    error
	}
	// context.Background so the goroutine survives the caller's request
	// timeout. Brain calls still honour their own internal timeouts.
	bgCtx := context.Background()
	outcomeCh := make(chan brainOutcome, 1)
	go func() {
		var result *domain.ReasonResult
		var err error
		if agentDID != "" {
			result, err = h.Brain.ReasonWithContext(bgCtx, req.Prompt, agentDID, sessionName)
		} else {
			result, err = h.Brain.ReasonAsUser(bgCtx, req.Prompt, source)
		}
		outcomeCh <- brainOutcome{result: result, err: err}
	}()

	// Fast path — if Brain returns quickly, respond inline.
	select {
	case out := <-outcomeCh:
		h.finalizeReason(w, r, out.result, out.err, req.Prompt, agentDID, sessionName, source)
		return
	case <-time.After(fastPathReasonWait):
		// Fall through to async path below.
	}

	// Async path — persist a pending record, launch the finaliser goroutine,
	// return 202 with a request_id so the CLI can poll.
	if h.PendingReasons == nil {
		// No store → fall back to waiting for the outcome (legacy behaviour).
		out := <-outcomeCh
		h.finalizeReason(w, r, out.result, out.err, req.Prompt, agentDID, sessionName, source)
		return
	}

	requestID, err := h.createInFlightRecord(r.Context(), agentDID, sessionName, source, req.Prompt)
	if err != nil {
		slog.Warn("reason.create_inflight_failed", "error", err)
		http.Error(w, `{"error":"failed to track in-flight request"}`, http.StatusInternalServerError)
		return
	}

	// Finaliser goroutine — writes the outcome into the pending store when
	// Brain returns. Uses background context so it survives the HTTP handler.
	go func() {
		out := <-outcomeCh
		h.persistReasonOutcome(bgCtx, requestID, out.result, out.err, agentDID, sessionName, source, req.Prompt)
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"request_id": requestID,
		"status":     domain.ReasonInFlight,
		"message":    "Reasoning in progress. Poll GET /api/v1/ask/{request_id}/status for the result.",
	})
}

// finalizeReason writes the Brain outcome directly to the response (fast-path
// synchronous return). Shared by the in-line and the "no PendingReasons
// configured" legacy fallback path.
func (h *ReasonHandler) finalizeReason(
	w http.ResponseWriter, r *http.Request,
	result *domain.ReasonResult, err error,
	prompt, agentDID, sessionName, source string,
) {
	if err != nil {
		if strings.Contains(err.Error(), "approval_required") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{
				"error":   "approval_required",
				"message": "Access requires approval. A notification has been sent.",
			})
			return
		}
		slog.Warn("reason.failed", "error", err)
		http.Error(w, `{"error":"reasoning failed"}`, http.StatusBadGateway)
		return
	}
	if result != nil && result.Status == domain.ReasonPendingApproval {
		h.handlePendingApproval(w, r, result, prompt, agentDID, sessionName, source)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// createInFlightRecord persists a new pending_reason record with status=in_flight.
// Returns the generated request_id.
func (h *ReasonHandler) createInFlightRecord(ctx context.Context, agentDID, sessionName, source, prompt string) (string, error) {
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		return "", fmt.Errorf("generate request id: %w", err)
	}
	requestID := "reason-" + hex.EncodeToString(idBytes)

	callerDID := agentDID
	if callerDID == "" {
		callerDID = "admin"
	}
	meta, _ := json.Marshal(map[string]string{
		"prompt":    prompt,
		"source":    source,
		"agent_did": agentDID,
		"session":   sessionName,
	})
	now := time.Now().Unix()
	record := domain.PendingReasonRecord{
		RequestID:   requestID,
		CallerDID:   callerDID,
		SessionName: sessionName,
		Status:      domain.ReasonInFlight,
		RequestMeta: string(meta),
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + domain.DefaultPendingReasonTTL,
	}
	if err := h.PendingReasons.Create(ctx, record); err != nil {
		return "", fmt.Errorf("persist pending record: %w", err)
	}
	return requestID, nil
}

// persistReasonOutcome writes the Brain outcome into the pending store so
// the status endpoint can serve it to the polling caller.
func (h *ReasonHandler) persistReasonOutcome(
	ctx context.Context, requestID string,
	result *domain.ReasonResult, err error,
	agentDID, sessionName, source, prompt string,
) {
	if err != nil {
		if strings.Contains(err.Error(), "approval_required") {
			// Approval flow is handled separately — the fast path already
			// returned 403 to the caller. If we got here with an approval
			// error the caller is polling, so surface it as failed with a
			// clear message.
			_ = h.PendingReasons.UpdateStatus(ctx, requestID, domain.ReasonFailed, "", "approval_required")
			return
		}
		slog.Warn("reason.async_failed", "request_id", requestID, "error", err)
		_ = h.PendingReasons.UpdateStatus(ctx, requestID, domain.ReasonFailed, "", "reasoning failed")
		return
	}
	if result != nil && result.Status == domain.ReasonPendingApproval {
		// Async approval required — fold into the existing pending_approval
		// bookkeeping so the approval flow still works on this record.
		_ = h.PendingReasons.UpdateApprovalID(ctx, requestID, result.ApprovalID)
		_ = h.PendingReasons.UpdateStatus(ctx, requestID, domain.ReasonPendingApproval, "", "")
		return
	}
	resultJSON, _ := json.Marshal(result)
	if err := h.PendingReasons.UpdateStatus(ctx, requestID, domain.ReasonComplete, string(resultJSON), ""); err != nil {
		slog.Warn("reason.persist_complete_failed", "request_id", requestID, "error", err)
	}
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

	// Extract request_id from path: /api/v1/ask/{id}/status
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/ask/")
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
