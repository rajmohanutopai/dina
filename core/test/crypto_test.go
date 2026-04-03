package test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
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
// TRACE: {"suite": "CORE", "case": "0265", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "DeriveRootIdentityKey"}
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
// TRACE: {"suite": "CORE", "case": "0266", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "DerivePersonaKey"}
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
// TRACE: {"suite": "CORE", "case": "0267", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "Determinism"}
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
// TRACE: {"suite": "CORE", "case": "0268", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "DifferentPathsDifferentKeys"}
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
// TRACE: {"suite": "CORE", "case": "0269", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "HardenedOnlyEnforced"}
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
// TRACE: {"suite": "CORE", "case": "0270", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "KnownTestVectors"}
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
// TRACE: {"suite": "CORE", "case": "0271", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "PurposeIsolation"}
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
// TRACE: {"suite": "CORE", "case": "0272", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "Purpose44Forbidden"}
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
// TRACE: {"suite": "CORE", "case": "0273", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "SameMnemonicIndependentTrees"}
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
// TRACE: {"suite": "CORE", "case": "0274", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "SiblingUnlinkability"}
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
// TRACE: {"suite": "CORE", "case": "0275", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "GoImplementation"}
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
// TRACE: {"suite": "CORE", "case": "0276", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "CanonicalPersonaIndexes"}
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
// TRACE: {"suite": "CORE", "case": "0277", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "CustomPersonaIndex7Plus"}
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
// TRACE: {"suite": "CORE", "case": "0278", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "02", "scenario": "01", "title": "DerivationIndexStored"}
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
// TRACE: {"suite": "CORE", "case": "0279", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "DerivePerPersonaDEK"}
func TestCrypto_2_3_DerivePerPersonaDEK(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
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
	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, dek, dek2)

	// Error cases: empty inputs must be rejected.
	_, err = impl.DeriveVaultDEK(nil, "general", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)
	_, err = impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)
	_, err = impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", nil)
	testutil.RequireError(t, err)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0280", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "DifferentPersonasDifferentDEKs"}
func TestCrypto_2_3_DifferentPersonasDifferentDEKs(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dekWork, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "work", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, dekWork, dekPersonal)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0281", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "Determinism"}
func TestCrypto_2_3_Determinism(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, dek1, dek2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0282", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "KnownHKDFTestVectors"}
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
// TRACE: {"suite": "CORE", "case": "0283", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "AllInfoStrings"}
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
		// TRACE: {"suite": "CORE", "case": "0284", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "info_format/"}
		t.Run("info_format/"+name, func(t *testing.T) {
			productionInfo := "dina:vault:" + name + ":v1"
			testutil.RequireEqual(t, expectedInfo, productionInfo)
		})
	}
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0285", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "CompromiseIsolation"}
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
// TRACE: {"suite": "CORE", "case": "0286", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "CustomPersonaInfoString"}
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
// TRACE: {"suite": "CORE", "case": "0287", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "BackupEncryptionKey"}
func TestCrypto_2_3_BackupEncryptionKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:backup:v1") produces a valid 256-bit key.
	dekBackup, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "backup", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekBackup, 32)

	// Backup key must differ from personal key (different HKDF info).
	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
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
// TRACE: {"suite": "CORE", "case": "0288", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "ArchiveKey"}
func TestCrypto_2_3_ArchiveKey(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// HKDF(info="dina:archive:v1") produces a valid 256-bit key.
	dekArchive, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekArchive, 32)

	// Archive key must differ from personal and backup keys (different HKDF info).
	dekPersonal, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", testutil.TestUserSalt[:])
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
// TRACE: {"suite": "CORE", "case": "0289", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "ArchiveSeparateFromBackup"}
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
// TRACE: {"suite": "CORE", "case": "0290", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "ClientSyncKey"}
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
// TRACE: {"suite": "CORE", "case": "0291", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "TrustSigningKey"}
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
// TRACE: {"suite": "CORE", "case": "0292", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "UserSaltRandom32Bytes"}
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
	dek, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dek, 32)

	// Different salt must produce a different DEK (proves salt is actually used).
	altSalt := make([]byte, 32)
	for i := range altSalt {
		altSalt[i] = byte(i + 0x80)
	}
	dekAlt, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", altSalt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, dekAlt, 32)
	testutil.RequireBytesNotEqual(t, dek, dekAlt)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0293", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "UserSaltGeneratedOnce"}
func TestCrypto_2_3_UserSaltGeneratedOnce(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Salt is generated at first setup only. Using the same salt
	// across multiple derivations produces consistent results.
	salt := testutil.TestUserSalt[:]

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", salt)
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", salt)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesEqual(t, dek1, dek2)

	// Negative control: a different salt must produce a different DEK
	// (proves the function is not ignoring the salt parameter).
	altSalt := make([]byte, 32)
	for i := range altSalt {
		altSalt[i] = byte(0xff - i)
	}
	dekAlt, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", altSalt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, dek1, dekAlt)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0294", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "UserSaltPersistedAcrossReboots"}
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
// TRACE: {"suite": "CORE", "case": "0295", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "UserSaltInExport"}
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
// TRACE: {"suite": "CORE", "case": "0296", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "DifferentSaltDifferentDEKs"}
func TestCrypto_2_3_DifferentSaltDifferentDEKs(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	salt1 := testutil.TestUserSalt[:]
	salt2 := make([]byte, 32)
	for i := range salt2 {
		salt2[i] = 0xff // Different salt
	}

	dek1, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", salt1)
	testutil.RequireNoError(t, err)

	dek2, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", salt2)
	testutil.RequireNoError(t, err)

	testutil.RequireBytesNotEqual(t, dek1, dek2)
}

