package port

import (
	"encoding/json"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// TrustCache provides read/write access to the local trust neighborhood cache.
// Implementations must be safe for concurrent use.
type TrustCache interface {
	// Lookup returns the trust entry for a DID, or nil if not cached.
	Lookup(did string) (*domain.TrustEntry, error)

	// List returns all entries in the trust cache.
	List() ([]domain.TrustEntry, error)

	// Upsert inserts or updates a trust entry in the cache.
	Upsert(entry domain.TrustEntry) error

	// Remove deletes a DID from the trust cache.
	Remove(did string) error

	// Stats returns the cache entry count and last sync timestamp.
	Stats() (domain.TrustCacheStats, error)

	// SetLastSync updates the last sync timestamp in the backing store.
	SetLastSync(ts int64) error
}

// TrustResolver fetches trust profiles from an external source (AppView).
type TrustResolver interface {
	// ResolveProfile fetches the trust profile for a single DID.
	ResolveProfile(did string) (*domain.TrustEntry, error)

	// ResolveNeighborhood fetches the trust neighborhood around a center DID.
	// hops controls the graph depth (1 = direct, 2 = friends-of-friends).
	// limit caps the number of entries returned.
	ResolveNeighborhood(centerDID string, hops int, limit int) ([]domain.TrustEntry, error)

	// ResolveFullProfile fetches the raw AppView profile JSON for a DID.
	// Returns nil if AppView is not configured or the DID is unknown.
	ResolveFullProfile(did string) (json.RawMessage, error)
}

// ContactLookup provides read-only access to the contact directory for trust decisions.
type ContactLookup interface {
	// GetTrustLevel returns the trust_level for a DID from the contacts table.
	// Returns empty string if the DID is not a contact.
	GetTrustLevel(did string) string
}
