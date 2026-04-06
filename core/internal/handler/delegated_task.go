package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	mw "github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// DelegatedTaskHandler provides HTTP handlers for the delegated task API.
// Auth rules:
//   - Create, QueueByProposal: Brain (service key) or admin only
//   - Claim, Heartbeat, Complete, Fail, Progress: agent-role device only
//   - List, Get: admin sees all, agent sees own claimed only
type DelegatedTaskHandler struct {
	Tasks    port.DelegatedTaskStore
	Devices  *service.DeviceService          // for device role lookup
	Sessions port.AgentSessionManager        // for session teardown on terminal states (may be nil)
}

// --- Auth helpers ---

// callerInfo extracts caller identity from request context.
func callerInfo(r *http.Request) (callerType, agentDID, serviceID string) {
	callerType, _ = r.Context().Value(mw.CallerTypeKey).(string)
	agentDID = r.Header.Get("X-DID")
	if agentDID == "" {
		if did, ok := r.Context().Value(mw.AgentDIDKey).(string); ok {
			agentDID = did
		}
	}
	serviceID, _ = r.Context().Value(mw.ServiceIDKey).(string)
	return
}

// isBrainOrAdmin returns true if the caller is Brain service or admin.
func isBrainOrAdmin(callerType, serviceID string) bool {
	if callerType == "admin" || callerType == "user" {
		return true
	}
	return serviceID == "brain" || serviceID == "core"
}

// isAgentDevice checks if the caller is a device with role=agent.
func (h *DelegatedTaskHandler) isAgentDevice(r *http.Request, agentDID string) bool {
	if h.Devices == nil || agentDID == "" {
		return false
	}
	dev, err := h.Devices.GetDeviceByDID(r.Context(), agentDID)
	if err != nil || dev == nil {
		return false
	}
	return dev.Role == domain.DeviceRoleAgent
}

// --- Handlers ---

// HandleCreate handles POST /v1/agent/tasks — create a new delegated task.
func (h *DelegatedTaskHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	callerType, _, serviceID := callerInfo(r)
	if !isBrainOrAdmin(callerType, serviceID) {
		jsonError(w, "only Brain or admin can create delegated tasks", http.StatusForbidden)
		return
	}

	var req struct {
		ID               string `json:"id"`
		Description      string `json:"description"`
		Origin           string `json:"origin"`
		ProposalID       string `json:"proposal_id"`
		IdempotencyKey   string `json:"idempotency_key"`
		RequiresApproval bool   `json:"requires_approval"`
		RequestedRunner  string `json:"requested_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.ID == "" || req.Description == "" {
		jsonError(w, "id and description are required", http.StatusBadRequest)
		return
	}
	if req.Origin == "" {
		req.Origin = "telegram"
	}

	status := domain.DelegatedQueued
	if req.RequiresApproval {
		status = domain.DelegatedPendingApproval
	}

	task := domain.DelegatedTask{
		ID:              req.ID,
		ProposalID:      req.ProposalID,
		Description:     req.Description,
		Origin:          req.Origin,
		Status:          status,
		RequestedRunner: req.RequestedRunner,
		IdempotencyKey:  req.IdempotencyKey,
	}
	if err := h.Tasks.Create(r.Context(), task); err != nil {
		if errors.Is(err, port.ErrDelegatedTaskExists) {
			jsonError(w, "task already exists", http.StatusConflict)
		} else {
			jsonError(w, "failed to create task", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":     req.ID,
		"status": string(status),
	})
}

// HandleList handles GET /v1/agent/tasks.
func (h *DelegatedTaskHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	callerType, agentDID, serviceID := callerInfo(r)

	status := r.URL.Query().Get("status")
	tasks, err := h.Tasks.List(r.Context(), status, 50)
	if err != nil {
		jsonError(w, "failed to list tasks", http.StatusInternalServerError)
		return
	}

	// Agent devices only see their own claimed tasks.
	if !isBrainOrAdmin(callerType, serviceID) {
		filtered := make([]domain.DelegatedTask, 0)
		for _, t := range tasks {
			if t.AgentDID == agentDID {
				filtered = append(filtered, t)
			}
		}
		tasks = filtered
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tasks": tasks})
}

// HandleGet handles GET /v1/agent/tasks/{id}.
func (h *DelegatedTaskHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Reject unknown subpaths — only bare /v1/agent/tasks/{id} is valid here.
	taskID := extractTaskID(r.URL.Path)
	if taskID == "" || strings.Contains(taskID, "/") {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}

	callerType, agentDID, serviceID := callerInfo(r)
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	task, err := h.Tasks.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Agent devices can only see their own tasks.
	if !isBrainOrAdmin(callerType, serviceID) && task.AgentDID != agentDID {
		jsonError(w, "forbidden: not your task", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

// HandleQueueByProposal handles POST /v1/agent/tasks/queue-by-proposal.
func (h *DelegatedTaskHandler) HandleQueueByProposal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	callerType, _, serviceID := callerInfo(r)
	if !isBrainOrAdmin(callerType, serviceID) {
		jsonError(w, "only Brain or admin can queue tasks", http.StatusForbidden)
		return
	}

	var req struct {
		ProposalID string `json:"proposal_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ProposalID == "" {
		jsonError(w, "proposal_id is required", http.StatusBadRequest)
		return
	}

	if err := h.Tasks.QueueByProposalID(r.Context(), req.ProposalID); err != nil {
		jsonError(w, "failed to queue task", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
}

// HandleClaim handles POST /v1/agent/tasks/claim.
func (h *DelegatedTaskHandler) HandleClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can claim tasks", http.StatusForbidden)
		return
	}

	var req struct {
		LeaseSeconds int    `json:"lease_seconds"`
		RunnerFilter string `json:"runner_filter"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.LeaseSeconds <= 0 {
		req.LeaseSeconds = 300
	}

	task, err := h.Tasks.Claim(r.Context(), agentDID, req.LeaseSeconds, req.RunnerFilter)
	if err != nil {
		jsonError(w, "claim failed", http.StatusInternalServerError)
		return
	}
	if task == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

// HandleHeartbeat handles POST /v1/agent/tasks/{id}/heartbeat.
func (h *DelegatedTaskHandler) HandleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can heartbeat", http.StatusForbidden)
		return
	}

	taskID := extractSubTaskID(r.URL.Path, "/heartbeat")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		LeaseSeconds int `json:"lease_seconds"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.LeaseSeconds <= 0 {
		req.LeaseSeconds = 300
	}

	if err := h.Tasks.Heartbeat(r.Context(), taskID, agentDID, req.LeaseSeconds); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleComplete handles POST /v1/agent/tasks/{id}/complete.
func (h *DelegatedTaskHandler) HandleComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can complete tasks", http.StatusForbidden)
		return
	}

	taskID := extractSubTaskID(r.URL.Path, "/complete")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Result         string `json:"result"`
		AssignedRunner string `json:"assigned_runner"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	// Set assigned_runner before completing (inline runners skip "running" state).
	if req.AssignedRunner != "" {
		h.Tasks.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner)
	}

	if err := h.Tasks.Complete(r.Context(), taskID, agentDID, req.Result); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	// Session teardown (handler orchestration, not store concern).
	h.endTaskSession(r, taskID, agentDID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
}

// HandleFail handles POST /v1/agent/tasks/{id}/fail.
func (h *DelegatedTaskHandler) HandleFail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can fail tasks", http.StatusForbidden)
		return
	}

	taskID := extractSubTaskID(r.URL.Path, "/fail")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Error          string `json:"error"`
		AssignedRunner string `json:"assigned_runner"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.AssignedRunner != "" {
		h.Tasks.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner)
	}

	if err := h.Tasks.Fail(r.Context(), taskID, agentDID, req.Error); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	h.endTaskSession(r, taskID, agentDID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "failed"})
}

