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

        Verify:
        - Both connected devices receive exactly 1 whisper each
        - Whisper type is "whisper" on both
        - Whisper text is identical on both devices
        - Whisper contains all context elements: ETA, context_flags, tea
        - Each device gets exactly 1 message (not duplicated)
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

        # Ensure Sancho's sharing policy allows context (a prior test may
        # have set context="none" and sharing policies are session-scoped).
        sancho.set_sharing_policy(
            node.did,
            context="full",
            presence="eta_only",
        )

        # Sancho sends a D2D arrival message to Don Alonso
        sancho.send_d2d(
            node.did,
            "dina/social/arrival",
            {
                "type": "dina/social/arrival",
                "eta_minutes": 15,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # Both devices should have received exactly 1 whisper each
        assert len(phone.ws_messages) == 1, (
            f"Phone must receive exactly 1 ws_message, got {len(phone.ws_messages)}"
        )
        assert len(laptop.ws_messages) == 1, (
            f"Laptop must receive exactly 1 ws_message, got {len(laptop.ws_messages)}"
        )

        # The whisper content should be identical on both devices
        phone_whisper = phone.ws_messages[0]
        laptop_whisper = laptop.ws_messages[0]

        assert phone_whisper["type"] == "whisper"
        assert laptop_whisper["type"] == "whisper"
        assert phone_whisper["payload"]["text"] == laptop_whisper["payload"]["text"], (
            "Whisper text must be identical on both devices"
        )

        # The whisper must contain ALL three context elements
        whisper_text = phone_whisper["payload"]["text"]
        assert "15" in whisper_text, (
            "Whisper must contain ETA (15 minutes)"
        )
        assert "mother" in whisper_text.lower() or "ill" in whisper_text.lower(), (
            "Whisper must contain context_flags content (mother_ill)"
        )
        assert "chai" in whisper_text.lower(), (
            "Whisper must contain tea_preference (strong chai)"
        )

# TST-E2E-054
    def test_offline_sync_reconciliation(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.2 Offline Sync Reconciliation.

        Phone goes offline.  D2D arrival messages arrive (triggering
        vault enrichment and device push).  Phone reconnects.
        Verify:
        - While phone is offline, only laptop receives ws_messages
        - Phone gets zero ws_messages while disconnected
        - After reconnect, vault items that arrived during offline period
          are available and can be synced (delta computation from timestamps)
        - Items stored while phone was offline have timestamps ≥ disconnect time
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

        # Both connected initially
        assert phone.connected is True
        assert laptop.connected is True

        # Clear ws_messages
        phone.ws_messages.clear()
        laptop.ws_messages.clear()

        # Phone goes offline — record the disconnect time
        disconnect_time = time.time()
        node.set_test_clock(disconnect_time)
        node.disconnect_device(phone.device_id)
        assert phone.connected is False
        assert laptop.connected is True

        # --- Create a sender so we can use real D2D flow ---
        from tests.e2e.mocks import MockPLCDirectory, MockD2DNetwork, TrustRing
        sender_plc = node.plc
        sender_net = node.network
        sender = HomeNode(
            did="did:plc:sync_sender",
            display_name="Sync Sender",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=sender_plc,
            network=sender_net,
        )
        sender.first_run_setup("sender@example.com", "pass_sender")

        # 10 D2D arrivals while phone is offline
        # Each arrival triggers _handle_arrival → _push_to_devices
        for i in range(10):
            node.set_test_clock(disconnect_time + i + 1)
            sender.send_d2d(
                to_did=node.did,
                message_type="dina/social/arrival",
                payload={
                    "type": "dina/social/arrival",
                    "eta_minutes": 10 + i,
                },
            )

        # Laptop received notifications (10 arrivals), phone received zero
        assert len(laptop.ws_messages) == 10, (
            f"Laptop (connected) must receive all 10 pushes, got {len(laptop.ws_messages)}"
        )
        assert len(phone.ws_messages) == 0, (
            "Phone (disconnected) must receive zero pushes"
        )

        # All laptop messages are whisper notifications from arrivals
        for ws_msg in laptop.ws_messages:
            assert ws_msg["type"] == "whisper", (
                f"Expected 'whisper' notification, got '{ws_msg['type']}'"
            )

        # Also store vault items while phone is offline (for delta check)
        stored_ids = []
        for i in range(10):
            node.set_test_clock(disconnect_time + 20 + i)
            item_id = node.vault_store(
                "consumer", f"offline_item_{i}",
                {"data": f"arrived_while_offline_{i}"},
            )
            stored_ids.append(item_id)

        # --- Phone reconnects ---
        phone.last_sync_ts = disconnect_time
        node.connect_device(phone.device_id)
        assert phone.connected is True

        # Delta computation: items stored since phone disconnected
        persona = node.personas["consumer"]
        delta_items = [
            item for item in persona.items.values()
            if item.timestamp >= disconnect_time
        ]

        # All 10 items stored during offline period are in the delta
        assert len(delta_items) >= 10, (
            f"Delta must contain at least 10 items, got {len(delta_items)}"
        )
        delta_ids = {item.item_id for item in delta_items}
        for item_id in stored_ids:
            assert item_id in delta_ids, (
                f"Item {item_id} stored while offline must appear in delta"
            )

        # Verify delta items have correct persona
        for item in delta_items:
            assert item.persona == "consumer"

        # Negative: items that don't exist in vault are not in delta
        assert "nonexistent_item" not in delta_ids

# TST-E2E-055
    def test_thin_client_no_local_storage(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-11.3 Thin Client No Local Storage.

        Pair both a thin and rich client. Verify the thin client has no
        local_cache while the rich client CAN have local_cache.
        When the node goes down, the thin client cannot serve data
        but the rich client's cache persists.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Store data in the vault
        item_id = node.vault_store(
            "consumer", "product_review", {"product": "Widget A"},
        )

        # ------------------------------------------------------------------
        # 1. Pair BOTH thin and rich clients
        # ------------------------------------------------------------------
        code_thin = node.generate_pairing_code()
        thin = node.pair_device(code_thin, DeviceType.THIN_CLIENT)
        assert thin is not None
        assert thin.device_type == DeviceType.THIN_CLIENT

        code_rich = node.generate_pairing_code()
        rich = node.pair_device(code_rich, DeviceType.RICH_CLIENT)
        assert rich is not None
        assert rich.device_type == DeviceType.RICH_CLIENT

        # ------------------------------------------------------------------
        # 2. POSITIVE CONTROL: Rich client CAN have local_cache
        # ------------------------------------------------------------------
        item = node.personas["consumer"].items[item_id]
        rich.local_cache[item_id] = item
        assert len(rich.local_cache) == 1, (
            "Rich client must be able to cache vault items locally"
        )
        assert rich.local_cache[item_id].persona == "consumer"
        assert "Widget A" in rich.local_cache[item_id].body_text

        # ------------------------------------------------------------------
        # 3. Thin client must have NO local_cache (empty dict)
        # ------------------------------------------------------------------
        assert thin.local_cache == {}, (
            "Thin client must never have local cached data"
        )

        # While node is up, queries through the node work
        results = node.vault_query("consumer", "product_review")
        assert len(results) == 1

        # ------------------------------------------------------------------
        # 4. Brain crash: thin client is helpless, rich client has cache
        # ------------------------------------------------------------------
        node.crash_brain()
        assert node.healthz()["brain"] == "crashed"

        # Thin client has nothing to fall back on
        assert thin.local_cache == {}

        # Rich client still has its cached data
        assert len(rich.local_cache) == 1, (
            "Rich client cache must survive brain crash"
        )
        assert rich.local_cache[item_id].persona == "consumer"

        # Brain queries fail
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            node._brain_process("query", {"q": "product_review"})

        # ------------------------------------------------------------------
        # 5. Restore and verify
        # ------------------------------------------------------------------
        node.restart_brain()
        assert node.healthz()["brain"] == "healthy"

        # Node queries work again
        results = node.vault_query("consumer", "product_review")
        assert len(results) == 1

        # Thin client STILL has no cache (it didn't magically get one)
        assert thin.local_cache == {}

        # Rich client cache is still intact
        assert len(rich.local_cache) == 1

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
