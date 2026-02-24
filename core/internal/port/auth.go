package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// TokenValidator authenticates incoming requests.
// Three-tier: Ed25519 signature (did:key lookup) + BRAIN_TOKEN (constant-time)
// + CLIENT_TOKEN (hash lookup).
type TokenValidator interface {
	ValidateBrainToken(token string) bool
	ValidateClientToken(token string) (deviceID string, ok bool)
	IdentifyToken(token string) (kind domain.TokenType, identity string, err error)
	// VerifySignature validates an Ed25519 request signature.
	// It looks up the DID in the device registry, checks replay protection
	// (timestamp window), and verifies the cryptographic signature.
	VerifySignature(did, method, path, timestamp string, body []byte, signatureHex string) (kind domain.TokenType, identity string, err error)
}

// DeviceKeyRegistrar allows the pairing/device layer to register and revoke
// Ed25519 device keys in the auth validator at runtime.
type DeviceKeyRegistrar interface {
	RegisterDeviceKey(did string, pubKey []byte, deviceID string)
	RevokeDeviceKey(did string)
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
