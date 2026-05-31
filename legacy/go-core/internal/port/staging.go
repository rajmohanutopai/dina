package port

import (
	"context"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// StagingInbox manages the staging pipeline for connector ingestion.
// Items arrive from connectors (push) or Brain's MCP sync (pull),
// get classified by Brain, and stored to the correct persona vault.
// Core decides whether to store immediately or pend for unlock.
type StagingInbox interface {
	// Ingest stores a raw item in the staging inbox.
	// Deduplicates on (connector_id, source, source_id).
	// Returns the staging item ID.
	Ingest(ctx context.Context, item domain.StagingItem) (string, error)

	// GetStatus returns the current status of a staging item.
	// If callerDID is non-empty, enforces ownership (origin_did must match).
	GetStatus(ctx context.Context, id, callerDID string) (string, error)

	// Claim marks up to `limit` received items as classifying with a lease.
	// Returns the claimed items. Expired leases auto-revert to received.
	Claim(ctx context.Context, limit int, leaseDuration time.Duration) ([]domain.StagingItem, error)

	// Resolve processes a classified item. Core decides:
	//   - persona open → store classified_item to vault, mark stored, clear raw body
	//   - persona locked → mark pending_unlock, keep classified_item, clear raw body
	Resolve(ctx context.Context, id, targetPersona string, classifiedItem domain.VaultItem) error

	// ResolveMulti processes a classified item for multiple target personas.
	// Core decides stored vs pending_unlock for each persona independently.
	// Each copy gets a deterministic ID: stg-{staging_id}-{persona}.
	ResolveMulti(ctx context.Context, id string, targets []domain.ResolveTarget) error

	// ExtendLease extends the lease on a classifying item. Brain calls this
	// during long-running operations to prevent Sweep from reverting the item.
	// VT6: Without this, items exceeding DefaultLeaseDuration are double-processed.
	ExtendLease(ctx context.Context, id string, extension time.Duration) error

	// MarkFailed records a classification failure with an error message.
	MarkFailed(ctx context.Context, id, errMsg string) error

	// MarkPendingApproval marks an item as pending_unlock with its classified
	// data and target persona. Used when staging resolve is blocked by access
	// control and an approval request has been created. The classified item is
	// preserved so DrainPending can store it after approval.
	MarkPendingApproval(ctx context.Context, id, targetPersona string, classifiedItem domain.VaultItem) error

	// CreatePendingCopy creates a new staging row in pending_unlock state.
	// Used for multi-target resolve when individual targets are denied —
	// the accessible targets go through ResolveMulti on the original row,
	// while denied targets get their own pending rows for later drain.
	CreatePendingCopy(ctx context.Context, copyID, targetPersona string, classifiedItem domain.VaultItem) error

	// DrainPending promotes pending_unlock items for a persona to its vault.
	// Called by Core when a persona is unlocked. No Brain dependency.
	// Returns the count of items drained.
	DrainPending(ctx context.Context, persona string) (int, error)

	// Sweep expires items past TTL and reverts expired classifying leases.
	// Returns the count of items cleaned up.
	Sweep(ctx context.Context) (int, error)

	// ListByStatus returns staging items matching the given status.
	ListByStatus(ctx context.Context, status string, limit int) ([]domain.StagingItem, error)
}
