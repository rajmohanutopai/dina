package test

import (
	"testing"

	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §24 — Deferred (Phase 2+)
// ==========================================================================
// Covers §24.1 (ZKP Trust Rings), §24.2 (HSM/Secure Enclave),
// §24.3 (Tier 5 Deep Archive), §24.4 (ZFS/Btrfs Snapshots),
// §24.5 (Client Cache Sync).
//
// These scenarios depend on features not yet implemented. Include in active
// test suite when the corresponding phase ships.
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §24.1 ZKP Trust Rings (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-751
func TestDeferred_24_1_1_Ring1UnverifiedDina(t *testing.T) {
	// New DID with no verification must have trust level: unverified,
	// very low trust ceiling, small interactions only.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	ring, err := impl.GetRingLevel("did:key:z6MkNewUnverified")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, ring, 1)
}

// TST-CORE-752
func TestDeferred_24_1_2_Ring2VerifiedHumanZKP(t *testing.T) {
	// User proves valid government ID via ZKP circuit.
	// Proof that "this is a valid, unique ID number" without revealing number.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	proof := testutil.ZKProof{
		ProofType:   "government_id",
		Proof:       []byte("mock-zkp-proof-bytes"),
		PublicInput: []byte("mock-public-input"),
		Ring:        2,
	}
	valid, err := impl.VerifyProof(proof)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "valid ZKP government ID proof must verify")
}

// TST-CORE-753
func TestDeferred_24_1_3_Ring2Phase1Compromise(t *testing.T) {
	// Phase 1 compromise: Aadhaar e-KYC XML with offline verification.
	// Processed locally on-device, only yes/no attestation stored.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	proof := testutil.ZKProof{
		ProofType:   "government_id",
		Proof:       []byte("mock-aadhaar-ekyc-attestation"),
		PublicInput: []byte("attestation-result-yes"),
		Ring:        2,
	}
	valid, err := impl.VerifyProof(proof)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "Phase 1 Aadhaar attestation must verify")
}

// TST-CORE-754
func TestDeferred_24_1_4_Ring2OneIDOneVerifiedDina(t *testing.T) {
	// Attempt second verification with same government ID must be rejected (Sybil prevention).
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	proofHash := []byte("hash-of-government-id-proof-001")

	// First check — should not be duplicate.
	isDuplicate, err := impl.CheckDuplicate(proofHash)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, isDuplicate, "first verification should not be duplicate")

	// After first verification is registered, second attempt should be duplicate.
	// (In real implementation, this would be persisted after first verify.)
}

// TST-CORE-755
func TestDeferred_24_1_5_Ring3SkinInTheGame(t *testing.T) {
	// W3C Verifiable Credentials from LinkedIn, GitHub, business registration
	// add trust weight, revealing only what user chooses.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	proof := testutil.ZKProof{
		ProofType:   "credential",
		Proof:       []byte("mock-verifiable-credential"),
		PublicInput: []byte("linkedin-github-biz-reg"),
		Ring:        3,
	}
	valid, err := impl.VerifyProof(proof)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "Ring 3 verifiable credential proof must verify")
}

// TST-CORE-756
func TestDeferred_24_1_6_TrustScoreFormula(t *testing.T) {
	// Trust score: f(ring_level, time_alive, transaction_anchors, outcome_data,
	// peer_attestations, credential_count) — composite function.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	score, err := impl.ComputeTrustScore("did:key:z6MkTrustTest")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, score)
	testutil.RequireTrue(t, score.RingLevel >= 1 && score.RingLevel <= 3, "ring level must be 1-3")
	testutil.RequireTrue(t, score.Score >= 0, "trust score must be non-negative")
}

// TST-CORE-757
func TestDeferred_24_1_7_TrustLevelAffectsSharingRouting(t *testing.T) {
	// Unverified vs Verified contacts get different default sharing policies.
	var impl testutil.ZKPVerifier
	testutil.RequireImplementation(t, impl, "ZKPVerifier")

	unverifiedRing, err := impl.GetRingLevel("did:key:z6MkUnverified")
	testutil.RequireNoError(t, err)

	verifiedRing, err := impl.GetRingLevel("did:key:z6MkVerified")
	testutil.RequireNoError(t, err)

	testutil.RequireTrue(t, verifiedRing > unverifiedRing,
		"verified contact must have higher ring level than unverified")
}

