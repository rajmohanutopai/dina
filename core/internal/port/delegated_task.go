package port

import (
	"context"
	"errors"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ErrDelegatedTaskExists is returned when creating a task with a duplicate ID.
var ErrDelegatedTaskExists = errors.New("delegated task already exists")

// DelegatedTaskStore provides durable storage for tasks delegated to external agents.
// Separate from TaskQueue (internal Core↔Brain async work) — different lifecycle,
// provenance, and access patterns.
type DelegatedTaskStore interface {
	// Create inserts a new delegated task.
	Create(ctx context.Context, task domain.DelegatedTask) error

	// GetByID returns a task by its ID, or nil if not found.
	GetByID(ctx context.Context, id string) (*domain.DelegatedTask, error)

	// GetByProposalID returns a task linked to a proposal, or nil if not found.
	GetByProposalID(ctx context.Context, proposalID string) (*domain.DelegatedTask, error)

	// List returns tasks filtered by status. Empty status returns all.
	List(ctx context.Context, status string, limit int) ([]domain.DelegatedTask, error)

	// Claim atomically grabs the oldest queued task and assigns it to agentDID.
	// Sets session_name = "task-" + id server-side. Returns nil if no work available.
	Claim(ctx context.Context, agentDID string, leaseSec int) (*domain.DelegatedTask, error)

	// Heartbeat extends the lease for a claimed task. Only the claiming agent can heartbeat.
	Heartbeat(ctx context.Context, id, agentDID string, leaseSec int) error

	// UpdateProgress stores a progress note on a claimed task.
	UpdateProgress(ctx context.Context, id, agentDID, message string) error

	// Complete marks a task as completed with a result summary.
	// Store-level only — handler orchestrates session teardown separately.
	Complete(ctx context.Context, id, agentDID, result string) error

	// Fail marks a task as failed with an error message.
	// Store-level only — handler orchestrates session teardown separately.
	Fail(ctx context.Context, id, agentDID, errMsg string) error

	// QueueByProposalID transitions a task from pending_approval to queued,
	// found by its linked proposal_id.
	// Idempotent: already queued/claimed/completed = no-op success.
	// No linked task for proposal = no-op success (not all proposals are tasks).
	QueueByProposalID(ctx context.Context, proposalID string) error

	// ExpireLeases finds tasks with expired leases (claimed/running + lease < now)
	// and transitions them back to queued. Returns the expired tasks so the caller
	// can clean up associated sessions.
	ExpireLeases(ctx context.Context) ([]domain.DelegatedTask, error)
}
