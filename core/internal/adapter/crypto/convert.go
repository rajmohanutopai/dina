package crypto

import (
	"crypto/ed25519"
	"crypto/sha512"
	"fmt"
	"math/big"

	"github.com/anthropics/dina/core/internal/port"
)

// p is the prime for Curve25519: 2^255 - 19.
var curve25519P = func() *big.Int {
	p := new(big.Int).Exp(big.NewInt(2), big.NewInt(255), nil)
	p.Sub(p, big.NewInt(19))
	return p
}()

// Compile-time check: KeyConverter satisfies port.KeyConverter.
var _ port.KeyConverter = (*KeyConverter)(nil)

// KeyConverter implements testutil.KeyConverter — Ed25519 ↔ X25519 conversion.
type KeyConverter struct{}

// NewKeyConverter returns a new key converter.
func NewKeyConverter() *KeyConverter { return &KeyConverter{} }

// Ed25519ToX25519Private converts an Ed25519 private key to an X25519 private key.
// Standard derivation: SHA-512 hash of the seed, clamp the first 32 bytes.
func (c *KeyConverter) Ed25519ToX25519Private(ed25519Priv []byte) ([]byte, error) {
	if len(ed25519Priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("convert: Ed25519 private key must be %d bytes, got %d", ed25519.PrivateKeySize, len(ed25519Priv))
	}

	// Ed25519 private key = seed (32 bytes) || public key (32 bytes).
	seed := ed25519Priv[:ed25519.SeedSize]
	h := sha512.Sum512(seed)

	// Clamp: clear bits 0,1,2 of first byte; clear bit 255, set bit 254.
	h[0] &= 248
	h[31] &= 127
	h[31] |= 64

	x25519Priv := make([]byte, 32)
	copy(x25519Priv, h[:32])
	return x25519Priv, nil
}

// Ed25519ToX25519Public converts an Ed25519 public key to an X25519 public key
// using the birational Edwards→Montgomery map: u = (1 + y) / (1 - y) mod p.
func (c *KeyConverter) Ed25519ToX25519Public(ed25519Pub []byte) ([]byte, error) {
	if len(ed25519Pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("convert: Ed25519 public key must be %d bytes, got %d", ed25519.PublicKeySize, len(ed25519Pub))
	}

	// Ed25519 public key is the y-coordinate in little-endian, with the
	// sign of x in the high bit of the last byte.
	// Extract y by clearing the sign bit.
	yBytes := make([]byte, 32)
	copy(yBytes, ed25519Pub)
	yBytes[31] &= 0x7f

	// Convert from little-endian to big.Int.
	reversed := make([]byte, 32)
	for i := 0; i < 32; i++ {
		reversed[i] = yBytes[31-i]
	}
	y := new(big.Int).SetBytes(reversed)

	// u = (1 + y) / (1 - y) mod p
	one := big.NewInt(1)
	num := new(big.Int).Add(one, y)
	num.Mod(num, curve25519P)

	den := new(big.Int).Sub(one, y)
	den.Mod(den, curve25519P)
	if den.Sign() < 0 {
		den.Add(den, curve25519P)
	}

	// Modular inverse: den^(p-2) mod p (Fermat's little theorem).
	pMinus2 := new(big.Int).Sub(curve25519P, big.NewInt(2))
	denInv := new(big.Int).Exp(den, pMinus2, curve25519P)

	u := new(big.Int).Mul(num, denInv)
	u.Mod(u, curve25519P)

	// Convert to little-endian 32 bytes.
	uBigEndian := u.Bytes()
	result := make([]byte, 32)
	for i, b := range uBigEndian {
		result[len(uBigEndian)-1-i] = b
	}

	return result, nil
}
