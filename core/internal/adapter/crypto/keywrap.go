package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"io"

	"github.com/anthropics/dina/core/internal/port"
)

// Compile-time check: AESGCMKeyWrapper satisfies port.KeyWrapper.
var _ port.KeyWrapper = (*AESGCMKeyWrapper)(nil)

// AESGCMKeyWrapper implements testutil.KeyWrapper — AES-256-GCM key wrapping.
type AESGCMKeyWrapper struct{}

// NewAESGCMKeyWrapper returns a new key wrapper.
func NewAESGCMKeyWrapper() *AESGCMKeyWrapper { return &AESGCMKeyWrapper{} }

// Wrap encrypts a DEK with a KEK using AES-256-GCM.
// Output format: nonce (12 bytes) || ciphertext+tag.
func (w *AESGCMKeyWrapper) Wrap(dek, kek []byte) ([]byte, error) {
	if len(kek) != 32 {
		return nil, fmt.Errorf("keywrap: KEK must be 32 bytes, got %d", len(kek))
	}
	if len(dek) == 0 {
		return nil, fmt.Errorf("keywrap: DEK must not be empty")
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, fmt.Errorf("keywrap: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("keywrap: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("keywrap: nonce generation: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, dek, nil)
	return ciphertext, nil
}

// Unwrap decrypts a wrapped DEK using the KEK.
func (w *AESGCMKeyWrapper) Unwrap(wrapped, kek []byte) ([]byte, error) {
	if len(kek) != 32 {
		return nil, fmt.Errorf("keywrap: KEK must be 32 bytes, got %d", len(kek))
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, fmt.Errorf("keywrap: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("keywrap: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(wrapped) < nonceSize {
		return nil, fmt.Errorf("keywrap: ciphertext too short")
	}

	nonce, ciphertext := wrapped[:nonceSize], wrapped[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("keywrap: decrypt failed: %w", err)
	}

	return plaintext, nil
}
