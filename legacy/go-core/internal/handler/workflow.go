package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	mw "github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// WorkflowHandler provides HTTP handlers for the workflow task API.
// Auth rules:
//   - Create, QueueByProposal, Cancel: Brain (service key) or admin only
//   - Claim, Heartbeat, MarkRunning, Progress: agent-role device only (kind=delegation)
//   - Complete, Fail: agent-role device only (kind=delegation)
//   - List, Get: admin/brain sees all, agent sees own claimed only
//   - EventAck: Brain or admin only
type WorkflowHandler struct {
	Workflow *service.WorkflowService
	Devices  *service.DeviceService          // for device role lookup
	Sessions port.AgentSessionManager        // for session teardown on terminal states (may be nil)
}

// --- Auth helpers ---

// workflowCallerInfo extracts caller identity from request context.
func workflowCallerInfo(r *http.Request) (callerType, agentDID, serviceID string) {
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

// isWorkflowBrainOrAdmin returns true if the caller is Brain service or admin.
func isWorkflowBrainOrAdmin(callerType, serviceID string) bool {
	if callerType == "admin" || callerType == "user" {
		return true
	}
	return serviceID == "brain" || serviceID == "core"
}

// isWorkflowAgentDevice checks if the caller is a device with role=agent.
func (h *WorkflowHandler) isWorkflowAgentDevice(r *http.Request, agentDID string) bool {
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

// HandleCreate handles POST /v1/workflow/tasks — create a new workflow task.
func (h *WorkflowHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	callerType, _, serviceID := workflowCallerInfo(r)
	if !isWorkflowBrainOrAdmin(callerType, serviceID) {
		jsonError(w, "only Brain or admin can create workflow tasks", http.StatusForbidden)
		return
	}

	var req struct {
		ID               string `json:"id"`
		Kind             string `json:"kind"`
		Description      string `json:"description"`
		Origin           string `json:"origin"`
		ProposalID       string `json:"proposal_id"`
		CorrelationID    string `json:"correlation_id"`
		ParentID         string `json:"parent_id"`
		Priority         string `json:"priority"`
		Payload          string `json:"payload"`
		PayloadType      string `json:"payload_type"`
		Policy           string `json:"policy"`
		IdempotencyKey   string `json:"idempotency_key"`
		RequiresApproval bool   `json:"requires_approval"`
		RequestedRunner  string `json:"requested_runner"`
		ExpiresAt        int64  `json:"expires_at"`
		NextRunAt        int64  `json:"next_run_at"`
		Recurrence       string `json:"recurrence"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.ID == "" || req.Description == "" {
		jsonError(w, "id and description are required", http.StatusBadRequest)
		return
	}
	if req.Kind == "" {
		req.Kind = string(domain.WFKindDelegation)
	}
	// Validate kind against known domain kinds.
	if !isValidWorkflowKind(req.Kind) {
		jsonError(w, "invalid kind: "+req.Kind, http.StatusBadRequest)
		return
	}
	if req.Origin == "" {
		req.Origin = "telegram"
	}
	// Validate origin against domain's allowed origins.
	if !isValidWorkflowOrigin(req.Origin) {
		jsonError(w, "invalid origin: "+req.Origin, http.StatusBadRequest)
		return
	}
	if req.Priority == "" {
		req.Priority = string(domain.WFPriorityNormal)
	}
	// Validate priority.
	if !isValidWorkflowPriority(req.Priority) {
		jsonError(w, "invalid priority: "+req.Priority, http.StatusBadRequest)
		return
	}

	// Determine initial status based on task kind.
	var status string
	switch req.Kind {
	case string(domain.WFKindDelegation):
		status = string(domain.WFQueued)
		if req.RequiresApproval {
			status = string(domain.WFPendingApproval)
		}
	case string(domain.WFKindApproval):
		// WS2: approval tasks start in pending_approval (awaiting operator review).
		status = string(domain.WFPendingApproval)
	default:
		status = string(domain.WFCreated)
	}

	task := domain.WorkflowTask{
		ID:              req.ID,
		Kind:            req.Kind,
		PayloadType:     req.PayloadType,
		Status:          status,
		CorrelationID:   req.CorrelationID,
		ParentID:        req.ParentID,
		ProposalID:      req.ProposalID,
		Priority:        req.Priority,
		Description:     req.Description,
		Payload:         req.Payload,
		Policy:          req.Policy,
		Origin:          req.Origin,
		RequestedRunner: req.RequestedRunner,
		IdempotencyKey:  req.IdempotencyKey,
		ExpiresAt:       req.ExpiresAt,
		NextRunAt:       req.NextRunAt,
		Recurrence:      req.Recurrence,
	}
	if err := h.Workflow.Create(r.Context(), task); err != nil {
		if strings.Contains(err.Error(), "already exists") {
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
		"status": status,
	})
}

// HandleList handles GET /v1/workflow/tasks.
func (h *WorkflowHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	callerType, agentDID, serviceID := workflowCallerInfo(r)

	// Parse query parameters.
	var states []string
	if s := r.URL.Query().Get("status"); s != "" {
		states = strings.Split(s, ",")
	}
	var kinds []string
	if k := r.URL.Query().Get("kind"); k != "" {
		kinds = strings.Split(k, ",")
	}

	// Agent devices only see their own delegation tasks.
	filterDID := ""
	if !isWorkflowBrainOrAdmin(callerType, serviceID) {
		filterDID = agentDID
		// Agents can only see delegation tasks — enforce kind filter.
		kinds = []string{string(domain.WFKindDelegation)}
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, parseErr := strconv.Atoi(l); parseErr == nil && parsed > 0 && parsed <= 500 {
			limit = parsed
		}
	}
	oldestFirst := r.URL.Query().Get("order") == "oldest"
	tasks, err := h.Workflow.Store().ListOrdered(r.Context(), states, kinds, filterDID, limit, oldestFirst)
	if err != nil {
		jsonError(w, "failed to list tasks", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tasks": tasks})
}

// HandleGet handles GET /v1/workflow/tasks/{id}.
func (h *WorkflowHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Reject unknown subpaths — only bare /v1/workflow/tasks/{id} is valid here.
	taskID := extractWorkflowTaskID(r.URL.Path)
	if taskID == "" || strings.Contains(taskID, "/") {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}

	callerType, agentDID, serviceID := workflowCallerInfo(r)

	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Agent devices can only see their own delegation tasks.
	if !isWorkflowBrainOrAdmin(callerType, serviceID) {
		if task.Kind != string(domain.WFKindDelegation) {
			jsonError(w, "task not found", http.StatusNotFound)
			return
		}
		if task.AgentDID != agentDID {
			jsonError(w, "forbidden: not your task", http.StatusForbidden)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

// HandleQueueByProposal handles POST /v1/workflow/tasks/queue-by-proposal.
func (h *WorkflowHandler) HandleQueueByProposal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	callerType, _, serviceID := workflowCallerInfo(r)
	if !isWorkflowBrainOrAdmin(callerType, serviceID) {
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

	if err := h.Workflow.QueueByProposalID(r.Context(), req.ProposalID); err != nil {
		jsonError(w, "failed to queue task", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
}

// HandleClaim handles POST /v1/workflow/tasks/claim.
// Queue-style: no {id} — atomically grabs the oldest queued delegation task.
func (h *WorkflowHandler) HandleClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := workflowCallerInfo(r)
	if !h.isWorkflowAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can claim tasks", http.StatusForbidden)
		return
	}

	var req struct {
		LeaseSeconds int    `json:"lease_seconds"`
		RunnerFilter string `json:"runner_filter"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.LeaseSeconds <= 0 {
		req.LeaseSeconds = 300
	}

	task, err := h.Workflow.Claim(r.Context(), agentDID, req.LeaseSeconds, req.RunnerFilter)
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

// HandleMarkRunning handles POST /v1/workflow/tasks/{id}/running.
// Transitions claimed -> running after a runner accepts execution.
// Delegation-specific: verifies task kind is "delegation".
func (h *WorkflowHandler) HandleMarkRunning(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := workflowCallerInfo(r)
	if !h.isWorkflowAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can mark tasks running", http.StatusForbidden)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/running")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	// Verify delegation kind.
	if !h.verifyDelegationKind(w, r, taskID) {
		return
	}

	var req struct {
		RunID          string `json:"run_id"`
		AssignedRunner string `json:"assigned_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.Workflow.MarkRunning(r.Context(), taskID, agentDID, req.RunID); err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	// Set assigned_runner if provided (advisory — errors logged, not fatal).
	if req.AssignedRunner != "" {
		if runnerErr := h.Workflow.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner); runnerErr != nil {
			slog.Warn("workflow.running.set_runner_failed", "task_id", taskID, "error", runnerErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "running"})
}

// HandleHeartbeat handles POST /v1/workflow/tasks/{id}/heartbeat.
// Delegation-specific: verifies task kind is "delegation".
func (h *WorkflowHandler) HandleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := workflowCallerInfo(r)
	if !h.isWorkflowAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can heartbeat", http.StatusForbidden)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/heartbeat")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	// Verify delegation kind.
	if !h.verifyDelegationKind(w, r, taskID) {
		return
	}

	var req struct {
		LeaseSeconds int `json:"lease_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.LeaseSeconds <= 0 {
		req.LeaseSeconds = 300
	}

	if err := h.Workflow.Heartbeat(r.Context(), taskID, agentDID, req.LeaseSeconds); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleProgress handles POST /v1/workflow/tasks/{id}/progress.
// Delegation-specific: verifies task kind is "delegation".
func (h *WorkflowHandler) HandleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, agentDID, _ := workflowCallerInfo(r)
	if !h.isWorkflowAgentDevice(r, agentDID) {
		jsonError(w, "only agent-role devices can update progress", http.StatusForbidden)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/progress")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	// Verify delegation kind.
	if !h.verifyDelegationKind(w, r, taskID) {
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if err := h.Workflow.UpdateProgress(r.Context(), taskID, agentDID, req.Message); err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleComplete handles POST /v1/workflow/tasks/{id}/complete.
// Auth split by task kind:
//   - delegation: agent-role device required, agent_did must match
//   - other kinds: Brain service-key or admin required (agent-role rejected)
func (h *WorkflowHandler) HandleComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/complete")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	callerType, agentDID, serviceID := workflowCallerInfo(r)

	// Look up the task to determine kind-based auth.
	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// effectiveDID is the agent_did passed to Complete for ownership checks.
	// For delegation tasks, it's the agent's DID. For non-delegation tasks
	// (Brain/admin path), it's empty — no ownership check needed.
	var effectiveDID string

	if task.Kind == string(domain.WFKindDelegation) {
		// Delegation tasks: only agent-role devices, must own the task.
		if !h.isWorkflowAgentDevice(r, agentDID) {
			jsonError(w, "only agent-role devices can complete delegation tasks", http.StatusForbidden)
			return
		}
		if task.AgentDID != agentDID {
			jsonError(w, "forbidden: not your task", http.StatusForbidden)
			return
		}
		effectiveDID = agentDID
	} else {
		// Non-delegation tasks: Brain or admin only.
		if !isWorkflowBrainOrAdmin(callerType, serviceID) {
			jsonError(w, "only Brain or admin can complete non-delegation tasks", http.StatusForbidden)
			return
		}
		// effectiveDID remains "" — no ownership check for non-delegation tasks.
	}

	var req struct {
		Result         string `json:"result"`
		AssignedRunner string `json:"assigned_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	eventID, err := h.Workflow.Complete(r.Context(), taskID, effectiveDID, req.Result)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	// Set assigned_runner only if the transition actually happened (not a no-op).
	if eventID > 0 && req.AssignedRunner != "" {
		if runnerErr := h.Workflow.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner); runnerErr != nil {
			slog.Warn("workflow.complete.set_runner_failed", "task_id", taskID, "error", runnerErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
}

// HandleFail handles POST /v1/workflow/tasks/{id}/fail.
// Auth split by task kind:
//   - delegation: agent-role device required, agent_did must match
//   - other kinds: Brain service-key or admin required (agent-role rejected)
func (h *WorkflowHandler) HandleFail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/fail")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	callerType, agentDID, serviceID := workflowCallerInfo(r)

	// Look up the task to determine kind-based auth.
	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// effectiveDID: delegation tasks use agentDID for ownership; non-delegation
	// tasks pass empty string (Brain/admin — no ownership check).
	var effectiveDID string

	if task.Kind == string(domain.WFKindDelegation) {
		// Delegation tasks: only agent-role devices, must own the task.
		if !h.isWorkflowAgentDevice(r, agentDID) {
			jsonError(w, "only agent-role devices can fail delegation tasks", http.StatusForbidden)
			return
		}
		if task.AgentDID != agentDID {
			jsonError(w, "forbidden: not your task", http.StatusForbidden)
			return
		}
		effectiveDID = agentDID
	} else {
		// Non-delegation tasks: Brain or admin only.
		if !isWorkflowBrainOrAdmin(callerType, serviceID) {
			jsonError(w, "only Brain or admin can fail non-delegation tasks", http.StatusForbidden)
			return
		}
		// effectiveDID remains "" — no ownership check for non-delegation tasks.
	}

	var req struct {
		Error          string `json:"error"`
		AssignedRunner string `json:"assigned_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	eventID, err := h.Workflow.Fail(r.Context(), taskID, effectiveDID, req.Error)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	// Set assigned_runner only if the transition actually happened (not a no-op).
	if eventID > 0 && req.AssignedRunner != "" {
		if runnerErr := h.Workflow.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner); runnerErr != nil {
			slog.Warn("workflow.fail.set_runner_failed", "task_id", taskID, "error", runnerErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "failed"})
}

// HandleCancel handles POST /v1/workflow/tasks/{id}/cancel.
// Brain or admin only — cancels any task regardless of kind.
func (h *WorkflowHandler) HandleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	callerType, _, serviceID := workflowCallerInfo(r)
	if !isWorkflowBrainOrAdmin(callerType, serviceID) {
		jsonError(w, "only Brain or admin can cancel tasks", http.StatusForbidden)
		return
	}

	taskID := extractWorkflowSubTaskID(r.URL.Path, "/cancel")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	// Prefetch task to distinguish 404 from already-terminal no-op.
	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}
	// Already terminal — return 200 no-op.
	if domain.IsTerminal(domain.WorkflowTaskState(task.Status)) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": task.Status, "noop": "true"})
		return
	}

	if _, err := h.Workflow.Cancel(r.Context(), taskID); err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"})
}

// HandleApprove handles POST /v1/workflow/tasks/{id}/approve.
// Brain service-key only. Transitions pending_approval → queued + emits event with task_payload.
func (h *WorkflowHandler) HandleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	_, _, serviceID := workflowCallerInfo(r)
	if serviceID != "brain" {
		http.Error(w, `{"error":"brain service-key required"}`, http.StatusForbidden)
		return
	}

	taskID := extractPathID(r, "/v1/workflow/tasks/", "/approve")
	if taskID == "" {
		http.Error(w, `{"error":"task ID required"}`, http.StatusBadRequest)
		return
	}

	eventID, err := h.Workflow.Store().Approve(r.Context(), taskID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "queued",
		"event_id": eventID,
	})
}

// extractPathID extracts a task/event ID from a URL path with prefix and suffix.
// e.g., extractPathID(r, "/v1/workflow/tasks/", "/approve") on "/v1/workflow/tasks/abc/approve" → "abc".
func extractPathID(r *http.Request, prefix, suffix string) string {
	path := r.URL.Path
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	if suffix != "" {
		if !strings.HasSuffix(rest, suffix) {
			return ""
		}
		rest = rest[:len(rest)-len(suffix)]
	}
	return rest
}

// HandleEventAck handles POST /v1/workflow/events/{id}/ack.
// Brain service-key only — acknowledges a delivered event.
// Admin is excluded: event delivery targets Brain, so only Brain should ACK.
func (h *WorkflowHandler) HandleEventAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, _, serviceID := workflowCallerInfo(r)
	if serviceID != "brain" {
		jsonError(w, "only Brain service can acknowledge events", http.StatusForbidden)
		return
	}

	eventIDStr := extractWorkflowEventID(r.URL.Path)
	if eventIDStr == "" {
		jsonError(w, "event_id required", http.StatusBadRequest)
		return
	}
	eventID, err := strconv.ParseInt(eventIDStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid event_id", http.StatusBadRequest)
		return
	}

	if err := h.Workflow.MarkEventAcknowledged(r.Context(), eventID); err != nil {
		if strings.Contains(err.Error(), "not found") {
			jsonError(w, err.Error(), http.StatusNotFound)
		} else {
			jsonError(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "acknowledged"})
}

// --- Internal callback handlers (for OpenClaw agent_end hooks) ---

// WorkflowCallbackHandler handles terminal callbacks from OpenClaw's
// agent_end hook. Internal endpoints authenticated by a pre-shared Bearer token.
type WorkflowCallbackHandler struct {
	Workflow      *service.WorkflowService
	CallbackToken string // pre-shared secret for OpenClaw hooks
}

// verifyCallbackToken checks the Bearer token with constant-time comparison.
func (h *WorkflowCallbackHandler) verifyCallbackToken(r *http.Request) bool {
	if h.CallbackToken == "" {
		return false
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := strings.TrimPrefix(auth, "Bearer ")
	return len(token) == len(h.CallbackToken) && subtle_compare(token, h.CallbackToken)
}

// HandleComplete handles POST /v1/internal/workflow-tasks/{id}/complete.
func (h *WorkflowCallbackHandler) HandleComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyCallbackToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractWorkflowCallbackTaskID(r.URL.Path, "/complete")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	// ResultJSON carries the full structured agent output; Result is the
	// optional human-readable summary for UI/logs. The service-query bridge
	// consumes ResultJSON, so truncating it (as the old openclaw_hook did
	// when stuffing JSON into a short text field) produced invalid responses.
	var req struct {
		Result         string          `json:"result"`
		ResultJSON     json.RawMessage `json:"result_json,omitempty"`
		AssignedRunner string          `json:"assigned_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Look up the task to get agent_did.
	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Internal callbacks only operate on delegation tasks.
	if task.Kind != string(domain.WFKindDelegation) {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Idempotent: already terminal
	if domain.IsTerminal(domain.WorkflowTaskState(task.Status)) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": task.Status, "noop": "true"})
		return
	}

	var eventID int64
	if len(req.ResultJSON) > 0 {
		eventID, err = h.Workflow.CompleteWithDetails(r.Context(), taskID, task.AgentDID, req.Result, string(req.ResultJSON), "")
	} else {
		eventID, err = h.Workflow.Complete(r.Context(), taskID, task.AgentDID, req.Result)
	}
	if err != nil {
		slog.Warn("callback.complete_failed", "task_id", taskID, "error", err)
		jsonError(w, "complete failed", http.StatusInternalServerError)
		return
	}

	// Set assigned_runner only after successful transition (not on no-op).
	if eventID > 0 && req.AssignedRunner != "" {
		if runnerErr := h.Workflow.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner); runnerErr != nil {
			slog.Warn("callback.complete.set_runner_failed", "task_id", taskID, "error", runnerErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
}

// HandleFail handles POST /v1/internal/workflow-tasks/{id}/fail.
func (h *WorkflowCallbackHandler) HandleFail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyCallbackToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractWorkflowCallbackTaskID(r.URL.Path, "/fail")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Error          string `json:"error"`
		AssignedRunner string `json:"assigned_runner"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Internal callbacks only operate on delegation tasks.
	if task.Kind != string(domain.WFKindDelegation) {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Idempotent
	if domain.IsTerminal(domain.WorkflowTaskState(task.Status)) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": task.Status, "noop": "true"})
		return
	}

	eventID, err := h.Workflow.Fail(r.Context(), taskID, task.AgentDID, req.Error)
	if err != nil {
		slog.Warn("callback.fail_failed", "task_id", taskID, "error", err)
		jsonError(w, "fail failed", http.StatusInternalServerError)
		return
	}

	// Set assigned_runner only after successful transition (not on no-op).
	if eventID > 0 && req.AssignedRunner != "" {
		if runnerErr := h.Workflow.SetAssignedRunner(r.Context(), taskID, req.AssignedRunner); runnerErr != nil {
			slog.Warn("callback.fail.set_runner_failed", "task_id", taskID, "error", runnerErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "failed"})
}

// HandleProgress handles POST /v1/internal/workflow-tasks/{id}/progress.
func (h *WorkflowCallbackHandler) HandleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyCallbackToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractWorkflowCallbackTaskID(r.URL.Path, "/progress")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Internal callbacks only operate on delegation tasks.
	if task.Kind != string(domain.WFKindDelegation) {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	if err := h.Workflow.UpdateProgress(r.Context(), taskID, task.AgentDID, req.Message); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleList handles GET /v1/internal/workflow-tasks?status=running.
// Scoped to delegation tasks only — reconciler should only see agent delegations.
func (h *WorkflowCallbackHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyCallbackToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var states []string
	if s := r.URL.Query().Get("status"); s != "" {
		states = strings.Split(s, ",")
	}
	// Reconciler only operates on delegation tasks.
	kinds := []string{string(domain.WFKindDelegation)}
	tasks, err := h.Workflow.List(r.Context(), states, kinds, "", 100)
	if err != nil {
		jsonError(w, "list failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tasks": tasks})
}

// --- Kind verification helper ---

// verifyDelegationKind checks that the task exists and is kind=delegation.
// Returns false (and writes error response) if the task is not a delegation.
func (h *WorkflowHandler) verifyDelegationKind(w http.ResponseWriter, r *http.Request, taskID string) bool {
	task, err := h.Workflow.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return false
	}
	if task.Kind != string(domain.WFKindDelegation) {
		jsonError(w, "operation only allowed for delegation tasks", http.StatusBadRequest)
		return false
	}
	return true
}

// --- Path helpers ---

// extractWorkflowTaskID extracts the task ID from /v1/workflow/tasks/{id} paths.
func extractWorkflowTaskID(path string) string {
	const prefix = "/v1/workflow/tasks/"
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

// extractWorkflowSubTaskID extracts task ID from /v1/workflow/tasks/{id}/suffix paths.
func extractWorkflowSubTaskID(path, suffix string) string {
	const prefix = "/v1/workflow/tasks/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	rest = strings.TrimSuffix(rest, suffix)
	rest = strings.TrimRight(rest, "/")
	return rest
}

// extractWorkflowEventID extracts the event ID from /v1/workflow/events/{id}/ack paths.
func extractWorkflowEventID(path string) string {
	const prefix = "/v1/workflow/events/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	rest = strings.TrimSuffix(rest, "/ack")
	rest = strings.TrimRight(rest, "/")
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

// extractWorkflowCallbackTaskID extracts task ID from /v1/internal/workflow-tasks/{id}/suffix.
func extractWorkflowCallbackTaskID(path, suffix string) string {
	const prefix = "/v1/internal/workflow-tasks/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	rest = strings.TrimSuffix(rest, suffix)
	rest = strings.TrimRight(rest, "/")
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

// subtle_compare performs constant-time string comparison.
func subtle_compare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	result := byte(0)
	for i := 0; i < len(a); i++ {
		result |= a[i] ^ b[i]
	}
	return result == 0
}

// --- Domain validation helpers (Issue 20) ---

// isValidWorkflowKind checks if a kind string matches a known WorkflowTaskKind.
func isValidWorkflowKind(kind string) bool {
	switch domain.WorkflowTaskKind(kind) {
	case domain.WFKindDelegation, domain.WFKindApproval, domain.WFKindServiceQuery,
		domain.WFKindTimer, domain.WFKindWatch, domain.WFKindGeneric:
		return true
	}
	return false
}

// isValidWorkflowPriority checks if a priority string matches a known priority.
func isValidWorkflowPriority(priority string) bool {
	switch domain.WorkflowTaskPriority(priority) {
	case domain.WFPriorityUserBlocking, domain.WFPriorityNormal, domain.WFPriorityBackground:
		return true
	}
	return false
}

// isValidWorkflowOrigin checks if an origin string is in the allowed origins list.
func isValidWorkflowOrigin(origin string) bool {
	for _, allowed := range domain.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}
