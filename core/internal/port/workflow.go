package port

import (
	"context"
	"errors"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ErrDelegatedTaskExists is returned when creating a task with a duplicate ID
// or idempotency key. Kept for backward compatibility with existing callers.
var ErrDelegatedTaskExists = errors.New("delegated task already exists")

// WorkflowStore is the durable store for workflow tasks and events.
// Replaces DelegatedTaskStore. Single interface for all workflow kinds.
type WorkflowStore interface {
	// CRUD
	Create(ctx context.Context, task domain.WorkflowTask) error
	GetByID(ctx context.Context, id string) (*domain.WorkflowTask, error)
	GetByProposalID(ctx context.Context, proposalID string) (*domain.WorkflowTask, error)
	GetByIdempotencyKey(ctx context.Context, key string) (*domain.WorkflowTask, error)
	// GetActiveByIdempotencyKey returns a non-terminal task with this key, or nil.
	GetActiveByIdempotencyKey(ctx context.Context, key string) (*domain.WorkflowTask, error)
	GetByCorrelationID(ctx context.Context, corrID string) ([]domain.WorkflowTask, error)
	// FindServiceQueryTask finds running/created service_query tasks matching the strict tuple.
	// Returns nil, nil if no match. Returns error if >1 match (data integrity violation).
	// nowUnix: caller's clock time for expiry check (avoids SQLite wall-clock divergence).
	FindServiceQueryTask(ctx context.Context, queryID, peerDID, capability string, nowUnix int64) (*domain.WorkflowTask, error)
	List(ctx context.Context, states, kinds []string, agentDID string, limit int) ([]domain.WorkflowTask, error)
	// ListOrdered is like List but allows oldest-first ordering for reconciliation.
	ListOrdered(ctx context.Context, states, kinds []string, agentDID string, limit int, oldestFirst bool) ([]domain.WorkflowTask, error)

	// Delegation lifecycle (kind=delegation — preserves exact current semantics)
	// Claim: atomically grabs oldest queued task. Assigns agent_did, session_name="task-"+id, lease.
	// requested_runner=''/auto' matches any runner; otherwise exact match.
	Claim(ctx context.Context, agentDID string, leaseSec int, runnerFilter string) (*domain.WorkflowTask, error)
	MarkRunning(ctx context.Context, id, agentDID, runID string) error
	SetAssignedRunner(ctx context.Context, id, runner string) error
	Heartbeat(ctx context.Context, id, agentDID string, leaseSec int) error
	UpdateProgress(ctx context.Context, id, agentDID, message string) error

	// Terminal transitions — atomic: UPDATE state + INSERT notification event in one transaction.
	// Returns (eventID, error). eventID=0 if already terminal (idempotent no-op).
	Complete(ctx context.Context, id, agentDID, resultSummary string) (int64, error)
	// CompleteWithDetails: like Complete but persists structured result in workflow_tasks.result
	// and uses eventDetails as the workflow_event details JSON.
	CompleteWithDetails(ctx context.Context, id, agentDID, resultSummary, resultJSON, eventDetails string) (int64, error)
	Fail(ctx context.Context, id, agentDID, errMsg string) (int64, error)
	Cancel(ctx context.Context, id string) (int64, error)

	// Transition performs a generic non-terminal state transition.
	// No agent_did, no event emission. Validates against ValidTransitions.
	Transition(ctx context.Context, id string, from, to domain.WorkflowTaskState) error

	// Approval bridge (preserves proposal_id linkage)
	// pending_approval → queued (idempotent)
	QueueByProposalID(ctx context.Context, proposalID string) error
	// Approve transitions pending_approval → queued and emits a workflow_event
	// with the full task payload in the event details (for Brain execution).
	Approve(ctx context.Context, id string) (int64, error)
	// ClaimApprovalForExecution atomically claims a queued approval task for execution.
	// queued → running with expires_at extended. Returns error if not claimable.
	ClaimApprovalForExecution(ctx context.Context, id string, extendSec int64) error
	// ListExpiringApprovalTasks returns approval tasks in queued state with past expires_at.
	ListExpiringApprovalTasks(ctx context.Context) ([]domain.WorkflowTask, error)

	// Sweeper methods — each atomically transitions state + appends notification event.
	// ExpireTasks: WHERE expires_at < now AND state NOT IN terminal.
	// Returns affected tasks for session cleanup.
	ExpireTasks(ctx context.Context) ([]domain.WorkflowTask, error)
	// ExpireLeases: WHERE lease_expires_at < now AND state = 'claimed'.
	// Clears agent_did, session_name, lease, progress, run_id. State → queued.
	// Returns affected tasks for session cleanup.
	ExpireLeases(ctx context.Context) ([]domain.WorkflowTask, error)

	// Events + delivery tracking
	AppendEvent(ctx context.Context, taskID, eventKind, details string, needsDelivery bool) (int64, error)
	// ReserveEventForDelivery atomically marks an event as in-delivery for reserveSec.
	// Returns (true, nil) if reserved. (false, nil) if already reserved. (false, err) on DB error.
	ReserveEventForDelivery(ctx context.Context, eventID int64, reserveSec int) (bool, error)
	// RecordDeliveryAttempt: always increments delivery_attempts, clears delivering_until.
	// On success: sets delivered_at. On failure: sets next_delivery_at with backoff.
	// After 3 total attempts with no ACK: sets delivery_failed=1.
	RecordDeliveryAttempt(ctx context.Context, eventID int64, succeeded bool) error
	// MarkEventAcknowledged: sets acknowledged_at. Clears delivery_failed if set (late ACK).
	MarkEventAcknowledged(ctx context.Context, eventID int64) error
	// SetRunID sets the run_id field on a task (no ownership check).
	// Used as a crash-recovery marker for service respond.
	SetRunID(ctx context.Context, id, runID string) error

	// SetInternalStash stores recovery data in the internal_stash column (not API-visible).
	SetInternalStash(ctx context.Context, id, stash string) error
	// ListStashedServiceQueryTasks returns service_query tasks with data in internal_stash.
	ListStashedServiceQueryTasks(ctx context.Context) ([]domain.WorkflowTask, error)
	// ListBridgePendingTasks returns delegation tasks whose internal_stash holds
	// a service.response awaiting send retry (prefix "bridge_pending:").
	ListBridgePendingTasks(ctx context.Context) ([]domain.WorkflowTask, error)

	// ListDeliverableEvents: needs_delivery=1 AND acknowledged_at IS NULL AND delivery_failed=0
	// AND delivery_attempts < 3 AND reservation expired AND backoff elapsed.
	// ORDER BY next_delivery_at ASC NULLS FIRST.
	ListDeliverableEvents(ctx context.Context, limit int) ([]domain.WorkflowEvent, error)
	// ListDeliverableEventsForTask: same eligibility as ListDeliverableEvents but scoped to one task.
	ListDeliverableEventsForTask(ctx context.Context, taskID string, limit int) ([]domain.WorkflowEvent, error)
	// ListEvents: all events for a task (audit/history).
	ListEvents(ctx context.Context, taskID string) ([]domain.WorkflowEvent, error)
}
