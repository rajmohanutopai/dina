package domain

// PendingReasonRecord tracks an in-flight reasoning request that is waiting
// for persona approval. Stored in identity.sqlite's pending_reason table.
// Only Core can read/write — Brain communicates via dedicated endpoints.
type PendingReasonRecord struct {
	RequestID   string `json:"request_id"`
	CallerDID   string `json:"caller_did"`
	SessionName string `json:"session_name"`
	ApprovalID  string `json:"approval_id"`
	Status      string `json:"status"`       // pending_approval, resuming, complete, denied, expired, failed
	RequestMeta string `json:"request_meta"` // JSON: prompt, provider, source, persona_tier, user_origin
	Result      string `json:"result"`       // JSON: content, model, tokens (only when complete)
	Error       string `json:"error"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
	ExpiresAt   int64  `json:"expires_at"`
}

// Pending reason status constants.
const (
	ReasonPendingApproval = "pending_approval"
	ReasonResuming        = "resuming"
	ReasonComplete        = "complete"
	ReasonDenied          = "denied"
	ReasonExpired         = "expired"
	ReasonFailed          = "failed"
)

// ReasonAccepted is the 202 response when a reasoning request needs approval.
// Returned by Core to the CLI — the CLI polls for the result.
type ReasonAccepted struct {
	RequestID  string `json:"request_id"`
	ApprovalID string `json:"approval_id"`
	Persona    string `json:"persona"`
	Status     string `json:"status"`  // "pending_approval"
	Message    string `json:"message"`
}

// ReasonStatusResponse is the polling response for a pending reasoning request.
// Returned by GET /api/v1/reason/{id}/status.
type ReasonStatusResponse struct {
	RequestID        string `json:"request_id"`
	Status           string `json:"status"`
	Content          string `json:"content,omitempty"`
	Model            string `json:"model,omitempty"`
	TokensIn         int    `json:"tokens_in,omitempty"`
	TokensOut        int    `json:"tokens_out,omitempty"`
	VaultContextUsed bool   `json:"vault_context_used,omitempty"`
	Error            string `json:"error,omitempty"`
}

// DefaultPendingReasonTTL matches approval request TTL (30 minutes).
// After the approval expires, the pending reason should also expire.
// Completed/denied/failed records are kept for 1 hour for CLI polling,
// then swept.
const DefaultPendingReasonTTL = 30 * 60 // 30 minutes (matches approval expiry)

// CompletedReasonRetention is how long completed/denied/failed records
// are kept for CLI polling before being swept.
const CompletedReasonRetention = 60 * 60 // 1 hour
