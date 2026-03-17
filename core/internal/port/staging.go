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

	// Claim marks up to `limit` received items as classifying with a lease.
	// Returns the claimed items. Expired leases auto-revert to received.
	Claim(ctx context.Context, limit int, leaseDuration time.Duration) ([]domain.StagingItem, error)

	// Resolve processes a classified item. Core decides:
	//   - persona open → store classified_item to vault, mark stored, clear raw body
	//   - persona locked → mark pending_unlock, keep classified_item, clear raw body
	Resolve(ctx context.Context, id, targetPersona string, classifiedItem domain.VaultItem) error

	// MarkFailed records a classification failure with an error message.
	MarkFailed(ctx context.Context, id, errMsg string) error

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