// HandleMarkRunning handles POST /v1/agent/tasks/{id}/running.
// Transitions claimed → running after a runner accepts execution.
func (h *DelegatedTaskHandler) HandleMarkRunning(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can mark tasks running", http.StatusForbidden)
		return
	}

	taskID := extractSubTaskID(r.URL.Path, "/running")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		RunID          string `json:"run_id"`
		AssignedRunner string `json:"assigned_runner"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if err := h.Tasks.MarkRunning(r.Context(), taskID, agentDID, req.RunID); err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	// Set assigned_runner if provided (separate update, same handler).
	if req.AssignedRunner != "" {
		h.Tasks.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "running"})
}

// HandleProgress handles POST /v1/agent/tasks/{id}/progress.
func (h *DelegatedTaskHandler) HandleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := callerInfo(r)
	if !h.isAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can update progress", http.StatusForbidden)
		return
	}

	taskID := extractSubTaskID(r.URL.Path, "/progress")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if err := h.Tasks.UpdateProgress(r.Context(), taskID, agentDID, req.Message); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// --- Session teardown ---

// endTaskSession ends the linked Dina session for a terminal task.
// Best-effort: "not found" is normal (race between claim and session_start).
// Other errors are logged but do not block task completion.
func (h *DelegatedTaskHandler) endTaskSession(r *http.Request, taskID, agentDID string) {
	if h.Sessions == nil {
		return
	}
	task, err := h.Tasks.GetByID(r.Context(), taskID)
	if err != nil || task == nil || task.SessionName == "" {
		return
	}
	err = h.Sessions.EndSession(r.Context(), agentDID, task.SessionName)
	if err != nil {
		// "not found" is normal (race between claim and session_start).
		// Other errors are logged but never block task completion.
		slog.Warn("delegated_task.session_end_failed",
			"task_id", taskID, "session", task.SessionName, "error", err)
	}
}

// --- Path helpers ---

// extractTaskID extracts the task ID from /v1/agent/tasks/{id} paths.
func extractTaskID(path string) string {
	const prefix = "/v1/agent/tasks/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	// Remove trailing slash or sub-path
	if idx := strings.Index(rest, "/"); idx >= 0 {
		return rest[:idx]
	}
	return rest
}

// extractSubTaskID extracts task ID from /v1/agent/tasks/{id}/suffix paths.
func extractSubTaskID(path, suffix string) string {
	const prefix = "/v1/agent/tasks/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	rest = strings.TrimSuffix(rest, suffix)
	rest = strings.TrimRight(rest, "/")
	return rest
}
