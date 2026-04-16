package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// SessionManager is the minimal interface for session teardown on terminal
// workflow transitions. Implemented by PersonaManager.
type SessionManager interface {
	EndSession(ctx context.Context, agentDID, sessionName string) error
}

// WorkflowService wraps the WorkflowStore and adds:
//   - Session teardown on ALL terminal transitions for kind=delegation
//   - RunSweeper goroutine: ExpireTasks + ExpireLeases + DeliverEvents every 30s
//   - DeliverEvents: scan deliverable events, reserve, call brain.Process, record attempt
// UnavailableSender is a callback for sending "unavailable" D2D responses
// during approval task expiry. Set via SetUnavailableSender after transport is wired.
// ttlSeconds is from the original query (preserves request contract).
type UnavailableSender func(ctx context.Context, peerDID, queryID, capability string, ttlSeconds int)

type WorkflowService struct {
	store              port.WorkflowStore
	brain              port.BrainClient
	sessionMgr         SessionManager
	clock              port.Clock
	unavailableSender  UnavailableSender // WS2: sends "unavailable" on approval expiry
}

// NewWorkflowService constructs a WorkflowService.
func NewWorkflowService(store port.WorkflowStore, brain port.BrainClient, sessionMgr SessionManager, clock port.Clock) *WorkflowService {
	return &WorkflowService{
		store:      store,
		brain:      brain,
		sessionMgr: sessionMgr,
		clock:      clock,
	}
}

// SetUnavailableSender sets the callback for sending "unavailable" D2D responses
// when approval tasks expire. Called from main.go after TransportService is wired.
func (s *WorkflowService) SetUnavailableSender(fn UnavailableSender) {
	s.unavailableSender = fn
}

// Store returns the underlying WorkflowStore (for direct reads by handlers
// that don't need service-layer orchestration).
func (s *WorkflowService) Store() port.WorkflowStore {
	return s.store
}

// --- Delegated CRUD (thin wrappers) ---

func (s *WorkflowService) Create(ctx context.Context, task domain.WorkflowTask) error {
	return s.store.Create(ctx, task)
}

func (s *WorkflowService) GetByID(ctx context.Context, id string) (*domain.WorkflowTask, error) {
	return s.store.GetByID(ctx, id)
}

func (s *WorkflowService) GetByProposalID(ctx context.Context, proposalID string) (*domain.WorkflowTask, error) {
	return s.store.GetByProposalID(ctx, proposalID)
}

func (s *WorkflowService) GetByIdempotencyKey(ctx context.Context, key string) (*domain.WorkflowTask, error) {
	return s.store.GetByIdempotencyKey(ctx, key)
}

func (s *WorkflowService) GetByCorrelationID(ctx context.Context, corrID string) ([]domain.WorkflowTask, error) {
	return s.store.GetByCorrelationID(ctx, corrID)
}

func (s *WorkflowService) List(ctx context.Context, states, kinds []string, agentDID string, limit int) ([]domain.WorkflowTask, error) {
	return s.store.List(ctx, states, kinds, agentDID, limit)
}

func (s *WorkflowService) Claim(ctx context.Context, agentDID string, leaseSec int, runnerFilter string) (*domain.WorkflowTask, error) {
	return s.store.Claim(ctx, agentDID, leaseSec, runnerFilter)
}

func (s *WorkflowService) MarkRunning(ctx context.Context, id, agentDID, runID string) error {
	return s.store.MarkRunning(ctx, id, agentDID, runID)
}

func (s *WorkflowService) SetAssignedRunner(ctx context.Context, id, runner string) error {
	return s.store.SetAssignedRunner(ctx, id, runner)
}

func (s *WorkflowService) Heartbeat(ctx context.Context, id, agentDID string, leaseSec int) error {
	return s.store.Heartbeat(ctx, id, agentDID, leaseSec)
}

func (s *WorkflowService) UpdateProgress(ctx context.Context, id, agentDID, message string) error {
	return s.store.UpdateProgress(ctx, id, agentDID, message)
}

func (s *WorkflowService) QueueByProposalID(ctx context.Context, proposalID string) error {
	return s.store.QueueByProposalID(ctx, proposalID)
}

func (s *WorkflowService) AppendEvent(ctx context.Context, taskID, eventKind, details string, needsDelivery bool) (int64, error) {
	return s.store.AppendEvent(ctx, taskID, eventKind, details, needsDelivery)
}

func (s *WorkflowService) MarkEventAcknowledged(ctx context.Context, eventID int64) error {
	return s.store.MarkEventAcknowledged(ctx, eventID)
}

