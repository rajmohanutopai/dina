package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// AgentSessionManager manages named agent sessions.
// Sessions scope access grants — when the session ends, all grants are revoked.
type AgentSessionManager interface {
	// StartSession creates a new named session for an agent.
	// Returns error if a session with the same name is already active for this agent.
	StartSession(ctx context.Context, agentDID, name string) (*domain.AgentSession, error)

	// EndSession ends an active session and revokes all its grants.
	EndSession(ctx context.Context, agentDID, name string) error

	// GetSession returns an active session by agent DID and name.
	GetSession(ctx context.Context, agentDID, name string) (*domain.AgentSession, error)

	// ListSessions returns all sessions for an agent (or all agents if agentDID is empty).
	ListSessions(ctx context.Context, agentDID string) ([]domain.AgentSession, error)

	// AddGrant adds a persona access grant to a session.
	AddGrant(ctx context.Context, sessionID, personaID, scope, grantedBy string) error

	// CheckGrant checks if a session has an active grant for a persona.
	CheckGrant(ctx context.Context, sessionID, personaID string) (bool, error)
}
