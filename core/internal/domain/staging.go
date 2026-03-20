package domain

// StagingItem represents a raw item in the staging inbox awaiting
// Brain classification before being stored to a persona vault.
//
// All memory-producing ingress flows through staging — CLI, connectors,
// Telegram, D2D, and admin imports. The ingress provenance fields
// (IngressChannel, OriginDID, OriginKind, ProducerID) are set server-side
// by the staging handler based on auth context. External callers cannot
// spoof these fields.
type StagingItem struct {
	ID             string `json:"id"`
	ConnectorID    string `json:"connector_id"`     // legacy — kept for connector items
	Source         string `json:"source"`            // gmail, calendar, dina-cli, etc.
	SourceID       string `json:"source_id"`         // external ID for dedup
	SourceHash     string `json:"source_hash"`       // SHA-256 of raw content
	Type           string `json:"type"`              // email, event, note
	Summary        string `json:"summary"`           // subject/headline
	Body           string `json:"body"`              // raw content (cleared after classification)
	Sender         string `json:"sender"`            // who sent it
	Metadata       string `json:"metadata"`          // JSON: labels, attachments, etc.
	Status         string `json:"status"`            // received, classifying, stored, pending_unlock, failed
	TargetPersona  string `json:"target_persona"`    // set by Brain classification
	ClassifiedItem string `json:"classified_item"`   // JSON VaultItem ready for storage
	Error          string `json:"error"`             // error message on failure
	RetryCount     int    `json:"retry_count"`       // for exponential backoff
	ClaimedAt      int64  `json:"claimed_at"`        // when Brain claimed it
	LeaseUntil     int64  `json:"lease_until"`       // lease expiry (auto-revert after)
	ExpiresAt      int64  `json:"expires_at"`        // 7-day TTL
	CreatedAt      int64  `json:"created_at"`        // when received
	UpdatedAt      int64  `json:"updated_at"`        // last status change

	// Ingress provenance — server-derived, never caller-supplied for
	// external callers. Trust is derived from (IngressChannel, OriginKind).
	IngressChannel string `json:"ingress_channel"` // cli, connector, telegram, d2d, brain, admin
	OriginDID      string `json:"origin_did"`       // device DID, remote DID, connector ID
	OriginKind     string `json:"origin_kind"`      // user, agent, remote_dina, service
	ProducerID     string `json:"producer_id"`      // dedup namespace: "cli:<did>", "connector:<id>", etc.
}

// Ingress channel constants.
const (
	IngressCLI       = "cli"
	IngressConnector = "connector"
	IngressTelegram  = "telegram"
	IngressD2D       = "d2d"
	IngressBrain     = "brain"
	IngressAdmin     = "admin"
)

// Origin kind constants — what kind of entity produced the content.
const (
	OriginUser       = "user"        // human user (personal CLI, Telegram, admin)
	OriginAgent      = "agent"       // AI agent running through CLI (OpenClaw)
	OriginRemoteDina = "remote_dina" // another Dina instance via D2D
	OriginService    = "service"     // connector, Brain internal, system
)

// Staging status constants.
const (
	StagingReceived      = "received"
	StagingClassifying   = "classifying"
	StagingStored        = "stored"
	StagingPendingUnlock = "pending_unlock"
	StagingFailed        = "failed"
)

// ValidStagingStatus lists accepted staging status values.
var ValidStagingStatus = map[string]bool{
	StagingReceived:      true,
	StagingClassifying:   true,
	StagingStored:        true,
	StagingPendingUnlock: true,
	StagingFailed:        true,
}

// StagingFilter holds query parameters for staging inbox searches.
type StagingFilter struct {
	Status      string
	ConnectorID string
	Source      string
	Limit       int
}

// ResolveTarget represents one persona target for multi-persona staging resolution.
type ResolveTarget struct {
	Persona        string    `json:"persona"`
	ClassifiedItem VaultItem `json:"classified_item"`
}

// DefaultStagingTTL is 7 days in seconds.
const DefaultStagingTTL = 7 * 24 * 60 * 60

// DefaultLeaseDuration is 15 minutes in seconds.
// VT6: Increased from 5 min to 15 min. Under slow LLM calls or network
// issues, a 5-min lease expires mid-classification, causing Sweep to
// revert the item to 'received' and enabling double-processing.
// 15 min gives Brain sufficient headroom for enrichment + LLM + resolve.
// If classification genuinely takes >15 min, the item is retried — which
// is the correct behavior for a stuck/failed processing attempt.
const DefaultLeaseDuration = 15 * 60
