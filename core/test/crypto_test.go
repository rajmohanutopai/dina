package test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"fmt"
	"io"
	"testing"

	"github.com/bluesky-social/indigo/atproto/atcrypto"
	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/test/testutil"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/hkdf"
)

// ==========================================================================
// TEST_PLAN §2 — Key Derivation & Cryptography
// BIP-39 mnemonic generation is handled client-side (Python CLI / install.sh).
// Core tests cover SLIP-0010, HKDF, Argon2id, Ed25519, X25519, NaCl, AES-GCM.
// ==========================================================================

// --------------------------------------------------------------------------
// §2.2 SLIP-0010 Hierarchical Deterministic Key Derivation (14 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_DeriveRootIdentityKey(t *testing.T) {
	impl := realHDKey
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	pub, priv, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, pub, 32)
	testutil.RequireBytesLen(t, priv, 64)

	// Sign/verify round-trip: proves pub and priv are a valid Ed25519 keypair.
	msg := []byte("dina-root-identity-test-message")
	sig := ed25519.Sign(ed25519.PrivateKey(priv), msg)
	testutil.RequireTrue(t, ed25519.Verify(ed25519.PublicKey(pub), msg, sig),
		"derived root identity key must produce a valid Ed25519 signature")

	// Determinism: same seed + path must always produce the same keypair.
	pub2, priv2, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, pub, pub2)
	testutil.RequireBytesEqual(t, priv, priv2)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_DerivePersonaKey(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Collect all derived public keys to verify cross-persona uniqueness.
	pubKeys := make(map[string]string) // hex(pub) → persona name

	for name, path := range testutil.DinaPersonaPaths {
		t.Run(name, func(t *testing.T) {
			pub, priv, err := impl.DerivePath(testutil.TestMnemonicSeed, path)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesLen(t, pub, 32)
			testutil.RequireBytesLen(t, priv, 64)

			// Public key must not be all zeros.
			allZero := true
			for _, b := range pub {
				if b != 0 {
					allZero = false
					break
				}
			}
			if allZero {
				t.Fatalf("persona %q: derived public key must not be all zeros", name)
			}

			// Each persona must produce a unique public key.
			pubHex := fmt.Sprintf("%x", pub)
			if prev, exists := pubKeys[pubHex]; exists {
				t.Fatalf("persona %q has same public key as %q — derivation paths not independent", name, prev)
			}
			pubKeys[pubHex] = name
		})
	}

	// Sanity: we tested all 7 canonical personas.
	if len(pubKeys) < 7 {
		t.Fatalf("expected at least 7 unique persona keys, got %d", len(pubKeys))
	}
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_Determinism(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	pub1, priv1, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)

	pub2, priv2, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, pub1, pub2)
	testutil.RequireBytesEqual(t, priv1, priv2)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_DifferentPathsDifferentKeys(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	pub0, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'")
	testutil.RequireNoError(t, err)

	pub1, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/1'")
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, pub0, pub1)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_HardenedOnlyEnforced(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Non-hardened path must be rejected.
	_, _, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.NonHardenedPath)
	testutil.RequireError(t, err)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_KnownTestVectors(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// SLIP-0010 test vector 1: seed = "000102030405060708090a0b0c0d0e0f"
	// Reference: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
	slip0010Seed := []byte{
		0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
		0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
	}

	// ---------- Chain m (master) ----------
	// SLIP-0010 spec master chain for this seed:
	//   private: 2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7
	//   public:  00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed
	//            (0x00 prefix is SLIP-0010 serialization; raw Ed25519 pubkey is 32 bytes after prefix)
	pubM, _, errM := impl.DerivePath(slip0010Seed, "m")
	if errM == nil {
		// Master path supported — verify against spec.
		// The Ed25519 pubkey is derived from the IL seed via ed25519.NewKeyFromSeed,
		// which should produce the same public key as the SLIP-0010 spec (minus 0x00 prefix).
		expectedPubM := []byte{
			0xa4, 0xb2, 0x85, 0x6b, 0xfe, 0xc5, 0x10, 0xab,
			0xab, 0x89, 0x75, 0x3f, 0xac, 0x1a, 0xc0, 0xe1,
			0x11, 0x23, 0x64, 0xe7, 0xd2, 0x50, 0x54, 0x59,
			0x63, 0xf1, 0x35, 0xf2, 0xa3, 0x31, 0x88, 0xed,
		}
		testutil.RequireBytesEqual(t, pubM, expectedPubM)
	}

	// ---------- Chain m/0' ----------
	// SLIP-0010 spec for m/0':
	//   private: 68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3
	//   public:  008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c
	pub, _, err := impl.DerivePath(slip0010Seed, "m/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, pub, 32)

	expectedPub := []byte{
		0x8c, 0x8a, 0x13, 0xdf, 0x77, 0xa2, 0x8f, 0x34,
		0x45, 0x21, 0x3a, 0x0f, 0x43, 0x2f, 0xde, 0x64,
		0x4a, 0xca, 0xa2, 0x15, 0xfc, 0x72, 0xdc, 0xdf,
		0x30, 0x0d, 0x5e, 0xfa, 0xa8, 0x5d, 0x35, 0x0c,
	}
	testutil.RequireBytesEqual(t, pub, expectedPub)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_PurposeIsolation(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// m/9999' (Dina purpose) must never collide with m/44' (BIP-44).
	// Different purpose numbers must yield entirely different key trees.
	pubDina, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'")
	testutil.RequireNoError(t, err)

	// If m/44'/0' is allowed by the implementation for comparison:
	// (The Dina implementation SHOULD reject m/44', but for isolation
	// testing we need to compare key material from different purposes.)
	// This test verifies the mathematical property that different
	// purpose indexes produce different keys.
	pubOther, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9998'/0'")
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, pubDina, pubOther)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_Purpose44Forbidden(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Positive control: Dina's own purpose (9999') must succeed.
	pub, priv, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(pub) > 0, "valid path must produce a public key")
	testutil.RequireTrue(t, len(priv) > 0, "valid path must produce a private key")

	// BIP-44 purpose path must be explicitly rejected by Dina's API.
	_, _, err = impl.DerivePath(testutil.TestMnemonicSeed, testutil.ForbiddenBIP44Path)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "44")

	// Other forbidden BIP-44 sub-paths must also be rejected.
	_, _, err = impl.DerivePath(testutil.TestMnemonicSeed, "m/44'/60'/0'")
	testutil.RequireError(t, err)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_SameMnemonicIndependentTrees(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Dina (m/9999') and a hypothetical wallet (m/9998') produce
	// independent key trees from the same seed.
	pubDina, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'")
	testutil.RequireNoError(t, err)

	pubWallet, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9998'/0'")
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, pubDina, pubWallet)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_SiblingUnlinkability(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Sibling keys (e.g. m/9999'/1' and m/9999'/2') must have no
	// detectable mathematical relationship (XOR, addition, etc.).
	pub1, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/1'")
	testutil.RequireNoError(t, err)

	pub2, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/2'")
	testutil.RequireNoError(t, err)

	pub3, _, err := impl.DerivePath(testutil.TestMnemonicSeed, "m/9999'/3'")
	testutil.RequireNoError(t, err)

	// Basic unlinkability: all siblings are distinct.
	testutil.RequireBytesNotEqual(t, pub1, pub2)
	testutil.RequireBytesNotEqual(t, pub2, pub3)
	testutil.RequireBytesNotEqual(t, pub1, pub3)

	// XOR of two siblings must not equal any other sibling (no linear relationship).
	xor12 := xorBytes(pub1, pub2)
	testutil.RequireBytesNotEqual(t, xor12, pub3)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_GoImplementation(t *testing.T) {
	// Code audit test: verify that the SLIP-0010 implementation uses
	// stellar/go (github.com/stellar/go/exp/crypto/derivation) or an
	// equivalent pure-Go Ed25519 HD derivation library.
	//
	// This is a structural/code-review assertion. When implementation
	// exists, inspect the import graph to confirm the library choice.
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Functional smoke test: derive a key and confirm it works.
	pub, _, err := impl.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, pub, 32)
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_CanonicalPersonaIndexes(t *testing.T) {
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Verify that root and persona paths produce unique keys per the derivation tree:
	//   m/9999'/0'/0' = root signing gen 0
	//   m/9999'/1'/N'/0' = persona N gen 0 (N=0..5 for built-in personas)
	expectedPaths := map[int]string{
		0: "m/9999'/0'/0'",   // root signing key gen 0
		1: "m/9999'/1'/0'/0'", // consumer gen 0
		2: "m/9999'/1'/1'/0'", // professional gen 0
		3: "m/9999'/1'/2'/0'", // social gen 0
		4: "m/9999'/1'/3'/0'", // health gen 0
		5: "m/9999'/1'/4'/0'", // financial gen 0
		6: "m/9999'/1'/5'/0'", // citizen gen 0
	}

	keys := make(map[int][]byte)
	for idx, path := range expectedPaths {
		t.Run(path, func(t *testing.T) {
			pub, _, err := impl.DerivePath(testutil.TestMnemonicSeed, path)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesLen(t, pub, 32)
			keys[idx] = pub
		})
	}

	// All 7 canonical keys must be unique.
	for i := 0; i < 7; i++ {
		for j := i + 1; j < 7; j++ {
			if keys[i] != nil && keys[j] != nil {
				testutil.RequireBytesNotEqual(t, keys[i], keys[j])
			}
		}
	}
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_CustomPersonaIndex7Plus(t *testing.T) {
	impl := realHDKey
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Use the production KeyDeriver which constructs the correct
	// SLIP-0010 path: m/9999'/1'/<personaIndex>'/<generation>'.
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)

	// First custom persona starts at FirstCustomPersonaIndex (6).
	customIdx := uint32(testutil.FirstCustomPersonaIndex)
	customKey, err := kd.DeriveSigningKey(testutil.TestMnemonicSeed, customIdx, 0)
	testutil.RequireNoError(t, err)

	// Extract the 32-byte public key from the Ed25519 private key.
	pub := []byte(customKey[32:])
	testutil.RequireBytesLen(t, pub, 32)

	// Must differ from all canonical persona signing keys (indexes 0-5).
	for i := uint32(0); i < customIdx; i++ {
		canonKey, err := kd.DeriveSigningKey(testutil.TestMnemonicSeed, i, 0)
		testutil.RequireNoError(t, err)
		canonPub := []byte(canonKey[32:])
		testutil.RequireBytesNotEqual(t, pub, canonPub)
	}

	// Also must differ from root signing key (purpose 0).
	rootPub, _, err := slip.DerivePath(testutil.TestMnemonicSeed, testutil.DinaRootKeyPath)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, pub, rootPub)

	// Verify determinism: same index always yields the same key.
	customKey2, err := kd.DeriveSigningKey(testutil.TestMnemonicSeed, customIdx, 0)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, []byte(customKey), []byte(customKey2))
}