func (s *WorkflowService) ListEvents(ctx context.Context, taskID string) ([]domain.WorkflowEvent, error) {
	return s.store.ListEvents(ctx, taskID)
}

// --- Terminal transitions with session teardown ---

// Complete marks a task as completed. For kind=delegation, tears down the
// linked agent session. Only performs teardown if the transition actually
// happened (eventID > 0), not on idempotent no-ops.
func (s *WorkflowService) Complete(ctx context.Context, id, agentDID, resultSummary string) (int64, error) {
	eventID, err := s.store.Complete(ctx, id, agentDID, resultSummary)
	if err != nil {
		return 0, err
	}
	if eventID > 0 {
		s.teardownSessionIfDelegation(ctx, id, agentDID)
	}
	return eventID, nil
}

// CompleteWithDetails marks a task as completed with structured result and rich event details.
// For kind=delegation, tears down the linked agent session.
func (s *WorkflowService) CompleteWithDetails(ctx context.Context, id, agentDID, resultSummary, resultJSON, eventDetails string) (int64, error) {
	eventID, err := s.store.CompleteWithDetails(ctx, id, agentDID, resultSummary, resultJSON, eventDetails)
	if err != nil {
		return 0, err
	}
	if eventID > 0 {
		s.teardownSessionIfDelegation(ctx, id, agentDID)
	}
	return eventID, nil
}

// Fail marks a task as failed. For kind=delegation, tears down the linked
// agent session. Only performs teardown if the transition actually happened
// (eventID > 0), not on idempotent no-ops.
func (s *WorkflowService) Fail(ctx context.Context, id, agentDID, errMsg string) (int64, error) {
	eventID, err := s.store.Fail(ctx, id, agentDID, errMsg)
	if err != nil {
		return 0, err
	}
	if eventID > 0 {
		s.teardownSessionIfDelegation(ctx, id, agentDID)
	}
	return eventID, nil
}

// Cancel marks a task as cancelled. For kind=delegation, tears down the
// linked agent session. Only performs teardown if the transition actually
// happened (eventID > 0), not on idempotent no-ops.
func (s *WorkflowService) Cancel(ctx context.Context, id string) (int64, error) {
	// Read the task before cancelling to capture agent_did for teardown.
	task, _ := s.store.GetByID(ctx, id)

	eventID, err := s.store.Cancel(ctx, id)
	if err != nil {
		return 0, err
	}

	if eventID > 0 && task != nil {
		s.teardownSessionIfDelegation(ctx, id, task.AgentDID)
	}
	return eventID, nil
}

// teardownSessionIfDelegation ends the linked Dina session for a terminal
// delegation task. Best-effort: errors are logged but never block the caller.
func (s *WorkflowService) teardownSessionIfDelegation(ctx context.Context, taskID, agentDID string) {
	if s.sessionMgr == nil {
		return
	}
	task, err := s.store.GetByID(ctx, taskID)
	if err != nil || task == nil || task.SessionName == "" {
		return
	}
	if task.Kind != string(domain.WFKindDelegation) {
		return
	}
	// Use agentDID from the task if not provided (e.g. cancel by admin).
	did := agentDID
	if did == "" {
		did = task.AgentDID
	}
	if did == "" {
		return
	}
	err = s.sessionMgr.EndSession(ctx, did, task.SessionName)
	if err != nil {
		// "not found" is normal (race between claim and session_start).
		// Other errors are logged but never block task completion.
		slog.Warn("workflow.session_end_failed",
			"task_id", taskID, "session", task.SessionName, "error", err)
	}
}

// --- Sweeper goroutine ---

// RunSweeper runs the sweeper loop: every 30s, expires tasks, expires leases,
// and delivers events. Blocks until ctx is cancelled.
func (s *WorkflowService) RunSweeper(ctx context.Context) {
	ticker := s.clock.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(ctx)
		}
	}
}

