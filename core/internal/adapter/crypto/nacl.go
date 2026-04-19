package crypto

import (
	"crypto/rand"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/port"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/nacl/box"
)

// Compile-time check: NaClBoxSealer satisfies port.Encryptor.
var _ port.Encryptor = (*NaClBoxSealer)(nil)

// NaClBoxSealer implements port.Encryptor — crypto_box_seal (anonymous sender).
type NaClBoxSealer struct{}

// NewNaClBoxSealer returns a new NaCl box sealer.
func NewNaClBoxSealer() *NaClBoxSealer { return &NaClBoxSealer{} }

// SealAnonymous encrypts plaintext for the recipient's X25519 public key using anonymous auth.
// Generates an ephemeral keypair, derives a shared key, and encrypts.
// Output: ephemeral public key (32 bytes) || box.Seal output (ciphertext + Poly1305 tag).
func (s *NaClBoxSealer) SealAnonymous(plaintext, recipientPub []byte) ([]byte, error) {
	if len(recipientPub) != 32 {
		return nil, fmt.Errorf("nacl: recipient public key must be 32 bytes, got %d", len(recipientPub))
	}
	var recipientKey [32]byte
	copy(recipientKey[:], recipientPub)

	ephPub, ephPriv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("nacl: key generation: %w", err)
	}

	nonce := sealNonce(ephPub[:], recipientPub)
	encrypted := box.Seal(nil, plaintext, &nonce, &recipientKey, ephPriv)

	// Output: ephemeral public key (32) || encrypted (len(plaintext) + box.Overhead).
	result := make([]byte, 32+len(encrypted))
	copy(result[:32], ephPub[:])
	copy(result[32:], encrypted)
	return result, nil
}

// OpenAnonymous decrypts a sealed message using the recipient's X25519 keypair.
func (s *NaClBoxSealer) OpenAnonymous(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error) {
	if len(recipientPub) != 32 {
		return nil, fmt.Errorf("nacl: recipient public key must be 32 bytes, got %d", len(recipientPub))
	}
	if len(recipientPriv) != 32 {
		return nil, fmt.Errorf("nacl: recipient private key must be 32 bytes, got %d", len(recipientPriv))
	}
	if len(ciphertext) < 32+box.Overhead {
		return nil, fmt.Errorf("nacl: ciphertext too short")
	}

	var recipientPubKey, recipientPrivKey [32]byte
	copy(recipientPubKey[:], recipientPub)
	copy(recipientPrivKey[:], recipientPriv)

	var ephPub [32]byte
	copy(ephPub[:], ciphertext[:32])

	nonce := sealNonce(ephPub[:], recipientPub)
	plaintext, ok := box.Open(nil, ciphertext[32:], &nonce, &ephPub, &recipientPrivKey)
	if !ok {
		return nil, fmt.Errorf("nacl: decryption failed")
	}
	return plaintext, nil
}

// sealNonce derives the 24-byte nonce for anonymous sealed boxes.
// Uses BLAKE2b(ephPub || recipientPub) with 24-byte output — the libsodium
// sealed-box standard (crypto_box_seal). This lets anything that speaks
// libsodium sealed-box (Python's PyNaCl, iOS/Android native sodium,
// tweetnacl-js, dina-mobile) interop with Core.
//
// Earlier versions used SHA-512[:24] which was Go-only and broke interop;
// changed to match libsodium. Security is equivalent — BLAKE2b is a PRF-
// quality hash for this purpose.
func sealNonce(ephPub, recipientPub []byte) [24]byte {
	h, _ := blake2b.New(24, nil) // Size = 24 bytes, no key
	h.Write(ephPub)
	h.Write(recipientPub)
	digest := h.Sum(nil)
	var nonce [24]byte
	copy(nonce[:], digest)
	return nonce
}
