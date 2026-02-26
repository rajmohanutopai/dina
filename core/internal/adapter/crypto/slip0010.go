package crypto

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time check: SLIP0010Deriver satisfies port.HDKeyDeriver.
var _ port.HDKeyDeriver = (*SLIP0010Deriver)(nil)

// SLIP0010Deriver implements testutil.HDKeyDeriver — SLIP-0010 Ed25519 hardened derivation.
type SLIP0010Deriver struct{}

// NewSLIP0010Deriver returns a new SLIP-0010 deriver.
func NewSLIP0010Deriver() *SLIP0010Deriver { return &SLIP0010Deriver{} }

// DerivePath derives an Ed25519 keypair from seed at the given SLIP-0010 path.
// Only hardened paths are accepted (e.g., m/9999'/0').
// BIP-44 purpose 44' is forbidden to prevent crypto wallet collision.
func (d *SLIP0010Deriver) DerivePath(seed []byte, path string) (pub, priv []byte, err error) {
	if len(seed) == 0 {
		return nil, nil, fmt.Errorf("slip0010: seed must not be empty")
	}

	indices, err := parsePath(path)
	if err != nil {
		return nil, nil, err
	}

	// Check for forbidden BIP-44 purpose.
	if len(indices) > 0 && indices[0] == 44+0x80000000 {
		return nil, nil, fmt.Errorf("slip0010: BIP-44 purpose 44' is forbidden in Dina")
	}

	// SLIP-0010 master key derivation: HMAC-SHA512 with key "ed25519 seed".
	mac := hmac.New(sha512.New, []byte("ed25519 seed"))
	mac.Write(seed)
	I := mac.Sum(nil)

	key := I[:32]   // IL = private key
	chain := I[32:] // IR = chain code

	// Derive child keys along the path.
	for _, index := range indices {
		key, chain, err = deriveChild(key, chain, index)
		if err != nil {
			return nil, nil, err
		}
	}

	// Generate Ed25519 keypair from the derived 32-byte key.
	signer := NewEd25519Signer()
	pub, priv, err = signer.GenerateFromSeed(key)
	if err != nil {
		return nil, nil, fmt.Errorf("slip0010: key generation: %w", err)
	}

	return pub, priv, nil
}

// parsePath parses a BIP-32 derivation path like "m/9999'/0'" into hardened indices.
func parsePath(path string) ([]uint32, error) {
	if path == "" {
		return nil, fmt.Errorf("slip0010: path must not be empty")
	}

	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "m/") && path != "m" {
		return nil, fmt.Errorf("slip0010: path must start with 'm/'")
	}

	if path == "m" {
		return nil, nil // master key only
	}

	parts := strings.Split(path[2:], "/")
	indices := make([]uint32, 0, len(parts))

	for _, part := range parts {
		if part == "" {
			continue
		}

		hardened := strings.HasSuffix(part, "'")
		if !hardened {
			return nil, fmt.Errorf("slip0010: only hardened derivation is allowed for Ed25519 (path segment %q missing ')", part)
		}

		numStr := strings.TrimSuffix(part, "'")
		num, err := strconv.ParseUint(numStr, 10, 31)
		if err != nil {
			return nil, fmt.Errorf("slip0010: invalid path segment %q: %w", part, err)
		}

		// Hardened index = value + 0x80000000.
		indices = append(indices, uint32(num)+0x80000000)
	}

	return indices, nil
}

// deriveChild derives a hardened child key from parent key and chain code.
func deriveChild(parentKey, parentChain []byte, index uint32) (key, chain []byte, err error) {
	// For hardened derivation: data = 0x00 || parent_key || index (4 bytes big-endian).
	data := make([]byte, 1+32+4)
	data[0] = 0x00
	copy(data[1:33], parentKey)
	binary.BigEndian.PutUint32(data[33:37], index)

	mac := hmac.New(sha512.New, parentChain)
	mac.Write(data)
	I := mac.Sum(nil)

	return I[:32], I[32:], nil
}