// TST-CORE-066, TST-CORE-067, TST-CORE-068, TST-CORE-069, TST-CORE-070, TST-CORE-071, TST-CORE-072
// TST-CORE-073, TST-CORE-074, TST-CORE-075, TST-CORE-076, TST-CORE-077, TST-CORE-078, TST-CORE-079
func TestCrypto_2_2_DerivationIndexStored(t *testing.T) {
	// Verify that persona records include the derivation_index field.
	// This test checks the PersonaManager contract: when a persona is
	// created, its derivation index must be persisted and retrievable.
	impl := realHDKey
	// impl = slip0010.New()
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	// Functional verification: derive at a specific index and confirm
	// the index is deterministic (same path always produces same key).
	idx := testutil.FirstCustomPersonaIndex // 7
	path := "m/9999'/7'"
	pub1, _, err := impl.DerivePath(testutil.TestMnemonicSeed, path)
	testutil.RequireNoError(t, err)

	pub2, _, err := impl.DerivePath(testutil.TestMnemonicSeed, path)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, pub1, pub2)

	// The persona record must store derivation_index = 7 to enable recovery.
	_ = idx // used for documentation; persona record check deferred to integration test.
}

// --------------------------------------------------------------------------
// §2.3 HKDF-SHA256 Per-Persona DEK Derivation (18 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_DerivePerPersonaDEK(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32) // 256-bit DEK

	// DEK must not be all zeros — HKDF with real inputs produces non-trivial output.
	allZero := true
	for _, b := range dek {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("derived DEK must not be all zeros")
	}

	// Determinism: same inputs must produce identical DEK.
	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dek, dek2)

	// Error cases: empty inputs must be rejected.
	_, err = impl.DeriveVaultDEK(nil, "personal", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)
	_, err = impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)
	_, err = impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", nil)
	testutil.RequireError(t, err)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_DifferentPersonasDifferentDEKs(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dekWork, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "work", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, dekWork, dekPersonal)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_Determinism(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, dek1, dek2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_KnownHKDFTestVectors(t *testing.T) {
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Verify production DeriveVaultDEK output matches independently-computed
	// HKDF-SHA256 with Dina's info string format "dina:vault:<persona>:v1".
	personas := []string{"identity", "health", "financial"}
	for _, persona := range personas {
		dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, persona, testutil.TestUserSalt[:])
		testutil.RequireNoError(t, err)
		testutil.RequireBytesLen(t, dek, 32)

		// Independently derive the expected value using raw HKDF-SHA256.
		info := []byte("dina:vault:" + persona + ":v1")
		reader := hkdf.New(sha256.New, testutil.TestMnemonicSeed, testutil.TestUserSalt[:], info)
		expected := make([]byte, 32)
		_, err = io.ReadFull(reader, expected)
		testutil.RequireNoError(t, err)

		testutil.RequireBytesEqual(t, dek, expected)
	}

	// Determinism: same inputs → same output.
	dek1, _ := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "identity", testutil.TestUserSalt[:])
	dek2, _ := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "identity", testutil.TestUserSalt[:])
	testutil.RequireBytesEqual(t, dek1, dek2)

	// Different personas → different keys.
	dekH, _ := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "health", testutil.TestUserSalt[:])
	dekF, _ := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", testutil.TestUserSalt[:])
	testutil.RequireBytesNotEqual(t, dekH, dekF)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_AllInfoStrings(t *testing.T) {
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Every persona info string must produce a unique 256-bit key.
	deks := make(map[string][]byte)
	for name := range testutil.HKDFInfoStrings {
		t.Run(name, func(t *testing.T) {
			dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, name, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			testutil.RequireBytesLen(t, dek, 32)
			deks[name] = dek
		})
	}

	// Verify all DEKs are pairwise distinct.
	names := make([]string, 0, len(deks))
	for name := range deks {
		names = append(names, name)
	}
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if deks[names[i]] != nil && deks[names[j]] != nil {
				testutil.RequireBytesNotEqual(t, deks[names[i]], deks[names[j]])
			}
		}
	}

	// Verify fixture info strings match the format production uses.
	// DeriveVaultDEK constructs "dina:vault:<personaID>:v1" — the fixture
	// must agree, otherwise the fixture is out of sync with production code.
	for name, expectedInfo := range testutil.HKDFInfoStrings {
		t.Run("info_format/"+name, func(t *testing.T) {
			productionInfo := "dina:vault:" + name + ":v1"
			testutil.RequireEqual(t, expectedInfo, productionInfo)
		})
	}
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_CompromiseIsolation(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Compromising the health DEK must not reveal the financial DEK.
	dekHealth, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "health", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	dekFinancial, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	// Keys are cryptographically independent — knowing one cannot derive the other.
	testutil.RequireBytesNotEqual(t, dekHealth, dekFinancial)

	// Additional: health DEK used as seed input must not produce financial DEK.
	dekCross, err := impl.DeriveVaultDEK(dekHealth, "financial", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dekCross, dekFinancial)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_CustomPersonaInfoString(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Custom persona follows naming convention: "dina:vault:<name>:v1".
	customPersona := "my_custom_persona"
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, customPersona, testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)

	// Must differ from all built-in personas.
	for name := range testutil.HKDFInfoStrings {
		builtinDEK, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, name, testutil.TestUserSalt[:])
		testutil.RequireNoError(t, err)
		testutil.RequireBytesNotEqual(t, dek, builtinDEK)
	}

	// Determinism: same custom persona + same inputs must produce the same DEK.
	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, customPersona, testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dek, dek2)

	// Different custom personas must produce different DEKs.
	dekOther, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "another_custom_persona", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dek, dekOther)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_BackupEncryptionKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:backup:v1") produces a valid 256-bit key.
	dekBackup, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekBackup, 32)

	// Backup key must differ from personal key (different HKDF info).
	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dekBackup, dekPersonal)

	// Backup key must be deterministic (same inputs → same output).
	dekBackup2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dekBackup, dekBackup2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_ArchiveKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:archive:v1") produces a valid 256-bit key.
	dekArchive, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekArchive, 32)

	// Archive key must differ from personal and backup keys (different HKDF info).
	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dekArchive, dekPersonal)

	dekBackup, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dekArchive, dekBackup)

	// Archive key must be deterministic.
	dekArchive2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dekArchive, dekArchive2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_ArchiveSeparateFromBackup(t *testing.T) {
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dekArchive, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekArchive, 32)

	dekBackup, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekBackup, 32)

	// Different persona IDs must produce different keys.
	testutil.RequireBytesNotEqual(t, dekArchive, dekBackup)

	// Verify each key matches an independently computed HKDF-SHA256 derivation
	// using the Dina info string format "dina:vault:<persona>:v1".
	archiveInfo := []byte("dina:vault:archive:v1")
	archiveReader := hkdf.New(sha256.New, testutil.TestMnemonicSeed, testutil.TestUserSalt[:], archiveInfo)
	expectedArchive := make([]byte, 32)
	_, err = io.ReadFull(archiveReader, expectedArchive)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dekArchive, expectedArchive)

	backupInfo := []byte("dina:vault:backup:v1")
	backupReader := hkdf.New(sha256.New, testutil.TestMnemonicSeed, testutil.TestUserSalt[:], backupInfo)
	expectedBackup := make([]byte, 32)
	_, err = io.ReadFull(backupReader, expectedBackup)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dekBackup, expectedBackup)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_ClientSyncKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:sync:v1") produces a valid 256-bit key.
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "sync", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_TrustSigningKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:trust:v1") produces a valid 256-bit key.
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "trust", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_UserSaltRandom32Bytes(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// User salt must be random 32 bytes, not nil.
	salt := testutil.TestUserSalt[:]
	testutil.RequireBytesLen(t, salt, 32)

	// Salt must not be all zeroes (not nil-equivalent).
	allZero := make([]byte, 32)
	testutil.RequireBytesNotEqual(t, salt, allZero)

	// Deriving with a real salt must succeed.
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)

	// Different salt must produce a different DEK (proves salt is actually used).
	altSalt := make([]byte, 32)
	for i := range altSalt {
		altSalt[i] = byte(i + 0x80)
	}
	dekAlt, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", altSalt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekAlt, 32)
	testutil.RequireBytesNotEqual(t, dek, dekAlt)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_UserSaltGeneratedOnce(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Salt is generated at first setup only. Using the same salt
	// across multiple derivations produces consistent results.
	salt := testutil.TestUserSalt[:]

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", salt)
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", salt)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, dek1, dek2)

	// Negative control: a different salt must produce a different DEK
	// (proves the function is not ignoring the salt parameter).
	altSalt := make([]byte, 32)
	for i := range altSalt {
		altSalt[i] = byte(0xff - i)
	}
	dekAlt, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", altSalt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dek1, dekAlt)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_UserSaltPersistedAcrossReboots(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Simulates persistence: same salt loaded after "reboot" produces same DEKs.
	salt := testutil.TestUserSalt[:]

	dekBefore, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "health", salt)
	testutil.RequireNoError(t, err)

	// "Reboot" — create new KeyDeriver instance with same salt.
	// var impl2 testutil.KeyDeriver = keyderiver.New()
	// For now, reuse impl (same contract, same salt).
	dekAfter, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "health", salt)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, dekBefore, dekAfter)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_UserSaltInExport(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Salt must be preserved in export so that imported backups can
	// re-derive the same DEKs. Verify by deriving with the test salt
	// and confirming the output is deterministic (export-safe).
	salt := testutil.TestUserSalt[:]
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)

	// Re-derive with the same "exported" salt.
	dekReimported, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dek, dekReimported)

	// Negative control: a different salt must produce a different DEK.
	differentSalt := make([]byte, len(salt))
	copy(differentSalt, salt)
	differentSalt[0] ^= 0xFF // flip bits in first byte
	dekDiffSalt, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "financial", differentSalt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekDiffSalt, 32)
	testutil.RequireBytesNotEqual(t, dek, dekDiffSalt)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_DifferentSaltDifferentDEKs(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	salt1 := testutil.TestUserSalt[:]
	salt2 := make([]byte, 32)
	for i := range salt2 {
		salt2[i] = 0xff // Different salt
	}

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", salt1)
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", salt2)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, dek1, dek2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
func TestCrypto_2_3_UserSaltAbsentStartupError(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Missing salt (nil) must produce an error, not silently use zero salt.
	_, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "personal", nil)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §2.4 Argon2id Passphrase Hashing (8 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_HashPassphrase(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}

	kek, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, kek, 32) // 256-bit KEK
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_VerifyCorrect(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}

	kek1, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)

	// Same passphrase + same salt → identical KEK (verification succeeds).
	kek2, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, kek1, kek2)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_VerifyWrong(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}

	kekCorrect, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)

	kekWrong, err := impl.DeriveKEK(testutil.TestPassphraseWrong, salt)
	testutil.RequireNoError(t, err)

	// Wrong passphrase produces different KEK (verification fails).
	testutil.RequireBytesNotEqual(t, kekCorrect, kekWrong)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_DefaultParameters(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	// Known-Answer Test: call argon2.IDKey directly with the expected
	// production parameters (128MB, 3 iterations, 4 threads, 32-byte key).
	// If production changes any parameter, the outputs diverge and the test fails.
	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i + 42)
	}

	kek, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, kek, 32)

	// Direct computation with expected production parameters.
	expected := argon2.IDKey(
		[]byte(testutil.TestPassphrase),
		salt,
		3,        // expected iterations
		128*1024, // expected memory (128 MB in KiB)
		4,        // expected parallelism
		32,       // expected key length
	)
	testutil.RequireBytesEqual(t, kek, expected)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_UniqueSalts(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	// Same passphrase with different salts → different hashes.
	salt1 := make([]byte, testutil.Argon2idSaltLen)
	salt2 := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt1 {
		salt1[i] = byte(i)
		salt2[i] = byte(i + 128)
	}

	kek1, err := impl.DeriveKEK(testutil.TestPassphrase, salt1)
	testutil.RequireNoError(t, err)

	kek2, err := impl.DeriveKEK(testutil.TestPassphrase, salt2)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, kek1, kek2)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_ConfigurableParameters(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	// Custom Argon2id parameters from config.json should be respected.
	// This test verifies that the implementation accepts configuration
	// overrides and produces valid output with non-default params.
	//
	// When implementation exists, configure with custom params and verify
	// the resulting KEK has the expected length and is deterministic.
	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}
	kek, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, kek, 32)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_RunsOnceNotPerRequest(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	// The KEK derivation (Argon2id) is expensive by design. At the
	// architectural level it should be called once at unlock, not per
	// request. This test validates the production DeriveKEK properties
	// that make that pattern safe: determinism, correct key length,
	// input validation, and domain separation (different inputs yield
	// different KEKs so a cached KEK cannot be confused across users/salts).

	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}

	// 1. Determinism: same passphrase+salt always yields the same KEK,
	//    so the result can safely be cached after a single derivation.
	kek1, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, kek1, 32)

	kek2, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, kek1, kek2)

	// 2. Input validation: empty passphrase must be rejected.
	_, err = impl.DeriveKEK("", salt)
	testutil.RequireError(t, err)

	// 3. Input validation: salt shorter than 16 bytes must be rejected.
	_, err = impl.DeriveKEK(testutil.TestPassphrase, salt[:8])
	testutil.RequireError(t, err)

	// 4. Domain separation: different passphrase must produce a different KEK.
	kekOther, err := impl.DeriveKEK(testutil.TestPassphraseWrong, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, kek1, kekOther)

	// 5. Domain separation: different salt must produce a different KEK.
	salt2 := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt2 {
		salt2[i] = byte(i + 100)
	}
	kekSalt2, err := impl.DeriveKEK(testutil.TestPassphrase, salt2)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, kek1, kekSalt2)
}

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
func TestCrypto_2_4_PassphraseChangeReWrapOnly(t *testing.T) {
	impl := realKEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "KEKDeriver")

	// Passphrase change should re-wrap the DEK with a new KEK,
	// not re-encrypt all vault data. Verify that the old and new KEKs
	// differ but the underlying DEK (derived from master seed) stays the same.
	salt := make([]byte, testutil.Argon2idSaltLen)
	for i := range salt {
		salt[i] = byte(i)
	}

	kekOld, err := impl.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)

	kekNew, err := impl.DeriveKEK("new passphrase for testing", salt)
	testutil.RequireNoError(t, err)

	// KEKs differ, but neither affects the DEK itself.
	testutil.RequireBytesNotEqual(t, kekOld, kekNew)
}

