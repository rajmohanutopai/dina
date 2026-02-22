package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// TokenValidator authenticates incoming requests.
// Two-tier: BRAIN_TOKEN (constant-time comparison) + CLIENT_TOKEN (hash lookup).
type TokenValidator interface {
	ValidateBrainToken(token string) bool
	ValidateClientToken(token string) (deviceID string, ok bool)
	IdentifyToken(token string) (kind domain.TokenType, identity string, err error)
}

// SessionManager handles browser sessions for the admin UI.
type SessionManager interface {
	Create(ctx context.Context, deviceID string) (sessionID, csrfToken string, err error)
	Validate(ctx context.Context, sessionID string) (deviceID string, err error)
	ValidateCSRF(sessionID, csrfToken string) (bool, error)
	Destroy(ctx context.Context, sessionID string) error
	ActiveSessions() int
}

// PassphraseVerifier validates the user's passphrase for security mode.
type PassphraseVerifier interface {
	Verify(passphrase string) (bool, error)
}

// RateLimiter enforces per-IP request rate limiting.
type RateLimiter interface {
	Allow(ip string) bool
	Reset(ip string)
}
