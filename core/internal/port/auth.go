package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// TokenValidator authenticates incoming requests.
// Two-tier: Ed25519 signature (service keys → TokenService + serviceID,
// device keys → TokenClient + deviceID) + CLIENT_TOKEN bearer (hash lookup → TokenClient).
type TokenValidator interface {
	ValidateClientToken(token string) (deviceID string, ok bool)
	IdentifyToken(token string) (kind domain.TokenType, identity string, err error)
	// VerifySignature validates an Ed25519 request signature.
	// Checks service keys first (returns TokenService + serviceID), then
	// device keys (returns TokenClient + deviceID). Enforces timestamp
	// window + nonce replay cache.
	VerifySignature(did, method, path, query, timestamp string, body []byte, signatureHex string) (kind domain.TokenType, identity string, err error)
}

// ServiceKeyRegistrar allows the composition root to register Ed25519
// service keys (e.g. Brain's public key) for signature verification.
type ServiceKeyRegistrar interface {
	RegisterServiceKey(did string, pubKey []byte, serviceID string)
}

// DeviceKeyRegistrar allows the pairing/device layer to register and revoke
// Ed25519 device keys in the auth validator at runtime.
type DeviceKeyRegistrar interface {
	RegisterDeviceKey(did string, pubKey []byte, deviceID string)
	RevokeDeviceKey(did string)
}

// ClientTokenRegistrar allows the pairing/device layer to register
// CLIENT_TOKENs in the auth validator at runtime so that newly paired
// legacy-token devices can authenticate.
// The optional scope parameter controls the token's privilege level:
//   - "admin": full access (bootstrap token)
//   - "device": restricted access (paired devices, default)
type ClientTokenRegistrar interface {
	RegisterClientToken(token string, deviceID string, scope ...string)
}

// TokenRevoker revokes client tokens by device identity.
type TokenRevoker interface {
	RevokeClientTokenByDevice(deviceIdentity string)
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
