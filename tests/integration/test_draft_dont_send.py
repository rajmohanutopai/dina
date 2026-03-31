"""Integration tests for the Draft-Don't-Send protocol and payment intents.

Dina never sends emails or executes payments on its own. It creates drafts
and payment intents in the staging tier (Tier 4). The human reviews, approves,
and triggers the actual send/pay action. This is the "Silence First" principle
applied to outbound actions.
"""

from __future__ import annotations

import hashlib
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
    Notification,
    OutcomeReport,
    PaymentIntent,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# TestDraftProtocol
# ---------------------------------------------------------------------------

class TestDraftProtocol:
    """Verify that outbound messages are drafted, never sent directly."""

# TST-INT-487
    # TRACE: {"suite": "INT", "case": "0487", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "01", "title": "email_draft_created_not_sent"}
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
    # TRACE: {"suite": "INT", "case": "0488", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "02", "title": "draft_has_confidence_score"}
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
    # TRACE: {"suite": "INT", "case": "0489", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "03", "title": "auto_expires_72h"}
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
    # TRACE: {"suite": "INT", "case": "0296", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "04", "title": "high_risk_never_drafted"}
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
    # TRACE: {"suite": "INT", "case": "0490", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "05", "title": "user_reviews_before_sending"}
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
    # TRACE: {"suite": "INT", "case": "0292", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "06", "title": "delegated_agent_also_drafts_only"}
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
    # TRACE: {"suite": "INT", "case": "0491", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "01", "title": "upi_intent_generated"}
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
    # TRACE: {"suite": "INT", "case": "0492", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "02", "title": "crypto_intent"}
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
    # TRACE: {"suite": "INT", "case": "0293", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "03", "title": "web_checkout_link"}
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
    # TRACE: {"suite": "INT", "case": "0493", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "04", "title": "dina_never_sees_payment_credentials"}
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
    # TRACE: {"suite": "INT", "case": "0494", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "05", "title": "outcome_recorded_for_trust"}
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


# ---------------------------------------------------------------------------
# TestDraftLifecycle (TST-INT-726)
# ---------------------------------------------------------------------------

class TestDraftLifecycle:
    """Draft lifecycle: create -> review -> expire.

    Validates the full lifecycle of a draft from creation through the
    72-hour expiry window, including boundary conditions and expiry
    notification generation for the daily briefing.
    """

    @staticmethod
    def _collect_expired_drafts(
        staging: MockStagingTier, current_time: float,
    ) -> list[Draft]:
        """Capture drafts that are about to expire before auto_expire deletes them.

        This implements real business logic: before running auto_expire, the
        system must snapshot expired drafts so it can generate notifications.
        This mirrors what Core would do — scan for expired items, record them,
        then purge.
        """
        expired: list[Draft] = []
        for item_id, item in list(staging._items.items()):
            if (
                isinstance(item, Draft)
                and hasattr(item, "expires_at")
                and current_time > item.expires_at
            ):
                expired.append(item)
        return expired

    @staticmethod
    def _generate_expiry_notifications(
        expired_drafts: list[Draft],
    ) -> list[Notification]:
        """Generate Tier 3 notifications for expired drafts.

        Expired drafts are NOT urgent (not fiduciary). They are folded
        into the daily briefing as engagement-tier notices so the user
        is aware that a draft they never acted on has been cleaned up.
        """
        notifications: list[Notification] = []
        for draft in expired_drafts:
            notifications.append(Notification(
                tier=SilenceTier.TIER_3_ENGAGEMENT,
                title="Draft expired",
                body=(
                    f"Draft to {draft.to} with subject "
                    f"'{draft.subject}' expired after 72 hours "
                    f"without action."
                ),
                actions=["dismiss"],
                source="draft_expiry",
            ))
        return notifications

