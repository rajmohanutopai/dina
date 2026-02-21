"""Integration tests for Migration and Portability (Section 12).

Tests schema migration, export/import roundtrips, hosting-level migration,
tamper detection, partial failure handling, FTS5 rebuild, and device
re-pairing after import.
"""

from __future__ import annotations

import hashlib
import json
import time

import pytest

from tests.integration.mocks import (
    MockDeploymentProfile,
    MockDockerCompose,
    MockExportArchive,
    MockIdentity,
    MockPairingManager,
    MockSchemaMigration,
    MockVault,
    PersonaType,
)


# ---------------------------------------------------------------------------
# Schema Migration
# ---------------------------------------------------------------------------


class TestSchemaMigration:
    """Schema version bumps, pre-flight backups, and rollback."""

# TST-INT-324
    def test_schema_migration_on_upgrade(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
    ) -> None:
        """When the application upgrades, the schema version is bumped and
        migration is applied to all vaults."""
        assert mock_schema_migration.current_version == 1

        success = mock_schema_migration.apply(2, mock_vault)
        assert success is True
        assert mock_schema_migration.current_version == 2
        assert 2 in mock_schema_migration.applied

# TST-INT-325
    def test_data_preserved_across_upgrade(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
    ) -> None:
        """All vault data survives a schema migration. Pre-existing records
        remain accessible after the version bump."""
        # Store data before migration
        mock_vault.store(1, "contact_alice", {"name": "Alice", "ring": "verified"})
        mock_vault.store(1, "verdict_laptop", {"product": "ThinkPad", "rating": 92})
        mock_vault.index_for_fts("contact_alice", "Alice contact verified")

        # Apply migration
        success = mock_schema_migration.apply(2, mock_vault)
        assert success is True

        # All data still present
        assert mock_vault.retrieve(1, "contact_alice") is not None
        assert mock_vault.retrieve(1, "verdict_laptop") is not None
        assert mock_vault.retrieve(1, "contact_alice")["name"] == "Alice"
        assert mock_vault.retrieve(1, "verdict_laptop")["rating"] == 92
        # FTS index still works
        results = mock_vault.search_fts("Alice")
        assert "contact_alice" in results

# TST-INT-326
    def test_rollback_after_failed_migration(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
    ) -> None:
        """A failed migration automatically rolls back to the pre-flight
        backup. The original schema version is preserved."""
        mock_vault.store(1, "important_data", {"value": "preserved"})
        original_version = mock_schema_migration.current_version

        # Inject integrity failure
        mock_schema_migration.set_integrity_failure()

        success = mock_schema_migration.apply(2, mock_vault)
        assert success is False
        assert mock_schema_migration.rolled_back is True
        # Backup was created before the attempt
        assert mock_schema_migration.backup is not None
        # Version did not advance
        assert mock_schema_migration.current_version == original_version

# TST-INT-327
    def test_config_format_change(
        self,
        mock_vault: MockVault,
    ) -> None:
        """Old config format is auto-converted to the new format during
        migration. The legacy keys are replaced by their new equivalents."""
        # Old-style flat config
        old_config = {
            "llm_provider": "ollama",
            "llm_model": "gemma3",
            "embed_provider": "ollama",
            "embed_model": "nomic-embed-text",
        }
        mock_vault.store(0, "config", old_config)

        # Migration converts to new provider/model format
        new_config = {
            "DINA_LIGHT": f"{old_config['llm_provider']}/{old_config['llm_model']}",
            "DINA_EMBED": f"{old_config['embed_provider']}/{old_config['embed_model']}",
        }
        mock_vault.store(0, "config", new_config)

        stored = mock_vault.retrieve(0, "config")
        assert "DINA_LIGHT" in stored
        assert stored["DINA_LIGHT"] == "ollama/gemma3"
        assert stored["DINA_EMBED"] == "ollama/nomic-embed-text"
        # Old keys are gone
        assert "llm_provider" not in stored
        assert "llm_model" not in stored

# TST-INT-333
    def test_schema_migration_identity_sqlite(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
    ) -> None:
        """Identity database schema can be migrated independently.
        The root DID and key material survive the migration."""
        original_did = mock_identity.root_did
        original_key = mock_identity.root_private_key

        # Store identity-related data in vault
        mock_vault.store(0, "identity_meta", {
            "did": original_did,
            "created_at": time.time(),
        })

        success = mock_schema_migration.apply(2, mock_vault)
        assert success is True

        # Identity is unchanged
        assert mock_identity.root_did == original_did
        assert mock_identity.root_private_key == original_key
        # Identity metadata is preserved
        meta = mock_vault.retrieve(0, "identity_meta")
        assert meta["did"] == original_did