// --------------------------------------------------------------------------
// §24.2 HSM / Secure Enclave Key Generation (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-758
func TestDeferred_24_2_1_SecureEnclaveIOS(t *testing.T) {
	// iOS device: private key generated inside Secure Enclave, never exported.
	var impl testutil.HSMProvider
	testutil.RequireImplementation(t, impl, "HSMProvider")

	keyInfo, err := impl.GenerateKey()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, keyInfo)
	// On iOS hardware, keyType should be "secure_enclave".
	// On test systems, may fall back to software.
	testutil.RequireTrue(t, keyInfo.KeyType != "", "key type must be set")
	testutil.RequireTrue(t, keyInfo.KeyID != "", "key ID must be set")
	testutil.RequireTrue(t, len(keyInfo.PublicKey) > 0, "public key must be non-empty")
}

// TST-CORE-759
func TestDeferred_24_2_2_StrongBoxAndroid(t *testing.T) {
	// Android device: private key generated inside StrongBox Keymaster.
	var impl testutil.HSMProvider
	testutil.RequireImplementation(t, impl, "HSMProvider")

	keyInfo, err := impl.GenerateKey()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, keyInfo)
	testutil.RequireTrue(t, keyInfo.KeyType != "", "key type must be set")
}

// TST-CORE-760
func TestDeferred_24_2_3_TPMDesktop(t *testing.T) {
	// Desktop/server: private key generated via TPM 2.0.
	var impl testutil.HSMProvider
	testutil.RequireImplementation(t, impl, "HSMProvider")

	keyInfo, err := impl.GenerateKey()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, keyInfo)
	testutil.RequireTrue(t, keyInfo.KeyType != "", "key type must be set")
}

// TST-CORE-761
func TestDeferred_24_2_4_FallbackSoftwareEntropy(t *testing.T) {
	// No HSM available: crypto/rand from OS entropy pool — secure but not hardware-isolated.
	var impl testutil.HSMProvider
	testutil.RequireImplementation(t, impl, "HSMProvider")

	if impl.IsHardwareBacked() {
		t.Skip("HSM is available — this test is for software fallback only")
	}

	keyInfo, err := impl.GenerateKey()
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, keyInfo)
	testutil.RequireEqual(t, keyInfo.KeyType, "software")
	testutil.RequireFalse(t, keyInfo.Hardware, "software fallback must not claim hardware backing")
	testutil.RequireTrue(t, len(keyInfo.PublicKey) > 0, "software key must still produce a public key")
}

// --------------------------------------------------------------------------
// §24.3 Tier 5 Deep Archive (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-762
func TestDeferred_24_3_1_ArchiveEncryptedWithArchiveKey(t *testing.T) {
	// Tier 5 snapshot must be encrypted with AES-256-GCM using HKDF("dina:archive:v1") key.
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "weekly",
		Destination:   "local",
		RetentionDays: 365,
		EncryptionKey: []byte("mock-archive-key-32-bytes-long!!"),
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
	testutil.RequireTrue(t, entry.ID != "", "archive must have an ID")
}

// TST-CORE-763
func TestDeferred_24_3_2_ArchiveContainsCorrectTiers(t *testing.T) {
	// Archive must contain Tier 0 (identity) + Tier 1 (persona vaults) + Tier 3 (trust/preferences).
	// Must NOT contain Tier 2 (index/embeddings — regenerable) or Tier 4 (staging — ephemeral).
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "weekly",
		Destination:   "local",
		RetentionDays: 365,
		EncryptionKey: []byte("mock-archive-key-32-bytes-long!!"),
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)

	tiers, err := impl.GetIncludedTiers(entry.ID)
	testutil.RequireNoError(t, err)

	// Must include tiers 0, 1, 3.
	tierSet := make(map[int]bool)
	for _, tier := range tiers {
		tierSet[tier] = true
	}
	testutil.RequireTrue(t, tierSet[0], "Tier 0 (identity) must be in archive")
	testutil.RequireTrue(t, tierSet[1], "Tier 1 (persona vaults) must be in archive")
	testutil.RequireTrue(t, tierSet[3], "Tier 3 (trust/preferences) must be in archive")
	testutil.RequireFalse(t, tierSet[2], "Tier 2 (index/embeddings) must NOT be in archive")
	testutil.RequireFalse(t, tierSet[4], "Tier 4 (staging) must NOT be in archive")
}

// TST-CORE-764
func TestDeferred_24_3_3_WeeklyFrequencyConfigurable(t *testing.T) {
	// Default weekly, configurable via config.json.
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "daily",
		Destination:   "local",
		RetentionDays: 30,
		EncryptionKey: []byte("mock-archive-key-32-bytes-long!!"),
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
}

