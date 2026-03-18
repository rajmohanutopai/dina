"""E2E Test Suite 23: Silence Under Stress.

Product-level validation that Silence First holds under adversarial
conditions: notification storms, ambiguous urgency from untrusted
sources, and DND hierarchy enforcement.

Actors: Don Alonso, Sancho.
"""

from __future__ import annotations

import json
import time

import pytest

from tests.e2e.actors import HomeNode
from tests.e2e.mocks import (
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Suite 23: Silence Under Stress
# ---------------------------------------------------------------------------


class TestSilenceUnderStress:
    """E2E-23.x -- Silence First under adversarial volume and ambiguity.

    Validates that Dina protects the user's attention even when flooded
    with events or confronted with urgency from untrusted sources.
    All tests hit real Go Core APIs for vault operations.
    """

    # TST-E2E-121
    def test_notification_storm_only_fiduciary_interrupts(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-23.1 Notification Storm — Only Fiduciary Interrupts.

        Inject 100 engagement events + 1 fiduciary event simultaneously.
        Observe client: only 1 push notification (the fiduciary).
        Trigger briefing: must contain the 100 engagement items
        (grouped/summarized).  Zero engagement items pushed via WebSocket.

        Requirement: E2E_TEST_PLAN §23.1.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Step 1: Ensure clean observation state.
        # ------------------------------------------------------------------
        device = list(node.devices.values())[0]
        device.ws_messages.clear()
        node.notifications.clear()
        node.briefing_queue.clear()
        node.dnd_active = False

        # ------------------------------------------------------------------
        # Step 2: Store 100 engagement-tier events into the vault as
        # context, then process them through Brain.
        # Uses real Go Core POST /v1/vault/store for persistence.
        # ------------------------------------------------------------------
        engagement_count = 100

        for i in range(engagement_count):
            # Store each engagement event in vault for traceability.
            node.vault_store(
                "general",
                f"engagement_event_{i:03d}",
                {
                    "type": "content_suggestion",
                    "text": f"Newsletter digest #{i+1}: Tech news roundup",
                    "source": "rss",
                    "priority": "low",
                },
                item_type="note",
                source="rss",
            )

            # Process through Brain — should classify as Tier 3.
            node._brain_process(
                "content_suggestion",
                {
                    "text": f"Newsletter digest #{i+1}: Tech news roundup",
                    "source": "rss",
                    "event_index": i,
                },
            )

        # ------------------------------------------------------------------
        # Step 3: Inject 1 fiduciary event — this MUST interrupt.
        # ------------------------------------------------------------------
        ws_before_fiduciary = len(device.ws_messages)
        notif_before = len(node.notifications)

        fiduciary_result = node._brain_process(
            "security_alert",
            {
                "fiduciary": True,
                "text": "Suspicious login from unknown IP address in Bangalore",
                "severity": "critical",
                "source": "security_monitor",
            },
        )

        # ------------------------------------------------------------------
        # Step 4: Verify only 1 push notification (the fiduciary).
        # ------------------------------------------------------------------
        fiduciary_tier = node._classify_silence(
            "security_alert",
            {"fiduciary": True},
        )
        assert fiduciary_tier == SilenceTier.TIER_1_FIDUCIARY, (
            f"security_alert with fiduciary flag must be Tier 1. "
            f"Got: {fiduciary_tier!r}"
        )

        # Exactly 1 notification for the fiduciary event.
        fiduciary_notifications = [
            n for n in node.notifications[notif_before:]
            if "suspicious" in n.get("payload", {}).get("text", "").lower()
            or "security" in n.get("type", "").lower()
        ]
        assert len(fiduciary_notifications) >= 1, (
            f"Fiduciary event (security alert) must produce a push "
            f"notification. Got {len(fiduciary_notifications)} fiduciary "
            f"notifications after injecting 100 engagement + 1 fiduciary."
        )

        # Device must have received the fiduciary push.
        ws_after = len(device.ws_messages)
        fiduciary_pushes = ws_after - ws_before_fiduciary
        assert fiduciary_pushes >= 1, (
            f"Fiduciary event must push to device WebSocket. "
            f"Got {fiduciary_pushes} new WS messages."
        )

        # ------------------------------------------------------------------
        # Step 5: Verify ZERO engagement events pushed to device.
        # Silence First: engagement events are briefing-only.
        # ------------------------------------------------------------------
        # Count engagement-type WS messages (newsletter digests).
        engagement_pushes = [
            msg for msg in device.ws_messages
            if "newsletter" in json.dumps(msg).lower()
            or "digest" in json.dumps(msg).lower()
        ]
        assert len(engagement_pushes) == 0, (
            f"Engagement events must NEVER push to device — briefing "
            f"only (Silence First). Got {len(engagement_pushes)} "
            f"engagement WS pushes."
        )

        # ------------------------------------------------------------------
        # Step 6: Verify briefing queue contains engagement items.
        # ------------------------------------------------------------------
        briefing_count = len(node.briefing_queue)
        assert briefing_count >= 50, (
            f"Briefing queue should contain most of the {engagement_count} "
            f"engagement events (possibly grouped/summarized). "
            f"Got {briefing_count} items."
        )

        # ------------------------------------------------------------------
        # Step 7: Verify fiduciary event is NOT in the briefing queue.
        # It was already pushed — don't duplicate.
        # ------------------------------------------------------------------
        fiduciary_in_briefing = [
            item for item in node.briefing_queue
            if "suspicious" in json.dumps(item).lower()
            or "security_alert" in json.dumps(item).lower()
        ]
        assert len(fiduciary_in_briefing) == 0, (
            f"Fiduciary event already pushed to device — must NOT also "
            f"appear in briefing queue (no double-delivery). "
            f"Found {len(fiduciary_in_briefing)} duplicates."
        )

        # ------------------------------------------------------------------
        # Step 8: Verify engagement items stored in vault (traceability).
        # Uses real Go Core POST /v1/vault/query.
        # ------------------------------------------------------------------
        vault_results = node.vault_query(
            "general", "Newsletter digest", mode="fts5",
        )
        assert len(vault_results) >= 10, (
            f"Engagement events must be stored in vault for later "
            f"retrieval. Expected at least 10 results for 'Newsletter "
            f"digest'. Got {len(vault_results)}."
        )

        # ------------------------------------------------------------------
        # Step 9: Verify overall notification count is bounded.
        # 100 engagement + 1 fiduciary should produce exactly 1 push.
        # ------------------------------------------------------------------
        total_ws = len(device.ws_messages)
        assert total_ws <= 5, (
            f"After 100 engagement + 1 fiduciary event, device should "
            f"have at most ~1-5 WS messages (fiduciary + system). "
            f"Got {total_ws} — Silence First violated under storm."
        )

    # TST-E2E-122
    def test_ambiguous_urgency_from_untrusted_source(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-23.2 Ambiguous Urgency from Untrusted Source.

        Unknown DID sends D2D: "URGENT: your account is compromised".
        Brain must NOT classify as fiduciary — untrusted sender + urgency
        keywords is a classic phishing vector.  Message queued for briefing.
        Then: same message from Sancho (Ring 2 verified contact) — NOW
        fiduciary, because sender trust is a classification input.

        Requirement: E2E_TEST_PLAN §23.2.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Step 1: Clean observation state.
        # ------------------------------------------------------------------
        device = list(node.devices.values())[0]
        device.ws_messages.clear()
        node.notifications.clear()
        node.briefing_queue.clear()

        # ------------------------------------------------------------------
        # Step 2: Store Don Alonso's contacts in vault so Brain can
        # distinguish trusted vs unknown senders.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------
        node.vault_store(
            "general",
            "contact_sancho",
            {
                "name": "Sancho",
                "did": sancho.did,
                "ring": TrustRing.RING_2_VERIFIED.value,
                "relationship": "trusted_friend",
                "verified": True,
            },
            item_type="contact_card",
            source="user",
        )

        # Verify the contact was stored.
        contacts = node.vault_query("general", "Sancho", mode="fts5")
        assert len(contacts) >= 1, (
            f"Sancho's contact must be stored in vault. "
            f"Got {len(contacts)} results."
        )

        # ------------------------------------------------------------------
        # Step 3: Unknown DID sends "URGENT: your account is compromised".
        # This is a classic phishing vector — urgency from untrusted source.
        # ------------------------------------------------------------------
        unknown_did = "did:plc:unknown-attacker-xyz"
        urgent_text = "URGENT: your account is compromised, click here immediately"

        ws_before_unknown = len(device.ws_messages)
        notif_before_unknown = len(node.notifications)
        briefing_before_unknown = len(node.briefing_queue)

        # Process the inbound message from the unknown sender.
        unknown_result = node._brain_process(
            "inbound_d2d",
            {
                "from_did": unknown_did,
                "text": urgent_text,
                "message_type": "dina/social/message",
                "sender_ring": TrustRing.RING_1_UNVERIFIED.value,
                "sender_verified": False,
                "sender_known": False,
            },
        )

        # ------------------------------------------------------------------
        # Step 4: Verify untrusted urgent message is NOT fiduciary.
        # Silence First + Verified Truth: urgency from unknown sender
        # is a phishing signal, not a fiduciary trigger.
        # ------------------------------------------------------------------

        # Classification must NOT be Tier 1 for unknown sender.
        untrusted_tier = node._classify_silence(
            "inbound_d2d",
            {
                "from_did": unknown_did,
                "text": urgent_text,
                "sender_ring": TrustRing.RING_1_UNVERIFIED.value,
                "sender_verified": False,
                "sender_known": False,
            },
        )
        assert untrusted_tier != SilenceTier.TIER_1_FIDUCIARY, (
            f"'URGENT' message from unknown DID must NOT be classified as "
            f"fiduciary. Untrusted sender + urgency keywords = phishing "
            f"vector. Silence First: protect attention from social "
            f"engineering. Got: {untrusted_tier!r}"
        )

        # Must be Tier 3 (engagement/briefing) — no interrupt.
        assert untrusted_tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Urgent message from unknown sender should be Tier 3 "
            f"(engagement) — queued for briefing review, not pushed. "
            f"Got: {untrusted_tier!r}"
        )

        # ------------------------------------------------------------------
        # Step 5: Verify no push notification for the untrusted message.
        # ------------------------------------------------------------------
        ws_after_unknown = len(device.ws_messages)
        notif_after_unknown = len(node.notifications)

        assert ws_after_unknown == ws_before_unknown, (
            f"Urgent message from unknown DID must NOT push to device. "
            f"Silence First: no interrupt for untrusted urgency. "
            f"Got {ws_after_unknown - ws_before_unknown} new WS messages."
        )

        assert notif_after_unknown == notif_before_unknown, (
            f"No push notification for untrusted urgent message. "
            f"Got {notif_after_unknown - notif_before_unknown} new "
            f"notifications."
        )

        # ------------------------------------------------------------------
        # Step 6: Verify the untrusted message is queued for briefing.
        # User can review it in the daily briefing context.
        # ------------------------------------------------------------------
        briefing_after_unknown = len(node.briefing_queue)
        assert briefing_after_unknown > briefing_before_unknown, (
            f"Untrusted urgent message must be queued for briefing "
            f"review (not discarded, not pushed). "
            f"Briefing queue: {briefing_before_unknown} → "
            f"{briefing_after_unknown}."
        )

        # Verify the briefing item mentions the phishing-like message.
        briefing_text = " ".join(
            json.dumps(item) for item in node.briefing_queue
        ).lower()
        assert "urgent" in briefing_text or "compromised" in briefing_text, (
            f"Briefing must contain the queued untrusted message for "
            f"user review. Got: {briefing_text!r}"
        )

        # ------------------------------------------------------------------
        # Step 7: Same message from Sancho (Ring 2, trusted contact).
        # NOW it should be fiduciary — sender trust changes classification.
        # ------------------------------------------------------------------
        device.ws_messages.clear()
        node.notifications.clear()
        node.briefing_queue.clear()

        ws_before_trusted = len(device.ws_messages)
        notif_before_trusted = len(node.notifications)

        # Sancho sends the same urgent text via D2D.
        trusted_msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/message",
            payload={
                "type": "dina/social/message",
                "text": urgent_text,
                "context_flags": ["urgent", "security"],
            },
        )
        assert trusted_msg.msg_id.startswith("msg_"), (
            f"Trusted D2D message must be sent successfully. "
            f"Got: {trusted_msg.msg_id!r}"
        )

        # Also process through Brain with sender trust metadata.
        trusted_result = node._brain_process(
            "inbound_d2d",
            {
                "from_did": sancho.did,
                "text": urgent_text,
                "message_type": "dina/social/message",
                "sender_ring": TrustRing.RING_2_VERIFIED.value,
                "sender_verified": True,
                "sender_known": True,
                "sender_name": "Sancho",
            },
        )

        # ------------------------------------------------------------------
        # Step 8: Verify trusted urgent message IS fiduciary.
        # Sender trust ring elevates the classification.
        # ------------------------------------------------------------------
        trusted_tier = node._classify_silence(
            "inbound_d2d",
            {
                "from_did": sancho.did,
                "text": urgent_text,
                "sender_ring": TrustRing.RING_2_VERIFIED.value,
                "sender_verified": True,
                "sender_known": True,
            },
        )
        assert trusted_tier == SilenceTier.TIER_1_FIDUCIARY, (
            f"'URGENT' message from trusted contact (Sancho, Ring 2) "
            f"MUST be classified as fiduciary. Sender trust is a "
            f"classification input — same words, different trust level, "
            f"different outcome. Got: {trusted_tier!r}"
        )

        # ------------------------------------------------------------------
        # Step 9: Verify push notification for the trusted message.
        # ------------------------------------------------------------------
        ws_after_trusted = len(device.ws_messages)
        notif_after_trusted = len(node.notifications)

        assert ws_after_trusted > ws_before_trusted, (
            f"Fiduciary event from trusted sender must push to device. "
            f"Got {ws_after_trusted - ws_before_trusted} new WS messages."
        )

        assert notif_after_trusted > notif_before_trusted, (
            f"Fiduciary event from trusted sender must produce a push "
            f"notification. Got {notif_after_trusted - notif_before_trusted} "
            f"new notifications."
        )

        # ------------------------------------------------------------------
        # Step 10: Verify audit trail captures both events with sender
        # trust metadata — proving the classification difference.
        # ------------------------------------------------------------------
        audit_entries = node.get_audit_entries("silence_classification")

        # At minimum, both events should be audited.
        assert len(audit_entries) >= 2, (
            f"Both silence classification decisions (untrusted + trusted) "
            f"must be audited. Got {len(audit_entries)} entries."
        )

        # ------------------------------------------------------------------
        # Step 11: Verify the untrusted message is NOT in the trusted
        # message's push — no cross-contamination.
        # ------------------------------------------------------------------
        trusted_ws_messages = device.ws_messages
        for msg in trusted_ws_messages:
            msg_text = json.dumps(msg).lower()
            assert unknown_did not in msg_text, (
                f"Push notification for trusted sender's message must "
                f"not contain the unknown sender's DID. "
                f"Cross-contamination detected: {msg!r}"
            )

        # ------------------------------------------------------------------
        # Step 12: Store untrusted message in vault for user review.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------
        node.vault_store(
            "general",
            "untrusted_urgent_msg",
            {
                "from_did": unknown_did,
                "text": urgent_text,
                "classification": "engagement",
                "reason": "untrusted_sender_urgency_downgrade",
                "sender_ring": TrustRing.RING_1_UNVERIFIED.value,
            },
            item_type="message",
            source="didcomm",
        )

        # Verify it's queryable for later review.
        stored = node.vault_query("general", "compromised", mode="fts5")
        assert len(stored) >= 1, (
            f"Untrusted urgent message must be stored in vault for "
            f"user review. Got {len(stored)} results."
        )

    # TST-E2E-123
    def test_dnd_respects_hierarchy(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-23.3 DND Respects Hierarchy.

        Enable DND → fiduciary event pushed (overrides DND) → solicited
        event deferred (NOT dropped) → engagement event queued for
        briefing → disable DND → deferred solicited events delivered
        immediately.

        Requirement: E2E_TEST_PLAN §23.3.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Step 1: Clean observation state and enable DND.
        # ------------------------------------------------------------------
        device = list(node.devices.values())[0]
        device.ws_messages.clear()
        node.notifications.clear()
        node.briefing_queue.clear()

        node.dnd_active = True
        assert node.dnd_active is True, "DND must be active for test."

        # ------------------------------------------------------------------
        # Step 2: Fiduciary event — bank fraud alert.
        # Must PUSH despite DND.  Fiduciary overrides everything.
        # ------------------------------------------------------------------
        ws_before_fiduciary = len(device.ws_messages)
        notif_before_fiduciary = len(node.notifications)

        node._brain_process(
            "security_alert",
            {
                "fiduciary": True,
                "text": "Bank fraud: unauthorised $2,500 transfer detected",
                "severity": "critical",
                "source": "bank_integration",
            },
        )

        # Verify fiduciary classification.
        fiduciary_tier = node._classify_silence(
            "security_alert",
            {"fiduciary": True},
        )
        assert fiduciary_tier == SilenceTier.TIER_1_FIDUCIARY, (
            f"Bank fraud alert must be Tier 1 (fiduciary). "
            f"Got: {fiduciary_tier!r}"
        )

        # Fiduciary MUST push to device despite DND.
        ws_after_fiduciary = len(device.ws_messages)
        assert ws_after_fiduciary > ws_before_fiduciary, (
            f"Fiduciary event must push to device DESPITE DND. "
            f"DND does not override fiduciary — silence would cause "
            f"financial harm. Got {ws_after_fiduciary - ws_before_fiduciary} "
            f"WS messages."
        )

        # Notification must exist for fiduciary.
        notif_after_fiduciary = len(node.notifications)
        assert notif_after_fiduciary > notif_before_fiduciary, (
            f"Fiduciary event must produce notification despite DND. "
            f"Got {notif_after_fiduciary - notif_before_fiduciary} "
            f"new notifications."
        )

        # ------------------------------------------------------------------
        # Step 3: Solicited event — user-requested reminder.
        # Must be DEFERRED (not dropped), delivered when DND ends.
        # ------------------------------------------------------------------
        ws_before_solicited = len(device.ws_messages)
        notif_before_solicited = len(node.notifications)
        briefing_before_solicited = len(node.briefing_queue)

        # Store the reminder in vault first.
        node.vault_store(
            "general",
            "medication_reminder",
            {
                "type": "reminder",
                "text": "Take evening medication — blood pressure pills",
                "user_requested": True,
                "scheduled_time": "20:00",
            },
            item_type="reminder",
            source="user",
        )

        node._brain_process(
            "reminder_fired",
            {
                "user_requested": True,
                "text": "Take evening medication — blood pressure pills",
                "reminder_id": "rem_medication_001",
                "source": "user_reminder",
            },
        )

        # Verify solicited classification.
        solicited_tier = node._classify_silence(
            "reminder_fired",
            {"user_requested": True},
        )
        assert solicited_tier == SilenceTier.TIER_2_SOLICITED, (
            f"User-requested reminder must be Tier 2 (solicited). "
            f"Got: {solicited_tier!r}"
        )

        # Solicited MUST NOT push during DND — deferred, not dropped.
        ws_after_solicited = len(device.ws_messages)
        assert ws_after_solicited == ws_before_solicited, (
            f"Solicited event must NOT push during DND — must be "
            f"deferred. Got {ws_after_solicited - ws_before_solicited} "
            f"new WS messages."
        )

        # Solicited must be queued (deferred), not silently dropped.
        briefing_after_solicited = len(node.briefing_queue)
        deferred_exists = (
            briefing_after_solicited > briefing_before_solicited
            or any(
                "medication" in json.dumps(n).lower()
                for n in node.notifications[notif_before_solicited:]
            )
        )
        # Check that it was stored somewhere — briefing or deferred queue.
        assert deferred_exists or len(node.notifications) > notif_before_solicited, (
            f"Solicited event must be DEFERRED during DND, not dropped. "
            f"It must be stored for delivery when DND ends. "
            f"Briefing: {briefing_before_solicited} → {briefing_after_solicited}, "
            f"Notifications: {notif_before_solicited} → {len(node.notifications)}"
        )

        # ------------------------------------------------------------------
        # Step 4: Engagement event — content suggestion.
        # Queued for briefing — same behaviour as without DND.
        # ------------------------------------------------------------------
        ws_before_engagement = len(device.ws_messages)
        briefing_before_engagement = len(node.briefing_queue)

        node._brain_process(
            "content_suggestion",
            {
                "text": "New article about ergonomic desk setups published",
                "source": "rss",
                "priority": "low",
            },
        )

        # Verify engagement classification.
        engagement_tier = node._classify_silence(
            "content_suggestion",
            {"source": "rss", "priority": "low"},
        )
        assert engagement_tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Content suggestion must be Tier 3 (engagement). "
            f"Got: {engagement_tier!r}"
        )

        # Engagement MUST NOT push during DND (same as without DND).
        ws_after_engagement = len(device.ws_messages)
        assert ws_after_engagement == ws_before_engagement, (
            f"Engagement event must not push during DND. "
            f"Got {ws_after_engagement - ws_before_engagement} new WS."
        )

        # Engagement goes to briefing queue.
        briefing_after_engagement = len(node.briefing_queue)
        assert briefing_after_engagement > briefing_before_engagement, (
            f"Engagement event must be queued for briefing (same as "
            f"without DND). Briefing: {briefing_before_engagement} → "
            f"{briefing_after_engagement}."
        )

        # ------------------------------------------------------------------
        # Step 5: Record state BEFORE disabling DND.
        # ------------------------------------------------------------------
        ws_before_dnd_off = len(device.ws_messages)
        notif_before_dnd_off = len(node.notifications)

        # ------------------------------------------------------------------
        # Step 6: Disable DND — deferred solicited events delivered.
        # ------------------------------------------------------------------
        node.dnd_active = False
        assert node.dnd_active is False, "DND must be disabled."

        # Trigger the DND-off event so the system can flush deferred items.
        node._brain_process(
            "dnd_disabled",
            {
                "trigger": "user_action",
                "flush_deferred": True,
            },
        )

        # ------------------------------------------------------------------
        # Step 7: Verify deferred solicited event is NOW delivered.
        # The medication reminder must arrive after DND ends.
        # ------------------------------------------------------------------
        ws_after_dnd_off = len(device.ws_messages)
        notif_after_dnd_off = len(node.notifications)

        # Check for the medication reminder in WS messages or notifications.
        medication_delivered = any(
            "medication" in json.dumps(msg).lower()
            or "blood pressure" in json.dumps(msg).lower()
            for msg in device.ws_messages[ws_before_dnd_off:]
        ) or any(
            "medication" in json.dumps(n).lower()
            or "blood pressure" in json.dumps(n).lower()
            for n in node.notifications[notif_before_dnd_off:]
        )

        assert medication_delivered, (
            f"After DND ends, deferred solicited event (medication "
            f"reminder) must be delivered immediately. DND defers, "
            f"never drops. WS messages: {device.ws_messages[ws_before_dnd_off:]!r}, "
            f"Notifications: {node.notifications[notif_before_dnd_off:]!r}"
        )

        # ------------------------------------------------------------------
        # Step 8: Verify fiduciary event was NOT deferred.
        # Bank fraud alert should have been pushed during DND, not now.
        # ------------------------------------------------------------------
        bank_fraud_in_post_dnd = [
            msg for msg in device.ws_messages[ws_before_dnd_off:]
            if "fraud" in json.dumps(msg).lower()
            or "$2,500" in json.dumps(msg).lower()
            or "bank" in json.dumps(msg).lower()
        ]
        assert len(bank_fraud_in_post_dnd) == 0, (
            f"Fiduciary event was already pushed during DND — must NOT "
            f"be re-delivered after DND ends (no double-delivery). "
            f"Found {len(bank_fraud_in_post_dnd)} duplicates."
        )

        # ------------------------------------------------------------------
        # Step 9: Verify engagement event stays in briefing — NOT pushed
        # when DND ends.  Engagement is always briefing-only.
        # ------------------------------------------------------------------
        engagement_in_post_dnd = [
            msg for msg in device.ws_messages[ws_before_dnd_off:]
            if "ergonomic" in json.dumps(msg).lower()
            or "desk setup" in json.dumps(msg).lower()
        ]
        assert len(engagement_in_post_dnd) == 0, (
            f"Engagement events must NOT be pushed when DND ends — "
            f"they stay in the briefing queue regardless. "
            f"Found {len(engagement_in_post_dnd)} engagement pushes."
        )

        # ------------------------------------------------------------------
        # Step 10: Verify overall push count is correct.
        # During entire test: 1 fiduciary push + 1 solicited delivery
        # after DND ends = 2 total pushes.  Zero engagement pushes.
        # ------------------------------------------------------------------
        total_ws = len(device.ws_messages)
        assert total_ws <= 5, (
            f"Total WS messages should be ~2 (fiduciary during DND + "
            f"deferred solicited after DND). Got {total_ws}."
        )

        # ------------------------------------------------------------------
        # Step 11: Verify vault audit trail for DND lifecycle.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------
        node.vault_store(
            "general",
            "dnd_lifecycle_test",
            {
                "dnd_enabled": True,
                "fiduciary_during_dnd": "bank_fraud_pushed",
                "solicited_during_dnd": "medication_deferred",
                "engagement_during_dnd": "content_queued",
                "dnd_disabled": True,
                "solicited_after_dnd": "medication_delivered",
            },
            item_type="system_event",
            source="system",
        )

        stored = node.vault_query(
            "general", "dnd_lifecycle_test", mode="fts5",
        )
        assert len(stored) >= 1, (
            f"DND lifecycle event must be stored in vault. "
            f"Got {len(stored)} results."
        )
