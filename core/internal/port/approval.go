package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ApprovalManager handles persona access approval requests.
// Approval requests are created when an agent tries to access a sensitive
// or standard persona without an active session grant.
type ApprovalManager interface {
	// RequestApproval creates a pending approval request.
	// Returns the request ID.
	RequestApproval(ctx context.Context, req domain.ApprovalRequest) (string, error)

	// ApproveRequest approves a pending request with the given scope.
	// Creates an AccessGrant scoped to the agent's session.
	ApproveRequest(ctx context.Context, id, scope, grantedBy string) error

	// DenyRequest denies a pending approval request.
	DenyRequest(ctx context.Context, id string) error

	// ListPending returns all pending approval requests.
	ListPending(ctx context.Context) ([]domain.ApprovalRequest, error)
}
