package domain

// StagingItem represents a raw item in the staging inbox awaiting
// Brain classification before being stored to a persona vault.
// Items arrive from connectors (push) or Brain's MCP sync (pull).
type StagingItem struct {
	ID             string `json:"id"`
	ConnectorID    string `json:"connector_id"`
	Source         string `json:"source"`          // gmail, calendar, etc.
	SourceID       string `json:"source_id"`       // external ID for dedup
	SourceHash     string `json:"source_hash"`     // SHA-256 of raw content
	Type           string `json:"type"`            // email, event, note
	Summary        string `json:"summary"`         // subject/headline
	Body           string `json:"body"`            // raw content (cleared after classification)
	Sender         string `json:"sender"`          // who sent it
	Metadata       string `json:"metadata"`        // JSON: labels, attachments, etc.
	Status         string `json:"status"`          // received, classifying, stored, pending_unlock, failed
	TargetPersona  string `json:"target_persona"`  // set by Brain classification
	ClassifiedItem string `json:"classified_item"` // JSON VaultItem ready for storage
	Error          string `json:"error"`           // error message on failure
	RetryCount     int    `json:"retry_count"`     // for exponential backoff
	ClaimedAt      int64  `json:"claimed_at"`      // when Brain claimed it
	LeaseUntil     int64  `json:"lease_until"`     // lease expiry (auto-revert after)
	ExpiresAt      int64  `json:"expires_at"`      // 7-day TTL
	CreatedAt      int64  `json:"created_at"`      // when received
	UpdatedAt      int64  `json:"updated_at"`      // last status change
}

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

// DefaultStagingTTL is 7 days in seconds.
const DefaultStagingTTL = 7 * 24 * 60 * 60

// DefaultLeaseDuration is 5 minutes in seconds.
const DefaultLeaseDuration = 5 * 60