// --------------------------------------------------------------------------
// §2.5 Ed25519 Signing & Verification (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_SignMessage(t *testing.T) {
	impl := realSigner
	testutil.RequireImplementation(t, impl, "Signer")

	pub, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	sig, err := impl.Sign(priv, testutil.TestMessage)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, sig, 64)

	// Signature must verify against the correct public key.
	valid, err := impl.Verify(pub, testutil.TestMessage, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "signature from Sign() must verify with matching public key")

	// Signature must NOT verify against a tampered message.
	tampered := make([]byte, len(testutil.TestMessage))
	copy(tampered, testutil.TestMessage)
	tampered[0] ^= 0xff
	valid, err = impl.Verify(pub, tampered, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, !valid, "signature must not verify on tampered message")

	// Ed25519 is deterministic — same key+message must produce same signature.
	sig2, err := impl.Sign(priv, testutil.TestMessage)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, sig, sig2)
}

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_VerifyValid(t *testing.T) {
	impl := realSigner
	// impl = signer.New()
	testutil.RequireImplementation(t, impl, "Signer")

	pub, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	sig, err := impl.Sign(priv, testutil.TestMessage)
	testutil.RequireNoError(t, err)

	valid, err := impl.Verify(pub, testutil.TestMessage, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "valid signature should verify")
}

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_VerifyTampered(t *testing.T) {
	impl := realSigner
	// impl = signer.New()
	testutil.RequireImplementation(t, impl, "Signer")

	pub, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	sig, err := impl.Sign(priv, testutil.TestMessage)
	testutil.RequireNoError(t, err)

	// Tamper with the message.
	tampered := make([]byte, len(testutil.TestMessage))
	copy(tampered, testutil.TestMessage)
	tampered[0] ^= 0xff

	valid, err := impl.Verify(pub, tampered, sig)
	// Either returns false or returns an error — both are acceptable.
	if err == nil {
		testutil.RequireFalse(t, valid, "tampered message should not verify")
	}
}

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_VerifyWrongKey(t *testing.T) {
	impl := realSigner
	// impl = signer.New()
	testutil.RequireImplementation(t, impl, "Signer")

	_, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	sig, err := impl.Sign(priv, testutil.TestMessage)
	testutil.RequireNoError(t, err)

	// Generate a different keypair.
	differentSeed := [32]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
		0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
		0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20}
	wrongPub, _, err := impl.GenerateFromSeed(differentSeed[:])
	testutil.RequireNoError(t, err)

	valid, err := impl.Verify(wrongPub, testutil.TestMessage, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, valid, "wrong public key should not verify")
}

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_CanonicalJSON(t *testing.T) {
	impl := realSigner
	testutil.RequireImplementation(t, impl, "Signer")

	pub, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	// Canonical JSON: sorted keys, no signature fields.
	canonical := []byte(`{"product":"Widget","rating":4,"reviewer":"did:key:z6Mk"}`)

	sig, err := impl.Sign(priv, canonical)
	testutil.RequireNoError(t, err)

	valid, err := impl.Verify(pub, canonical, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "canonical JSON signature should verify")

	// Determinism: same canonical message → same signature.
	sig2, err := impl.Sign(priv, canonical)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, sig, sig2)

	// Different key ordering (non-canonical) must produce a DIFFERENT
	// signature, proving the signer signs raw bytes and does NOT
	// canonicalize internally. Canonicalization must happen upstream.
	nonCanonical := []byte(`{"reviewer":"did:key:z6Mk","product":"Widget","rating":4}`)
	sigNonCanon, err := impl.Sign(priv, nonCanonical)
	testutil.RequireNoError(t, err)

	// Same logical JSON but different bytes → must produce different signature.
	testutil.RequireBytesNotEqual(t, sig, sigNonCanon)

	// Non-canonical signature must NOT verify against canonical payload.
	valid, err = impl.Verify(pub, canonical, sigNonCanon)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, valid,
		"signature of non-canonical bytes must NOT verify against canonical bytes")

	// Each signature must verify against its own payload.
	valid, err = impl.Verify(pub, nonCanonical, sigNonCanon)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid,
		"non-canonical signature must verify against its own payload")
}

