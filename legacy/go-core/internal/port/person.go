package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// PersonStore manages the person memory layer — canonical person records
// and their surface forms. Separate from ContactDirectory.
type PersonStore interface {
	// ApplyExtraction atomically applies an extraction result.
	// Idempotent per (source_item_id, extractor_version, fingerprint).
	// Name surfaces are allowed on multiple people.
	// Role phrase surfaces trigger conflict if already confirmed on a different person.
	ApplyExtraction(ctx context.Context, result domain.ExtractionResult) (*ApplyExtractionResponse, error)

	// GetPerson returns a person with all surfaces.
	GetPerson(ctx context.Context, personID string) (*domain.Person, error)

	// ListPeople returns all people with their surfaces.
	ListPeople(ctx context.Context) ([]domain.Person, error)

	// ConfirmPerson promotes a suggested person to confirmed.
	ConfirmPerson(ctx context.Context, personID string) error

	// RejectPerson marks a person as rejected (tombstone).
	RejectPerson(ctx context.Context, personID string) error

	// ConfirmSurface promotes a suggested surface to confirmed.
	ConfirmSurface(ctx context.Context, personID string, surfaceID int64) error

	// RejectSurface marks a surface as rejected.
	RejectSurface(ctx context.Context, personID string, surfaceID int64) error

	// DetachSurface removes a surface from a person.
	DetachSurface(ctx context.Context, personID string, surfaceID int64) error

	// MergePeople merges two people. All surfaces from mergeID move to keepID.
	MergePeople(ctx context.Context, keepID, mergeID string) error

	// DeletePerson tombstones a person and rejects all surfaces.
	DeletePerson(ctx context.Context, personID string) error

	// LinkContact links a person to a contact DID.
	LinkContact(ctx context.Context, personID, contactDID string) error

	// ResolveConfirmedSurfaces returns all confirmed surfaces for lookup.
	// Returns map[normalized_surface] → []PersonSurface (multiple people may share a name).
	ResolveConfirmedSurfaces(ctx context.Context) (map[string][]domain.PersonSurface, error)

	// ClearExcerptsForItem clears source_excerpt on all surfaces from a deleted source item.
	ClearExcerptsForItem(ctx context.Context, sourceItemID string) error

	// GarbageCollect archives old suggested-but-unconfirmed people.
	GarbageCollect(ctx context.Context, maxAgeDays int) (int, error)
}

// ApplyExtractionResponse is the result of applying an extraction.
type ApplyExtractionResponse struct {
	Created   int      `json:"created"`   // new people created
	Updated   int      `json:"updated"`   // existing people updated
	Conflicts []string `json:"conflicts"` // conflicting role phrases (need review)
	Skipped   bool     `json:"skipped"`   // true if idempotent duplicate
}
