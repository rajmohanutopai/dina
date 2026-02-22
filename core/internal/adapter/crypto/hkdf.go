package crypto

import (
	"crypto/sha256"
	"fmt"
	"io"

	"github.com/anthropics/dina/core/internal/port"
	"golang.org/x/crypto/hkdf"
)

// Compile-time check: HKDFKeyDeriver satisfies port.VaultDEKDeriver.
var _ port.VaultDEKDeriver = (*HKDFKeyDeriver)(nil)

// HKDFKeyDeriver implements port.VaultDEKDeriver for HKDF-SHA256 DEK derivation.
// Also provides DerivePassphraseKEK as a convenience method (delegates to Argon2Deriver).
type HKDFKeyDeriver struct {
	argon2 *Argon2Deriver
}

// NewHKDFKeyDeriver returns a new key deriver that combines HKDF and Argon2id.
func NewHKDFKeyDeriver() *HKDFKeyDeriver {
	return &HKDFKeyDeriver{argon2: NewArgon2Deriver()}
}

// DeriveVaultDEK derives a per-persona 256-bit DEK via HKDF-SHA256.
// info string format: "dina:vault:<persona>:v1", salt is user_salt.
func (d *HKDFKeyDeriver) DeriveVaultDEK(masterSeed []byte, personaID string, userSalt []byte) ([]byte, error) {
	if len(masterSeed) == 0 {
		return nil, fmt.Errorf("hkdf: master seed must not be empty")
	}
	if personaID == "" {
		return nil, fmt.Errorf("hkdf: persona ID must not be empty")
	}
	if len(userSalt) == 0 {
		return nil, fmt.Errorf("hkdf: user salt must not be empty")
	}

	info := []byte("dina:vault:" + personaID + ":v1")
	reader := hkdf.New(sha256.New, masterSeed, userSalt, info)

	dek := make([]byte, 32)
	if _, err := io.ReadFull(reader, dek); err != nil {
		return nil, fmt.Errorf("hkdf: derivation failed: %w", err)
	}

	return dek, nil
}

// DerivePassphraseKEK hashes a passphrase via Argon2id to produce a KEK.
func (d *HKDFKeyDeriver) DerivePassphraseKEK(passphrase string, salt []byte) ([]byte, error) {
	return d.argon2.DeriveKEK(passphrase, salt)
}