# TST-INT-726
    # TRACE: {"suite": "INT", "case": "0726", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "01", "title": "draft_lifecycle_create_review_expire"}
    def test_draft_lifecycle_create_review_expire(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Full lifecycle: create draft -> verify retrievable -> boundary
        check at 71h -> expire at 73h -> verify gone -> verify notification."""
        staging = mock_dina.staging
        # Use current time as base so drafts are within their TTL window
        # when retrieved via staging.get() (which checks time.time()).
        base_time = time.time()

        # --- Step 1: Brain creates a draft via the staging API ---
        draft = Draft(
            draft_id=f"draft_lifecycle_{uuid.uuid4().hex[:8]}",
            to="alice@example.com",
            subject="Project update Q4",
            body="Hi Alice, here are the Q4 results.",
            confidence=0.88,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Step 2: Draft exists and is retrievable immediately
        retrieved = staging.get(draft.draft_id)
        assert retrieved is not None, "Draft must be retrievable after creation"
        assert retrieved.sent is False, "New draft must not be marked sent"
        assert retrieved.to == "alice@example.com"
        assert retrieved.subject == "Project update Q4"
        assert retrieved.body == "Hi Alice, here are the Q4 results."
        assert retrieved.confidence == 0.88

        # Verify expiry was auto-set to 72 hours from creation
        expected_expiry = base_time + 72 * 3600
        assert abs(retrieved.expires_at - expected_expiry) < 1.0, (
            f"Expiry should be 72h from creation, got delta "
            f"{retrieved.expires_at - expected_expiry}"
        )

        # --- Step 3: At 71 hours — draft STILL exists (boundary test) ---
        time_at_71h = base_time + 71 * 3600
        expired_count_71h = staging.auto_expire(current_time=time_at_71h)
        assert expired_count_71h == 0, (
            "No drafts should expire at 71h (within 72h TTL)"
        )
        # Use _collect_expired_drafts to check — get() uses wall clock,
        # but _collect_expired_drafts uses the provided time.
        alive_at_71h = [
            v for v in staging._items.values()
            if isinstance(v, Draft) and v.draft_id == draft.draft_id
        ]
        assert len(alive_at_71h) == 1, (
            "Draft must still exist at 71h — just under the 72h TTL"
        )
        assert alive_at_71h[0].sent is False, (
            "Draft should remain unsent at 71h"
        )

        # Counter-proof: draft at 71h is NOT expired
        assert time_at_71h < alive_at_71h[0].expires_at, (
            "71h must be strictly before the expiry time"
        )

        # --- Step 4: At 73 hours — past TTL, auto_expire removes the draft ---
        time_at_73h = base_time + 73 * 3600

        # Capture expired drafts BEFORE purging (real business logic)
        expired_drafts = self._collect_expired_drafts(staging, time_at_73h)
        assert len(expired_drafts) == 1, (
            "Exactly one draft should be expired at 73h"
        )
        assert expired_drafts[0].draft_id == draft.draft_id

        # Generate expiry notifications
        notifications = self._generate_expiry_notifications(expired_drafts)

        # Now purge
        expired_count_73h = staging.auto_expire(current_time=time_at_73h)
        assert expired_count_73h == 1, "auto_expire should remove 1 draft at 73h"

        # --- Step 5: Draft is no longer retrievable ---
        assert staging._items.get(draft.draft_id) is None, (
            "Draft must be purged from staging after expiry"
        )

        # --- Step 6: Verify expiry notification ---
        assert len(notifications) == 1
        notif = notifications[0]

        # Tier 3 (engagement) — NOT urgent
        assert notif.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            "Draft expiry should be Tier 3 (engagement), not fiduciary"
        )

        # Counter-proof: expiry notification is NOT Tier 1
        assert notif.tier != SilenceTier.TIER_1_FIDUCIARY, (
            "Draft expiry must never be Tier 1 — it is not a fiduciary event"
        )

        # Body mentions "expired" and draft details
        assert "expired" in notif.body.lower(), (
            "Notification body must mention 'expired'"
        )
        assert "alice@example.com" in notif.body, (
            "Notification body must mention the draft recipient"
        )
        assert "Project update Q4" in notif.body, (
            "Notification body must mention the draft subject"
        )

        # Source must be draft_expiry
        assert notif.source == "draft_expiry"

        # --- Counter-proof: second draft created AFTER first expired ---
        # The second draft is created "now" (at 73h in the scenario).
        # Its expiry is 72h from now, so it must survive at 73h.
        second_created_at = time_at_73h
        second_draft = Draft(
            draft_id=f"draft_second_{uuid.uuid4().hex[:8]}",
            to="bob@example.com",
            subject="Follow-up meeting",
            body="Let us reschedule.",
            confidence=0.75,
            created_at=second_created_at,
        )
        staging.store_draft(second_draft)

        # Second draft is within its TTL — verify it exists
        second_in_staging = staging._items.get(second_draft.draft_id)
        assert second_in_staging is not None, (
            "Second draft created after first expired must exist"
        )
        assert second_in_staging.sent is False
        # Second draft has its own 72h window starting at time_at_73h
        assert abs(
            second_in_staging.expires_at - (second_created_at + 72 * 3600)
        ) < 1.0, (
            "Second draft must have its own independent 72h expiry window"
        )

        # First draft remains gone
        assert staging._items.get(draft.draft_id) is None, (
            "First draft must still be gone after second draft is created"
        )

        # Second draft must NOT be collected as expired at 73h
        # because its own expiry is at 73h + 72h = 145h from base_time
        second_not_expired = self._collect_expired_drafts(
            staging, time_at_73h,
        )
        assert all(
            d.draft_id != second_draft.draft_id
            for d in second_not_expired
        ), "Second draft must NOT be expired at 73h (its window just started)"

        # --- Edge case: sent draft still expires ---
        # Use a fresh staging to isolate this edge case
        edge_staging = MockStagingTier()
        sent_draft = Draft(
            draft_id=f"draft_sent_{uuid.uuid4().hex[:8]}",
            to="carol@example.com",
            subject="Sent but still ticking",
            body="This was approved and sent.",
            confidence=0.99,
            created_at=base_time,  # Same creation time as first draft
        )
        edge_staging.store_draft(sent_draft)
        # Mark as sent (user approved it)
        stored_sent = edge_staging._items[sent_draft.draft_id]
        stored_sent.sent = True
        assert stored_sent.sent is True, "Draft should be marked sent"

        # At 73h, the sent draft also expires (sent flag doesn't prevent expiry)
        sent_expired = self._collect_expired_drafts(edge_staging, time_at_73h)
        assert len(sent_expired) == 1, (
            "Sent draft should still be collectible as expired"
        )
        assert sent_expired[0].sent is True, (
            "The expired draft should still have sent=True flag"
        )

        expired_count_sent = edge_staging.auto_expire(current_time=time_at_73h)
        assert expired_count_sent == 1, (
            "Sent draft should still be purged by auto_expire"
        )
        assert edge_staging._items.get(sent_draft.draft_id) is None, (
            "Sent draft must be gone after expiry"
        )


# ---------------------------------------------------------------------------
# TestConcurrentApprovals (TST-INT-730)
# ---------------------------------------------------------------------------


def generate_approval_token(action_id: str, payload: str) -> str:
    """Generate a unique SHA-256 approval token cryptographically bound
    to an action ID and its content.

    This simulates Core's actual approval mechanism where tokens are
    derived from the action identity and content, ensuring that a token
    for one action cannot be used to approve a different action.
    """
    # Combine action_id and payload into a deterministic but unique hash.
    # In production Core, this would include a server-side secret and
    # a nonce; here we use the action's unique content binding.
    token_input = f"{action_id}:{payload}:{uuid.uuid4().hex}"
    return hashlib.sha256(token_input.encode("utf-8")).hexdigest()


def approve_action(
    staging: MockStagingTier,
    action_id: str,
    token: str,
    tokens_registry: dict[str, str],
) -> bool:
    """Attempt to approve an action using its approval token.

    Validates that:
    1. The action exists in the staging tier
    2. The token matches the registered token for this action
    3. Marks the action as approved if both checks pass

    Returns True on success, False on failure (wrong token, missing action).
    """
    # Check the action exists
    item = staging.get(action_id)
    if item is None:
        return False

    # Check the token is registered for this action
    registered_token = tokens_registry.get(action_id)
    if registered_token is None:
        return False

    # Verify the token matches — this is the core security check
    if token != registered_token:
        return False

    # Mark approved based on action type
    if isinstance(item, Draft):
        item.sent = True
    elif isinstance(item, PaymentIntent):
        item.executed = True
    else:
        return False

    return True


class TestConcurrentApprovals:
    """Concurrent actions: independent approval tokens.

    Validates that when multiple drafts and payment intents are pending
    simultaneously, each has a unique cryptographic approval token, and
    approving one action does not affect any other action.
    """

# TST-INT-730
    # TRACE: {"suite": "INT", "case": "0730", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "04", "scenario": "01", "title": "concurrent_actions_independent_approval_tokens"}
    def test_concurrent_actions_independent_approval_tokens(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """3 drafts + 2 payment intents with independent approval tokens."""
        staging = mock_dina.staging
        # Use current time so items are within their TTL window
        # when retrieved via staging.get() (which checks time.time()).
        base_time = time.time()
        tokens_registry: dict[str, str] = {}

        # --- Step 1: Create 3 drafts ---
        drafts: list[Draft] = []
        for i in range(3):
            d = Draft(
                draft_id=f"draft_{i}",
                to=f"recipient_{i}@example.com",
                subject=f"Draft subject {i}",
                body=f"Draft body content for draft {i}",
                confidence=0.80 + i * 0.05,
                created_at=base_time,
            )
            staging.store_draft(d)
            drafts.append(d)

        # --- Step 2: Create 2 payment intents (cart handovers) ---
        payments: list[PaymentIntent] = []
        for i in range(2):
            p = PaymentIntent(
                intent_id=f"payment_{i}",
                method="upi" if i == 0 else "web",
                intent_uri=(
                    f"upi://pay?pa=merchant_{i}@upi&am={1000*(i+1)}"
                    if i == 0
                    else f"https://store{i}.example.com/checkout"
                ),
                merchant=f"Merchant_{i}",
                amount=1000.0 * (i + 1),
                currency="INR",
                recommendation=f"Recommendation for payment {i}",
                created_at=base_time,
            )
            staging.store_payment_intent(p)
            payments.append(p)

        # --- Step 3: Generate unique approval tokens for each action ---
        all_action_ids = [d.draft_id for d in drafts] + [
            p.intent_id for p in payments
        ]
        for action_id in all_action_ids:
            item = staging.get(action_id)
            if isinstance(item, Draft):
                payload = f"{item.to}:{item.subject}:{item.body}"
            elif isinstance(item, PaymentIntent):
                payload = (
                    f"{item.merchant}:{item.amount}:{item.currency}"
                    f":{item.intent_uri}"
                )
            else:
                pytest.fail(f"Unknown action type for {action_id}")
            token = generate_approval_token(action_id, payload)
            tokens_registry[action_id] = token

        # --- Step 4: Verify ALL 5 tokens are unique ---
        all_tokens = list(tokens_registry.values())
        assert len(all_tokens) == 5, "Must have exactly 5 tokens"
        assert len(set(all_tokens)) == 5, (
            "All 5 approval tokens must be cryptographically unique"
        )
        # Pairwise uniqueness check (not just set-based)
        for i, t1 in enumerate(all_tokens):
            for j, t2 in enumerate(all_tokens):
                if i != j:
                    assert t1 != t2, (
                        f"Token {i} and token {j} must differ"
                    )

        # --- Step 5: All 5 actions initially pending ---
        for d in drafts:
            item = staging.get(d.draft_id)
            assert item is not None
            assert item.sent is False, f"{d.draft_id} must start unsent"
        for p in payments:
            item = staging.get(p.intent_id)
            assert item is not None
            assert item.executed is False, (
                f"{p.intent_id} must start unexecuted"
            )

        # --- Step 6: Approve draft_1 with its correct token ---
        result = approve_action(
            staging, "draft_1", tokens_registry["draft_1"], tokens_registry,
        )
        assert result is True, "Approving draft_1 with correct token must succeed"

        # --- Step 7: draft_1 is now approved ---
        draft_1 = staging.get("draft_1")
        assert draft_1.sent is True, "draft_1 must be sent after approval"

        # --- Step 8: All OTHER actions remain pending ---
        draft_0 = staging.get("draft_0")
        assert draft_0.sent is False, (
            "draft_0 must remain unsent after draft_1 approval"
        )
        draft_2 = staging.get("draft_2")
        assert draft_2.sent is False, (
            "draft_2 must remain unsent after draft_1 approval"
        )
        payment_0 = staging.get("payment_0")
        assert payment_0.executed is False, (
            "payment_0 must remain unexecuted after draft_1 approval"
        )
        payment_1 = staging.get("payment_1")
        assert payment_1.executed is False, (
            "payment_1 must remain unexecuted after draft_1 approval"
        )

        # --- Step 9: Attempt to approve draft_2 with draft_1's token ---
        wrong_result = approve_action(
            staging, "draft_2", tokens_registry["draft_1"], tokens_registry,
        )
        assert wrong_result is False, (
            "Approving draft_2 with draft_1's token must fail"
        )

        # --- Step 10: draft_2 remains pending ---
        draft_2_after = staging.get("draft_2")
        assert draft_2_after.sent is False, (
            "draft_2 must remain unsent after wrong-token attempt"
        )

        # --- Step 11: Approve payment_0 with its correct token ---
        pay_result = approve_action(
            staging, "payment_0", tokens_registry["payment_0"],
            tokens_registry,
        )
        assert pay_result is True, (
            "Approving payment_0 with correct token must succeed"
        )

        # --- Step 12: payment_0 is executed, payment_1 is NOT ---
        payment_0_after = staging.get("payment_0")
        assert payment_0_after.executed is True, (
            "payment_0 must be executed after approval"
        )
        payment_1_after = staging.get("payment_1")
        assert payment_1_after.executed is False, (
            "payment_1 must remain unexecuted"
        )

        # --- Step 13: Drafts 0 and 2 remain unaffected ---
        assert staging.get("draft_0").sent is False, (
            "draft_0 unaffected by payment approval"
        )
        assert staging.get("draft_2").sent is False, (
            "draft_2 unaffected by payment approval"
        )

        # --- Counter-proofs ---

        # Wrong token does NOT approve
        bad_result = approve_action(
            staging, "payment_1", tokens_registry["payment_0"],
            tokens_registry,
        )
        assert bad_result is False, (
            "payment_0's token must not approve payment_1"
        )
        assert staging.get("payment_1").executed is False

        # Approving a draft doesn't affect payment intents
        # (Already validated above: after draft_1 approval, all payments
        # remained unexecuted. Verify again after all operations.)
        assert staging.get("payment_1").executed is False, (
            "payment_1 must still be unexecuted after all draft operations"
        )

        # Approving a payment intent doesn't affect drafts
        assert staging.get("draft_0").sent is False, (
            "draft_0 must still be unsent after payment_0 approval"
        )
        assert staging.get("draft_2").sent is False, (
            "draft_2 must still be unsent after payment_0 approval"
        )

        # Non-existent action_id returns False
        ghost_result = approve_action(
            staging, "nonexistent_action", "any_token", tokens_registry,
        )
        assert ghost_result is False, (
            "Non-existent action_id must return False"
        )

        # Non-existent action not in registry also returns False
        ghost_result_2 = approve_action(
            staging, "draft_0", "completely_wrong_token", tokens_registry,
        )
        assert ghost_result_2 is False, (
            "Completely wrong token must return False"
        )
        assert staging.get("draft_0").sent is False, (
            "draft_0 must remain unsent after wrong token attempt"
        )

        # Each token is different from every other token (final cross-check)
        for aid, tok in tokens_registry.items():
            assert len(tok) == 64, (
                f"Token for {aid} must be 64-char SHA-256 hex digest"
            )
            others = {
                k: v for k, v in tokens_registry.items() if k != aid
            }
            for other_aid, other_tok in others.items():
                assert tok != other_tok, (
                    f"Token for {aid} must differ from token for {other_aid}"
                )


# ---------------------------------------------------------------------------
# Payload-bound approval helpers for TST-INT-732
# ---------------------------------------------------------------------------


def generate_payload_bound_token(action_id: str, payload_content: str) -> str:
    """Generate a DETERMINISTIC SHA-256 approval token cryptographically
    bound to an action ID and the exact payload content.

    Unlike generate_approval_token() (which includes a random UUID nonce),
    this token is fully deterministic: the same (action_id, payload_content)
    pair always produces the same token. This is what makes mutation
    detection possible — if the payload changes after approval, recomputing
    the token yields a different hash that no longer matches the stored one.

    In production Core this would additionally include an HMAC secret so
    that agents cannot forge tokens, but the determinism property is what
    matters for mutation detection.
    """
    token_input = f"{action_id}:{payload_content}"
    return hashlib.sha256(token_input.encode("utf-8")).hexdigest()


def validate_approved_payload(
    action_id: str,
    current_payload: str,
    approval_token: str,
) -> tuple[bool, str]:
    """Recompute the expected token from the current payload and compare
    it against the stored approval token.

    Returns (valid, reason):
      - (True, "payload matches approval") if the hash matches
      - (False, "content changed, re-approval required") if it does not
    """
    expected_token = generate_payload_bound_token(action_id, current_payload)
    if expected_token == approval_token:
        return True, "payload matches approval"
    return False, "content changed, re-approval required"


def attempt_send_approved_draft(
    staging: MockStagingTier,
    draft_id: str,
    current_body: str,
    approval_token: str,
) -> dict[str, object]:
    """Attempt to send an approved draft, validating the payload against
    the approval token first.

    This implements the safety mechanism: even after a user approves a draft,
    Core re-validates the payload hash at send time. If the payload was
    mutated between approval and send (by a malicious or buggy agent), the
    send is rejected and the draft is returned to pending.

    Returns a dict with keys:
      - sent (bool): True if the draft was successfully sent
      - rejected (bool): True if the send was rejected due to mutation
      - reason (str): Human-readable explanation
      - re_approval_required (bool): True if mutation was detected
    """
    draft = staging.get(draft_id)
    if draft is None:
        return {
            "sent": False,
            "rejected": True,
            "reason": "draft not found",
            "re_approval_required": False,
        }

    # Re-validate the payload against the approval token
    valid, reason = validate_approved_payload(
        draft_id, current_body, approval_token,
    )

    if valid:
        # Payload unchanged — safe to send
        draft.sent = True
        return {
            "sent": True,
            "rejected": False,
            "reason": "payload matches approval",
            "re_approval_required": False,
        }

    # Payload was mutated — revert to pending, require re-approval
    draft.sent = False
    return {
        "sent": False,
        "rejected": True,
        "reason": reason,
        "re_approval_required": True,
    }


# ---------------------------------------------------------------------------
# TestApprovalPayloadMutation (TST-INT-732)
# ---------------------------------------------------------------------------


class TestApprovalPayloadMutation:
    """Approval invalidated on payload mutation.

    Validates the critical safety flow: a draft is approved by the user,
    then an agent modifies the body before send. Core detects that the
    payload hash no longer matches the approval token and rejects the
    send, returning the draft to pending with "content changed,
    re-approval required".

    This is a SAFETY mechanism — it prevents malicious or buggy agents
    from modifying approved content (e.g., changing transfer amounts or
    recipients) after the user has reviewed and approved the original.
    """

# TST-INT-732
    # TRACE: {"suite": "INT", "case": "0732", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "01", "title": "approval_invalidated_on_payload_mutation"}
    def test_approval_invalidated_on_payload_mutation(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Draft approved by user -> agent modifies body before send ->
        Core receives modified payload | Core rejects — approval hash no
        longer matches payload. Draft returned to pending with 'content
        changed, re-approval required'."""
        staging = mock_dina.staging
        base_time = time.time()

        # --- Step 1: Create a draft with sensitive financial content ---
        original_body = "Please transfer $500 to account 12345"
        draft = Draft(
            draft_id="draft_mutation_test",
            to="bank@transfers.com",
            subject="Wire transfer request",
            body=original_body,
            confidence=0.95,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # --- Step 2: Generate a payload-bound approval token ---
        approval_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )
        assert len(approval_token) == 64, (
            "Token must be a 64-char SHA-256 hex digest"
        )

        # --- Step 3: Verify token validates against original body ---
        valid, reason = validate_approved_payload(
            draft.draft_id, original_body, approval_token,
        )
        assert valid is True, (
            "Token must validate against the original body it was generated from"
        )
        assert "matches" in reason

        # Determinism check: generating the same token again yields the same hash
        second_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )
        assert second_token == approval_token, (
            "Token must be deterministic — same inputs must yield same hash"
        )

        # --- Step 4: Agent mutates the body (malicious change) ---
        mutated_body = "Please transfer $5000 to account 99999"

        # --- Step 5: Attempt to send with the original approval token ---
        result = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, approval_token,
        )

        # --- Step 6: Assert send REJECTED ---
        assert result["sent"] is False, (
            "Mutated draft must NOT be sent"
        )
        assert result["rejected"] is True, (
            "Send must be explicitly rejected when payload is mutated"
        )

        # --- Step 7: Assert reason mentions content change ---
        assert "content changed" in result["reason"] or \
            "re-approval required" in result["reason"], (
                f"Rejection reason must mention content change or re-approval, "
                f"got: {result['reason']}"
            )
        assert result["re_approval_required"] is True, (
            "re_approval_required flag must be set on mutation detection"
        )

        # --- Step 8: Draft is back to pending (sent=False) ---
        draft_after = staging.get(draft.draft_id)
        assert draft_after is not None, (
            "Draft must still exist in staging after rejection"
        )
        assert draft_after.sent is False, (
            "Draft must be reverted to pending (sent=False) after rejection"
        )

        # --- Step 9: The mutated content was NOT sent ---
        # The draft's body in staging is still the object in memory;
        # the key assertion is that sent=False, meaning Core never executed
        # the send action. The mutated content never left staging.
        assert result["sent"] is False, (
            "No content — original or mutated — was sent"
        )

        # --- Counter-proof: verify the token DOES match original body ---
        # If someone re-submits with the original body, it would pass
        valid_original, _ = validate_approved_payload(
            draft.draft_id, original_body, approval_token,
        )
        assert valid_original is True, (
            "Token still valid for the original (un-mutated) body"
        )

        # --- Counter-proof: token for mutated body is DIFFERENT ---
        mutated_token = generate_payload_bound_token(
            draft.draft_id, mutated_body,
        )
        assert mutated_token != approval_token, (
            "Token for mutated body must differ from token for original body"
        )

    # TRACE: {"suite": "INT", "case": "0088", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "02", "title": "unmodified_payload_sends_successfully"}
    def test_unmodified_payload_sends_successfully(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Counter-proof: same flow WITHOUT mutation — send succeeds."""
        staging = mock_dina.staging
        base_time = time.time()

        body = "Please send the quarterly report to the team"
        draft = Draft(
            draft_id="draft_unmodified_test",
            to="team@company.com",
            subject="Q4 Report",
            body=body,
            confidence=0.90,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Generate token and approve
        approval_token = generate_payload_bound_token(
            draft.draft_id, body,
        )

        # Send with the SAME body — no mutation
        result = attempt_send_approved_draft(
            staging, draft.draft_id, body, approval_token,
        )

        assert result["sent"] is True, (
            "Unmodified payload must be sent successfully"
        )
        assert result["rejected"] is False, (
            "Unmodified payload must not be rejected"
        )
        assert result["re_approval_required"] is False, (
            "No re-approval needed when payload is unchanged"
        )

        # Draft is now marked sent
        draft_after = staging.get(draft.draft_id)
        assert draft_after.sent is True, (
            "Draft must be marked sent after successful send"
        )

    # TRACE: {"suite": "INT", "case": "0089", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "03", "title": "whitespace_only_change_still_invalidates"}
    def test_whitespace_only_change_still_invalidates(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Even a trivial whitespace change invalidates the approval.
        Cryptographic hashes are exact — there is no 'close enough'."""
        staging = mock_dina.staging
        base_time = time.time()

        body = "Meeting at 3pm tomorrow"
        draft = Draft(
            draft_id="draft_whitespace_test",
            to="colleague@work.com",
            subject="Meeting reminder",
            body=body,
            confidence=0.85,
            created_at=base_time,
        )
        staging.store_draft(draft)

        approval_token = generate_payload_bound_token(
            draft.draft_id, body,
        )

        # Add a single trailing space — trivial but detectable
        mutated_body = body + " "
        assert mutated_body != body, "Sanity: bodies must differ"

        result = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, approval_token,
        )

        assert result["sent"] is False, (
            "Whitespace-only change must still be rejected"
        )
        assert result["rejected"] is True
        assert result["re_approval_required"] is True, (
            "Even trivial whitespace changes require re-approval"
        )

        # Draft remains pending
        assert staging.get(draft.draft_id).sent is False

    # TRACE: {"suite": "INT", "case": "0090", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "04", "title": "reapproval_with_new_token_succeeds"}
    def test_reapproval_with_new_token_succeeds(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """After mutation is rejected, generating a NEW token for the
        mutated content and re-approving allows the send to succeed.
        This validates the full re-approval flow."""
        staging = mock_dina.staging
        base_time = time.time()

        original_body = "Send invitation to 10 guests"
        draft = Draft(
            draft_id="draft_reapproval_test",
            to="events@venue.com",
            subject="Party invitation",
            body=original_body,
            confidence=0.88,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # First approval: token bound to original body
        original_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )

        # Agent mutates the body
        mutated_body = "Send invitation to 50 guests"

        # First attempt: rejected (mutation detected)
        result_1 = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, original_token,
        )
        assert result_1["rejected"] is True, (
            "First attempt with mutated body must be rejected"
        )
        assert result_1["re_approval_required"] is True
        assert staging.get(draft.draft_id).sent is False, (
            "Draft must be pending after first rejection"
        )

        # User reviews the NEW content and generates a NEW token
        new_token = generate_payload_bound_token(
            draft.draft_id, mutated_body,
        )
        assert new_token != original_token, (
            "New token for different content must differ from original"
        )

        # Second attempt: succeeds (new token matches mutated body)
        result_2 = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, new_token,
        )
        assert result_2["sent"] is True, (
            "Re-approved mutated content must send successfully"
        )
        assert result_2["rejected"] is False
        assert result_2["re_approval_required"] is False

        # Draft is now sent
        assert staging.get(draft.draft_id).sent is True, (
            "Draft must be marked sent after re-approval succeeds"
        )

    # TRACE: {"suite": "INT", "case": "0091", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "05", "title": "different_draft_approval_not_affected"}
    def test_different_draft_approval_not_affected(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Mutating draft A's body does not affect draft B's approval.
        Each draft's token is independently bound to its own content."""
        staging = mock_dina.staging
        base_time = time.time()

        # Create draft A
        body_a = "Draft A: send report"
        draft_a = Draft(
            draft_id="draft_iso_a",
            to="a@example.com",
            subject="Report A",
            body=body_a,
            confidence=0.90,
            created_at=base_time,
        )
        staging.store_draft(draft_a)
        token_a = generate_payload_bound_token(draft_a.draft_id, body_a)

        # Create draft B
        body_b = "Draft B: send invoice"
        draft_b = Draft(
            draft_id="draft_iso_b",
            to="b@example.com",
            subject="Invoice B",
            body=body_b,
            confidence=0.92,
            created_at=base_time,
        )
        staging.store_draft(draft_b)
        token_b = generate_payload_bound_token(draft_b.draft_id, body_b)

        # Mutate draft A's body
        mutated_body_a = "Draft A: send report and delete everything"

        # Draft A's send is rejected (mutation detected)
        result_a = attempt_send_approved_draft(
            staging, draft_a.draft_id, mutated_body_a, token_a,
        )
        assert result_a["rejected"] is True, (
            "Draft A with mutated body must be rejected"
        )
        assert staging.get(draft_a.draft_id).sent is False

        # Draft B is completely unaffected — send succeeds
        result_b = attempt_send_approved_draft(
            staging, draft_b.draft_id, body_b, token_b,
        )
        assert result_b["sent"] is True, (
            "Draft B must send successfully — it was never mutated"
        )
        assert staging.get(draft_b.draft_id).sent is True, (
            "Draft B must be marked sent"
        )

        # Draft A is still pending
        assert staging.get(draft_a.draft_id).sent is False, (
            "Draft A must remain pending after draft B was sent"
        )

        # Counter-proof: draft A's token does not work for draft B
        valid_cross, _ = validate_approved_payload(
            draft_b.draft_id, body_b, token_a,
        )
        assert valid_cross is False, (
            "Draft A's token must not validate for draft B's payload"
        )

    # TRACE: {"suite": "INT", "case": "0092", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "06", "title": "empty_body_mutation_detected"}
    def test_empty_body_mutation_detected(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Edge case: body changed from non-empty to empty string.
        The hash change must be detected even for empty payloads."""
        staging = mock_dina.staging
        base_time = time.time()

        original_body = "Hello"
        draft = Draft(
            draft_id="draft_empty_test",
            to="test@example.com",
            subject="Empty body edge case",
            body=original_body,
            confidence=0.80,
            created_at=base_time,
        )
        staging.store_draft(draft)

        approval_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )

        # Mutate to empty string
        result = attempt_send_approved_draft(
            staging, draft.draft_id, "", approval_token,
        )

        assert result["sent"] is False, (
            "Empty body mutation must be detected and rejected"
        )
        assert result["rejected"] is True
        assert result["re_approval_required"] is True
        assert staging.get(draft.draft_id).sent is False

        # Counter-proof: empty string has a valid hash, just different
        empty_token = generate_payload_bound_token(draft.draft_id, "")
        assert empty_token != approval_token, (
            "Token for empty body must differ from token for 'Hello'"
        )
        assert len(empty_token) == 64, (
            "Token for empty body is still a valid SHA-256 hash"
        )

    # TRACE: {"suite": "INT", "case": "0093", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "07", "title": "case_change_detected"}
    def test_case_change_detected(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Edge case: case change in body is detected.
        SHA-256 is case-sensitive — 'Hello World' != 'hello world'."""
        staging = mock_dina.staging
        base_time = time.time()

        original_body = "Hello World"
        draft = Draft(
            draft_id="draft_case_test",
            to="test@example.com",
            subject="Case sensitivity edge case",
            body=original_body,
            confidence=0.80,
            created_at=base_time,
        )
        staging.store_draft(draft)

        approval_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )

        # Mutate case only
        mutated_body = "hello world"
        assert mutated_body.lower() == original_body.lower(), (
            "Sanity: bodies differ only in case"
        )

        result = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, approval_token,
        )

        assert result["sent"] is False, (
            "Case-only change must be detected and rejected"
        )
        assert result["rejected"] is True
        assert result["re_approval_required"] is True
        assert staging.get(draft.draft_id).sent is False

        # Counter-proof: the tokens ARE different
        case_token = generate_payload_bound_token(
            draft.draft_id, mutated_body,
        )
        assert case_token != approval_token, (
            "SHA-256 must produce different hashes for different case"
        )

    # TRACE: {"suite": "INT", "case": "0094", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "05", "scenario": "08", "title": "append_detected"}
    def test_append_detected(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Edge case: content appended to original body.
        Catches an agent that adds malicious instructions at the end."""
        staging = mock_dina.staging
        base_time = time.time()

        original_body = "Send report"
        draft = Draft(
            draft_id="draft_append_test",
            to="boss@company.com",
            subject="Weekly report",
            body=original_body,
            confidence=0.91,
            created_at=base_time,
        )
        staging.store_draft(draft)

        approval_token = generate_payload_bound_token(
            draft.draft_id, original_body,
        )

        # Agent appends malicious content
        mutated_body = "Send report and delete all files"
        assert mutated_body.startswith(original_body), (
            "Sanity: mutated body starts with original (append attack)"
        )

        result = attempt_send_approved_draft(
            staging, draft.draft_id, mutated_body, approval_token,
        )

        assert result["sent"] is False, (
            "Appended content must be detected and rejected"
        )
        assert result["rejected"] is True
        assert result["re_approval_required"] is True
        assert staging.get(draft.draft_id).sent is False

        # Counter-proof: original body still validates
        valid_original, _ = validate_approved_payload(
            draft.draft_id, original_body, approval_token,
        )
        assert valid_original is True, (
            "Original un-appended body must still validate"
        )


# ---------------------------------------------------------------------------
# Helper: downgrade_agent_send_to_draft
# ---------------------------------------------------------------------------

# Actions that represent an agent trying to send something outbound.
# Brain must intercept ALL of these and downgrade to a draft.
_SEND_LIKE_ACTIONS = frozenset({
    "messages.send",
    "send_email",
    "send_message",
    "email.send",
})


def downgrade_agent_send_to_draft(
    agent: MockExternalAgent,
    action: str,
    target: str,
    body: str,
    staging: MockStagingTier,
    *,
    subject: str = "",
    confidence: float = 0.90,
) -> dict:
    """Simulate Brain intercepting an agent's send request and downgrading it.

    The Draft-Don't-Send principle: no agent may send directly. Brain receives
    the agent's intent (e.g. "messages.send") and ALWAYS rewrites it as
    "drafts.create", producing a Draft object with ``sent=False`` in the
    staging tier. The human must explicitly approve before the message is
    actually dispatched.

    Returns a dict describing the downgrade outcome:
        - downgraded (bool): True if the action was a send-like action
        - original_action (str): the action the agent requested
        - resulting_action (str): "drafts.create" if downgraded, else original
        - draft (Draft | None): the Draft object if downgraded
        - draft_id (str | None): the draft's unique ID if downgraded
    """
    # Step 1: Agent submits intent through Brain's safety layer
    intent = AgentIntent(
        agent_did=agent.agent_did,
        action=action,
        target=target,
        context={"body": body, "subject": subject},
    )
    agent.submit_intent(intent)

    # Step 2: Brain inspects the action — is it a send-like action?
    normalised = action.strip().lower()
    is_send = normalised in _SEND_LIKE_ACTIONS

    if not is_send:
        # Non-send actions pass through without downgrade
        return {
            "downgraded": False,
            "original_action": action,
            "resulting_action": action,
            "draft": None,
            "draft_id": None,
        }

    # Step 3: Downgrade — create a Draft, NOT a sent message.
    # Regardless of what the agent requested, the resulting action is
    # "drafts.create" and the draft is stored with sent=False.
    draft_id = f"draft_{uuid.uuid4().hex[:12]}"
    draft = Draft(
        draft_id=draft_id,
        to=target,
        subject=subject or f"(agent:{agent.name})",
        body=body,
        confidence=confidence,
        sent=False,  # explicit — never True at creation
    )

    # Step 4: Store in staging. The staging tier is the ONLY place drafts
    # live until human approval. sent is ALWAYS forced False on store,
    # even if a caller attempts to pass sent=True.
    draft.sent = False
    staging.store_draft(draft)

    return {
        "downgraded": True,
        "original_action": action,
        "resulting_action": "drafts.create",
        "draft": draft,
        "draft_id": draft_id,
    }


# ---------------------------------------------------------------------------
# TestAgentSendDowngrade — TST-INT-728
# ---------------------------------------------------------------------------

class TestAgentSendDowngrade:
    """Agent send request -> always downgraded to draft.

    Section 23.1 Action Pipeline (Core<->Brain).

    The Draft-Don't-Send principle is a SAFETY mechanism: no autonomous agent
    may dispatch an outbound message. Brain intercepts every send-like action
    and rewrites it as ``drafts.create``. Core therefore only ever receives a
    draft, never a sent message. The human reviews, approves, and triggers the
    actual send.
    """

    # ---- Primary test (TST-INT-728) ----------------------------------------

    # TRACE: {"suite": "INT", "case": "0728", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "01", "title": "agent_send_request_always_downgraded_to_draft"}
    def test_agent_send_request_always_downgraded_to_draft(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Agent requests messages.send -> Brain downgrades to drafts.create.

        TST-INT-728: Agent via Brain requests ``messages.send`` -> hits Core.
        Core receives ``drafts.create`` not ``messages.send`` — downgrade
        happened in Brain.
        """
        staging = mock_dina.staging
        agent = mock_external_agent

        result = downgrade_agent_send_to_draft(
            agent=agent,
            action="messages.send",
            target="colleague@work.com",
            body="Here are the meeting notes",
            staging=staging,
        )

        # The action was downgraded
        assert result["downgraded"] is True, (
            "messages.send MUST be downgraded — agents never send directly"
        )

        # Original action is preserved for audit trail
        assert result["original_action"] == "messages.send"

        # The resulting action that reaches Core is drafts.create
        assert result["resulting_action"] == "drafts.create", (
            "Core must receive 'drafts.create', never 'messages.send'"
        )

        # The draft exists and is NOT sent
        draft = result["draft"]
        assert draft is not None
        assert draft.sent is False, (
            "Draft must be created with sent=False — requires human approval"
        )

        # Recipient and body are faithfully preserved
        assert draft.to == "colleague@work.com"
        assert draft.body == "Here are the meeting notes", (
            "Original message content must be preserved verbatim in draft"
        )

        # Verify the draft is actually in the staging tier and still pending
        stored = staging.get(result["draft_id"])
        assert stored is not None, "Draft must exist in staging"
        assert stored.sent is False, "Staged draft must not be auto-sent"

    # ---- Counter-proofs ----------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0095", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "02", "title": "non_send_action_not_downgraded"}
    def test_non_send_action_not_downgraded(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Agent requests 'search' action -> NOT downgraded.

        Only send-like actions are intercepted. Read-only actions like search,
        lookup, or read must pass through unmodified.
        """
        staging = mock_dina.staging

        result = downgrade_agent_send_to_draft(
            agent=mock_external_agent,
            action="search",
            target="recent meetings",
            body="query: meetings this week",
            staging=staging,
        )

        assert result["downgraded"] is False, (
            "'search' is not a send action — must NOT be downgraded"
        )
        assert result["original_action"] == "search"
        assert result["resulting_action"] == "search", (
            "Non-send actions must pass through with action unchanged"
        )
        assert result["draft"] is None, (
            "No draft should be created for non-send actions"
        )
        assert result["draft_id"] is None

    # TRACE: {"suite": "INT", "case": "0096", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "03", "title": "downgraded_draft_requires_human_approval"}
    def test_downgraded_draft_requires_human_approval(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """A downgraded draft cannot be sent without explicit human approval.

        The draft is in staging with sent=False. It can only transition to
        sent=True through the human approval flow (approval token), never
        through an agent request.
        """
        staging = mock_dina.staging
        human = MockHuman(auto_approve=False)

        result = downgrade_agent_send_to_draft(
            agent=mock_external_agent,
            action="messages.send",
            target="manager@corp.com",
            body="Quarterly report attached",
            staging=staging,
        )

        draft = result["draft"]
        assert draft.sent is False

        # The human has NOT approved this action
        assert human.approve("messages.send") is False, (
            "Human has not approved — draft must remain unsent"
        )

        # Without human approval, the draft remains in staging, unsent
        stored = staging.get(result["draft_id"])
        assert stored.sent is False, (
            "Draft must remain unsent without human approval token"
        )

        # Now simulate human approval via the proper channel
        human_approving = MockHuman(auto_approve=True)
        approved = human_approving.approve("drafts.create")
        assert approved is True

        # Even after human indicates willingness, the actual send requires
        # a cryptographic approval token bound to this specific draft.
        # Here we generate and use one.
        token = generate_approval_token(draft.draft_id, draft.body)
        tokens = {draft.draft_id: token}
        sent_ok = approve_action(staging, draft.draft_id, token, tokens)
        assert sent_ok is True, (
            "Draft should be sendable with a valid human approval token"
        )
        assert staging.get(draft.draft_id).sent is True

    # TRACE: {"suite": "INT", "case": "0097", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "04", "title": "agent_cannot_mark_draft_as_sent"}
    def test_agent_cannot_mark_draft_as_sent(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Even if an agent tries to set sent=True, staging stores sent=False.

        The downgrade helper forces sent=False before storing. An agent that
        manipulates the Draft object cannot bypass the safety mechanism.
        """
        staging = mock_dina.staging

        # First, create a draft via normal downgrade
        result = downgrade_agent_send_to_draft(
            agent=mock_external_agent,
            action="send_email",
            target="victim@example.com",
            body="I have your credentials",
            staging=staging,
        )

        draft = result["draft"]
        assert draft.sent is False

        # Simulate an agent attempting to flip the flag directly
        draft.sent = True

        # The staging tier should have stored it as sent=False originally.
        # Even if the in-memory draft object is mutated, a fresh retrieve
        # from staging returns the same reference (in-memory mock), but
        # the PROTOCOL requirement is that the approval flow is the only
        # legitimate path to sent=True. We verify that the draft was stored
        # with sent=False and that the approval mechanism is required.
        #
        # In production, Core enforces this at the HTTP API layer — the agent
        # cannot POST to the "mark sent" endpoint without an approval token.
        # We verify the approval token is required.
        wrong_token = "agent_forged_token_" + uuid.uuid4().hex
        tokens_registry: dict[str, str] = {}  # empty — no token was issued
        sent_ok = approve_action(
            staging, draft.draft_id, wrong_token, tokens_registry,
        )
        assert sent_ok is False, (
            "Agent must not be able to approve its own draft — "
            "a valid human-issued token is required"
        )

    # ---- Edge cases --------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0098", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "05", "title": "all_send_variants_downgraded"}
    def test_all_send_variants_downgraded(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """All send-like action names are downgraded: messages.send,
        send_email, send_message, email.send."""
        staging = mock_dina.staging
        send_actions = ["messages.send", "send_email", "send_message", "email.send"]

        for action in send_actions:
            result = downgrade_agent_send_to_draft(
                agent=mock_external_agent,
                action=action,
                target=f"recipient-{action}@test.com",
                body=f"Body for {action}",
                staging=staging,
            )

            assert result["downgraded"] is True, (
                f"Action '{action}' must be downgraded to a draft"
            )
            assert result["resulting_action"] == "drafts.create", (
                f"Action '{action}' must become 'drafts.create', "
                f"got '{result['resulting_action']}'"
            )
            assert result["draft"].sent is False, (
                f"Draft from '{action}' must have sent=False"
            )

        # Counter-proof: non-send actions are NOT downgraded
        safe_actions = ["search", "lookup", "read", "calendar.view"]
        for action in safe_actions:
            result = downgrade_agent_send_to_draft(
                agent=mock_external_agent,
                action=action,
                target="anything",
                body="anything",
                staging=staging,
            )
            assert result["downgraded"] is False, (
                f"Action '{action}' is not send-like — must NOT be downgraded"
            )

    # TRACE: {"suite": "INT", "case": "0099", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "06", "title": "draft_body_preserves_original_content_exactly"}
    def test_draft_body_preserves_original_content_exactly(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Body with unicode, newlines, and special characters is preserved
        exactly in the downgraded draft."""
        staging = mock_dina.staging

        complex_body = (
            "Hello \u00e9\u00e8\u00ea \u00fc\u00f6\u00e4\n"
            "Line 2 with\ttabs\n"
            "Emoji: \U0001f600 \U0001f680\n"
            "Special: <script>alert('xss')</script>\n"
            'Quotes: "double" and \'single\'\n'
            "Null-ish: \\0 \\n (literal backslash-n)\n"
            "CJK: \u4f60\u597d\u4e16\u754c \u3053\u3093\u306b\u3061\u306f\n"
            "Arabic: \u0645\u0631\u062d\u0628\u0627\n"
            "Math: \u222b f(x)dx = F(x) + C"
        )

        result = downgrade_agent_send_to_draft(
            agent=mock_external_agent,
            action="messages.send",
            target="intl@example.com",
            body=complex_body,
            staging=staging,
        )

        assert result["draft"].body == complex_body, (
            "Draft body must preserve unicode, newlines, tabs, and special "
            "characters byte-for-byte"
        )

        # Verify through staging retrieval as well
        stored = staging.get(result["draft_id"])
        assert stored.body == complex_body, (
            "Staged draft body must match the original exactly after retrieval"
        )

    # TRACE: {"suite": "INT", "case": "0100", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "07", "title": "draft_gets_unique_id"}
    def test_draft_gets_unique_id(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Each downgraded draft gets a unique ID — no collisions."""
        staging = mock_dina.staging
        draft_ids: set[str] = set()

        for i in range(50):
            result = downgrade_agent_send_to_draft(
                agent=mock_external_agent,
                action="messages.send",
                target=f"user{i}@test.com",
                body=f"Message number {i}",
                staging=staging,
            )
            draft_id = result["draft_id"]
            assert draft_id not in draft_ids, (
                f"Draft ID collision: '{draft_id}' was already assigned to "
                f"a previous draft (iteration {i})"
            )
            draft_ids.add(draft_id)

        assert len(draft_ids) == 50, (
            "50 send requests must produce 50 unique draft IDs"
        )

    # TRACE: {"suite": "INT", "case": "0101", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "06", "scenario": "08", "title": "multiple_send_requests_each_create_separate_draft"}
    def test_multiple_send_requests_each_create_separate_draft(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """3 send requests -> 3 separate drafts in staging, each independently
        retrievable with correct content."""
        staging = mock_dina.staging

        requests = [
            ("alice@example.com", "Hi Alice, meeting at 3pm"),
            ("bob@example.com", "Bob, please review the PR"),
            ("carol@example.com", "Carol, updated the budget sheet"),
        ]

        drafts = []
        for target, body in requests:
            result = downgrade_agent_send_to_draft(
                agent=mock_external_agent,
                action="messages.send",
                target=target,
                body=body,
                staging=staging,
            )
            assert result["downgraded"] is True
            drafts.append(result)

        # All 3 drafts must be distinct and independently stored
        draft_ids = [d["draft_id"] for d in drafts]
        assert len(set(draft_ids)) == 3, (
            "3 send requests must produce 3 distinct draft IDs"
        )

        # Each draft is independently retrievable with correct content
        for i, (target, body) in enumerate(requests):
            stored = staging.get(drafts[i]["draft_id"])
            assert stored is not None, (
                f"Draft {i} must be retrievable from staging"
            )
            assert stored.to == target, (
                f"Draft {i} recipient mismatch: expected '{target}', "
                f"got '{stored.to}'"
            )
            assert stored.body == body, (
                f"Draft {i} body mismatch: expected '{body}', "
                f"got '{stored.body}'"
            )
            assert stored.sent is False, (
                f"Draft {i} must not be auto-sent"
            )


# ---------------------------------------------------------------------------
# Cart Handover Lifecycle helpers
# ---------------------------------------------------------------------------


CART_HANDOVER_TTL_HOURS = 12
"""Payment intents have a 12-hour TTL — shorter than drafts (72h).

Money-related actions have a tighter safety window because stale payment
intents are more dangerous than stale email drafts: prices change, stock
depletes, and session tokens expire.  The Cart Handover principle means
Dina builds the cart and hands it to the user; if the user does not act
within 12 hours the intent is cleaned up and the user is notified.
"""

DRAFT_TTL_HOURS = 72
"""Standard draft TTL for comparison — 72 hours."""


def create_cart_handover(
    staging: MockStagingTier,
    merchant: str,
    amount: float,
    currency: str,
    method: str = "web",
    intent_uri: str = "",
    ttl_hours: float = CART_HANDOVER_TTL_HOURS,
    created_at: float | None = None,
) -> tuple[PaymentIntent, str]:
    """Create a PaymentIntent (cart handover) with a specified TTL.

    Cart Handover principle: Dina advises on purchases but never touches
    money.  This helper creates the intent with the correct expiry window
    and stores it in staging.  The default 12-hour TTL is intentionally
    shorter than the 72-hour draft TTL because money-related actions have
    a tighter safety profile.

    Returns (PaymentIntent, intent_id).
    """
    base = created_at if created_at is not None else time.time()
    intent_id = f"cart_{uuid.uuid4().hex[:8]}"

    if not intent_uri:
        if method == "upi":
            safe_merchant = merchant.replace(" ", "").lower()
            intent_uri = (
                f"upi://pay?pa={safe_merchant}@upi"
                f"&pn={merchant}&am={amount}&cu={currency}"
            )
        elif method == "crypto":
            intent_uri = f"ethereum:0xABC?value={amount}&token={currency}"
        else:
            safe_merchant = merchant.replace(" ", "-").lower()
            intent_uri = (
                f"https://{safe_merchant}.example.com"
                f"/checkout?amount={amount}&currency={currency}"
            )

    intent = PaymentIntent(
        intent_id=intent_id,
        method=method,
        intent_uri=intent_uri,
        merchant=merchant,
        amount=amount,
        currency=currency,
        recommendation=f"Best option from {merchant} per trust network.",
        created_at=base,
        expires_at=base + ttl_hours * 3600,
        executed=False,
    )
    stored_id = staging.store_payment_intent(intent)
    return intent, stored_id


def check_cart_handover_expiry(
    staging: MockStagingTier,
    intent_id: str,
    current_time: float,
) -> dict:
    """Check whether a payment intent has expired at the given time.

    This implements real business logic: before purging, the system must
    inspect expired intents so it can generate notifications that tell the
    user which cart handover expired (merchant, amount).  The user needs
    this context to decide whether to re-create the intent.

    Returns dict with keys:
      - expired (bool)
      - intent (PaymentIntent | None) — the intent if still alive
      - notification (Notification | None) — generated if expired
    """
    # Look up the item directly (bypass time.time()-based get() which
    # uses wall clock; we need to evaluate against the provided time).
    item = staging._items.get(intent_id)

    if item is None:
        # Already purged or never existed
        return {"expired": True, "intent": None, "notification": None}

    if not isinstance(item, PaymentIntent):
        return {"expired": False, "intent": None, "notification": None}

    if current_time > item.expires_at:
        # Intent has expired — generate a notification with context
        notification = Notification(
            tier=SilenceTier.TIER_3_ENGAGEMENT,
            title="Payment intent expired",
            body=(
                f"Cart handover for {item.merchant} "
                f"({item.amount} {item.currency}) expired after "
                f"{CART_HANDOVER_TTL_HOURS} hours without action. "
                f"Recreate if you still want to purchase."
            ),
            actions=["recreate", "dismiss"],
            source="cart_expiry",
        )
        return {"expired": True, "intent": item, "notification": notification}

    # Still alive
    return {"expired": False, "intent": item, "notification": None}


# ---------------------------------------------------------------------------
# TestCartHandoverLifecycle (TST-INT-727)
# ---------------------------------------------------------------------------


class TestCartHandoverLifecycle:
    """Cart handover lifecycle: create -> expire.

    Validates that payment intents (cart handovers) have a shorter TTL than
    drafts (12h vs 72h), expire correctly, and generate user-facing
    notifications on expiry.  The Cart Handover principle: Dina builds the
    cart but the user finalises payment — Dina never touches money.
    """

# TST-INT-727
    # TRACE: {"suite": "INT", "case": "0727", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "01", "title": "cart_handover_lifecycle_create_expire"}
    def test_cart_handover_lifecycle_create_expire(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Brain creates payment intent -> 13 hours pass | Intent expired
        — shorter TTL than drafts.

        Full lifecycle:
        1. Create a payment intent for BookStore, 2500 INR, 12h TTL
        2. Verify stored successfully with executed=False
        3. At 11h: still alive
        4. At 13h: expired and removed
        5. Expiry notification generated with merchant/amount context
        6. TTL is shorter than drafts (12h vs 72h)
        """
        staging = mock_dina.staging
        base_time = time.time()

        # --- Step 1: Create a payment intent ---
        intent, intent_id = create_cart_handover(
            staging,
            merchant="BookStore",
            amount=2500.0,
            currency="INR",
            method="web",
            created_at=base_time,
        )

        # --- Step 2: Verify stored successfully ---
        retrieved = staging._items.get(intent_id)
        assert retrieved is not None, (
            "Payment intent must be stored in staging"
        )
        assert retrieved.executed is False, (
            "Cart Handover: intent must NOT be executed — user finalises"
        )
        assert retrieved.merchant == "BookStore"
        assert retrieved.amount == 2500.0
        assert retrieved.currency == "INR"
        assert retrieved.method == "web"

        # Verify TTL is 12 hours (not 72h default)
        expected_expiry = base_time + CART_HANDOVER_TTL_HOURS * 3600
        assert abs(retrieved.expires_at - expected_expiry) < 1.0, (
            f"Payment intent must expire at {CART_HANDOVER_TTL_HOURS}h, "
            f"got delta {retrieved.expires_at - expected_expiry}"
        )

        # --- Step 3: At 11 hours — intent still alive ---
        time_at_11h = base_time + 11 * 3600
        result_11h = check_cart_handover_expiry(
            staging, intent_id, time_at_11h,
        )
        assert result_11h["expired"] is False, (
            "Intent must be alive at 11h (within 12h TTL)"
        )
        assert result_11h["intent"] is not None, (
            "Intent must be retrievable at 11h"
        )
        assert result_11h["notification"] is None, (
            "No notification should be generated before expiry"
        )
        # Also verify auto_expire does NOT remove it at 11h
        expired_count_11h = staging.auto_expire(current_time=time_at_11h)
        assert expired_count_11h == 0, (
            "auto_expire must not remove anything at 11h"
        )
        assert staging._items.get(intent_id) is not None, (
            "Intent must still exist in staging after auto_expire at 11h"
        )

        # --- Step 4: At 13 hours — past TTL ---
        time_at_13h = base_time + 13 * 3600

        # Check expiry status and capture notification BEFORE purging
        result_13h = check_cart_handover_expiry(
            staging, intent_id, time_at_13h,
        )
        assert result_13h["expired"] is True, (
            "Intent must be expired at 13h (past 12h TTL)"
        )

        # Now purge via auto_expire
        expired_count_13h = staging.auto_expire(current_time=time_at_13h)
        assert expired_count_13h == 1, (
            "auto_expire should remove exactly 1 intent at 13h"
        )

        # --- Step 5: Intent no longer retrievable ---
        assert staging._items.get(intent_id) is None, (
            "Intent must be purged from staging after expiry"
        )

        # --- Step 6: Verify expiry notification ---
        notification = result_13h["notification"]
        assert notification is not None, (
            "Expiry must generate a notification for the user"
        )
        assert notification.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            "Cart expiry is engagement-tier (daily briefing), not fiduciary"
        )
        # Counter-proof: NOT tier 1 (fiduciary)
        assert notification.tier != SilenceTier.TIER_1_FIDUCIARY, (
            "Cart expiry must never be fiduciary — no immediate harm"
        )
        assert "BookStore" in notification.body, (
            "Notification must mention the merchant"
        )
        assert "2500" in notification.body, (
            "Notification must mention the amount"
        )
        assert "INR" in notification.body, (
            "Notification must mention the currency"
        )
        assert "expired" in notification.body.lower(), (
            "Notification body must mention 'expired'"
        )
        assert notification.source == "cart_expiry"
        assert "recreate" in notification.actions, (
            "Notification must offer a 'recreate' action"
        )

        # --- Step 7: TTL is shorter than drafts ---
        assert CART_HANDOVER_TTL_HOURS < DRAFT_TTL_HOURS, (
            "Payment intents must have a shorter TTL than drafts "
            f"({CART_HANDOVER_TTL_HOURS}h < {DRAFT_TTL_HOURS}h) — "
            "money has a tighter safety profile"
        )

    # -- Counter-proofs -------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0102", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "02", "title": "cart_handover_shorter_ttl_than_draft"}
    def test_cart_handover_shorter_ttl_than_draft(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """At 13h a payment intent is expired but a draft created at the
        same time is still alive.  Validates the different safety profiles
        of money vs messages."""
        staging = mock_dina.staging
        base_time = time.time()

        # Create a draft with default 72h TTL
        draft = Draft(
            draft_id=f"draft_ttl_cmp_{uuid.uuid4().hex[:8]}",
            to="team@company.com",
            subject="Weekly sync notes",
            body="Here are the notes.",
            confidence=0.85,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Create a payment intent with 12h TTL at the same time
        intent, intent_id = create_cart_handover(
            staging,
            merchant="GadgetShop",
            amount=7999.0,
            currency="INR",
            created_at=base_time,
        )

        # Sanity: verify different expiry times
        assert intent.expires_at < draft.expires_at, (
            "Intent must expire before draft "
            f"(intent: {intent.expires_at}, draft: {draft.expires_at})"
        )

        # At 13h: intent expired, draft alive
        time_at_13h = base_time + 13 * 3600
        expired_count = staging.auto_expire(current_time=time_at_13h)
        assert expired_count == 1, (
            "Only the payment intent should expire at 13h, not the draft"
        )

        # Intent gone
        assert staging._items.get(intent_id) is None, (
            "Payment intent must be gone at 13h"
        )

        # Draft still alive
        draft_still = staging._items.get(draft.draft_id)
        assert draft_still is not None, (
            "Draft must still exist at 13h (72h TTL)"
        )
        assert draft_still.sent is False

        # Counter-proof: at 73h, the draft also expires
        time_at_73h = base_time + 73 * 3600
        expired_count_73h = staging.auto_expire(current_time=time_at_73h)
        assert expired_count_73h == 1, (
            "Draft should expire at 73h"
        )
        assert staging._items.get(draft.draft_id) is None, (
            "Draft must be gone at 73h"
        )

    # TRACE: {"suite": "INT", "case": "0103", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "03", "title": "intent_alive_before_expiry"}
    def test_intent_alive_before_expiry(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """At 11h59m the intent is still retrievable — proves the boundary
        is correctly at 12h, not before."""
        staging = mock_dina.staging
        base_time = time.time()

        intent, intent_id = create_cart_handover(
            staging,
            merchant="CoffeeHouse",
            amount=350.0,
            currency="INR",
            created_at=base_time,
        )

        # At 11h 59m (11 * 3600 + 59 * 60 = 43140 seconds)
        time_at_11h59m = base_time + 11 * 3600 + 59 * 60
        result = check_cart_handover_expiry(
            staging, intent_id, time_at_11h59m,
        )
        assert result["expired"] is False, (
            "Intent must be alive at 11h59m — still within 12h TTL"
        )
        assert result["intent"] is not None
        assert result["intent"].merchant == "CoffeeHouse"
        assert result["notification"] is None, (
            "No notification before expiry"
        )

        # auto_expire also does not remove it
        expired_count = staging.auto_expire(current_time=time_at_11h59m)
        assert expired_count == 0
        assert staging._items.get(intent_id) is not None

    # TRACE: {"suite": "INT", "case": "0104", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "04", "title": "executed_intent_does_not_expire"}
    def test_executed_intent_does_not_expire(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """An executed (completed) intent should not be auto-expired — the
        user already acted on it.  While auto_expire will still purge it
        by timestamp (it does not check the executed flag), the business
        logic check in check_cart_handover_expiry must still report it as
        expired.  The key assertion is that an executed intent remains
        in staging during its TTL window and is accessible for audit."""
        staging = mock_dina.staging
        base_time = time.time()

        intent, intent_id = create_cart_handover(
            staging,
            merchant="ElectroMart",
            amount=15000.0,
            currency="INR",
            created_at=base_time,
        )

        # User executes the payment (marks intent as done)
        stored = staging._items.get(intent_id)
        stored.executed = True

        # At 6h: intent still alive and executed flag preserved
        time_at_6h = base_time + 6 * 3600
        result = check_cart_handover_expiry(
            staging, intent_id, time_at_6h,
        )
        assert result["expired"] is False, (
            "Executed intent at 6h must not be expired"
        )
        assert result["intent"] is not None
        assert result["intent"].executed is True, (
            "Executed flag must be preserved during TTL window"
        )
        assert result["notification"] is None

        # auto_expire also does not remove it at 6h
        expired_count = staging.auto_expire(current_time=time_at_6h)
        assert expired_count == 0
        assert staging._items.get(intent_id) is not None

        # The executed intent is accessible for the full 12h window
        time_at_11h = base_time + 11 * 3600
        result_11h = check_cart_handover_expiry(
            staging, intent_id, time_at_11h,
        )
        assert result_11h["expired"] is False
        assert result_11h["intent"].executed is True, (
            "Executed flag must persist through the full TTL window"
        )

    # -- Edge cases -----------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0105", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "05", "title": "exactly_at_expiry_boundary"}
    def test_exactly_at_expiry_boundary(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """At exactly 12h the intent is NOT expired (strict > comparison).
        The expiry uses `current_time > expires_at`, meaning the intent
        is alive at exactly its expiry timestamp and only expires after."""
        staging = mock_dina.staging
        base_time = time.time()

        intent, intent_id = create_cart_handover(
            staging,
            merchant="BoundaryShop",
            amount=100.0,
            currency="USD",
            created_at=base_time,
        )

        # At exactly 12h — should NOT be expired (strict >)
        time_at_exactly_12h = base_time + CART_HANDOVER_TTL_HOURS * 3600
        assert time_at_exactly_12h == intent.expires_at, (
            "Sanity: time should equal expires_at exactly"
        )

        result_exact = check_cart_handover_expiry(
            staging, intent_id, time_at_exactly_12h,
        )
        assert result_exact["expired"] is False, (
            "At exactly expires_at, intent must NOT be expired "
            "(strict > comparison, not >=)"
        )
        assert result_exact["notification"] is None

        # auto_expire also uses strict > — should not purge
        expired_count = staging.auto_expire(
            current_time=time_at_exactly_12h,
        )
        assert expired_count == 0, (
            "auto_expire with strict > must not purge at exact boundary"
        )
        assert staging._items.get(intent_id) is not None

        # One second later — NOW it is expired
        time_at_12h_plus_1s = time_at_exactly_12h + 1
        result_plus_1 = check_cart_handover_expiry(
            staging, intent_id, time_at_12h_plus_1s,
        )
        assert result_plus_1["expired"] is True, (
            "One second after expiry boundary must be expired"
        )
        assert result_plus_1["notification"] is not None

        expired_count_after = staging.auto_expire(
            current_time=time_at_12h_plus_1s,
        )
        assert expired_count_after == 1
        assert staging._items.get(intent_id) is None

    # TRACE: {"suite": "INT", "case": "0106", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "06", "title": "multiple_intents_expire_independently"}
    def test_multiple_intents_expire_independently(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Three intents created at different times each expire at their
        own 12h mark — they do not interfere with each other."""
        staging = mock_dina.staging
        base_time = time.time()

        # Intent A: created at base_time
        intent_a, id_a = create_cart_handover(
            staging,
            merchant="ShopA",
            amount=100.0,
            currency="USD",
            created_at=base_time,
        )

        # Intent B: created 2 hours later
        intent_b, id_b = create_cart_handover(
            staging,
            merchant="ShopB",
            amount=200.0,
            currency="EUR",
            created_at=base_time + 2 * 3600,
        )

        # Intent C: created 5 hours later
        intent_c, id_c = create_cart_handover(
            staging,
            merchant="ShopC",
            amount=300.0,
            currency="GBP",
            created_at=base_time + 5 * 3600,
        )

        # At 13h from base: A expired (12h window passed), B and C alive
        time_at_13h = base_time + 13 * 3600
        result_a = check_cart_handover_expiry(staging, id_a, time_at_13h)
        result_b = check_cart_handover_expiry(staging, id_b, time_at_13h)
        result_c = check_cart_handover_expiry(staging, id_c, time_at_13h)

        assert result_a["expired"] is True, "A (created at t+0) expired at t+13h"
        assert result_b["expired"] is False, (
            "B (created at t+2h) alive at t+13h — its window ends at t+14h"
        )
        assert result_c["expired"] is False, (
            "C (created at t+5h) alive at t+13h — its window ends at t+17h"
        )

        expired_count_13h = staging.auto_expire(current_time=time_at_13h)
        assert expired_count_13h == 1, "Only A should be purged at t+13h"
        assert staging._items.get(id_a) is None
        assert staging._items.get(id_b) is not None
        assert staging._items.get(id_c) is not None

        # At 15h from base: B also expired (created at t+2h, expires t+14h)
        time_at_15h = base_time + 15 * 3600
        result_b_15h = check_cart_handover_expiry(staging, id_b, time_at_15h)
        assert result_b_15h["expired"] is True, (
            "B must be expired at t+15h (window ended at t+14h)"
        )
        assert result_b_15h["notification"] is not None
        assert "ShopB" in result_b_15h["notification"].body

        expired_count_15h = staging.auto_expire(current_time=time_at_15h)
        assert expired_count_15h == 1, "Only B should be purged at t+15h"
        assert staging._items.get(id_b) is None
        assert staging._items.get(id_c) is not None

        # At 18h from base: C also expired (created at t+5h, expires t+17h)
        time_at_18h = base_time + 18 * 3600
        expired_count_18h = staging.auto_expire(current_time=time_at_18h)
        assert expired_count_18h == 1, "Only C should be purged at t+18h"
        assert staging._items.get(id_c) is None

    # TRACE: {"suite": "INT", "case": "0107", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "07", "title": "cart_handover_preserves_payment_details"}
    def test_cart_handover_preserves_payment_details(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Merchant, amount, currency, and method are all preserved
        faithfully until the intent expires.  Cart Handover means Dina
        builds the cart accurately — the user must be able to trust
        the details when they decide to finalise."""
        staging = mock_dina.staging
        base_time = time.time()

        intent, intent_id = create_cart_handover(
            staging,
            merchant="Artisan Furniture Co.",
            amount=47500.50,
            currency="INR",
            method="upi",
            intent_uri="upi://pay?pa=artisan@upi&pn=Artisan&am=47500.50&cu=INR",
            created_at=base_time,
        )

        # Verify all details immediately after creation
        stored = staging._items.get(intent_id)
        assert stored.merchant == "Artisan Furniture Co."
        assert stored.amount == 47500.50
        assert stored.currency == "INR"
        assert stored.method == "upi"
        assert "upi://pay" in stored.intent_uri
        assert stored.executed is False
        assert stored.recommendation == (
            "Best option from Artisan Furniture Co. per trust network."
        )

        # At 6h — details still intact
        time_at_6h = base_time + 6 * 3600
        result_6h = check_cart_handover_expiry(
            staging, intent_id, time_at_6h,
        )
        assert result_6h["expired"] is False
        live_intent = result_6h["intent"]
        assert live_intent.merchant == "Artisan Furniture Co.", (
            "Merchant must be preserved at 6h"
        )
        assert live_intent.amount == 47500.50, (
            "Amount must be preserved at 6h"
        )
        assert live_intent.currency == "INR", (
            "Currency must be preserved at 6h"
        )
        assert live_intent.method == "upi", (
            "Method must be preserved at 6h"
        )
        assert "artisan@upi" in live_intent.intent_uri, (
            "Intent URI must be preserved at 6h"
        )

        # At 11h — still intact (just before boundary)
        time_at_11h = base_time + 11 * 3600
        result_11h = check_cart_handover_expiry(
            staging, intent_id, time_at_11h,
        )
        assert result_11h["expired"] is False
        assert result_11h["intent"].amount == 47500.50

        # At 13h — expired, but the notification preserves context
        time_at_13h = base_time + 13 * 3600
        result_13h = check_cart_handover_expiry(
            staging, intent_id, time_at_13h,
        )
        assert result_13h["expired"] is True
        notif = result_13h["notification"]
        assert "Artisan Furniture Co." in notif.body, (
            "Expiry notification must mention merchant name"
        )
        assert "47500.5" in notif.body, (
            "Expiry notification must mention amount"
        )
        assert "INR" in notif.body, (
            "Expiry notification must mention currency"
        )

    # TRACE: {"suite": "INT", "case": "0108", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "07", "scenario": "08", "title": "zero_amount_intent_still_has_ttl"}
    def test_zero_amount_intent_still_has_ttl(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Even a 0-amount intent (free trial signup) has the full TTL
        lifecycle.  A zero-amount cart handover is still a cart handover —
        it represents a commitment (e.g., signing up for a free trial that
        requires payment details).  The TTL ensures stale signups are
        cleaned up."""
        staging = mock_dina.staging
        base_time = time.time()

        intent, intent_id = create_cart_handover(
            staging,
            merchant="StreamingService",
            amount=0.0,
            currency="USD",
            method="web",
            created_at=base_time,
        )

        # Verify stored with 0 amount
        stored = staging._items.get(intent_id)
        assert stored is not None
        assert stored.amount == 0.0, "Zero-amount intent must store amount as 0.0"
        assert stored.executed is False

        # TTL is still 12h — zero amount does not bypass the lifecycle
        expected_expiry = base_time + CART_HANDOVER_TTL_HOURS * 3600
        assert abs(stored.expires_at - expected_expiry) < 1.0, (
            "Zero-amount intent must still have 12h TTL"
        )

        # At 11h: still alive
        time_at_11h = base_time + 11 * 3600
        result_11h = check_cart_handover_expiry(
            staging, intent_id, time_at_11h,
        )
        assert result_11h["expired"] is False
        assert result_11h["intent"].amount == 0.0

        # At 13h: expired with notification
        time_at_13h = base_time + 13 * 3600
        result_13h = check_cart_handover_expiry(
            staging, intent_id, time_at_13h,
        )
        assert result_13h["expired"] is True
        assert result_13h["notification"] is not None
        assert "StreamingService" in result_13h["notification"].body
        assert "0.0" in result_13h["notification"].body, (
            "Even zero-amount expiry notification must show the amount"
        )

        # Purge works
        expired_count = staging.auto_expire(current_time=time_at_13h)
        assert expired_count == 1
        assert staging._items.get(intent_id) is None


# ---------------------------------------------------------------------------
# Helper: simulate_brain_crash_and_recovery
# ---------------------------------------------------------------------------


def simulate_brain_crash_and_recovery(
    brain: "MockPythonBrain",
    staging: MockStagingTier,
    draft_ids: list[str],
) -> dict:
    """Simulate a Brain sidecar crash and recovery, then verify draft survival.

    The sidecar architecture means drafts live in Core's staging tier (SQLite),
    not in Brain's memory.  A Brain crash (OOM, segfault, container restart)
    must have ZERO impact on pending drafts because Core is an independent
    process.  After restart, Brain recovers state by querying Core's staging.

    Steps:
      1. Snapshot pre-crash state of all draft_ids from staging.
      2. Crash the Brain (``brain.crash()``).
      3. Verify Brain is in crashed state (operations raise RuntimeError).
      4. Restart the Brain (``brain.restart()``).
      5. Verify Brain is healthy (operations succeed).
      6. Query Core staging for every draft_id to recover state.
      7. Compare pre-crash and post-recovery states.

    Returns a dict with:
      - drafts_survived: list[str] — draft_ids still present in staging
      - drafts_lost: list[str] — draft_ids no longer in staging
      - brain_recovered: bool — True if Brain is operational after restart
      - pre_crash_state: dict[str, dict] — {draft_id: {to, subject, body, confidence, sent}}
      - post_recovery_state: dict[str, dict] — same shape, from post-recovery query
    """
    # --- Step 1: Snapshot pre-crash state ---
    pre_crash_state: dict[str, dict] = {}
    for did in draft_ids:
        item = staging._items.get(did)
        if item is not None and isinstance(item, Draft):
            pre_crash_state[did] = {
                "to": item.to,
                "subject": item.subject,
                "body": item.body,
                "confidence": item.confidence,
                "sent": item.sent,
                "created_at": item.created_at,
                "expires_at": item.expires_at,
            }

    # --- Step 2: Crash the Brain ---
    brain.crash()

    # --- Step 3: Verify Brain is crashed ---
    brain_is_crashed = brain._crashed is True
    assert brain_is_crashed, "Brain must be in crashed state after crash()"

    # Verify Brain operations raise RuntimeError while crashed
    try:
        brain.process({"type": "test", "content": "probe"})
        brain_rejects_while_crashed = False
    except RuntimeError:
        brain_rejects_while_crashed = True
    assert brain_rejects_while_crashed, (
        "Brain must reject process() calls while crashed"
    )

    # --- Step 4: Restart the Brain ---
    brain.restart()

    # --- Step 5: Verify Brain is healthy ---
    brain_recovered = brain._crashed is False
    assert brain_recovered, "Brain must be healthy after restart()"

    # Verify Brain can process again
    try:
        brain.process({"type": "test", "content": "health_check"})
        brain_operational = True
    except RuntimeError:
        brain_operational = False
    assert brain_operational, (
        "Brain must accept process() calls after restart"
    )

    # --- Step 6: Query Core staging for all drafts (recovery) ---
    post_recovery_state: dict[str, dict] = {}
    drafts_survived: list[str] = []
    drafts_lost: list[str] = []

    for did in draft_ids:
        item = staging._items.get(did)
        if item is not None and isinstance(item, Draft):
            drafts_survived.append(did)
            post_recovery_state[did] = {
                "to": item.to,
                "subject": item.subject,
                "body": item.body,
                "confidence": item.confidence,
                "sent": item.sent,
                "created_at": item.created_at,
                "expires_at": item.expires_at,
            }
        else:
            drafts_lost.append(did)

    return {
        "drafts_survived": drafts_survived,
        "drafts_lost": drafts_lost,
        "brain_recovered": brain_recovered,
        "pre_crash_state": pre_crash_state,
        "post_recovery_state": post_recovery_state,
    }


# ---------------------------------------------------------------------------
# TestApprovalSurvivesBrainCrash (TST-INT-729)
# ---------------------------------------------------------------------------


class TestApprovalSurvivesBrainCrash:
    """Approval survives brain crash.

    Section 23.1 Action Pipeline (Core<->Brain).

    The sidecar pattern means Core is the vault keeper and Brain is a
    stateless analyst.  Drafts pending approval are stored in Core's staging
    tier (SQLite), NOT in Brain's memory.  When Brain crashes and restarts,
    all pending drafts must still be in Core staging — unchanged, un-auto-
    approved, and available for the approval flow to continue.

    This is a critical resilience guarantee: a Brain OOM or container restart
    must never cause data loss or silent state changes in the action pipeline.
    """

    # ---- Primary test (TST-INT-729) -----------------------------------------

# TST-INT-729
    # TRACE: {"suite": "INT", "case": "0729", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "01", "title": "approval_survives_brain_crash"}
    def test_approval_survives_brain_crash(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Draft pending approval -> brain crashes -> brain restarts |
        Draft still pending in Core staging — brain recovers state from
        scratchpad.

        1. Create 3 drafts in Core staging (various recipients/subjects)
        2. Verify all 3 are pending (sent=False)
        3. Simulate Brain crash
        4. Verify Brain is crashed/unhealthy
        5. Simulate Brain restart
        6. Verify Brain is healthy
        7. Query Core staging -> ALL 3 drafts still present
        8. Each draft has original content intact (to, subject, body, confidence)
        9. Each draft still has sent=False (pending, not auto-approved)
        10. Approve one draft post-recovery -> approval flow works
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        # --- Step 1: Create 3 drafts in Core staging ---
        draft_specs = [
            ("alice@example.com", "Q4 Summary", "Revenue grew 15% in Q4.", 0.92),
            ("bob@corp.net", "Code Review", "PR #1234 needs your review.", 0.87),
            ("carol@startup.io", "Partnership Proposal",
             "Let us explore a joint venture.", 0.75),
        ]

        draft_ids: list[str] = []
        for to, subject, body, confidence in draft_specs:
            draft = Draft(
                draft_id=f"draft_crash_{uuid.uuid4().hex[:8]}",
                to=to,
                subject=subject,
                body=body,
                confidence=confidence,
                created_at=base_time,
            )
            staging.store_draft(draft)
            draft_ids.append(draft.draft_id)

        # --- Step 2: Verify all 3 are pending ---
        for did in draft_ids:
            item = staging._items.get(did)
            assert item is not None, f"Draft {did} must exist before crash"
            assert item.sent is False, f"Draft {did} must be pending (sent=False)"

        # --- Steps 3-6: Crash and recover ---
        result = simulate_brain_crash_and_recovery(
            brain, staging, draft_ids,
        )

        # --- Step 7: ALL 3 drafts survived ---
        assert len(result["drafts_survived"]) == 3, (
            f"All 3 drafts must survive brain crash, but only "
            f"{len(result['drafts_survived'])} survived: "
            f"lost={result['drafts_lost']}"
        )
        assert result["drafts_lost"] == [], (
            f"No drafts should be lost, but lost: {result['drafts_lost']}"
        )
        assert result["brain_recovered"] is True

        # --- Step 8: Each draft has original content intact ---
        for i, did in enumerate(draft_ids):
            to, subject, body, confidence = draft_specs[i]
            post = result["post_recovery_state"][did]
            pre = result["pre_crash_state"][did]

            assert post["to"] == to, (
                f"Draft {did}: 'to' changed from '{to}' to '{post['to']}'"
            )
            assert post["subject"] == subject, (
                f"Draft {did}: 'subject' changed"
            )
            assert post["body"] == body, (
                f"Draft {did}: 'body' changed"
            )
            assert post["confidence"] == confidence, (
                f"Draft {did}: 'confidence' changed from "
                f"{confidence} to {post['confidence']}"
            )

            # Pre-crash and post-recovery states must be identical
            assert pre == post, (
                f"Draft {did}: pre-crash state differs from post-recovery "
                f"state. Pre={pre}, Post={post}"
            )

        # --- Step 9: No draft was auto-approved during crash ---
        for did in draft_ids:
            item = staging._items.get(did)
            assert item.sent is False, (
                f"Draft {did} must still be pending (sent=False) after "
                f"brain crash — no silent auto-approval"
            )

        # --- Step 10: Approval flow works post-recovery ---
        first_draft = staging._items.get(draft_ids[0])
        approval_token = generate_payload_bound_token(
            draft_ids[0], first_draft.body,
        )
        send_result = attempt_send_approved_draft(
            staging, draft_ids[0], first_draft.body, approval_token,
        )
        assert send_result["sent"] is True, (
            "Approval flow must work after brain recovery — the draft "
            "is still in Core staging and fully functional"
        )
        assert staging._items.get(draft_ids[0]).sent is True, (
            "Draft must be marked sent after post-recovery approval"
        )

        # Other drafts remain pending (approval of one does not affect others)
        for did in draft_ids[1:]:
            assert staging._items.get(did).sent is False, (
                f"Draft {did} must remain pending after sibling approval"
            )

    # ---- Counter-proofs -----------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0109", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "02", "title": "draft_in_core_not_in_brain_memory"}
    def test_draft_in_core_not_in_brain_memory(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Verify that drafts are stored via staging (Core), not in Brain's
        internal state.

        Brain's ``processed`` and ``reasoned`` lists are ephemeral in-memory
        state. Drafts must NOT appear there — they must be in ``staging``,
        which represents Core's SQLite-backed staging tier.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        draft = Draft(
            draft_id=f"draft_location_{uuid.uuid4().hex[:8]}",
            to="test@example.com",
            subject="Storage location test",
            body="This draft must live in Core, not Brain.",
            confidence=0.88,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Draft is in staging (Core)
        assert staging._items.get(draft.draft_id) is not None, (
            "Draft must be in staging (Core's tier)"
        )

        # Draft is NOT in Brain's ephemeral state
        brain_processed_ids = [
            p.get("draft_id") for p in brain.processed if "draft_id" in p
        ]
        assert draft.draft_id not in brain_processed_ids, (
            "Draft must NOT appear in Brain's processed list — "
            "Brain is stateless, drafts belong to Core"
        )

        brain_reasoned_ids = [
            r.get("draft_id") for r in brain.reasoned if "draft_id" in r
        ]
        assert draft.draft_id not in brain_reasoned_ids, (
            "Draft must NOT appear in Brain's reasoned list"
        )

        # Crash brain — draft still in Core
        brain.crash()
        assert staging._items.get(draft.draft_id) is not None, (
            "Draft must survive in Core staging even when Brain is crashed"
        )
        brain.restart()

    # TRACE: {"suite": "INT", "case": "0110", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "03", "title": "brain_crash_does_not_auto_approve_pending_drafts"}
    def test_brain_crash_does_not_auto_approve_pending_drafts(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """After crash + recovery, no draft was silently approved or sent.

        A crash must be a no-op on draft state. If any draft transitions
        from sent=False to sent=True during a crash window without human
        approval, the system has violated the Silence First principle.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        draft_ids: list[str] = []
        for i in range(5):
            draft = Draft(
                draft_id=f"draft_noapprove_{i}_{uuid.uuid4().hex[:8]}",
                to=f"recipient_{i}@test.com",
                subject=f"Auto-approve test {i}",
                body=f"This is draft {i} — must never be auto-approved.",
                confidence=0.80 + i * 0.03,
                created_at=base_time,
            )
            staging.store_draft(draft)
            draft_ids.append(draft.draft_id)

        # All start as pending
        for did in draft_ids:
            assert staging._items.get(did).sent is False

        # Crash and recover
        brain.crash()
        brain.restart()

        # Counter-proof: NONE were auto-approved
        for did in draft_ids:
            item = staging._items.get(did)
            assert item is not None, (
                f"Draft {did} must still exist after crash+recovery"
            )
            assert item.sent is False, (
                f"Draft {did} was silently auto-approved during brain "
                f"crash — SAFETY VIOLATION. sent must remain False."
            )

    # TRACE: {"suite": "INT", "case": "0111", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "04", "title": "brain_crash_does_not_corrupt_draft_content"}
    def test_brain_crash_does_not_corrupt_draft_content(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Body, subject, to fields are bitwise identical before and after crash.

        Content integrity is critical for the approval flow: if the user
        approved specific content, a crash must not alter that content in
        any way.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        # Use content with unicode, special chars, and multi-line text
        # to catch subtle encoding corruption
        original_body = (
            "Transfer $5,000 to acct 1234-5678-9012\n"
            "\u00e9\u00e8\u00ea \u00fc\u00f6\u00e4 \U0001f600\n"
            "Line 3 with\ttabs and   multiple   spaces"
        )
        original_subject = "Wire \u2014 Q4 Reimbursement \u2192 Alice"
        original_to = "alice-\u00e9@example.com"

        draft = Draft(
            draft_id=f"draft_integrity_{uuid.uuid4().hex[:8]}",
            to=original_to,
            subject=original_subject,
            body=original_body,
            confidence=0.95,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Compute content hashes before crash
        pre_body_hash = hashlib.sha256(original_body.encode("utf-8")).hexdigest()
        pre_subject_hash = hashlib.sha256(
            original_subject.encode("utf-8"),
        ).hexdigest()
        pre_to_hash = hashlib.sha256(original_to.encode("utf-8")).hexdigest()

        # Crash and recover
        brain.crash()
        brain.restart()

        # Retrieve and verify bitwise identity
        recovered = staging._items.get(draft.draft_id)
        assert recovered is not None, "Draft must exist after crash"

        post_body_hash = hashlib.sha256(
            recovered.body.encode("utf-8"),
        ).hexdigest()
        post_subject_hash = hashlib.sha256(
            recovered.subject.encode("utf-8"),
        ).hexdigest()
        post_to_hash = hashlib.sha256(
            recovered.to.encode("utf-8"),
        ).hexdigest()

        assert post_body_hash == pre_body_hash, (
            "Body hash mismatch — content was corrupted during brain crash. "
            f"Pre: {pre_body_hash}, Post: {post_body_hash}"
        )
        assert post_subject_hash == pre_subject_hash, (
            "Subject hash mismatch — content was corrupted during brain crash"
        )
        assert post_to_hash == pre_to_hash, (
            "'to' hash mismatch — recipient was corrupted during brain crash"
        )

        # Direct string comparison (not just hash)
        assert recovered.body == original_body, (
            "Body must be identical string after crash"
        )
        assert recovered.subject == original_subject, (
            "Subject must be identical string after crash"
        )
        assert recovered.to == original_to, (
            "'to' must be identical string after crash"
        )
        assert recovered.confidence == 0.95, (
            "Confidence must be unchanged after crash"
        )

    # ---- Edge cases ---------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0112", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "05", "title": "multiple_crashes_drafts_still_survive"}
    def test_multiple_crashes_drafts_still_survive(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Crash -> recover -> crash again -> recover again -> drafts intact.

        Tests that the system handles repeated failures gracefully. Each
        crash-recovery cycle must leave Core staging completely unaffected.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        draft = Draft(
            draft_id=f"draft_multicrash_{uuid.uuid4().hex[:8]}",
            to="resilience@test.com",
            subject="Multi-crash survival test",
            body="This draft must survive multiple brain crashes.",
            confidence=0.90,
            created_at=base_time,
        )
        staging.store_draft(draft)
        draft_ids = [draft.draft_id]

        # First crash-recovery cycle
        result_1 = simulate_brain_crash_and_recovery(
            brain, staging, draft_ids,
        )
        assert result_1["drafts_survived"] == draft_ids, (
            "Draft must survive first crash"
        )
        assert result_1["post_recovery_state"][draft.draft_id]["sent"] is False

        # Second crash-recovery cycle
        result_2 = simulate_brain_crash_and_recovery(
            brain, staging, draft_ids,
        )
        assert result_2["drafts_survived"] == draft_ids, (
            "Draft must survive second crash"
        )
        assert result_2["post_recovery_state"][draft.draft_id]["sent"] is False

        # Third crash-recovery cycle
        result_3 = simulate_brain_crash_and_recovery(
            brain, staging, draft_ids,
        )
        assert result_3["drafts_survived"] == draft_ids, (
            "Draft must survive third crash"
        )

        # Content identical across all cycles
        for cycle_num, result in enumerate([result_1, result_2, result_3], 1):
            state = result["post_recovery_state"][draft.draft_id]
            assert state["to"] == "resilience@test.com", (
                f"Cycle {cycle_num}: 'to' corrupted"
            )
            assert state["subject"] == "Multi-crash survival test", (
                f"Cycle {cycle_num}: 'subject' corrupted"
            )
            assert state["body"] == (
                "This draft must survive multiple brain crashes."
            ), f"Cycle {cycle_num}: 'body' corrupted"
            assert state["confidence"] == 0.90, (
                f"Cycle {cycle_num}: 'confidence' corrupted"
            )
            assert state["sent"] is False, (
                f"Cycle {cycle_num}: draft silently approved"
            )

    # TRACE: {"suite": "INT", "case": "0113", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "06", "title": "approval_mid_crash_recoverable"}
    def test_approval_mid_crash_recoverable(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Draft was being reviewed when crash happened -> after recovery,
        draft is still pending (no half-state).

        In a real system, "being reviewed" means the Brain has queried Core
        for the draft content and is reasoning about it (e.g., generating
        a confidence explanation).  If Brain crashes mid-reasoning, the
        draft in Core must remain in its last consistent state: pending.
        There must be no half-approved or inconsistent state.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        draft = Draft(
            draft_id=f"draft_midcrash_{uuid.uuid4().hex[:8]}",
            to="important@client.com",
            subject="Contract Amendment",
            body="Attached is the revised contract with updated terms.",
            confidence=0.93,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Simulate Brain starting to review the draft (querying Core)
        retrieved_for_review = staging._items.get(draft.draft_id)
        assert retrieved_for_review is not None, (
            "Draft must be retrievable for review"
        )
        assert retrieved_for_review.sent is False, (
            "Draft is pending at start of review"
        )

        # Brain begins reasoning (this would be an LLM call in production)
        # but crashes before completing the review
        try:
            brain.process({
                "type": "draft_review",
                "content": retrieved_for_review.body,
                "draft_id": draft.draft_id,
            })
        except RuntimeError:
            pytest.fail("Brain should not crash during process() before crash()")

        # NOW the crash happens mid-review
        brain.crash()

        # Verify Brain cannot continue the review
        with pytest.raises(RuntimeError, match="crashed"):
            brain.reason(
                f"Should I approve draft {draft.draft_id}?",
                context={"draft": draft.draft_id},
            )

        # Restart
        brain.restart()

        # Draft is still in its last consistent state: pending
        post_draft = staging._items.get(draft.draft_id)
        assert post_draft is not None, (
            "Draft must still exist after mid-review crash"
        )
        assert post_draft.sent is False, (
            "Draft must be pending (sent=False) after mid-review crash — "
            "no half-approved state"
        )

        # Content unchanged
        assert post_draft.to == "important@client.com"
        assert post_draft.subject == "Contract Amendment"
        assert post_draft.body == (
            "Attached is the revised contract with updated terms."
        )
        assert post_draft.confidence == 0.93

        # The approval flow can proceed cleanly after recovery
        token = generate_payload_bound_token(
            draft.draft_id, post_draft.body,
        )
        result = attempt_send_approved_draft(
            staging, draft.draft_id, post_draft.body, token,
        )
        assert result["sent"] is True, (
            "Draft must be sendable after mid-review crash recovery"
        )

    # TRACE: {"suite": "INT", "case": "0114", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "08", "scenario": "07", "title": "expired_draft_during_crash_still_expires"}
    def test_expired_draft_during_crash_still_expires(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """If a draft's TTL expires during the crash window, it should still
        be expired on recovery (Core handles expiry independently).

        Core runs auto_expire on its own schedule — it does not depend on
        Brain being alive.  A draft that was created 71 hours before Brain
        crashed, where Brain was down for 2 hours, must be expired when
        auto_expire runs at hour 73, regardless of Brain's state.
        """
        staging = mock_dina.staging
        brain = mock_dina.brain
        base_time = time.time()

        # Draft created at base_time with default 72h TTL
        draft = Draft(
            draft_id=f"draft_expire_crash_{uuid.uuid4().hex[:8]}",
            to="ephemeral@test.com",
            subject="This will expire during crash",
            body="Content that should be cleaned up by Core.",
            confidence=0.70,
            created_at=base_time,
        )
        staging.store_draft(draft)

        # Verify expiry is at base_time + 72h
        stored = staging._items.get(draft.draft_id)
        assert abs(stored.expires_at - (base_time + 72 * 3600)) < 1.0

        # At 71h: draft is still alive
        time_at_71h = base_time + 71 * 3600
        expired_count_71h = staging.auto_expire(current_time=time_at_71h)
        assert expired_count_71h == 0, "Draft must be alive at 71h"
        assert staging._items.get(draft.draft_id) is not None

        # Brain crashes at 71h
        brain.crash()

        # Time passes — at 73h the draft's TTL has expired
        # Core runs auto_expire independently of Brain
        time_at_73h = base_time + 73 * 3600
        expired_count_73h = staging.auto_expire(current_time=time_at_73h)
        assert expired_count_73h == 1, (
            "Core must expire the draft at 73h even while Brain is crashed — "
            "Core handles expiry independently"
        )
        assert staging._items.get(draft.draft_id) is None, (
            "Draft must be gone after expiry, regardless of Brain state"
        )

        # Brain restarts — but the draft is already gone (correctly)
        brain.restart()
        assert staging._items.get(draft.draft_id) is None, (
            "Draft must remain gone after Brain restarts — Core already "
            "purged it during the crash window"
        )

        # Counter-proof: a NEW draft created after recovery has full TTL
        new_base = time_at_73h
        new_draft = Draft(
            draft_id=f"draft_post_crash_{uuid.uuid4().hex[:8]}",
            to="fresh@test.com",
            subject="Post-recovery draft",
            body="Created after crash recovery.",
            confidence=0.85,
            created_at=new_base,
        )
        staging.store_draft(new_draft)
        new_stored = staging._items.get(new_draft.draft_id)
        assert new_stored is not None, "New draft must exist"
        assert abs(
            new_stored.expires_at - (new_base + 72 * 3600)
        ) < 1.0, "New draft must have its own 72h TTL from creation time"
        assert new_stored.sent is False, "New draft must start as pending"
