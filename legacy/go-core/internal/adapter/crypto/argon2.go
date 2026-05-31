package crypto

import (
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/port"
	"golang.org/x/crypto/argon2"
)

const (
	argon2Memory      = 128 * 1024 // 128 MB in KiB
	argon2Iterations  = 3
	argon2Parallelism = 4
	argon2KeyLen      = 32
	argon2SaltLen     = 16
)

// Compile-time check: Argon2Deriver satisfies port.KEKDeriver.
var _ port.KEKDeriver = (*Argon2Deriver)(nil)

// Argon2Deriver implements Argon2id KEK derivation.
type Argon2Deriver struct{}

// NewArgon2Deriver returns a new Argon2id deriver.
func NewArgon2Deriver() *Argon2Deriver { return &Argon2Deriver{} }

// DeriveKEK hashes a passphrase via Argon2id (128MB/3iter/4parallel) to produce a 32-byte KEK.
func (d *Argon2Deriver) DeriveKEK(passphrase string, salt []byte) ([]byte, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("argon2: passphrase must not be empty")
	}
	if len(salt) < argon2SaltLen {
		return nil, fmt.Errorf("argon2: salt must be at least %d bytes, got %d", argon2SaltLen, len(salt))
	}

	kek := argon2.IDKey(
		[]byte(passphrase),
		salt,
		argon2Iterations,
		argon2Memory,
		argon2Parallelism,
		argon2KeyLen,
	)
	return kek, nil
}