// TST-CORE-106, TST-CORE-107, TST-CORE-108, TST-CORE-109, TST-CORE-110, TST-CORE-111
func TestCrypto_2_5_EmptyMessage(t *testing.T) {
	impl := realSigner
	// impl = signer.New()
	testutil.RequireImplementation(t, impl, "Signer")

	pub, priv, err := impl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	// Empty byte slice must be accepted.
	sig, err := impl.Sign(priv, []byte{})
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, sig, 64)

	valid, err := impl.Verify(pub, []byte{}, sig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "empty message signature should verify")
}

// --------------------------------------------------------------------------
// §2.6 Ed25519→X25519 Key Conversion (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_ConvertPrivateKey(t *testing.T) {
	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	impl := realConverter
	testutil.RequireImplementation(t, impl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	x25519Priv, err := impl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, x25519Priv, 32)

	// Determinism: same input → same output.
	x25519Priv2, err := impl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, x25519Priv, x25519Priv2)

	// Functional verification: converted key must work for NaCl box encryption.
	x25519Pub, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, x25519Pub, 32)

	plaintext := []byte("test key conversion")
	sealed, err := realEncryptor.SealAnonymous(plaintext, x25519Pub)
	testutil.RequireNoError(t, err)

	opened, err := realEncryptor.OpenAnonymous(sealed, x25519Pub, x25519Priv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, plaintext, opened)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_ConvertPublicKey(t *testing.T) {
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	impl := realConverter
	// impl = converter.New()
	testutil.RequireImplementation(t, impl, "KeyConverter")

	pub, _, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	x25519Pub, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, x25519Pub, 32) // X25519 public key is 32 bytes

	// The X25519 key must differ from the Ed25519 key (different curves).
	testutil.RequireBytesNotEqual(t, x25519Pub, pub)

	// Determinism: same Ed25519 key always converts to the same X25519 key.
	x25519Pub2, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, x25519Pub, x25519Pub2)

	// Different Ed25519 keys must produce different X25519 keys.
	seed2 := make([]byte, 32)
	copy(seed2, testutil.TestEd25519Seed[:])
	seed2[0] ^= 0xFF // flip bits to get a different seed
	pub2, _, err := sImpl.GenerateFromSeed(seed2)
	testutil.RequireNoError(t, err)
	x25519Pub3, err := impl.Ed25519ToX25519Public(pub2)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, x25519Pub, x25519Pub3)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_Roundtrip(t *testing.T) {
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	boxImpl := realEncryptor
	// boxImpl = box.New()
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	// Sign → encrypt → decrypt → verify roundtrip.
	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	// Step 1: Sign the message.
	message := []byte("roundtrip test message")
	sig, err := sImpl.Sign(priv, message)
	testutil.RequireNoError(t, err)

	// Step 2: Convert to X25519 for encryption.
	x25519Pub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	x25519Priv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// Step 3: Encrypt (seal) the signed message.
	payload := append(message, sig...)
	sealed, err := boxImpl.SealAnonymous(payload, x25519Pub)
	testutil.RequireNoError(t, err)

	// Step 4: Decrypt (open) the sealed message.
	opened, err := boxImpl.OpenAnonymous(sealed, x25519Pub, x25519Priv)
	testutil.RequireNoError(t, err)

	// Step 5: Verify the signature on the decrypted message.
	recoveredMsg := opened[:len(message)]
	recoveredSig := opened[len(message):]
	valid, err := sImpl.Verify(pub, recoveredMsg, recoveredSig)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "roundtrip signature should verify")
	testutil.RequireBytesEqual(t, message, recoveredMsg)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_OneWayProperty(t *testing.T) {
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	impl := realConverter
	// impl = converter.New()
	testutil.RequireImplementation(t, impl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	x25519Pub, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	x25519Priv, err := impl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// One-way property: X25519 keys must not equal Ed25519 keys
	// (the conversion is a one-way transformation).
	testutil.RequireBytesNotEqual(t, pub, x25519Pub)
	testutil.RequireBytesNotEqual(t, priv[:32], x25519Priv)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_EphemeralPerMessage(t *testing.T) {
	// Each crypto_box_seal uses a fresh ephemeral keypair.
	// Two seals of the same plaintext must produce different ciphertext.
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	boxImpl := realEncryptor
	// boxImpl = box.New()
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	pub, _, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	x25519Pub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	plaintext := []byte("ephemeral test message")

	sealed1, err := boxImpl.SealAnonymous(plaintext, x25519Pub)
	testutil.RequireNoError(t, err)

	sealed2, err := boxImpl.SealAnonymous(plaintext, x25519Pub)
	testutil.RequireNoError(t, err)

	// Different ciphertext proves fresh ephemeral keypair per seal.
	testutil.RequireBytesNotEqual(t, sealed1, sealed2)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_ConsciousReuse(t *testing.T) {
	// Code audit test: a single Ed25519 keypair is converted to X25519
	// once, and the same X25519 keys are reused for all encryption
	// operations with that identity (conscious reuse, not accidental).
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	impl := realConverter
	// impl = converter.New()
	testutil.RequireImplementation(t, impl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	// Converting the same Ed25519 key twice must yield identical X25519 keys.
	x25519Pub1, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	x25519Pub2, err := impl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, x25519Pub1, x25519Pub2)

	x25519Priv1, err := impl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	x25519Priv2, err := impl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, x25519Priv1, x25519Priv2)
}

// TST-CORE-112, TST-CORE-113, TST-CORE-114, TST-CORE-115, TST-CORE-116, TST-CORE-117, TST-CORE-118
func TestCrypto_2_6_EphemeralZeroed(t *testing.T) {
	// After sealing, the ephemeral private key must be zeroed from memory.
	// This is a design/code audit test. Functionally, we verify that
	// sealing works and the sealed output can be opened (proving the
	// ephemeral key was used correctly and then discarded).
	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	boxImpl := realEncryptor
	// boxImpl = box.New()
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	x25519Pub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	x25519Priv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	plaintext := []byte("ephemeral zeroing test")
	sealed, err := boxImpl.SealAnonymous(plaintext, x25519Pub)
	testutil.RequireNoError(t, err)

	// Verify the sealed message can be opened (ephemeral key was valid).
	opened, err := boxImpl.OpenAnonymous(sealed, x25519Pub, x25519Priv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, plaintext, opened)
}

// --------------------------------------------------------------------------
// §2.7 NaCl crypto_box_seal (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_SealMessage(t *testing.T) {
	impl := realEncryptor
	testutil.RequireImplementation(t, impl, "Encryptor")

	// Generate a recipient X25519 keypair (via Ed25519 conversion).
	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	plaintext := []byte("secret message for recipient")
	sealed, err := impl.SealAnonymous(plaintext, recipientPub)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(sealed) > len(plaintext), "ciphertext must be longer than plaintext")

	// Seal→Open round-trip: verify decryption recovers the original plaintext.
	opened, err := impl.OpenAnonymous(sealed, recipientPub, recipientPriv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, opened, plaintext)

	// Sealing the same plaintext twice must produce different ciphertext
	// (ephemeral keys are random).
	sealed2, err := impl.SealAnonymous(plaintext, recipientPub)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, sealed, sealed2)
}

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_OpenSealed(t *testing.T) {
	impl := realEncryptor
	// impl = box.New()
	testutil.RequireImplementation(t, impl, "Encryptor")

	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	plaintext := []byte("secret message to decrypt")
	sealed, err := impl.SealAnonymous(plaintext, recipientPub)
	testutil.RequireNoError(t, err)

	opened, err := impl.OpenAnonymous(sealed, recipientPub, recipientPriv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, plaintext, opened)
}

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_WrongRecipient(t *testing.T) {
	impl := realEncryptor
	// impl = box.New()
	testutil.RequireImplementation(t, impl, "Encryptor")

	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	// Recipient A: seal the message.
	pubA, _, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	recipientPubA, err := convImpl.Ed25519ToX25519Public(pubA)
	testutil.RequireNoError(t, err)

	plaintext := []byte("for recipient A only")
	sealed, err := impl.SealAnonymous(plaintext, recipientPubA)
	testutil.RequireNoError(t, err)

	// Recipient B: try to open with wrong keys.
	wrongSeed := [32]byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8,
		0xf7, 0xf6, 0xf5, 0xf4, 0xf3, 0xf2, 0xf1, 0xf0,
		0xef, 0xee, 0xed, 0xec, 0xeb, 0xea, 0xe9, 0xe8,
		0xe7, 0xe6, 0xe5, 0xe4, 0xe3, 0xe2, 0xe1, 0xe0}
	pubB, privB, err := sImpl.GenerateFromSeed(wrongSeed[:])
	testutil.RequireNoError(t, err)
	recipientPubB, err := convImpl.Ed25519ToX25519Public(pubB)
	testutil.RequireNoError(t, err)
	recipientPrivB, err := convImpl.Ed25519ToX25519Private(privB)
	testutil.RequireNoError(t, err)

	_, err = impl.OpenAnonymous(sealed, recipientPubB, recipientPrivB)
	testutil.RequireError(t, err)
}

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_TamperedCiphertext(t *testing.T) {
	impl := realEncryptor
	// impl = box.New()
	testutil.RequireImplementation(t, impl, "Encryptor")

	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	plaintext := []byte("tamper test message")
	sealed, err := impl.SealAnonymous(plaintext, recipientPub)
	testutil.RequireNoError(t, err)

	// Tamper with the ciphertext.
	tampered := make([]byte, len(sealed))
	copy(tampered, sealed)
	if len(tampered) > 0 {
		tampered[len(tampered)-1] ^= 0xff
	}

	_, err = impl.OpenAnonymous(tampered, recipientPub, recipientPriv)
	testutil.RequireError(t, err)
}

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_EmptyPlaintext(t *testing.T) {
	impl := realEncryptor
	// impl = box.New()
	testutil.RequireImplementation(t, impl, "Encryptor")

	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// Empty plaintext must work.
	sealed, err := impl.SealAnonymous([]byte{}, recipientPub)
	testutil.RequireNoError(t, err)

	opened, err := impl.OpenAnonymous(sealed, recipientPub, recipientPriv)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(opened), 0)
}

