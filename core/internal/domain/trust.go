package domain

// TrustEntry represents a cached trust score for a DID in the local neighborhood.
// Stored in identity.sqlite (installation-wide, not per-persona).
type TrustEntry struct {
	DID            string  `json:"did"`
	DisplayName    string  `json:"display_name"`
	TrustScore     float64 `json:"trust_score"`     // 0.0–1.0 composite from AppView
	TrustRing      int     `json:"trust_ring"`       // 1=unverified, 2=verified(ZKP), 3=verified+actioned
	Relationship   string  `json:"relationship"`     // contact, frequent, 1-hop, 2-hop, unknown
	Source         string  `json:"source"`            // manual, appview_sync
	LastVerifiedAt int64   `json:"last_verified_at"` // unix timestamp
	UpdatedAt      int64   `json:"updated_at"`
}

// IngressDecision is the trust-based verdict for an incoming D2D message.
type IngressDecision string

const (
	IngressAccept     IngressDecision = "accept"
	IngressQuarantine IngressDecision = "quarantine"
	IngressDrop       IngressDecision = "drop"
)

// ValidTrustRings is the set of accepted trust ring values.
var ValidTrustRings = map[int]bool{
	1: true, // Unverified
	2: true, // Verified (ZKP, no real name needed)
	3: true, // Verified + Actioned (transactions, time, peer attestation)
}

// ValidRelationships is the set of accepted relationship values.
var ValidRelationships = map[string]bool{
	"contact":  true,
	"frequent": true,
	"1-hop":    true,
	"2-hop":    true,
	"unknown":  true,
}

// ValidTrustSources is the set of accepted source values.
var ValidTrustSources = map[string]bool{
	"manual":       true,
	"appview_sync": true,
}

// TrustCacheStats holds summary statistics for the trust cache.
type TrustCacheStats struct {
	Count      int   `json:"count"`
	LastSyncAt int64 `json:"last_sync_at"`
}
