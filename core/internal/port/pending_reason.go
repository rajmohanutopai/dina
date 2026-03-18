package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// PendingReasonStore manages in-flight reasoning requests that are waiting
// for persona approval. Backed by identity.sqlite's pending_reason table.
type PendingReasonStore interface {
	// Create stores a new pending reason record.
	Create(ctx context.Context, record domain.PendingReasonRecord) error

	// GetByID retrieves a pending reason by request_id.
	// Enforces caller binding: returns error if callerDID doesn't match.
	GetByID(ctx context.Context, requestID, callerDID string) (*domain.PendingReasonRecord, error)

	// GetByApprovalID finds all pending reason records for an approval.
	// Used by HandleApprove/HandleDeny to update related requests.
	GetByApprovalID(ctx context.Context, approvalID string) ([]domain.PendingReasonRecord, error)

	// UpdateStatus updates the status (and optionally result/error) of a record.
	UpdateStatus(ctx context.Context, requestID, status, result, errMsg string) error

	// UpdateApprovalID updates the approval_id for a second-approval cycle.
	UpdateApprovalID(ctx context.Context, requestID, approvalID string) error

	// Sweep deletes expired entries and marks timed-out ones as expired.
	// Returns the number of entries cleaned up.
	Sweep(ctx context.Context) (int, error)
}