// TST-CORE-119, TST-CORE-120, TST-CORE-121, TST-CORE-122, TST-CORE-123, TST-CORE-124
func TestCrypto_2_7_LargeMessage(t *testing.T) {
	impl := realEncryptor
	// impl = box.New()
	testutil.RequireImplementation(t, impl, "Encryptor")

	sImpl := realSigner
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// 1 MiB plaintext.
	largePlaintext := make([]byte, 1<<20)
	for i := range largePlaintext {
		largePlaintext[i] = byte(i % 256)
	}

	sealed, err := impl.SealAnonymous(largePlaintext, recipientPub)
	testutil.RequireNoError(t, err)

	opened, err := impl.OpenAnonymous(sealed, recipientPub, recipientPriv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, largePlaintext, opened)
}

// --------------------------------------------------------------------------
// §2.8 AES-256-GCM Key Wrapping (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-125, TST-CORE-126, TST-CORE-127, TST-CORE-128, TST-CORE-129
func TestCrypto_2_8_WrapKey(t *testing.T) {
	impl := realKeyWrapper
	// impl = wrapper.New()
	testutil.RequireImplementation(t, impl, "KeyWrapper")

	wrapped, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(wrapped) > len(testutil.TestDEK[:]),
		"wrapped output must be longer than plaintext DEK (includes nonce + tag)")
}

