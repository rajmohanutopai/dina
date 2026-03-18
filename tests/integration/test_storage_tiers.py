"""Integration tests for the six-tier encrypted storage system.

Tier 0 — Identity Vault (root keypair, BIP-39 recovery, SLIP-0010 derivation)
Tier 1 — Personal Vault (encrypted, FTS5, per-persona partitions)
Tier 4 — Staging (drafts, payment intents, auto-expire 72h)
Tier 5 — Deep Archive (encrypted snapshots, immutable, right to delete)
"""

from __future__ import annotations

import time

import pytest

from tests.integration.mocks import (
    Draft,
    LLMTarget,
    MockConnector,
    MockDinaCore,
    MockExternalAgent,
    MockGmailConnector,
    MockGoCore,
    MockIdentity,
    MockKeyManager,
    MockLLMRouter,
    MockPIIScrubber,
    MockPersona,
    MockPythonBrain,
    MockScratchpad,
    MockSilenceClassifier,
    MockStagingTier,
    MockVault,
    MockWhisperAssembler,
    Notification,
    PaymentIntent,
    PersonaType,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# TestTier0IdentityVault
# ---------------------------------------------------------------------------

class TestTier0IdentityVault:
    """Tier 0 holds the root keypair, BIP-39 mnemonic, and SLIP-0010 derivation."""

# TST-INT-204
    def test_root_keypair_encrypted_at_rest(
        self, mock_identity: MockIdentity
    ) -> None:
        """The root private key (DEK) must be key-wrapped when stored.

        In production: passphrase → Argon2id (KEK) → AES-256-GCM wraps the
        Master Key (DEK). Here we verify the mock produces a wrapped blob
        that differs from the plaintext key, and that different passphrases
        produce different wrapped outputs.
        """
        km = MockKeyManager(mock_identity)
        wrapped = km.key_wrap(
            mock_identity.root_private_key, passphrase="strong-passphrase"
        )

        assert wrapped.startswith("WRAPPED[")
        assert mock_identity.root_private_key not in wrapped

        # Counter-proof: different passphrase produces different wrapped blob
        wrapped_other = km.key_wrap(
            mock_identity.root_private_key, passphrase="different-passphrase"
        )
        assert wrapped_other.startswith("WRAPPED[")
        assert wrapped_other != wrapped, (
            "Different passphrases must produce different wrapped blobs"
        )

        # Counter-proof: a different identity's key produces different wrap
        other_identity = MockIdentity(did="did:plc:OTHER_KEYPAIR_TEST_001")
        other_km = MockKeyManager(other_identity)
        wrapped_other_id = other_km.key_wrap(
            other_identity.root_private_key, passphrase="strong-passphrase"
        )
        assert wrapped_other_id != wrapped, (
            "Same passphrase on different key must produce different wrap"
        )

# TST-INT-182
    def test_bip39_recovery_mnemonic_exists(
        self, mock_identity: MockIdentity
    ) -> None:
        """A 24-word BIP-39 mnemonic is generated with the identity.

        The mnemonic allows full recovery of every persona key.
        """
        words = mock_identity.bip39_mnemonic.split()
        assert len(words) == 24, "BIP-39 mnemonic must be 24 words"
        assert all(len(w) > 0 for w in words)

        # Derive persona keys from this identity
        km = MockKeyManager(mock_identity)
        consumer_key = km.derive_persona_key(PersonaType.CONSUMER)
        health_key = km.derive_persona_key(PersonaType.HEALTH)

        # Keys are deterministic — re-deriving produces the same result
        consumer_key_2 = km.derive_persona_key(PersonaType.CONSUMER)
        assert consumer_key == consumer_key_2

        # Different personas produce different keys
        assert consumer_key != health_key

        # Counter-proof: a different mnemonic (different identity) produces
        # different keys — the mnemonic actually seeds derivation
        other_identity = MockIdentity(did="did:plc:OTHER_IDENTITY_FOR_BIP39_TEST")
        other_km = MockKeyManager(other_identity)
        other_consumer_key = other_km.derive_persona_key(PersonaType.CONSUMER)
        assert other_consumer_key != consumer_key

# TST-INT-197
    def test_bip32_derivation_produces_child_keys(
        self, mock_identity: MockIdentity
    ) -> None:
        """SLIP-0010 derivation from root produces distinct child keys."""
        consumer_key = MockKeyManager(mock_identity).derive_persona_key(
            PersonaType.CONSUMER
        )
        health_key = MockKeyManager(mock_identity).derive_persona_key(
            PersonaType.HEALTH
        )

        assert consumer_key != health_key
        assert consumer_key != mock_identity.root_private_key
        assert health_key != mock_identity.root_private_key

# TST-INT-207
    def test_cryptographically_unlinkable_personas(
        self, mock_identity: MockIdentity
    ) -> None:
        """External observers cannot link two personas to the same root.

        The derived DIDs share no common prefix beyond the method scheme.
        """
        # Pre-condition: no personas derived yet
        assert len(mock_identity.personas) == 0

        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        # Both are did:key, but the z6Mk... suffix differs
        assert consumer.did.startswith("did:key:z6Mk")
        assert health.did.startswith("did:key:z6Mk")

        # The key-specific portion is completely different
        consumer_suffix = consumer.did.split("z6Mk")[1]
        health_suffix = health.did.split("z6Mk")[1]
        assert consumer_suffix != health_suffix

        # Derived keys must differ entirely
        assert consumer.derived_key != health.derived_key

        # Determinism: re-deriving same persona returns identical DID and key
        consumer_again = mock_identity.derive_persona(PersonaType.CONSUMER)
        assert consumer_again.did == consumer.did
        assert consumer_again.derived_key == consumer.derived_key

        # Counter-proof: different root identity produces different DIDs
        # for the same persona type — no cross-identity linkability
        other_identity = MockIdentity()
        other_consumer = other_identity.derive_persona(PersonaType.CONSUMER)
        assert other_consumer.did != consumer.did
        assert other_consumer.derived_key != consumer.derived_key

# TST-INT-183
    def test_root_key_stored_in_tier_0(
        self, mock_vault: MockVault, mock_identity: MockIdentity
    ) -> None:
        """The root identity material lives exclusively in Tier 0."""
        km = MockKeyManager(mock_identity)
        encrypted_root = km.key_wrap(
            mock_identity.root_private_key, passphrase="vault-pass"
        )

        mock_vault.store(tier=0, key="root_key", value=encrypted_root)

        # Retrievable from Tier 0
        retrieved = mock_vault.retrieve(tier=0, key="root_key")
        assert retrieved == encrypted_root

        # NOT in any other tier
        for tier in range(1, 6):
            assert mock_vault.retrieve(tier=tier, key="root_key") is None

# TST-INT-195
    def test_device_key_derivation(
        self, mock_identity: MockIdentity
    ) -> None:
        """Device keys are derived from the root for delegated access."""
        phone_key = mock_identity.register_device("phone_001")
        laptop_key = mock_identity.register_device("laptop_001")

        assert phone_key != laptop_key
        assert phone_key != mock_identity.root_private_key
        assert "phone_001" in mock_identity.devices
        assert "laptop_001" in mock_identity.devices


# ---------------------------------------------------------------------------
# TestEncryptionVerification — Mandatory CI safety catch
# ---------------------------------------------------------------------------

class TestEncryptionVerification:
    """Mandatory CI test: prove the .sqlite files are actually encrypted.

    A standard SQLite file always begins with the 16-byte magic header:
    ``SQLite format 3\\x00``.  If our "encrypted" vault file starts with
    those bytes, encryption failed silently — the vault is plaintext.

    In production this is a Go test that reads raw file bytes.
    Here we encode the *contract*: MockVault.raw_file_header() must never
    return the SQLite magic header for a vault that contains data.
    """

    SQLITE_MAGIC = b"SQLite format 3\x00"

# TST-INT-190
    def test_encrypted_vault_has_no_sqlite_header(
        self, mock_vault: MockVault, mock_identity: MockIdentity
    ) -> None:
        """After storing data, the raw file header must NOT be the SQLite
        magic string — proving SQLCipher encryption is active."""
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        mock_vault.store(
            tier=1, key="test_item", value=consumer.encrypt("secret data"),
            persona=PersonaType.CONSUMER,
        )

        header = mock_vault.raw_file_header(PersonaType.CONSUMER)

        assert header != self.SQLITE_MAGIC, (
            "CRITICAL SECURITY FAILURE: Database is not encrypted! "
            "Raw SQLite header detected. SQLCipher PRAGMA key likely "
            "failed to activate. Check mutecomm/go-sqlcipher CGO flags."
        )
        assert len(header) == 16

# TST-INT-201
    def test_all_persona_vaults_encrypted(
        self, mock_vault: MockVault, mock_identity: MockIdentity
    ) -> None:
        """Every persona vault must pass the encryption header check."""
        for ptype in [PersonaType.CONSUMER, PersonaType.HEALTH,
                      PersonaType.SOCIAL, PersonaType.FINANCIAL,
                      PersonaType.PROFESSIONAL]:
            persona = mock_identity.derive_persona(ptype)
            mock_vault.store(
                tier=1, key=f"test_{ptype.value}",
                value=persona.encrypt("data"), persona=ptype,
            )
            header = mock_vault.raw_file_header(ptype)
            assert header != self.SQLITE_MAGIC, (
                f"CRITICAL: {ptype.value}.sqlite is not encrypted!"
            )

# TST-INT-189
    def test_empty_vault_would_fail_check(
        self, mock_vault: MockVault
    ) -> None:
        """An uninitialized vault returns the SQLite magic header —
        this is the failure case the CI test is designed to catch."""
        # CITIZEN persona has no data stored — simulates failed encryption
        header = mock_vault.raw_file_header(PersonaType.CITIZEN)
        assert header == self.SQLITE_MAGIC, (
            "Mock should return SQLite magic for empty partitions "
            "to simulate the failure case"
        )


# ---------------------------------------------------------------------------
# TestTier1Vault
# ---------------------------------------------------------------------------

class TestTier1Vault:
    """Tier 1 is the personal vault: encrypted, FTS5, per-persona partition."""

# TST-INT-119
    def test_data_encrypted_with_persona_key(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Data stored in Tier 1 is encrypted with the persona's key.
        The correct persona can decrypt; a different persona cannot."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        plaintext = "blood pressure: 120/80"
        encrypted = health.encrypt(plaintext)

        # Encrypted form does not contain plaintext
        assert plaintext not in encrypted
        assert encrypted.startswith(f"ENC[{health.storage_partition}]:")

        # Correct persona can decrypt
        decrypted = health.decrypt(encrypted)
        assert decrypted == plaintext, (
            "Same persona must decrypt its own encrypted data"
        )

        # Counter-proof: a different persona type CANNOT decrypt
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        cross_decrypt = consumer.decrypt(encrypted)
        assert cross_decrypt is None, (
            "Different persona must NOT decrypt another persona's data"
        )

        # Different persona produces different ciphertext for same plaintext
        consumer_encrypted = consumer.encrypt(plaintext)
        assert consumer_encrypted != encrypted, (
            "Same plaintext under different personas must produce different ciphertext"
        )

        # Store and retrieve the encrypted blob — vault preserves it exactly
        mock_vault.store(
            tier=1, key="bp_reading", value=encrypted,
            persona=PersonaType.HEALTH,
        )
        retrieved = mock_vault.retrieve(
            tier=1, key="bp_reading", persona=PersonaType.HEALTH,
        )
        assert retrieved == encrypted

# TST-INT-188
    def test_fts5_search_returns_matching_keys(
        self, mock_vault: MockVault
    ) -> None:
        """FTS5 full-text search indexes Tier 1 entries by keyword."""
        # Pre-condition: no FTS results before indexing
        assert mock_vault.search_fts("chair") == []

        mock_vault.store(tier=1, key="note_alpha",
                         value={"text": "ergonomic chair review"})
        mock_vault.index_for_fts("note_alpha",
                                  "ergonomic chair review lumbar support")

        mock_vault.store(tier=1, key="note_beta",
                         value={"text": "laptop battery life"})
        mock_vault.index_for_fts("note_beta",
                                  "laptop battery life ThinkPad performance")

        # "chair" matches only note_alpha
        results = mock_vault.search_fts("chair")
        assert "note_alpha" in results
        assert "note_beta" not in results

        # "laptop" matches only note_beta
        results = mock_vault.search_fts("laptop")
        assert "note_beta" in results
        assert "note_alpha" not in results

        # Counter-proof: non-matching query returns empty
        results = mock_vault.search_fts("smartphone")
        assert len(results) == 0

        # Shared keyword matches both
        results = mock_vault.search_fts("review")
        assert "note_alpha" in results  # "ergonomic chair review"
        # note_beta doesn't have "review" in its FTS text
        assert "note_beta" not in results

# TST-INT-217
    def test_fts5_search_case_insensitive(
        self, mock_vault: MockVault
    ) -> None:
        """FTS5 search is case-insensitive."""
        mock_vault.index_for_fts("doc_1", "Herman Miller Aeron")

        assert mock_vault.search_fts("herman") == ["doc_1"]
        assert mock_vault.search_fts("AERON") == ["doc_1"]
        assert mock_vault.search_fts("Miller") == ["doc_1"]

# TST-INT-198
    def test_per_persona_partition_isolation(
        self, mock_vault: MockVault
    ) -> None:
        """Each persona has its own partition; data does not bleed."""
        mock_vault.store(tier=1, key="salary",
                         value={"amount": 200000},
                         persona=PersonaType.FINANCIAL)
        mock_vault.store(tier=1, key="diagnosis",
                         value={"condition": "healthy"},
                         persona=PersonaType.HEALTH)
        mock_vault.store(tier=1, key="hobby",
                         value={"activity": "cycling"},
                         persona=PersonaType.SOCIAL)

        fin_partition = mock_vault.per_persona_partition(PersonaType.FINANCIAL)
        health_partition = mock_vault.per_persona_partition(PersonaType.HEALTH)
        social_partition = mock_vault.per_persona_partition(PersonaType.SOCIAL)

        assert "salary" in fin_partition
        assert "salary" not in health_partition
        assert "salary" not in social_partition

        assert "diagnosis" in health_partition
        assert "diagnosis" not in fin_partition

        assert "hobby" in social_partition
        assert "hobby" not in fin_partition

# TST-INT-211
    def test_partition_returns_copy_not_reference(
        self, mock_vault: MockVault
    ) -> None:
        """per_persona_partition returns a snapshot, not a live reference."""
        mock_vault.store(tier=1, key="item1", value="val1",
                         persona=PersonaType.CONSUMER)

        partition = mock_vault.per_persona_partition(PersonaType.CONSUMER)
        partition["item1"] = "TAMPERED"

        # Original vault data is unchanged
        original = mock_vault.retrieve(tier=1, key="item1",
                                       persona=PersonaType.CONSUMER)
        assert original == "val1"

# TST-INT-187
    def test_multiple_entries_same_persona(
        self, mock_vault: MockVault
    ) -> None:
        """A persona can store many entries in its partition."""
        for i in range(50):
            mock_vault.store(
                tier=1, key=f"entry_{i}", value={"idx": i},
                persona=PersonaType.CONSUMER,
            )

        partition = mock_vault.per_persona_partition(PersonaType.CONSUMER)
        assert len(partition) == 50
        assert partition["entry_0"]["idx"] == 0
        assert partition["entry_49"]["idx"] == 49


# ---------------------------------------------------------------------------
# TestTier4Staging
# ---------------------------------------------------------------------------

class TestTier4Staging:
    """Tier 4 is ephemeral staging: drafts and payment intents, auto-expire."""

# TST-INT-175
    def test_drafts_stored_in_staging(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Email/message drafts are stored and retrievable."""
        draft = Draft(
            draft_id="draft_001",
            to="sancho@email.com",
            subject="Meeting follow-up",
            body="Thanks for the discussion about the project.",
            confidence=0.92,
        )
        stored_id = mock_staging.store_draft(draft)
        assert stored_id == "draft_001"

        retrieved = mock_staging.get("draft_001")
        assert retrieved is not None
        assert retrieved.subject == "Meeting follow-up"
        assert not retrieved.sent

# TST-INT-213
    def test_auto_expire_72h(self, mock_staging: MockStagingTier) -> None:
        """Drafts auto-expire after 72 hours (259200 seconds)."""
        now = time.time()
        draft = Draft(
            draft_id="draft_expire",
            to="test@email.com",
            subject="Expiring draft",
            body="This will expire.",
            confidence=0.5,
            created_at=now,
        )
        mock_staging.store_draft(draft)

        # Verify expiry is set to 72h from creation
        stored = mock_staging.get("draft_expire")
        assert stored is not None
        assert stored.expires_at == pytest.approx(
            now + 72 * 3600, abs=1.0
        )

        # Before expiry: still available
        expired_count = mock_staging.auto_expire(current_time=now + 71 * 3600)
        assert expired_count == 0
        assert mock_staging.get("draft_expire") is not None

        # After 72h: auto-expired
        expired_count = mock_staging.auto_expire(current_time=now + 73 * 3600)
        assert expired_count == 1

# TST-INT-206
    def test_payment_intents_stored(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Payment intents are staged for user review before execution."""
        # Pre-condition: staging is empty
        assert mock_staging.get("pay_001") is None

        intent = PaymentIntent(
            intent_id="pay_001",
            method="upi",
            intent_uri="upi://pay?pa=seller@upi&am=95000",
            merchant="ChairMaker Co.",
            amount=95000.0,
            currency="INR",
            recommendation="Herman Miller Aeron — top rated by experts",
        )
        stored_id = mock_staging.store_payment_intent(intent)
        assert stored_id == "pay_001"

        # Expiry auto-set by staging tier (72h default)
        assert intent.expires_at > intent.created_at

        retrieved = mock_staging.get("pay_001")
        assert retrieved is not None
        assert retrieved.merchant == "ChairMaker Co."
        assert retrieved.amount == 95000.0
        assert retrieved.currency == "INR"
        assert not retrieved.executed

        # Counter-proof: non-existent intent returns None
        assert mock_staging.get("pay_nonexistent") is None

# TST-INT-561
    def test_payment_intent_also_expires(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Payment intents also have 72h expiry for security."""
        now = time.time()
        intent = PaymentIntent(
            intent_id="pay_expire",
            method="crypto",
            intent_uri="ethereum:0xabc...",
            merchant="CryptoShop",
            amount=0.05,
            currency="ETH",
            created_at=now,
        )
        mock_staging.store_payment_intent(intent)

        # Expire it
        expired_count = mock_staging.auto_expire(current_time=now + 73 * 3600)
        assert expired_count == 1

        # Gone after expiry
        assert mock_staging.get("pay_expire") is None

# TST-INT-562
    def test_multiple_items_in_staging(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Multiple drafts and intents coexist in staging."""
        now = time.time()
        for i in range(5):
            mock_staging.store_draft(Draft(
                draft_id=f"d_{i}", to="a@b.com", subject=f"Sub {i}",
                body="body", confidence=0.8, created_at=now,
            ))
        for i in range(3):
            mock_staging.store_payment_intent(PaymentIntent(
                intent_id=f"p_{i}", method="upi", intent_uri="upi://",
                merchant=f"M{i}", amount=float(i * 1000),
                currency="INR", created_at=now,
            ))

        # All retrievable
        for i in range(5):
            assert mock_staging.get(f"d_{i}") is not None
        for i in range(3):
            assert mock_staging.get(f"p_{i}") is not None

        # Expire all
        expired = mock_staging.auto_expire(current_time=now + 73 * 3600)
        assert expired == 8

# TST-INT-563
    def test_staging_get_returns_none_for_missing(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Requesting a non-existent item returns None gracefully."""
        assert mock_staging.get("does_not_exist") is None


# ---------------------------------------------------------------------------
# TestTier5DeepArchive
# ---------------------------------------------------------------------------

class TestTier5DeepArchive:
    """Tier 5 is deep archive: encrypted, immutable, but deletable."""

# TST-INT-216
    def test_encrypted_snapshots(self, mock_vault: MockVault) -> None:
        """Vault snapshots are created for archival purposes."""
        # Pre-condition: empty vault snapshot has tiers but no data in tier 1
        empty_snap = mock_vault.snapshot()
        assert "tiers" in empty_snap
        assert "timestamp" in empty_snap
        assert len(empty_snap["tiers"].get(1, {})) == 0

        # Populate some data
        mock_vault.store(tier=1, key="note1", value="hello")
        mock_vault.store(tier=1, key="note2", value="world")
        mock_vault.store(tier=5, key="archive1", value="deep")

        snapshot = mock_vault.snapshot()

        assert "tiers" in snapshot
        assert "timestamp" in snapshot
        assert snapshot["timestamp"] > 0

        # Snapshot contains the data from multiple tiers
        assert "note1" in snapshot["tiers"][1]
        assert snapshot["tiers"][1]["note1"] == "hello"
        assert snapshot["tiers"][1]["note2"] == "world"
        assert snapshot["tiers"][5]["archive1"] == "deep"

        # Counter-proof: tier with no data is empty in snapshot
        assert len(snapshot["tiers"].get(2, {})) == 0

# TST-INT-209
    def test_immutable_archive(self, mock_vault: MockVault) -> None:
        """Archived data in Tier 5 is stored and cannot be accidentally
        overwritten by a Tier 1 store.
        """
        # Pre-condition: archive key does not exist in any tier
        assert mock_vault.retrieve(tier=5, key="archive_2025") is None
        assert mock_vault.retrieve(tier=1, key="archive_2025") is None

        # Store in archive
        mock_vault.store(tier=5, key="archive_2025",
                         value={"year": 2025, "records": 1200})

        # Verify archive stored correctly
        from tests.integration.conftest import as_dict
        archived = mock_vault.retrieve(tier=5, key="archive_2025")
        archived = as_dict(archived)
        assert archived["records"] == 1200

        # Store same key in Tier 1 — must NOT affect Tier 5
        mock_vault.store(tier=1, key="archive_2025",
                         value={"year": 2025, "records": 0})

        # Tier 5 is untouched after Tier 1 write
        archived_after = as_dict(mock_vault.retrieve(tier=5, key="archive_2025"))
        assert archived_after["records"] == 1200

        # Tier 1 has its own copy
        tier1_copy = as_dict(mock_vault.retrieve(tier=1, key="archive_2025"))
        assert tier1_copy["records"] == 0

        # Counter-proof: deleting Tier 1 copy does not affect Tier 5
        deleted = mock_vault.delete(tier=1, key="archive_2025")
        assert deleted is True
        assert mock_vault.retrieve(tier=1, key="archive_2025") is None
        assert as_dict(mock_vault.retrieve(tier=5, key="archive_2025"))["records"] == 1200

# TST-INT-123
    def test_right_to_delete_still_works(
        self, mock_vault: MockVault
    ) -> None:
        """Even archived data can be permanently deleted (GDPR right to
        erasure). Signed tombstones make deletion auditable.
        """
        mock_vault.store(tier=5, key="personal_history",
                         value={"data": "sensitive archive"})

        # Confirm it exists
        assert mock_vault.retrieve(tier=5, key="personal_history") is not None

        # Exercise right to delete
        deleted = mock_vault.delete(tier=5, key="personal_history")
        assert deleted is True

        # Truly gone
        assert mock_vault.retrieve(tier=5, key="personal_history") is None

# TST-INT-178
    def test_delete_nonexistent_returns_false(
        self, mock_vault: MockVault
    ) -> None:
        """Deleting a key that does not exist returns False."""
        result = mock_vault.delete(tier=5, key="ghost_key")
        assert result is False

# TST-INT-208
    def test_delete_removes_from_all_partitions_and_fts(
        self, mock_vault: MockVault
    ) -> None:
        """Deletion also removes from persona partitions and FTS index."""
        mock_vault.store(tier=1, key="secret",
                         value="classified",
                         persona=PersonaType.HEALTH)
        mock_vault.index_for_fts("secret", "classified health data")

        # Before delete: searchable
        assert mock_vault.search_fts("classified") == ["secret"]

        # Delete
        mock_vault.delete(tier=1, key="secret")

        # After delete: gone from FTS and partition
        assert mock_vault.search_fts("classified") == []
        assert mock_vault.retrieve(tier=1, key="secret",
                                   persona=PersonaType.HEALTH) is None

# TST-INT-184
    def test_snapshot_is_point_in_time(self, mock_vault: MockVault) -> None:
        """A snapshot captures the vault state at the moment it is taken.

        We deep-copy the snapshot to simulate what a real archive would
        do (serialize to encrypted blob). Subsequent mutations to the
        live vault must not appear in the frozen copy.
        """
        import copy

        mock_vault.store(tier=1, key="before_snap", value="exists")
        raw_snapshot = mock_vault.snapshot()
        # Deep-copy simulates serialization to encrypted archive blob
        snapshot = copy.deepcopy(raw_snapshot)

        # Mutate the vault after snapshot
        mock_vault.store(tier=1, key="after_snap", value="new")
        mock_vault.delete(tier=1, key="before_snap")

        # Snapshot is frozen
        assert "before_snap" in snapshot["tiers"][1]
        assert "after_snap" not in snapshot["tiers"][1]

# TST-INT-125
    def test_archive_with_persona_encryption(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Archived data is stored under the persona's encryption."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        encrypted = health.encrypt("annual checkup 2025 results")

        mock_vault.store(tier=5, key="checkup_2025", value=encrypted,
                         persona=PersonaType.HEALTH)

        retrieved = mock_vault.retrieve(tier=5, key="checkup_2025",
                                        persona=PersonaType.HEALTH)
        assert retrieved == encrypted

        # Only the health persona can decrypt
        assert health.decrypt(retrieved) == "annual checkup 2025 results"

        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        assert consumer.decrypt(retrieved) is None


# ---------------------------------------------------------------------------
# SQLite Concurrent Access (Issue #7)
# ---------------------------------------------------------------------------


class TestSQLiteConcurrentAccess:
    """Single-writer / read-pool pattern and batch ingestion.

    dina-core is a concurrent Go server. WAL allows concurrent reads but
    only one writer at a time. Without proper connection management, writes
    back up during heavy ingestion and brain queries time out.

    Contract:
    - busy_timeout = 5000 (wait, don't fail immediately)
    - Single write connection (serialized), unlimited read connections
    - Batch ingestion: 100 items per transaction, one brain notification per batch
    """

    # --- PRAGMA contract ---

# TST-INT-202
    def test_wal_mode_configured(self, mock_vault: MockVault) -> None:
        """Vault must use WAL journal mode for concurrent read access."""
        assert mock_vault.PRAGMAS["journal_mode"] == "WAL"

# TST-INT-564
    def test_busy_timeout_configured(self, mock_vault: MockVault) -> None:
        """busy_timeout must be set to avoid immediate SQLITE_BUSY errors."""
        assert mock_vault.PRAGMAS["busy_timeout"] == 5000

# TST-INT-122
    def test_synchronous_normal(self, mock_vault: MockVault) -> None:
        """synchronous=NORMAL is safe in WAL mode and faster than FULL."""
        assert mock_vault.PRAGMAS["synchronous"] == "NORMAL"

# TST-INT-203
    def test_foreign_keys_on(self, mock_vault: MockVault) -> None:
        """Foreign keys must be enforced to prevent orphaned data."""
        assert mock_vault.PRAGMAS["foreign_keys"] == "ON"

    # --- Single-writer pattern ---

# TST-INT-210
    def test_single_write_increments_tx_count(self, mock_vault: MockVault) -> None:
        """Each individual store() is one transaction."""
        mock_vault.store(1, "key_a", "val_a")
        mock_vault.store(1, "key_b", "val_b")
        assert mock_vault._write_count == 2
        assert mock_vault._tx_count == 2

# TST-INT-199
    def test_reads_never_blocked_by_writes(self, mock_vault: MockVault) -> None:
        """Reads use the read pool and succeed even during writes.

        In production: read connections have PRAGMA query_only=ON.
        In mock: retrieve() never touches the write path.
        """
        # Pre-condition: vault is empty
        assert mock_vault.retrieve(1, "concurrent_key") is None

        mock_vault.store(1, "concurrent_key", "concurrent_val")
        # Read immediately after write — should always succeed
        assert mock_vault.retrieve(1, "concurrent_key") == "concurrent_val"

        # FTS read also succeeds immediately after indexing
        mock_vault.index_for_fts("concurrent_key", "concurrent test")
        assert "concurrent_key" in mock_vault.search_fts("concurrent")

        # Multiple writes followed by reads — all reads succeed
        for i in range(10):
            mock_vault.store(1, f"rw_key_{i}", f"rw_val_{i}")
        for i in range(10):
            assert mock_vault.retrieve(1, f"rw_key_{i}") == f"rw_val_{i}", \
                f"Read of rw_key_{i} must succeed after batch writes"

        # Counter-proof: reading a non-existent key returns None (not blocked)
        assert mock_vault.retrieve(1, "nonexistent_key") is None

        # Counter-proof: FTS search for non-indexed term returns empty
        assert len(mock_vault.search_fts("zzz_never_indexed")) == 0

        # Counter-proof: writes to different tiers don't interfere with reads
        mock_vault.store(2, "tier2_key", "tier2_val")
        assert mock_vault.retrieve(1, "concurrent_key") == "concurrent_val", \
            "Write to tier 2 must not affect reads from tier 1"

    # --- Batch ingestion ---

# TST-INT-565
    def test_batch_store_one_transaction(self, mock_vault: MockVault) -> None:
        """store_batch() writes N items in a single transaction."""
        items = [(f"batch_{i}", {"data": i}) for i in range(50)]
        written = mock_vault.store_batch(1, items, persona=PersonaType.CONSUMER)

        assert written == 50
        assert mock_vault._write_count == 50  # 50 individual writes
        assert mock_vault._tx_count == 1      # but only 1 transaction

# TST-INT-124
    def test_batch_store_emits_notification(self, mock_vault: MockVault) -> None:
        """Each batch emits one brain notification (not one per item)."""
        items = [(f"notif_{i}", {"data": i}) for i in range(100)]
        mock_vault.store_batch(1, items, persona=PersonaType.PROFESSIONAL)

        assert len(mock_vault._batch_notifications) == 1
        notif = mock_vault._batch_notifications[0]
        assert notif["count"] == 100
        assert notif["persona"] == PersonaType.PROFESSIONAL

# TST-INT-566
    def test_batch_data_readable_after_commit(self, mock_vault: MockVault) -> None:
        """All items in a batch are readable after the batch commits."""
        items = [(f"read_{i}", f"value_{i}") for i in range(10)]
        mock_vault.store_batch(1, items, persona=PersonaType.SOCIAL)

        for i in range(10):
            assert mock_vault.retrieve(1, f"read_{i}") == f"value_{i}"
            assert mock_vault.retrieve(
                1, f"read_{i}", persona=PersonaType.SOCIAL
            ) == f"value_{i}"

# TST-INT-567
    def test_batch_size_is_100(self, mock_vault: MockVault) -> None:
        """Default batch size for ingestion is 100 items."""
        assert mock_vault.BATCH_SIZE == 100

    # --- Connector batch ingestion ---

# TST-INT-218
    def test_connector_batch_ingest_uses_batches(
        self, mock_vault: MockVault
    ) -> None:
        """Connector.batch_ingest() splits items into vault batch_size chunks."""
        connector = MockGmailConnector()
        # Simulate 250 emails — should produce 3 batches (100 + 100 + 50)
        items = [
            {"id": f"email_{i}", "content": f"Email body {i}"}
            for i in range(250)
        ]
        total = connector.batch_ingest(items, mock_vault)

        assert total == 250
        assert connector.items_ingested == 250
        # 3 batch transactions (100 + 100 + 50)
        assert mock_vault._tx_count == 3
        # 3 brain notifications (one per batch)
        assert len(mock_vault._batch_notifications) == 3
        assert mock_vault._batch_notifications[0]["count"] == 100
        assert mock_vault._batch_notifications[1]["count"] == 100
        assert mock_vault._batch_notifications[2]["count"] == 50

# TST-INT-568
    def test_connector_batch_ingest_small_set(
        self, mock_vault: MockVault
    ) -> None:
        """A small set of items (< batch_size) is still one transaction."""
        # Pre-condition: vault is empty
        assert mock_vault._tx_count == 0
        assert mock_vault._write_count == 0

        connector = MockGmailConnector()
        items = [
            {"id": f"small_{i}", "content": f"Content {i}"}
            for i in range(5)
        ]
        total = connector.batch_ingest(items, mock_vault)

        assert total == 5
        # 5 items < BATCH_SIZE (100) → exactly 1 transaction
        assert mock_vault._tx_count == 1
        assert mock_vault._write_count == 5
        assert len(mock_vault._batch_notifications) == 1
        # Notification reports the correct item count
        assert mock_vault._batch_notifications[0]["count"] == 5

        # Verify data actually stored and retrievable
        stored = mock_vault.retrieve(1, "small_0")
        assert stored is not None

# TST-INT-569
    @pytest.mark.slow
    def test_initial_gmail_sync_transaction_count(
        self, mock_vault: MockVault
    ) -> None:
        """10,000 email initial sync produces ~100 transactions, not 10,000."""
        connector = MockGmailConnector()
        items = [
            {"id": f"gmail_{i}", "content": f"Email {i}"}
            for i in range(10_000)
        ]
        connector.batch_ingest(items, mock_vault)

        # 10,000 / 100 = exactly 100 batch transactions
        assert mock_vault._tx_count == 100
        assert mock_vault._write_count == 10_000
        # 100 brain notifications instead of 10,000
        assert len(mock_vault._batch_notifications) == 100


# ---------------------------------------------------------------------------
# TestDataFlowBoundaries — §10 Data Flow
# ---------------------------------------------------------------------------

class TestDataFlowBoundaries:
    """Data flows between Brain, Core, and clients follow strict boundaries."""

# TST-INT-264
    def test_ingestion_brain_mcp_core(
        self,
        mock_go_core: MockGoCore,
        mock_brain: MockPythonBrain,
        mock_vault: MockVault,
    ) -> None:
        """Data flows from Brain through MCP protocol to Core vault.
        Brain processes data and uses Core API to store — never writes
        directly to SQLite."""
        # Brain receives raw data and processes it
        raw_data = {"type": "email", "content": "Q4 planning meeting notes"}
        processed = mock_brain.process(raw_data)
        assert processed["processed"] is True

        # Brain stores via Core API (MCP protocol), not directly to vault
        mock_go_core.vault_store(
            key="email_q4_planning",
            value=raw_data["content"],
            tier=1,
            persona=PersonaType.PROFESSIONAL,
        )

        # Core API call was logged
        store_calls = [
            c for c in mock_go_core.api_calls
            if c["endpoint"] == "/v1/vault/store"
        ]
        assert len(store_calls) >= 1

        # Data is now in vault (via Core, not direct write)
        stored = mock_vault.retrieve(1, "email_q4_planning",
                                      persona=PersonaType.PROFESSIONAL)
        assert stored == raw_data["content"]

# TST-INT-269
    @pytest.mark.slow
    def test_batch_ingestion_5000_email_initial_sync(
        self, mock_vault: MockVault
    ) -> None:
        """Large batch (5000-email initial sync) stored correctly in vault.
        Uses batch transactions for efficiency."""
        # Pre-condition: vault is empty
        assert mock_vault._tx_count == 0
        assert mock_vault._write_count == 0

        connector = MockGmailConnector()
        items = [
            {"id": f"init_{i}", "content": f"Initial sync email {i}"}
            for i in range(5000)
        ]
        total = connector.batch_ingest(items, mock_vault)

        assert total == 5000
        assert mock_vault._write_count == 5000
        # 5000 / 100 = 50 batch transactions (not 5000 individual writes)
        assert mock_vault._tx_count == 50
        assert len(mock_vault._batch_notifications) == 50

        # Verify notification counts sum to total
        notif_sum = sum(n["count"] for n in mock_vault._batch_notifications)
        assert notif_sum == 5000

        # Boundary items are retrievable
        assert mock_vault.retrieve(1, "init_0") is not None
        assert mock_vault.retrieve(1, "init_4999") is not None
        # Mid-point spot check
        mid = mock_vault.retrieve(1, "init_2500")
        assert mid is not None

        # Counter-proof: item beyond range doesn't exist
        assert mock_vault.retrieve(1, "init_5000") is None

# TST-INT-270
    def test_batch_ingestion_concurrent_reads_unblocked(
        self, mock_vault: MockVault
    ) -> None:
        """Reads work while a batch write is in progress. The WAL
        single-writer / read-pool pattern ensures concurrent reads
        are never blocked by writes."""
        # Pre-populate some data
        mock_vault.store(1, "existing_1", "pre-existing data")
        mock_vault.index_for_fts("existing_1", "pre-existing data search")

        # Batch write in progress (simulated — in mock, all synchronous)
        batch_items = [(f"batch_{i}", f"batch_value_{i}") for i in range(200)]
        mock_vault.store_batch(1, batch_items, persona=PersonaType.PROFESSIONAL)

        # Reads against pre-existing data still succeed during/after batch
        assert mock_vault.retrieve(1, "existing_1") == "pre-existing data"
        assert "existing_1" in mock_vault.search_fts("pre-existing")

        # Reads against batch data also succeed after commit
        assert mock_vault.retrieve(1, "batch_0") == "batch_value_0"
        assert mock_vault.retrieve(1, "batch_199") == "batch_value_199"


# ---------------------------------------------------------------------------
# TestStagingAreaLifecycle — §10 Staging
# ---------------------------------------------------------------------------

class TestStagingAreaLifecycle:
    """Staging area (Tier 4) manages drafts through their lifecycle."""

# TST-INT-271
    def test_draft_lifecycle_create_review_promote_discard(
        self, mock_staging: MockStagingTier, mock_vault: MockVault
    ) -> None:
        """Draft created -> reviewed -> promoted (sent) or discarded.
        A draft lives in staging until the user acts on it."""
        now = time.time()

        # Pre-condition: staging and vault are empty
        assert mock_staging.get("lifecycle_001") is None
        assert len(mock_vault._tiers.get(1, {})) == 0

        # Create a draft
        draft = Draft(
            draft_id="lifecycle_001",
            to="colleague@work.com",
            subject="Project update",
            body="Here is the latest progress report.",
            confidence=0.88,
            created_at=now,
        )
        draft_id = mock_staging.store_draft(draft)
        assert draft_id == "lifecycle_001"

        # Draft exists in staging
        retrieved = mock_staging.get("lifecycle_001")
        assert retrieved is not None
        assert not retrieved.sent
        # Verify draft content survived staging
        assert retrieved.to == "colleague@work.com"
        assert retrieved.subject == "Project update"
        assert retrieved.body == "Here is the latest progress report."

        # Expiry was auto-set (72 hours from creation)
        assert retrieved.expires_at > 0
        assert retrieved.expires_at == now + 72 * 3600

        # Promote: store to vault, then mark sent
        mock_vault.store(1, "sent_lifecycle_001", {
            "to": retrieved.to,
            "subject": retrieved.subject,
            "body": retrieved.body,
        })
        retrieved.sent = True
        promoted = mock_vault.retrieve(1, "sent_lifecycle_001")
        assert promoted is not None
        from tests.integration.conftest import as_dict
        promoted = as_dict(promoted)
        assert promoted["to"] == "colleague@work.com"

        # Create another draft and let it expire (discard path)
        discard_draft = Draft(
            draft_id="lifecycle_002",
            to="nobody@example.com",
            subject="Bad idea",
            body="Never mind.",
            confidence=0.3,
            created_at=now,
        )
        mock_staging.store_draft(discard_draft)
        assert mock_staging.get("lifecycle_002") is not None

        # Counter-proof: before 72 hours, nothing expires
        expired_early = mock_staging.auto_expire(current_time=now + 71 * 3600)
        assert expired_early == 0, \
            "Drafts must NOT expire before 72 hours"
        assert mock_staging.get("lifecycle_002") is not None

        # After 73 hours, both drafts expire from staging
        expired = mock_staging.auto_expire(current_time=now + 73 * 3600)
        assert expired >= 1
        assert mock_staging.get("lifecycle_002") is None, \
            "Discarded draft must be gone after expiry"

        # Counter-proof: promoted data survives in vault even after staging expires
        assert mock_vault.retrieve(1, "sent_lifecycle_001") is not None, \
            "Promoted draft must persist in vault after staging cleanup"

# TST-INT-272
    def test_staging_area_72_hour_expiry(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Unreviewed drafts expire after 72 hours (259200 seconds).
        Expired drafts are automatically cleaned up."""
        now = time.time()

        for i in range(5):
            draft = Draft(
                draft_id=f"exp_draft_{i}",
                to="test@example.com",
                subject=f"Draft {i}",
                body="Auto-expire test",
                confidence=0.5,
                created_at=now,
            )
            mock_staging.store_draft(draft)

        # All drafts exist at creation time
        for i in range(5):
            assert mock_staging.get(f"exp_draft_{i}") is not None

        # At 71 hours — nothing expired
        expired = mock_staging.auto_expire(current_time=now + 71 * 3600)
        assert expired == 0

        # At 73 hours — all expired
        expired = mock_staging.auto_expire(current_time=now + 73 * 3600)
        assert expired == 5

        # All gone
        for i in range(5):
            assert mock_staging.get(f"exp_draft_{i}") is None


# ---------------------------------------------------------------------------
# TestEmbeddingAndSearch — §10 Search
# ---------------------------------------------------------------------------

class TestEmbeddingAndSearch:
    """Embedding, FTS, and multi-step search patterns."""

# TST-INT-273
    def test_embedding_via_local_llama(
        self,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Text embedding uses local LLM (llama-server) for vector search.
        In offline mode, embed tasks route to LOCAL."""
        target = mock_llm_router.route("embed", persona=PersonaType.CONSUMER)
        assert target == LLMTarget.LOCAL

        # Sensitive personas also stay local for embedding
        target_health = mock_llm_router.route(
            "embed", persona=PersonaType.HEALTH
        )
        assert target_health == LLMTarget.LOCAL

        # Routing is logged
        embed_entries = [
            e for e in mock_llm_router.routing_log
            if e["task_type"] == "embed"
        ]
        assert len(embed_entries) == 2

# TST-INT-278
    def test_fts5_available_during_reindexing(
        self, mock_vault: MockVault
    ) -> None:
        """FTS remains queryable while the index rebuilds. Old results
        still return; new items appear once re-indexing catches up."""
        # Populate initial FTS index
        for i in range(100):
            key = f"doc_{i}"
            mock_vault.store(1, key, {"text": f"Document about topic_{i}"})
            mock_vault.index_for_fts(key, f"topic_{i} document content")

        # FTS works before re-indexing
        results_before = mock_vault.search_fts("topic_50")
        assert "doc_50" in results_before

        # Simulate re-indexing by adding new documents
        for i in range(100, 150):
            key = f"doc_{i}"
            mock_vault.store(1, key, {"text": f"New document topic_{i}"})
            mock_vault.index_for_fts(key, f"topic_{i} new document")

        # Old results still available during re-index
        results_during = mock_vault.search_fts("topic_50")
        assert "doc_50" in results_during

        # New results also available after re-index completes
        results_new = mock_vault.search_fts("topic_120")
        assert "doc_120" in results_new

# TST-INT-279
    @pytest.mark.slow
    def test_reindex_scale_100k_items(
        self, mock_vault: MockVault
    ) -> None:
        """Re-indexing handles a vault with 100K+ items. The FTS index
        supports large-scale search without degradation."""
        # Store 100K items
        batch_items = [
            (f"scale_{i}", {"data": f"content_{i}"})
            for i in range(100_000)
        ]
        # Use batch store for efficiency
        batch_size = mock_vault.BATCH_SIZE
        for start in range(0, len(batch_items), batch_size):
            chunk = batch_items[start:start + batch_size]
            mock_vault.store_batch(1, chunk)

        assert mock_vault._write_count == 100_000

        # Index a subset for FTS (simulating re-index)
        for i in range(0, 1000):
            mock_vault.index_for_fts(f"scale_{i}", f"content_{i} keyword")

        # FTS still works at scale
        results = mock_vault.search_fts("content_500")
        assert "scale_500" in results

# TST-INT-283
    def test_agentic_multi_step_search(
        self,
        mock_vault: MockVault,
        mock_brain: MockPythonBrain,
        mock_go_core: MockGoCore,
    ) -> None:
        """Multi-step search: FTS narrowing -> vector similarity -> Brain
        reasoning. Each step refines results from the previous step."""
        # Populate vault with diverse data
        mock_vault.store(1, "laptop_review_1",
                         {"product": "ThinkPad", "rating": 92})
        mock_vault.index_for_fts("laptop_review_1",
                                  "ThinkPad laptop review battery keyboard")
        mock_vault.store(1, "laptop_review_2",
                         {"product": "MacBook", "rating": 88})
        mock_vault.index_for_fts("laptop_review_2",
                                  "MacBook laptop review display screen")
        mock_vault.store(1, "chair_review_1",
                         {"product": "Aeron", "rating": 91})
        mock_vault.index_for_fts("chair_review_1",
                                  "Aeron chair ergonomic lumbar")

        # Step 1: FTS narrowing — "laptop" query
        fts_results = mock_go_core.vault_query("laptop")
        assert "laptop_review_1" in fts_results
        assert "laptop_review_2" in fts_results
        assert "chair_review_1" not in fts_results

        # Step 2: Brain reasoning — pick the best from FTS results
        context = {
            "fts_results": fts_results,
            "candidates": [
                mock_vault.retrieve(1, key) for key in fts_results
            ],
        }
        answer = mock_brain.reason(
            "Which laptop has the best battery life?",
            context=context,
        )
        assert answer is not None
        assert "Reasoned answer" in answer

# TST-INT-284
    def test_fast_path_vs_brain_path_routing(
        self,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Simple queries use FTS directly (fast path, no LLM).
        Complex queries go through Brain reasoning (brain path)."""
        # Fast path: FTS search — no LLM needed
        fts_target = mock_llm_router.route("fts_search")
        assert fts_target == LLMTarget.NONE

        # Fast path: exact match lookup — no LLM needed
        exact_target = mock_llm_router.route("exact_match")
        assert exact_target == LLMTarget.NONE

        # Brain path: complex reasoning — needs LLM
        complex_target = mock_llm_router.route("complex_reasoning")
        assert complex_target == LLMTarget.CLOUD

        # Brain path: multi-step analysis — needs LLM
        multi_step_target = mock_llm_router.route("multi_step_analysis")
        assert multi_step_target == LLMTarget.CLOUD


# ---------------------------------------------------------------------------
# TestComponentBoundaries — §10 Separation of Concerns
# ---------------------------------------------------------------------------

class TestComponentBoundaries:
    """Strict boundaries: Brain never touches SQLite, Core never calls
    external APIs, Brain never talks to clients directly."""

# TST-INT-285
    def test_brain_never_opens_sqlite(
        self,
        mock_brain: MockPythonBrain,
        mock_go_core: MockGoCore,
        mock_vault: MockVault,
    ) -> None:
        """Brain accesses vault only through Core API, never directly.
        All Brain storage operations go through Core's /v1/vault/* endpoints."""
        # Brain processes data
        mock_brain.process({"type": "email", "content": "test data"})

        # Brain needs data — it asks Core, not the vault directly
        mock_go_core.vault_store("brain_data_1", "processed result", tier=1)
        results = mock_go_core.vault_query("processed")

        # All access went through Core's API
        vault_calls = [
            c for c in mock_go_core.api_calls
            if "/v1/vault/" in c["endpoint"]
        ]
        assert len(vault_calls) >= 2  # at least store + query

        # Brain has no direct reference to vault internals
        # (In production, Brain has no SQLite connection string)
        assert not hasattr(mock_brain, "_vault")
        assert not hasattr(mock_brain, "vault")

# TST-INT-287
    def test_core_never_calls_external_apis(
        self,
        mock_go_core: MockGoCore,
    ) -> None:
        """Core is pure local — no external HTTP calls. All its API
        endpoints are internal vault/identity/PII operations."""
        # Core performs various operations
        mock_go_core.vault_store("key_1", "value_1", tier=1)
        mock_go_core.vault_query("value")
        mock_go_core.did_sign(b"test data")
        mock_go_core.pii_scrub("Rajmohan is here")

        # Every API call is an internal endpoint (no external URLs)
        for call in mock_go_core.api_calls:
            endpoint = call["endpoint"]
            assert endpoint.startswith("/v1/"), (
                f"Core endpoint must be internal /v1/*, got: {endpoint}"
            )
            assert "http://" not in endpoint
            assert "https://" not in endpoint

# TST-INT-288
    def test_brain_never_talks_to_clients_directly(
        self,
        mock_brain: MockPythonBrain,
        mock_go_core: MockGoCore,
    ) -> None:
        """All client communication goes through Core. Brain sends
        results to Core, which forwards to clients via WebSocket."""
        # Pre-condition: no API calls or notifications yet
        assert len(mock_go_core.api_calls) == 0
        assert len(mock_go_core._notifications_sent) == 0

        # Brain has no client connection or device reference
        assert not hasattr(mock_brain, "client")
        assert not hasattr(mock_brain, "device")
        assert not hasattr(mock_brain, "websocket")

        # Brain generates a notification
        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="New email summary",
            body="You have 3 new emails about the project.",
        )

        # Brain sends via Core's notify endpoint — never directly to client
        mock_go_core.notify(notification)

        # Core received and forwarded the notification
        notify_calls = [
            c for c in mock_go_core.api_calls
            if c["endpoint"] == "/v1/notify"
        ]
        assert len(notify_calls) == 1
        assert mock_go_core._notifications_sent[-1] is notification

        # Verify the notification content survived the Core relay
        sent = mock_go_core._notifications_sent[-1]
        assert sent.title == "New email summary"
        assert sent.tier == SilenceTier.TIER_2_SOLICITED

# TST-INT-289
    def test_llama_is_stateless(
        self,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """LLM container (llama-server) holds no state. It can be
        replaced freely — all state lives in Core's vault."""
        # Route multiple requests through LLM
        mock_llm_router.route("summarize", PersonaType.CONSUMER)
        mock_llm_router.route("draft", PersonaType.PROFESSIONAL)
        mock_llm_router.route("classify", PersonaType.SOCIAL)

        # LLM router has a log but no persistent state
        assert len(mock_llm_router.routing_log) == 3

        # Create a "replacement" LLM router (simulating container restart)
        replacement = MockLLMRouter(profile=mock_llm_router.profile)

        # Replacement starts fresh — no state carried over
        assert len(replacement.routing_log) == 0

        # Replacement routes identically (same config, stateless)
        target_1 = mock_llm_router.route("summarize", PersonaType.CONSUMER)
        target_2 = replacement.route("summarize", PersonaType.CONSUMER)
        assert target_1 == target_2

# TST-INT-295
    def test_reminder_loop_missed_reminder_on_reboot(
        self,
        mock_vault: MockVault,
        mock_go_core: MockGoCore,
        mock_scratchpad: MockScratchpad,
    ) -> None:
        """After reboot, missed reminders are detected and delivered.
        Reminders are stored in the vault with their scheduled time.
        On startup, any past-due reminders are immediately surfaced."""
        now = time.time()

        # Pre-condition: no notifications sent yet
        notifications_before = len(mock_go_core._notifications_sent)

        # Schedule a reminder before "shutdown"
        reminder = {
            "type": "reminder",
            "title": "Driver's license expires",
            "scheduled_at": now - 3600,  # was due 1 hour ago
            "delivered": False,
        }
        mock_vault.store(1, "reminder_license", reminder)
        mock_vault.index_for_fts("reminder_license",
                                  "driver license expires reminder")

        # Also store a future reminder that should NOT be delivered
        future_reminder = {
            "type": "reminder",
            "title": "Annual checkup",
            "scheduled_at": now + 86400,  # due tomorrow
            "delivered": False,
        }
        mock_vault.store(1, "reminder_future", future_reminder)

        # Save checkpoint for the reminder task
        mock_scratchpad.save("reminder_loop", step=1, context={
            "last_check": now - 7200,  # last checked 2 hours ago
        })

        # --- Simulate reboot ---

        # On startup, load checkpoint
        checkpoint = mock_scratchpad.load("reminder_loop")
        assert checkpoint is not None
        last_check = checkpoint["context"]["last_check"]

        # Find all reminders that were due since last check
        from tests.integration.conftest import as_dict as _as_dict
        stored_reminder = mock_vault.retrieve(1, "reminder_license")
        assert stored_reminder is not None
        stored_reminder = _as_dict(stored_reminder)
        assert stored_reminder["scheduled_at"] > last_check  # due after last check
        assert stored_reminder["scheduled_at"] < now  # past due
        assert stored_reminder["delivered"] is False

        # Counter-proof: future reminder is NOT past due
        stored_future = mock_vault.retrieve(1, "reminder_future")
        assert stored_future is not None
        stored_future = _as_dict(stored_future)
        assert stored_future["scheduled_at"] > now  # not yet due
        assert stored_future["delivered"] is False

        # Deliver the missed reminder via Core (FIDUCIARY — silence causes harm)
        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title=stored_reminder["title"],
            body=f"Missed reminder: {stored_reminder['title']}",
        )
        mock_go_core.notify(notification)

        # Mark as delivered
        stored_reminder["delivered"] = True
        mock_vault.store(1, "reminder_license", stored_reminder)

        # Verify delivery — exactly one new notification
        assert len(mock_go_core._notifications_sent) == notifications_before + 1
        sent = mock_go_core._notifications_sent[-1]
        assert sent.title == "Driver's license expires"
        assert sent.tier == SilenceTier.TIER_1_FIDUCIARY

        # Verify vault updated
        updated = _as_dict(mock_vault.retrieve(1, "reminder_license"))
        assert updated["delivered"] is True

        # Counter-proof: future reminder still undelivered
        still_future = _as_dict(mock_vault.retrieve(1, "reminder_future"))
        assert still_future["delivered"] is False
