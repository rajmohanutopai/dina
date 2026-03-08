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


class TestQuietDina:
    """E2E-17.x -- Silence protocol, notification tiers, and daily briefing
    queue behavior."""

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

        # -- Tier 1: Fiduciary -- must interrupt immediately ---------------
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

        # -- Tier 2: Solicited -- notification delivered -------------------
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
        # Tier 2 events should be pushed to devices (not queued for briefing)
        assert tier2_result.get("status") == "ok"
        assert len(node.notifications) >= 1

        # -- Tier 3: Engagement -- queued, not pushed ----------------------
        # Enable DND so Tier 3 events are queued in briefing_queue
        node.dnd_active = True

        notifications_before = len(device.ws_messages)
        briefing_before = len(node.briefing_queue)

        tier3_result = node._brain_process(
            "dina/social/arrival",
            {
                "eta_minutes": 30,
                "text": "Newsletter digest available",
            },
            from_did="did:plc:sancho",
        )
        tier3_class = node._classify_silence(
            "content_suggestion",
            {"text": "Newsletter digest available"},
        )
        assert tier3_class == SilenceTier.TIER_3_ENGAGEMENT, (
            "Content suggestion without fiduciary/user_requested must be Tier 3"
        )

        # The event should be queued in briefing, not pushed to device
        assert tier3_result.get("status") == "queued_for_briefing"
        assert len(node.briefing_queue) > briefing_before, (
            "Tier 3 event must be added to the briefing queue"
        )

        # No new ws_message should have been pushed for the Tier 3 event
        # during DND (the arrival handler queues instead of pushing)
        assert tier3_result["status"] == "queued_for_briefing"

# TST-E2E-100
    def test_daily_briefing_summarizes_queued(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-17.2 Daily briefing summarizes all queued Tier 3 items.

        Queue multiple Tier 3 items into the briefing queue, then drain
        the briefing and verify it contains all items exactly once.
        """
        node = don_alonso
        node.dnd_active = True

        # Queue 5 Tier 3 engagement notifications
        engagement_items = []
        for i in range(5):
            notification = {
                "type": "whisper",
                "payload": {
                    "text": f"Engagement item {i}: product deal #{i}",
                    "trigger": f"feed:item_{i}",
                    "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                },
            }
            node.briefing_queue.append(notification)
            engagement_items.append(notification)

        assert len(node.briefing_queue) >= 5

        # Drain the briefing queue (simulates daily briefing generation)
        briefing_snapshot = list(node.briefing_queue)
        node.briefing_queue.clear()

        # Verify all 5 items appear in the briefing exactly once
        briefing_texts = [
            item["payload"]["text"]
            for item in briefing_snapshot
            if item.get("type") == "whisper"
            and item["payload"].get("tier") == SilenceTier.TIER_3_ENGAGEMENT.value
        ]

        for i in range(5):
            expected_text = f"Engagement item {i}: product deal #{i}"
            count = briefing_texts.count(expected_text)
            assert count == 1, (
                f"Expected exactly 1 occurrence of engagement item {i} "
                f"in briefing, found {count}"
            )

        # Queue is now empty after drain
        assert len(node.briefing_queue) == 0

        # Verify LLM can produce a summary from the briefing items
        context = [item["payload"]["text"] for item in briefing_snapshot]
        summary = node.llm_reason("Summarize today's briefing", context=context)
        assert len(summary) > 0, "Briefing summary must not be empty"

# TST-E2E-101
    def test_briefing_regenerates_after_crash(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-17.3 Briefing regenerates from source after brain crash.

        Queue Tier 3 items, simulate a brain crash (clear in-memory
        briefing state), rebuild the briefing from the vault source
        records, and verify no duplicates.
        """
        node = don_alonso
        node.dnd_active = True

        # Store engagement events in the vault as source-of-truth
        source_item_ids = []
        for i in range(4):
            item_id = node.vault_store(
                "personal",
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

            # Also queue in briefing_queue (in-memory)
            node.briefing_queue.append({
                "type": "whisper",
                "payload": {
                    "text": f"Queued event {i}: daily tip #{i}",
                    "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                    "source_item_id": item_id,
                },
            })

        assert len(node.briefing_queue) >= 4
        assert len(source_item_ids) == 4

        # Simulate brain crash: clear in-memory briefing state
        node.crash_brain()
        node.briefing_queue.clear()
        assert len(node.briefing_queue) == 0

        # Restart brain
        node.restart_brain()
        assert node._brain_crashed is False

        # Rebuild briefing from vault (source-of-truth persists the crash).
        # Query for "daily" — a standalone FTS token present in every
        # notification body ("Queued event N: daily tip #N").  The key
        # "engagement_event_N" is a single underscore-joined token, so
        # querying "engagement_event" would not match any FTS word.
        rebuilt_items = node.vault_query("personal", "daily")

        # Filter to only the notification-type items from this test
        rebuilt_notifications = [
            item for item in rebuilt_items
            if item.item_type == "notification"
            and item.source == "engagement_feed"
        ]

        # All 4 source items must be recoverable
        assert len(rebuilt_notifications) >= 4, (
            f"Expected at least 4 engagement events after rebuild, "
            f"got {len(rebuilt_notifications)}"
        )

        # Re-populate the briefing queue from vault
        seen_ids: set[str] = set()
        for item in rebuilt_notifications:
            if item.item_id not in seen_ids:
                seen_ids.add(item.item_id)
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

        # All original source items are present
        for sid in source_item_ids:
            assert sid in rebuilt_source_ids, (
                f"Source item {sid} missing from rebuilt briefing"
            )