// TST-CORE-765
func TestDeferred_24_3_4_S3GlacierComplianceModeLock(t *testing.T) {
	// S3 Glacier with Compliance Mode Object Lock — even root cannot delete during retention.
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "weekly",
		Destination:   "s3",
		RetentionDays: 365,
		EncryptionKey: []byte("mock-archive-key-32-bytes-long!!"),
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, entry.Destination, "s3")
}

// TST-CORE-766
func TestDeferred_24_3_5_SovereignUSBLTOTape(t *testing.T) {
	// Sovereign: push to local drive (USB/LTO tape) — physically unplugged after backup.
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "weekly",
		Destination:   "local",
		RetentionDays: 365,
		EncryptionKey: []byte("mock-archive-key-32-bytes-long!!"),
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, entry.Destination, "local")
}

// TST-CORE-767
func TestDeferred_24_3_6_ArchiveUselessWithoutKeys(t *testing.T) {
	// Attacker obtains archive blob — cannot decrypt without master seed.
	// Uses real AES-256-GCM key wrapping + HKDF key derivation to prove that
	// an encrypted archive payload is useless without the correct key material.

	wrapper := realKeyWrapper
	testutil.RequireImplementation(t, wrapper, "KeyWrapper")
	dekDeriver := realVaultDEKDeriver
	testutil.RequireImplementation(t, dekDeriver, "VaultDEKDeriver")

	// Step 1: Derive an archive-specific DEK from the master seed via HKDF,
	// using the "archive" persona (info = "dina:vault:archive:v1").
	archiveDEK, err := dekDeriver.DeriveVaultDEK(testutil.TestMnemonicSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, archiveDEK, 32)

	// Step 2: Wrap a payload DEK with the archive DEK (simulates archive encryption).
	payloadDEK := testutil.TestDEK[:]
	wrapped, err := wrapper.Wrap(payloadDEK, archiveDEK)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(wrapped) > 0, "wrapped blob must be non-empty")

	// Step 3: Verify the correct key can unwrap.
	recovered, err := wrapper.Unwrap(wrapped, archiveDEK)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered, payloadDEK)

	// Step 4: Attacker has the wrapped blob but uses a wrong key — must fail.
	wrongKey := [32]byte{
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
		0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
	}
	_, err = wrapper.Unwrap(wrapped, wrongKey[:])
	testutil.RequireError(t, err)

	// Step 5: Attacker derives a key from a different seed — must also fail.
	wrongSeed := make([]byte, len(testutil.TestMnemonicSeed))
	copy(wrongSeed, testutil.TestMnemonicSeed)
	wrongSeed[0] ^= 0xff // flip one byte
	wrongArchiveDEK, err := dekDeriver.DeriveVaultDEK(wrongSeed, "archive", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, wrongArchiveDEK, archiveDEK)
	_, err = wrapper.Unwrap(wrapped, wrongArchiveDEK)
	testutil.RequireError(t, err)

	// Step 6: Tampered ciphertext must also fail decryption.
	tampered := make([]byte, len(wrapped))
	copy(tampered, wrapped)
	tampered[len(tampered)-1] ^= 0xff
	_, err = wrapper.Unwrap(tampered, archiveDEK)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §24.4 ZFS/Btrfs File System Snapshots (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-768
func TestDeferred_24_4_1_AutoSnapshotEvery15Minutes(t *testing.T) {
	// ZFS on /var/lib/dina/vault/ — copy-on-write snapshots, instant, near-zero space cost.
	var impl testutil.SnapshotManager
	testutil.RequireImplementation(t, impl, "SnapshotManager")

	snap, err := impl.CreateSnapshot("dina/vault")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, snap)
	testutil.RequireTrue(t, snap.Name != "", "snapshot must have a name")
	testutil.RequireEqual(t, snap.Dataset, "dina/vault")
}

// TST-CORE-769
func TestDeferred_24_4_2_SnapshotRetentionPolicy(t *testing.T) {
	// Retention: 24h of 15-min, 7 days of hourly, 30 days of daily.
	var impl testutil.SnapshotManager
	testutil.RequireImplementation(t, impl, "SnapshotManager")

	pruned, err := impl.ApplyRetention("dina/vault")
	testutil.RequireNoError(t, err)
	_ = pruned // number of pruned snapshots
}

// TST-CORE-770
func TestDeferred_24_4_3_ZFSRollbackRecovery(t *testing.T) {
	// Corruption detected: `zfs rollback dina/vault@15min_ago` — instant revert.
	var impl testutil.SnapshotManager
	testutil.RequireImplementation(t, impl, "SnapshotManager")

	// Create a snapshot first.
	snap, err := impl.CreateSnapshot("dina/vault")
	testutil.RequireNoError(t, err)

	// Rollback to it.
	err = impl.Rollback(snap.Name)
	testutil.RequireNoError(t, err)
}

