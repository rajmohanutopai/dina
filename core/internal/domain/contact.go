package domain

// Contact holds contact directory data stored in identity.sqlite.
type Contact struct {
	DID              string `json:"did"`
	Name             string `json:"name"`
	Alias            string `json:"alias"`
	TrustLevel       string `json:"trust_level"`       // blocked, unknown, trusted, verified
	SharingPolicy    string `json:"sharing_policy"`    // JSON blob
	Source           string `json:"source"`             // who provided this contact data
	SourceConfidence string `json:"source_confidence"`  // high, medium, low
	LastContact      int64  `json:"last_contact"`       // unix timestamp of last interaction
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
