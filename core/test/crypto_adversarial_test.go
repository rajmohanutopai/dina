package test

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ==========================================================================
// Adversarial & Negative Tests — Cryptographic Isolation
// These tests verify that key derivation and vault encryption boundaries
// hold under adversarial conditions per architecture §5 and §6.
// ==========================================================================

// ---------- §B1 — HKDF Cross-Persona DEK Isolation ----------

// TST-ADV-026: Different persona names produce different DEKs from same master seed.
// Architecture §5: "Per-persona DEK isolation — HKDF with different info strings."
func TestAdv_29_6_HKDFCrossPersona(t *testing.T) {
	deriver := dinacrypto.NewHKDFKeyDeriver()
	masterSeed := make([]byte, 64) // simulated BIP-39 seed
	for i := range masterSeed {
		masterSeed[i] = byte(i + 1)
	}
	userSalt := []byte("test-user-salt-unique-per-node")

	personas := []string{"personal", "health", "financial", "social", "professional"}
	deks := make(map[string][]byte)

	for _, p := range personas {
		dek, err := deriver.DeriveVaultDEK(masterSeed, p, userSalt)
		if err != nil {
			t.Fatalf("DeriveVaultDEK(%q): %v", p, err)
		}
		if len(dek) != 32 {
			t.Fatalf("DEK for %q should be 32 bytes, got %d", p, len(dek))
		}
		deks[p] = dek
	}

	// Verify ALL pairs are different — compromise of one DEK cannot derive another.
	for i, p1 := range personas {
		for j, p2 := range personas {
			if i >= j {
				continue
			}
			if bytes.Equal(deks[p1], deks[p2]) {
				t.Fatalf("DEK collision: %q and %q produced identical DEKs — isolation broken", p1, p2)
			}
		}
	}
}

// TST-ADV-027: Same persona + same seed + different user_salt → different DEKs.
// Architecture §5: "user_salt uniqueness — two nodes with same mnemonic get different DEKs."
func TestAdv_29_6_HKDFUserSalt(t *testing.T) {
	deriver := dinacrypto.NewHKDFKeyDeriver()
	masterSeed := make([]byte, 64)
	for i := range masterSeed {
		masterSeed[i] = byte(i + 1)
	}

	salt1 := []byte("node-A-user-salt")
	salt2 := []byte("node-B-user-salt")

	dek1, err := deriver.DeriveVaultDEK(masterSeed, "personal", salt1)
	if err != nil {
		t.Fatalf("DeriveVaultDEK salt1: %v", err)
	}
	dek2, err := deriver.DeriveVaultDEK(masterSeed, "personal", salt2)
	if err != nil {
		t.Fatalf("DeriveVaultDEK salt2: %v", err)
	}

	if bytes.Equal(dek1, dek2) {
		t.Fatal("same seed + different user_salt must produce different DEKs")
	}
}

// TST-ADV-028: HKDF determinism — same inputs always produce same DEK.
// Architecture §5: "Deterministic recovery — same mnemonic → same DEKs."
func TestAdv_29_6_HKDFDeterminism(t *testing.T) {
	deriver := dinacrypto.NewHKDFKeyDeriver()
	masterSeed := make([]byte, 64)
	for i := range masterSeed {
		masterSeed[i] = byte(i + 1)
	}
	userSalt := []byte("determinism-test-salt")

	dek1, _ := deriver.DeriveVaultDEK(masterSeed, "health", userSalt)
	dek2, _ := deriver.DeriveVaultDEK(masterSeed, "health", userSalt)

	if !bytes.Equal(dek1, dek2) {
		t.Fatal("HKDF must be deterministic — same inputs must produce identical DEKs")
	}
}

// ---------- §B2 — SLIP-0010 Hardened Path Enforcement ----------

// TST-ADV-029: Non-hardened derivation path is rejected.
// Architecture §6: "Only hardened derivation is allowed for Ed25519."
func TestAdv_29_7_SLIP0010NonHardened(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	seed := make([]byte, 64)
	for i := range seed {
		seed[i] = byte(i + 1)
	}

	// Non-hardened path (missing ' on segments) should be rejected.
	_, _, err := slip.DerivePath(seed, "m/9999/0")
	if err == nil {
		t.Fatal("non-hardened path m/9999/0 should be rejected for Ed25519")
	}
}

// TST-ADV-030: BIP-44 purpose 44' is explicitly forbidden.
// Architecture §6: "Purpose 9999' namespace isolation — 44' strictly forbidden."
func TestAdv_29_7_SLIP0010BIP44Forbidden(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	seed := make([]byte, 64)
	for i := range seed {
		seed[i] = byte(i + 1)
	}

	// BIP-44 purpose 44' must be rejected to prevent crypto wallet collision.
	_, _, err := slip.DerivePath(seed, "m/44'/0'")
	if err == nil {
		t.Fatal("BIP-44 purpose 44' should be forbidden in Dina")
	}
}