// TST-CORE-771
func TestDeferred_24_4_4_ManagedHostingPerUserVolumes(t *testing.T) {
	// Managed hosting: /var/lib/dina/users/<did>/vault/ — separate ZFS datasets per user.
	var impl testutil.SnapshotManager
	testutil.RequireImplementation(t, impl, "SnapshotManager")

	// Verify two separate user datasets can have independent snapshots.
	snap1, err := impl.CreateSnapshot("dina/users/did1/vault")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, snap1.Dataset, "dina/users/did1/vault")

	snap2, err := impl.CreateSnapshot("dina/users/did2/vault")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, snap2.Dataset, "dina/users/did2/vault")

	testutil.RequireTrue(t, snap1.Name != snap2.Name, "per-user snapshots must be independent")
}

// --------------------------------------------------------------------------
// §24.5 Client Cache Sync (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-772
func TestDeferred_24_5_1_PhoneRecent6MonthsCached(t *testing.T) {
	// Phone: only last 6 months of data cached, encrypted with Client Sync Key.
	var impl testutil.CacheSyncer
	testutil.RequireImplementation(t, impl, "CacheSyncer")

	config := testutil.CacheConfig{
		DeviceType:    "phone",
		CacheDuration: "6months",
		EncryptionKey: []byte("mock-sync-key-32-bytes-long!!!!"),
	}
	err := impl.ConfigureCache(config)
	testutil.RequireNoError(t, err)

	status, err := impl.GetCacheStatus("device-phone-001")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, status)
	testutil.RequireEqual(t, status.DeviceType, "phone")
	testutil.RequireTrue(t, status.Encrypted, "phone cache must be encrypted")
}

// TST-CORE-773
func TestDeferred_24_5_2_LaptopConfigurableCacheSize(t *testing.T) {
	// Laptop: configurable cache — can be set to "everything" (full vault replica).
	var impl testutil.CacheSyncer
	testutil.RequireImplementation(t, impl, "CacheSyncer")

	config := testutil.CacheConfig{
		DeviceType:    "laptop",
		CacheDuration: "everything",
		EncryptionKey: []byte("mock-sync-key-32-bytes-long!!!!"),
	}
	err := impl.ConfigureCache(config)
	testutil.RequireNoError(t, err)
}

// TST-CORE-774
func TestDeferred_24_5_3_ThinClientNoLocalCache(t *testing.T) {
	// Thin client: zero vault data stored locally — WS msgbox only.
	var impl testutil.CacheSyncer
	testutil.RequireImplementation(t, impl, "CacheSyncer")

	config := testutil.CacheConfig{
		DeviceType:    "thin",
		CacheDuration: "none",
		EncryptionKey: nil, // no key needed — nothing cached
	}
	err := impl.ConfigureCache(config)
	testutil.RequireNoError(t, err)

	status, err := impl.GetCacheStatus("device-thin-001")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, status)
	testutil.RequireEqual(t, status.CachedItems, 0)
}

// TST-CORE-775
func TestDeferred_24_5_4_CacheEncryptedWithSyncKey(t *testing.T) {
	// Cache on device must be encrypted with HKDF("dina:sync:v1") — not raw DEKs.
	var impl testutil.CacheSyncer
	testutil.RequireImplementation(t, impl, "CacheSyncer")

	config := testutil.CacheConfig{
		DeviceType:    "phone",
		CacheDuration: "6months",
		EncryptionKey: []byte("mock-sync-key-32-bytes-long!!!!"),
	}
	err := impl.ConfigureCache(config)
	testutil.RequireNoError(t, err)

	status, err := impl.GetCacheStatus("device-phone-sync-001")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, status)
	testutil.RequireTrue(t, status.Encrypted, "cache must be encrypted")
	testutil.RequireTrue(t, status.SyncKeyUsed, "cache must use Sync Key, not raw DEKs")
}

// TST-CORE-931
func TestDeferred_24_5_5_Tier5DeepArchive_EncryptedSnapshot(t *testing.T) {
	// Tier 5 Deep Archive: encrypted snapshot to cold storage with compliance lock.
	var impl testutil.ArchiveManager
	testutil.RequireImplementation(t, impl, "ArchiveManager")

	config := testutil.ArchiveConfig{
		Frequency:     "weekly",
		Destination:   "s3",
		RetentionDays: 365,
		EncryptionKey: testutil.TestDEK[:],
	}
	entry, err := impl.CreateArchive(config)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, entry.ID != "", "archive must have an ID")
}
