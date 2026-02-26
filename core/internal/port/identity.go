package port

import (
	"context"
	"crypto/ed25519"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// KeyDeriver derives per-persona Data Encryption Keys from the master seed.
type KeyDeriver interface {
	DerivePersonaDEK(seed []byte, persona domain.PersonaName) ([]byte, error)
	DeriveSigningKey(seed []byte, index uint32) (ed25519.PrivateKey, error)
	DeriveBackupKey(seed []byte) ([]byte, error)
}

// IdentitySigner provides stateful Ed25519 signing with a bound key.
type IdentitySigner interface {
	Sign(ctx context.Context, data []byte) ([]byte, error)
	PublicKey() ed25519.PublicKey
}

// Verifier validates Ed25519 signatures.
type Verifier interface {
	Verify(publicKey ed25519.PublicKey, message, signature []byte) (bool, error)
}

// DIDResolver resolves a DID to its DID Document.
type DIDResolver interface {
	Resolve(ctx context.Context, did domain.DID) (*domain.DIDDocument, error)
	InvalidateCache(did domain.DID)
}

// DIDManager handles DID lifecycle operations (create, rotate, resolve).
type DIDManager interface {
	Create(ctx context.Context, publicKey []byte) (domain.DID, error)
	Resolve(ctx context.Context, did domain.DID) ([]byte, error)
	Rotate(ctx context.Context, did domain.DID, oldPrivKey, newPubKey []byte) error
}

// PersonaManager handles persona lifecycle operations.
type PersonaManager interface {
	Create(ctx context.Context, name, tier string) (string, error)
	List(ctx context.Context) ([]string, error)
	Unlock(ctx context.Context, personaID, passphrase string, ttlSeconds int) error
	Lock(ctx context.Context, personaID string) error
	IsLocked(personaID string) (bool, error)
	Delete(ctx context.Context, personaID string) error
}

// ContactDirectory manages the contact registry in identity.sqlite.
type ContactDirectory interface {
	Add(ctx context.Context, did, name, trustLevel string) error
	Resolve(ctx context.Context, name string) (string, error)
	UpdateTrust(ctx context.Context, did, trustLevel string) error
	UpdateName(ctx context.Context, did, name string) error
	Delete(ctx context.Context, did string) error
	List(ctx context.Context) ([]domain.Contact, error)
}

// DeviceRegistry manages paired device records.
type DeviceRegistry interface {
	Register(ctx context.Context, name string, tokenHash []byte) (string, error)
	List(ctx context.Context) ([]domain.Device, error)
	Revoke(ctx context.Context, deviceID string) error
}

// RecoveryManager implements Shamir's Secret Sharing for key recovery.
type RecoveryManager interface {
	Split(secret []byte, k, n int) ([][]byte, error)
	Combine(shares [][]byte) ([]byte, error)
}
