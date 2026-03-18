package domain

// Contact holds contact directory data stored in identity.sqlite.
type Contact struct {
	DID              string `json:"did"`
	Name             string `json:"name"`
	Alias            string `json:"alias"`
	TrustLevel       string `json:"trust_level"`       // blocked, unknown, trusted, verified
	TrustRing        int    `json:"trust_ring"`         // 0=unverified, 1=inner circle, 2=verified, 3=transactional
	SharingPolicy    string `json:"sharing_policy"`     // JSON blob
	ResolutionPolicy string `json:"resolution_policy"`  // late_binding (ring 1), plaintext (ring 2-3), blocked (ring 0)
	Source           string `json:"source"`              // who provided this contact data
	SourceConfidence string `json:"source_confidence"`   // high, medium, low
	LastContact      int64  `json:"last_contact"`        // unix timestamp of last interaction
}

// Trust ring constants.
// Rings determine how agents receive contact data:
//   Ring 0 (Unverified): agents get nothing — blocked by default
//   Ring 1 (Inner Circle): late binding only — agents never see raw PII
//   Ring 2 (Verified): plaintext for approved intents, late binding for risky ones
//   Ring 3 (Transactional): plaintext — public/business contacts
const (
	TrustRingUnverified    = 0 // no trust data — default for new contacts
	TrustRingInnerCircle   = 1 // family, close friends — maximum privacy
	TrustRingVerified      = 2 // verified contacts — standard privacy
	TrustRingTransactional = 3 // business/utility — minimal privacy
)

// EntityResolutionMode determines how agent receives contact data.
type EntityResolutionMode string

const (
	// ResolutionBlocked — agent gets nothing. Ring 0 contacts.
	ResolutionBlocked EntityResolutionMode = "blocked"

	// ResolutionLateBound — agent gets {{dina.vault...}} placeholders.
	// Dina hydrates the real values at execution time. The agent never
	// sees raw PII. Used for Ring 1 (inner circle) contacts.
	ResolutionLateBound EntityResolutionMode = "late_binding"

	// ResolutionPlaintext — agent gets the actual data directly.
	// Used for Ring 2-3 (verified/transactional) contacts for
	// approved low-risk intents.
	ResolutionPlaintext EntityResolutionMode = "plaintext"
)

// EntityResolutionRequest is an agent's request to resolve a contact.
// Sent to POST /v1/gateway/resolve-entity.
type EntityResolutionRequest struct {
	AgentID        string   `json:"agent_id"`
	Intent         string   `json:"intent"`          // what the agent wants to do
	TargetEntity   string   `json:"target_entity"`   // contact name or DID
	RequiredFields []string `json:"required_fields"` // email, phone, address, etc.
}

// EntityResolutionResponse is Dina's response with contact data.
// The resolution_mode tells the agent how to use the data.
type EntityResolutionResponse struct {
	Status            string                 `json:"status"`             // success, denied, approval_required
	ResolutionMode    EntityResolutionMode   `json:"resolution_mode"`
	EntityID          string                 `json:"entity_id"`
	Data              map[string]string      `json:"data,omitempty"`               // plaintext fields (ring 2-3)
	BindingReferences map[string]string      `json:"binding_references,omitempty"` // late-bound refs (ring 1)
	Instruction       string                 `json:"instruction,omitempty"`        // guidance for the agent
	TrustRing         int                    `json:"trust_ring"`
}

// SharingTier controls how much data is shared for a given category.
type SharingTier string

const (
	SharingNone          SharingTier = "none"
	SharingSummary       SharingTier = "summary"
	SharingFull          SharingTier = "full"
	SharingETAOnly       SharingTier = "eta_only"
	SharingFreeBusy      SharingTier = "free_busy"
	SharingExactLocation SharingTier = "exact_location"
)

// ValidSharingTiers is the set of accepted sharing tier values.
var ValidSharingTiers = map[SharingTier]bool{
	SharingNone:          true,
	SharingSummary:       true,
	SharingFull:          true,
	SharingETAOnly:       true,
	SharingFreeBusy:      true,
	SharingExactLocation: true,
}

// SharingPolicy holds per-category sharing tiers for a contact.
type SharingPolicy struct {
	ContactDID string
	Categories map[string]SharingTier // category -> tier
}

// TieredPayload holds the brain's tiered output for a single category.
type TieredPayload struct {
	Summary string
	Full    string
}

// EgressPayload is the brain's outbound data with tiered categories.
type EgressPayload struct {
	RecipientDID string
	Categories   map[string]interface{} // category -> TieredPayload or raw value
}

// EgressResult is the filtered payload after sharing policy enforcement.
type EgressResult struct {
	RecipientDID string
	Filtered     map[string]string // category -> selected tier value
	Denied       []string          // categories that were denied
	AuditEntries []AuditEntry
}

// AuditEntry records an egress decision.
type AuditEntry struct {
	Action     string // "egress_check"
	ContactDID string
	Category   string
	Decision   string // "allowed", "denied"
	Reason     string // "tier_none", "tier_summary", "tier_full", "malformed"
}
