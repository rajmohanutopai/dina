package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"fmt"
	"io"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"golang.org/x/crypto/hkdf"
)

var _ port.KeyDeriver = (*KeyDeriver)(nil)

// Top-level SLIP-0010 purpose branches under m/9999'.
// Each purpose gets its own subtree to prevent collisions as any
// category grows (e.g. hundreds of personas won't collide with PLC keys).
const (
	PurposeRootSigning = 0 // m/9999'/0'/...  → root identity signing key (generations)
	PurposePersonas    = 1 // m/9999'/1'/...  → persona signing keys (index/generation)
	PurposePLCRecovery = 2 // m/9999'/2'/...  → secp256k1 PLC rotation keys (generations)
	PurposeServiceAuth = 3 // m/9999'/3'/...  → service-to-service auth keys (Core, Brain, etc.)
)

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
// using HKDF-SHA256 with persona-specific info. Uses v1 derivation path
// for backward compatibility. New code should use DerivePersonaDEKVersioned.
func (d *KeyDeriver) DerivePersonaDEK(seed []byte, persona domain.PersonaName) ([]byte, error) {
	return d.DerivePersonaDEKVersioned(seed, persona, 1)
}

// DerivePersonaDEKVersioned derives a 32-byte Data Encryption Key for a persona
// using HKDF-SHA256, parameterized by DEK version.
//   - Version 1 (legacy): info="dina:persona:<name>:dek:v1", deterministic salt
//   - Version 2 (Argon2id): info="dina:persona:<name>:dek:v2", longer salt context
//
// The version tag in the HKDF info string ensures v1 and v2 produce different DEKs,
// which is required for vault re-encryption during migration.
func (d *KeyDeriver) DerivePersonaDEKVersioned(seed []byte, persona domain.PersonaName, dekVersion int) ([]byte, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	if dekVersion < 1 {
		dekVersion = 1
	}
	info := []byte(fmt.Sprintf("dina:persona:%s:dek:v%d", string(persona), dekVersion))
	salt := sha256.Sum256([]byte("dina:salt:" + string(persona)))
	reader := hkdf.New(sha256.New, seed, salt[:], info)
	dek := make([]byte, 32)
	if _, err := io.ReadFull(reader, dek); err != nil {
		return nil, fmt.Errorf("keyderiver: HKDF derivation failed: %w", err)
	}
	return dek, nil
}

// DeriveRootSigningKey derives the root Ed25519 signing key at the given
// generation using SLIP-0010 child derivation at m/9999'/0'/<generation>'.
// Generation 0 is the initial key; subsequent generations are produced by
// explicit user-driven rotation.
func (d *KeyDeriver) DeriveRootSigningKey(seed []byte, generation uint32) (pub []byte, priv ed25519.PrivateKey, err error) {
	if len(seed) == 0 {
		return nil, nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	path := fmt.Sprintf("m/9999'/%d'/%d'", PurposeRootSigning, generation)
	pubKey, privKey, err := d.hd.DerivePath(seed, path)
	if err != nil {
		return nil, nil, fmt.Errorf("keyderiver: root signing key derivation failed: %w", err)
	}
	if len(privKey) == ed25519.SeedSize {
		return pubKey, ed25519.NewKeyFromSeed(privKey), nil
	}
	return pubKey, ed25519.PrivateKey(privKey), nil
}

// DeriveSigningKey derives an Ed25519 persona signing key at the given
// persona index and generation using SLIP-0010 child derivation at
// m/9999'/1'/<personaIndex>'/<generation>'.
//
// Persona indexes: 0=consumer, 1=professional, 2=social, 3=health,
// 4=financial, 5=citizen, 6+=custom.
func (d *KeyDeriver) DeriveSigningKey(seed []byte, personaIndex uint32, generation uint32) (ed25519.PrivateKey, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	path := fmt.Sprintf("m/9999'/%d'/%d'/%d'", PurposePersonas, personaIndex, generation)
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

// DeriveRotationKey derives a raw 32-byte secp256k1 (k256) private key
// at generation 0 using SLIP-0010 with BIP-32 secp256k1 master derivation
// at m/9999'/2'/0'. The returned bytes can be passed to
// atcrypto.ParsePrivateBytesK256().
func (d *KeyDeriver) DeriveRotationKey(seed []byte) ([]byte, error) {
	return d.DeriveRotationKeyVersioned(seed, 0)
}

// DeriveRotationKeyVersioned derives a raw 32-byte secp256k1 (k256) private
// key at the given generation using SLIP-0010 at m/9999'/2'/<generation>'.
func (d *KeyDeriver) DeriveRotationKeyVersioned(seed []byte, generation uint32) ([]byte, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	path := fmt.Sprintf("m/9999'/%d'/%d'", PurposePLCRecovery, generation)
	key, err := d.hd.DerivePathK256(seed, path)
	if err != nil {
		return nil, fmt.Errorf("keyderiver: rotation key derivation failed: %w", err)
	}
	return key, nil
}

// DeriveServiceKey derives an Ed25519 private key for service-to-service
// authentication at m/9999'/3'/<serviceIndex>'.
// Service indexes: 0=Core, 1=Brain.
func (d *KeyDeriver) DeriveServiceKey(seed []byte, serviceIndex uint32) (ed25519.PrivateKey, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("keyderiver: seed must not be empty")
	}
	path := fmt.Sprintf("m/9999'/%d'/%d'", PurposeServiceAuth, serviceIndex)
	_, priv, err := d.hd.DerivePath(seed, path)
	if err != nil {
		return nil, fmt.Errorf("keyderiver: service key derivation failed: %w", err)
	}
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