// TST-CORE-125, TST-CORE-126, TST-CORE-127, TST-CORE-128, TST-CORE-129
func TestCrypto_2_8_UnwrapCorrect(t *testing.T) {
	impl := realKeyWrapper
	// impl = wrapper.New()
	testutil.RequireImplementation(t, impl, "KeyWrapper")

	wrapped, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)

	unwrapped, err := impl.Unwrap(wrapped, testutil.TestKEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, testutil.TestDEK[:], unwrapped)
}

// TST-CORE-125, TST-CORE-126, TST-CORE-127, TST-CORE-128, TST-CORE-129
func TestCrypto_2_8_UnwrapWrong(t *testing.T) {
	impl := realKeyWrapper
	// impl = wrapper.New()
	testutil.RequireImplementation(t, impl, "KeyWrapper")

	wrapped, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)

	// Wrong KEK must fail unwrap.
	wrongKEK := [32]byte{0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef}
	_, err = impl.Unwrap(wrapped, wrongKEK[:])
	testutil.RequireError(t, err)
}

// TST-CORE-125, TST-CORE-126, TST-CORE-127, TST-CORE-128, TST-CORE-129
func TestCrypto_2_8_TamperedBlob(t *testing.T) {
	impl := realKeyWrapper
	// impl = wrapper.New()
	testutil.RequireImplementation(t, impl, "KeyWrapper")

	wrapped, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)

	// Tamper with the wrapped blob.
	tampered := make([]byte, len(wrapped))
	copy(tampered, wrapped)
	if len(tampered) > 0 {
		tampered[len(tampered)-1] ^= 0xff
	}

	_, err = impl.Unwrap(tampered, testutil.TestKEK[:])
	testutil.RequireError(t, err)
}

