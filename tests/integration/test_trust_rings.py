"""Integration tests for trust rings and composite trust function.

Trust is a function of identity verification level (ring), time alive,
transaction history, peer attestations, and credentials. These tests
validate the behavioral contracts that govern how Dina evaluates and
interacts with entities at different trust levels.
"""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    ActionRisk,
    AgentIntent,
    ExpertAttestation,
    MockDinaCore,
    MockHuman,
    MockIdentity,
    MockTrustNetwork,
    MockTrustEvaluator,
    OutcomeReport,
    TrustRing,
)

# Task 8.21 migration prep. Trust rings (Ring 1 unverified → Ring 3+
# verified-actioned) + composite trust function live in Lite's trust-
# scorer subsystem, which lands with M3 (tasks 8.20-8.26 scope).
# Entire file exercises the ring model; file-level pytestmark is the
# right granularity. LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="Trust rings + composite trust function are M3 scope "
    "(tasks 8.20-8.26). Lite trust-scorer lands with Phase 5+. "
    "LITE_SKIPS.md category `pending-feature`."
)


# ---------------------------------------------------------------------------
# TestRing1Unverified
# ---------------------------------------------------------------------------

class TestRing1Unverified:
    """Ring 1: anonymous / unverified entities. Lowest trust."""

# TST-INT-313
    # TRACE: {"suite": "INT", "case": "0313", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "01", "title": "created_without_id"}
    def test_created_without_id(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """An unverified entity starts with minimal trust baseline."""
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_1_UNVERIFIED,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        # Ring 1 base is 5.0 with zero history
        assert score == 5.0

# TST-INT-570
    # TRACE: {"suite": "INT", "case": "0570", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "02", "title": "limited_transactions"}
    def test_limited_transactions(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Unverified entities face strict transaction limits.

        High-risk actions (financial transfers) are blocked or require
        explicit human approval.
        """
        intent = AgentIntent(
            agent_did="did:plc:Anonymous123456789012345678",
            action="transfer_money",
            target="unknown_wallet",
            context={"amount": 50000, "currency": "INR"},
        )

        risk = mock_dina.classify_action_risk(intent)
        assert risk == ActionRisk.HIGH

        # Human explicitly rejects the transfer
        mock_human.set_approval("transfer_money", False)
        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is False

        # Counter-proof: if human explicitly approves, it goes through
        mock_human.set_approval("transfer_money", True)
        approved_now = mock_dina.approve_intent(intent, mock_human)
        assert approved_now is True, \
            "Explicit human approval must override for HIGH risk"

        # Counter-proof: a SAFE action (read/search) does not need approval
        safe_intent = AgentIntent(
            agent_did="did:plc:Anonymous123456789012345678",
            action="search",
            target="product_catalog",
        )
        safe_risk = mock_dina.classify_action_risk(safe_intent)
        assert safe_risk == ActionRisk.SAFE
        # SAFE actions pass without human involvement
        safe_approved = mock_dina.approve_intent(safe_intent, mock_human)
        assert safe_approved is True

# TST-INT-571
    # TRACE: {"suite": "INT", "case": "0571", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "03", "title": "low_trust_weight"}
    def test_low_trust_weight(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Even with moderate activity, an unverified entity stays low."""
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_1_UNVERIFIED,
            time_alive_days=180,
            transaction_count=20,
            transaction_volume=5000.0,
            outcome_count=5,
            peer_attestations=1,
            credential_count=0,
        )
        # Should be noticeably below a Ring 2 baseline (30.0)
        assert score < 30.0
        # But above the bare minimum
        assert score > 5.0

# TST-INT-572
    # TRACE: {"suite": "INT", "case": "0572", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "04", "title": "polite_but_cautious"}
    def test_polite_but_cautious(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Dina interacts politely with Ring 1 entities but restricts
        information sharing. Read-only actions are still SAFE.
        """
        # A simple read/search is safe regardless of trust ring
        read_intent = AgentIntent(
            agent_did="did:plc:Anonymous123456789012345678",
            action="search",
            target="product_catalog",
        )
        assert mock_dina.classify_action_risk(read_intent) == ActionRisk.SAFE

        approved = mock_dina.approve_intent(read_intent, mock_human)
        assert approved is True

        # But data sharing is HIGH risk
        share_intent = AgentIntent(
            agent_did="did:plc:Anonymous123456789012345678",
            action="share_data",
            target="external_party",
        )
        assert mock_dina.classify_action_risk(share_intent) == ActionRisk.HIGH

# TST-INT-573
    # TRACE: {"suite": "INT", "case": "0573", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "05", "title": "unverified_attestation_has_low_impact"}
    def test_unverified_attestation_has_low_impact(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Reviews from unverified entities carry minimal weight."""
        attestation = ExpertAttestation(
            expert_did="did:plc:Anon123456789012345678901234",
            expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
            product_category="laptops",
            product_id="generic_laptop_001",
            rating=95,
            verdict={"summary": "Best laptop ever!"},
            source_url="https://example.com/review",
        )
        mock_trust_network.add_attestation(attestation)

        # The attestation is recorded but the expert's trust score is 0
        assert mock_trust_network.get_trust_score(
            attestation.expert_did
        ) == 0.0


# ---------------------------------------------------------------------------
# TestRing2Verified
# ---------------------------------------------------------------------------

class TestRing2Verified:
    """Ring 2: ZKP-verified unique person. No identity revealed."""

# TST-INT-574
    # TRACE: {"suite": "INT", "case": "0574", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "01", "title": "zkp_proves_unique_person"}
    def test_zkp_proves_unique_person(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """ZKP verification alone lifts the trust baseline significantly."""
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_2_VERIFIED,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        # Ring 2 base is 30.0 — 6x higher than Ring 1
        assert score == 30.0

# TST-INT-575
    # TRACE: {"suite": "INT", "case": "0575", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "02", "title": "higher_trust_than_ring_1"}
    def test_higher_trust_than_ring_1(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """At equivalent activity levels, Ring 2 always scores higher."""
        activity = dict(
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=25000.0,
            outcome_count=10,
            peer_attestations=3,
            credential_count=1,
        )
        ring1_score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_1_UNVERIFIED, **activity,
        )
        ring2_score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_2_VERIFIED, **activity,
        )
        assert ring2_score > ring1_score
        assert ring2_score - ring1_score >= 25.0  # base diff is 25

# TST-INT-315
    # TRACE: {"suite": "INT", "case": "0315", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "03", "title": "no_identity_revealed"}
    def test_no_identity_revealed(
        self, mock_identity: MockIdentity
    ) -> None:
        """ZKP verification proves uniqueness without revealing the
        actual DID or personal information. We verify this by checking
        that signing produces a valid signature without exposing the key.
        """
        data = b"I am a unique person"
        signature = mock_identity.sign(data)

        # Signature is a hex string (not the key itself)
        assert signature != mock_identity.root_private_key
        assert len(signature) == 64  # SHA-256 hex

        # Verification works without revealing the private key
        assert mock_identity.verify(data, signature) is True
        assert mock_identity.verify(b"tampered", signature) is False

# TST-INT-576
    # TRACE: {"suite": "INT", "case": "0576", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "04", "title": "larger_transactions_allowed"}
    def test_larger_transactions_allowed(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Ring 2 entities can engage in moderate-risk actions with
        user approval (not auto-blocked).
        """
        intent = AgentIntent(
            agent_did="did:plc:Verified1234567890123456789",
            action="send_email",
            target="colleague@example.com",
            context={"trust_ring": TrustRing.RING_2_VERIFIED},
        )

        risk = mock_dina.classify_action_risk(intent)
        assert risk == ActionRisk.MODERATE

        # User approves moderate actions from verified entities
        mock_human.set_approval("send_email", True)
        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is True


# ---------------------------------------------------------------------------
# TestRing3AndBeyond
# ---------------------------------------------------------------------------

class TestRing3AndBeyond:
    """Ring 3: skin in the game — LinkedIn, business registration,
    transaction history, peer attestation, time factor.
    """

# TST-INT-577
    # TRACE: {"suite": "INT", "case": "0577", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "01", "title": "linkedin_anchor"}
    def test_linkedin_anchor(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """A LinkedIn credential adds to the trust score."""
        without_cred = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=100,
            transaction_volume=50000.0,
            outcome_count=20,
            peer_attestations=5,
            credential_count=0,
        )
        with_cred = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=100,
            transaction_volume=50000.0,
            outcome_count=20,
            peer_attestations=5,
            credential_count=1,  # LinkedIn
        )
        assert with_cred > without_cred

# TST-INT-578
    # TRACE: {"suite": "INT", "case": "0578", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "02", "title": "business_registration"}
    def test_business_registration(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Multiple credentials (LinkedIn + business registration) stack."""
        one_cred = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=30000.0,
            outcome_count=10,
            peer_attestations=3,
            credential_count=1,
        )
        two_creds = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=30000.0,
            outcome_count=10,
            peer_attestations=3,
            credential_count=2,
        )
        assert two_creds > one_cred

# TST-INT-579
    # TRACE: {"suite": "INT", "case": "0579", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "03", "title": "transaction_history"}
    def test_transaction_history(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """More transactions (count + volume) increase trust."""
        low_tx = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=5,
            transaction_volume=1000.0,
            outcome_count=1,
            peer_attestations=0,
            credential_count=0,
        )
        high_tx = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=200,
            transaction_volume=100000.0,
            outcome_count=1,
            peer_attestations=0,
            credential_count=0,
        )
        assert high_tx > low_tx

