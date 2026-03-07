package crypto

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/binary"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// secp256k1N is the order of the secp256k1 curve.
var secp256k1N, _ = new(big.Int).SetString("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)

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
			return nil, fmt.Errorf("slip0010: only hardened derivation is allowed (path segment %q missing ')", part)
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

// DerivePathK256 derives a raw 32-byte secp256k1 private key from seed at the
// given BIP-32 path. Uses "Bitcoin seed" as the HMAC key per BIP-32 for
// secp256k1, with proper scalar arithmetic for child derivation:
//
//	child_key = (parse256(I_L) + parent_key) mod n
//
// Invalid keys (I_L >= n or child_key == 0) trigger the BIP-32 retry rule:
// increment the index and re-derive.
//
// The returned key bytes can be passed directly to atcrypto.ParsePrivateBytesK256().
func (d *SLIP0010Deriver) DerivePathK256(seed []byte, path string) ([]byte, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("slip0010: seed must not be empty")
	}

	indices, err := parsePath(path)
	if err != nil {
		return nil, err
	}

	if len(indices) > 0 && indices[0] == 44+0x80000000 {
		return nil, fmt.Errorf("slip0010: BIP-44 purpose 44' is forbidden in Dina")
	}

	// BIP-32 master key derivation for secp256k1: HMAC-SHA512 with key "Bitcoin seed".
	mac := hmac.New(sha512.New, []byte("Bitcoin seed"))
	mac.Write(seed)
	I := mac.Sum(nil)

	masterKey := new(big.Int).SetBytes(I[:32])
	chain := make([]byte, 32)
	copy(chain, I[32:])

	// Validate master key: must be < n and non-zero.
	if masterKey.Cmp(secp256k1N) >= 0 || masterKey.Sign() == 0 {
		return nil, fmt.Errorf("slip0010: invalid secp256k1 master key (extremely rare)")
	}

	parentKey := masterKey

	// Derive child keys along the path using BIP-32 secp256k1 rules.
	for _, index := range indices {
		parentKey, chain, err = deriveChildK256(parentKey, chain, index)
		if err != nil {
			return nil, err
		}
	}

	// Pad to 32 bytes (big.Int.Bytes() strips leading zeros).
	keyBytes := parentKey.Bytes()
	if len(keyBytes) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(keyBytes):], keyBytes)
		keyBytes = padded
	}

	return keyBytes, nil
}

// deriveChildK256 derives a hardened child key for secp256k1 per BIP-32:
//
//	data = 0x00 || ser256(parent_key) || ser32(index)
//	I = HMAC-SHA512(parent_chain, data)
//	child_key = (parse256(I_L) + parent_key) mod n
//
// If parse256(I_L) >= n or child_key == 0, the index is incremented (retry).
func deriveChildK256(parentKey *big.Int, parentChain []byte, index uint32) (*big.Int, []byte, error) {
	const maxRetries = 256

	for attempt := 0; attempt < maxRetries; attempt++ {
		currentIndex := index + uint32(attempt)

		// Serialize parent key as 32 bytes (big-endian, zero-padded).
		pkBytes := parentKey.Bytes()
		data := make([]byte, 1+32+4)
		data[0] = 0x00
		copy(data[1+32-len(pkBytes):33], pkBytes)
		binary.BigEndian.PutUint32(data[33:37], currentIndex)

		mac := hmac.New(sha512.New, parentChain)
		mac.Write(data)
		I := mac.Sum(nil)

		il := new(big.Int).SetBytes(I[:32])
		childChain := make([]byte, 32)
		copy(childChain, I[32:])

		// BIP-32: if I_L >= n, this key is invalid — retry with next index.
		if il.Cmp(secp256k1N) >= 0 {
			continue
		}

		// child_key = (I_L + parent_key) mod n
		childKey := new(big.Int).Add(il, parentKey)
		childKey.Mod(childKey, secp256k1N)

		// BIP-32: if child_key == 0, invalid — retry.
		if childKey.Sign() == 0 {
			continue
		}

		return childKey, childChain, nil
	}

	return nil, nil, fmt.Errorf("slip0010: failed to derive valid secp256k1 child key after %d attempts", maxRetries)
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
