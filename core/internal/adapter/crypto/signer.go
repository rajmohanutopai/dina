// Package crypto implements cryptographic primitives for dina-core.
package crypto

import (
	"crypto/ed25519"
	"fmt"

	"github.com/anthropics/dina/core/internal/port"
)

// Compile-time check: Ed25519Signer satisfies port.Signer.
var _ port.Signer = (*Ed25519Signer)(nil)

// Ed25519Signer implements port.Signer — Ed25519 signing and verification.
type Ed25519Signer struct{}

// NewEd25519Signer returns a new Ed25519 signer.
func NewEd25519Signer() *Ed25519Signer { return &Ed25519Signer{} }

// GenerateFromSeed creates an Ed25519 keypair from a 32-byte seed.
func (s *Ed25519Signer) GenerateFromSeed(seed []byte) (pub, priv []byte, err error) {
	if len(seed) != ed25519.SeedSize {
		return nil, nil, fmt.Errorf("ed25519: seed must be %d bytes, got %d", ed25519.SeedSize, len(seed))
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return []byte(publicKey), []byte(privateKey), nil
}

// Sign produces an Ed25519 signature over message.
func (s *Ed25519Signer) Sign(privateKey, message []byte) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("ed25519: private key must be %d bytes, got %d", ed25519.PrivateKeySize, len(privateKey))
	}
	sig := ed25519.Sign(ed25519.PrivateKey(privateKey), message)
	return sig, nil
}

// Verify checks an Ed25519 signature.
func (s *Ed25519Signer) Verify(publicKey, message, signature []byte) (bool, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return false, fmt.Errorf("ed25519: public key must be %d bytes, got %d", ed25519.PublicKeySize, len(publicKey))
	}
	if len(signature) != ed25519.SignatureSize {
		return false, nil
	}
	return ed25519.Verify(ed25519.PublicKey(publicKey), message, signature), nil
}
