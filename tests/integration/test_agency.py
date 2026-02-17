"""Integration tests for user agency protection.

Behavioral contracts tested:
- Impulse protection: Dina detects emotional purchase triggers and flags
  items not on the user's pre-approved list.
- Manipulation detection: Dina identifies deceptive ads, dark patterns,
  fake urgency, and dead-internet bot traffic.

Dina is the user's guardian — she protects the user from external
manipulation AND from their own impulses.
"""

from __future__ import annotations

import pytest
import time

from tests.integration.mocks import (
    ActionRisk,
    MockDinaCore,
    MockHuman,
    MockPythonBrain,
    MockVault,
    Notification,
    PaymentIntent,
    PersonaType,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def detect_emotional_state(messages: list[dict]) -> str:
    """Detect the user's current emotional state from recent messages."""
    stress_keywords = {"stressed", "angry", "frustrated", "upset", "anxious",
                       "sad", "depressed", "bored", "lonely"}
    calm_keywords = {"good", "fine", "great", "happy", "relaxed", "content"}

    stress_count = 0
    calm_count = 0
    for msg in messages:
        content_lower = msg.get("content", "").lower()
        stress_count += sum(1 for kw in stress_keywords if kw in content_lower)
        calm_count += sum(1 for kw in calm_keywords if kw in content_lower)

    if stress_count > calm_count and stress_count >= 2:
        return "elevated"
    return "calm"


def is_on_purchase_list(vault: MockVault, product_id: str) -> bool:
    """Check if a product is on the user's pre-approved purchase list."""
    purchase_list = vault.retrieve(0, "purchase_list")
    if purchase_list is None:
        return False
    return product_id in purchase_list.get("items", [])


def analyze_ad_content(content: str) -> dict:
    """Analyze ad/product page content for manipulation tactics."""
    flags = []

    deceptive_patterns = [
        ("fake_review", ["as seen on", "doctors recommend", "miracle"]),
        ("urgency", ["only 2 left", "limited time", "act now", "expires soon",
                      "flash sale", "last chance"]),
        ("dark_pattern", ["pre-checked", "hidden fee", "auto-subscribe",
                          "negative option", "confirm shaming"]),
        ("social_proof_fake", ["10000 people", "trending", "everyone is buying",
                               "viral"]),
    ]

    content_lower = content.lower()
    for pattern_name, keywords in deceptive_patterns:
        if any(kw in content_lower for kw in keywords):
            flags.append(pattern_name)

    return {
        "is_clean": len(flags) == 0,
        "flags": flags,
        "risk_score": min(1.0, len(flags) * 0.3),
    }


def detect_dead_internet(sources: list[dict]) -> dict:
    """Filter sources for dead-internet bot signatures."""
    bot_indicators = {"generic_review", "templated", "no_purchase_verified",
                      "age_0_days", "burst_reviews"}
    flagged = []
    clean = []

    for source in sources:
        indicators_found = set(source.get("indicators", [])) & bot_indicators
        if indicators_found:
            flagged.append({**source, "bot_flags": list(indicators_found)})
        else:
            clean.append(source)

    return {
        "clean_sources": clean,
        "flagged_sources": flagged,
        "bot_ratio": len(flagged) / max(len(sources), 1),
    }


# =========================================================================
# TestImpulseProtection
# =========================================================================

class TestImpulseProtection:
    """Dina protects the user from emotional purchasing impulses."""

    def test_emotional_state_detection(self, mock_dina: MockDinaCore):
        """Dina detects elevated emotional state from recent conversation."""
        messages = [
            {"content": "I'm so stressed about work deadlines"},
            {"content": "Everything is going wrong, I'm frustrated"},
            {"content": "I just want to buy something to feel better"},
        ]
        state = detect_emotional_state(messages)
        assert state == "elevated"

    def test_calm_state_not_flagged(self, mock_dina: MockDinaCore):
        """A calm user is not flagged for impulse protection."""
        messages = [
            {"content": "Having a great day today"},
            {"content": "I'd like to buy new headphones for the commute"},
        ]
        state = detect_emotional_state(messages)
        assert state == "calm"

    def test_purchase_not_on_list_flagged(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ):
        """If a product is NOT on the pre-approved purchase list and the user
        is in an elevated emotional state, Dina flags it."""
        # Set up purchase list
        mock_dina.vault.store(0, "purchase_list", {
            "items": ["thinkpad_x1_2025", "aeron_2025"],
        })

        # Product NOT on the list
        assert is_on_purchase_list(mock_dina.vault, "random_gadget_001") is False

        # Emotional state is elevated
        messages = [
            {"content": "I'm so stressed and anxious"},
            {"content": "I need to buy something NOW"},
        ]
        state = detect_emotional_state(messages)
        assert state == "elevated"

        # Dina flags the purchase
        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Impulse purchase detected",
            body=("This item isn't on your purchase list, and you seem "
                  "stressed right now. Want to add it to your list and "
                  "revisit tomorrow?"),
            actions=["Add to list", "Buy anyway", "Cancel"],
        )
        mock_human.receive_notification(notification)

        assert notification.tier == SilenceTier.TIER_1_FIDUCIARY
        assert len(mock_human.notifications) == 1
        assert "purchase list" in mock_human.notifications[0].body

    def test_purchase_on_list_passes(self, mock_dina: MockDinaCore):
        """A product that IS on the list proceeds without flagging,
        regardless of emotional state."""
        mock_dina.vault.store(0, "purchase_list", {
            "items": ["thinkpad_x1_2025", "aeron_2025"],
        })
        assert is_on_purchase_list(mock_dina.vault, "thinkpad_x1_2025") is True

    def test_user_can_override(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ):
        """Even after being flagged, the user can say 'Buy anyway' and
        Dina complies — she protects but never blocks."""
        mock_human.set_approval("impulse_purchase", True)
        approved = mock_human.approve("impulse_purchase")
        assert approved is True

        # Create and execute the payment
        intent = PaymentIntent(
            intent_id="impulse_001",
            method="upi",
            intent_uri="upi://pay?pa=seller@upi",
            merchant="Random Gadget Store",
            amount=2999.0,
            currency="INR",
            recommendation="Wait 24 hours",
        )
        mock_dina.staging.store_payment_intent(intent)
        stored = mock_dina.staging.get("impulse_001")
        assert stored is not None
        assert stored.amount == 2999.0