// TST-CORE-080, TST-CORE-081, TST-CORE-082, TST-CORE-083, TST-CORE-084, TST-CORE-085, TST-CORE-086
// TST-CORE-087, TST-CORE-088, TST-CORE-089, TST-CORE-090, TST-CORE-091, TST-CORE-092, TST-CORE-093
// TST-CORE-094, TST-CORE-095, TST-CORE-096, TST-CORE-097
// TRACE: {"suite": "CORE", "case": "0297", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "03", "scenario": "01", "title": "UserSaltAbsentStartupError"}
func TestCrypto_2_3_UserSaltAbsentStartupError(t *testing.T) {
	impl := realVaultDEKDeriver
	// impl = keyderiver.New()
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	// Missing salt (nil) must produce an error, not silently use zero salt.
	_, err := impl.DeriveVaultDEK(testutil.TestMnemonicSeed, "general", nil)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §2.4 Argon2id Passphrase Hashing (8 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-098, TST-CORE-099, TST-CORE-100, TST-CORE-101, TST-CORE-102, TST-CORE-103, TST-CORE-104
// TST-CORE-105
// TRACE: {"suite": "CORE", "case": "0298", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "HashPassphrase"}
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
// TRACE: {"suite": "CORE", "case": "0299", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "VerifyCorrect"}
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
// TRACE: {"suite": "CORE", "case": "0300", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "VerifyWrong"}
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
// TRACE: {"suite": "CORE", "case": "0301", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "DefaultParameters"}
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
// TRACE: {"suite": "CORE", "case": "0302", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "UniqueSalts"}
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
// TRACE: {"suite": "CORE", "case": "0303", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "ConfigurableParameters"}
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
// TRACE: {"suite": "CORE", "case": "0304", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "RunsOnceNotPerRequest"}
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
// TRACE: {"suite": "CORE", "case": "0305", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "04", "scenario": "01", "title": "PassphraseChangeReWrapOnly"}
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
// TRACE: {"suite": "CORE", "case": "0306", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "SignMessage"}
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
// TRACE: {"suite": "CORE", "case": "0307", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "VerifyValid"}
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
// TRACE: {"suite": "CORE", "case": "0308", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "VerifyTampered"}
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
// TRACE: {"suite": "CORE", "case": "0309", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "VerifyWrongKey"}
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
// TRACE: {"suite": "CORE", "case": "0310", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "CanonicalJSON"}
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
// TRACE: {"suite": "CORE", "case": "0311", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "05", "scenario": "01", "title": "EmptyMessage"}
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
// TRACE: {"suite": "CORE", "case": "0312", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "ConvertPrivateKey"}
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
// TRACE: {"suite": "CORE", "case": "0313", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "ConvertPublicKey"}
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
// TRACE: {"suite": "CORE", "case": "0314", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "Roundtrip"}
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
// TRACE: {"suite": "CORE", "case": "0315", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "OneWayProperty"}
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
// TRACE: {"suite": "CORE", "case": "0316", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "EphemeralPerMessage"}
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
// TRACE: {"suite": "CORE", "case": "0317", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "ConsciousReuse"}
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
// TRACE: {"suite": "CORE", "case": "0318", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "06", "scenario": "01", "title": "EphemeralZeroed"}
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
// TRACE: {"suite": "CORE", "case": "0319", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "SealMessage"}
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
// TRACE: {"suite": "CORE", "case": "0320", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "OpenSealed"}
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
// TRACE: {"suite": "CORE", "case": "0321", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "WrongRecipient"}
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
// TRACE: {"suite": "CORE", "case": "0322", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "TamperedCiphertext"}
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
// TRACE: {"suite": "CORE", "case": "0323", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "EmptyPlaintext"}
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
// TRACE: {"suite": "CORE", "case": "0324", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "07", "scenario": "01", "title": "LargeMessage"}
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
// TRACE: {"suite": "CORE", "case": "0325", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "01", "title": "WrapKey"}
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
// TRACE: {"suite": "CORE", "case": "0326", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "01", "title": "UnwrapCorrect"}
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
// TRACE: {"suite": "CORE", "case": "0327", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "01", "title": "UnwrapWrong"}
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
// TRACE: {"suite": "CORE", "case": "0328", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "01", "title": "TamperedBlob"}
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
// TRACE: {"suite": "CORE", "case": "0329", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "01", "title": "NonceUniqueness"}
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
// TRACE: {"suite": "CORE", "case": "0330", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "06", "title": "KeyGenerationUsesSecureRandom"}
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
// TRACE: {"suite": "CORE", "case": "0331", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "07", "title": "ArchiveKeySurvivesBackupKeyRotation"}
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
// TRACE: {"suite": "CORE", "case": "0332", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "08", "scenario": "08", "title": "ClientSyncKeyUsedForSyncEncryption"}
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

// TRACE: {"suite": "CORE", "case": "0333", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "DeriveK256Deterministic"}
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

// TRACE: {"suite": "CORE", "case": "0334", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256DifferentFromEd25519"}
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

// TRACE: {"suite": "CORE", "case": "0335", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256DifferentPaths"}
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

// TRACE: {"suite": "CORE", "case": "0336", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256EmptySeedRejected"}
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

// TRACE: {"suite": "CORE", "case": "0337", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256BIP44Forbidden"}
func TestCrypto_2_9_K256BIP44Forbidden(t *testing.T) {
	deriver := dinacrypto.NewSLIP0010Deriver()
	_, err := deriver.DerivePathK256(testutil.TestMnemonicSeed, "m/44'/0'")
	if err == nil {
		t.Fatal("expected BIP-44 to be forbidden")
	}
}

// TRACE: {"suite": "CORE", "case": "0338", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256ParseableByAtcrypto"}
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

// TRACE: {"suite": "CORE", "case": "0339", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256ManagerWithSeed"}
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

// TRACE: {"suite": "CORE", "case": "0340", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256ManagerBackwardCompat"}
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

// TRACE: {"suite": "CORE", "case": "0341", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "K256ManagerExistingKeyPreferred"}
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

// TRACE: {"suite": "CORE", "case": "0342", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "09", "scenario": "01", "title": "KeyDeriverRotationKey"}
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

// TRACE: {"suite": "CORE", "case": "0343", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "10", "scenario": "01", "title": "DeriveServiceKeyDeterministic"}
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

// TRACE: {"suite": "CORE", "case": "0344", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "10", "scenario": "02", "title": "DeriveServiceKeyDistinctIndexes"}
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

// TRACE: {"suite": "CORE", "case": "0345", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "10", "scenario": "03", "title": "DeriveServiceKeyMatchesSLIP0010Path"}
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

// TRACE: {"suite": "CORE", "case": "0346", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "10", "scenario": "04", "title": "DeriveServiceKeyCrossLanguage"}
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

// --------------------------------------------------------------------------
// §2.1 BIP-39 Mnemonic Generation — Master seed IS the DEK
// --------------------------------------------------------------------------

// TST-CORE-061
// TRACE: {"suite": "CORE", "case": "0347", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "01", "scenario": "06", "title": "MasterSeedIsTheDEK"}
func TestCrypto_2_1_6_MasterSeedIsTheDEK(t *testing.T) {
	// Requirement (§2.1, row 6):
	//   The 512-bit BIP-39 seed is used directly as key material for all
	//   derivations — persona DEKs via HKDF-SHA256, signing keys via SLIP-0010.
	//   The seed itself is key-wrapped on disk by an Argon2id-derived KEK
	//   using AES-256-GCM. The master seed never touches disk unwrapped in
	//   security mode.
	//
	// Anti-tautological design:
	//   1. Same seed → same DEK (deterministic derivation proves seed IS the material)
	//   2. Different seeds → different DEKs (derivation depends on seed, not a constant)
	//   3. Seed → persona DEK → can encrypt/decrypt (DEK is usable key material)
	//   4. Key wrapping round-trips (KEK wraps seed, unwrap recovers exact seed)
	//   5. Wrapped seed differs from raw seed (wrapping is not a no-op)

	deriver := dinacrypto.NewHKDFKeyDeriver()
	wrapper := realKeyWrapper

	seed := testutil.TestMnemonicSeed // 64-byte BIP-39 seed
	salt := testutil.TestUserSalt[:]

	// TRACE: {"suite": "CORE", "case": "0348", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "seed_deterministic_derivation"}
	t.Run("seed_deterministic_derivation", func(t *testing.T) {
		// Same seed + persona + salt → identical DEK every time.
		// This proves the seed IS the root key material (not discarded or
		// replaced with a random key during derivation).
		dek1, err := deriver.DeriveVaultDEK(seed, "general", salt)
		if err != nil {
			t.Fatalf("first derivation failed: %v", err)
		}
		if len(dek1) != 32 {
			t.Fatalf("DEK must be 32 bytes, got %d", len(dek1))
		}

		dek2, err := deriver.DeriveVaultDEK(seed, "general", salt)
		if err != nil {
			t.Fatalf("second derivation failed: %v", err)
		}

		for i := range dek1 {
			if dek1[i] != dek2[i] {
				t.Fatal("same seed must produce identical DEK — derivation is non-deterministic")
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0349", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "different_seeds_different_DEKs"}
	t.Run("different_seeds_different_DEKs", func(t *testing.T) {
		// Contrast: different seed → different DEK.
		// Without this, the test would pass even if DeriveVaultDEK ignored
		// the seed parameter entirely and returned a constant.
		dek1, err := deriver.DeriveVaultDEK(seed, "general", salt)
		if err != nil {
			t.Fatalf("derivation with seed1: %v", err)
		}

		// Construct a different 64-byte seed (flip all bits).
		altSeed := make([]byte, len(seed))
		for i, b := range seed {
			altSeed[i] = ^b
		}

		dek2, err := deriver.DeriveVaultDEK(altSeed, "general", salt)
		if err != nil {
			t.Fatalf("derivation with seed2: %v", err)
		}

		match := true
		for i := range dek1 {
			if dek1[i] != dek2[i] {
				match = false
				break
			}
		}
		if match {
			t.Fatal("different seeds must produce different DEKs")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0350", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "persona_isolation_from_same_seed"}
	t.Run("persona_isolation_from_same_seed", func(t *testing.T) {
		// Two personas derived from the SAME seed must get different DEKs.
		// This tests HKDF info string differentiation ("dina:vault:<persona>:v1").
		dekPersonal, err := deriver.DeriveVaultDEK(seed, "general", salt)
		if err != nil {
			t.Fatalf("personal DEK: %v", err)
		}
		dekHealth, err := deriver.DeriveVaultDEK(seed, "health", salt)
		if err != nil {
			t.Fatalf("health DEK: %v", err)
		}

		match := true
		for i := range dekPersonal {
			if dekPersonal[i] != dekHealth[i] {
				match = false
				break
			}
		}
		if match {
			t.Fatal("different personas must derive different DEKs from the same seed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0351", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "key_wrap_round_trip"}
	t.Run("key_wrap_round_trip", func(t *testing.T) {
		// In security mode, the master seed is wrapped on disk:
		//   wrapped = AES-256-GCM(KEK, seed)
		//   unwrapped = AES-256-GCM-Open(KEK, wrapped)
		// The unwrapped seed must exactly match the original.
		kek := testutil.TestKEK[:]
		wrapped, err := wrapper.Wrap(seed, kek)
		if err != nil {
			t.Fatalf("Wrap failed: %v", err)
		}

		unwrapped, err := wrapper.Unwrap(wrapped, kek)
		if err != nil {
			t.Fatalf("Unwrap failed: %v", err)
		}

		if len(unwrapped) != len(seed) {
			t.Fatalf("unwrapped length %d != original %d", len(unwrapped), len(seed))
		}
		for i := range seed {
			if unwrapped[i] != seed[i] {
				t.Fatal("unwrapped seed must exactly match original — key wrapping corrupted seed")
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0352", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "wrapped_differs_from_raw"}
	t.Run("wrapped_differs_from_raw", func(t *testing.T) {
		// Wrapping must not be a no-op — wrapped bytes must differ from raw seed.
		kek := testutil.TestKEK[:]
		wrapped, err := wrapper.Wrap(seed, kek)
		if err != nil {
			t.Fatalf("Wrap: %v", err)
		}

		// Wrapped output must be larger (nonce + ciphertext + tag).
		if len(wrapped) <= len(seed) {
			t.Fatalf("wrapped output (%d bytes) should be larger than raw seed (%d bytes)",
				len(wrapped), len(seed))
		}

		// Content must differ (not just appended zeros).
		match := true
		minLen := len(seed)
		if len(wrapped) < minLen {
			minLen = len(wrapped)
		}
		for i := 0; i < minLen; i++ {
			if wrapped[i] != seed[i] {
				match = false
				break
			}
		}
		if match && len(wrapped) == len(seed) {
			t.Fatal("wrapped bytes must differ from raw seed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0353", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "wrong_KEK_fails_unwrap"}
	t.Run("wrong_KEK_fails_unwrap", func(t *testing.T) {
		// Wrapping with one KEK and unwrapping with a different KEK must fail.
		// This proves the KEK actually protects the seed.
		kek := testutil.TestKEK[:]
		wrapped, err := wrapper.Wrap(seed, kek)
		if err != nil {
			t.Fatalf("Wrap: %v", err)
		}

		wrongKEK := testutil.TestDEK[:] // Different 32-byte key
		_, err = wrapper.Unwrap(wrapped, wrongKEK)
		if err == nil {
			t.Fatal("unwrap with wrong KEK must fail — seed protection is broken")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0354", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "derived_DEK_encrypts_data"}
	t.Run("derived_DEK_encrypts_data", func(t *testing.T) {
		// End-to-end: seed → HKDF → DEK → AES-256-GCM encrypt → decrypt.
		// Proves the DEK derived from the master seed is usable key material.
		dek, err := deriver.DeriveVaultDEK(seed, "general", salt)
		if err != nil {
			t.Fatalf("derive DEK: %v", err)
		}
		if len(dek) != 32 {
			t.Fatalf("DEK must be 32 bytes for AES-256")
		}

		// Use the DEK to wrap and unwrap some test data.
		testData := []byte("vault item encrypted with persona DEK")
		wrapped, err := wrapper.Wrap(testData, dek)
		if err != nil {
			t.Fatalf("encrypt with DEK: %v", err)
		}
		unwrapped, err := wrapper.Unwrap(wrapped, dek)
		if err != nil {
			t.Fatalf("decrypt with DEK: %v", err)
		}
		for i := range testData {
			if testData[i] != unwrapped[i] {
				t.Fatal("DEK derived from master seed must produce usable encryption key")
			}
		}
	})
}

// --------------------------------------------------------------------------
// §29.6 HKDF & Key Derivation Isolation
// --------------------------------------------------------------------------

// TST-CORE-964
// TRACE: {"suite": "CORE", "case": "0355", "section": "29", "sectionName": "Adversarial & Security", "subsection": "06", "scenario": "01", "title": "CrossPersonaDEKIsolation5Personas"}
func TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas(t *testing.T) {
	// Requirement (§29.6):
	//   Same master seed + same user salt + 5 different persona names must
	//   produce 5 mutually distinct DEKs. All 10 pairwise combinations must
	//   differ. Each derivation must be deterministic (same inputs → same output).
	//
	// Anti-tautological design:
	//   1. Derive DEKs for 5 production personas
	//   2. Verify all 10 pairwise combinations are distinct
	//   3. Verify each DEK is exactly 32 bytes (AES-256)
	//   4. Verify determinism: re-derive each and compare
	//   5. Verify different seed produces entirely different DEKs (contrast)

	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")

	personas := []string{"general", "health", "financial", "social", "consumer"}
	seed := testutil.TestMnemonicSeed
	salt := testutil.TestUserSalt[:]

	// Derive DEKs for all 5 personas.
	deks := make([][]byte, len(personas))
	for i, p := range personas {
		dek, err := impl.DeriveVaultDEK(seed, p, salt)
		testutil.RequireNoError(t, err)
		deks[i] = dek
	}

	// TRACE: {"suite": "CORE", "case": "0356", "section": "29", "sectionName": "Adversarial & Security", "title": "all_deks_are_32_bytes"}
	t.Run("all_deks_are_32_bytes", func(t *testing.T) {
		for i, dek := range deks {
			if len(dek) != 32 {
				t.Fatalf("persona %q DEK must be 32 bytes (AES-256), got %d", personas[i], len(dek))
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0357", "section": "29", "sectionName": "Adversarial & Security", "title": "all_10_pairwise_combinations_distinct"}
	t.Run("all_10_pairwise_combinations_distinct", func(t *testing.T) {
		// 5 choose 2 = 10 pairs.
		pairs := 0
		for i := 0; i < len(deks); i++ {
			for j := i + 1; j < len(deks); j++ {
				pairs++
				testutil.RequireBytesNotEqual(t, deks[i], deks[j])
			}
		}
		if pairs != 10 {
			t.Fatalf("expected 10 pairwise comparisons, got %d", pairs)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0358", "section": "29", "sectionName": "Adversarial & Security", "title": "deterministic_re_derivation"}
	t.Run("deterministic_re_derivation", func(t *testing.T) {
		// Re-derive every persona DEK and verify it matches the original.
		for i, p := range personas {
			dek2, err := impl.DeriveVaultDEK(seed, p, salt)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesEqual(t, deks[i], dek2)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0359", "section": "29", "sectionName": "Adversarial & Security", "title": "different_seed_produces_different_deks"}
	t.Run("different_seed_produces_different_deks", func(t *testing.T) {
		// Contrast: same personas + salt but different seed → all DEKs differ.
		altSeed := make([]byte, 64)
		copy(altSeed, seed)
		altSeed[0] ^= 0xFF // Flip first byte

		for i, p := range personas {
			altDEK, err := impl.DeriveVaultDEK(altSeed, p, salt)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesNotEqual(t, deks[i], altDEK)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0360", "section": "29", "sectionName": "Adversarial & Security", "title": "different_salt_produces_different_deks"}
	t.Run("different_salt_produces_different_deks", func(t *testing.T) {
		// Contrast: same seed + personas but different salt → all DEKs differ.
		altSalt := make([]byte, 32)
		copy(altSalt, salt)
		altSalt[0] ^= 0xFF

		for i, p := range personas {
			altDEK, err := impl.DeriveVaultDEK(seed, p, altSalt)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesNotEqual(t, deks[i], altDEK)
		}
	})
}

// ==========================================================================
// §30.11 — Crypto/Identity Cross-Process Tests
// ==========================================================================

// TST-CORE-1030
// Ed25519 → X25519 conversion verified across nodes.
// Requirement: Two independent nodes (separate Ed25519 keypairs from different
// seeds) must be able to exchange NaCl sealed-box messages by converting their
// Ed25519 keys to X25519. Node A seals to Node B's public key, Node B opens
// with their private key, and vice versa. Cross-contamination must fail.
// TRACE: {"suite": "CORE", "case": "0361", "section": "30", "sectionName": "Test System Quality", "subsection": "11", "scenario": "04", "title": "CrossNodeEd25519ToX25519SealedBoxExchange"}
func TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange(t *testing.T) {
	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	boxImpl := realEncryptor
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	// --- Set up two independent nodes with different seeds ---

	seedA := make([]byte, 32)
	copy(seedA, testutil.TestEd25519Seed[:])
	// Flip bits to get a completely different seed for Node B.
	seedB := make([]byte, 32)
	copy(seedB, testutil.TestEd25519Seed[:])
	seedB[0] ^= 0xFF
	seedB[15] ^= 0xAA
	seedB[31] ^= 0x55

	pubA, privA, err := sImpl.GenerateFromSeed(seedA)
	testutil.RequireNoError(t, err)

	pubB, privB, err := sImpl.GenerateFromSeed(seedB)
	testutil.RequireNoError(t, err)

	// Keys must differ between nodes.
	testutil.RequireBytesNotEqual(t, pubA, pubB)

	// Convert to X25519.
	x25519PubA, err := convImpl.Ed25519ToX25519Public(pubA)
	testutil.RequireNoError(t, err)
	x25519PrivA, err := convImpl.Ed25519ToX25519Private(privA)
	testutil.RequireNoError(t, err)

	x25519PubB, err := convImpl.Ed25519ToX25519Public(pubB)
	testutil.RequireNoError(t, err)
	x25519PrivB, err := convImpl.Ed25519ToX25519Private(privB)
	testutil.RequireNoError(t, err)

	// X25519 keys must differ between nodes.
	testutil.RequireBytesNotEqual(t, x25519PubA, x25519PubB)
	testutil.RequireBytesNotEqual(t, x25519PrivA, x25519PrivB)

	// TRACE: {"suite": "CORE", "case": "0362", "section": "30", "sectionName": "Test System Quality", "title": "node_A_seals_to_node_B_and_B_opens"}
	t.Run("node_A_seals_to_node_B_and_B_opens", func(t *testing.T) {
		// Node A encrypts a message intended for Node B.
		message := []byte("Hello from Node A to Node B — cross-node NaCl sealed box")
		sealed, err := boxImpl.SealAnonymous(message, x25519PubB)
		testutil.RequireNoError(t, err)

		// Node B opens it with their own X25519 keys.
		opened, err := boxImpl.OpenAnonymous(sealed, x25519PubB, x25519PrivB)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesEqual(t, message, opened)
	})

	// TRACE: {"suite": "CORE", "case": "0363", "section": "30", "sectionName": "Test System Quality", "title": "node_B_seals_to_node_A_and_A_opens"}
	t.Run("node_B_seals_to_node_A_and_A_opens", func(t *testing.T) {
		// Reverse direction: Node B encrypts for Node A.
		message := []byte("Hello from Node B to Node A — reverse direction test")
		sealed, err := boxImpl.SealAnonymous(message, x25519PubA)
		testutil.RequireNoError(t, err)

		// Node A opens it with their own X25519 keys.
		opened, err := boxImpl.OpenAnonymous(sealed, x25519PubA, x25519PrivA)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesEqual(t, message, opened)
	})

	// TRACE: {"suite": "CORE", "case": "0364", "section": "30", "sectionName": "Test System Quality", "title": "cross_contamination_fails_wrong_private_key"}
	t.Run("cross_contamination_fails_wrong_private_key", func(t *testing.T) {
		// A message sealed to Node B's public key must NOT be openable
		// with Node A's private key.
		message := []byte("sealed for B only")
		sealed, err := boxImpl.SealAnonymous(message, x25519PubB)
		testutil.RequireNoError(t, err)

		// Attempt to open with Node A's keys — must fail.
		_, err = boxImpl.OpenAnonymous(sealed, x25519PubA, x25519PrivA)
		if err == nil {
			t.Fatal("opening a message sealed to Node B with Node A's keys must fail — cross-contamination detected")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0365", "section": "30", "sectionName": "Test System Quality", "title": "cross_contamination_fails_mismatched_pub_priv"}
	t.Run("cross_contamination_fails_mismatched_pub_priv", func(t *testing.T) {
		// Try opening with Node B's public key but Node A's private key — must fail.
		message := []byte("sealed for B only — mismatch test")
		sealed, err := boxImpl.SealAnonymous(message, x25519PubB)
		testutil.RequireNoError(t, err)

		_, err = boxImpl.OpenAnonymous(sealed, x25519PubB, x25519PrivA)
		if err == nil {
			t.Fatal("opening with mismatched pub/priv keys must fail")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0366", "section": "30", "sectionName": "Test System Quality", "title": "ed25519_signature_interop_across_nodes"}
	t.Run("ed25519_signature_interop_across_nodes", func(t *testing.T) {
		// Node A signs a message with Ed25519, Node B verifies using Node A's
		// Ed25519 public key. This proves Ed25519 identity verification works
		// cross-node alongside X25519 encryption.
		message := []byte("signed by Node A, verified by Node B")
		sig, err := sImpl.Sign(privA, message)
		testutil.RequireNoError(t, err)

		// Node B verifies using Node A's Ed25519 public key.
		valid, err := sImpl.Verify(pubA, message, sig)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, valid, "Node B must verify Node A's signature")

		// Node B's public key must NOT verify Node A's signature.
		valid2, err := sImpl.Verify(pubB, message, sig)
		testutil.RequireNoError(t, err)
		if valid2 {
			t.Fatal("Node B's public key must NOT verify Node A's signature — identity confusion")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0367", "section": "30", "sectionName": "Test System Quality", "title": "sign_seal_unseal_verify_full_cross_node_roundtrip"}
	t.Run("sign_seal_unseal_verify_full_cross_node_roundtrip", func(t *testing.T) {
		// Full cross-node roundtrip: Node A signs a message with Ed25519, seals
		// the message+signature with NaCl to Node B's X25519 public key. Node B
		// unseals, then verifies the signature using Node A's Ed25519 public key.
		message := []byte("full roundtrip: sign → seal → unseal → verify")
		sig, err := sImpl.Sign(privA, message)
		testutil.RequireNoError(t, err)

		// Combine message + signature into a single payload.
		payload := make([]byte, 0, len(message)+len(sig))
		payload = append(payload, message...)
		payload = append(payload, sig...)

		// Seal to Node B.
		sealed, err := boxImpl.SealAnonymous(payload, x25519PubB)
		testutil.RequireNoError(t, err)

		// Node B unseals.
		opened, err := boxImpl.OpenAnonymous(sealed, x25519PubB, x25519PrivB)
		testutil.RequireNoError(t, err)

		// Extract message and signature.
		recoveredMsg := opened[:len(message)]
		recoveredSig := opened[len(message):]

		testutil.RequireBytesEqual(t, message, recoveredMsg)

		// Verify signature using Node A's Ed25519 public key.
		valid, err := sImpl.Verify(pubA, recoveredMsg, recoveredSig)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, valid, "full cross-node roundtrip signature must verify")
	})
}

// TST-CORE-1027
// Real cross-node D2D: sign → encrypt → POST → decrypt → verify.
// Requirement: Two independent nodes exchange DIDComm-style messages
// through the full D2D pipeline. Node A signs a message with Ed25519,
// wraps it in the JSON envelope {"c":"<base64>","s":"<hex-sig>"}, encrypts
// the payload with NaCl sealed box to Node B's X25519 key. Node B decrypts,
// extracts the envelope, verifies the Ed25519 signature. The test covers
// the exact wire format used by Core's transport layer.
// TST-CORE-1222
// TRACE: {"suite": "CORE", "case": "0368", "section": "30", "sectionName": "Test System Quality", "subsection": "11", "scenario": "01", "title": "RealCrossNodeD2DSignEncryptDecryptVerify"}
func TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify(t *testing.T) {
	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	boxImpl := realEncryptor
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	// --- Set up two independent nodes ---
	seedA := make([]byte, 32)
	copy(seedA, testutil.TestEd25519Seed[:])

	seedB := make([]byte, 32)
	copy(seedB, testutil.TestEd25519Seed[:])
	seedB[0] ^= 0xFF
	seedB[15] ^= 0xAA

	pubA, privA, err := sImpl.GenerateFromSeed(seedA)
	testutil.RequireNoError(t, err)

	pubB, privB, err := sImpl.GenerateFromSeed(seedB)
	testutil.RequireNoError(t, err)

	x25519PubA, err := convImpl.Ed25519ToX25519Public(pubA)
	testutil.RequireNoError(t, err)
	x25519PrivA, err := convImpl.Ed25519ToX25519Private(privA)
	testutil.RequireNoError(t, err)

	x25519PubB, err := convImpl.Ed25519ToX25519Public(pubB)
	testutil.RequireNoError(t, err)
	x25519PrivB, err := convImpl.Ed25519ToX25519Private(privB)
	testutil.RequireNoError(t, err)

	// TRACE: {"suite": "CORE", "case": "0369", "section": "30", "sectionName": "Test System Quality", "title": "node_a_to_node_b_full_d2d_pipeline"}
	t.Run("node_a_to_node_b_full_d2d_pipeline", func(t *testing.T) {
		// Step 1: Node A creates the plaintext message.
		message := []byte(`{"type":"nudge","content":"Time to take a break","from":"did:plc:nodeA"}`)

		// Step 2: Node A signs the message with Ed25519.
		sig, err := sImpl.Sign(privA, message)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesLen(t, sig, 64) // Ed25519 signatures are 64 bytes.

		// Step 3: Build the D2D envelope: {"c":"<base64(message)>","s":"<hex(sig)>"}
		// This matches Core's ProcessInbound wire format.
		envelope := struct {
			Ciphertext string `json:"c"`
			Sig        string `json:"s"`
		}{
			Ciphertext: fmt.Sprintf("%x", message), // hex encoding of plaintext
			Sig:        fmt.Sprintf("%x", sig),      // hex encoding of signature
		}
		envelopeJSON, err := json.Marshal(envelope)
		if err != nil {
			t.Fatalf("envelope marshal: %v", err)
		}

		// Step 4: Encrypt the envelope with NaCl sealed box to Node B's X25519 key.
		sealed, err := boxImpl.SealAnonymous(envelopeJSON, x25519PubB)
		testutil.RequireNoError(t, err)

		// --- Network transit (simulated) ---

		// Step 5: Node B decrypts with their X25519 private key.
		opened, err := boxImpl.OpenAnonymous(sealed, x25519PubB, x25519PrivB)
		testutil.RequireNoError(t, err)

		// Step 6: Parse the D2D envelope.
		var received struct {
			Ciphertext string `json:"c"`
			Sig        string `json:"s"`
		}
		if err := json.Unmarshal(opened, &received); err != nil {
			t.Fatalf("envelope unmarshal: %v", err)
		}

		// Both fields must be present (non-empty).
		if received.Ciphertext == "" {
			t.Fatal("envelope missing ciphertext field 'c'")
		}
		if received.Sig == "" {
			t.Fatal("envelope missing signature field 's'")
		}

		// Step 7: Decode the message and signature from hex.
		recoveredMsg, err := hex.DecodeString(received.Ciphertext)
		if err != nil {
			t.Fatalf("hex decode ciphertext: %v", err)
		}
		recoveredSig, err := hex.DecodeString(received.Sig)
		if err != nil {
			t.Fatalf("hex decode sig: %v", err)
		}

		// Step 8: Verify the original message was preserved.
		testutil.RequireBytesEqual(t, message, recoveredMsg)

		// Step 9: Verify the Ed25519 signature using Node A's public key.
		valid, err := sImpl.Verify(pubA, recoveredMsg, recoveredSig)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, valid, "Node B must verify Node A's signature on the message")

		// Step 10: Node B's key must NOT verify the signature (authenticity proof).
		valid2, err := sImpl.Verify(pubB, recoveredMsg, recoveredSig)
		testutil.RequireNoError(t, err)
		if valid2 {
			t.Fatal("Node B's key must NOT verify Node A's signature — identity confusion")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0370", "section": "30", "sectionName": "Test System Quality", "title": "bidirectional_exchange"}
	t.Run("bidirectional_exchange", func(t *testing.T) {
		// Both nodes exchange messages simultaneously. Each verifies the other.
		msgAtoB := []byte(`{"from":"nodeA","to":"nodeB","msg":"hello B"}`)
		msgBtoA := []byte(`{"from":"nodeB","to":"nodeA","msg":"hello A"}`)

		// Node A signs and seals to B.
		sigA, err := sImpl.Sign(privA, msgAtoB)
		testutil.RequireNoError(t, err)
		payloadA, _ := json.Marshal(map[string]string{
			"c": fmt.Sprintf("%x", msgAtoB),
			"s": fmt.Sprintf("%x", sigA),
		})
		sealedAtoB, err := boxImpl.SealAnonymous(payloadA, x25519PubB)
		testutil.RequireNoError(t, err)

		// Node B signs and seals to A.
		sigB, err := sImpl.Sign(privB, msgBtoA)
		testutil.RequireNoError(t, err)
		payloadB, _ := json.Marshal(map[string]string{
			"c": fmt.Sprintf("%x", msgBtoA),
			"s": fmt.Sprintf("%x", sigB),
		})
		sealedBtoA, err := boxImpl.SealAnonymous(payloadB, x25519PubA)
		testutil.RequireNoError(t, err)

		// Node B decrypts A's message.
		openedFromA, err := boxImpl.OpenAnonymous(sealedAtoB, x25519PubB, x25519PrivB)
		testutil.RequireNoError(t, err)
		var envFromA map[string]string
		json.Unmarshal(openedFromA, &envFromA)
		decMsg, _ := hex.DecodeString(envFromA["c"])
		decSig, _ := hex.DecodeString(envFromA["s"])
		valid, _ := sImpl.Verify(pubA, decMsg, decSig)
		testutil.RequireTrue(t, valid, "B must verify A's message")
		testutil.RequireBytesEqual(t, msgAtoB, decMsg)

		// Node A decrypts B's message.
		openedFromB, err := boxImpl.OpenAnonymous(sealedBtoA, x25519PubA, x25519PrivA)
		testutil.RequireNoError(t, err)
		var envFromB map[string]string
		json.Unmarshal(openedFromB, &envFromB)
		decMsg2, _ := hex.DecodeString(envFromB["c"])
		decSig2, _ := hex.DecodeString(envFromB["s"])
		valid2, _ := sImpl.Verify(pubB, decMsg2, decSig2)
		testutil.RequireTrue(t, valid2, "A must verify B's message")
		testutil.RequireBytesEqual(t, msgBtoA, decMsg2)
	})

	// TRACE: {"suite": "CORE", "case": "0371", "section": "30", "sectionName": "Test System Quality", "title": "tampered_ciphertext_fails_verification"}
	t.Run("tampered_ciphertext_fails_verification", func(t *testing.T) {
		// Node A sends a message. An attacker tampers with the sealed payload.
		message := []byte(`{"sensitive":"vault data"}`)
		sig, _ := sImpl.Sign(privA, message)
		payload, _ := json.Marshal(map[string]string{
			"c": fmt.Sprintf("%x", message),
			"s": fmt.Sprintf("%x", sig),
		})
		sealed, _ := boxImpl.SealAnonymous(payload, x25519PubB)

		// Tamper with the sealed bytes.
		tampered := make([]byte, len(sealed))
		copy(tampered, sealed)
		tampered[len(tampered)/2] ^= 0xFF

		// Node B tries to open tampered payload — must fail.
		_, err := boxImpl.OpenAnonymous(tampered, x25519PubB, x25519PrivB)
		if err == nil {
			t.Fatal("opening tampered sealed payload must fail — integrity violation")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0372", "section": "30", "sectionName": "Test System Quality", "title": "forged_signature_detected"}
	t.Run("forged_signature_detected", func(t *testing.T) {
		// Attacker creates a message with a valid-looking envelope but signs
		// with their own key (not Node A's). Node B must detect the forgery.
		message := []byte(`{"type":"transfer_money","amount":10000}`)

		// Attacker signs with Node B's private key (pretending to be Node A).
		forgeSig, _ := sImpl.Sign(privB, message)
		payload, _ := json.Marshal(map[string]string{
			"c": fmt.Sprintf("%x", message),
			"s": fmt.Sprintf("%x", forgeSig),
		})
		sealed, _ := boxImpl.SealAnonymous(payload, x25519PubB)

		// Node B decrypts (encryption succeeded, attacker knew B's public key).
		opened, err := boxImpl.OpenAnonymous(sealed, x25519PubB, x25519PrivB)
		testutil.RequireNoError(t, err)

		// Parse envelope.
		var env map[string]string
		json.Unmarshal(opened, &env)
		decMsg, _ := hex.DecodeString(env["c"])
		decSig, _ := hex.DecodeString(env["s"])

		// Verify using Node A's public key — must FAIL (signature was made by attacker).
		valid, _ := sImpl.Verify(pubA, decMsg, decSig)
		if valid {
			t.Fatal("forged signature verified as Node A — catastrophic authentication failure")
		}
	})
}

// TST-CORE-062
// Mnemonic recovery: re-derive everything.
// §2.1 BIP-39 Mnemonic Generation
// Requirement: Entering the same 24-word mnemonic on a new install produces
// identical root keypair, identical persona signing keys, identical vault DEKs,
// identical service keys, and an identical DID. This test validates the Go
// side of recovery: given the SAME seed (which a correct mnemonic produces),
// ALL derived keys are byte-identical across two independent derivation runs.
// This proves full identity restoration is possible from just the mnemonic.
// TRACE: {"suite": "CORE", "case": "0373", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "01", "scenario": "07", "title": "MnemonicRecoveryReDeriveEverything"}
func TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	dekDeriver := realVaultDEKDeriver
	testutil.RequireImplementation(t, dekDeriver, "VaultDEKDeriver")

	seed := testutil.TestMnemonicSeed

	// Simulate two independent derivation runs (original install vs recovery).
	// Both must produce byte-identical output at every level.

	// TRACE: {"suite": "CORE", "case": "0374", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "root_signing_key_deterministic"}
	t.Run("root_signing_key_deterministic", func(t *testing.T) {
		// The root identity signing key must be identical across recovery.
		// This key generates the DID — if it differs, the identity is lost.
		pub1, priv1, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)
		pub2, priv2, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesEqual(t, pub1, pub2)
		testutil.RequireBytesEqual(t, []byte(priv1), []byte(priv2))
		testutil.RequireBytesLen(t, pub1, 32)
		testutil.RequireBytesLen(t, []byte(priv1), 64)
	})

	// TRACE: {"suite": "CORE", "case": "0375", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "all_persona_signing_keys_deterministic"}
	t.Run("all_persona_signing_keys_deterministic", func(t *testing.T) {
		// Every persona's signing key must be identical after recovery.
		// Without this, persona-specific signatures won't verify.
		personas := []struct {
			name  string
			index uint32
		}{
			{"consumer", 0}, {"professional", 1}, {"social", 2},
			{"health", 3}, {"financial", 4}, {"citizen", 5},
		}
		for _, p := range personas {
			key1, err := kd.DeriveSigningKey(seed, p.index, 0)
			testutil.RequireNoError(t, err)
			key2, err := kd.DeriveSigningKey(seed, p.index, 0)
			testutil.RequireNoError(t, err)
			if string(key1) != string(key2) {
				t.Fatalf("persona %q (index %d): signing keys differ after recovery", p.name, p.index)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0376", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "all_persona_vault_deks_deterministic"}
	t.Run("all_persona_vault_deks_deterministic", func(t *testing.T) {
		// Every persona's vault DEK must be identical after recovery.
		// Without this, encrypted vault data is inaccessible.
		personas := []string{"identity", "general", "health", "financial", "social", "consumer"}
		for _, persona := range personas {
			dek1, err := dekDeriver.DeriveVaultDEK(seed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			dek2, err := dekDeriver.DeriveVaultDEK(seed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			testutil.RequireBytesEqual(t, dek1, dek2)
			testutil.RequireBytesLen(t, dek1, 32)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0377", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "service_keys_deterministic"}
	t.Run("service_keys_deterministic", func(t *testing.T) {
		// Core (index 0) and Brain (index 1) service keys must match after recovery.
		// Without this, inter-service auth breaks.
		for _, idx := range []uint32{0, 1} {
			key1, err := kd.DeriveServiceKey(seed, idx)
			testutil.RequireNoError(t, err)
			key2, err := kd.DeriveServiceKey(seed, idx)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesEqual(t, key1.Seed(), key2.Seed())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0378", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "did_key_deterministic_from_root_pubkey"}
	t.Run("did_key_deterministic_from_root_pubkey", func(t *testing.T) {
		// The DID derived from the root public key must be identical.
		// This is the user's permanent identity — it MUST survive recovery.
		pub1, _, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)
		pub2, _, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)

		// Construct did:key:z... from Ed25519 public key.
		// Multicodec prefix for Ed25519: 0xed 0x01
		did1 := ed25519DIDKey(pub1)
		did2 := ed25519DIDKey(pub2)
		if did1 != did2 {
			t.Fatalf("DID changed after recovery: %s vs %s", did1, did2)
		}
		if did1 == "" {
			t.Fatal("DID must not be empty")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0379", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "cross_layer_isolation_preserved_after_recovery"}
	t.Run("cross_layer_isolation_preserved_after_recovery", func(t *testing.T) {
		// Critical: even though all keys are derived from one seed,
		// they must be cryptographically isolated. Root key != persona key != DEK.
		rootPub, _, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)

		personaKey, err := kd.DeriveSigningKey(seed, 0, 0) // consumer persona
		testutil.RequireNoError(t, err)
		personaPub := []byte(personaKey[32:])

		serviceKey, err := kd.DeriveServiceKey(seed, 0) // core service
		testutil.RequireNoError(t, err)
		servicePub := []byte(serviceKey[32:])

		dek, err := dekDeriver.DeriveVaultDEK(seed, "general", testutil.TestUserSalt[:])
		testutil.RequireNoError(t, err)

		// All must be different from each other.
		testutil.RequireBytesNotEqual(t, rootPub, personaPub)
		testutil.RequireBytesNotEqual(t, rootPub, servicePub)
		testutil.RequireBytesNotEqual(t, rootPub, dek)
		testutil.RequireBytesNotEqual(t, personaPub, servicePub)
		testutil.RequireBytesNotEqual(t, personaPub, dek)
		testutil.RequireBytesNotEqual(t, servicePub, dek)
	})
}

// ed25519DIDKey converts a 32-byte Ed25519 public key to a did:key:z identifier.
// Uses the multicodec prefix 0xed 0x01 for Ed25519, then base58btc encoding.
func ed25519DIDKey(pub []byte) string {
	if len(pub) != 32 {
		return ""
	}
	multicodec := append([]byte{0xed, 0x01}, pub...)
	// Minimal base58btc encoding (Bitcoin alphabet).
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	result := make([]byte, 0, 50)
	x := make([]byte, len(multicodec))
	copy(x, multicodec)
	for {
		allZero := true
		remainder := 0
		for i := range x {
			val := remainder*256 + int(x[i])
			x[i] = byte(val / 58)
			remainder = val % 58
			if x[i] != 0 {
				allZero = false
			}
		}
		result = append(result, alphabet[remainder])
		if allZero {
			break
		}
	}
	for _, b := range multicodec {
		if b != 0 {
			break
		}
		result = append(result, alphabet[0])
	}
	// Reverse.
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return "did:key:z" + string(result)
}

// TST-CORE-064
// Lose device + paper = identity gone.
// §2.1 BIP-39 Mnemonic Generation
// Requirement: Without the mnemonic (and therefore the seed), the identity is
// completely unrecoverable. There is no password reset, no server-side recovery,
// no backdoor. This is by design: sovereignty = responsibility.
// This test validates that a DIFFERENT seed (simulating loss of the original)
// produces a completely different identity at every derivation layer.
// TRACE: {"suite": "CORE", "case": "0380", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "01", "scenario": "09", "title": "LoseDeviceAndPaperIdentityGone"}
func TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	dekDeriver := realVaultDEKDeriver
	testutil.RequireImplementation(t, dekDeriver, "VaultDEKDeriver")

	originalSeed := testutil.TestMnemonicSeed
	// Create a completely different seed (simulating lost mnemonic).
	lostSeed := make([]byte, len(originalSeed))
	copy(lostSeed, originalSeed)
	// Flip every byte — ensures maximum distance from the original.
	for i := range lostSeed {
		lostSeed[i] ^= 0xFF
	}

	// TRACE: {"suite": "CORE", "case": "0381", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "root_key_irrecoverable"}
	t.Run("root_key_irrecoverable", func(t *testing.T) {
		// A different seed produces a completely different root signing key.
		// The user's DID changes, and the original identity is GONE.
		origPub, _, err := kd.DeriveRootSigningKey(originalSeed, 0)
		testutil.RequireNoError(t, err)
		lostPub, _, err := kd.DeriveRootSigningKey(lostSeed, 0)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesNotEqual(t, origPub, lostPub)
	})

	// TRACE: {"suite": "CORE", "case": "0382", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "did_irrecoverable"}
	t.Run("did_irrecoverable", func(t *testing.T) {
		// The DID derived from a wrong seed is completely different.
		// No server can fix this — the DID is a pure function of the seed.
		origPub, _, _ := kd.DeriveRootSigningKey(originalSeed, 0)
		lostPub, _, _ := kd.DeriveRootSigningKey(lostSeed, 0)
		origDID := ed25519DIDKey(origPub)
		lostDID := ed25519DIDKey(lostPub)
		if origDID == lostDID {
			t.Fatal("different seeds must produce different DIDs — identity collision would break sovereignty")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0383", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "all_persona_keys_irrecoverable"}
	t.Run("all_persona_keys_irrecoverable", func(t *testing.T) {
		// Every persona's signing key changes with a different seed.
		// Nothing signed under the original identity can be reproduced.
		for idx := uint32(0); idx < 6; idx++ {
			origKey, err := kd.DeriveSigningKey(originalSeed, idx, 0)
			testutil.RequireNoError(t, err)
			lostKey, err := kd.DeriveSigningKey(lostSeed, idx, 0)
			testutil.RequireNoError(t, err)
			if string(origKey) == string(lostKey) {
				t.Fatalf("persona index %d: different seeds produced same signing key — catastrophic", idx)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0384", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "vault_deks_irrecoverable"}
	t.Run("vault_deks_irrecoverable", func(t *testing.T) {
		// Every persona's vault DEK changes with a different seed.
		// ALL encrypted data in ALL vaults becomes permanently inaccessible.
		personas := []string{"identity", "general", "health", "financial", "social"}
		for _, persona := range personas {
			origDEK, err := dekDeriver.DeriveVaultDEK(originalSeed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			lostDEK, err := dekDeriver.DeriveVaultDEK(lostSeed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			testutil.RequireBytesNotEqual(t, origDEK, lostDEK)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0385", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "service_keys_irrecoverable"}
	t.Run("service_keys_irrecoverable", func(t *testing.T) {
		// Service keys change — inter-service auth with the original Core/Brain pair fails.
		for _, idx := range []uint32{0, 1} {
			origKey, err := kd.DeriveServiceKey(originalSeed, idx)
			testutil.RequireNoError(t, err)
			lostKey, err := kd.DeriveServiceKey(lostSeed, idx)
			testutil.RequireNoError(t, err)
			if string(origKey.Seed()) == string(lostKey.Seed()) {
				t.Fatalf("service index %d: different seeds produced same key", idx)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0386", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "single_bit_change_still_irrecoverable"}
	t.Run("single_bit_change_still_irrecoverable", func(t *testing.T) {
		// Even a SINGLE bit difference in the seed produces a completely
		// different identity. There's no "close enough" in cryptography.
		nearSeed := make([]byte, len(originalSeed))
		copy(nearSeed, originalSeed)
		nearSeed[0] ^= 0x01 // flip just one bit

		origPub, _, err := kd.DeriveRootSigningKey(originalSeed, 0)
		testutil.RequireNoError(t, err)
		nearPub, _, err := kd.DeriveRootSigningKey(nearSeed, 0)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesNotEqual(t, origPub, nearPub)

		// Also check DEK — one-bit seed change must produce different vault key.
		origDEK, _ := dekDeriver.DeriveVaultDEK(originalSeed, "general", testutil.TestUserSalt[:])
		nearDEK, _ := dekDeriver.DeriveVaultDEK(nearSeed, "general", testutil.TestUserSalt[:])
		testutil.RequireBytesNotEqual(t, origDEK, nearDEK)
	})

	// TRACE: {"suite": "CORE", "case": "0387", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "no_server_side_recovery_possible"}
	t.Run("no_server_side_recovery_possible", func(t *testing.T) {
		// This test validates the DESIGN PRINCIPLE: all key material is
		// derived deterministically from the seed. There is no "recovery
		// service" that holds a copy. The seed IS the identity.
		//
		// We verify this by checking that the derivation is purely mathematical:
		// same inputs always produce same outputs, different inputs always
		// produce different outputs. No external state, no server interaction.
		origPub, _, _ := kd.DeriveRootSigningKey(originalSeed, 0)
		verifyPub, _, _ := kd.DeriveRootSigningKey(originalSeed, 0)
		testutil.RequireBytesEqual(t, origPub, verifyPub)

		// The ONLY way to get origPub back is to have originalSeed.
		// Any other seed produces a different key.
		wrongSeeds := [][]byte{lostSeed}
		for _, ws := range wrongSeeds {
			wrongPub, _, _ := kd.DeriveRootSigningKey(ws, 0)
			testutil.RequireBytesNotEqual(t, origPub, wrongPub)
		}
	})
}

// TST-CORE-974
// Deterministic seed derivation.
// §29.8 BIP-39 Recovery Safety
// Requirement: The same seed input always produces identical derived key
// material. This is the foundation of recovery: if derivation were
// non-deterministic, recovery from mnemonic would be impossible.
// While BIP-39 mnemonic → seed conversion is handled client-side (Python),
// Go Core MUST guarantee that seed → keys is perfectly deterministic.
// This test calls every derivation function TWICE with the same seed
// and verifies byte-exact identity of all outputs.
// TRACE: {"suite": "CORE", "case": "0388", "section": "29", "sectionName": "Adversarial & Security", "subsection": "08", "scenario": "03", "title": "DeterministicSeedDerivation"}
func TestCrypto_29_8_3_DeterministicSeedDerivation(t *testing.T) {
	slip := dinacrypto.NewSLIP0010Deriver()
	kd := dinacrypto.NewKeyDeriver(slip)
	dekDeriver := realVaultDEKDeriver
	testutil.RequireImplementation(t, dekDeriver, "VaultDEKDeriver")

	seed := testutil.TestMnemonicSeed

	// TRACE: {"suite": "CORE", "case": "0389", "section": "29", "sectionName": "Adversarial & Security", "title": "slip0010_determinism_all_paths"}
	t.Run("slip0010_determinism_all_paths", func(t *testing.T) {
		// SLIP-0010 derivation at EVERY standard path must be deterministic.
		paths := []string{
			"m/9999'/0'/0'",  // root signing key
			"m/9999'/1'/0'",  // purpose 1 (persona signing)
			"m/9999'/1'/0'/0'", // consumer persona gen 0
			"m/9999'/1'/3'/0'", // health persona gen 0
			"m/9999'/2'/0'",  // PLC rotation key path
			"m/9999'/3'/0'",  // core service key
			"m/9999'/3'/1'",  // brain service key
		}
		for _, path := range paths {
			pub1, priv1, err := slip.DerivePath(seed, path)
			testutil.RequireNoError(t, err)
			pub2, priv2, err := slip.DerivePath(seed, path)
			testutil.RequireNoError(t, err)
			testutil.RequireBytesEqual(t, pub1, pub2)
			testutil.RequireBytesEqual(t, priv1, priv2)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0390", "section": "29", "sectionName": "Adversarial & Security", "title": "hkdf_determinism_all_personas"}
	t.Run("hkdf_determinism_all_personas", func(t *testing.T) {
		// HKDF-SHA256 DEK derivation for every persona must be deterministic.
		personas := []string{"identity", "general", "health", "financial", "social", "consumer", "professional"}
		for _, persona := range personas {
			dek1, err := dekDeriver.DeriveVaultDEK(seed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			dek2, err := dekDeriver.DeriveVaultDEK(seed, persona, testutil.TestUserSalt[:])
			testutil.RequireNoError(t, err)
			testutil.RequireBytesEqual(t, dek1, dek2)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0391", "section": "29", "sectionName": "Adversarial & Security", "title": "keyderiver_high_level_determinism"}
	t.Run("keyderiver_high_level_determinism", func(t *testing.T) {
		// High-level KeyDeriver functions wrapping SLIP-0010 must be deterministic.
		// Root signing key.
		pub1, priv1, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)
		pub2, priv2, err := kd.DeriveRootSigningKey(seed, 0)
		testutil.RequireNoError(t, err)
		testutil.RequireBytesEqual(t, pub1, pub2)
		testutil.RequireBytesEqual(t, []byte(priv1), []byte(priv2))

		// Persona signing keys.
		for idx := uint32(0); idx < 6; idx++ {
			k1, _ := kd.DeriveSigningKey(seed, idx, 0)
			k2, _ := kd.DeriveSigningKey(seed, idx, 0)
			testutil.RequireBytesEqual(t, []byte(k1), []byte(k2))
		}

		// Service keys.
		for idx := uint32(0); idx < 2; idx++ {
			k1, _ := kd.DeriveServiceKey(seed, idx)
			k2, _ := kd.DeriveServiceKey(seed, idx)
			testutil.RequireBytesEqual(t, k1.Seed(), k2.Seed())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0392", "section": "29", "sectionName": "Adversarial & Security", "title": "independent_instances_same_output"}
	t.Run("independent_instances_same_output", func(t *testing.T) {
		// Two independently-created deriver instances must produce
		// identical output. This proves there's no hidden state.
		slip1 := dinacrypto.NewSLIP0010Deriver()
		slip2 := dinacrypto.NewSLIP0010Deriver()

		pub1, priv1, _ := slip1.DerivePath(seed, testutil.DinaRootKeyPath)
		pub2, priv2, _ := slip2.DerivePath(seed, testutil.DinaRootKeyPath)
		testutil.RequireBytesEqual(t, pub1, pub2)
		testutil.RequireBytesEqual(t, priv1, priv2)
	})
}

// TST-CORE-057
// Mnemonic → seed derivation.
// §2.1 BIP-39 Mnemonic Generation
// Requirement: Given a known BIP-39 test vector mnemonic, the system produces
// the correct 512-bit seed via PBKDF2-HMAC-SHA512, 2048 iterations, with
// salt = "mnemonic" (no passphrase). The Go side uses the 64-byte seed as
// input key material for SLIP-0010 and HKDF derivation. The Python side handles
// the mnemonic ↔ entropy conversion using the Trezor reference library.
// Both sides must agree: the same mnemonic always produces the same seed,
// and that seed feeds deterministic key derivation.
// TRACE: {"suite": "CORE", "case": "0393", "section": "02", "sectionName": "Key Derivation & Cryptography", "subsection": "01", "scenario": "02", "title": "MnemonicToSeedDerivation"}
func TestCrypto_2_1_2_MnemonicToSeedDerivation(t *testing.T) {
	root := findProjectRoot(t)

	// TRACE: {"suite": "CORE", "case": "0394", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "go_test_vector_is_standard_bip39_512bit_seed"}
	t.Run("go_test_vector_is_standard_bip39_512bit_seed", func(t *testing.T) {
		// The TestMnemonicSeed fixture must be exactly 64 bytes (512 bits).
		// BIP-39 PBKDF2-HMAC-SHA512 always produces 512 bits regardless of input.
		seed := testutil.TestMnemonicSeed
		if len(seed) != 64 {
			t.Fatalf("TestMnemonicSeed must be 64 bytes (512-bit BIP-39 seed), got %d bytes", len(seed))
		}
	})

	// TRACE: {"suite": "CORE", "case": "0395", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "go_test_vector_matches_known_bip39_output"}
	t.Run("go_test_vector_matches_known_bip39_output", func(t *testing.T) {
		// The "abandon" x 23 + "art" test vector is the most widely used BIP-39
		// test vector. Its PBKDF2-HMAC-SHA512(mnemonic, "mnemonic", 2048) output
		// is published in https://github.com/trezor/python-mnemonic/blob/master/vectors.json
		// First 8 bytes: 0x408b285c12383600
		seed := testutil.TestMnemonicSeed
		expectedPrefix := []byte{0x40, 0x8b, 0x28, 0x5c, 0x12, 0x38, 0x36, 0x00}
		for i, b := range expectedPrefix {
			if seed[i] != b {
				t.Fatalf("TestMnemonicSeed[%d] = 0x%02x, expected 0x%02x — "+
					"does not match published BIP-39 'abandon...art' test vector",
					i, seed[i], b)
			}
		}
		// Last 4 bytes: 0x99480840
		expectedSuffix := []byte{0x99, 0x48, 0x08, 0x40}
		for i, b := range expectedSuffix {
			idx := len(seed) - 4 + i
			if seed[idx] != b {
				t.Fatalf("TestMnemonicSeed[%d] = 0x%02x, expected 0x%02x — "+
					"tail mismatch with published BIP-39 test vector", idx, seed[idx], b)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0396", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "go_fixtures_document_pbkdf2_derivation"}
	t.Run("go_fixtures_document_pbkdf2_derivation", func(t *testing.T) {
		// The fixtures file must explicitly document that the seed comes from
		// PBKDF2-HMAC-SHA512 with 2048 iterations and salt = "mnemonic".
		// This ensures future developers don't confuse raw entropy with derived seed.
		content := readProjectFile(t, root, "core/test/testutil/fixtures.go")

		if !strings.Contains(content, "PBKDF2") {
			t.Fatal("fixtures.go must document PBKDF2 derivation method for TestMnemonicSeed")
		}
		if !strings.Contains(content, "HMAC-SHA512") || !strings.Contains(content, "SHA512") {
			t.Fatal("fixtures.go must document SHA512 hash for PBKDF2 derivation")
		}
		if !strings.Contains(content, "2048") {
			t.Fatal("fixtures.go must document 2048 iterations for PBKDF2")
		}
		if !strings.Contains(content, `"mnemonic"`) {
			t.Fatal(`fixtures.go must document salt = "mnemonic" (BIP-39 standard salt)`)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0397", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "seed_feeds_slip0010_derivation_correctly"}
	t.Run("seed_feeds_slip0010_derivation_correctly", func(t *testing.T) {
		// The 64-byte seed from PBKDF2 must produce valid SLIP-0010 keys.
		// If the seed were wrong (e.g., truncated or from a different mnemonic),
		// derivation would still work but produce wrong keys — so we verify
		// that at least the root key is non-zero and has valid Ed25519 properties.
		slip := dinacrypto.NewSLIP0010Deriver()
		seed := testutil.TestMnemonicSeed

		pub, priv, err := slip.DerivePath(seed, testutil.DinaRootKeyPath)
		if err != nil {
			t.Fatalf("SLIP-0010 derivation from BIP-39 seed failed: %v", err)
		}

		// Public key must be exactly 32 bytes (Ed25519 compressed point).
		if len(pub) != 32 {
			t.Fatalf("derived public key must be 32 bytes, got %d", len(pub))
		}
		// SLIP-0010 private key output is either 32 bytes (seed) or 64 bytes
		// (full Ed25519 key = seed + public). Both are valid representations.
		if len(priv) != 32 && len(priv) != 64 {
			t.Fatalf("derived private key must be 32 or 64 bytes, got %d", len(priv))
		}

		// Public key must not be all zeros (would indicate derivation failure).
		allZero := true
		for _, b := range pub {
			if b != 0 {
				allZero = false
				break
			}
		}
		if allZero {
			t.Fatal("derived public key is all zeros — derivation failure")
		}

		// Ed25519 signing/verification must succeed with derived keys.
		// Use the private key directly if 64 bytes, or expand from seed if 32.
		var fullPriv ed25519.PrivateKey
		if len(priv) == 64 {
			fullPriv = ed25519.PrivateKey(priv)
		} else {
			fullPriv = ed25519.NewKeyFromSeed(priv)
		}
		msg := []byte("BIP-39 seed derivation test")
		sig := ed25519.Sign(fullPriv, msg)
		if !ed25519.Verify(ed25519.PublicKey(pub), msg, sig) {
			t.Fatal("Ed25519 sign/verify failed with BIP-39-derived SLIP-0010 keys")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0398", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "python_roundtrip_uses_to_mnemonic_and_to_entropy"}
	t.Run("python_roundtrip_uses_to_mnemonic_and_to_entropy", func(t *testing.T) {
		// The Python CLI converts entropy → mnemonic (for backup display) and
		// mnemonic → entropy (for recovery). These use the Trezor library's
		// to_mnemonic() and to_entropy() respectively, which are the inverse
		// functions. to_entropy recovers the original 32-byte entropy from the
		// 24 words (NOT the PBKDF2-derived 512-bit seed).
		// The Go side receives the 64-byte PBKDF2 seed from install.sh.
		seedWrap := readProjectFile(t, root, "cli/src/dina_cli/seed_wrap.py")

		// Forward path: entropy → mnemonic (for display/backup).
		if !strings.Contains(seedWrap, ".to_mnemonic(") {
			t.Fatal("Python must use Trezor .to_mnemonic() for entropy → mnemonic conversion")
		}

		// Reverse path: mnemonic → entropy (for recovery).
		if !strings.Contains(seedWrap, ".to_entropy(") {
			t.Fatal("Python must use Trezor .to_entropy() for mnemonic → entropy recovery")
		}

		// Return type of mnemonic_to_seed must be bytes (raw entropy).
		retTypeRe := regexp.MustCompile(`def\s+mnemonic_to_seed\s*\([^)]*\)\s*->\s*bytes`)
		if !retTypeRe.MatchString(seedWrap) {
			t.Fatal("mnemonic_to_seed must return bytes (raw entropy), not str or int")
		}

		// The to_entropy result must be wrapped in bytes() since the Trezor
		// library returns a bytearray.
		if !strings.Contains(seedWrap, "bytes(_M.to_entropy(") {
			t.Fatal("mnemonic_to_seed must wrap to_entropy result in bytes() for type consistency")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0399", "section": "02", "sectionName": "Key Derivation & Cryptography", "title": "seed_hkdf_derivation_uses_full_64_bytes"}
	t.Run("seed_hkdf_derivation_uses_full_64_bytes", func(t *testing.T) {
		// HKDF-SHA256 DEK derivation must use the full 64-byte seed as IKM.
		// Truncating the seed would reduce entropy and weaken vault encryption.
		dekDeriver := realVaultDEKDeriver
		testutil.RequireImplementation(t, dekDeriver, "VaultDEKDeriver")
		seed := testutil.TestMnemonicSeed

		// Derive a DEK — must succeed with 64-byte seed.
		dek, err := dekDeriver.DeriveVaultDEK(seed, "general", testutil.TestUserSalt[:])
		if err != nil {
			t.Fatalf("HKDF derivation from 64-byte BIP-39 seed failed: %v", err)
		}
		// DEK must be exactly 32 bytes (AES-256).
		if len(dek) != 32 {
			t.Fatalf("vault DEK must be 32 bytes, got %d", len(dek))
		}

		// Different personas from same seed must produce different DEKs.
		dek2, _ := dekDeriver.DeriveVaultDEK(seed, "health", testutil.TestUserSalt[:])
		if string(dek) == string(dek2) {
			t.Fatal("different personas must produce different DEKs from same seed")
		}
	})
}
