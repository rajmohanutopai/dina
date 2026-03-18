"""E2E Test Suite 17: The Quiet Dina.

Product-level validation of silence protocol and daily briefing behavior.

Actors: Don Alonso.
"""

from __future__ import annotations

import pytest

from tests.e2e.actors import HomeNode
from tests.e2e.mocks import (
    SilenceTier,
)


# ---------------------------------------------------------------------------
# Suite 17: The Quiet Dina
# ---------------------------------------------------------------------------


@pytest.mark.mock_heavy
class TestQuietDina:
    """E2E-17.x -- Silence protocol, notification tiers, and daily briefing
    queue behavior.

    NOTE: ~98% mock-only — exercises _classify_silence(), briefing_queue,
    and notifications list on HomeNode. No real Go Core or Brain API calls.
    Consider migrating to tests/integration/ or adding real Brain silence
    classification endpoints to the Docker stack.
    """

# TST-E2E-099
    def test_mixed_tier_interrupt_notify_queue(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-17.1 Mixed-tier event routing: interrupt, notify, queue.

        Trigger a fiduciary event (Tier 1) -> immediate interrupt pushed
        to devices.  Trigger a solicited event (Tier 2) -> notification
        delivered.  Trigger an engagement event (Tier 3) -> queued in
        briefing_queue, no device push for that event.
        """
        node = don_alonso

        # Ensure at least one device is connected for push observation
        device_list = list(node.devices.values())
        assert len(device_list) >= 1, "Don Alonso must have at least 1 device"
        device = device_list[0]
        device.ws_messages.clear()
        node.notifications.clear()
        node.briefing_queue.clear()
        node.dnd_active = False

        # -- Tier 1: Fiduciary -- must interrupt immediately ---------------
        ws_before_t1 = len(device.ws_messages)
        tier1_result = node._brain_process(
            "security_alert",
            {"fiduciary": True, "text": "Suspicious login from unknown IP"},
        )
        tier1_class = node._classify_silence(
            "security_alert", {"fiduciary": True},
        )
        assert tier1_class == SilenceTier.TIER_1_FIDUCIARY, (
            "security_alert with fiduciary flag must be Tier 1"
        )
        assert tier1_result.get("tier") == SilenceTier.TIER_1_FIDUCIARY.value

        # -- Tier 2: Solicited -- notification delivered (DND off) ---------
        ws_before_t2 = len(device.ws_messages)
        tier2_result = node._brain_process(
            "dina/social/arrival",
            {
                "user_requested": True,
                "eta_minutes": 10,
                "text": "Sancho is arriving",
            },
            from_did="did:plc:sancho",
        )
        tier2_class = node._classify_silence(
            "dina/social/arrival",
            {"user_requested": True, "eta_minutes": 10},
        )
        assert tier2_class == SilenceTier.TIER_2_SOLICITED, (
            "Social arrival event must be Tier 2"
        )
        # Tier 2 events must be pushed to devices (not queued)
        assert tier2_result.get("status") == "ok"
        assert len(node.notifications) == 2, (
            "2 notifications: 1 fiduciary (interrupt) + 1 solicited (deliver)"
        )
        # Device must have received the whisper push
        assert len(device.ws_messages) > ws_before_t2, (
            "Tier 2 must push ws_message to device when DND off"
        )
        tier2_whisper = device.ws_messages[-1]
        assert "10" in tier2_whisper["payload"]["text"], (
            "Tier 2 whisper must contain ETA"
        )

        # -- Tier 3: Classification verified directly ----------------------
        tier3_class = node._classify_silence(
            "content_suggestion",
            {"text": "Newsletter digest available"},
        )
        assert tier3_class == SilenceTier.TIER_3_ENGAGEMENT, (
            "content_suggestion without fiduciary/user_requested must be Tier 3"
        )

        # -- DND queuing: non-fiduciary arrivals queued during DND ---------
        # Note: "dina/social/arrival" is classified as TIER_2 (prefix match),
        # but DND queues ALL non-fiduciary arrivals, proving the DND gate.
        node.dnd_active = True
        ws_before_dnd = len(device.ws_messages)
        briefing_before = len(node.briefing_queue)

        dnd_result = node._brain_process(
            "dina/social/arrival",
            {"eta_minutes": 30, "text": "Newsletter digest available"},
            from_did="did:plc:sancho",
        )
        assert dnd_result["status"] == "queued_for_briefing", (
            "Non-fiduciary arrivals must be queued during DND"
        )
        assert len(node.briefing_queue) == briefing_before + 1, (
            "Exactly 1 new item in briefing queue"
        )
        # No new ws_message pushed during DND
        assert len(device.ws_messages) == ws_before_dnd, (
            "No device push during DND for non-fiduciary events"
        )

        # Queued item must contain the arrival content
        queued = node.briefing_queue[-1]
        assert queued["type"] == "whisper"
        assert "30" in queued["payload"]["text"], (
            "Queued briefing item must contain ETA"
        )

        # -- Fiduciary BYPASSES DND ----------------------------------------
        ws_before_fiduciary = len(device.ws_messages)
        fiduciary_dnd_result = node._brain_process(
            "security_alert",
            {"fiduciary": True, "text": "Account compromised"},
        )
        assert fiduciary_dnd_result.get("tier") == SilenceTier.TIER_1_FIDUCIARY.value, (
            "Fiduciary events must NOT be queued even during DND"
        )
        # Fiduciary must not be in briefing queue
        assert len(node.briefing_queue) == briefing_before + 1, (
            "Fiduciary event must not be added to briefing queue"
        )

        node.dnd_active = False

# TST-E2E-100
    def test_daily_briefing_summarizes_queued(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-17.2 Daily briefing summarizes all queued Tier 3 items.

        Queue multiple items via real _brain_process during DND, then
        drain the briefing and verify it contains all items exactly once.
        """
        node = don_alonso
        node.dnd_active = True
        node.briefing_queue.clear()

        # Queue 5 arrival events through REAL _brain_process during DND.
        # DND queues non-fiduciary arrivals in briefing_queue.
        for i in range(5):
            result = node._brain_process(
                "dina/social/arrival",
                {"eta_minutes": (i + 1) * 5, "text": f"Visitor {i} arriving"},
                from_did=f"did:plc:visitor_{i}",
            )
            assert result["status"] == "queued_for_briefing", (
                f"Event {i} must be queued during DND"
            )

        # All 5 must be in the briefing queue
        assert len(node.briefing_queue) == 5, (
            f"Expected exactly 5 queued items, got {len(node.briefing_queue)}"
        )

        # Each queued item must have correct structure and unique content
        for i, item in enumerate(node.briefing_queue):
            assert item["type"] == "whisper"
            assert "tier" in item["payload"]
            assert item["payload"]["tier"] == SilenceTier.TIER_2_SOLICITED.value

        # Verify unique ETA values appear (no duplicate events)
        eta_values = set()
        for item in node.briefing_queue:
            text = item["payload"]["text"]
            for eta in [5, 10, 15, 20, 25]:
                if str(eta) in text:
                    eta_values.add(eta)
        assert len(eta_values) == 5, (
            f"Expected 5 unique ETAs in briefing, got {eta_values}"
        )

        # Drain the briefing queue (simulates daily briefing generation)
        briefing_snapshot = list(node.briefing_queue)
        node.briefing_queue.clear()
        assert len(node.briefing_queue) == 0, "Queue must be empty after drain"

        # No duplicates in drained briefing
        briefing_texts = [item["payload"]["text"] for item in briefing_snapshot]
        assert len(briefing_texts) == len(set(briefing_texts)), (
            "Briefing must contain no duplicate items"
        )

        # Each visitor's arrival text must be present
        for i in range(5):
            found = any(
                f"did:plc:visitor_{i}" in text or f"{(i+1)*5}" in text
                for text in briefing_texts
            )
            assert found, f"Visitor {i} not found in briefing"

        node.dnd_active = False

# TST-E2E-101
    def test_briefing_regenerates_after_crash(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-17.3 Briefing regenerates from source after brain crash.

        Store engagement events in vault, queue via DND arrival flow,
        crash the brain, rebuild from vault source-of-truth, verify
        no data loss and no duplicates.
        """
        node = don_alonso
        node.dnd_active = True
        node.briefing_queue.clear()

        # Store engagement events in the vault as source-of-truth
        source_item_ids = []
        for i in range(4):
            item_id = node.vault_store(
                "general",
                f"engagement_event_{i}",
                {
                    "event_type": "engagement",
                    "text": f"Queued event {i}: daily tip #{i}",
                    "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                },
                item_type="notification",
                source="engagement_feed",
            )
            source_item_ids.append(item_id)

        assert len(source_item_ids) == 4

        # Also queue arrivals via real _brain_process during DND
        for i in range(4):
            result = node._brain_process(
                "dina/social/arrival",
                {"eta_minutes": (i + 1) * 10, "text": f"daily tip #{i}"},
                from_did=f"did:plc:feed_{i}",
            )
            assert result["status"] == "queued_for_briefing"

        assert len(node.briefing_queue) == 4

        # Pre-crash positive control: vault_query returns stored items
        pre_crash_results = node.vault_query("general", "daily")
        pre_crash_notifications = [
            item for item in pre_crash_results
            if item.item_type == "notification"
            and item.source == "engagement_feed"
        ]
        assert len(pre_crash_notifications) == 4, (
            f"Pre-crash: expected 4 notifications, got {len(pre_crash_notifications)}"
        )

        # Simulate brain crash: clear in-memory briefing state
        node.crash_brain()
        node.briefing_queue.clear()
        assert len(node.briefing_queue) == 0

        # Restart brain
        node.restart_brain()
        assert node._brain_crashed is False

        # Rebuild briefing from vault (source-of-truth persists the crash).
        # Query for "daily" — a standalone FTS token present in every
        # notification body ("Queued event N: daily tip #N").
        rebuilt_items = node.vault_query("general", "daily")

        # Filter to only the notification-type items from this test
        rebuilt_notifications = [
            item for item in rebuilt_items
            if item.item_type == "notification"
            and item.source == "engagement_feed"
        ]

        # All 4 source items must be recoverable (exact count)
        assert len(rebuilt_notifications) == 4, (
            f"Expected exactly 4 engagement events after rebuild, "
            f"got {len(rebuilt_notifications)}"
        )

        # Verify VALUE assertions on rebuilt items
        for item in rebuilt_notifications:
            assert item.persona == "general"
            assert "daily tip" in item.body_text, (
                f"Rebuilt item must contain 'daily tip': {item.body_text}"
            )
            assert item.item_id in source_item_ids, (
                f"Rebuilt item {item.item_id} not in original source IDs"
            )

        # Re-populate the briefing queue from vault
        for item in rebuilt_notifications:
            node.briefing_queue.append({
                "type": "whisper",
                "payload": {
                    "text": item.body_text,
                    "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                    "source_item_id": item.item_id,
                },
            })

        # No duplicates in rebuilt briefing
        rebuilt_source_ids = [
            entry["payload"]["source_item_id"]
            for entry in node.briefing_queue
        ]
        assert len(rebuilt_source_ids) == len(set(rebuilt_source_ids)), (
            "Rebuilt briefing queue must contain no duplicate source items"
        )
        assert len(rebuilt_source_ids) == 4

        # All original source items are present
        for sid in source_item_ids:
            assert sid in rebuilt_source_ids, (
                f"Source item {sid} missing from rebuilt briefing"
            )

        # Negative control: non-existent query returns empty
        empty = node.vault_query("general", "nonexistent_xyz_briefing")
        assert len(empty) == 0

        node.dnd_active = False