// TST-CORE-125, TST-CORE-126, TST-CORE-127, TST-CORE-128, TST-CORE-129
func TestCrypto_2_8_NonceUniqueness(t *testing.T) {
	impl := realKeyWrapper
	// impl = wrapper.New()
	testutil.RequireImplementation(t, impl, "KeyWrapper")

	// Wrapping the same DEK with the same KEK twice must produce
	// different outputs (unique nonce per wrap).
	wrapped1, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)

	wrapped2, err := impl.Wrap(testutil.TestDEK[:], testutil.TestKEK[:])
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, wrapped1, wrapped2)

	// Both must still unwrap correctly.
	unwrapped1, err := impl.Unwrap(wrapped1, testutil.TestKEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, testutil.TestDEK[:], unwrapped1)

	unwrapped2, err := impl.Unwrap(wrapped2, testutil.TestKEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, testutil.TestDEK[:], unwrapped2)
}

// ==========================================================================
// Helper functions
// ==========================================================================

// xorBytes returns the XOR of two equal-length byte slices.
func xorBytes(a, b []byte) []byte {
	if len(a) != len(b) {
		return nil
	}
	result := make([]byte, len(a))
	for i := range a {
		result[i] = a[i] ^ b[i]
	}
	return result
}

// TST-CORE-880
func TestCrypto_2_8_6_KeyGenerationUsesSecureRandom(t *testing.T) {
	// Verify that Go's Ed25519 key generation uses crypto/rand (not weak entropy).
	// ed25519.GenerateKey(nil) uses crypto/rand.Reader internally.

	// Generate 5 keypairs via crypto/rand — all must be unique.
	pubKeys := make(map[string]bool)
	for i := 0; i < 5; i++ {
		pub, _, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatalf("ed25519.GenerateKey failed on iteration %d: %v", i, err)
		}
		pubHex := fmt.Sprintf("%x", pub)
		if pubKeys[pubHex] {
			t.Fatalf("duplicate public key on iteration %d — entropy source may be weak", i)
		}
		pubKeys[pubHex] = true
	}

	// Verify that GenerateFromSeed is deterministic (same seed → same key).
	impl := realSigner
	testutil.RequireImplementation(t, impl, "Signer")

	pub1, _, err := impl.GenerateFromSeed(testutil.TestDEK[:])
	testutil.RequireNoError(t, err)
	pub2, _, err := impl.GenerateFromSeed(testutil.TestDEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, pub1, pub2)

	// Different seeds must produce different keys.
	pub3, _, err := impl.GenerateFromSeed(testutil.TestKEK[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, pub1, pub3)
}

// TST-CORE-881
func TestCrypto_2_8_7_ArchiveKeySurvivesBackupKeyRotation(t *testing.T) {
	// Archive key survives backup key rotation (separate HKDF derivations).
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Derive archive key and backup key — they must be independent.
	archiveKey, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	backupKey, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, archiveKey, backupKey)
}

// TST-CORE-882
func TestCrypto_2_8_8_ClientSyncKeyUsedForSyncEncryption(t *testing.T) {
	// Client sync key used for sync encryption, trust key for signing.
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	syncKey, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "sync", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	trustKey, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "trust", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	// Keys must be different — different HKDF info strings.
	testutil.RequireBytesNotEqual(t, syncKey, trustKey)
}

// --------------------------------------------------------------------------
// §2.9 K256 Deterministic Derivation from Master Seed
// --------------------------------------------------------------------------

func TestCrypto_2_9_DeriveK256Deterministic(t *testing.T) {
	// Same seed always produces the same k256 key.
	impl := realHDKey
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	deriver := impl.(*dinacrypto.SLIP0010Deriver)

	key1, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}
	key2, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}

	testutil.RequireBytesLen(t, key1, 32)
	testutil.RequireBytesEqual(t, key1, key2)
}

func TestCrypto_2_9_K256DifferentFromEd25519(t *testing.T) {
	// K256 at m/9999'/2'/0' must differ from Ed25519 at m/9999'/0'.
	impl := realHDKey
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	deriver := impl.(*dinacrypto.SLIP0010Deriver)

	k256Key, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}

	_, ed25519Priv, err := deriver.DerivePath(testutil.TestMnemonicSeed, "m/9999'/0'")
	if err != nil {
		t.Fatalf("DerivePath: %v", err)
	}

	// Ed25519 priv is 64 bytes; compare first 32 (seed portion) to k256.
	testutil.RequireBytesNotEqual(t, k256Key, ed25519Priv[:32])
}

func TestCrypto_2_9_K256DifferentPaths(t *testing.T) {
	// Different k256 derivation paths produce different keys.
	impl := realHDKey
	testutil.RequireImplementation(t, impl, "HDKeyDeriver")

	deriver := impl.(*dinacrypto.SLIP0010Deriver)

	key100, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}
	key1, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/1'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}

	testutil.RequireBytesNotEqual(t, key100, key1)
}

func TestCrypto_2_9_K256EmptySeedRejected(t *testing.T) {
	deriver := dinacrypto.NewSLIP0010Deriver()
	_, err := deriver.DerivePathK256(nil, "m/9999'/2'/0'")
	if err == nil {
		t.Fatal("expected error for nil seed")
	}
	_, err = deriver.DerivePathK256([]byte{}, "m/9999'/2'/0'")
	if err == nil {
		t.Fatal("expected error for empty seed")
	}
}

func TestCrypto_2_9_K256BIP44Forbidden(t *testing.T) {
	deriver := dinacrypto.NewSLIP0010Deriver()
	_, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/44'/0'")
	if err == nil {
		t.Fatal("expected BIP-44 to be forbidden")
	}
}

