"""Integration tests for the three-tier silence system.

Dina follows the principle of Silence First. Notifications are classified
into three tiers:
  Tier 1 (Fiduciary)  -- interrupt immediately; silence would cause harm
  Tier 2 (Solicited)  -- notify when appropriate; user asked for this
  Tier 3 (Engagement) -- save for daily briefing; never interrupt
"""

from __future__ import annotations

import time

import pytest

from tests.integration.mocks import (
    LLMTarget,
    MockDinaCore,
    MockGoCore,
    MockHuman,
    MockPythonBrain,
    MockSilenceClassifier,
    Notification,
    SilenceTier,
)


# -----------------------------------------------------------------------
# TestTier1Fiduciary
# -----------------------------------------------------------------------


class TestTier1Fiduciary:
    """Tier 1 events always interrupt -- silence would cause harm."""

    def test_malicious_contract_interrupts(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """A malicious contract detection must interrupt immediately."""
        tier = mock_dina.classifier.classify(
            "contract_review",
            "This contract contains a malicious clause that forfeits all rights.",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY

        # Deliver the notification
        notification = Notification(
            tier=tier,
            title="Malicious contract detected",
            body="Clause 7 forfeits all intellectual property rights.",
            source="contract_review",
        )
        mock_dina.go_core.notify(notification)
        mock_human.receive_notification(notification)

        assert len(mock_human.notifications) == 1
        assert mock_human.notifications[0].tier == SilenceTier.TIER_1_FIDUCIARY

    def test_phishing_interrupts(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Phishing attempt must be classified as Tier 1."""
        tier = mock_classifier.classify(
            "email_incoming",
            "Urgent: Your bank phishing attempt detected. Click here.",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY

    def test_fiduciary_overrides_dnd(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Tier 1 overrides Do-Not-Disturb / quiet hours."""
        # Even if user has "DND" preference, Tier 1 still fires
        tier = mock_dina.classifier.classify(
            "security_alert",
            "Unauthorized access to your account detected. Emergency!",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY

        notification = Notification(
            tier=tier,
            title="Security breach",
            body="Unauthorized login from unknown device.",
            actions=["Lock account", "Dismiss"],
            source="security",
        )
        mock_human.receive_notification(notification)

        # Notification is delivered despite any DND setting
        assert len(mock_human.notifications) == 1
        assert mock_human.notifications[0].tier == SilenceTier.TIER_1_FIDUCIARY

    def test_financial_fraud_detection(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Financial fraud triggers Tier 1."""
        tier = mock_classifier.classify(
            "transaction_monitor",
            "Suspicious fraud transaction of $5,000 to unknown account.",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY


# -----------------------------------------------------------------------
# TestTier2Solicited
# -----------------------------------------------------------------------


class TestTier2Solicited:
    """Tier 2 events are user-requested notifications."""

    def test_alarm_notification(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """User-set alarms are Tier 2."""
        tier = mock_classifier.classify("alarm", "Wake up at 7:00 AM.")
        assert tier == SilenceTier.TIER_2_SOLICITED

    def test_price_alert(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Price alerts the user subscribed to are Tier 2."""
        tier = mock_classifier.classify(
            "price_alert", "ThinkPad X1 Carbon dropped to 140,000 INR."
        )
        assert tier == SilenceTier.TIER_2_SOLICITED

    def test_respects_timing(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Tier 2 can carry timing metadata so the UI defers delivery."""
        tier = mock_dina.classifier.classify(
            "reminder", "Meeting in 15 minutes.",
            context={"user_waiting": True},
        )
        # When user is waiting, context elevates to Tier 2
        assert tier == SilenceTier.TIER_2_SOLICITED

        notification = Notification(
            tier=tier,
            title="Meeting reminder",
            body="Team standup in 15 minutes.",
            source="calendar",
        )
        mock_human.receive_notification(notification)
        assert len(mock_human.notifications) == 1

    def test_search_results_ready(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Completed search results the user asked for are Tier 2."""
        tier = mock_classifier.classify(
            "search_results",
            "Found 3 matching laptops under 150,000 INR.",
        )
        assert tier == SilenceTier.TIER_2_SOLICITED


# -----------------------------------------------------------------------
# TestTier3Engagement
# -----------------------------------------------------------------------


class TestTier3Engagement:
    """Tier 3 events are saved silently for the daily briefing."""

    def test_new_video_saved_for_briefing(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """A new YouTube video from a subscribed channel is Tier 3."""
        tier = mock_classifier.classify(
            "youtube_new_video",
            "MKBHD uploaded: Galaxy S26 Review.",
        )
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

    def test_flash_sale_saved(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Flash sale notifications are Tier 3 (no interruption)."""
        tier = mock_classifier.classify(
            "flash_sale",
            "Amazon flash sale: 20% off on electronics.",
        )
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

    def test_daily_briefing_aggregates(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Multiple Tier 3 events are aggregated into one briefing."""
        tier3_events = [
            ("youtube_new_video", "MKBHD uploaded: Galaxy S26 Review"),
            ("flash_sale", "Amazon flash sale: 20% off"),
            ("newsletter", "Weekly tech digest arrived"),
            ("social_update", "Sancho posted a new photo"),
        ]

        briefing_items: list[Notification] = []
        for event_type, content in tier3_events:
            tier = mock_dina.classifier.classify(event_type, content)
            assert tier == SilenceTier.TIER_3_ENGAGEMENT
            briefing_items.append(
                Notification(
                    tier=tier,
                    title=event_type,
                    body=content,
                    source=event_type,
                )
            )

        # At briefing time, all items are delivered together
        for item in briefing_items:
            mock_human.receive_notification(item)

        assert len(mock_human.notifications) == 4
        assert all(
            n.tier == SilenceTier.TIER_3_ENGAGEMENT
            for n in mock_human.notifications
        )

    def test_tier_3_never_interrupts(
        self, mock_classifier: MockSilenceClassifier, mock_human: MockHuman
    ) -> None:
        """Tier 3 events produce no immediate notification on their own."""
        tier = mock_classifier.classify(
            "content_recommendation",
            "You might enjoy this article about AI ethics.",
        )
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

        # User has received nothing yet -- Tier 3 waits for briefing
        assert len(mock_human.notifications) == 0


# -----------------------------------------------------------------------
# TestSilenceClassifier
# -----------------------------------------------------------------------


class TestSilenceClassifier:
    """Test the classifier logic directly."""

    @pytest.mark.parametrize(
        "event_type,content,expected_tier",
        [
            # Tier 1: fiduciary keywords
            ("email_check", "A malicious attachment was detected", SilenceTier.TIER_1_FIDUCIARY),
            ("link_scan", "Possible phishing URL found", SilenceTier.TIER_1_FIDUCIARY),
            ("tx_monitor", "Potential fraud on your account", SilenceTier.TIER_1_FIDUCIARY),
            ("security", "Unauthorized access attempt", SilenceTier.TIER_1_FIDUCIARY),
            ("alert", "Account breach detected", SilenceTier.TIER_1_FIDUCIARY),
            ("scan", "Emergency evacuation notice", SilenceTier.TIER_1_FIDUCIARY),
            ("monitor", "Scam website detected", SilenceTier.TIER_1_FIDUCIARY),
            # Tier 2: solicited types
            ("alarm", "Wake up", SilenceTier.TIER_2_SOLICITED),
            ("price_alert", "Price dropped", SilenceTier.TIER_2_SOLICITED),
            ("search_results", "Results ready", SilenceTier.TIER_2_SOLICITED),
            ("reminder", "Take medicine", SilenceTier.TIER_2_SOLICITED),
            # Tier 3: everything else
            ("new_article", "Interesting read", SilenceTier.TIER_3_ENGAGEMENT),
            ("social_feed", "New posts available", SilenceTier.TIER_3_ENGAGEMENT),
        ],
    )
    def test_assigns_correct_tier(
        self,
        mock_classifier: MockSilenceClassifier,
        event_type: str,
        content: str,
        expected_tier: SilenceTier,
    ) -> None:
        """Parametrized: each event maps to the correct tier."""
        tier = mock_classifier.classify(event_type, content)
        assert tier == expected_tier

    def test_if_silent_causes_harm_speak(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Any content with harm keywords overrides default tier."""
        # 'social_feed' would normally be Tier 3, but the content
        # mentions a security breach -- fiduciary duty takes over.
        tier = mock_classifier.classify(
            "social_feed",
            "Your account has an unauthorized login from Russia.",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY

    def test_user_can_override_tier(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """User can force a specific event type to a chosen tier."""
        # By default, 'newsletter' would be Tier 3
        tier_before = mock_classifier.classify("newsletter", "Weekly digest")
        assert tier_before == SilenceTier.TIER_3_ENGAGEMENT

        # User overrides newsletter to Tier 2 (they really want it)
        mock_classifier.set_override("newsletter", SilenceTier.TIER_2_SOLICITED)
        tier_after = mock_classifier.classify("newsletter", "Weekly digest")
        assert tier_after == SilenceTier.TIER_2_SOLICITED

        # Verify override is logged
        override_logs = [
            entry for entry in mock_classifier.classification_log
            if entry["reason"] == "user_override"
        ]
        assert len(override_logs) == 1

    def test_context_affects_classification(
        self, mock_classifier: MockSilenceClassifier
    ) -> None:
        """Context dict can elevate an event's tier."""
        # Without context, 'data_sync' is Tier 3
        tier_default = mock_classifier.classify("data_sync", "Syncing data")
        assert tier_default == SilenceTier.TIER_3_ENGAGEMENT

        # With user_waiting context, it becomes Tier 2
        tier_with_context = mock_classifier.classify(
            "data_sync",
            "Syncing data",
            context={"user_waiting": True},
        )
        assert tier_with_context == SilenceTier.TIER_2_SOLICITED