func (s *WorkflowService) sweep(ctx context.Context) {
	// 0a. Recover stashed service.response results (DB-failure recovery, best-effort).
	s.recoverStashedResponses(ctx)

	// 0b. Pre-expiry: claim and fail expiring approval tasks (sends "unavailable" best-effort).
	// Must run BEFORE ExpireTasks so we can claim queued→running before they're failed.
	s.expireApprovalTasks(ctx)

	// 1. Expire tasks with past expires_at.
	expiredTasks, err := s.store.ExpireTasks(ctx)
	if err != nil {
		slog.Warn("workflow.sweep.expire_tasks_failed", "error", err)
	}
	for _, t := range expiredTasks {
		slog.Info("workflow.task_expired", "task_id", t.ID, "kind", t.Kind)
		s.teardownSessionIfDelegation(ctx, t.ID, t.AgentDID)
	}

	// 2. Expire leases — requeue claimed tasks with past lease.
	expiredLeases, err := s.store.ExpireLeases(ctx)
	if err != nil {
		slog.Warn("workflow.sweep.expire_leases_failed", "error", err)
	}
	for _, t := range expiredLeases {
		slog.Info("workflow.lease_expired", "task_id", t.ID, "agent_did", t.AgentDID, "session", t.SessionName)
		if t.SessionName != "" && t.AgentDID != "" && s.sessionMgr != nil {
			err := s.sessionMgr.EndSession(ctx, t.AgentDID, t.SessionName)
			if err != nil {
				slog.Warn("workflow.lease_session_cleanup_failed",
					"task_id", t.ID, "agent_did", t.AgentDID,
					"session", t.SessionName, "error", err)
			}
		}
	}

	// 3. Deliver pending events to Brain.
	s.DeliverEvents(ctx)
}

// DeliverEvents scans deliverable events, reserves each one, calls
// brain.Process, and records the attempt outcome.
func (s *WorkflowService) DeliverEvents(ctx context.Context) {
	if s.brain == nil {
		return
	}
	events, err := s.store.ListDeliverableEvents(ctx, 20)
	if err != nil {
		slog.Warn("workflow.deliver_events.list_failed", "error", err)
		return
	}

	for _, evt := range events {
		s.deliverSingleEvent(ctx, evt)
	}
}

// DeliverEventsForTask delivers pending events for a specific task.
// Used for immediate delivery after task completion (don't wait for 30s sweeper).
// Respects full eligibility predicate (attempts, backoff, reservation).
func (s *WorkflowService) DeliverEventsForTask(ctx context.Context, taskID string) {
	if s.brain == nil {
		return
	}
	events, err := s.store.ListDeliverableEventsForTask(ctx, taskID, 10)
	if err != nil {
		slog.Warn("workflow.deliver_events_for_task.list_failed", "task_id", taskID, "error", err)
		return
	}
	for _, evt := range events {
		s.deliverSingleEvent(ctx, evt)
	}
}

// deliverSingleEvent reserves, delivers, and records a single event.
func (s *WorkflowService) deliverSingleEvent(ctx context.Context, evt domain.WorkflowEvent) {
	// Reserve for 60 seconds.
	reserved, err := s.store.ReserveEventForDelivery(ctx, evt.EventID, 60)
	if err != nil {
		slog.Warn("workflow.deliver_events.reserve_failed",
			"event_id", evt.EventID, "error", err)
		return
	}
	if !reserved {
		return // already reserved by another sweeper tick
	}

	// Look up the task to get kind for the payload.
	taskKind := ""
	task, taskErr := s.store.GetByID(ctx, evt.TaskID)
	if taskErr == nil && task != nil {
		taskKind = task.Kind
	}

	// Parse details JSON string into a map so Brain receives a dict,
	// not a raw JSON string. Falls back to the raw string on parse error.
	var detailsParsed interface{}
	if evt.Details != "" {
		var detailsMap map[string]interface{}
		if jsonErr := json.Unmarshal([]byte(evt.Details), &detailsMap); jsonErr == nil {
			detailsParsed = detailsMap
		} else {
			detailsParsed = evt.Details
		}
	} else {
		detailsParsed = map[string]interface{}{}
	}

	// Deliver to brain via Process.
	taskEvent := domain.TaskEvent{
		Type:   "workflow_event",
		TaskID: evt.TaskID,
		Payload: map[string]interface{}{
			"event_id":         evt.EventID,
			"workflow_task_id": evt.TaskID,
			"event_kind":       evt.EventKind,
			"task_kind":        taskKind,
			"details":          detailsParsed,
		},
	}
	deliveryErr := s.brain.Process(ctx, taskEvent)
	succeeded := deliveryErr == nil

	if recordErr := s.store.RecordDeliveryAttempt(ctx, evt.EventID, succeeded); recordErr != nil {
		slog.Warn("workflow.deliver_events.record_failed",
			"event_id", evt.EventID, "error", recordErr)
	}

	if !succeeded {
		slog.Warn("workflow.deliver_events.delivery_failed",
			"event_id", evt.EventID, "task_id", evt.TaskID, "error", deliveryErr)
	}
}