# =========================================================================
# TestManipulationDetection
# =========================================================================

class TestManipulationDetection:
    """Dina identifies and flags manipulation in the commercial environment."""

    def test_deceptive_ad(self, mock_dina: MockDinaCore, mock_human: MockHuman):
        """Dina flags ads with unverifiable claims."""
        ad_content = (
            "MIRACLE weight loss pill! As seen on TV! "
            "Doctors recommend this breakthrough formula!"
        )
        analysis = analyze_ad_content(ad_content)
        assert analysis["is_clean"] is False
        assert "fake_review" in analysis["flags"]

        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Deceptive advertising detected",
            body=f"This ad contains unverifiable claims: {', '.join(analysis['flags'])}",
            actions=["Block source", "Ignore", "Report"],
        )
        mock_human.receive_notification(notification)
        assert notification.tier == SilenceTier.TIER_1_FIDUCIARY

    def test_dark_pattern_in_checkout(self, mock_dina: MockDinaCore):
        """Dina detects dark patterns in checkout flows — pre-checked
        add-ons, hidden fees, confirm shaming."""
        checkout_content = (
            "Complete your order! "
            "Insurance pre-checked for your convenience. "
            "Hidden fee: processing charge $4.99. "
            "No thanks, I don't want to protect my purchase (confirm shaming)."
        )
        analysis = analyze_ad_content(checkout_content)
        assert analysis["is_clean"] is False
        assert "dark_pattern" in analysis["flags"]
        assert analysis["risk_score"] > 0

    def test_fake_urgency(self, mock_dina: MockDinaCore):
        """Dina detects manufactured urgency — 'Only 2 left!' when the
        count never changes."""
        page_content = "Only 2 left in stock! Act now! Limited time offer!"
        analysis = analyze_ad_content(page_content)
        assert analysis["is_clean"] is False
        assert "urgency" in analysis["flags"]

    def test_dead_internet_filter(self, mock_dina: MockDinaCore):
        """Dina filters out bot-generated reviews from the reputation graph,
        keeping only verified human sources."""
        sources = [
            {
                "source_id": "review_1",
                "type": "expert",
                "creator": "MKBHD",
                "indicators": ["purchase_verified", "long_form"],
            },
            {
                "source_id": "review_2",
                "type": "user_review",
                "creator": "user_abc123",
                "indicators": ["generic_review", "age_0_days", "templated"],
            },
            {
                "source_id": "review_3",
                "type": "user_review",
                "creator": "user_def456",
                "indicators": ["purchase_verified", "detailed"],
            },
            {
                "source_id": "review_4",
                "type": "user_review",
                "creator": "user_ghi789",
                "indicators": ["burst_reviews", "no_purchase_verified"],
            },
        ]

        result = detect_dead_internet(sources)
        assert len(result["clean_sources"]) == 2
        assert len(result["flagged_sources"]) == 2
        assert result["bot_ratio"] == pytest.approx(0.5)

        # Clean sources retain the trusted ones
        clean_ids = {s["source_id"] for s in result["clean_sources"]}
        assert "review_1" in clean_ids  # MKBHD expert review
        assert "review_3" in clean_ids  # Verified user review

        # Flagged sources are the bots
        flagged_ids = {s["source_id"] for s in result["flagged_sources"]}
        assert "review_2" in flagged_ids
        assert "review_4" in flagged_ids
