package domain

import "strings"

// ScenarioTier controls how a D2D message family is handled for a given contact.
// Applied symmetrically on inbound and outbound.
type ScenarioTier string

const (
	// ScenarioStandingPolicy — allowed in both directions without per-send approval.
	ScenarioStandingPolicy ScenarioTier = "standing_policy"

	// ScenarioExplicitOnce — owner must approve each outbound send.
	// Inbound is accepted; outbound is parked until approved.
	ScenarioExplicitOnce ScenarioTier = "explicit_once"

	// ScenarioDenyByDefault — message family is blocked in both directions.
	// The only exception is safety.alert, which always passes inbound.
	ScenarioDenyByDefault ScenarioTier = "deny_by_default"
)

// Contact holds contact directory data stored in identity.sqlite.
type Contact struct {
	DID                   string `json:"did"`
	Name                  string `json:"name"`
	Alias                 string   `json:"alias"`                   // compatibility: aliases[0] at serialization boundary
	Aliases               []string `json:"aliases,omitempty"`        // canonical multi-alias list (populated from alias store)
	TrustLevel            string `json:"trust_level"`            // blocked, unknown, trusted, verified
	TrustRing             int    `json:"trust_ring"`              // 0=unverified, 1=inner circle, 2=verified, 3=transactional
	Relationship          string `json:"relationship"`            // spouse, child, parent, sibling, friend, colleague, acquaintance, unknown
	DataResponsibility    string `json:"data_responsibility"`     // household, care, financial, external
	ResponsibilityExplicit bool  `json:"responsibility_explicit"` // true if user explicitly set data_responsibility (read-only in API)
	SharingPolicy         string `json:"sharing_policy"`          // JSON blob
	ResolutionPolicy      string `json:"resolution_policy"`       // late_binding (ring 1), plaintext (ring 2-3), blocked (ring 0)
	Source                string `json:"source"`                   // who provided this contact data
	SourceConfidence      string `json:"source_confidence"`        // high, medium, low
	LastContact           int64  `json:"last_contact"`             // unix timestamp of last interaction
}

// Relationship values.
const (
	RelationshipSpouse       = "spouse"
	RelationshipChild        = "child"
	RelationshipParent       = "parent"
	RelationshipSibling      = "sibling"
	RelationshipFriend       = "friend"
	RelationshipColleague    = "colleague"
	RelationshipAcquaintance = "acquaintance"
	RelationshipUnknown      = "unknown"
)

// ValidContactRelationships is the set of accepted contact relationship values.
// Named differently from ValidRelationships in trust.go (trust network graph relationships).
var ValidContactRelationships = map[string]bool{
	RelationshipSpouse: true, RelationshipChild: true,
	RelationshipParent: true, RelationshipSibling: true,
	RelationshipFriend: true, RelationshipColleague: true,
	RelationshipAcquaintance: true, RelationshipUnknown: true,
}

// DataResponsibility values — routing signal for persona classification.
// "self" is a pipeline-only bucket, NOT storable on contacts.
const (
	ResponsibilityHousehold = "household" // spouse/child: their sensitive data = user's own
	ResponsibilityCare      = "care"      // medical caregiver: health→health, finance→general
	ResponsibilityFinancial = "financial" // financial guardian: health→general, finance→finance
	ResponsibilityExternal  = "external"  // all sensitive data → general
)

// ValidDataResponsibility is the set of accepted data_responsibility values.
// "self" is intentionally excluded — it is a pipeline-only classification bucket.
var ValidDataResponsibility = map[string]bool{
	ResponsibilityHousehold: true,
	ResponsibilityCare:      true,
	ResponsibilityFinancial: true,
	ResponsibilityExternal:  true,
}

// DefaultResponsibility returns the default data_responsibility for a relationship.
// Spouse and child default to household; all others default to external.
func DefaultResponsibility(relationship string) string {
	switch relationship {
	case RelationshipSpouse, RelationshipChild:
		return ResponsibilityHousehold
	default:
		return ResponsibilityExternal
	}
}

// ReservedAliases are pronouns and generic terms that cannot be used as aliases.
var ReservedAliases = map[string]bool{
	"he": true, "she": true, "they": true, "him": true, "her": true,
	"them": true, "his": true, "hers": true, "their": true, "theirs": true,
	"i": true, "me": true, "my": true, "mine": true, "we": true, "us": true,
}

// ValidateAlias checks if an alias is acceptable. Returns an error message or "".
func ValidateAlias(alias string) string {
	normalized := strings.ToLower(strings.TrimSpace(alias))
	if normalized == "" {
		return "alias cannot be empty"
	}
	if len(normalized) < 2 {
		return "alias must be at least 2 characters"
	}
	if ReservedAliases[normalized] {
		return "alias cannot be a pronoun or reserved word"
	}
	return ""
}

// NormalizeAlias returns the lowercase trimmed form for uniqueness checks.
func NormalizeAlias(alias string) string {
	return strings.ToLower(strings.TrimSpace(alias))
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
