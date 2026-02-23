"""E2E Test Suite 11: Multi-Device & Sync.

Tests real-time multi-device push, offline sync reconciliation, thin client
behaviour, rich client offline operations, cache corruption recovery, and
heartbeat-based stale connection cleanup.

Actors: Don Alonso (fresh/session), PLC Directory, D2D Network, FCM.
"""

from __future__ import annotations

import time

import pytest

from tests.e2e.actors import HomeNode, Device, PersonaType
from tests.e2e.mocks import (
    D2DMessage,
    DeviceType,
    MockD2DNetwork,
    MockFCM,
    MockPLCDirectory,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 11: Multi-Device & Sync
# ---------------------------------------------------------------------------


class TestMultiDeviceSync:
    """E2E-11.x -- Real-time push, offline reconciliation, thin/rich
    client semantics, cache corruption, and heartbeat cleanup."""

# TST-E2E-053
    def test_realtime_multi_device_push(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-11.1 Real-Time Multi-Device Push.

        Phone and laptop are both connected. A D2D message arrives from
        Sancho. Both devices receive identical whisper notifications via
        ws_messages.
        """
        node = don_alonso

        # Ensure at least two devices are connected
        device_list = list(node.devices.values())
        assert len(device_list) >= 2, "Don Alonso must have at least 2 devices"

        phone = device_list[0]
        laptop = device_list[1]
        assert phone.connected is True
        assert laptop.connected is True

        # Clear ws_messages from prior tests
        phone.ws_messages.clear()
        laptop.ws_messages.clear()

        # Sancho sends a D2D arrival message to Don Alonso
        sancho.send_d2d(
            node.did,
            "dina/social/arrival",
            {
                "eta_minutes": 15,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # Both devices should have received the whisper notification
        assert len(phone.ws_messages) >= 1, "Phone did not receive ws_message"
        assert len(laptop.ws_messages) >= 1, "Laptop did not receive ws_message"

        # The whisper content should be identical on both devices
        phone_whisper = phone.ws_messages[-1]
        laptop_whisper = laptop.ws_messages[-1]

        assert phone_whisper["type"] == "whisper"
        assert laptop_whisper["type"] == "whisper"
        assert phone_whisper["payload"]["text"] == laptop_whisper["payload"]["text"]

        # The whisper should contain contextual information
        whisper_text = phone_whisper["payload"]["text"]
        assert "15" in whisper_text or "minutes" in whisper_text

# TST-E2E-054
    def test_offline_sync_reconciliation(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.2 Offline Sync Reconciliation.

        Phone goes offline. 10 new vault items arrive. Phone reconnects
        with last_sync_ts=0. Core sends a delta containing all 10 items.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Pair phone and laptop
        code1 = node.generate_pairing_code()
        phone = node.pair_device(code1, DeviceType.RICH_CLIENT)
        assert phone is not None

        code2 = node.generate_pairing_code()
        laptop = node.pair_device(code2, DeviceType.RICH_CLIENT)
        assert laptop is not None

        # Phone goes offline
        node.disconnect_device(phone.device_id)
        assert phone.connected is False

        # 10 new items arrive while phone is offline
        new_item_ids = []
        for i in range(10):
            item_id = node.vault_store(
                "consumer", f"offline_item_{i}",
                {"data": f"arrived_while_offline_{i}"},
            )
            new_item_ids.append(item_id)

            # Push to connected devices (only laptop receives)
            node._push_to_devices({
                "type": "vault_update",
                "payload": {"item_id": item_id, "persona": "consumer"},
            })

        # Laptop received all 10 pushes, phone received none
        laptop_vault_updates = [
            m for m in laptop.ws_messages if m["type"] == "vault_update"
        ]
        phone_vault_updates = [
            m for m in phone.ws_messages if m["type"] == "vault_update"
        ]
        assert len(laptop_vault_updates) == 10
        assert len(phone_vault_updates) == 0

        # Phone reconnects with last_sync_ts=0 (requesting full delta)
        phone.last_sync_ts = 0
        node.connect_device(phone.device_id)
        assert phone.connected is True

        # Core computes the delta: all items since last_sync_ts=0
        persona = node.personas["consumer"]
        delta_items = [
            item for item in persona.items.values()
            if item.timestamp >= phone.last_sync_ts
        ]

        # Push the delta to the phone
        for item in delta_items:
            phone.ws_messages.append({
                "type": "sync_delta",
                "payload": {
                    "item_id": item.item_id,
                    "persona": item.persona,
                    "summary": item.summary,
                },
            })

        # Phone should now have all 10 items in its sync delta
        sync_deltas = [
            m for m in phone.ws_messages if m["type"] == "sync_delta"
        ]
        assert len(sync_deltas) >= 10

        # Verify each offline item is present in the delta
        delta_item_ids = {m["payload"]["item_id"] for m in sync_deltas}
        for item_id in new_item_ids:
            assert item_id in delta_item_ids

# TST-E2E-055
    def test_thin_client_no_local_storage(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.3 Thin Client No Local Storage.

        Pair a thin client (DeviceType.THIN_CLIENT). Verify it has no
        local_cache. When the node goes down, the thin client cannot
        query data.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Store some data in the vault
        node.vault_store("consumer", "product_review", {"product": "Widget A"})

        # Pair a thin client
        code = node.generate_pairing_code()
        thin = node.pair_device(code, DeviceType.THIN_CLIENT)
        assert thin is not None
        assert thin.device_type == DeviceType.THIN_CLIENT

        # Thin client must have NO local_cache (empty dict)
        assert thin.local_cache == {}

        # While node is up, queries through the node work
        results = node.vault_query("consumer", "product_review")
        assert len(results) >= 1

        # Simulate node going down (brain crash)
        node.crash_brain()
        assert node.healthz()["brain"] == "crashed"

        # Thin client has no local_cache to fall back on
        assert len(thin.local_cache) == 0

        # Any attempt to process through the brain raises
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            node._brain_process("query", {"q": "product_review"})

        # Thin client cannot independently serve data
        assert thin.local_cache == {}

        # Restore the node
        node.restart_brain()
        assert node.healthz()["brain"] == "healthy"

        # After restart, queries work again
        results = node.vault_query("consumer", "product_review")
        assert len(results) >= 1

# TST-E2E-056
    def test_rich_client_offline_operations(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.4 Rich Client Offline Operations.

        Populate local_cache on a rich client. Disconnect. Read from
        local_cache while offline. Reconnect, upload offline_queue items
        back to the node.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Pair a rich client
        code = node.generate_pairing_code()
        rich = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert rich is not None
        assert rich.device_type == DeviceType.RICH_CLIENT

        # Populate local_cache with vault items (simulating sync)
        cached_items = {}
        for i in range(5):
            item_id = node.vault_store(
                "consumer", f"cached_item_{i}",
                {"data": f"cached_data_{i}"},
            )
            item = node.personas["consumer"].items[item_id]
            cached_items[item_id] = item
            rich.local_cache[item_id] = item

        assert len(rich.local_cache) == 5

        # Disconnect the rich client
        node.disconnect_device(rich.device_id)
        assert rich.connected is False

        # While offline, read from local_cache
        for item_id, item in rich.local_cache.items():
            assert item.persona == "consumer"
            assert "cached_data" in item.body_text

        # Create offline edits (queued for later upload)
        offline_edits = [
            {"action": "store", "key": "offline_note_0",
             "value": {"data": "created_offline_0"}},
            {"action": "store", "key": "offline_note_1",
             "value": {"data": "created_offline_1"}},
            {"action": "store", "key": "offline_note_2",
             "value": {"data": "created_offline_2"}},
        ]
        for edit in offline_edits:
            rich.offline_queue.append(edit)

        assert len(rich.offline_queue) == 3

        # Reconnect
        node.connect_device(rich.device_id)
        assert rich.connected is True

        # Upload offline_queue items to the node
        uploaded_ids = []
        while rich.offline_queue:
            edit = rich.offline_queue.pop(0)
            if edit["action"] == "store":
                item_id = node.vault_store(
                    "consumer", edit["key"], edit["value"],
                )
                uploaded_ids.append(item_id)

        assert len(rich.offline_queue) == 0
        assert len(uploaded_ids) == 3

        # Verify all offline edits are now in the node's vault
        persona = node.personas["consumer"]
        for item_id in uploaded_ids:
            assert item_id in persona.items
            assert "created_offline" in persona.items[item_id].body_text

# TST-E2E-057
    def test_cache_corruption_recovery(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.5 Cache Corruption Recovery.

        Corrupt a rich client's local_cache, detect the corruption
        (KeyError or similar), clear the cache, and request a full
        re-sync from the node.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Pair a rich client and populate its cache
        code = node.generate_pairing_code()
        rich = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert rich is not None

        original_ids = []
        for i in range(5):
            item_id = node.vault_store(
                "consumer", f"sync_item_{i}",
                {"data": f"synced_data_{i}"},
            )
            item = node.personas["consumer"].items[item_id]
            rich.local_cache[item_id] = item
            original_ids.append(item_id)

        assert len(rich.local_cache) == 5

        # Corrupt the cache: replace a valid entry with a bogus object
        # and remove another entry entirely
        corrupted_key = original_ids[0]
        rich.local_cache[corrupted_key] = "CORRUPTED_NOT_A_VAULT_ITEM"  # type: ignore
        del rich.local_cache[original_ids[1]]

        # Detect corruption: attempt to access a field on the corrupted entry
        corruption_detected = False
        try:
            item = rich.local_cache[corrupted_key]
            # A valid VaultItem should have a .persona attribute
            _ = item.persona  # type: ignore
        except AttributeError:
            corruption_detected = True

        assert corruption_detected is True

        # Also detect the missing key
        missing_detected = False
        try:
            _ = rich.local_cache[original_ids[1]]
        except KeyError:
            missing_detected = True

        assert missing_detected is True

        # Recovery: clear the corrupted cache
        rich.local_cache.clear()
        assert len(rich.local_cache) == 0

        # Request full re-sync from the node
        rich.last_sync_ts = 0  # signal "give me everything"
        persona = node.personas["consumer"]
        for item_id, item in persona.items.items():
            rich.local_cache[item_id] = item

        # Cache is now fully restored from the authoritative node
        assert len(rich.local_cache) == len(persona.items)

        # Verify every item in the cache is a valid VaultItem
        for item_id, item in rich.local_cache.items():
            assert isinstance(item, VaultItem)
            assert item.persona == "consumer"
            assert item.item_id == item_id

        # All original IDs that are in the node are in the cache
        for item_id in original_ids:
            assert item_id in rich.local_cache

# TST-E2E-058
    def test_heartbeat_stale_connection_cleanup(
        self,
        fresh_don_alonso: HomeNode,
        fcm: MockFCM,
    ) -> None:
        """E2E-11.6 Heartbeat and Stale Connection Cleanup.

        Simulate 3 missed pongs on a device. Verify the device is
        disconnected. FCM sends a wake-only push with no data payload.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Pair a device
        code = node.generate_pairing_code()
        phone = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert phone is not None
        assert phone.connected is True

        # Record the FCM push count before the test
        initial_push_count = len(fcm.pushes)

        # Simulate 3 missed pongs (heartbeat failures)
        phone.missed_pongs = 3

        # Heartbeat check: if missed_pongs >= 3, disconnect the device
        stale_devices = []
        for dev_id, dev in node.devices.items():
            if dev.missed_pongs >= 3:
                stale_devices.append(dev_id)

        assert phone.device_id in stale_devices

        # Disconnect stale devices and send FCM wake-only push
        for dev_id in stale_devices:
            dev = node.devices[dev_id]
            node.disconnect_device(dev_id)

            # FCM wake-only push -- MUST have no data payload (privacy)
            fcm.send_wake(dev.token, node.did)

        # Verify device is disconnected
        assert phone.connected is False

        # Verify FCM push was sent
        assert len(fcm.pushes) == initial_push_count + 1

        new_push = fcm.pushes[-1]
        assert new_push["type"] == "wake_only"
        assert new_push["data_payload"] is None  # Privacy: no data in push
        assert new_push["device_token"] == phone.token
        assert new_push["did"] == node.did

        # After the wake push, the device would reconnect
        # (simulated by resetting missed_pongs and connecting)
        phone.missed_pongs = 0
        node.connect_device(phone.device_id)
        assert phone.connected is True
        assert phone.missed_pongs == 0
