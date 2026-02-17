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
    MockReputationGraph,
    MockTrustEvaluator,
    OutcomeReport,
    TrustRing,
)


# ---------------------------------------------------------------------------
# TestRing1Unverified
# ---------------------------------------------------------------------------

class TestRing1Unverified:
    """Ring 1: anonymous / unverified entities. Lowest trust."""

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

        # Even if the human has a default-approve policy, this should
        # be flagged for explicit approval (the test proves the system
        # asks, it does not silently auto-approve).
        mock_human.set_approval("transfer_money", False)
        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is False

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

    def test_unverified_attestation_has_low_impact(
        self, mock_reputation_graph: MockReputationGraph
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
        mock_reputation_graph.add_attestation(attestation)

        # The attestation is recorded but the expert's trust score is 0
        assert mock_reputation_graph.get_trust_score(
            attestation.expert_did
        ) == 0.0


# ---------------------------------------------------------------------------
# TestRing2Verified
# ---------------------------------------------------------------------------

class TestRing2Verified:
    """Ring 2: ZKP-verified unique person. No identity revealed."""

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

    def test_peer_attestation(
        self, mock_trust_evaluator: MockTrustEvaluator
    ) -> None:
        """Peer attestations (vouching) increase trust."""
        no_peers = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=20000.0,
            outcome_count=10,
            peer_attestations=0,
            credential_count=0,
        )
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

    def test_trust_degrades_with_bad_behavior(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Bad outcomes reduce a bot's reputation score over time."""
        bot_did = "did:plc:BadBot12345678901234567890ab"

        # Start with a decent score
        mock_reputation_graph.update_bot_score(bot_did, 40.0)
        initial = mock_reputation_graph.get_bot_score(bot_did)
        assert initial == 90.0  # default 50 + 40

        # Series of bad outcomes tank the score
        for _ in range(5):
            mock_reputation_graph.update_bot_score(bot_did, -15.0)

        degraded = mock_reputation_graph.get_bot_score(bot_did)
        assert degraded < initial
        assert degraded == 15.0  # 90 - 75

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

    def test_trust_score_floor_at_zero(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Bot reputation cannot go below 0.0."""
        bot_did = "did:plc:Floor1234567890123456789012ab"

        # Massive negative adjustments
        for _ in range(20):
            mock_reputation_graph.update_bot_score(bot_did, -50.0)

        score = mock_reputation_graph.get_bot_score(bot_did)
        assert score == 0.0

    def test_outcome_reports_from_different_rings(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Outcome reports are recorded regardless of reporter ring,
        but the ring is preserved for downstream weighting.
        """
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
            mock_reputation_graph.add_outcome(outcome)

        assert len(mock_reputation_graph.outcomes) == 3
        rings_recorded = {o.reporter_trust_ring for o in
                          mock_reputation_graph.outcomes}
        assert rings_recorded == {
            TrustRing.RING_1_UNVERIFIED,
            TrustRing.RING_2_VERIFIED,
            TrustRing.RING_3_SKIN_IN_GAME,
        }

    def test_signed_tombstone_only_by_author(
        self, mock_reputation_graph: MockReputationGraph,
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
        mock_reputation_graph.add_attestation(attestation)
        assert len(mock_reputation_graph.attestations) == 1

        # Non-author cannot delete
        sig = mock_identity.sign(b"aeron_2025")
        result = mock_reputation_graph.signed_tombstone(
            target_id="aeron_2025", author_did=other_did, signature=sig,
        )
        assert result is False
        assert len(mock_reputation_graph.attestations) == 1

        # Author CAN delete
        result = mock_reputation_graph.signed_tombstone(
            target_id="aeron_2025", author_did=author_did, signature=sig,
        )
        assert result is True
        assert len(mock_reputation_graph.attestations) == 0
        assert len(mock_reputation_graph.tombstones) == 1
        assert mock_reputation_graph.tombstones[0]["author"] == author_did
