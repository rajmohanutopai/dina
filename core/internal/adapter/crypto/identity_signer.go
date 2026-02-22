package crypto

import (
	"context"
	"crypto/ed25519"

	"github.com/anthropics/dina/core/internal/port"
)

var _ port.IdentitySigner = (*IdentitySigner)(nil)

// IdentitySigner is a stateful wrapper holding an Ed25519 private key.
type IdentitySigner struct {
	privKey ed25519.PrivateKey
}

// NewIdentitySigner returns a new IdentitySigner bound to the given private key.
func NewIdentitySigner(privateKey ed25519.PrivateKey) *IdentitySigner {
	return &IdentitySigner{privKey: privateKey}
}

// Sign produces an Ed25519 signature over data.
func (s *IdentitySigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return ed25519.Sign(s.privKey, data), nil
}

// PublicKey returns the Ed25519 public key.
func (s *IdentitySigner) PublicKey() ed25519.PublicKey {
	return s.privKey.Public().(ed25519.PublicKey)
}
