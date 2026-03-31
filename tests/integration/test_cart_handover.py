"""Integration tests for cart handover — Dina advises but never touches money.

Dina's role is to recommend products based on verified expert reviews and
trust data. When it is time to buy, Dina hands off a cart or checkout
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

# TST-INT-293
    # TRACE: {"suite": "INT", "case": "0293", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "01", "title": "recommends_but_user_buys"}
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

# TST-INT-296
    # TRACE: {"suite": "INT", "case": "0296", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "02", "title": "never_holds_payment_info"}
    def test_never_holds_payment_info(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Dina's vault must never store raw payment credentials.  The staging
        tier stores payment intents (URIs/links) but never raw credentials.
        Cart Handover: Dina advises, user pays."""
        vault = mock_dina.vault
        staging = mock_dina.staging

        # Store legitimate user preferences — these ARE allowed
        vault.store(1, "preference_laptop", {
            "category": "laptops",
            "budget": "150000-200000_INR",
            "priority": "battery_life",
        })
        retrieved = vault.retrieve(1, "preference_laptop")
        assert retrieved is not None
        assert retrieved["category"] == "laptops"

        # Payment intents go to staging, not vault — they contain
        # links/URIs, never raw credentials
        intent = PaymentIntent(
            intent_id="pay_test_no_creds",
            method="upi",
            intent_uri="upi://pay?pa=merchant@upi&am=5000&cu=INR",
            merchant="SafeShop",
            amount=5000.0,
            currency="INR",
        )
        staging.store_payment_intent(intent)

        # Intent exists in staging, not in vault
        assert staging.get("pay_test_no_creds") is not None
        assert vault.retrieve(1, "pay_test_no_creds") is None, (
            "Payment intents must live in staging, not vault"
        )

        # The intent URI contains no raw credentials
        stored = staging.get("pay_test_no_creds")
        intent_str = str(vars(stored))
        for pattern in ("4111", "cvv", "private_key", "password", "PIN"):
            assert pattern not in intent_str, (
                f"Payment intent must not contain '{pattern}'"
            )

        # Counter-proof: the intent IS accessible and has correct data
        assert stored.method == "upi"
        assert stored.executed is False
        assert stored.amount == 5000.0

# TST-INT-455
    # TRACE: {"suite": "INT", "case": "0455", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "03", "title": "handover_with_link"}
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

# TST-INT-456
    # TRACE: {"suite": "INT", "case": "0456", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "04", "title": "multiple_options_presented"}
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

# TST-INT-457
    # TRACE: {"suite": "INT", "case": "0457", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "05", "title": "impulse_purchase_protection"}
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

# TST-INT-458
    # TRACE: {"suite": "INT", "case": "0458", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "06", "title": "deceptive_ad_detection"}
    def test_deceptive_ad_detection(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Dina's silence classifier flags content containing scam or fraud
        keywords as Tier 1 (fiduciary — must warn user).  Legitimate
        recommendations are NOT flagged (counter-proof)."""
        from tests.integration.mocks import SilenceTier
        classifier = mock_dina.classifier

        # Counter-proof: a legitimate recommendation is NOT fiduciary
        legit_tier = classifier.classify(
            event_type="product_recommendation",
            content="The ThinkPad X1 Carbon scored 92/100 from MKBHD. "
                    "Great keyboard, solid battery life.",
        )
        assert legit_tier == SilenceTier.TIER_3_ENGAGEMENT, (
            "Legitimate recommendation must NOT be flagged as fiduciary"
        )

        # Classify a deceptive ad — "scam" and "fraud" are fiduciary keywords
        tier = classifier.classify(
            event_type="product_recommendation",
            content="AMAZING DEAL! This is definitely not a scam or fraud. "
                    "Limited stock — buy now before it's gone!",
        )
        assert tier == SilenceTier.TIER_1_FIDUCIARY

        # The classification log should record the match
        fiduciary_logs = [e for e in classifier.classification_log
                          if e["tier"] == SilenceTier.TIER_1_FIDUCIARY]
        assert len(fiduciary_logs) == 1
        assert fiduciary_logs[0]["reason"] == "keyword_match"
        assert fiduciary_logs[0]["event_type"] == "product_recommendation"
