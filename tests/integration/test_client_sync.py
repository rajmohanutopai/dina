"""Integration tests for client device synchronization.

Behavioral contracts tested:
- Rich client (phone/laptop): local cache, offline queue, checkpoint sync,
  cache corruption recovery.
- Thin client (glasses/watch): no local storage, authenticated WebSocket only.
- Device onboarding: QR code pairing, hardware-bound key storage, device
  registration in the identity system.
"""

from __future__ import annotations

import time
import hashlib

import pytest

from tests.integration.mocks import (
    MockDinaCore,
    MockGoCore,
    MockIdentity,
    MockPairingManager,
    MockRichClient,
    MockThinClient,
    MockVault,
    PersonaType,
)


# =========================================================================
# TestRichClientSync
# =========================================================================

class TestRichClientSync:
    """Phone/Laptop with SQLite cache and on-device LLM."""

# TST-INT-369
    # TRACE: {"suite": "INT", "case": "0369", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "01", "title": "initial_sync_from_checkpoint"}
    def test_initial_sync_from_checkpoint(
        self,
        mock_rich_client: MockRichClient,
        mock_dina: MockDinaCore,
    ):
        """On first connect, rich client syncs all data from the home node
        starting at checkpoint 0."""
        assert mock_rich_client.sync_checkpoint == 0.0

        # Home node has some items
        mock_dina.vault.store(1, "item_a", {"content": "alpha"})
        mock_dina.vault.store(1, "item_b", {"content": "bravo"})

        # Sync: push home node items to client
        home_items = [
            {"id": "item_a", "content": "alpha"},
            {"id": "item_b", "content": "bravo"},
        ]
        mock_rich_client.sync(home_items)

        assert mock_rich_client.sync_checkpoint > 0
        assert "item_a" in mock_rich_client.local_cache
        assert "item_b" in mock_rich_client.local_cache

# TST-INT-380
    # TRACE: {"suite": "INT", "case": "0380", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "02", "title": "realtime_push"}
    def test_realtime_push(
        self,
        mock_rich_client: MockRichClient,
        mock_dina: MockDinaCore,
    ):
        """New data added to the home node is pushed to the rich client
        in real time when connected. The client's local cache reflects
        the vault state after sync."""
        # Pre-condition: client cache is empty
        assert len(mock_rich_client.local_cache) == 0
        assert mock_rich_client.connected is True

        # Initial sync from home node
        mock_rich_client.sync([{"id": "item_1", "content": "first"}])
        assert "item_1" in mock_rich_client.local_cache
        assert mock_rich_client.sync_checkpoint > 0  # checkpoint advanced

        # New item arrives at home node vault
        new_item = {"id": "item_2", "content": "second"}
        mock_dina.vault.store(1, "item_2", new_item)
        # Verify item exists in vault
        assert mock_dina.vault.retrieve(1, "item_2") is not None

        # Push to connected client (simulates Core→WS→Client push)
        mock_rich_client.cache_item("item_2", new_item)
        assert "item_2" in mock_rich_client.local_cache
        assert mock_rich_client.local_cache["item_2"]["content"] == "second"

        # Client cache now has both items
        assert len(mock_rich_client.local_cache) == 2

        # Client can search locally for pushed content
        results = mock_rich_client.search_local("second")
        assert len(results) == 1
        assert results[0]["content"] == "second"

        # Counter-proof: non-matching search returns empty
        assert len(mock_rich_client.search_local("nonexistent")) == 0

# TST-INT-381
    # TRACE: {"suite": "INT", "case": "0381", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "03", "title": "offline_queue_then_sync"}
    def test_offline_queue_then_sync(
        self, mock_rich_client: MockRichClient
    ):
        """When offline, the client queues new items locally. When
        reconnected, the queue is flushed to the home node."""
        mock_rich_client.connected = False

        # Queue items while offline
        mock_rich_client.queue_offline({"id": "offline_1", "content": "queued"})
        mock_rich_client.queue_offline({"id": "offline_2", "content": "queued2"})
        assert len(mock_rich_client.offline_queue) == 2

        # Reconnect and flush
        mock_rich_client.connected = True
        flushed = mock_rich_client.push_queued()
        assert len(flushed) == 2
        assert len(mock_rich_client.offline_queue) == 0

        # Items are now synced
        flushed_ids = {item["id"] for item in flushed}
        assert "offline_1" in flushed_ids
        assert "offline_2" in flushed_ids

