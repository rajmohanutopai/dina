"""Integration tests for cart handover — Dina advises but never touches money.

Dina's role is to recommend products based on verified expert reviews and
reputation data. When it is time to buy, Dina hands off a cart or checkout
link to the human. Dina never holds payment info, never auto-purchases,
and actively protects against impulse buys and deceptive ads.
"""

from __future__ import annotations

import uuid

import pytest

from tests.integration.mocks import (
    ActionRisk,
    AgentIntent,
    Draft,
    ExpertAttestation,
    MockDinaCore,
    MockExternalAgent,
    MockHuman,
    MockReviewBot,
    MockStagingTier,
    PaymentIntent,
    TrustRing,
)


# ---------------------------------------------------------------------------
# TestCartHandover
# ---------------------------------------------------------------------------

class TestCartHandover:
    """Dina recommends; the human buys. Money never flows through Dina."""

    def test_recommends_but_user_buys(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Dina queries the review bot, presents options, but the user
        makes the final purchase decision."""
        # Dina asks the review bot for laptop recommendations
        result = mock_review_bot.query_product("best laptop for programming")

        assert len(result["recommendations"]) > 0
        top_pick = result["recommendations"][0]
        assert top_pick["product"] == "ThinkPad X1 Carbon"
        assert top_pick["score"] >= 90

        # Dina presents a payment intent — user must complete it
        intent = PaymentIntent(
            intent_id=f"cart_{uuid.uuid4().hex[:8]}",
            method="web",
            intent_uri=f"https://store.example.com/checkout?product={top_pick['product']}",
            merchant="LenovoStore",
            amount=175000.0,
            currency="INR",
            recommendation=f"Top pick: {top_pick['product']} (score {top_pick['score']})",
        )
        mock_dina.staging.store_payment_intent(intent)

        retrieved = mock_dina.staging.get(intent.intent_id)
        assert retrieved is not None
        assert retrieved.executed is False
        assert "ThinkPad" in retrieved.recommendation

    def test_never_holds_payment_info(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Dina's vault must never store raw payment credentials. The vault
        tiers should be free of card numbers, PINs, and wallet keys."""
        vault = mock_dina.vault

        # Store some legitimate user data
        vault.store(1, "preference_laptop", {
            "category": "laptops",
            "budget": "150000-200000_INR",
            "priority": "battery_life",
        })

        # Verify no payment-sensitive data is in the vault
        for tier_num, tier_data in vault._tiers.items():
            tier_str = str(tier_data)
            assert "4111-2222-3333-4444" not in tier_str
            assert "upi_pin" not in tier_str.lower()
            assert "private_key" not in tier_str.lower()
            assert "cvv" not in tier_str.lower()

    def test_handover_with_link(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """The handover must include a direct checkout link. The user clicks
        to buy — Dina does not click for them."""
        result = mock_review_bot.query_product("ergonomic chair")

        assert len(result["recommendations"]) > 0
        top_pick = result["recommendations"][0]
        assert top_pick["product"] == "Herman Miller Aeron"

        # Build checkout link
        checkout_url = (
            f"https://hermanmiller.com/checkout?product=aeron"
            f"&ref=dina_{mock_dina.identity.root_did[:16]}"
        )

        intent = PaymentIntent(
            intent_id=f"cart_{uuid.uuid4().hex[:8]}",
            method="web",
            intent_uri=checkout_url,
            merchant="Herman Miller",
            amount=95000.0,
            currency="INR",
        )
        mock_dina.staging.store_payment_intent(intent)

        retrieved = mock_dina.staging.get(intent.intent_id)
        assert "https://" in retrieved.intent_uri
        assert "checkout" in retrieved.intent_uri
        assert retrieved.executed is False

    def test_multiple_options_presented(
        self, mock_dina: MockDinaCore, mock_review_bot: MockReviewBot,
    ) -> None:
        """When multiple products match, Dina should present all of them
        so the user can compare. No single-option funneling."""
        # Register a multi-option response under a unique keyword
        mock_review_bot.add_response("student computing", {
            "recommendations": [
                {
                    "product": "ThinkPad X1 Carbon",
                    "score": 92,
                    "sources": [],
                    "cons": ["expensive"],
                    "confidence": 0.87,
                },
                {
                    "product": "Dell XPS 13",
                    "score": 88,
                    "sources": [],
                    "cons": ["thermal_throttle"],
                    "confidence": 0.82,
                },
                {
                    "product": "Framework 16",
                    "score": 85,
                    "sources": [],
                    "cons": ["less_portable"],
                    "confidence": 0.79,
                },
            ],
            "bot_signature": "mock_sig",
            "bot_did": mock_review_bot.bot_did,
        })

        result = mock_review_bot.query_product("student computing options")
        recs = result["recommendations"]

        assert len(recs) >= 2, "User should see multiple options, not just one"
        # Options should be ranked by score
        scores = [r["score"] for r in recs]
        assert scores == sorted(scores, reverse=True)

    def test_impulse_purchase_protection(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """If a purchase intent is created for a high-value item without
        prior research (no review bot query), Dina flags it as HIGH risk
        and requires approval."""
        mock_human.set_approval("transfer_money", False)

        # An agent tries to push a purchase without any review context
        agent = MockExternalAgent(name="FlashSaleBot")
        intent = agent.submit_intent(
            AgentIntent(
                agent_did="",
                action="transfer_money",
                target="flashsale.example.com",
                context={"amount": 50000, "currency": "INR",
                         "reason": "Limited time offer! Buy now!"},
            )
        )

        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is False
        assert intent.risk_level == ActionRisk.HIGH

    def test_deceptive_ad_detection(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Dina's silence classifier flags content containing scam or fraud
        keywords as Tier 1 (fiduciary — must warn user)."""
        classifier = mock_dina.classifier

        # Classify a deceptive ad
        tier = classifier.classify(
            event_type="product_recommendation",
            content="AMAZING DEAL! This is definitely not a scam or fraud. "
                    "Limited stock — buy now before it's gone!",
        )

        # "scam" and "fraud" are fiduciary keywords — must interrupt
        from tests.integration.mocks import SilenceTier
        assert tier == SilenceTier.TIER_1_FIDUCIARY

        # The classification log should record the match
        assert len(classifier.classification_log) >= 1
        last_log = classifier.classification_log[-1]
        assert last_log["tier"] == SilenceTier.TIER_1_FIDUCIARY
        assert last_log["reason"] == "keyword_match"
