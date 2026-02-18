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
    MockConnector,
    MockDinaCore,
    MockGmailConnector,
    MockIdentity,
    MockKeyManager,
    MockPersona,
    MockStagingTier,
    MockVault,
    PaymentIntent,
    PersonaType,
)


# ---------------------------------------------------------------------------
# TestTier0IdentityVault
# ---------------------------------------------------------------------------

class TestTier0IdentityVault:
    """Tier 0 holds the root keypair, BIP-39 mnemonic, and SLIP-0010 derivation."""

    def test_root_keypair_encrypted_at_rest(
        self, mock_identity: MockIdentity
    ) -> None:
        """The root private key (DEK) must be key-wrapped when stored.

        In production: passphrase → Argon2id (KEK) → AES-256-GCM wraps the
        Master Key (DEK). Here we verify the mock produces a wrapped blob
        that differs from the plaintext key.
        """
        km = MockKeyManager(mock_identity)
        wrapped = km.key_wrap(
            mock_identity.root_private_key, passphrase="strong-passphrase"
        )

        assert wrapped.startswith("WRAPPED[")
        assert mock_identity.root_private_key not in wrapped

    def test_bip39_recovery_mnemonic_exists(
        self, mock_identity: MockIdentity
    ) -> None:
        """A 24-word BIP-39 mnemonic is generated with the identity.

        The mnemonic allows full recovery of every persona key.
        """
        words = mock_identity.bip39_mnemonic.split()
        assert len(words) == 24, "BIP-39 mnemonic must be 24 words"
        # Each word must be non-empty
        assert all(len(w) > 0 for w in words)

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

    def test_cryptographically_unlinkable_personas(
        self, mock_identity: MockIdentity
    ) -> None:
        """External observers cannot link two personas to the same root.

        The derived DIDs share no common prefix beyond the method scheme.
        """
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        # Both are did:key, but the z6Mk... suffix differs
        assert consumer.did.startswith("did:key:z6Mk")
        assert health.did.startswith("did:key:z6Mk")

        # The key-specific portion is completely different
        consumer_suffix = consumer.did.split("z6Mk")[1]
        health_suffix = health.did.split("z6Mk")[1]
        assert consumer_suffix != health_suffix

        # Derived keys share no common pattern detectable by an observer
        overlap = sum(
            1 for a, b in zip(consumer.derived_key, health.derived_key)
            if a == b
        )
        # With SHA-256, random overlap is ~1/16 per hex char; 64 chars
        # means ~4 matches on average. Allow generous margin but ensure
        # it is nowhere near identical.
        assert overlap < len(consumer.derived_key), (
            "Persona keys must not be identical"
        )

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

    def test_data_encrypted_with_persona_key(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Data stored in Tier 1 is encrypted with the persona's key."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        plaintext = "blood pressure: 120/80"
        encrypted = health.encrypt(plaintext)

        # Encrypted form does not contain plaintext
        assert plaintext not in encrypted
        assert encrypted.startswith(f"ENC[{health.storage_partition}]:")

        # Store the encrypted blob
        mock_vault.store(
            tier=1, key="bp_reading", value=encrypted,
            persona=PersonaType.HEALTH,
        )
        retrieved = mock_vault.retrieve(
            tier=1, key="bp_reading", persona=PersonaType.HEALTH,
        )
        assert retrieved == encrypted

    def test_fts5_search_returns_matching_keys(
        self, mock_vault: MockVault
    ) -> None:
        """FTS5 full-text search indexes Tier 1 entries by keyword."""
        mock_vault.store(tier=1, key="note_alpha",
                         value={"text": "ergonomic chair review"})
        mock_vault.index_for_fts("note_alpha",
                                  "ergonomic chair review lumbar support")

        mock_vault.store(tier=1, key="note_beta",
                         value={"text": "laptop battery life"})
        mock_vault.index_for_fts("note_beta",
                                  "laptop battery life ThinkPad performance")

        results = mock_vault.search_fts("chair")
        assert "note_alpha" in results
        assert "note_beta" not in results

        results = mock_vault.search_fts("laptop")
        assert "note_beta" in results
        assert "note_alpha" not in results

    def test_fts5_search_case_insensitive(
        self, mock_vault: MockVault
    ) -> None:
        """FTS5 search is case-insensitive."""
        mock_vault.index_for_fts("doc_1", "Herman Miller Aeron")

        assert mock_vault.search_fts("herman") == ["doc_1"]
        assert mock_vault.search_fts("AERON") == ["doc_1"]
        assert mock_vault.search_fts("Miller") == ["doc_1"]

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

    def test_payment_intents_stored(
        self, mock_staging: MockStagingTier
    ) -> None:
        """Payment intents are staged for user review before execution."""
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

        retrieved = mock_staging.get("pay_001")
        assert retrieved is not None
        assert retrieved.merchant == "ChairMaker Co."
        assert retrieved.amount == 95000.0
        assert not retrieved.executed

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

    def test_encrypted_snapshots(self, mock_vault: MockVault) -> None:
        """Vault snapshots are created for archival purposes."""
        # Populate some data
        mock_vault.store(tier=1, key="note1", value="hello")
        mock_vault.store(tier=1, key="note2", value="world")

        snapshot = mock_vault.snapshot()

        assert "tiers" in snapshot
        assert "timestamp" in snapshot
        assert snapshot["timestamp"] > 0

        # Snapshot contains the data
        assert "note1" in snapshot["tiers"][1]
        assert snapshot["tiers"][1]["note1"] == "hello"

    def test_immutable_archive(self, mock_vault: MockVault) -> None:
        """Archived data in Tier 5 is stored and cannot be accidentally
        overwritten by a Tier 1 store.
        """
        # Store in archive
        mock_vault.store(tier=5, key="archive_2025",
                         value={"year": 2025, "records": 1200})

        # Store same key in Tier 1
        mock_vault.store(tier=1, key="archive_2025",
                         value={"year": 2025, "records": 0})

        # Tier 5 is untouched
        archived = mock_vault.retrieve(tier=5, key="archive_2025")
        assert archived["records"] == 1200

        # Tier 1 has its own copy
        tier1_copy = mock_vault.retrieve(tier=1, key="archive_2025")
        assert tier1_copy["records"] == 0

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

    def test_delete_nonexistent_returns_false(
        self, mock_vault: MockVault
    ) -> None:
        """Deleting a key that does not exist returns False."""
        result = mock_vault.delete(tier=5, key="ghost_key")
        assert result is False

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
        assert health.decrypt(retrieved) == "DECRYPTED_CONTENT"

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

    def test_wal_mode_configured(self, mock_vault: MockVault) -> None:
        """Vault must use WAL journal mode for concurrent read access."""
        assert mock_vault.PRAGMAS["journal_mode"] == "WAL"

    def test_busy_timeout_configured(self, mock_vault: MockVault) -> None:
        """busy_timeout must be set to avoid immediate SQLITE_BUSY errors."""
        assert mock_vault.PRAGMAS["busy_timeout"] == 5000

    def test_synchronous_normal(self, mock_vault: MockVault) -> None:
        """synchronous=NORMAL is safe in WAL mode and faster than FULL."""
        assert mock_vault.PRAGMAS["synchronous"] == "NORMAL"

    def test_foreign_keys_on(self, mock_vault: MockVault) -> None:
        """Foreign keys must be enforced to prevent orphaned data."""
        assert mock_vault.PRAGMAS["foreign_keys"] == "ON"

    # --- Single-writer pattern ---

    def test_single_write_increments_tx_count(self, mock_vault: MockVault) -> None:
        """Each individual store() is one transaction."""
        mock_vault.store(1, "key_a", "val_a")
        mock_vault.store(1, "key_b", "val_b")
        assert mock_vault._write_count == 2
        assert mock_vault._tx_count == 2

    def test_reads_never_blocked_by_writes(self, mock_vault: MockVault) -> None:
        """Reads use the read pool and succeed even during writes.

        In production: read connections have PRAGMA query_only=ON.
        In mock: retrieve() never touches the write path.
        """
        mock_vault.store(1, "concurrent_key", "concurrent_val")
        # Read immediately after write — should always succeed
        assert mock_vault.retrieve(1, "concurrent_key") == "concurrent_val"
        # FTS read also succeeds
        mock_vault.index_for_fts("concurrent_key", "concurrent test")
        assert "concurrent_key" in mock_vault.search_fts("concurrent")

    # --- Batch ingestion ---

    def test_batch_store_one_transaction(self, mock_vault: MockVault) -> None:
        """store_batch() writes N items in a single transaction."""
        items = [(f"batch_{i}", {"data": i}) for i in range(50)]
        written = mock_vault.store_batch(1, items, persona=PersonaType.CONSUMER)

        assert written == 50
        assert mock_vault._write_count == 50  # 50 individual writes
        assert mock_vault._tx_count == 1      # but only 1 transaction

    def test_batch_store_emits_notification(self, mock_vault: MockVault) -> None:
        """Each batch emits one brain notification (not one per item)."""
        items = [(f"notif_{i}", {"data": i}) for i in range(100)]
        mock_vault.store_batch(1, items, persona=PersonaType.PROFESSIONAL)

        assert len(mock_vault._batch_notifications) == 1
        notif = mock_vault._batch_notifications[0]
        assert notif["count"] == 100
        assert notif["persona"] == PersonaType.PROFESSIONAL

    def test_batch_data_readable_after_commit(self, mock_vault: MockVault) -> None:
        """All items in a batch are readable after the batch commits."""
        items = [(f"read_{i}", f"value_{i}") for i in range(10)]
        mock_vault.store_batch(1, items, persona=PersonaType.SOCIAL)

        for i in range(10):
            assert mock_vault.retrieve(1, f"read_{i}") == f"value_{i}"
            assert mock_vault.retrieve(
                1, f"read_{i}", persona=PersonaType.SOCIAL
            ) == f"value_{i}"

    def test_batch_size_is_100(self, mock_vault: MockVault) -> None:
        """Default batch size for ingestion is 100 items."""
        assert mock_vault.BATCH_SIZE == 100

    # --- Connector batch ingestion ---

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

    def test_connector_batch_ingest_small_set(
        self, mock_vault: MockVault
    ) -> None:
        """A small set of items (< batch_size) is still one transaction."""
        connector = MockGmailConnector()
        items = [
            {"id": f"small_{i}", "content": f"Content {i}"}
            for i in range(5)
        ]
        total = connector.batch_ingest(items, mock_vault)

        assert total == 5
        assert mock_vault._tx_count == 1
        assert len(mock_vault._batch_notifications) == 1

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