# TST-INT-312
    # TRACE: {"suite": "INT", "case": "0312", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "04", "title": "peer_attestation"}
    def test_peer_attestation(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Peer attestations (vouching) increase trust."""
        # Pre-condition: scores start at 0 before any computation
        no_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=0,
            credential_count=0,
        )
        assert no_peers > 0, "Non-zero inputs must produce a positive score"

        with_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=5,
            credential_count=0,
        )
        assert with_peers > no_peers

        # More peers → even higher trust (monotonic increase)
        with_many_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=20,
            credential_count=0,
        )
        assert with_many_peers > with_peers, (
            "Peer attestation effect must be monotonically increasing"
        )

        # Counter-proof: zero peers on a lower ring still gets lower score
        # than zero peers on Ring 3 (ring baseline matters)
        ring2_no_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_2_VERIFIED,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=0,
            credential_count=0,
        )
        assert ring2_no_peers < no_peers, (
            "Ring 2 baseline must be lower than Ring 3 baseline"
        )

# TST-INT-580
    # TRACE: {"suite": "INT", "case": "0580", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "05", "title": "time_factor"}
    def test_time_factor(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Older accounts with clean history earn more trust."""
        new_account = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=7,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=3,
            credential_count=1,
        )
        old_account = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=730,  # 2 years
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=3,
            credential_count=1,
        )
        assert old_account > new_account