// recoverStashedResponses finds service_query tasks with a stashed response
// (run_id starts with "response_stashed:") and completes them with the stashed data.
// This recovers from the edge case where CompleteWithDetails fails in CheckServiceIngress
// but the response was already authorized and stashed.
func (s *WorkflowService) recoverStashedResponses(ctx context.Context) {
	tasks, err := s.store.ListStashedServiceQueryTasks(ctx)
	if err != nil {
		slog.Warn("workflow.recover_stashed.list_failed", "error", err)
		return
	}
	for _, t := range tasks {
		stashedJSON := t.InternalStash
		// Validate stashed JSON is parseable before using as result.
		var check map[string]interface{}
		if json.Unmarshal([]byte(stashedJSON), &check) != nil {
			slog.Warn("workflow.recover_stashed.invalid_json", "task_id", t.ID)
			s.store.Fail(ctx, t.ID, "", "stashed_response_corrupted")
			continue
		}
		slog.Info("workflow.recovering_stashed_response", "task_id", t.ID)

		_, completeErr := s.store.CompleteWithDetails(ctx, t.ID, "", "recovered", stashedJSON, stashedJSON)
		if completeErr != nil {
			slog.Warn("workflow.stashed_response_recovery_failed", "task_id", t.ID, "error", completeErr)
			continue
		}
		// Clear stash after successful recovery.
		s.store.SetInternalStash(ctx, t.ID, "")
		s.DeliverEventsForTask(ctx, t.ID)
	}
}

// expireApprovalTasks handles approval task expiry with "unavailable" response send.
// Covers both queued (approved but not yet executed) and pending_approval (never approved).
// Must run BEFORE generic ExpireTasks so we can claim/fail before ExpireTasks does.
func (s *WorkflowService) expireApprovalTasks(ctx context.Context) {
	candidates, err := s.store.ListExpiringApprovalTasks(ctx)
	if err != nil {
		slog.Warn("workflow.expire_approval_tasks.list_failed", "error", err)
		return
	}
	for _, t := range candidates {
		switch t.Status {
		case string(domain.WFQueued):
			// Queued: approved but not yet executed. Claim → send unavailable → fail.
			if claimErr := s.store.ClaimApprovalForExecution(ctx, t.ID, 30); claimErr != nil {
				continue // already claimed/terminal
			}
			s.sendUnavailableResponse(ctx, &t)
			if _, failErr := s.store.Fail(ctx, t.ID, "", "expired"); failErr != nil {
				slog.Warn("workflow.expire_approval_tasks.fail_failed", "task_id", t.ID, "error", failErr)
			}

		case string(domain.WFPendingApproval):
			// Pending approval: never approved. Atomically transition to failed first
			// to prevent a concurrent /service_approve from racing.
			// pending_approval → failed is valid (see ValidTransitions).
			_, failErr := s.store.Fail(ctx, t.ID, "", "expired_unapproved")
			if failErr != nil {
				slog.Warn("workflow.expire_approval_tasks.fail_failed", "task_id", t.ID, "error", failErr)
				continue // concurrent approve won — skip
			}
			// Task is now failed (terminal). Send "unavailable" best-effort.
			s.sendUnavailableResponse(ctx, &t)

		default:
			continue
		}
		slog.Info("workflow.approval_task_expired", "task_id", t.ID, "state", t.Status)
	}
}

// sendUnavailableResponse is a best-effort attempt to send an "unavailable"
// service.response to the requester when an approval task expires.
// Uses the unavailableSender callback (set by main.go after transport is wired).
// Failures are logged but never block task expiry.
func (s *WorkflowService) sendUnavailableResponse(ctx context.Context, t *domain.WorkflowTask) {
	if s.unavailableSender == nil {
		return
	}
	var payload map[string]interface{}
	if json.Unmarshal([]byte(t.Payload), &payload) != nil {
		return
	}
	fromDID, _ := payload["from_did"].(string)
	queryID, _ := payload["query_id"].(string)
	capability, _ := payload["capability"].(string)
	if fromDID == "" || queryID == "" || capability == "" {
		return
	}

	ttlSeconds := 60 // default
	if ttl, ok := payload["ttl_seconds"].(float64); ok {
		ttlSeconds = int(ttl)
	}

	slog.Info("workflow.sending_unavailable_response",
		"task_id", t.ID, "to", fromDID, "query_id", queryID)
	s.unavailableSender(ctx, fromDID, queryID, capability, ttlSeconds)
}
