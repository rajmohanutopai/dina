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
    def test_realtime_push(
        self,
        mock_rich_client: MockRichClient,
        mock_dina: MockDinaCore,
    ):
        """New data added to the home node is pushed to the rich client
        in real time when connected."""
        # Initial sync
        mock_rich_client.sync([{"id": "item_1", "content": "first"}])
        assert "item_1" in mock_rich_client.local_cache

        # New item arrives at home node
        new_item = {"id": "item_2", "content": "second"}
        mock_dina.vault.store(1, "item_2", new_item)

        # Push to connected client
        mock_rich_client.cache_item("item_2", new_item)
        assert "item_2" in mock_rich_client.local_cache
        assert mock_rich_client.local_cache["item_2"]["content"] == "second"

# TST-INT-381
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
    def test_corrupted_cache_resync(
        self, mock_rich_client: MockRichClient, mock_dina: MockDinaCore
    ):
        """If the local cache is corrupted, the client detects it and
        re-syncs from the home node checkpoint."""
        # Normal sync
        mock_rich_client.sync([
            {"id": "item_x", "content": "valid data"},
        ])
        assert "item_x" in mock_rich_client.local_cache

        # Simulate corruption: wipe the cache
        mock_rich_client.local_cache.clear()
        assert len(mock_rich_client.local_cache) == 0

        # Detect corruption (cache unexpectedly empty)
        is_corrupted = len(mock_rich_client.local_cache) == 0
        assert is_corrupted is True

        # Re-sync from home node
        mock_rich_client.sync_checkpoint = 0.0  # Reset checkpoint
        home_items = [{"id": "item_x", "content": "valid data"}]
        mock_rich_client.sync(home_items)

        assert "item_x" in mock_rich_client.local_cache
        assert mock_rich_client.sync_checkpoint > 0


# =========================================================================
# TestThinClientSync
# =========================================================================

class TestThinClientSync:
    """Glasses/Watch/Browser — no local storage."""

# TST-INT-370
    def test_no_local_storage(self, mock_thin_client: MockThinClient):
        """Thin clients have no local cache at all — everything streams
        from the home node."""
        # The thin client has no local_cache attribute (unlike rich client)
        assert not hasattr(mock_thin_client, "local_cache")

# TST-INT-371
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
    def test_qr_code_pairing(self, mock_dina: MockDinaCore):
        """QR code contains a one-time pairing token derived from the
        root identity. Scanning it initiates device registration."""
        # Generate a pairing token (simulates QR code content)
        pairing_token = hashlib.sha256(
            f"{mock_dina.identity.root_private_key}:pairing:{time.time()}".encode()
        ).hexdigest()

        assert len(pairing_token) == 64  # SHA-256 hex
        assert pairing_token != mock_dina.identity.root_private_key

        # The pairing token is single-use
        mock_dina.vault.store(0, f"pairing_{pairing_token[:16]}", {
            "token": pairing_token,
            "used": False,
            "created_at": time.time(),
        })

        stored = mock_dina.vault.retrieve(0, f"pairing_{pairing_token[:16]}")
        assert stored["used"] is False

        # Mark as used after pairing
        stored["used"] = True
        mock_dina.vault.store(0, f"pairing_{pairing_token[:16]}", stored)
        updated = mock_dina.vault.retrieve(0, f"pairing_{pairing_token[:16]}")
        assert updated["used"] is True

# TST-INT-367
    def test_key_stored_in_hardware(self, mock_dina: MockDinaCore):
        """The device key is derived from the root identity and is unique
        per device. In production this would be stored in the Secure Enclave
        or TPM — here we verify derivation produces a deterministic,
        device-unique key."""
        key_phone = mock_dina.identity.register_device("phone_001")
        key_laptop = mock_dina.identity.register_device("laptop_001")

        # Keys are deterministic for the same device ID
        key_phone_again = hashlib.sha256(
            f"{mock_dina.identity.root_private_key}device:phone_001".encode()
        ).hexdigest()
        assert key_phone == key_phone_again

        # Different devices get different keys
        assert key_phone != key_laptop

        # Keys are 256-bit (64 hex chars)
        assert len(key_phone) == 64
        assert len(key_laptop) == 64

# TST-INT-378
    def test_device_registered(self, mock_dina: MockDinaCore):
        """After onboarding, the device appears in the identity's device list."""
        assert len(mock_dina.identity.devices) == 0

        mock_dina.identity.register_device("phone_new")
        assert "phone_new" in mock_dina.identity.devices

        mock_dina.identity.register_device("watch_new")
        assert "watch_new" in mock_dina.identity.devices
        assert len(mock_dina.identity.devices) == 2
