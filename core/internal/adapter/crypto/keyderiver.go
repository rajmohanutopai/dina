package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"fmt"
	"io"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	"golang.org/x/crypto/hkdf"
)

var _ port.KeyDeriver = (*KeyDeriver)(nil)

// KeyDeriver derives per-persona DEKs, signing keys, and backup keys
// from a master seed using HKDF-SHA256 and SLIP-0010.
type KeyDeriver struct {
	hd *SLIP0010Deriver
}

// NewKeyDeriver returns a new KeyDeriver.
func NewKeyDeriver(hd *SLIP0010Deriver) *KeyDeriver {
	return &KeyDeriver{hd: hd}
}

// DerivePersonaDEK derives a 32-byte Data Encryption Key for a persona
// using HKDF-SHA256 with persona-specific info.
func (d *KeyDeriver) DerivePersonaDEK(seed []byte, persona domain.PersonaName) ([]byte, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	info := []byte("dina:persona:" + string(persona) + ":dek:v1")
	salt := sha256.Sum256([]byte("dina:salt:" + string(persona)))
	reader := hkdf.New(sha256.New, seed, salt[:], info)
	dek := make([]byte, 32)
	if _, err := io.ReadFull(reader, dek); err != nil {
		return nil, fmt.Errorf("keyderiver: HKDF derivation failed: %w", err)
	}
	return dek, nil
}

// DeriveSigningKey derives an Ed25519 private key at the given index
// using SLIP-0010 child derivation (m/9999'/index').
func (d *KeyDeriver) DeriveSigningKey(seed []byte, index uint32) (ed25519.PrivateKey, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	path := fmt.Sprintf("m/9999'/%d'", index)
	_, priv, err := d.hd.DerivePath(seed, path)
	if err != nil {
		return nil, fmt.Errorf("keyderiver: signing key derivation failed: %w", err)
	}
	// SLIP-0010 returns a 32-byte seed; expand to full Ed25519 private key.
	if len(priv) == ed25519.SeedSize {
		return ed25519.NewKeyFromSeed(priv), nil
	}
	return ed25519.PrivateKey(priv), nil
}

// DeriveBackupKey derives a 32-byte backup encryption key using HKDF-SHA256
// with "backup" info.
func (d *KeyDeriver) DeriveBackupKey(seed []byte) ([]byte, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	info := []byte("dina:backup:key:v1")
	salt := sha256.Sum256([]byte("dina:backup:salt"))
	reader := hkdf.New(sha256.New, seed, salt[:], info)
	key := make([]byte, 32)
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, fmt.Errorf("keyderiver: backup key derivation failed: %w", err)
	}
	return key, nil
}