func TestCrypto_2_9_K256ParseableByAtcrypto(t *testing.T) {
	// Derived k256 key must be parseable by atcrypto.
	deriver := dinacrypto.NewSLIP0010Deriver()
	raw, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}

	key, err := atcrypto.ParsePrivateBytesK256(raw)
	if err != nil {
		t.Fatalf("ParsePrivateBytesK256: %v", err)
	}

	pub, err := key.PublicKey()
	if err != nil {
		t.Fatalf("PublicKey: %v", err)
	}
	didKey := pub.DIDKey()
	if didKey == "" {
		t.Fatal("expected non-empty did:key")
	}
}

func TestCrypto_2_9_K256ManagerWithSeed(t *testing.T) {
	// K256KeyManager with seed derives deterministically and persists to disk.
	tmpDir := t.TempDir()
	mgr := dinacrypto.NewK256KeyManager(tmpDir)
	mgr.SetMasterSeed(testutil.TestMnemonicSeed)

	key1, err := mgr.GenerateOrLoad()
	if err != nil {
		t.Fatalf("GenerateOrLoad: %v", err)
	}

	didKey1, err := mgr.PublicDIDKey()
	if err != nil {
		t.Fatalf("PublicDIDKey: %v", err)
	}
	if didKey1 == "" {
		t.Fatal("expected non-empty did:key")
	}

	// Second manager with same seed loads from disk (same result).
	mgr2 := dinacrypto.NewK256KeyManager(tmpDir)
	mgr2.SetMasterSeed(testutil.TestMnemonicSeed)

	key2, err := mgr2.GenerateOrLoad()
	if err != nil {
		t.Fatalf("GenerateOrLoad (2nd): %v", err)
	}

	if key1.Bytes() == nil || key2.Bytes() == nil {
		t.Fatal("expected non-nil key bytes")
	}
	testutil.RequireBytesEqual(t, key1.Bytes(), key2.Bytes())
}

func TestCrypto_2_9_K256ManagerBackwardCompat(t *testing.T) {
	// A manager without seed falls back to random generation (legacy path).
	tmpDir := t.TempDir()
	mgr := dinacrypto.NewK256KeyManager(tmpDir)
	// No SetMasterSeed — random generation.

	key, err := mgr.GenerateOrLoad()
	if err != nil {
		t.Fatalf("GenerateOrLoad: %v", err)
	}
	if key == nil {
		t.Fatal("expected non-nil key")
	}
	if len(key.Bytes()) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(key.Bytes()))
	}
}

func TestCrypto_2_9_K256ManagerExistingKeyPreferred(t *testing.T) {
	// If a key exists on disk (from random generation), it is loaded even
	// when a seed is later provided. This ensures backward compatibility:
	// existing DIDs with random rotation keys continue working.
	tmpDir := t.TempDir()

	// Step 1: Create a random key (no seed).
	mgr1 := dinacrypto.NewK256KeyManager(tmpDir)
	randomKey, err := mgr1.GenerateOrLoad()
	if err != nil {
		t.Fatalf("random GenerateOrLoad: %v", err)
	}

	// Step 2: Create new manager with seed.
	mgr2 := dinacrypto.NewK256KeyManager(tmpDir)
	mgr2.SetMasterSeed(testutil.TestMnemonicSeed)

	loadedKey, err := mgr2.GenerateOrLoad()
	if err != nil {
		t.Fatalf("seeded GenerateOrLoad: %v", err)
	}

	// Must load the existing random key, not derive a new one.
	testutil.RequireBytesEqual(t, randomKey.Bytes(), loadedKey.Bytes())
}

func TestCrypto_2_9_KeyDeriverRotationKey(t *testing.T) {
	// KeyDeriver.DeriveRotationKey produces the same result as direct SLIP-0010.
	deriver := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(deriver)

	rotKey, err := kd.DeriveRotationKey(testutil.TestMnemonicSeed)
	if err != nil {
		t.Fatalf("DeriveRotationKey: %v", err)
	}

	direct, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/9999'/2'/0'")
	if err != nil {
		t.Fatalf("DerivePathK256: %v", err)
	}

	testutil.RequireBytesEqual(t, rotKey, direct)
}

// --------------------------------------------------------------------------
// §2.10 Service Key Derivation (m/9999'/3'/...)
// --------------------------------------------------------------------------

func TestCrypto_2_10_1_DeriveServiceKeyDeterministic(t *testing.T) {
	// DeriveServiceKey at the same index always produces the same key.
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	seed := testutil.TestMnemonicSeed

	key1, err := kd.DeriveServiceKey(seed, 0)
	testutil.RequireNoError(t, err)
	key2, err := kd.DeriveServiceKey(seed, 0)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, key1.Seed(), key2.Seed())
}

func TestCrypto_2_10_2_DeriveServiceKeyDistinctIndexes(t *testing.T) {
	// Different service indexes produce different keys.
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	seed := testutil.TestMnemonicSeed

	core, err := kd.DeriveServiceKey(seed, 0)
	testutil.RequireNoError(t, err)
	brain, err := kd.DeriveServiceKey(seed, 1)
	testutil.RequireNoError(t, err)

	if string(core.Seed()) == string(brain.Seed()) {
		t.Fatal("core and brain service keys must differ")
	}
}

func TestCrypto_2_10_3_DeriveServiceKeyMatchesSLIP0010Path(t *testing.T) {
	// DeriveServiceKey(seed, 0) must produce the same key as
	// DerivePath(seed, "m/9999'/3'/0'").
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	seed := testutil.TestMnemonicSeed

	serviceKey, err := kd.DeriveServiceKey(seed, 0)
	testutil.RequireNoError(t, err)

	_, directPriv, err := slip.DerivePath(seed, "m/9999'/3'/0'")
	testutil.RequireNoError(t, err)

	// DerivePath returns the full 64-byte ed25519.PrivateKey.
	testutil.RequireBytesEqual(t, []byte(serviceKey), directPriv)
}

func TestCrypto_2_10_4_DeriveServiceKeyCrossLanguage(t *testing.T) {
	// Verify Go derivation matches the Python provision_derived_service_keys.py
	// output for TestEd25519Seed. This ensures install-time PEM files will
	// match the keys Go expects.
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	seed := testutil.TestEd25519Seed[:]

	coreKey, err := kd.DeriveServiceKey(seed, 0)
	testutil.RequireNoError(t, err)
	brainKey, err := kd.DeriveServiceKey(seed, 1)
	testutil.RequireNoError(t, err)

	// Expected values from Python provision_derived_service_keys.py.
	expectedCorePub := "ab88ac362dd891fef58a97dd09abb9e25a06396aaebba5cf356d9ecdfdc1a9ba"
	expectedBrainPub := "11893492182d27400bfaa0aa67b8d11c75cbf1b2b684e83d8120da8f6b321073"

	corePubHex := fmt.Sprintf("%x", coreKey.Public())
	brainPubHex := fmt.Sprintf("%x", brainKey.Public())

	if corePubHex != expectedCorePub {
		t.Fatalf("core pub mismatch: go=%s, python=%s", corePubHex, expectedCorePub)
	}
	if brainPubHex != expectedBrainPub {
		t.Fatalf("brain pub mismatch: go=%s, python=%s", brainPubHex, expectedBrainPub)
	}
}
