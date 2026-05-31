// rpc_decrypt.go — NaCl sealed-box decryption for RPC envelopes.
//
// CLI encrypts the inner request JSON with Core's X25519 public key
// (derived from Ed25519 #dina_signing). Core decrypts with its X25519
// private key (derived from Ed25519 private key via SHA-512 clamping).
//
// MBX-021: This sits between the MsgBox envelope parser and the RPC bridge.
package transport

import (
	"encoding/base64"
	"fmt"
)

// Decryptor is the interface for NaCl sealed-box operations.
// Matches port.Encryptor interface.
type Decryptor interface {
	OpenAnonymous(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error)
	SealAnonymous(plaintext, recipientPub []byte) ([]byte, error)
}

// KeyConverter converts Ed25519 keys to X25519 for NaCl operations.
type KeyConverter interface {
	Ed25519ToX25519Private(ed25519Priv []byte) ([]byte, error)
	Ed25519ToX25519Public(ed25519Pub []byte) ([]byte, error)
}

// RPCDecryptor decrypts RPC envelope ciphertexts using NaCl sealed-box.
type RPCDecryptor struct {
	decryptor    Decryptor
	converter    KeyConverter
	x25519Pub    []byte // Core's X25519 public key (derived from Ed25519)
	x25519Priv   []byte // Core's X25519 private key (derived from Ed25519)
}

// NewRPCDecryptor creates a decryptor from Core's Ed25519 signing key.
// The Ed25519 keys are converted to X25519 for NaCl operations.
func NewRPCDecryptor(decryptor Decryptor, converter KeyConverter, ed25519Pub, ed25519Priv []byte) (*RPCDecryptor, error) {
	x25519Pub, err := converter.Ed25519ToX25519Public(ed25519Pub)
	if err != nil {
		return nil, fmt.Errorf("rpc_decrypt: convert public key: %w", err)
	}
	x25519Priv, err := converter.Ed25519ToX25519Private(ed25519Priv)
	if err != nil {
		return nil, fmt.Errorf("rpc_decrypt: convert private key: %w", err)
	}
	return &RPCDecryptor{
		decryptor:  decryptor,
		converter:  converter,
		x25519Pub:  x25519Pub,
		x25519Priv: x25519Priv,
	}, nil
}

// DecryptCiphertext takes a base64-encoded NaCl sealed-box ciphertext
// from an RPC envelope and returns the decrypted inner request JSON.
func (d *RPCDecryptor) DecryptCiphertext(ciphertextB64 string) ([]byte, error) {
	if ciphertextB64 == "" {
		return nil, fmt.Errorf("rpc_decrypt: empty ciphertext")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		// Try URL-safe base64.
		ciphertext, err = base64.URLEncoding.DecodeString(ciphertextB64)
		if err != nil {
			return nil, fmt.Errorf("rpc_decrypt: invalid base64: %w", err)
		}
	}
	plaintext, err := d.decryptor.OpenAnonymous(ciphertext, d.x25519Pub, d.x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("rpc_decrypt: NaCl open failed: %w", err)
	}
	return plaintext, nil
}