# TST-INT-368
    # TRACE: {"suite": "INT", "case": "0368", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "04", "title": "local_cache_works_offline"}
    def test_local_cache_works_offline(
        self, mock_rich_client: MockRichClient
    ):
        """When offline, the rich client can still search its local cache."""
        # Populate cache while online
        mock_rich_client.sync([
            {"id": "doc_1", "content": "meeting notes from Monday"},
            {"id": "doc_2", "content": "grocery list for the weekend"},
        ])

        # Go offline
        mock_rich_client.connected = False

        # Search still works on local cache
        results = mock_rich_client.search_local("meeting")
        assert len(results) == 1
        assert results[0]["id"] == "doc_1"

        results_all = mock_rich_client.search_local("doc_")
        assert len(results_all) == 2

# TST-INT-379
    # TRACE: {"suite": "INT", "case": "0379", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "05", "title": "corrupted_cache_resync"}
    def test_corrupted_cache_resync(
        self, mock_rich_client: MockRichClient, mock_dina: MockDinaCore
    ):
        """If the local cache is corrupted, the client detects it and
        re-syncs from the home node vault."""
        # Populate the authoritative vault (home node)
        mock_dina.vault.store(1, "item_x", {"content": "valid data"})
        mock_dina.vault.store(1, "item_y", {"content": "other data"})

        # Normal sync: client caches from home node
        mock_rich_client.sync([
            {"id": "item_x", "content": "valid data"},
            {"id": "item_y", "content": "other data"},
        ])
        pre_corruption_checkpoint = mock_rich_client.sync_checkpoint
        assert len(mock_rich_client.local_cache) == 2
        assert "item_x" in mock_rich_client.local_cache
        assert "item_y" in mock_rich_client.local_cache

        # Simulate corruption: cache loses data
        mock_rich_client.local_cache.clear()

        # Corruption detection: cache empty but checkpoint says we had data
        assert len(mock_rich_client.local_cache) == 0
        assert pre_corruption_checkpoint > 0, \
            "Checkpoint proves we previously synced — empty cache is corruption"

        # Re-sync: reset checkpoint and pull fresh data from home node vault
        mock_rich_client.sync_checkpoint = 0.0
        vault_items = []
        for key, value in mock_dina.vault._tiers[1].items():
            vault_items.append({"id": key, **value})
        mock_rich_client.sync(vault_items)

        # All home node data restored
        assert len(mock_rich_client.local_cache) == 2
        assert "item_x" in mock_rich_client.local_cache
        assert "item_y" in mock_rich_client.local_cache
        assert mock_rich_client.sync_checkpoint > 0

        # Counter-proof: search works after resync
        results = mock_rich_client.search_local("valid")
        assert len(results) > 0, "Search should find restored data"


# =========================================================================
# TestThinClientSync
# =========================================================================

class TestThinClientSync:
    """Glasses/Watch/Browser — no local storage."""

# TST-INT-370
    # TRACE: {"suite": "INT", "case": "0370", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "01", "title": "no_local_storage"}
    def test_no_local_storage(self, mock_thin_client: MockThinClient):
        """Thin clients have no local cache at all — everything streams
        from the home node."""
        # The thin client has no local_cache attribute (unlike rich client)
        assert not hasattr(mock_thin_client, "local_cache")

# TST-INT-371
    # TRACE: {"suite": "INT", "case": "0371", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "02", "title": "authenticated_only"}
    def test_authenticated_only(
        self,
        mock_thin_client: MockThinClient,
        mock_go_core: MockGoCore,
    ):
        """Thin client cannot connect without a device key."""
        # No key -> connection fails
        assert mock_thin_client.device_key is None
        connected = mock_thin_client.connect(mock_go_core)
        assert connected is False
        assert mock_thin_client.connected is False

        # Set device key -> connection succeeds
        mock_thin_client.device_key = "authenticated_key_001"
        connected = mock_thin_client.connect(mock_go_core)
        assert connected is True
        assert mock_thin_client.connected is True

        # Can now receive streamed data
        mock_thin_client.receive_stream({"type": "notification", "body": "hello"})
        assert len(mock_thin_client.received_streams) == 1