# TST-INT-581
    # TRACE: {"suite": "INT", "case": "0581", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "06", "title": "ring3_base_higher_than_ring2"}
    def test_ring3_base_higher_than_ring2(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Ring 3 baseline (50.0) exceeds Ring 2 baseline (30.0)."""
        ring2 = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_2_VERIFIED,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        ring3 = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        assert ring3 == 50.0
        assert ring3 > ring2


# ---------------------------------------------------------------------------
# TestTrustComposite
# ---------------------------------------------------------------------------

class TestTrustComposite:
    """The composite trust function combines all factors."""

# TST-INT-582
    # TRACE: {"suite": "INT", "case": "0582", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "01", "title": "composite_calculation"}
    def test_composite_calculation(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """A fully-loaded Ring 3 entity approaches maximum trust."""
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=1095,          # 3 years
            transaction_count=500,
            transaction_volume=200000.0,
            outcome_count=100,
            peer_attestations=10,
            credential_count=5,
        )
        # Each factor is capped; total capped at 100.0
        assert score == 100.0

# TST-INT-583
    # TRACE: {"suite": "INT", "case": "0583", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "02", "title": "all_factors_contribute"}
    def test_all_factors_contribute(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Adding each factor individually raises the composite score."""
        base = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        assert base == 50.0  # Ring 3 base

        # Add time
        with_time = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        assert with_time > base

        # Add transactions
        with_tx = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=100,
            transaction_volume=50000.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        assert with_tx > base

        # Add outcomes
        with_outcomes = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=50,
            peer_attestations=0,
            credential_count=0,
        )
        assert with_outcomes > base

        # Add peer attestations
        with_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=5,
            credential_count=0,
        )
        assert with_peers > base

        # Add credentials
        with_creds = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=0,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=3,
        )
        assert with_creds > base

