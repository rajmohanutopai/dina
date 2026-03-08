"""Integration tests for the Draft-Don't-Send protocol and payment intents.

Dina never sends emails or executes payments on its own. It creates drafts
and payment intents in the staging tier (Tier 4). The human reviews, approves,
and triggers the actual send/pay action. This is the "Silence First" principle
applied to outbound actions.
"""

from __future__ import annotations

import time
import uuid

import pytest

from tests.integration.mocks import (
    ActionRisk,
    AgentIntent,
    Draft,
    MockDinaCore,
    MockExternalAgent,
    MockHuman,
    MockLegalBot,
    MockStagingTier,
    OutcomeReport,
    PaymentIntent,
    TrustRing,
)


# ---------------------------------------------------------------------------
# TestDraftProtocol
# ---------------------------------------------------------------------------

class TestDraftProtocol:
    """Verify that outbound messages are drafted, never sent directly."""

# TST-INT-487
    def test_email_draft_created_not_sent(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """When Dina composes an email, it creates a Draft in staging.
        The draft's `sent` flag is False."""
        staging = mock_dina.staging

        draft = Draft(
            draft_id=f"draft_{uuid.uuid4().hex[:8]}",
            to="colleague@work.com",
            subject="Meeting notes",
            body="Here are the notes from today's standup.",
            confidence=0.92,
        )
        staging.store_draft(draft)

        retrieved = staging.get(draft.draft_id)
        assert retrieved is not None
        assert retrieved.sent is False
        assert retrieved.to == "colleague@work.com"
        assert retrieved.subject == "Meeting notes"

# TST-INT-488
    def test_draft_has_confidence_score(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Every draft must carry a confidence score so the user can gauge
        how certain Dina was about the content."""
        staging = mock_dina.staging

        draft = Draft(
            draft_id="draft_conf_test",
            to="friend@example.com",
            subject="Birthday reminder",
            body="Don't forget the party on Saturday!",
            confidence=0.78,
        )
        staging.store_draft(draft)

        retrieved = staging.get(draft.draft_id)
        assert retrieved is not None
        assert 0.0 <= retrieved.confidence <= 1.0
        assert retrieved.confidence == 0.78

# TST-INT-489
    def test_auto_expires_72h(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Drafts auto-expire after 72 hours (the default staging window).
        Stale drafts must not linger."""
        staging = mock_dina.staging
        now = time.time()

        draft = Draft(
            draft_id="draft_72h_test",
            to="someone@example.com",
            subject="Expiry test",
            body="This should expire.",
            confidence=0.5,
            created_at=now,
        )
        staging.store_draft(draft)

        # Verify expiry is set to 72 hours from creation
        retrieved = staging.get(draft.draft_id)
        assert retrieved is not None
        expected_expiry = now + 72 * 3600
        assert abs(retrieved.expires_at - expected_expiry) < 1.0

        # After 72h + 1 second, the draft should be expired
        expired_count = staging.auto_expire(current_time=now + 72 * 3600 + 1)
        assert expired_count == 1
        assert staging.get(draft.draft_id) is None

# TST-INT-296
    def test_high_risk_never_drafted(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """A HIGH-risk action that the user denies should never produce
        a draft at all."""
        mock_human.set_approval("share_data", False)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="share_data",
                        target="analytics_corp",
                        context={"fields": ["medical_records"]})
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is False
        assert intent.risk_level == ActionRisk.HIGH
        # No draft was created in staging
        # (In a real system, the draft creation step would be skipped
        # if approval fails. Here we assert staging is empty.)
        assert mock_dina.staging._items == {}

# TST-INT-490
    def test_user_reviews_before_sending(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """The user must explicitly mark a draft as sent. Dina cannot
        flip the `sent` flag on its own."""
        staging = mock_dina.staging

        draft = Draft(
            draft_id="draft_review_test",
            to="boss@company.com",
            subject="Quarterly report",
            body="Please see attached report.",
            confidence=0.95,
        )
        staging.store_draft(draft)

        # Draft exists, unsent
        retrieved = staging.get(draft.draft_id)
        assert retrieved.sent is False

        # Counter-proof: human DENIES approval → draft stays unsent
        mock_human.set_approval("send_email", False)
        if mock_human.approve("send_email"):
            retrieved.sent = True
        assert retrieved.sent is False, (
            "Draft must remain unsent when human denies approval"
        )

        # Human APPROVES → now the draft can be marked sent
        mock_human.set_approval("send_email", True)
        if mock_human.approve("send_email"):
            retrieved.sent = True
        assert retrieved.sent is True

        # MockStagingTier has no send() method — the architecture enforces
        # that only manual flag-flip after human approval can mark sent
        assert not hasattr(staging, "send"), (
            "Staging must not expose a send() method — drafts only"
        )

# TST-INT-292
    def test_delegated_agent_also_drafts_only(
        self, mock_dina: MockDinaCore, mock_legal_bot: MockLegalBot,
    ) -> None:
        """Even a delegated specialist bot (e.g. LegalBot) must produce
        drafts, never send directly."""
        identity_data = {"name": "Rajmohan", "id_number": "XXXX1234"}

        draft = mock_legal_bot.form_fill(
            task="Driver license renewal",
            identity_data=identity_data,
        )

        assert isinstance(draft, Draft)
        assert draft.sent is False
        assert "Draft:" in draft.subject
        assert draft.confidence > 0.0

        # Store in staging — still not sent
        mock_dina.staging.store_draft(draft)
        retrieved = mock_dina.staging.get(draft.draft_id)
        assert retrieved.sent is False


# ---------------------------------------------------------------------------
# TestPaymentIntentProtocol
# ---------------------------------------------------------------------------

class TestPaymentIntentProtocol:
    """Verify that Dina generates payment intents, never executes payments."""

# TST-INT-491
    def test_upi_intent_generated(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """For UPI payments, Dina generates a UPI intent URI. The user's
        payment app opens it — Dina never sees the UPI PIN."""
        staging = mock_dina.staging

        intent = PaymentIntent(
            intent_id="pay_upi_test",
            method="upi",
            intent_uri="upi://pay?pa=merchant@upi&pn=ChairMaker&am=95000&cu=INR",
            merchant="ChairMaker Co.",
            amount=95000.0,
            currency="INR",
            recommendation="Best chair per expert reviews.",
        )
        staging.store_payment_intent(intent)

        retrieved = staging.get(intent.intent_id)
        assert retrieved is not None
        assert retrieved.method == "upi"
        assert "upi://pay" in retrieved.intent_uri
        assert retrieved.executed is False
        assert retrieved.amount == 95000.0

# TST-INT-492
    def test_crypto_intent(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """For crypto payments, Dina generates a payment link. The user
        signs the transaction in their own wallet."""
        staging = mock_dina.staging

        # Pre-condition: nonexistent intent returns None
        assert staging.get("pay_crypto_test") is None

        intent = PaymentIntent(
            intent_id="pay_crypto_test",
            method="crypto",
            intent_uri="ethereum:0xABC123?value=150e6&token=USDC",
            merchant="GlobalStore",
            amount=150.0,
            currency="USDC",
        )
        intent_id = staging.store_payment_intent(intent)
        assert intent_id == "pay_crypto_test"

        retrieved = staging.get(intent.intent_id)
        assert retrieved is not None
        assert retrieved.method == "crypto"
        assert "ethereum:" in retrieved.intent_uri
        # Cart Handover: Dina never executes — user signs in own wallet
        assert retrieved.executed is False
        # Expiry window was auto-set by staging
        assert retrieved.expires_at > retrieved.created_at

        # Counter-proof: a different intent doesn't collide
        web_intent = PaymentIntent(
            intent_id="pay_web_separate",
            method="web",
            intent_uri="https://store.example.com/checkout",
            merchant="OtherStore",
            amount=50.0,
            currency="USD",
        )
        staging.store_payment_intent(web_intent)
        # Crypto intent still retrievable and unchanged
        still_crypto = staging.get("pay_crypto_test")
        assert still_crypto is not None
        assert still_crypto.method == "crypto"
        # Web intent is separate
        web_retrieved = staging.get("pay_web_separate")
        assert web_retrieved is not None
        assert web_retrieved.method == "web"

# TST-INT-293
    def test_web_checkout_link(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """For traditional web checkouts, Dina provides a link. The user
        completes payment in their browser.  Cart Handover: Dina never
        executes payment — only stores the intent for user action."""
        staging = mock_dina.staging

        # Counter-proof: non-existent intent returns None
        assert staging.get("nonexistent_intent") is None

        intent = PaymentIntent(
            intent_id="pay_web_test",
            method="web",
            intent_uri="https://store.example.com/checkout?cart=abc123",
            merchant="OnlineStore",
            amount=4999.0,
            currency="INR",
        )
        stored_id = staging.store_payment_intent(intent)
        assert stored_id == "pay_web_test"

        retrieved = staging.get(intent.intent_id)
        assert retrieved is not None
        # Cart Handover contract: Dina NEVER executes
        assert retrieved.executed is False

        # Staging auto-expiry: intent has a valid expiry window
        assert retrieved.expires_at > retrieved.created_at, (
            "Payment intent must have an expiry window"
        )

        # Counter-proof: a different method (UPI) produces distinct intent
        upi_intent = PaymentIntent(
            intent_id="pay_upi_test",
            method="upi",
            intent_uri="upi://pay?pa=merchant@upi&am=5000",
            merchant="SafeShop",
            amount=5000.0,
            currency="INR",
        )
        staging.store_payment_intent(upi_intent)
        assert staging.get("pay_upi_test").method == "upi"
        assert staging.get("pay_web_test").method == "web"  # no collision

# TST-INT-493
    def test_dina_never_sees_payment_credentials(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Payment intents never contain raw card numbers, UPI PINs,
        or wallet private keys."""
        staging = mock_dina.staging

        intent = PaymentIntent(
            intent_id="pay_no_creds",
            method="upi",
            intent_uri="upi://pay?pa=merchant@upi&am=5000&cu=INR",
            merchant="SafeShop",
            amount=5000.0,
            currency="INR",
        )
        staging.store_payment_intent(intent)

        retrieved = staging.get(intent.intent_id)
        # Serialize the entire intent and check for sensitive patterns
        intent_str = str(vars(retrieved))
        sensitive_patterns = [
            "4111", "PIN", "private_key", "secret", "password",
            "cvv", "expiry",
        ]
        for pattern in sensitive_patterns:
            assert pattern not in intent_str, \
                f"Sensitive pattern '{pattern}' found in payment intent"

# TST-INT-494
    def test_outcome_recorded_for_trust(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """After a purchase is completed (by the user, not Dina), the
        outcome is recorded in the trust network."""
        trust_network = mock_dina.trust_network

        # User completes purchase and reports outcome
        outcome = OutcomeReport(
            reporter_trust_ring=TrustRing.RING_2_VERIFIED,
            reporter_age_days=365,
            product_category="office_chairs",
            product_id="aeron_2025",
            purchase_verified=True,
            time_since_purchase_days=90,
            outcome="still_using",
            satisfaction="positive",
            issues=[],
        )
        trust_network.add_outcome(outcome)

        assert len(trust_network.outcomes) == 1
        recorded = trust_network.outcomes[0]
        assert recorded.product_id == "aeron_2025"
        assert recorded.outcome == "still_using"
        assert recorded.satisfaction == "positive"
        assert recorded.purchase_verified is True
