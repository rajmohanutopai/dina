package domain

import (
	"fmt"
	"strings"
)

// PersonaName is a validated persona identifier.
// Valid names are lowercase alphanumeric with optional underscores, 1-64 chars.
type PersonaName string

// NewPersonaName validates and returns a PersonaName.
func NewPersonaName(name string) (PersonaName, error) {
	if name == "" {
		return "", ErrInvalidPersona
	}
	if len(name) > 64 {
		return "", fmt.Errorf("%w: exceeds 64 characters", ErrInvalidPersona)
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return "", fmt.Errorf("%w: invalid character %q", ErrInvalidPersona, c)
		}
	}
	return PersonaName(name), nil
}

// String returns the persona name as a plain string.
func (p PersonaName) String() string { return string(p) }

// DID is a validated Decentralized Identifier string.
// Accepted prefixes: did:plc:, did:key:, did:web:.
type DID string

// NewDID validates and returns a DID.
func NewDID(raw string) (DID, error) {
	if raw == "" {
		return "", ErrInvalidDID
	}
	if !strings.HasPrefix(raw, "did:plc:") &&
		!strings.HasPrefix(raw, "did:key:") &&
		!strings.HasPrefix(raw, "did:web:") {
		return "", fmt.Errorf("%w: unsupported method in %q", ErrInvalidDID, raw)
	}
	return DID(raw), nil
}

// String returns the DID as a plain string.
func (d DID) String() string { return string(d) }

// ClientToken is a per-device authentication token (hashed for storage).
type ClientToken string

// KeyPair holds a raw Ed25519 key pair.
type KeyPair struct {
	Pub  []byte // 32-byte Ed25519 public key
	Priv []byte // 64-byte Ed25519 private key (seed || pub)
}

// TrustLevel represents the trust ring for a contact or agent.
type TrustLevel string

const (
	TrustUnverified       TrustLevel = "unverified"
	TrustVerified         TrustLevel = "verified"
	TrustVerifiedActioned TrustLevel = "verified_actioned"
	TrustBlocked          TrustLevel = "blocked"
	TrustUnknown          TrustLevel = "unknown"
	TrustTrusted          TrustLevel = "trusted"
	TrustUntrusted        TrustLevel = "untrusted"
)

// ValidTrustLevels is the set of accepted trust level values.
var ValidTrustLevels = map[TrustLevel]bool{
	TrustUnverified:       true,
	TrustVerified:         true,
	TrustVerifiedActioned: true,
	TrustBlocked:          true,
	TrustUnknown:          true,
	TrustTrusted:          true,
	TrustUntrusted:        true,
}

// PersonaTier controls the access level for a persona's vault.
type PersonaTier string

const (
	TierOpen       PersonaTier = "open"
	TierRestricted PersonaTier = "restricted"
	TierLocked     PersonaTier = "locked"
)
