package domain

// AgentSession represents a named workspace for an agent's interaction.
// Sessions scope access grants — when the session ends, all grants are revoked.
//
// Session names are unique per agent (one agent can't have two active sessions
// with the same name). Different agents can have different active sessions.
// Sessions persist across process restarts for crash recovery.
type AgentSession struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`       // human-readable, unique per agent
	AgentDID  string        `json:"agent_did"`
	Status    string        `json:"status"`      // "active", "ended"
	Grants    []AccessGrant `json:"grants"`      // persona grants scoped to this session
	CreatedAt int64         `json:"created_at"`
	EndedAt   int64         `json:"ended_at,omitempty"`
}

// Session statuses.
const (
	SessionActive = "active"
	SessionEnded  = "ended"
)
