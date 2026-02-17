"""Integration tests for the Reputation Graph.

Tests expert attestations (signed reviews from verified creators),
outcome data (anonymized purchase outcomes), and bot reputation
(tracking, degradation, auto-routing).
"""

from __future__ import annotations

import hashlib
import json
import uuid

import pytest

from tests.integration.mocks import (
    ExpertAttestation,
    MockDinaCore,
    MockHuman,
    MockIdentity,
    MockReputationGraph,
    MockReviewBot,
    MockTrustEvaluator,
    OutcomeReport,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Expert Attestations
# ---------------------------------------------------------------------------


class TestExpertAttestations:
    """YouTube reviews and expert verdicts become signed attestations."""

    def test_review_becomes_attestation(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_identity: MockIdentity,
    ) -> None:
        """A YouTube product review is transformed into a signed attestation
        in the reputation graph."""
        attestation = ExpertAttestation(
            expert_did="did:dht:z6MkMKBHD12345678901234567890123456",
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            rating=92,
            verdict={
                "summary": "Excellent build quality, best keyboard in class",
                "pros": ["keyboard", "display", "portability"],
                "cons": ["expensive", "limited GPU"],
            },
            source_url="https://youtube.com/watch?v=abc123",
            deep_link="https://youtube.com/watch?v=abc123&t=260",
            deep_link_context="Battery stress test at 4:20",
            creator_name="MKBHD",
        )
        mock_reputation_graph.add_attestation(attestation)

        assert len(mock_reputation_graph.attestations) == 1
        stored = mock_reputation_graph.attestations[0]
        assert stored.product_id == "thinkpad_x1_2025"
        assert stored.rating == 92
        assert stored.source_url == "https://youtube.com/watch?v=abc123"
        assert stored.creator_name == "MKBHD"
        assert "keyboard" in stored.verdict["pros"]

    def test_attestation_is_signed(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_identity: MockIdentity,
    ) -> None:
        """Every attestation carries a cryptographic signature from the expert's DID."""
        expert_did = "did:dht:z6MkExpert12345678901234567890123456"
        verdict_data = {
            "product_id": "thinkpad_x1_2025",
            "rating": 92,
            "summary": "Excellent laptop",
        }
        canonical = json.dumps(verdict_data, sort_keys=True).encode()
        signature = hashlib.sha256(
            f"expert_private_key{canonical.decode()}".encode()
        ).hexdigest()

        attestation = ExpertAttestation(
            expert_did=expert_did,
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            rating=92,
            verdict=verdict_data,
            source_url="https://youtube.com/watch?v=expert_review",
            signature=signature,
        )
        mock_reputation_graph.add_attestation(attestation)

        stored = mock_reputation_graph.attestations[0]
        assert stored.signature != ""
        assert len(stored.signature) == 64  # SHA-256 hex digest
        # Verify signature matches expected
        assert stored.signature == signature

    def test_multiple_experts_same_product(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Multiple experts can attest to the same product. All attestations
        are preserved for aggregation."""
        experts = [
            ("did:dht:z6MkMKBHD", "MKBHD", 92),
            ("did:dht:z6MkDaveL", "Dave2D", 88),
            ("did:dht:z6MkLinus", "LTT", 85),
        ]
        for did, name, rating in experts:
            att = ExpertAttestation(
                expert_did=did,
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_2025",
                rating=rating,
                verdict={"summary": f"{name}'s review"},
                source_url=f"https://youtube.com/watch?v={name.lower()}_review",
                creator_name=name,
            )
            mock_reputation_graph.add_attestation(att)

        assert len(mock_reputation_graph.attestations) == 3

        # All three are for the same product
        product_attestations = [
            a for a in mock_reputation_graph.attestations
            if a.product_id == "thinkpad_x1_2025"
        ]
        assert len(product_attestations) == 3

        # Each from a different expert
        expert_dids = {a.expert_did for a in product_attestations}
        assert len(expert_dids) == 3

        # Average rating
        avg_rating = sum(a.rating for a in product_attestations) / len(product_attestations)
        assert 85 <= avg_rating <= 92


# ---------------------------------------------------------------------------
# Outcome Data
# ---------------------------------------------------------------------------


class TestOutcomeData:
    """Anonymized purchase outcomes — the pull-economy feedback loop."""

    def test_purchase_outcome_tracked(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """After a purchase, the user can record an outcome (still_using, returned, etc.)."""
        outcome = OutcomeReport(
            reporter_trust_ring=TrustRing.RING_2_VERIFIED,
            reporter_age_days=365,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            purchase_verified=True,
            time_since_purchase_days=90,
            outcome="still_using",
            satisfaction="positive",
            issues=[],
        )
        mock_reputation_graph.add_outcome(outcome)

        assert len(mock_reputation_graph.outcomes) == 1
        stored = mock_reputation_graph.outcomes[0]
        assert stored.outcome == "still_using"
        assert stored.satisfaction == "positive"
        assert stored.purchase_verified is True

    def test_outcome_anonymized(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Outcome reports do not contain PII — only trust ring and age bucket."""
        outcome = OutcomeReport(
            reporter_trust_ring=TrustRing.RING_2_VERIFIED,
            reporter_age_days=400,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            purchase_verified=True,
            time_since_purchase_days=120,
            outcome="still_using",
            satisfaction="positive",
        )
        mock_reputation_graph.add_outcome(outcome)

        stored = mock_reputation_graph.outcomes[0]
        # OutcomeReport has no name, email, DID, or address fields
        assert not hasattr(stored, "reporter_name")
        assert not hasattr(stored, "reporter_email")
        assert not hasattr(stored, "reporter_did")
        assert not hasattr(stored, "reporter_address")
        # Only anonymized identifiers
        assert stored.reporter_trust_ring == TrustRing.RING_2_VERIFIED
        assert stored.reporter_age_days == 400

    def test_gentle_outcome_query(
        self,
        mock_dina: MockDinaCore,
        mock_human: MockHuman,
    ) -> None:
        """Dina gently asks the user for outcome data — never nags.
        The query is classified as Tier 3 (save for briefing)."""
        tier = mock_dina.classifier.classify(
            "outcome_query",
            "How is the ThinkPad X1 working out after 3 months?",
        )
        # Outcome queries are engagement-level — not urgent
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

    def test_high_participation_rate_from_verified_users(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Verified users (Ring 2+) contribute more outcomes, making the data reliable."""
        # Simulate 20 outcomes from verified users, 5 from unverified
        for i in range(20):
            mock_reputation_graph.add_outcome(OutcomeReport(
                reporter_trust_ring=TrustRing.RING_2_VERIFIED,
                reporter_age_days=200 + i * 10,
                product_category="laptops",
                product_id="thinkpad_x1_2025",
                purchase_verified=True,
                time_since_purchase_days=30 + i * 5,
                outcome="still_using",
                satisfaction="positive",
            ))
        for i in range(5):
            mock_reputation_graph.add_outcome(OutcomeReport(
                reporter_trust_ring=TrustRing.RING_1_UNVERIFIED,
                reporter_age_days=10 + i,
                product_category="laptops",
                product_id="thinkpad_x1_2025",
                purchase_verified=False,
                time_since_purchase_days=10,
                outcome="returned",
                satisfaction="negative",
            ))

        total = len(mock_reputation_graph.outcomes)
        verified = [
            o for o in mock_reputation_graph.outcomes
            if o.reporter_trust_ring != TrustRing.RING_1_UNVERIFIED
        ]
        assert total == 25
        assert len(verified) == 20
        # 80% participation from verified users
        assert len(verified) / total >= 0.8

    def test_factual_not_opinion(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Outcome data records facts (still_using, returned, broken) not opinions.
        The satisfaction field is the only subjective element."""
        outcome = OutcomeReport(
            reporter_trust_ring=TrustRing.RING_2_VERIFIED,
            reporter_age_days=500,
            product_category="office_chairs",
            product_id="aeron_2025",
            purchase_verified=True,
            time_since_purchase_days=180,
            outcome="still_using",
            satisfaction="positive",
            issues=["armrest_wobble"],
        )
        mock_reputation_graph.add_outcome(outcome)

        stored = mock_reputation_graph.outcomes[0]
        # Factual fields
        assert stored.outcome in ("still_using", "returned", "broken",
                                  "gifted", "replaced")
        assert stored.purchase_verified is True
        assert stored.time_since_purchase_days == 180
        # Issues are factual observations
        assert "armrest_wobble" in stored.issues


# ---------------------------------------------------------------------------
# Bot Reputation
# ---------------------------------------------------------------------------


class TestBotReputation:
    """Review bots and task agents have tracked, visible reputation scores."""

    def test_reputation_tracked(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Every bot has a reputation score tracked in the graph."""
        mock_reputation_graph.update_bot_score(mock_review_bot.bot_did, 0)
        score = mock_reputation_graph.get_bot_score(mock_review_bot.bot_did)
        # Default is 50.0, delta 0 keeps it at 50.0
        assert score == 50.0

        # Record good performance
        mock_reputation_graph.update_bot_score(mock_review_bot.bot_did, 10)
        score = mock_reputation_graph.get_bot_score(mock_review_bot.bot_did)
        assert score == 60.0

    def test_compromised_bot_drops_score(
        self,
        mock_reputation_graph: MockReputationGraph,
    ) -> None:
        """If a bot is found compromised or gives bad recommendations,
        its reputation score drops sharply."""
        bot_did = "did:dht:z6MkCompromisedBot000000000000000000"
        mock_reputation_graph.update_bot_score(bot_did, 30)  # Start at 80
        initial = mock_reputation_graph.get_bot_score(bot_did)
        assert initial == 80.0

        # Compromise detected — heavy penalty
        mock_reputation_graph.update_bot_score(bot_did, -50)
        after_penalty = mock_reputation_graph.get_bot_score(bot_did)
        assert after_penalty == 30.0
        assert after_penalty < initial

        # Further penalties cannot go below 0
        mock_reputation_graph.update_bot_score(bot_did, -100)
        floor = mock_reputation_graph.get_bot_score(bot_did)
        assert floor == 0.0

    def test_auto_routes_to_better_bot(
        self,
        mock_reputation_graph: MockReputationGraph,
    ) -> None:
        """Dina auto-routes queries to the highest-reputation bot for a category."""
        bots = {
            "did:dht:z6MkBotA": ("BotA", 45.0),
            "did:dht:z6MkBotB": ("BotB", 88.0),
            "did:dht:z6MkBotC": ("BotC", 72.0),
        }
        for bot_did, (_name, delta) in bots.items():
            # Start from 0: update_bot_score starts from default 50, so
            # we set score = 50 + delta_from_50
            mock_reputation_graph.bot_scores[bot_did] = delta

        # Find the best bot
        best_bot_did = max(
            mock_reputation_graph.bot_scores,
            key=lambda did: mock_reputation_graph.get_bot_score(did),
        )
        assert best_bot_did == "did:dht:z6MkBotB"
        assert mock_reputation_graph.get_bot_score(best_bot_did) == 88.0

        # If BotB's reputation drops below BotC, routing switches
        mock_reputation_graph.update_bot_score("did:dht:z6MkBotB", -20)
        new_best = max(
            mock_reputation_graph.bot_scores,
            key=lambda did: mock_reputation_graph.get_bot_score(did),
        )
        assert new_best == "did:dht:z6MkBotC"

    def test_reputation_visible_to_user(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot reputation scores are visible to the user — full transparency."""
        mock_reputation_graph.bot_scores[mock_review_bot.bot_did] = 94.0

        score = mock_reputation_graph.get_bot_score(mock_review_bot.bot_did)
        assert score == 94.0

        # User can see all bot scores
        assert mock_review_bot.bot_did in mock_reputation_graph.bot_scores
        # Score is a simple float, easy to display
        assert isinstance(score, float)
        assert 0.0 <= score <= 100.0

    def test_reputation_score_capped_at_100(
        self, mock_reputation_graph: MockReputationGraph
    ) -> None:
        """Reputation score cannot exceed 100.0."""
        bot_did = "did:dht:z6MkPerfectBot0000000000000000000000"
        mock_reputation_graph.update_bot_score(bot_did, 60)  # 50 + 60 = 110 -> capped at 100
        score = mock_reputation_graph.get_bot_score(bot_did)
        assert score == 100.0