# TST-INT-584
    # TRACE: {"suite": "INT", "case": "0584", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "03", "title": "rug_pull_assessment"}
    def test_rug_pull_assessment(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """A seller with zero history (potential rug pull) gets low trust,
        even at Ring 3, because the non-ring factors are all empty.
        """
        rug_pull_risk = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=1,      # brand new
            transaction_count=0,    # no history
            transaction_volume=0.0,
            outcome_count=0,        # no outcomes
            peer_attestations=0,    # nobody vouches
            credential_count=0,     # no credentials
        )

        established_seller = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=730,
            transaction_count=500,
            transaction_volume=200000.0,
            outcome_count=100,
            peer_attestations=8,
            credential_count=2,
        )

        # The rug-pull-risk entity is barely above base
        assert rug_pull_risk < 55.0
        # The established seller is far ahead
        assert established_seller > 90.0
        # The gap should be significant
        assert established_seller - rug_pull_risk > 40.0

# TST-INT-314
    # TRACE: {"suite": "INT", "case": "0314", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "04", "title": "trust_degrades_with_bad_behavior"}
    def test_trust_degrades_with_bad_behavior(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Bad outcomes reduce a bot's trust score over time."""
        bot_did = "did:plc:BadBot12345678901234567890ab"

        # Pre-condition: unknown bot starts at default 50.0
        assert mock_trust_network.get_bot_score(bot_did) == 50.0

        # Start with a decent score
        mock_trust_network.update_bot_score(bot_did, 40.0)
        initial = mock_trust_network.get_bot_score(bot_did)
        assert initial == 90.0  # default 50 + 40

        # Series of bad outcomes tank the score
        for _ in range(5):
            mock_trust_network.update_bot_score(bot_did, -15.0)

        degraded = mock_trust_network.get_bot_score(bot_did)
        assert degraded < initial
        assert degraded == 15.0  # 90 - 75

        # Counter-proof: floor clamping — score cannot go below 0.0
        for _ in range(10):
            mock_trust_network.update_bot_score(bot_did, -50.0)
        floored = mock_trust_network.get_bot_score(bot_did)
        assert floored == 0.0

        # Counter-proof: a different bot is unaffected
        other_did = "did:plc:GoodBot1234567890123456789ab"
        assert mock_trust_network.get_bot_score(other_did) == 50.0

# TST-INT-585
    # TRACE: {"suite": "INT", "case": "0585", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "05", "title": "trust_score_capped_at_100"}
    def test_trust_score_capped_at_100(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Composite trust never exceeds 100.0."""
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=10000,
            transaction_count=10000,
            transaction_volume=999999.0,
            outcome_count=10000,
            peer_attestations=100,
            credential_count=100,
        )
        assert score == 100.0

# TST-INT-311
    # TRACE: {"suite": "INT", "case": "0311", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "06", "title": "trust_score_floor_at_zero"}
    def test_trust_score_floor_at_zero(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Bot trust cannot go below 0.0."""
        bot_did = "did:plc:Floor1234567890123456789012ab"

        # Massive negative adjustments
        for _ in range(20):
            mock_trust_network.update_bot_score(bot_did, -50.0)

        score = mock_trust_network.get_bot_score(bot_did)
        assert score == 0.0

# TST-INT-586
    # TRACE: {"suite": "INT", "case": "0586", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "07", "title": "outcome_reports_from_different_rings"}
    def test_outcome_reports_from_different_rings(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Outcome reports are recorded regardless of reporter ring,
        but the ring is preserved for downstream weighting.
        """
        # Pre-condition: no outcomes exist yet
        assert len(mock_trust_network.outcomes) == 0

        for ring in TrustRing:
            outcome = OutcomeReport(
                reporter_trust_ring=ring,
                reporter_age_days=365,
                product_category="laptops",
                product_id="thinkpad_x1_2025",
                purchase_verified=True,
                time_since_purchase_days=90,
                outcome="still_using",
                satisfaction="positive",
            )
            mock_trust_network.add_outcome(outcome)

        assert len(mock_trust_network.outcomes) == 3
        rings_recorded = {o.reporter_trust_ring for o in
                          mock_trust_network.outcomes}
        assert rings_recorded == {
            TrustRing.RING_1_UNVERIFIED,
            TrustRing.RING_2_VERIFIED,
            TrustRing.RING_3_SKIN_IN_GAME,
        }

        # Verify individual outcome fields are preserved (not just the ring)
        for outcome in mock_trust_network.outcomes:
            assert outcome.product_id == "thinkpad_x1_2025"
            assert outcome.purchase_verified is True
            assert outcome.satisfaction == "positive"
            assert outcome.reporter_age_days == 365

        # Counter-proof: a negative outcome is also recorded faithfully
        negative = OutcomeReport(
            reporter_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            reporter_age_days=30,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            purchase_verified=True,
            time_since_purchase_days=10,
            outcome="returned",
            satisfaction="negative",
        )
        mock_trust_network.add_outcome(negative)
        assert len(mock_trust_network.outcomes) == 4
        neg_outcomes = [o for o in mock_trust_network.outcomes
                        if o.satisfaction == "negative"]
        assert len(neg_outcomes) == 1
        assert neg_outcomes[0].outcome == "returned"

# TST-INT-587
    # TRACE: {"suite": "INT", "case": "0587", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "08", "title": "signed_tombstone_only_by_author"}
    def test_signed_tombstone_only_by_author(
        self, mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """Only the original author can delete their attestation via
        signed tombstone. Others cannot delete it.
        """
        author_did = mock_identity.root_did
        other_did = "did:plc:Other1234567890123456789012ab"

        attestation = ExpertAttestation(
            expert_did=author_did,
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="chairs",
            product_id="aeron_2025",
            rating=91,
            verdict={"summary": "Excellent lumbar support"},
            source_url="https://example.com/review",
        )
        mock_trust_network.add_attestation(attestation)
        assert len(mock_trust_network.attestations) == 1

        # Non-author cannot delete
        sig = mock_identity.sign(b"aeron_2025")
        result = mock_trust_network.signed_tombstone(
            target_id="aeron_2025", author_did=other_did, signature=sig,
        )
        assert result is False
        assert len(mock_trust_network.attestations) == 1

        # Author CAN delete
        result = mock_trust_network.signed_tombstone(
            target_id="aeron_2025", author_did=author_did, signature=sig,
        )
        assert result is True
        assert len(mock_trust_network.attestations) == 0
        assert len(mock_trust_network.tombstones) == 1
        assert mock_trust_network.tombstones[0]["author"] == author_did