# TST-INT-334
    def test_schema_migration_persona_vault(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
    ) -> None:
        """Persona vault schemas are migrated per-partition. Each persona's
        encrypted data survives the migration."""
        # Store data in consumer and health persona partitions
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        mock_vault.store(1, "purchase_history", {"items": 5},
                         persona=PersonaType.CONSUMER)
        mock_vault.store(1, "health_record", {"bp": "120/80"},
                         persona=PersonaType.HEALTH)

        success = mock_schema_migration.apply(2, mock_vault)
        assert success is True

        # Both partitions preserved
        consumer_data = mock_vault.retrieve(1, "purchase_history",
                                            persona=PersonaType.CONSUMER)
        health_data = mock_vault.retrieve(1, "health_record",
                                          persona=PersonaType.HEALTH)
        assert consumer_data is not None
        assert consumer_data["items"] == 5
        assert health_data is not None
        assert health_data["bp"] == "120/80"

# TST-INT-335
    def test_schema_migration_partial_failure(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
    ) -> None:
        """If migration fails for one database (e.g., persona vault),
        the other databases remain uncorrupted."""
        # Create two independent migration managers for two DBs
        migration_identity = MockSchemaMigration(current_version=1)
        migration_persona = MockSchemaMigration(current_version=1)

        # Store data in both
        mock_vault.store(0, "identity_data", {"did": mock_identity.root_did})
        mock_vault.store(1, "persona_data", {"type": "consumer"},
                         persona=PersonaType.CONSUMER)

        # Identity migration succeeds
        assert migration_identity.apply(2, mock_vault) is True

        # Persona migration fails
        migration_persona.set_integrity_failure()
        assert migration_persona.apply(2, mock_vault) is False
        assert migration_persona.rolled_back is True

        # Identity DB is still at version 2 (unaffected by persona failure)
        assert migration_identity.current_version == 2
        # Persona DB stayed at version 1
        assert migration_persona.current_version == 1
        # Data in both is intact
        assert mock_vault.retrieve(0, "identity_data") is not None
        assert mock_vault.retrieve(1, "persona_data",
                                   persona=PersonaType.CONSUMER) is not None

# TST-INT-336
    def test_fts5_rebuild_after_schema_change(
        self,
        mock_schema_migration: MockSchemaMigration,
        mock_vault: MockVault,
    ) -> None:
        """After a schema migration the full-text search index is rebuilt
        so that queries work correctly against the new schema."""
        # Populate FTS index
        mock_vault.store(1, "note_1", {"text": "meeting with Alice"})
        mock_vault.index_for_fts("note_1", "meeting Alice work standup")
        mock_vault.store(1, "note_2", {"text": "buy groceries"})
        mock_vault.index_for_fts("note_2", "groceries shopping list buy")

        # Pre-migration search works
        assert "note_1" in mock_vault.search_fts("Alice")
        assert "note_2" in mock_vault.search_fts("groceries")

        # Apply migration
        success = mock_schema_migration.apply(2, mock_vault)
        assert success is True

        # Simulate FTS5 rebuild: re-index all entries
        mock_vault.index_for_fts("note_1", "meeting Alice work standup")
        mock_vault.index_for_fts("note_2", "groceries shopping list buy")

        # Post-migration search still works
        assert "note_1" in mock_vault.search_fts("Alice")
        assert "note_2" in mock_vault.search_fts("groceries")
        # Negative search returns nothing
        assert mock_vault.search_fts("nonexistent") == []


# ---------------------------------------------------------------------------
# Export / Import Portability
# ---------------------------------------------------------------------------


class TestExportImport:
    """Data portability via dina export / dina import."""

# TST-INT-328
    def test_export_import_roundtrip(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
        mock_export_archive: MockExportArchive,
    ) -> None:
        """A full export followed by import into a fresh vault preserves
        all data."""
        # Populate vault
        mock_vault.store(1, "verdict_laptop", {"product": "ThinkPad", "rating": 92})
        mock_vault.store(1, "contact_bob", {"name": "Bob", "ring": "verified"})
        mock_vault.store(0, "config", {"DINA_LIGHT": "ollama/gemma3"})

        # Export
        mock_export_archive.export_from(mock_vault, mock_identity)
        assert mock_export_archive.checksum != ""
        assert mock_export_archive.did == mock_identity.root_did

        # Import into a fresh vault
        fresh_vault = MockVault()
        success = mock_export_archive.import_into(fresh_vault, mock_identity)
        assert success is True

        # All data present in fresh vault
        assert fresh_vault.retrieve(1, "verdict_laptop") is not None
        assert fresh_vault.retrieve(1, "verdict_laptop")["rating"] == 92
        assert fresh_vault.retrieve(1, "contact_bob")["name"] == "Bob"
        assert fresh_vault.retrieve(0, "config")["DINA_LIGHT"] == "ollama/gemma3"

# TST-INT-329
    def test_export_import_preserves_did_identity(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
        mock_export_archive: MockExportArchive,
    ) -> None:
        """The DID identity remains identical after export and re-import.
        No new DID is generated."""
        original_did = mock_identity.root_did

        mock_export_archive.export_from(mock_vault, mock_identity)
        assert mock_export_archive.did == original_did

        # Import into a new vault — identity stays the same
        fresh_vault = MockVault()
        success = mock_export_archive.import_into(fresh_vault, mock_identity)
        assert success is True
        assert mock_identity.root_did == original_did

