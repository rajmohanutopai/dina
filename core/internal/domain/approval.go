package domain

// ApprovalRequest represents a pending request for persona access.
// Created when an agent tries to access a sensitive or standard persona
// without an active session grant.
type ApprovalRequest struct {
	ID        string `json:"id"`
	ClientDID string `json:"client_did"`  // requesting agent's DID
	PersonaID string `json:"persona_id"`  // which persona
	SessionID string `json:"session_id"`  // agent session (if any)
	Action    string `json:"action"`      // what action triggered the request
	Scope     string `json:"scope"`       // requested scope: "single", "session"
	Status    string `json:"status"`      // "pending", "approved", "denied", "expired"
	Reason    string `json:"reason"`      // human-readable reason from agent
	GrantedBy string `json:"granted_by"`  // who approved (DID or "telegram")
	ExpiresAt int64  `json:"expires_at"`  // Unix timestamp
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// Approval statuses.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalDenied   = "denied"
	ApprovalExpired  = "expired"
)

// AccessGrant represents an active permission for a client to access a persona.
// Grants are scoped to a session and revoked when the session ends.
type AccessGrant struct {
	ID        string `json:"id"`
	ClientDID string `json:"client_did"`
	PersonaID string `json:"persona_id"`
	SessionID string `json:"session_id"` // scoped to agent session
	Scope     string `json:"scope"`      // "single", "session"
	ExpiresAt int64  `json:"expires_at"`
	GrantedBy string `json:"granted_by"`
	Reason    string `json:"reason"`
	CreatedAt int64  `json:"created_at"`
}