# TST-INT-374
    # TRACE: {"suite": "INT", "case": "0374", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "03", "title": "unauthenticated_receives_nothing"}
    def test_unauthenticated_receives_nothing(
        self, mock_thin_client: MockThinClient
    ):
        """An unauthenticated thin client does not receive any data even
        if receive_stream is called."""
        assert mock_thin_client.connected is False
        mock_thin_client.receive_stream({"sensitive": "data"})
        # Not connected -> data is silently dropped
        assert len(mock_thin_client.received_streams) == 0


# =========================================================================
# TestDeviceOnboarding
# =========================================================================

class TestDeviceOnboarding:
    """New device onboarding flow: QR code -> key exchange -> registration."""

# TST-INT-030
    # TRACE: {"suite": "INT", "case": "0030", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "01", "title": "qr_code_pairing"}
    def test_qr_code_pairing(self, mock_dina: MockDinaCore):
        """Pairing code is single-use: generate → complete → token issued.
        Re-using the same code must fail."""
        pairing_mgr = MockPairingManager()

        # --- Generate a pairing code (simulates QR display) ---
        pairing = pairing_mgr.generate_code()
        assert len(pairing.code) == 6, "Pairing code must be 6 digits"
        assert pairing.code in pairing_mgr.pending_codes, (
            "Generated code must be tracked in pending_codes"
        )
        assert pairing.used is False, "New code must not be marked used"

        # --- Complete pairing with valid code → token issued ---
        token = pairing_mgr.complete_pairing(pairing.code, "phone_001")
        assert token is not None, (
            "Valid pairing code must issue a CLIENT_TOKEN"
        )
        assert len(token.token) == 64, "Token must be 64-char hex"
        assert pairing.used is True, (
            "Code must be marked used after successful pairing"
        )

        # --- Single-use: re-using same code must fail ---
        token2 = pairing_mgr.complete_pairing(pairing.code, "tablet_001")
        assert token2 is None, (
            "Used pairing code must not issue a second token"
        )

        # --- Invalid code must fail ---
        token3 = pairing_mgr.complete_pairing("999999", "laptop_001")
        assert token3 is None, (
            "Invalid pairing code must not issue a token"
        )

        # --- Issued token is valid ---
        assert pairing_mgr.is_token_valid(token.token) is True, (
            "Freshly issued token must be valid"
        )

# TST-INT-367
    # TRACE: {"suite": "INT", "case": "0367", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "02", "title": "key_stored_in_hardware"}
    def test_key_stored_in_hardware(self, mock_dina: MockDinaCore):
        """The device key is derived from the root identity and is unique
        per device. In production this would be stored in the Secure Enclave
        or TPM — here we verify derivation produces a deterministic,
        device-unique key."""
        # Pre-condition: no devices registered
        assert len(mock_dina.identity.devices) == 0

        key_phone = mock_dina.identity.register_device("phone_001")
        key_laptop = mock_dina.identity.register_device("laptop_001")

        # Both devices are registered
        assert "phone_001" in mock_dina.identity.devices
        assert "laptop_001" in mock_dina.identity.devices

        # Different devices get different keys (per-device uniqueness)
        assert key_phone != key_laptop

        # Keys are 256-bit (64 hex chars)
        assert len(key_phone) == 64
        assert len(key_laptop) == 64

        # Determinism: re-registering same device produces same key
        key_phone_again = mock_dina.identity.register_device("phone_001")
        assert key_phone_again == key_phone

        # Counter-proof: different identity produces different key for same device
        other_identity = MockIdentity()
        other_key = other_identity.register_device("phone_001")
        assert other_key != key_phone  # different root key → different device key

# TST-INT-378
    # TRACE: {"suite": "INT", "case": "0378", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "03", "title": "device_registered"}
    def test_device_registered(self, mock_dina: MockDinaCore):
        """After onboarding, the device appears in the identity's device list."""
        assert len(mock_dina.identity.devices) == 0

        mock_dina.identity.register_device("phone_new")
        assert "phone_new" in mock_dina.identity.devices

        mock_dina.identity.register_device("watch_new")
        assert "watch_new" in mock_dina.identity.devices
        assert len(mock_dina.identity.devices) == 2