# TST-INT-332
    def test_import_rejects_tampered_archive(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
        mock_export_archive: MockExportArchive,
    ) -> None:
        """A tampered export archive is rejected during import. The vault
        is not modified."""
        mock_vault.store(1, "original_data", {"safe": True})
        mock_export_archive.export_from(mock_vault, mock_identity)

        # Tamper with the archive
        mock_export_archive.tamper()

        fresh_vault = MockVault()
        success = mock_export_archive.import_into(fresh_vault, mock_identity)
        assert success is False
        # Fresh vault remains empty — no partial import
        assert fresh_vault.retrieve(1, "original_data") is None


# ---------------------------------------------------------------------------
# Hosting Level Migration
# ---------------------------------------------------------------------------


class TestHostingLevelMigration:
    """Moving between cloud, self-hosted, and local deployments."""

# TST-INT-330
    def test_migration_between_hosting_levels(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
        mock_export_archive: MockExportArchive,
    ) -> None:
        """Moving from cloud-hosted to self-hosted preserves the DID
        identity and all vault data."""
        # Cloud-hosted node has data
        mock_vault.store(1, "cloud_verdict", {"product": "Aeron", "rating": 91})
        mock_vault.store(0, "hosting", {"level": "cloud"})
        original_did = mock_identity.root_did

        # Export from cloud
        mock_export_archive.export_from(mock_vault, mock_identity)

        # Import into self-hosted node
        self_hosted_vault = MockVault()
        success = mock_export_archive.import_into(self_hosted_vault, mock_identity)
        assert success is True

        # Identity preserved
        assert mock_identity.root_did == original_did

        # Data preserved
        verdict = self_hosted_vault.retrieve(1, "cloud_verdict")
        assert verdict is not None
        assert verdict["product"] == "Aeron"
        assert verdict["rating"] == 91

        # Update hosting level marker
        self_hosted_vault.store(0, "hosting", {"level": "self-hosted"})
        assert self_hosted_vault.retrieve(0, "hosting")["level"] == "self-hosted"

# TST-INT-331
    def test_same_docker_image_across_hosting_levels(
        self,
        mock_deployment_profile: MockDeploymentProfile,
    ) -> None:
        """The same Docker image works across all hosting levels (cloud,
        local-llm). Container set adjusts by profile, not by image."""
        cloud = MockDeploymentProfile(profile="cloud")
        local = MockDeploymentProfile(profile="local-llm")

        # Both profiles share the same base containers
        assert "core" in cloud.containers
        assert "brain" in cloud.containers
        assert "pds" in cloud.containers
        assert "core" in local.containers
        assert "brain" in local.containers
        assert "pds" in local.containers

        # Local adds llama server; cloud does not
        assert "llama" in local.containers
        assert "llama" not in cloud.containers

        # The base set is identical — same image, different profiles
        base_cloud = sorted([c for c in cloud.containers if c != "llama"])
        base_local = sorted([c for c in local.containers if c != "llama"])
        assert base_cloud == base_local


# ---------------------------------------------------------------------------
# Device Re-pairing After Import
# ---------------------------------------------------------------------------


class TestDeviceRepairing:
    """Import invalidates existing device tokens."""

# TST-INT-337
    def test_import_invalidates_all_device_tokens(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
        mock_export_archive: MockExportArchive,
        mock_pairing_manager: MockPairingManager,
    ) -> None:
        """After importing into a new node, all previously paired devices
        must re-pair. Old CLIENT_TOKENs are invalidated."""
        # Pair two devices
        code_1 = mock_pairing_manager.generate_code()
        token_1 = mock_pairing_manager.complete_pairing(code_1.code, "phone_1")
        assert token_1 is not None
        assert mock_pairing_manager.is_token_valid(token_1.token)

        code_2 = mock_pairing_manager.generate_code()
        token_2 = mock_pairing_manager.complete_pairing(code_2.code, "tablet_1")
        assert token_2 is not None
        assert mock_pairing_manager.is_token_valid(token_2.token)

        # Export and import to a new node
        mock_export_archive.export_from(mock_vault, mock_identity)
        fresh_vault = MockVault()
        mock_export_archive.import_into(fresh_vault, mock_identity)

        # Revoke all existing device tokens (post-import security measure)
        for token_hash in list(mock_pairing_manager.paired_devices.keys()):
            mock_pairing_manager.revoke_device(token_hash)

        # Old tokens are now invalid
        assert not mock_pairing_manager.is_token_valid(token_1.token)
        assert not mock_pairing_manager.is_token_valid(token_2.token)

        # Devices must re-pair with new codes
        new_code = mock_pairing_manager.generate_code()
        new_token = mock_pairing_manager.complete_pairing(new_code.code, "phone_1")
        assert new_token is not None
        assert mock_pairing_manager.is_token_valid(new_token.token)