// TST-ADV-031: Sibling hardened paths produce unrelated keypairs.
// Architecture §6: "Hardened derivation unlinkability — siblings cannot be derived from each other."
func TestAdv_29_7_SLIP0010SiblingUnlink(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	seed := make([]byte, 64)
	for i := range seed {
		seed[i] = byte(i + 1)
	}

	pub1, priv1, err := slip.DerivePath(seed, "m/9999'/1'")
	if err != nil {
		t.Fatalf("derive m/9999'/1': %v", err)
	}
	pub2, priv2, err := slip.DerivePath(seed, "m/9999'/2'")
	if err != nil {
		t.Fatalf("derive m/9999'/2': %v", err)
	}

	// Public keys must be different.
	if bytes.Equal(pub1, pub2) {
		t.Fatal("sibling public keys m/9999'/1' and m/9999'/2' must differ")
	}

	// Private keys must be different.
	if bytes.Equal(priv1, priv2) {
		t.Fatal("sibling private keys m/9999'/1' and m/9999'/2' must differ")
	}

	// Verify each keypair can sign/verify independently.
	message := []byte("test-message")
	sig1 := ed25519.Sign(ed25519.PrivateKey(priv1), message)
	sig2 := ed25519.Sign(ed25519.PrivateKey(priv2), message)

	// sig1 verifies with pub1 but NOT pub2 (unlinkable).
	if !ed25519.Verify(ed25519.PublicKey(pub1), message, sig1) {
		t.Fatal("sig1 should verify with pub1")
	}
	if ed25519.Verify(ed25519.PublicKey(pub2), message, sig1) {
		t.Fatal("sig1 must NOT verify with pub2 — siblings must be unlinkable")
	}

	// sig2 verifies with pub2 but NOT pub1.
	if !ed25519.Verify(ed25519.PublicKey(pub2), message, sig2) {
		t.Fatal("sig2 should verify with pub2")
	}
	if ed25519.Verify(ed25519.PublicKey(pub1), message, sig2) {
		t.Fatal("sig2 must NOT verify with pub1 — siblings must be unlinkable")
	}
}

// ---------- §B3 — KeyDeriver Persona Isolation ----------

// TST-ADV-032: KeyDeriver.DerivePersonaDEK produces different keys per persona.
// Architecture §5: "each persona gets its own HKDF-derived DEK."
func TestAdv_29_6_KeyDeriverPersonaDEK(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)

	seed := make([]byte, 64)
	for i := range seed {
		seed[i] = byte(i + 1)
	}

	personaNames := []string{"personal", "health", "financial"}
	deks := make(map[string][]byte)

	for _, name := range personaNames {
		p, err := domain.NewPersonaName(name)
		if err != nil {
			t.Fatalf("NewPersonaName(%q): %v", name, err)
		}
		dek, err := kd.DerivePersonaDEK(seed, p)
		if err != nil {
			t.Fatalf("DerivePersonaDEK(%q): %v", name, err)
		}
		deks[name] = dek
	}

	// All DEKs must be distinct.
	for i, n1 := range personaNames {
		for j, n2 := range personaNames {
			if i >= j {
				continue
			}
			if bytes.Equal(deks[n1], deks[n2]) {
				t.Fatalf("persona DEK collision: %q and %q — isolation violated", n1, n2)
			}
		}
	}
}

// TST-ADV-033: DeriveSigningKey at different persona indices produces independent Ed25519 keys.
// Architecture §6: "each persona gets its own signing key at m/9999'/1'/<index>'/<gen>'."
func TestAdv_29_6_KeyDeriverSigningKey(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)

	seed := make([]byte, 64)
	for i := range seed {
		seed[i] = byte(i + 1)
	}

	// Derive persona signing keys at different indexes, all generation 0.
	key0, err := kd.DeriveSigningKey(seed, 0, 0)
	if err != nil {
		t.Fatalf("DeriveSigningKey(0,0): %v", err)
	}
	key1, err := kd.DeriveSigningKey(seed, 1, 0)
	if err != nil {
		t.Fatalf("DeriveSigningKey(1,0): %v", err)
	}
	key2, err := kd.DeriveSigningKey(seed, 2, 0)
	if err != nil {
		t.Fatalf("DeriveSigningKey(2,0): %v", err)
	}

	// All private keys must differ.
	if bytes.Equal([]byte(key0), []byte(key1)) {
		t.Fatal("signing keys at persona 0 and 1 must differ")
	}
	if bytes.Equal([]byte(key1), []byte(key2)) {
		t.Fatal("signing keys at persona 1 and 2 must differ")
	}

	// Each key signs independently — cross-verification must fail.
	message := []byte("cross-verify-test")
	sig0 := ed25519.Sign(key0, message)
	if ed25519.Verify(key1.Public().(ed25519.PublicKey), message, sig0) {
		t.Fatal("key0's signature must NOT verify with key1's public key")
	}

	// Verify different generations at same index also produce different keys.
	key0g1, err := kd.DeriveSigningKey(seed, 0, 1)
	if err != nil {
		t.Fatalf("DeriveSigningKey(0,1): %v", err)
	}
	if bytes.Equal([]byte(key0), []byte(key0g1)) {
		t.Fatal("same persona, different generations must produce different keys")
	}
}

// §B4 — BIP-39 Recovery Safety tests removed.
// BIP-39 mnemonic generation is now handled client-side (Python CLI / install.sh)
// using the Trezor python-mnemonic reference implementation.
// Core receives only the wrapped seed blob — never the raw seed or mnemonic.
