"""Integration tests for the Trust Network.

Tests expert attestations (signed reviews from verified creators),
outcome data (anonymized purchase outcomes), and bot trust
(tracking, degradation, auto-routing).
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid

import pytest

from tests.integration.mocks import (
    DIDDocument,
    ExpertAttestation,
    MockAppView,
    MockDinaCore,
    MockDockerCompose,
    MockHuman,
    MockIdentity,
    MockPLCResolver,
    MockRelay,
    MockTrustNetwork,
    MockReviewBot,
    MockTrustEvaluator,
    MockVerificationLayer,
    OutcomeReport,
    SilenceTier,
    TrustRing,
)

# Task 8.20 migration prep. File-level skip_in_lite — Trust Network is
# the M3 gate's defining capability (tasks 8.20-8.26 scope). Expert
# attestations, outcome data, bot trust, AT Protocol PDS integration
# on the trust-data side, and trust-data-density all depend on Lite's
# AppView + trust scorer subsystem, which lands with M3 features.
# LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="Trust Network (expert attestations, outcome data, bot trust, "
    "AT Protocol PDS publishing to trust-facing lexicons) is the M3 gate "
    "(tasks 8.20-8.26). Lite's trust-scorer subsystem lands with Phase 5+ "
    "+ AppView integration. LITE_SKIPS.md category `pending-feature`."
)


# ---------------------------------------------------------------------------
# Expert Attestations
# ---------------------------------------------------------------------------


class TestExpertAttestations:
    """YouTube reviews and expert verdicts become signed attestations."""

# TST-INT-297
    # TRACE: {"suite": "INT", "case": "0297", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "01", "title": "review_becomes_attestation"}
    def test_review_becomes_attestation(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """A YouTube product review is transformed into a signed attestation
        in the trust network."""
        attestation = ExpertAttestation(
            expert_did="did:plc:MKBHD12345678901234567890123456",
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
        mock_trust_network.add_attestation(attestation)

        assert len(mock_trust_network.attestations) == 1
        stored = mock_trust_network.attestations[0]
        assert stored.product_id == "thinkpad_x1_2025"
        assert stored.rating == 92
        assert stored.source_url == "https://youtube.com/watch?v=abc123"
        assert stored.creator_name == "MKBHD"
        assert "keyboard" in stored.verdict["pros"]

# TST-INT-299
    # TRACE: {"suite": "INT", "case": "0299", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "02", "title": "attestation_is_signed"}
    def test_attestation_is_signed(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """Every attestation carries a cryptographic signature from the expert's DID."""
        expert_did = "did:plc:Expert12345678901234567890123456"
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
        mock_trust_network.add_attestation(attestation)

        stored = mock_trust_network.attestations[0]
        assert stored.signature != ""
        assert len(stored.signature) == 64  # SHA-256 hex digest
        # Verify signature matches expected
        assert stored.signature == signature

# TST-INT-535
    # TRACE: {"suite": "INT", "case": "0535", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "03", "title": "multiple_experts_same_product"}
    def test_multiple_experts_same_product(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Multiple experts can attest to the same product. All attestations
        are preserved for aggregation."""
        experts = [
            ("did:plc:MKBHD", "MKBHD", 92),
            ("did:plc:DaveL", "Dave2D", 88),
            ("did:plc:Linus", "LTT", 85),
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
            mock_trust_network.add_attestation(att)

        assert len(mock_trust_network.attestations) == 3

        # All three are for the same product
        product_attestations = [
            a for a in mock_trust_network.attestations
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

# TST-INT-298
    # TRACE: {"suite": "INT", "case": "0298", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "01", "title": "purchase_outcome_tracked"}
    def test_purchase_outcome_tracked(
        self, mock_trust_network: MockTrustNetwork
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
        mock_trust_network.add_outcome(outcome)

        assert len(mock_trust_network.outcomes) == 1
        stored = mock_trust_network.outcomes[0]
        assert stored.outcome == "still_using"
        assert stored.satisfaction == "positive"
        assert stored.purchase_verified is True

# TST-INT-307
    # TRACE: {"suite": "INT", "case": "0307", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "02", "title": "outcome_anonymized"}
    def test_outcome_anonymized(
        self, mock_trust_network: MockTrustNetwork
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
        mock_trust_network.add_outcome(outcome)

        stored = mock_trust_network.outcomes[0]
        # OutcomeReport has no name, email, DID, or address fields
        assert not hasattr(stored, "reporter_name")
        assert not hasattr(stored, "reporter_email")
        assert not hasattr(stored, "reporter_did")
        assert not hasattr(stored, "reporter_address")
        # Only anonymized identifiers
        assert stored.reporter_trust_ring == TrustRing.RING_2_VERIFIED
        assert stored.reporter_age_days == 400

# TST-INT-312
    # TRACE: {"suite": "INT", "case": "0312", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "03", "title": "gentle_outcome_query"}
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

# TST-INT-309
    # TRACE: {"suite": "INT", "case": "0309", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "04", "title": "high_participation_rate_from_verified_users"}
    def test_high_participation_rate_from_verified_users(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Verified users (Ring 2+) contribute more outcomes, making the
        data reliable.  The trust evaluator gives verified reporters a
        higher composite score, so their outcomes carry more weight."""
        evaluator = MockTrustEvaluator()

        # A verified reporter with real usage history
        verified_score = evaluator.compute_composite(
            ring=TrustRing.RING_2_VERIFIED,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=25000.0,
            outcome_count=20,
            peer_attestations=3,
            credential_count=2,
        )

        # An unverified reporter with minimal history
        unverified_score = evaluator.compute_composite(
            ring=TrustRing.RING_1_UNVERIFIED,
            time_alive_days=10,
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=1,
            peer_attestations=0,
            credential_count=0,
        )

        # Verified reporters must score meaningfully higher — their
        # outcomes are more reliable for the trust network
        assert verified_score > unverified_score, (
            f"Verified reporter ({verified_score}) must outscore "
            f"unverified ({unverified_score})"
        )
        # Ring 2 base alone is 30 vs Ring 1 base of 5 — the gap must
        # be substantial, not a rounding artefact
        assert verified_score - unverified_score >= 20.0, (
            "Trust gap between verified and unverified must be >= 20 points"
        )

        # Counter-proof: a Ring 3 (skin-in-game) reporter scores even
        # higher than Ring 2, reflecting deeper commitment
        skin_score = evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=365,
            transaction_count=50,
            transaction_volume=25000.0,
            outcome_count=20,
            peer_attestations=3,
            credential_count=2,
        )
        assert skin_score > verified_score, (
            "Ring 3 reporter must score higher than Ring 2 with same history"
        )

        # Store outcomes and verify the network records them correctly
        mock_trust_network.add_outcome(OutcomeReport(
            reporter_trust_ring=TrustRing.RING_2_VERIFIED,
            reporter_age_days=365,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            purchase_verified=True,
            time_since_purchase_days=90,
            outcome="still_using",
            satisfaction="positive",
        ))
        mock_trust_network.add_outcome(OutcomeReport(
            reporter_trust_ring=TrustRing.RING_1_UNVERIFIED,
            reporter_age_days=10,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            purchase_verified=False,
            time_since_purchase_days=10,
            outcome="returned",
            satisfaction="negative",
        ))
        assert len(mock_trust_network.outcomes) == 2
        assert mock_trust_network.outcomes[0].reporter_trust_ring == TrustRing.RING_2_VERIFIED
        assert mock_trust_network.outcomes[1].reporter_trust_ring == TrustRing.RING_1_UNVERIFIED

# TST-INT-310
    # TRACE: {"suite": "INT", "case": "0310", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "05", "title": "factual_not_opinion"}
    def test_factual_not_opinion(
        self, mock_trust_network: MockTrustNetwork
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
        mock_trust_network.add_outcome(outcome)

        stored = mock_trust_network.outcomes[0]
        # Factual fields
        assert stored.outcome in ("still_using", "returned", "broken",
                                  "gifted", "replaced")
        assert stored.purchase_verified is True
        assert stored.time_since_purchase_days == 180
        # Issues are factual observations
        assert "armrest_wobble" in stored.issues


# ---------------------------------------------------------------------------
# Bot Trust
# ---------------------------------------------------------------------------


class TestBotTrust:
    """Review bots and task agents have tracked, visible trust scores."""

# TST-INT-314
    # TRACE: {"suite": "INT", "case": "0314", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "01", "title": "trust_tracked"}
    def test_trust_tracked(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Every bot has a trust score tracked in the graph."""
        mock_trust_network.update_bot_score(mock_review_bot.bot_did, 0)
        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        # Default is 50.0, delta 0 keeps it at 50.0
        assert score == 50.0

        # Record good performance
        mock_trust_network.update_bot_score(mock_review_bot.bot_did, 10)
        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        assert score == 60.0

# TST-INT-536
    # TRACE: {"suite": "INT", "case": "0536", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "02", "title": "compromised_bot_drops_score"}
    def test_compromised_bot_drops_score(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """If a bot is found compromised or gives bad recommendations,
        its trust score drops sharply."""
        bot_did = "did:plc:CompromisedBot000000000000000000"
        mock_trust_network.update_bot_score(bot_did, 30)  # Start at 80
        initial = mock_trust_network.get_bot_score(bot_did)
        assert initial == 80.0

        # Compromise detected — heavy penalty
        mock_trust_network.update_bot_score(bot_did, -50)
        after_penalty = mock_trust_network.get_bot_score(bot_did)
        assert after_penalty == 30.0
        assert after_penalty < initial

        # Further penalties cannot go below 0
        mock_trust_network.update_bot_score(bot_did, -100)
        floor = mock_trust_network.get_bot_score(bot_did)
        assert floor == 0.0

# TST-INT-537
    # TRACE: {"suite": "INT", "case": "0537", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "03", "title": "auto_routes_to_better_bot"}
    def test_auto_routes_to_better_bot(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """Dina auto-routes queries to the highest-trust bot for a category."""
        bots = {
            "did:plc:BotA": ("BotA", 45.0),
            "did:plc:BotB": ("BotB", 88.0),
            "did:plc:BotC": ("BotC", 72.0),
        }
        for bot_did, (_name, delta) in bots.items():
            # Start from 0: update_bot_score starts from default 50, so
            # we set score = 50 + delta_from_50
            mock_trust_network.bot_scores[bot_did] = delta

        # Find the best bot
        best_bot_did = max(
            mock_trust_network.bot_scores,
            key=lambda did: mock_trust_network.get_bot_score(did),
        )
        assert best_bot_did == "did:plc:BotB"
        assert mock_trust_network.get_bot_score(best_bot_did) == 88.0

        # If BotB's trust drops below BotC, routing switches
        mock_trust_network.update_bot_score("did:plc:BotB", -20)
        new_best = max(
            mock_trust_network.bot_scores,
            key=lambda did: mock_trust_network.get_bot_score(did),
        )
        assert new_best == "did:plc:BotC"

# TST-INT-311
    # TRACE: {"suite": "INT", "case": "0311", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "04", "title": "trust_visible_to_user"}
    def test_trust_visible_to_user(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot trust scores are visible to the user — full transparency."""
        # Pre-condition: unknown bot has default score
        default = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        assert default == 50.0

        # Set score via update (not direct dict assignment)
        mock_trust_network.update_bot_score(mock_review_bot.bot_did, 44.0)
        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        assert score == 94.0  # 50 + 44

        # User can see all bot scores
        assert mock_review_bot.bot_did in mock_trust_network.bot_scores
        # Score is a simple float, easy to display
        assert isinstance(score, float)
        assert 0.0 <= score <= 100.0

        # Counter-proof: different bot still at default
        other_did = "did:plc:OtherBot000000000000000000000000"
        assert mock_trust_network.get_bot_score(other_did) == 50.0

# TST-INT-304
    # TRACE: {"suite": "INT", "case": "0304", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "05", "title": "trust_score_capped_at_100"}
    def test_trust_score_capped_at_100(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Trust score cannot exceed 100.0."""
        bot_did = "did:plc:PerfectBot0000000000000000000000"
        mock_trust_network.update_bot_score(bot_did, 60)  # 50 + 60 = 110 -> capped at 100
        score = mock_trust_network.get_bot_score(bot_did)
        assert score == 100.0


# ---------------------------------------------------------------------------
# AT Protocol / PDS (Section 11)
# ---------------------------------------------------------------------------


class TestATProtocolPDS:
    """AT Protocol Personal Data Server integration — records, lexicons,
    federation, and discovery."""

# TST-INT-300
    # TRACE: {"suite": "INT", "case": "0300", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "01", "title": "pds_cannot_forge_records"}
    def test_pds_cannot_forge_records(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """Records are signed by the author's DID key. A PDS operator
        cannot modify a record without invalidating the signature."""
        # Pre-condition: no attestations exist yet
        assert len(mock_trust_network.attestations) == 0

        author_did = mock_identity.root_did
        verdict_data = {
            "product_id": "thinkpad_x1_2025",
            "rating": 92,
            "summary": "Excellent laptop",
        }
        canonical = json.dumps(verdict_data, sort_keys=True).encode()
        signature = mock_identity.sign(canonical)

        # Signature must be non-empty and not the raw private key
        assert signature != ""
        assert len(signature) == 64, "Ed25519 signature should be 64-char hex"

        attestation = ExpertAttestation(
            expert_did=author_did,
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            rating=92,
            verdict=verdict_data,
            source_url="https://youtube.com/watch?v=pds_forge_test",
            signature=signature,
        )
        mock_trust_network.add_attestation(attestation)

        assert len(mock_trust_network.attestations) == 1
        stored = mock_trust_network.attestations[0]
        assert stored.signature == signature
        assert stored.expert_did == author_did

        # Original signature verifies
        assert mock_identity.verify(canonical, stored.signature)

        # Tampered data does NOT verify with original signature
        tampered_data = dict(verdict_data)
        tampered_data["rating"] = 50
        tampered_canonical = json.dumps(tampered_data, sort_keys=True).encode()
        assert not mock_identity.verify(tampered_canonical, stored.signature)

        # Counter-proof: even a single-byte change (summary) also fails
        tampered_summary = dict(verdict_data)
        tampered_summary["summary"] = "Excellent laptops"  # added 's'
        tampered_summary_canonical = json.dumps(
            tampered_summary, sort_keys=True
        ).encode()
        assert not mock_identity.verify(
            tampered_summary_canonical, stored.signature
        ), "Any field change must invalidate the signature"

        # Counter-proof: a different identity cannot verify this signature
        other_identity = MockIdentity()
        assert other_identity.root_did != mock_identity.root_did
        assert not other_identity.verify(canonical, stored.signature), (
            "A different identity's verify() must reject the original author's signature"
        )

# TST-INT-301
    # TRACE: {"suite": "INT", "case": "0301", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "02", "title": "bundled_pds_in_docker_compose"}
    def test_bundled_pds_in_docker_compose(
        self,
        mock_compose: MockDockerCompose,
    ) -> None:
        """Type B deployment: PDS runs as a container inside the
        docker-compose stack alongside core and brain."""
        assert "pds" in mock_compose.containers
        pds = mock_compose.containers["pds"]

        # Pre-condition: nothing running before up()
        assert pds.running is False

        # PDS has a health-check on AT Protocol endpoint
        assert pds.healthcheck is not None
        assert "/xrpc/_health" in pds.healthcheck.endpoint

        # Start the stack — PDS starts before core (dependency order)
        mock_compose.up()
        start_order = mock_compose._resolve_start_order()
        assert start_order.index("pds") < start_order.index("core")
        assert pds.running is True

        # PDS is healthy after startup
        assert pds.healthcheck.is_healthy()

        # PDS exposes port 2583 for AT Protocol
        assert pds.is_port_exposed(2583), \
            "PDS must expose port 2583 for AT Protocol XRPC"

        # Counter-proof: brain does NOT expose port 2583
        brain = mock_compose.containers["brain"]
        assert not brain.is_port_exposed(2583), \
            "Only PDS should expose XRPC port"

        # All three containers run after up()
        assert mock_compose.is_all_healthy()

# TST-INT-302
    # TRACE: {"suite": "INT", "case": "0302", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "03", "title": "external_pds_push"}
    def test_external_pds_push(
        self,
        mock_identity: MockIdentity,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """Type A: user pushes trust records to an external PDS.
        The PLC document advertises the external PDS endpoint."""
        external_pds_endpoint = "https://pds.external-provider.example"
        doc = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint=external_pds_endpoint,
        )
        mock_plc_resolver.register(doc)

        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved is not None
        assert resolved.service_endpoint == external_pds_endpoint
        # The endpoint is external, not the local bundled PDS
        assert "external-provider" in resolved.service_endpoint

# TST-INT-303
    # TRACE: {"suite": "INT", "case": "0303", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "04", "title": "custom_lexicon_validation"}
    def test_custom_lexicon_validation(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Trust records use custom com.dina.trust.* lexicons.
        The AppView indexes only matching lexicons."""
        records = [
            {
                "id": "rec_1",
                "lexicon": "com.dina.trust.review",
                "author_did": "did:plc:Author1",
                "product_id": "laptop_1",
                "rating": 90,
                "signature": "sig_1",
            },
            {
                "id": "rec_2",
                "lexicon": "com.dina.trust.outcome",
                "author_did": "did:plc:Author2",
                "product_id": "laptop_1",
                "rating": 85,
                "signature": "sig_2",
            },
            {
                "id": "rec_3",
                "lexicon": "app.bsky.feed.post",  # unrelated Bluesky post
                "author_did": "did:plc:Author3",
                "text": "Hello world",
            },
        ]
        indexed = mock_app_view.consume_firehose(records)

        # Only the two com.dina.trust.* records are indexed
        assert indexed == 2
        assert len(mock_app_view.indexed_records) == 2
        lexicons = {r["lexicon"] for r in mock_app_view.indexed_records}
        assert all(lex.startswith("com.dina.trust.") for lex in lexicons)

# TST-INT-305
    # TRACE: {"suite": "INT", "case": "0305", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "05", "title": "author_deletes_own_review_signed_tombstone"}
    def test_author_deletes_own_review_signed_tombstone(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """An author can delete their own review by publishing a signed
        tombstone record."""
        author_did = mock_identity.root_did
        attestation = ExpertAttestation(
            expert_did=author_did,
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            rating=92,
            verdict={"summary": "Great laptop"},
            source_url="https://youtube.com/watch?v=tombstone_test",
        )
        mock_trust_network.add_attestation(attestation)
        assert len(mock_trust_network.attestations) == 1

        # Author signs and publishes tombstone
        tombstone_sig = mock_identity.sign(b"tombstone:thinkpad_x1_2025")
        deleted = mock_trust_network.signed_tombstone(
            "thinkpad_x1_2025", author_did, tombstone_sig
        )
        assert deleted is True
        assert len(mock_trust_network.attestations) == 0
        assert len(mock_trust_network.tombstones) == 1
        assert mock_trust_network.tombstones[0]["author"] == author_did

# TST-INT-306
    # TRACE: {"suite": "INT", "case": "0306", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "06", "title": "non_author_cannot_delete_review"}
    def test_non_author_cannot_delete_review(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """Only the original author can tombstone a review. A different
        DID's tombstone request is rejected."""
        original_author = "did:plc:OriginalAuthor0000000000000000"
        attestation = ExpertAttestation(
            expert_did=original_author,
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="laptops",
            product_id="thinkpad_x1_2025",
            rating=92,
            verdict={"summary": "Great laptop"},
            source_url="https://youtube.com/watch?v=non_author_test",
        )
        mock_trust_network.add_attestation(attestation)

        # A different user tries to delete the review
        impostor_did = mock_identity.root_did
        assert impostor_did != original_author

        fake_sig = mock_identity.sign(b"tombstone:thinkpad_x1_2025")
        deleted = mock_trust_network.signed_tombstone(
            "thinkpad_x1_2025", impostor_did, fake_sig
        )
        assert deleted is False
        # Record is still present
        assert len(mock_trust_network.attestations) == 1

# TST-INT-308
    # TRACE: {"suite": "INT", "case": "0308", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "07", "title": "aggregate_scores_computed_not_stored"}
    def test_aggregate_scores_computed_not_stored(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Aggregate trust scores are computed on-the-fly by the
        AppView, never persisted as a separate record."""
        records = [
            {
                "id": f"rec_{i}",
                "lexicon": "com.dina.trust.review",
                "author_did": f"did:plc:Expert{i}",
                "product_id": "laptop_agg",
                "rating": rating,
                "signature": f"sig_{i}",
            }
            for i, rating in enumerate([90, 80, 85], start=1)
        ]
        mock_app_view.consume_firehose(records)

        # Aggregate is computed, not stored
        aggregate = mock_app_view.compute_aggregate("laptop_agg")
        assert aggregate == pytest.approx(85.0)

        # No separate aggregate record exists in the index
        assert all(
            r.get("lexicon") != "com.dina.trust.aggregate"
            for r in mock_app_view.indexed_records
        )
        # Only the 3 individual review records
        assert len(mock_app_view.indexed_records) == 3

# TST-INT-316
    # TRACE: {"suite": "INT", "case": "0316", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "08", "title": "pds_down_records_still_available_via_relay"}
    def test_pds_down_records_still_available_via_relay(
        self,
        mock_app_view: MockAppView,
        mock_relay: MockRelay,
    ) -> None:
        """When a PDS is down, records that were already replicated to the
        relay/AppView remain available for queries.  New records from
        a different PDS are still consumable independently."""
        # Counter-proof: before firehose, no records exist
        assert len(mock_app_view.query_by_product("laptop_offline")) == 0

        # Records replicated to AppView via firehose (PDS was up at this point)
        records = [
            {
                "id": "rec_replicated_1",
                "lexicon": "com.dina.trust.review",
                "author_did": "did:plc:Author1",
                "product_id": "laptop_offline",
                "rating": 88,
                "signature": "sig_replicated",
            },
        ]
        indexed = mock_app_view.consume_firehose(records)
        assert indexed == 1

        # Relay had forwarded data — verify relay records the forwarding
        mock_relay.forward(
            "did:plc:Author1", "did:plc:AppView",
            "encrypted_record_blob_for_laptop_offline",
        )
        assert len(mock_relay.forwarded) == 1
        assert mock_relay.forwarded[0]["from"] == "did:plc:Author1"

        # PDS is now down — but AppView already has the indexed records
        # Query still works because AppView has its own indexed copy
        results = mock_app_view.query_by_product("laptop_offline")
        assert len(results) == 1
        assert results[0]["rating"] == 88
        assert results[0]["author_did"] == "did:plc:Author1"

        # Counter-proof: a different product NOT in the firehose returns empty
        assert len(mock_app_view.query_by_product("phone_missing")) == 0

        # Aggregate score is computable from cached records
        score = mock_app_view.compute_aggregate("laptop_offline")
        assert score == 88.0

# TST-INT-317
    # TRACE: {"suite": "INT", "case": "0317", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "09", "title": "pds_migration_account_portability"}
    def test_pds_migration_account_portability(
        self,
        mock_identity: MockIdentity,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """A user can migrate from one PDS to another without losing their
        DID or records. The PLC directory is updated to point to the new PDS."""
        old_pds = "https://old-pds.example.com"
        new_pds = "https://new-pds.example.com"

        # Register at old PDS
        doc_old = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint=old_pds,
        )
        mock_plc_resolver.register(doc_old)
        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved.service_endpoint == old_pds

        # Migrate: update PLC directory to new PDS
        doc_new = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint=new_pds,
        )
        mock_plc_resolver.register(doc_new)
        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved.service_endpoint == new_pds

        # DID stays the same
        assert resolved.did == mock_identity.root_did

# TST-INT-318
    # TRACE: {"suite": "INT", "case": "0318", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "10", "title": "foundation_pds_stores_only_trust_data"}
    def test_foundation_pds_stores_only_trust_data(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """The Foundation PDS stores only trust records (reviews,
        outcomes). No personal data (messages, contacts, health) is stored."""
        records = [
            {
                "id": "rep_1",
                "lexicon": "com.dina.trust.review",
                "author_did": "did:plc:Author1",
                "product_id": "chair_1",
                "rating": 91,
                "signature": "sig_1",
            },
            {
                "id": "personal_1",
                "lexicon": "com.dina.personal.message",
                "author_did": "did:plc:Author1",
                "body": "Hey, how are you?",
            },
            {
                "id": "health_1",
                "lexicon": "com.dina.health.record",
                "author_did": "did:plc:Author1",
                "data": "blood_pressure:120/80",
            },
        ]
        indexed = mock_app_view.consume_firehose(records)

        # Only the trust record is indexed
        assert indexed == 1
        assert len(mock_app_view.indexed_records) == 1
        assert mock_app_view.indexed_records[0]["lexicon"] == "com.dina.trust.review"

# TST-INT-319
    # TRACE: {"suite": "INT", "case": "0319", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "11", "title": "relay_crawls_pds_via_delta_sync"}
    def test_relay_crawls_pds_via_delta_sync(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """The relay uses cursor-based delta sync to crawl new records
        from PDS instances incrementally."""
        batch_1 = [
            {
                "id": "rec_1",
                "lexicon": "com.dina.trust.review",
                "author_did": "did:plc:Author1",
                "product_id": "phone_1",
                "rating": 85,
                "signature": "sig_1",
            },
        ]
        mock_app_view.consume_firehose(batch_1)
        cursor_after_batch_1 = mock_app_view.cursor
        assert cursor_after_batch_1 == 1

        # Second batch picks up from where cursor left off
        batch_2 = [
            {
                "id": "rec_2",
                "lexicon": "com.dina.trust.review",
                "author_did": "did:plc:Author2",
                "product_id": "phone_2",
                "rating": 78,
                "signature": "sig_2",
            },
            {
                "id": "rec_3",
                "lexicon": "com.dina.trust.outcome",
                "author_did": "did:plc:Author3",
                "product_id": "phone_1",
                "rating": 82,
                "signature": "sig_3",
            },
        ]
        mock_app_view.consume_firehose(batch_2)
        cursor_after_batch_2 = mock_app_view.cursor
        assert cursor_after_batch_2 == 3
        # Cursor advances monotonically
        assert cursor_after_batch_2 > cursor_after_batch_1
        # All records indexed across both batches
        assert len(mock_app_view.indexed_records) == 3

# TST-INT-320
    # TRACE: {"suite": "INT", "case": "0320", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "12", "title": "discovery_to_pds_federation"}
    def test_discovery_to_pds_federation(
        self,
        mock_identity: MockIdentity,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """DID resolution discovers the PDS endpoint, enabling federation.
        Given a DID, the resolver returns the service endpoint where
        trust records are stored."""
        pds_endpoint = "https://pds.dina.example.com"
        doc = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint=pds_endpoint,
        )
        mock_plc_resolver.register(doc)

        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved is not None
        assert resolved.service_endpoint == pds_endpoint
        # Another node can now federate by connecting to this endpoint
        assert resolved.service_endpoint.startswith("https://")

# TST-INT-321
    # TRACE: {"suite": "INT", "case": "0321", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "13", "title": "discovery_endpoint_available_unauthenticated"}
    def test_discovery_endpoint_available_unauthenticated(
        self,
        mock_plc_resolver: MockPLCResolver,
        mock_identity: MockIdentity,
    ) -> None:
        """DID discovery does not require authentication. Any node can
        resolve a DID to its PDS endpoint."""
        doc = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint="https://pds.open.example.com",
        )
        mock_plc_resolver.register(doc)

        # Resolve without any auth token or identity context
        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved is not None
        assert resolved.did == mock_identity.root_did
        # The resolve method has no auth parameter — it is inherently open
        import inspect
        sig = inspect.signature(mock_plc_resolver.resolve)
        param_names = list(sig.parameters.keys())
        assert param_names == ["did"]  # only DID, no auth

# TST-INT-322
    # TRACE: {"suite": "INT", "case": "0322", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "14", "title": "discovery_returns_plain_text_did"}
    def test_discovery_returns_plain_text_did(
        self,
        mock_plc_resolver: MockPLCResolver,
        mock_identity: MockIdentity,
    ) -> None:
        """The discovery response includes a simple DID string that starts
        with the 'did:' prefix."""
        doc = DIDDocument(
            did=mock_identity.root_did,
            public_key=mock_identity.root_private_key,
            service_endpoint="https://pds.example.com",
        )
        mock_plc_resolver.register(doc)

        resolved = mock_plc_resolver.resolve(mock_identity.root_did)
        assert resolved is not None
        # DID is a plain string with standard prefix
        assert isinstance(resolved.did, str)
        assert resolved.did.startswith("did:")
        # Contains the method segment
        assert resolved.did.startswith("did:plc:")

# TST-INT-323
    # TRACE: {"suite": "INT", "case": "0323", "section": "11", "sectionName": "Trust Network Integration", "subsection": "04", "scenario": "15", "title": "missing_discovery_pds_federation_fails"}
    def test_missing_discovery_pds_federation_fails(
        self,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """Without a discovery entry, a DID cannot be resolved and PDS
        federation fails gracefully."""
        unknown_did = "did:plc:UnknownUser00000000000000000000"
        resolved = mock_plc_resolver.resolve(unknown_did)
        assert resolved is None
        # Federation cannot proceed without a resolved endpoint


# ---------------------------------------------------------------------------
# Trust Data Density Spectrum (Section 22.1)
# ---------------------------------------------------------------------------


def assemble_trust_summary(
    attestations: list[ExpertAttestation],
    outcomes: list[OutcomeReport] | None = None,
) -> dict:
    """Assemble a trust-aware recommendation summary from attestation data.

    This implements the actual Brain logic for presenting trust data
    across the full density spectrum. The system must:
    - Never fabricate confidence where data doesn't support it
    - Be transparent about conflicts, limitations, and data quality
    - Weight verified (Ring 2+) reviewers higher than unverified
    - Report stale data honestly

    Returns:
        {
            "total_reviews": int,
            "positive_count": int,
            "negative_count": int,
            "neutral_count": int,
            "confidence_level": "none" | "low" | "moderate" | "high",
            "summary_text": str,
            "has_conflict": bool,
            "verified_count": int,
            "unverified_count": int,
        }
    """
    total = len(attestations)
    positive_count = sum(1 for a in attestations if a.rating >= 70)
    negative_count = sum(1 for a in attestations if a.rating < 30)
    neutral_count = total - positive_count - negative_count

    verified_count = sum(
        1 for a in attestations
        if a.expert_trust_ring in (TrustRing.RING_2_VERIFIED,
                                    TrustRing.RING_3_SKIN_IN_GAME)
    )
    unverified_count = total - verified_count

    has_conflict = positive_count > 0 and negative_count > 0

    # Confidence based on total count
    if total == 0:
        confidence_level = "none"
    elif total <= 2:
        confidence_level = "low"
    elif total <= 9:
        confidence_level = "moderate"
    else:
        confidence_level = "high"

    # --- Summary text assembly ---
    if total == 0:
        summary_text = "No verified reviews available for this product"
    elif total == 1:
        att = attestations[0]
        if att.rating >= 70:
            stance = "recommends"
        elif att.rating < 30:
            stance = "cautions against"
        else:
            stance = "is neutral on"
        source_label = "verified source" if verified_count == 1 else "unverified source"
        summary_text = (
            f"Limited evidence — 1 {source_label} {stance} this product"
        )
    elif has_conflict:
        if positive_count == negative_count:
            # Equal split
            source_label = "verified sources" if verified_count > 0 else "unverified sources"
            summary_text = (
                f"Split opinion from {source_label} — "
                f"{positive_count} recommend, {negative_count} "
                f"{'caution' if negative_count == 1 else 'caution'}"
            )
        elif total >= 50 and max(positive_count, negative_count) / total >= 0.9:
            # Dense consensus: overwhelming supermajority despite some dissent
            source_label = "verified sources" if verified_count > 0 else "unverified sources"
            majority = max(positive_count, negative_count)
            minority = min(positive_count, negative_count)
            if positive_count > negative_count:
                summary_text = (
                    f"Strong consensus from {total} {source_label} — "
                    f"{majority} recommend, {minority} "
                    f"{'cautions' if minority == 1 else 'caution'}"
                )
            else:
                summary_text = (
                    f"Strong consensus from {total} {source_label} — "
                    f"{majority} caution against, {minority} recommend"
                )
        else:
            # Unequal split with conflict
            source_label = "verified sources" if verified_count > 0 else "unverified sources"
            summary_text = (
                f"Mixed reviews from {source_label} — "
                f"{positive_count} recommend, {negative_count} "
                f"{'cautions' if negative_count == 1 else 'caution'}"
            )
    elif positive_count == total:
        source_label = "verified sources" if verified_count > 0 else "unverified sources"
        summary_text = (
            f"Consensus positive from {source_label} — "
            f"all {total} reviewers recommend"
        )
    elif negative_count == total:
        source_label = "verified sources" if verified_count > 0 else "unverified sources"
        summary_text = (
            f"Consensus negative from {source_label} — "
            f"all {total} reviewers caution against"
        )
    else:
        # Mix of positive/neutral or negative/neutral (no conflict)
        source_label = "verified sources" if verified_count > 0 else "unverified sources"
        summary_text = (
            f"Generally {'positive' if positive_count > negative_count else 'cautious'} "
            f"from {source_label} — "
            f"{positive_count} recommend, {neutral_count} neutral"
            + (f", {negative_count} caution" if negative_count > 0 else "")
        )

    return {
        "total_reviews": total,
        "positive_count": positive_count,
        "negative_count": negative_count,
        "neutral_count": neutral_count,
        "confidence_level": confidence_level,
        "summary_text": summary_text,
        "has_conflict": has_conflict,
        "verified_count": verified_count,
        "unverified_count": unverified_count,
    }


def _classify_sentiment(positive: int, negative: int, neutral: int) -> str:
    """Return a sentiment label for a group of attestations."""
    if positive > 0 and negative > 0:
        return "mixed"
    if positive > 0:
        return "positive"
    if negative > 0:
        return "negative"
    if neutral > 0:
        return "neutral"
    return "neutral"


def assemble_ring_weighted_summary(
    attestations: list[ExpertAttestation],
) -> dict:
    """Assemble a ring-aware trust summary that weights verified sources higher.

    Separates attestations into verified (Ring 2+) and unverified (Ring 1)
    groups, computes independent sentiment for each, and produces a narrative
    that makes the ring-based weighting visible when the groups disagree.

    Returns:
        {
            "verified_sentiment": "positive" | "negative" | "neutral" | "mixed",
            "unverified_sentiment": "positive" | "negative" | "neutral" | "mixed",
            "ring_conflict": bool,
            "summary_text": str,
            "verified_count": int,
            "unverified_count": int,
            "weighting_visible": bool,
        }
    """
    verified = [
        a for a in attestations
        if a.expert_trust_ring in (TrustRing.RING_2_VERIFIED,
                                    TrustRing.RING_3_SKIN_IN_GAME)
    ]
    unverified = [
        a for a in attestations
        if a.expert_trust_ring == TrustRing.RING_1_UNVERIFIED
    ]

    def _group_counts(group: list[ExpertAttestation]) -> tuple[int, int, int]:
        pos = sum(1 for a in group if a.rating >= 70)
        neg = sum(1 for a in group if a.rating < 30)
        neu = len(group) - pos - neg
        return pos, neg, neu

    v_pos, v_neg, v_neu = _group_counts(verified)
    u_pos, u_neg, u_neu = _group_counts(unverified)

    verified_sentiment = _classify_sentiment(v_pos, v_neg, v_neu)
    unverified_sentiment = _classify_sentiment(u_pos, u_neg, u_neu)

    verified_count = len(verified)
    unverified_count = len(unverified)

    # Ring conflict: the two groups' dominant sentiments disagree.
    # Only meaningful when both groups have attestations.
    ring_conflict = (
        verified_count > 0
        and unverified_count > 0
        and verified_sentiment != unverified_sentiment
        # Only flag conflict when the sentiments are substantively opposed
        # (positive vs negative, or one mixed and the other clearly one-sided)
        and not (verified_sentiment == "neutral" and unverified_sentiment == "neutral")
    )

    # --- Build summary text ---
    if verified_count == 0 and unverified_count == 0:
        summary_text = "No reviews available for this product"
        weighting_visible = False
    elif verified_count == 0:
        # All unverified — must note absence of verified data
        if u_pos > 0 and u_neg == 0:
            tone = "positive"
        elif u_neg > 0 and u_pos == 0:
            tone = "negative"
        else:
            tone = "mixed"
        summary_text = (
            f"All {unverified_count} review{'s' if unverified_count != 1 else ''} "
            f"are from unverified sources ({tone} sentiment). "
            f"No verified reviews available"
        )
        weighting_visible = False
    elif unverified_count == 0:
        # All verified — no ring distinction needed in narrative
        if v_pos > 0 and v_neg == 0:
            tone = "positive"
        elif v_neg > 0 and v_pos == 0:
            tone = "negative"
        else:
            tone = "mixed"
        summary_text = (
            f"All {verified_count} review{'s' if verified_count != 1 else ''} "
            f"are from verified sources ({tone} sentiment)"
        )
        weighting_visible = False
    elif ring_conflict:
        # Both groups present AND they disagree — weighting must be visible
        # Describe verified group sentiment
        if verified_sentiment == "negative":
            verified_desc = (
                f"Verified reviewers ({verified_count}) caution against this product"
            )
        elif verified_sentiment == "positive":
            verified_desc = (
                f"Verified reviewers ({verified_count}) recommend this product"
            )
        else:
            verified_desc = (
                f"Verified reviewers ({verified_count}) are {verified_sentiment}"
            )

        # Describe unverified group sentiment
        if unverified_sentiment == "positive":
            unverified_desc = (
                f"unverified reviews ({unverified_count}) are more positive"
            )
        elif unverified_sentiment == "negative":
            unverified_desc = (
                f"unverified reviews ({unverified_count}) are more negative"
            )
        else:
            unverified_desc = (
                f"unverified reviews ({unverified_count}) are {unverified_sentiment}"
            )

        summary_text = (
            f"{verified_desc}; {unverified_desc}. "
            f"Verified sources are weighted higher in this assessment"
        )
        weighting_visible = True
    else:
        # Both groups present, sentiments agree — mention both but no conflict
        summary_text = (
            f"Verified ({verified_count}) and unverified ({unverified_count}) "
            f"reviewers agree: sentiment is {verified_sentiment}"
        )
        weighting_visible = False

    return {
        "verified_sentiment": verified_sentiment,
        "unverified_sentiment": unverified_sentiment,
        "ring_conflict": ring_conflict,
        "summary_text": summary_text,
        "verified_count": verified_count,
        "unverified_count": unverified_count,
        "weighting_visible": weighting_visible,
    }


def assemble_trust_summary_with_outcomes(
    attestations: list[ExpertAttestation],
    outcomes: list[OutcomeReport] | None = None,
) -> dict:
    """Assemble a trust summary that also accounts for outcome data.

    Extends :func:`assemble_trust_summary` by cross-referencing attestation
    (review) presence against outcome (purchase result) presence.  When
    reviews exist but outcomes are absent, the summary must disclose this
    "outcome gap" so that the user understands long-term satisfaction data
    is unknown.

    Returns all keys from ``assemble_trust_summary`` plus:
        ``outcome_count``      -- number of outcome reports provided
        ``has_outcome_gap``    -- True when reviews are present but outcomes
                                  are empty/None
        ``outcome_disclosure`` -- human-readable note about outcome availability
    """
    base = assemble_trust_summary(attestations, outcomes=outcomes)

    outcome_list = outcomes if outcomes is not None else []
    outcome_count = len(outcome_list)
    has_reviews = base["total_reviews"] > 0

    # Outcome gap: reviews exist but no purchase outcomes to corroborate
    has_outcome_gap = has_reviews and outcome_count == 0

    if has_outcome_gap:
        outcome_disclosure = (
            "Reviews available but no verified purchase outcomes "
            "\u2014 long-term satisfaction unknown"
        )
    elif has_reviews and outcome_count > 0:
        outcome_disclosure = (
            f"{outcome_count} verified purchase "
            f"{'outcome' if outcome_count == 1 else 'outcomes'} available"
        )
    else:
        # No reviews (and possibly no outcomes) -- nothing to disclose
        outcome_disclosure = ""

    return {
        **base,
        "outcome_count": outcome_count,
        "has_outcome_gap": has_outcome_gap,
        "outcome_disclosure": outcome_disclosure,
    }


def assemble_trust_summary_with_recency(
    attestations: list[ExpertAttestation],
    now: float | None = None,
) -> dict:
    """Assemble a trust summary that checks review recency and discloses staleness.

    Extends :func:`assemble_trust_summary` by examining the timestamps of
    all attestations to determine whether they are stale (older than 365
    days).  Stale reviews are **included** in the summary — never silently
    discarded — but a recency disclosure is added so the user understands
    the data may be outdated.

    Returns all keys from ``assemble_trust_summary`` plus:
        ``all_stale``            -- True when **every** review is older
                                    than 365 days
        ``oldest_review_days``   -- age (in days) of the oldest review
        ``newest_review_days``   -- age (in days) of the newest review
        ``recency_disclosure``   -- human-readable staleness note
        ``reviews_included``     -- True (stale reviews are kept, not
                                    discarded)
    """
    base = assemble_trust_summary(attestations)
    current_time = now if now is not None else time.time()

    if not attestations:
        return {
            **base,
            "all_stale": False,
            "oldest_review_days": 0,
            "newest_review_days": 0,
            "recency_disclosure": "",
            "reviews_included": True,
        }

    SECONDS_PER_DAY = 86400
    STALE_THRESHOLD_DAYS = 365

    ages_days = [
        int((current_time - a.timestamp) / SECONDS_PER_DAY)
        for a in attestations
    ]
    oldest_days = max(ages_days)
    newest_days = min(ages_days)

    stale_count = sum(1 for age in ages_days if age > STALE_THRESHOLD_DAYS)
    all_stale = stale_count == len(ages_days)

    # --- Recency disclosure ---
    if all_stale:
        recency_disclosure = (
            "Reviews are over a year old \u2014 product may have changed"
        )
    elif stale_count > 0:
        fresh_count = len(ages_days) - stale_count
        recency_disclosure = (
            f"Mixed recency: {fresh_count} recent "
            f"{'review' if fresh_count == 1 else 'reviews'}, "
            f"{stale_count} older than a year"
        )
    else:
        recency_disclosure = ""

    # --- Confidence downgrade for all-stale data ---
    # Stale data should not produce inflated confidence.  When all reviews
    # are stale, cap confidence at "moderate" regardless of volume.
    confidence_level = base["confidence_level"]
    if all_stale and confidence_level == "high":
        confidence_level = "moderate"

    return {
        **base,
        "confidence_level": confidence_level,
        "all_stale": all_stale,
        "oldest_review_days": oldest_days,
        "newest_review_days": newest_days,
        "recency_disclosure": recency_disclosure,
        "reviews_included": True,
    }


class TestTrustDataDensity:
    """22.1 Trust Data Density Spectrum — the system must produce useful
    responses across the entire data spectrum without fabricating confidence."""

    # TST-INT-718
    # TRACE: {"suite": "INT", "case": "0718", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "01", "title": "sparse_conflicting_transparent_split"}
    def test_sparse_conflicting_transparent_split(self) -> None:
        """Sparse conflicting: 3 reviews (2 positive, 1 negative) from
        verified sources.  The response must report the split honestly
        without fabricating consensus."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ReviewerAlpha000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                rating=85,
                verdict={
                    "summary": "Solid build quality, great keyboard",
                    "pros": ["keyboard", "display", "build quality"],
                    "cons": ["battery life could be better"],
                },
                source_url="https://techreviews.example/thinkpad-x1-2026-review",
                deep_link="https://techreviews.example/thinkpad-x1-2026-review#battery",
                deep_link_context="Battery benchmark at section 4",
                creator_name="TechReviewerAlpha",
            ),
            ExpertAttestation(
                expert_did="did:plc:ReviewerBeta0000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                rating=90,
                verdict={
                    "summary": "Best business laptop of 2026",
                    "pros": ["performance", "portability", "keyboard"],
                    "cons": ["price"],
                },
                source_url="https://laptopworld.example/x1-2026-deep-dive",
                deep_link="https://laptopworld.example/x1-2026-deep-dive#perf",
                deep_link_context="Performance benchmarks section",
                creator_name="LaptopWorldBeta",
            ),
            ExpertAttestation(
                expert_did="did:plc:ReviewerGamma000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                rating=20,
                verdict={
                    "summary": "Overpriced, thermal throttling under load",
                    "pros": ["keyboard feel"],
                    "cons": ["thermal throttling", "overpriced", "fan noise"],
                },
                source_url="https://honesttech.example/thinkpad-x1-problems",
                deep_link="https://honesttech.example/thinkpad-x1-problems#thermals",
                deep_link_context="Thermal stress test results",
                creator_name="HonestTechGamma",
            ),
        ]

        result = assemble_trust_summary(attestations)

        # --- Core assertions (TST-INT-718) ---

        # 1. Total reviews
        assert result["total_reviews"] == 3

        # 2. Correct positive/negative breakdown
        assert result["positive_count"] == 2
        assert result["negative_count"] == 1
        assert result["neutral_count"] == 0

        # 3. Conflict detected — both positive and negative exist
        assert result["has_conflict"] is True

        # 4. Confidence is moderate (3 reviews — sparse but real)
        assert result["confidence_level"] == "moderate"

        # 5. All reviewers are verified (Ring 2)
        assert result["verified_count"] == 3
        assert result["unverified_count"] == 0

        # 6. Summary text reports the split honestly
        summary = result["summary_text"].lower()
        assert "2" in result["summary_text"], (
            "Summary must mention the positive count (2)"
        )
        assert "1" in result["summary_text"], (
            "Summary must mention the negative count (1)"
        )
        assert "mixed" in summary or "split" in summary, (
            "Summary must acknowledge disagreement with 'mixed' or 'split'"
        )

        # 7. Summary does NOT fabricate consensus
        assert "strong consensus" not in summary, (
            "Must not claim strong consensus when reviews conflict"
        )
        assert "unanimous" not in summary, (
            "Must not claim unanimity when reviews conflict"
        )

        # 8. Confidence is NOT high — only 3 reviews
        assert result["confidence_level"] != "high", (
            "3 reviews must not produce high confidence"
        )

    # --- Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0222", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "02", "title": "all_positive_no_conflict"}
    def test_all_positive_no_conflict(self) -> None:
        """Counter-proof: 3 positive reviews produce no conflict flag,
        and summary mentions agreement."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:PositiveReviewer{i:024d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="headphones",
                product_id="studio_pro_2026",
                rating=rating,
                verdict={
                    "summary": f"Reviewer {i} loved the sound quality",
                    "pros": ["sound", "comfort"],
                    "cons": ["weight"],
                },
                source_url=f"https://audiophile.example/review-{i}",
                creator_name=f"AudioReviewer{i}",
            )
            for i, rating in enumerate([88, 92, 80], start=1)
        ]

        result = assemble_trust_summary(attestations)

        assert result["has_conflict"] is False
        assert result["positive_count"] == 3
        assert result["negative_count"] == 0
        summary = result["summary_text"].lower()
        assert "consensus" in summary or "all" in summary, (
            "All-positive should mention agreement"
        )
        assert "mixed" not in summary, (
            "All-positive must NOT say 'mixed'"
        )

    # TRACE: {"suite": "INT", "case": "0223", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "03", "title": "all_negative_no_conflict"}
    def test_all_negative_no_conflict(self) -> None:
        """Counter-proof: 3 negative reviews produce no conflict flag,
        and summary mentions consensus against."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:NegativeReviewer{i:023d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="tablets",
                product_id="budget_tablet_2026",
                rating=rating,
                verdict={
                    "summary": f"Reviewer {i} found serious quality issues",
                    "pros": ["price"],
                    "cons": ["display", "performance", "durability"],
                },
                source_url=f"https://tabletreviews.example/review-{i}",
                creator_name=f"TabletReviewer{i}",
            )
            for i, rating in enumerate([15, 22, 10], start=1)
        ]

        result = assemble_trust_summary(attestations)

        assert result["has_conflict"] is False
        assert result["positive_count"] == 0
        assert result["negative_count"] == 3
        summary = result["summary_text"].lower()
        assert "consensus" in summary or "all" in summary
        assert "caution" in summary or "against" in summary

    # TRACE: {"suite": "INT", "case": "0224", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "04", "title": "single_review_low_confidence"}
    def test_single_review_low_confidence(self) -> None:
        """Counter-proof: a single review yields low confidence and
        mentions limited evidence."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:SoloReviewer0000000000000000000",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="monitors",
                product_id="ultrawide_2026",
                rating=78,
                verdict={
                    "summary": "Decent monitor for the price",
                    "pros": ["value", "color accuracy"],
                    "cons": ["stand quality"],
                },
                source_url="https://displays.example/ultrawide-review",
                creator_name="DisplayExpert",
            ),
        ]

        result = assemble_trust_summary(attestations)

        assert result["total_reviews"] == 1
        assert result["confidence_level"] == "low"
        assert "limited" in result["summary_text"].lower(), (
            "Single review must mention limited evidence"
        )

    # TRACE: {"suite": "INT", "case": "0225", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "05", "title": "zero_reviews_no_confidence"}
    def test_zero_reviews_no_confidence(self) -> None:
        """Counter-proof: zero reviews yield 'none' confidence and
        a clear 'no reviews' message."""
        result = assemble_trust_summary([])

        assert result["total_reviews"] == 0
        assert result["confidence_level"] == "none"
        assert result["has_conflict"] is False
        assert result["positive_count"] == 0
        assert result["negative_count"] == 0
        assert result["verified_count"] == 0
        assert result["unverified_count"] == 0
        assert "no" in result["summary_text"].lower()

    # --- Edge cases ---

    # TRACE: {"suite": "INT", "case": "0226", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "06", "title": "two_positive_one_neutral_no_conflict"}
    def test_two_positive_one_neutral_no_conflict(self) -> None:
        """Edge case: 2 positive + 1 neutral does NOT trigger conflict —
        neutral reviews do not count as negative."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:PosEdge10000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="mech_keyboard_2026",
                rating=82,
                verdict={
                    "summary": "Great tactile feel",
                    "pros": ["switches", "build"],
                    "cons": ["no wireless"],
                },
                source_url="https://keyboards.example/mech-review-1",
                creator_name="KeyboardFan1",
            ),
            ExpertAttestation(
                expert_did="did:plc:PosEdge20000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="mech_keyboard_2026",
                rating=75,
                verdict={
                    "summary": "Solid choice for the price",
                    "pros": ["value", "typing experience"],
                    "cons": ["software"],
                },
                source_url="https://keyboards.example/mech-review-2",
                creator_name="KeyboardFan2",
            ),
            ExpertAttestation(
                expert_did="did:plc:NeutralEdge0000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="mech_keyboard_2026",
                rating=50,
                verdict={
                    "summary": "Average keyboard, nothing special",
                    "pros": ["acceptable build"],
                    "cons": ["nothing stands out"],
                },
                source_url="https://keyboards.example/mech-review-3",
                creator_name="KeyboardReviewer3",
            ),
        ]

        result = assemble_trust_summary(attestations)

        assert result["has_conflict"] is False, (
            "Neutral reviews must NOT trigger conflict"
        )
        assert result["positive_count"] == 2
        assert result["neutral_count"] == 1
        assert result["negative_count"] == 0

    # TRACE: {"suite": "INT", "case": "0227", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "07", "title": "equal_split_one_positive_one_negative"}
    def test_equal_split_one_positive_one_negative(self) -> None:
        """Edge case: 1 positive + 1 negative is a 50/50 split,
        has_conflict must be True."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:SplitPos000000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="cameras",
                product_id="mirrorless_2026",
                rating=85,
                verdict={
                    "summary": "Excellent image quality",
                    "pros": ["sensor", "autofocus"],
                    "cons": ["battery"],
                },
                source_url="https://cameras.example/mirrorless-positive",
                creator_name="PhotoPro",
            ),
            ExpertAttestation(
                expert_did="did:plc:SplitNeg000000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="cameras",
                product_id="mirrorless_2026",
                rating=18,
                verdict={
                    "summary": "Terrible ergonomics, overheats in video",
                    "pros": ["image quality in photos"],
                    "cons": ["overheating", "ergonomics", "menu system"],
                },
                source_url="https://cameras.example/mirrorless-negative",
                creator_name="VideoPro",
            ),
        ]

        result = assemble_trust_summary(attestations)

        assert result["has_conflict"] is True
        assert result["positive_count"] == 1
        assert result["negative_count"] == 1
        summary = result["summary_text"].lower()
        assert "split" in summary or "mixed" in summary

    # TRACE: {"suite": "INT", "case": "0228", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "08", "title": "all_unverified_mentions_unverified"}
    def test_all_unverified_mentions_unverified(self) -> None:
        """Edge case: all reviewers from Ring 1 (unverified).
        verified_count == 0, summary mentions unverified."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:Unverified{i:025d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="earbuds",
                product_id="budget_earbuds_2026",
                rating=rating,
                verdict={
                    "summary": f"Unverified reviewer {i} opinion",
                    "pros": ["price"],
                    "cons": ["sound quality"],
                },
                source_url=f"https://forums.example/earbuds-review-{i}",
                creator_name=f"ForumUser{i}",
            )
            for i, rating in enumerate([72, 80, 75], start=1)
        ]

        result = assemble_trust_summary(attestations)

        assert result["verified_count"] == 0
        assert result["unverified_count"] == 3
        assert "unverified" in result["summary_text"].lower(), (
            "Summary must mention that sources are unverified"
        )

    # ------------------------------------------------------------------
    # TST-INT-717  Single review: honest uncertainty
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0717", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "09", "title": "single_review_honest_uncertainty"}
    def test_single_review_honest_uncertainty(self) -> None:
        """TST-INT-717: 1 attestation in AppView -> Brain assembles response.
        Response includes the review but notes limited data:
        'One verified review — limited evidence'.

        Validates that a single positive review from a verified source is
        reported honestly — low confidence, limited evidence, no fabricated
        consensus language.
        """
        attestation = ExpertAttestation(
            expert_did="did:plc:SingleReviewer00000000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="smartphones",
            product_id="pixel_10_2026",
            rating=82,
            verdict={
                "summary": "Excellent camera, clean software experience",
                "pros": ["camera", "software", "updates"],
                "cons": ["battery life mediocre"],
            },
            source_url="https://phonereview.example/pixel-10-review",
            deep_link="https://phonereview.example/pixel-10-review#camera",
            deep_link_context="Camera comparison section",
            creator_name="PhoneReviewerAlpha",
        )

        result = assemble_trust_summary([attestation])
        summary = result["summary_text"]
        summary_lower = summary.lower()

        # 1. Exactly 1 review counted
        assert result["total_reviews"] == 1

        # 2. Confidence must be "low" — only 1 data point
        assert result["confidence_level"] == "low", (
            f"Single review must yield low confidence, got "
            f"'{result['confidence_level']}'"
        )
        assert result["confidence_level"] != "moderate", (
            "1 review must never reach moderate confidence"
        )
        assert result["confidence_level"] != "high", (
            "1 review must never reach high confidence"
        )

        # 3. Summary communicates limited evidence
        limited_indicators = ("limited", "one", "1")
        assert any(indicator in summary_lower for indicator in limited_indicators), (
            f"Summary must mention limited evidence (expected one of "
            f"{limited_indicators}), got: '{summary}'"
        )

        # 4. Summary must NOT fabricate confidence or consensus
        fabricated_phrases = (
            "strong consensus",
            "recommended",
            "many",
            "most",
            "unanimous",
            "all reviewers",
            "consensus positive",
            "consensus negative",
            "generally",
        )
        for phrase in fabricated_phrases:
            assert phrase not in summary_lower, (
                f"Single review must NOT claim '{phrase}' — "
                f"fabricating confidence from 1 data point. Got: '{summary}'"
            )

        # 5. Correct sentiment breakdown (rating 82 >= 70 → positive)
        assert result["positive_count"] == 1
        assert result["negative_count"] == 0
        assert result["neutral_count"] == 0

        # 6. Verified/unverified correctly reported (Ring 2 = verified)
        assert result["verified_count"] == 1
        assert result["unverified_count"] == 0

        # 7. No conflict possible with a single review
        assert result["has_conflict"] is False, (
            "A single review cannot have internal conflict"
        )

        # 8. The positive stance is reflected in the summary
        # (rating 82 → "recommends" — the single reviewer's view)
        stance_words = ("recommends", "positive", "recommend")
        assert any(w in summary_lower for w in stance_words), (
            f"Summary must reflect the single reviewer's positive stance, "
            f"got: '{summary}'"
        )

    # --- TST-INT-717 Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0717", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "10", "title": "single_negative_review_reports_caution"}
    def test_single_negative_review_reports_caution(self) -> None:
        """TST-INT-717 counter-proof: a single negative review (rating=15)
        must report caution — never 'recommends'."""
        attestation = ExpertAttestation(
            expert_did="did:plc:NegSoloReviewer000000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="routers",
            product_id="mesh_router_2026",
            rating=15,
            verdict={
                "summary": "Constant disconnections, terrible firmware",
                "pros": ["design looks nice"],
                "cons": ["reliability", "firmware bugs", "range"],
            },
            source_url="https://networkreview.example/mesh-router-disaster",
            creator_name="NetworkExpert",
        )

        result = assemble_trust_summary([attestation])
        summary_lower = result["summary_text"].lower()

        assert result["total_reviews"] == 1
        assert result["confidence_level"] == "low"
        assert result["negative_count"] == 1
        assert result["positive_count"] == 0

        # Must mention caution — not recommendation
        assert "caution" in summary_lower or "against" in summary_lower, (
            f"Negative single review must mention caution, got: "
            f"'{result['summary_text']}'"
        )
        assert "recommends" not in summary_lower, (
            "Negative single review must NOT say 'recommends'"
        )

    # TRACE: {"suite": "INT", "case": "0229", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "11", "title": "single_neutral_review_neither_recommends_nor_cautions"}
    def test_single_neutral_review_neither_recommends_nor_cautions(self) -> None:
        """TST-INT-717 counter-proof: a single neutral review (rating=50)
        must not claim positive or negative stance."""
        attestation = ExpertAttestation(
            expert_did="did:plc:NeutralSoloReview0000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="webcams",
            product_id="budget_webcam_2026",
            rating=50,
            verdict={
                "summary": "Average quality, nothing remarkable",
                "pros": ["price"],
                "cons": ["image quality in low light"],
            },
            source_url="https://webcamreviews.example/budget-webcam",
            creator_name="WebcamReviewer",
        )

        result = assemble_trust_summary([attestation])
        summary_lower = result["summary_text"].lower()

        assert result["total_reviews"] == 1
        assert result["confidence_level"] == "low"
        assert result["neutral_count"] == 1
        assert result["positive_count"] == 0
        assert result["negative_count"] == 0

        # Neutral must not claim positive or negative stance
        assert "recommends" not in summary_lower, (
            "Neutral review must NOT say 'recommends'"
        )
        assert "cautions against" not in summary_lower, (
            "Neutral review must NOT say 'cautions against'"
        )

        # Must reflect neutrality
        assert "neutral" in summary_lower, (
            f"Neutral single review should mention neutral stance, "
            f"got: '{result['summary_text']}'"
        )

    # TRACE: {"suite": "INT", "case": "0230", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "12", "title": "single_unverified_review_disclosed"}
    def test_single_unverified_review_disclosed(self) -> None:
        """TST-INT-717 counter-proof: a single unverified review (Ring 1)
        must disclose 'unverified' status — never claim verified source."""
        attestation = ExpertAttestation(
            expert_did="did:plc:UnverifiedSoloReview00000000000",
            expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
            product_category="chargers",
            product_id="usbc_charger_2026",
            rating=78,
            verdict={
                "summary": "Fast charging, compact design",
                "pros": ["speed", "portability"],
                "cons": ["gets warm"],
            },
            source_url="https://forums.example/usbc-charger-review",
            creator_name="ForumUser42",
        )

        result = assemble_trust_summary([attestation])
        summary_lower = result["summary_text"].lower()

        assert result["total_reviews"] == 1
        assert result["confidence_level"] == "low"
        assert result["verified_count"] == 0
        assert result["unverified_count"] == 1

        # Must disclose unverified status
        assert "unverified" in summary_lower, (
            f"Unverified reviewer must be disclosed as unverified, "
            f"got: '{result['summary_text']}'"
        )
        # Must NOT falsely claim verified
        assert "verified source" not in summary_lower.replace("unverified", ""), (
            "Must not claim 'verified source' for a Ring 1 reviewer"
        )

    # TRACE: {"suite": "INT", "case": "0231", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "13", "title": "single_review_never_says_consensus"}
    def test_single_review_never_says_consensus(self) -> None:
        """TST-INT-717 counter-proof: no single-review summary may
        use any consensus / confidence-fabricating language, regardless
        of the reviewer's rating or ring."""
        test_cases = [
            ("did:plc:ConsensusChkPos000000000000000", TrustRing.RING_2_VERIFIED, 90),
            ("did:plc:ConsensusChkNeg000000000000000", TrustRing.RING_2_VERIFIED, 10),
            ("did:plc:ConsensusChkNeutral0000000000", TrustRing.RING_2_VERIFIED, 50),
            ("did:plc:ConsensusChkUnverif0000000000", TrustRing.RING_1_UNVERIFIED, 85),
            ("did:plc:ConsensusChkR3Pos00000000000", TrustRing.RING_3_SKIN_IN_GAME, 75),
        ]

        forbidden_phrases = (
            "consensus",
            "unanimous",
            "all reviewers",
            "strong",
            "many",
            "most",
            "majority",
            "overwhelmingly",
        )

        for did, ring, rating in test_cases:
            attestation = ExpertAttestation(
                expert_did=did,
                expert_trust_ring=ring,
                product_category="accessories",
                product_id="generic_product_2026",
                rating=rating,
                verdict={
                    "summary": "Test review",
                    "pros": ["test"],
                    "cons": ["test"],
                },
                source_url="https://test.example/review",
                creator_name="TestReviewer",
            )

            result = assemble_trust_summary([attestation])
            summary_lower = result["summary_text"].lower()

            for phrase in forbidden_phrases:
                assert phrase not in summary_lower, (
                    f"Single review (rating={rating}, ring={ring.name}) "
                    f"must never use '{phrase}' — got: '{result['summary_text']}'"
                )

    # --- TST-INT-717 Edge cases: boundary ratings ---

    # TRACE: {"suite": "INT", "case": "0717", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "14", "title": "single_review_boundary_rating_70"}
    def test_single_review_boundary_rating_70(self) -> None:
        """TST-INT-717 edge case: rating=70 is the threshold for positive
        (>= 70 is positive).  Must count as positive, not neutral."""
        attestation = ExpertAttestation(
            expert_did="did:plc:BoundaryPos70_0000000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="mice",
            product_id="ergonomic_mouse_2026",
            rating=70,
            verdict={
                "summary": "Decent ergonomic mouse, just crosses the bar",
                "pros": ["ergonomics"],
                "cons": ["sensor precision", "scroll wheel"],
            },
            source_url="https://peripherals.example/ergo-mouse-review",
            creator_name="PeripheralReviewer",
        )

        result = assemble_trust_summary([attestation])
        summary_lower = result["summary_text"].lower()

        assert result["positive_count"] == 1, (
            "Rating 70 (>= 70 threshold) must count as positive"
        )
        assert result["negative_count"] == 0
        assert result["neutral_count"] == 0

        # Stance should reflect positive (recommends)
        assert "recommends" in summary_lower or "positive" in summary_lower, (
            f"Rating 70 (boundary positive) should reflect positive stance, "
            f"got: '{result['summary_text']}'"
        )
        assert "cautions against" not in summary_lower, (
            "Boundary-positive review (70) must NOT say 'cautions against'"
        )
        assert "neutral" not in summary_lower, (
            "Boundary-positive review (70) must NOT be classified as neutral"
        )

    # TRACE: {"suite": "INT", "case": "0232", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "15", "title": "single_review_boundary_rating_30"}
    def test_single_review_boundary_rating_30(self) -> None:
        """TST-INT-717 edge case: rating=30 must NOT be negative (threshold
        is < 30 for negative).  Rating 30 should count as neutral."""
        attestation = ExpertAttestation(
            expert_did="did:plc:BoundaryNeutral30_000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="speakers",
            product_id="portable_speaker_2026",
            rating=30,
            verdict={
                "summary": "Mediocre sound, barely acceptable",
                "pros": ["portability"],
                "cons": ["bass response", "volume"],
            },
            source_url="https://audiogear.example/portable-speaker-review",
            creator_name="AudioReviewer",
        )

        result = assemble_trust_summary([attestation])
        summary_lower = result["summary_text"].lower()

        assert result["neutral_count"] == 1, (
            "Rating 30 (not < 30) must count as neutral, not negative"
        )
        assert result["negative_count"] == 0, (
            "Rating 30 must NOT be negative — threshold is strictly < 30"
        )
        assert result["positive_count"] == 0

        # Stance should reflect neutral — not recommends, not cautions
        assert "neutral" in summary_lower, (
            f"Rating 30 (boundary neutral) should reflect neutral stance, "
            f"got: '{result['summary_text']}'"
        )
        assert "recommends" not in summary_lower, (
            "Boundary-neutral review (30) must NOT say 'recommends'"
        )
        assert "cautions against" not in summary_lower, (
            "Boundary-neutral review (30) must NOT say 'cautions against'"
        )

    # ------------------------------------------------------------------
    # TST-INT-716  Zero trust data: graceful absence
    # ------------------------------------------------------------------

    # TST-INT-716
    # TRACE: {"suite": "INT", "case": "0716", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "16", "title": "zero_trust_data_graceful_absence"}
    def test_zero_trust_data_graceful_absence(self) -> None:
        """TST-INT-716: AppView returns empty for product query -> Brain
        assembles response.  Response uses web search + vault context.
        No 'Trust Network error.'  No hallucinated score.  Brain says
        'No verified reviews in the Trust Network.'

        When the Trust Network has zero attestations the system must
        degrade gracefully: acknowledge the data absence, report no
        confidence, and avoid any error language or fabricated numbers.
        """
        result = assemble_trust_summary([])

        # --- Structural counts must all be zero ---
        assert result["total_reviews"] == 0, (
            "Zero attestations must produce total_reviews == 0"
        )
        assert result["positive_count"] == 0
        assert result["negative_count"] == 0
        assert result["neutral_count"] == 0
        assert result["verified_count"] == 0
        assert result["unverified_count"] == 0

        # --- Confidence must be the lowest tier ---
        assert result["confidence_level"] == "none", (
            "Zero data must yield confidence_level 'none', "
            f"got '{result['confidence_level']}'"
        )

        # --- No conflict when there are no reviews ---
        assert result["has_conflict"] is False, (
            "Zero reviews cannot have a conflict"
        )

        # --- Summary acknowledges absence without error language ---
        summary = result["summary_text"]
        summary_lower = summary.lower()

        # Must communicate absence of data
        assert "no" in summary_lower or "0" in summary, (
            f"Summary must acknowledge data absence (contain 'no' or '0'), "
            f"got: '{summary}'"
        )

        # Must NOT use error/failure language
        for forbidden in ("error", "failed", "unavailable", "broken",
                          "exception", "fault", "crash"):
            assert forbidden not in summary_lower, (
                f"Summary must not contain error language '{forbidden}', "
                f"got: '{summary}'"
            )

        # Must NOT hallucinate a numeric score or percentage
        import re
        assert not re.search(r"\d+\s*/\s*\d+", summary), (
            f"Summary must not contain a score pattern like 'X/Y', "
            f"got: '{summary}'"
        )
        assert not re.search(r"\d+%", summary), (
            f"Summary must not contain a percentage, got: '{summary}'"
        )
        assert not re.search(r"\d+\.\d+\s*stars?", summary_lower), (
            f"Summary must not contain a star rating, got: '{summary}'"
        )

    # --- TST-INT-716 Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0716", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "17", "title": "zero_data_does_not_hallucinate_score"}
    def test_zero_data_does_not_hallucinate_score(self) -> None:
        """TST-INT-716 counter-proof: the zero-data summary must not
        contain any pattern that looks like a score — no 'X/Y', no
        '4.5 stars', no 'score: N', no 'rating: N', no standalone
        numbers that imply a metric."""
        import re

        result = assemble_trust_summary([])
        summary = result["summary_text"]
        summary_lower = summary.lower()

        # No "score: <number>" or "rating: <number>"
        assert not re.search(r"(?:score|rating)\s*[:=]\s*\d", summary_lower), (
            f"Summary must not contain a labeled score, got: '{summary}'"
        )

        # No fraction-style scores (85/100, 4/5, etc.)
        assert not re.search(r"\d+\s*/\s*\d+", summary), (
            f"Summary must not contain fraction scores, got: '{summary}'"
        )

        # No star ratings (4.5 stars, 3 star, etc.)
        assert not re.search(r"\d+(?:\.\d+)?\s*stars?", summary_lower), (
            f"Summary must not contain star ratings, got: '{summary}'"
        )

        # No percentages
        assert not re.search(r"\d+%", summary), (
            f"Summary must not contain percentages, got: '{summary}'"
        )

        # No "trusted" or "recommended" claims — no data to support them
        assert "trusted" not in summary_lower, (
            f"Cannot claim 'trusted' with zero data, got: '{summary}'"
        )
        assert "recommended" not in summary_lower, (
            f"Cannot claim 'recommended' with zero data, got: '{summary}'"
        )

    # TRACE: {"suite": "INT", "case": "0233", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "18", "title": "zero_data_does_not_claim_consensus"}
    def test_zero_data_does_not_claim_consensus(self) -> None:
        """TST-INT-716 counter-proof: with zero reviews, the summary
        must not claim any form of agreement or community sentiment."""
        result = assemble_trust_summary([])
        summary_lower = result["summary_text"].lower()

        for word in ("consensus", "agreement", "most", "many",
                     "recommend", "majority", "popular", "preferred"):
            assert word not in summary_lower, (
                f"Zero-data summary must not claim '{word}' — "
                f"got: '{result['summary_text']}'"
            )

    # TRACE: {"suite": "INT", "case": "0234", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "19", "title": "zero_data_with_outcomes_still_no_reviews"}
    def test_zero_data_with_outcomes_still_no_reviews(self) -> None:
        """TST-INT-716 counter-proof: passing outcome reports alongside
        empty attestations must still yield total_reviews == 0.
        Outcomes are purchase results, not expert reviews — the system
        must not conflate them."""
        outcomes = [
            OutcomeReport(
                reporter_trust_ring=TrustRing.RING_2_VERIFIED,
                reporter_age_days=365,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                purchase_verified=True,
                time_since_purchase_days=90,
                outcome="still_using",
                satisfaction="positive",
                issues=[],
            ),
            OutcomeReport(
                reporter_trust_ring=TrustRing.RING_2_VERIFIED,
                reporter_age_days=180,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                purchase_verified=True,
                time_since_purchase_days=30,
                outcome="returned",
                satisfaction="negative",
                issues=["thermal throttling"],
            ),
        ]

        result = assemble_trust_summary([], outcomes=outcomes)

        # Outcomes must NOT inflate review counts
        assert result["total_reviews"] == 0, (
            "Outcomes are not reviews — total_reviews must stay 0"
        )
        assert result["positive_count"] == 0
        assert result["negative_count"] == 0
        assert result["confidence_level"] == "none", (
            "Zero attestations with only outcomes must still yield "
            f"confidence 'none', got '{result['confidence_level']}'"
        )
        assert result["has_conflict"] is False

    # --- TST-INT-716 Edge cases ---

    # TRACE: {"suite": "INT", "case": "0716", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "20", "title": "zero_data_result_is_complete_dict"}
    def test_zero_data_result_is_complete_dict(self) -> None:
        """TST-INT-716 edge case: the result dictionary from zero
        attestations must contain every expected key — no KeyError
        when a consumer accesses any standard field."""
        result = assemble_trust_summary([])

        expected_keys = {
            "total_reviews",
            "positive_count",
            "negative_count",
            "neutral_count",
            "confidence_level",
            "summary_text",
            "has_conflict",
            "verified_count",
            "unverified_count",
        }

        missing = expected_keys - set(result.keys())
        assert not missing, (
            f"Zero-data result is missing keys: {missing}"
        )

        # Every value must be a concrete type (not None unless by design)
        assert isinstance(result["total_reviews"], int)
        assert isinstance(result["positive_count"], int)
        assert isinstance(result["negative_count"], int)
        assert isinstance(result["neutral_count"], int)
        assert isinstance(result["confidence_level"], str)
        assert isinstance(result["summary_text"], str)
        assert isinstance(result["has_conflict"], bool)
        assert isinstance(result["verified_count"], int)
        assert isinstance(result["unverified_count"], int)

        # summary_text must not be empty — the system should always say something
        assert len(result["summary_text"]) > 0, (
            "summary_text must not be empty even with zero data"
        )

    # TRACE: {"suite": "INT", "case": "0235", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "21", "title": "none_attestations_handled_or_empty_equivalent"}
    def test_none_attestations_handled_or_empty_equivalent(self) -> None:
        """TST-INT-716 edge case: verify that the function either
        handles None attestations gracefully (treating as empty) or
        that callers are expected to pass an empty list.

        This test documents the contract: if None is valid input, the
        result must match the empty-list result exactly.  If None is
        not valid, a TypeError is acceptable (caller's responsibility).
        """
        try:
            result = assemble_trust_summary(None)  # type: ignore[arg-type]
        except TypeError:
            # The function requires a list — None is not accepted.
            # This is a valid contract: callers must pass [].
            return

        # If we get here, None was accepted — result must match empty list
        empty_result = assemble_trust_summary([])
        assert result["total_reviews"] == empty_result["total_reviews"] == 0
        assert result["confidence_level"] == empty_result["confidence_level"] == "none"
        assert result["has_conflict"] == empty_result["has_conflict"] is False

    # ------------------------------------------------------------------
    # TST-INT-722  Reviews + no outcomes
    # ------------------------------------------------------------------

    def _make_positive_attestations(self, count: int) -> list[ExpertAttestation]:
        """Helper: create *count* positive verified attestations."""
        return [
            ExpertAttestation(
                expert_did=f"did:plc:Reviewer722_{i:03d}_{'0' * 24}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                rating=85,
                verdict={
                    "summary": f"Reviewer {i} recommends",
                    "pros": ["keyboard", "display"],
                    "cons": [],
                },
                source_url=f"https://example.com/review/{i}",
                deep_link=f"https://example.com/review/{i}#details",
                deep_link_context="Full review",
                creator_name=f"Reviewer {i}",
            )
            for i in range(count)
        ]

    def _make_outcomes(self, count: int) -> list[OutcomeReport]:
        """Helper: create *count* positive verified purchase outcomes."""
        return [
            OutcomeReport(
                reporter_trust_ring=TrustRing.RING_2_VERIFIED,
                reporter_age_days=365,
                product_category="laptops",
                product_id="thinkpad_x1_2026",
                purchase_verified=True,
                time_since_purchase_days=90 + i * 30,
                outcome="still_using",
                satisfaction="positive",
                issues=[],
            )
            for i in range(count)
        ]

    # --- Primary test (TST-INT-722) ---

    # TRACE: {"suite": "INT", "case": "0722", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "22", "title": "reviews_with_no_outcomes_discloses_gap"}
    def test_reviews_with_no_outcomes_discloses_gap(self) -> None:
        """TST-INT-722: Attestations present, zero outcome records.
        Brain must note: 'Reviews available but no verified purchase
        outcomes — long-term satisfaction unknown'."""
        attestations = self._make_positive_attestations(5)

        result = assemble_trust_summary_with_outcomes(
            attestations, outcomes=[],
        )

        # 1. Reviews are counted correctly
        assert result["total_reviews"] == 5, (
            f"Expected 5 reviews, got {result['total_reviews']}"
        )

        # 2. Outcome count is zero
        assert result["outcome_count"] == 0, (
            f"Expected 0 outcomes, got {result['outcome_count']}"
        )

        # 3. Outcome gap is flagged
        assert result["has_outcome_gap"] is True, (
            "Reviews exist with no outcomes — has_outcome_gap must be True"
        )

        # 4. Disclosure mentions absence of outcomes
        disclosure = result["outcome_disclosure"].lower()
        assert "no" in disclosure or "zero" in disclosure or "without" in disclosure, (
            f"Outcome disclosure must indicate absence of outcomes, "
            f"got: '{result['outcome_disclosure']}'"
        )

        # 5. Disclosure mentions long-term impact
        assert any(
            term in disclosure
            for term in ("long-term", "satisfaction", "purchase")
        ), (
            f"Outcome disclosure must mention long-term satisfaction or "
            f"purchase impact, got: '{result['outcome_disclosure']}'"
        )

        # 6. Disclosure is NOT an error message
        assert "error" not in disclosure, (
            "Outcome disclosure must not be an error message"
        )
        assert "unavailable" not in disclosure, (
            "Outcome disclosure must not use 'unavailable' — it is a "
            "disclosure, not a service-down notice"
        )

        # 7. Review summary is still complete (reviews not discarded)
        assert result["positive_count"] == 5, (
            "All 5 positive reviews must still be counted"
        )
        assert len(result["summary_text"]) > 0, (
            "Summary text must still be present despite outcome gap"
        )

        # 8. Confidence reflects reviews only — not inflated by missing data
        assert result["confidence_level"] == "moderate", (
            f"5 reviews should yield 'moderate' confidence, "
            f"got '{result['confidence_level']}'"
        )

    # --- Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0236", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "23", "title": "reviews_with_outcomes_no_gap"}
    def test_reviews_with_outcomes_no_gap(self) -> None:
        """TST-INT-722 counter-proof: when both attestations and outcomes
        are present, has_outcome_gap must be False — no spurious
        disclosure about missing data."""
        attestations = self._make_positive_attestations(5)
        outcomes = self._make_outcomes(3)

        result = assemble_trust_summary_with_outcomes(
            attestations, outcomes=outcomes,
        )

        assert result["total_reviews"] == 5
        assert result["outcome_count"] == 3
        assert result["has_outcome_gap"] is False, (
            "Both reviews and outcomes present — has_outcome_gap must be False"
        )
        # Disclosure should reference available outcomes, not a gap
        disclosure_lower = result["outcome_disclosure"].lower()
        assert "long-term satisfaction unknown" not in disclosure_lower, (
            "Gap language must not appear when outcomes are present"
        )

    # TRACE: {"suite": "INT", "case": "0237", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "24", "title": "no_reviews_no_outcomes_no_gap"}
    def test_no_reviews_no_outcomes_no_gap(self) -> None:
        """TST-INT-722 counter-proof: zero attestations AND zero outcomes
        means there is no outcome gap — the concept only applies when
        reviews exist to compare against."""
        result = assemble_trust_summary_with_outcomes([], outcomes=[])

        assert result["total_reviews"] == 0
        assert result["outcome_count"] == 0
        assert result["has_outcome_gap"] is False, (
            "No reviews means no outcome gap — gap requires reviews"
        )
        assert result["outcome_disclosure"] == "", (
            "With zero reviews and zero outcomes, outcome_disclosure "
            f"should be empty, got: '{result['outcome_disclosure']}'"
        )
        assert result["confidence_level"] == "none", (
            "Zero data must yield 'none' confidence"
        )

    # TRACE: {"suite": "INT", "case": "0238", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "25", "title": "outcome_presence_does_not_inflate_review_count"}
    def test_outcome_presence_does_not_inflate_review_count(self) -> None:
        """TST-INT-722 counter-proof: outcome reports are purchase data,
        not expert reviews.  Adding outcomes must never inflate
        total_reviews."""
        attestations = self._make_positive_attestations(5)
        outcomes = self._make_outcomes(3)

        result = assemble_trust_summary_with_outcomes(
            attestations, outcomes=outcomes,
        )

        assert result["total_reviews"] == 5, (
            f"3 outcomes must not inflate total_reviews past 5, "
            f"got {result['total_reviews']}"
        )
        assert result["outcome_count"] == 3, (
            f"outcome_count must reflect actual outcomes, "
            f"got {result['outcome_count']}"
        )
        # Verify positive count is purely from attestations
        assert result["positive_count"] == 5, (
            "positive_count must reflect attestation ratings only"
        )

    # --- Edge cases ---

    # TRACE: {"suite": "INT", "case": "0239", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "26", "title": "single_review_no_outcomes"}
    def test_single_review_no_outcomes(self) -> None:
        """TST-INT-722 edge case: a single attestation with zero outcomes
        must still flag the outcome gap and maintain 'low' confidence."""
        attestations = self._make_positive_attestations(1)

        result = assemble_trust_summary_with_outcomes(
            attestations, outcomes=[],
        )

        assert result["total_reviews"] == 1
        assert result["outcome_count"] == 0
        assert result["has_outcome_gap"] is True, (
            "Even 1 review with 0 outcomes constitutes an outcome gap"
        )
        assert result["confidence_level"] == "low", (
            f"1 review must yield 'low' confidence, "
            f"got '{result['confidence_level']}'"
        )
        # Disclosure must still be present
        assert len(result["outcome_disclosure"]) > 0, (
            "Single-review outcome gap must still produce a disclosure"
        )

    # TRACE: {"suite": "INT", "case": "0240", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "27", "title": "reviews_with_none_outcomes_parameter"}
    def test_reviews_with_none_outcomes_parameter(self) -> None:
        """TST-INT-722 edge case: outcomes=None and outcomes=[] must
        both indicate an outcome gap when reviews exist.  The function
        should not distinguish between 'not provided' and 'empty'."""
        attestations = self._make_positive_attestations(3)

        result_none = assemble_trust_summary_with_outcomes(
            attestations, outcomes=None,
        )
        result_empty = assemble_trust_summary_with_outcomes(
            attestations, outcomes=[],
        )

        # Both must flag the gap
        assert result_none["has_outcome_gap"] is True, (
            "outcomes=None with reviews present must flag outcome gap"
        )
        assert result_empty["has_outcome_gap"] is True, (
            "outcomes=[] with reviews present must flag outcome gap"
        )

        # Both must produce the same disclosure
        assert result_none["outcome_disclosure"] == result_empty["outcome_disclosure"], (
            f"None vs [] should produce identical disclosure; "
            f"None gave: '{result_none['outcome_disclosure']}', "
            f"[] gave: '{result_empty['outcome_disclosure']}'"
        )

        # Both must count outcomes as 0
        assert result_none["outcome_count"] == 0
        assert result_empty["outcome_count"] == 0

    # TRACE: {"suite": "INT", "case": "0241", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "28", "title": "many_reviews_no_outcomes_still_discloses"}
    def test_many_reviews_no_outcomes_still_discloses(self) -> None:
        """TST-INT-722 edge case: 20 reviews with 0 outcomes must still
        disclose the gap.  A large review volume does not compensate for
        absent purchase outcome data."""
        attestations = self._make_positive_attestations(20)

        result = assemble_trust_summary_with_outcomes(
            attestations, outcomes=[],
        )

        assert result["total_reviews"] == 20
        assert result["outcome_count"] == 0
        assert result["has_outcome_gap"] is True, (
            "20 reviews with 0 outcomes must still flag outcome gap — "
            "volume of reviews does not substitute for outcome data"
        )
        assert result["confidence_level"] == "high", (
            f"20 reviews should yield 'high' confidence (for reviews), "
            f"got '{result['confidence_level']}'"
        )
        # Disclosure is still mandatory
        disclosure_lower = result["outcome_disclosure"].lower()
        assert "long-term" in disclosure_lower or "satisfaction" in disclosure_lower, (
            f"Even with 20 reviews, missing outcomes must still be "
            f"disclosed, got: '{result['outcome_disclosure']}'"
        )

    # ------------------------------------------------------------------
    # TST-INT-721  Mixed ring levels: weighting visible
    # ------------------------------------------------------------------

    # TST-INT-721
    # TRACE: {"suite": "INT", "case": "0721", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "29", "title": "mixed_ring_levels_weighting_visible"}
    def test_mixed_ring_levels_weighting_visible(self) -> None:
        """TST-INT-721: 5 Ring 1 (unverified) positive + 3 Ring 2 (verified)
        negative.  Response clearly weights verified higher:
        'Verified reviewers caution against it; unverified reviews are more
        positive' — ring affects narrative.

        The system must separate verified and unverified groups, detect the
        disagreement, and produce a summary where the ring-based weighting
        is explicitly visible.
        """
        attestations = [
            # --- 5 Ring 1 (unverified) positive attestations ---
            ExpertAttestation(
                expert_did="did:plc:UnverPos1_0000000000000000000",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=85,
                verdict={
                    "summary": "Great sound for the price",
                    "pros": ["sound quality", "comfort"],
                    "cons": ["plastic build"],
                },
                source_url="https://forums.example/headphones-review-1",
                creator_name="ForumUser1",
            ),
            ExpertAttestation(
                expert_did="did:plc:UnverPos2_0000000000000000000",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=78,
                verdict={
                    "summary": "Solid wireless headphones",
                    "pros": ["battery life", "noise cancellation"],
                    "cons": ["mic quality"],
                },
                source_url="https://forums.example/headphones-review-2",
                creator_name="ForumUser2",
            ),
            ExpertAttestation(
                expert_did="did:plc:UnverPos3_0000000000000000000",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=90,
                verdict={
                    "summary": "Best headphones I've owned",
                    "pros": ["everything"],
                    "cons": ["case is bulky"],
                },
                source_url="https://forums.example/headphones-review-3",
                creator_name="ForumUser3",
            ),
            ExpertAttestation(
                expert_did="did:plc:UnverPos4_0000000000000000000",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=75,
                verdict={
                    "summary": "Good value, decent audio",
                    "pros": ["value", "comfort"],
                    "cons": ["treble slightly harsh"],
                },
                source_url="https://forums.example/headphones-review-4",
                creator_name="ForumUser4",
            ),
            ExpertAttestation(
                expert_did="did:plc:UnverPos5_0000000000000000000",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=82,
                verdict={
                    "summary": "Surprisingly good for the price point",
                    "pros": ["price-to-performance", "ANC"],
                    "cons": ["no aptX"],
                },
                source_url="https://forums.example/headphones-review-5",
                creator_name="ForumUser5",
            ),
            # --- 3 Ring 2 (verified) negative attestations ---
            ExpertAttestation(
                expert_did="did:plc:VerNeg1_00000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=15,
                verdict={
                    "summary": "Terrible driver quality, breaks within months",
                    "pros": ["looks nice"],
                    "cons": ["durability", "driver failure", "warranty issues"],
                },
                source_url="https://audiophile.example/wireless-pro-problems",
                deep_link="https://audiophile.example/wireless-pro-problems#drivers",
                deep_link_context="Driver failure analysis",
                creator_name="AudioExpert1",
            ),
            ExpertAttestation(
                expert_did="did:plc:VerNeg2_00000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=22,
                verdict={
                    "summary": "Misleading specs, actual ANC performance is poor",
                    "pros": ["battery life acceptable"],
                    "cons": ["ANC underperforms", "frequency response issues"],
                },
                source_url="https://audiophile.example/wireless-pro-anc-test",
                deep_link="https://audiophile.example/wireless-pro-anc-test#measurements",
                deep_link_context="ANC measurement data",
                creator_name="AudioExpert2",
            ),
            ExpertAttestation(
                expert_did="did:plc:VerNeg3_00000000000000000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="headphones",
                product_id="wireless_pro_2026",
                rating=10,
                verdict={
                    "summary": "Do not buy — known defect rate over 30%",
                    "pros": [],
                    "cons": ["defect rate", "quality control", "misleading marketing"],
                },
                source_url="https://audiophile.example/wireless-pro-defect-report",
                deep_link="https://audiophile.example/wireless-pro-defect-report#data",
                deep_link_context="Defect rate statistical analysis",
                creator_name="AudioExpert3",
            ),
        ]

        result = assemble_ring_weighted_summary(attestations)

        # 1. Ring conflict detected — verified negative vs unverified positive
        assert result["ring_conflict"] is True, (
            "Verified-negative vs unverified-positive must trigger ring_conflict"
        )

        # 2. Verified sentiment is negative
        assert result["verified_sentiment"] == "negative", (
            f"All 3 verified reviews are negative (ratings 10-22), "
            f"expected 'negative', got '{result['verified_sentiment']}'"
        )

        # 3. Unverified sentiment is positive
        assert result["unverified_sentiment"] == "positive", (
            f"All 5 unverified reviews are positive (ratings 75-90), "
            f"expected 'positive', got '{result['unverified_sentiment']}'"
        )

        # 4. Correct counts
        assert result["verified_count"] == 3, (
            f"Expected 3 verified, got {result['verified_count']}"
        )
        assert result["unverified_count"] == 5, (
            f"Expected 5 unverified, got {result['unverified_count']}"
        )

        # 5. Summary text mentions both "verified" and "unverified"
        summary = result["summary_text"]
        summary_lower = summary.lower()
        assert "verified" in summary_lower, (
            f"Summary must mention 'verified' reviewers, got: '{summary}'"
        )
        assert "unverified" in summary_lower, (
            f"Summary must mention 'unverified' reviewers, got: '{summary}'"
        )

        # 6. Summary indicates verified reviewers caution/warn
        assert (
            "caution" in summary_lower or "warn" in summary_lower
            or "against" in summary_lower
        ), (
            f"Summary must indicate verified reviewers caution/warn, "
            f"got: '{summary}'"
        )

        # 7. Summary indicates unverified reviews are positive
        assert "positive" in summary_lower or "recommend" in summary_lower, (
            f"Summary must indicate unverified reviews are positive, "
            f"got: '{summary}'"
        )

        # 8. Weighting is visible — ring distinction is explicit in narrative
        assert result["weighting_visible"] is True, (
            "weighting_visible must be True when ring groups disagree"
        )

        # 9. Summary indicates verified sources carry more weight
        assert (
            "weighted" in summary_lower or "weight" in summary_lower
        ), (
            f"Summary must indicate verified sources are weighted higher, "
            f"got: '{summary}'"
        )

        # --- Counter-proof: summary does NOT treat all 8 equally ---
        # A ring-unaware summary would say something like
        # "5 recommend, 3 caution" without ring context.
        # The ring-weighted summary must NOT flatten the groups.
        import re
        flat_pattern = re.compile(
            r"5\s+recommend.*3\s+caution|"
            r"3\s+caution.*5\s+recommend",
            re.IGNORECASE,
        )
        assert not flat_pattern.search(summary), (
            f"Summary must NOT flatten ring groups into '5 recommend, "
            f"3 caution' without ring context — got: '{summary}'"
        )

    # --- TST-INT-721 Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0721", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "30", "title": "all_same_ring_no_weighting_distinction"}
    def test_all_same_ring_no_weighting_distinction(self) -> None:
        """TST-INT-721 counter-proof: when all reviews come from the same
        ring (Ring 2), there is no ring conflict and weighting distinction
        is not needed in the narrative."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:SameRingReviewer{i:020d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="tablets",
                product_id="pro_tablet_2026",
                rating=rating,
                verdict={
                    "summary": f"Reviewer {i} assessment",
                    "pros": ["display"],
                    "cons": ["price"],
                },
                source_url=f"https://tabletreviews.example/review-{i}",
                creator_name=f"TabletReviewer{i}",
            )
            for i, rating in enumerate([88, 15, 92, 20, 85], start=1)
        ]

        result = assemble_ring_weighted_summary(attestations)

        # No ring conflict — all reviews from same ring
        assert result["ring_conflict"] is False, (
            "All reviews from Ring 2 — no ring conflict possible"
        )
        assert result["unverified_count"] == 0
        assert result["verified_count"] == 5

        # Weighting distinction is not needed when only one ring is present
        # (There's nothing to weight against)
        assert result["weighting_visible"] is False, (
            "weighting_visible must be False when all reviews are same ring"
        )

    # TRACE: {"suite": "INT", "case": "0242", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "31", "title": "both_rings_agree_positive"}
    def test_both_rings_agree_positive(self) -> None:
        """TST-INT-721 counter-proof: 3 Ring 1 positive + 3 Ring 2 positive
        means both groups agree — no ring conflict."""
        attestations = [
            # Ring 1 positive
            ExpertAttestation(
                expert_did=f"did:plc:AgreeUnver{i:024d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="monitors",
                product_id="ultrawide_2026",
                rating=rating,
                verdict={
                    "summary": f"Unverified reviewer {i} likes it",
                    "pros": ["picture quality"],
                    "cons": ["stand"],
                },
                source_url=f"https://forums.example/monitor-{i}",
                creator_name=f"ForumMonitor{i}",
            )
            for i, rating in enumerate([78, 82, 85], start=1)
        ] + [
            # Ring 2 positive
            ExpertAttestation(
                expert_did=f"did:plc:AgreeVerif{i:024d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="monitors",
                product_id="ultrawide_2026",
                rating=rating,
                verdict={
                    "summary": f"Verified reviewer {i} recommends",
                    "pros": ["color accuracy", "resolution"],
                    "cons": ["power consumption"],
                },
                source_url=f"https://displays.example/ultrawide-{i}",
                creator_name=f"DisplayExpert{i}",
            )
            for i, rating in enumerate([90, 88, 75], start=1)
        ]

        result = assemble_ring_weighted_summary(attestations)

        assert result["ring_conflict"] is False, (
            "Both ring groups are positive — no ring conflict"
        )
        assert result["verified_sentiment"] == "positive"
        assert result["unverified_sentiment"] == "positive"
        assert result["verified_count"] == 3
        assert result["unverified_count"] == 3

    # TRACE: {"suite": "INT", "case": "0243", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "32", "title": "verified_positive_unverified_negative"}
    def test_verified_positive_unverified_negative(self) -> None:
        """TST-INT-721 counter-proof: reverse scenario — verified positive,
        unverified negative.  Summary must still weight verified higher,
        presenting the positive verified view prominently."""
        attestations = [
            # Ring 1 negative
            ExpertAttestation(
                expert_did=f"did:plc:RevUnverNeg{i:023d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="speakers",
                product_id="bookshelf_speaker_2026",
                rating=rating,
                verdict={
                    "summary": f"Unverified reviewer {i} disappointed",
                    "pros": ["looks"],
                    "cons": ["sound", "distortion"],
                },
                source_url=f"https://forums.example/speaker-neg-{i}",
                creator_name=f"ForumSpeaker{i}",
            )
            for i, rating in enumerate([18, 12, 25, 20], start=1)
        ] + [
            # Ring 2 positive
            ExpertAttestation(
                expert_did=f"did:plc:RevVerPos{i:024d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="speakers",
                product_id="bookshelf_speaker_2026",
                rating=rating,
                verdict={
                    "summary": f"Verified reviewer {i} impressed",
                    "pros": ["clarity", "soundstage"],
                    "cons": ["needs amp"],
                },
                source_url=f"https://audiophile.example/bookshelf-{i}",
                creator_name=f"AudioVerified{i}",
            )
            for i, rating in enumerate([88, 92], start=1)
        ]

        result = assemble_ring_weighted_summary(attestations)

        # Ring conflict: verified positive vs unverified negative
        assert result["ring_conflict"] is True, (
            "Verified positive vs unverified negative must trigger ring_conflict"
        )
        assert result["verified_sentiment"] == "positive"
        assert result["unverified_sentiment"] == "negative"

        # Summary must still weight verified higher — recommending, not cautioning
        summary_lower = result["summary_text"].lower()
        assert "verified" in summary_lower
        assert "recommend" in summary_lower or "positive" in summary_lower, (
            f"Verified-positive view must be prominently stated, "
            f"got: '{result['summary_text']}'"
        )
        assert result["weighting_visible"] is True

    # TRACE: {"suite": "INT", "case": "0244", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "33", "title": "summary_never_treats_unverified_equal_to_verified"}
    def test_summary_never_treats_unverified_equal_to_verified(self) -> None:
        """TST-INT-721 counter-proof: even when unverified outnumber verified
        5-to-1, the narrative must not give them equal weight.  The summary
        must explicitly mark the ring distinction."""
        attestations = [
            # 10 Ring 1 positive
            ExpertAttestation(
                expert_did=f"did:plc:ManyUnver{i:024d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="keyboards",
                product_id="gaming_keyboard_2026",
                rating=80 + i,
                verdict={
                    "summary": f"Unverified reviewer {i} loves it",
                    "pros": ["switches", "RGB"],
                    "cons": ["software"],
                },
                source_url=f"https://forums.example/keyboard-{i}",
                creator_name=f"GamerUser{i}",
            )
            for i in range(1, 11)
        ] + [
            # 2 Ring 2 negative
            ExpertAttestation(
                expert_did=f"did:plc:FewVerNeg{i:024d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="gaming_keyboard_2026",
                rating=rating,
                verdict={
                    "summary": f"Verified reviewer {i} found key chatter issues",
                    "pros": ["aesthetics"],
                    "cons": ["key chatter", "QC problems"],
                },
                source_url=f"https://keyboards.example/gaming-kb-issues-{i}",
                creator_name=f"KBExpert{i}",
            )
            for i, rating in enumerate([18, 22], start=1)
        ]

        result = assemble_ring_weighted_summary(attestations)

        assert result["ring_conflict"] is True
        assert result["verified_count"] == 2
        assert result["unverified_count"] == 10

        summary_lower = result["summary_text"].lower()

        # The narrative must NOT present a flat "10 recommend, 2 caution"
        # without ring context — that would treat unverified equal to verified
        assert "verified" in summary_lower and "unverified" in summary_lower, (
            f"Summary must distinguish verified from unverified, "
            f"got: '{result['summary_text']}'"
        )
        assert result["weighting_visible"] is True, (
            "With 10 unverified vs 2 verified disagreeing, "
            "weighting must be visible"
        )

    # --- TST-INT-721 Edge cases ---

    # TRACE: {"suite": "INT", "case": "0721", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "34", "title": "single_verified_vs_many_unverified"}
    def test_single_verified_vs_many_unverified(self) -> None:
        """TST-INT-721 edge case: 1 Ring 2 negative vs 10 Ring 1 positive.
        Even a single verified reviewer must be prominently mentioned when
        it disagrees with 10 unverified reviewers."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:TenUnverEdge{i:022d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="smartwatches",
                product_id="fitness_watch_2026",
                rating=75 + i,
                verdict={
                    "summary": f"Unverified reviewer {i} happy",
                    "pros": ["fitness tracking"],
                    "cons": ["app ecosystem"],
                },
                source_url=f"https://forums.example/watch-{i}",
                creator_name=f"WatchFan{i}",
            )
            for i in range(1, 11)
        ] + [
            ExpertAttestation(
                expert_did="did:plc:SingleVerNegEdge00000000000",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="smartwatches",
                product_id="fitness_watch_2026",
                rating=12,
                verdict={
                    "summary": "Heart rate sensor dangerously inaccurate",
                    "pros": ["battery life"],
                    "cons": ["HR accuracy", "medical safety concern"],
                },
                source_url="https://wearabletech.example/fitness-watch-hr-problems",
                deep_link="https://wearabletech.example/fitness-watch-hr-problems#data",
                deep_link_context="Heart rate accuracy test data",
                creator_name="WearableExpert",
            ),
        ]

        result = assemble_ring_weighted_summary(attestations)

        # Ring conflict must be detected even with just 1 verified
        assert result["ring_conflict"] is True, (
            "1 verified negative vs 10 unverified positive must be a conflict"
        )
        assert result["verified_count"] == 1
        assert result["unverified_count"] == 10
        assert result["verified_sentiment"] == "negative"
        assert result["unverified_sentiment"] == "positive"

        # The single verified reviewer must be mentioned
        summary_lower = result["summary_text"].lower()
        assert "verified" in summary_lower, (
            f"Even 1 verified reviewer must be mentioned, "
            f"got: '{result['summary_text']}'"
        )
        assert result["weighting_visible"] is True, (
            "1 verified vs 10 unverified disagreeing — weighting must be visible"
        )

        # The verified caution must not be drowned out by the numbers
        assert (
            "caution" in summary_lower or "against" in summary_lower
            or "warn" in summary_lower
        ), (
            f"Verified negative must not be drowned out by unverified positives, "
            f"got: '{result['summary_text']}'"
        )

    # TRACE: {"suite": "INT", "case": "0245", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "35", "title": "all_unverified_no_verified_section"}
    def test_all_unverified_no_verified_section(self) -> None:
        """TST-INT-721 edge case: only Ring 1 attestations.  Summary notes
        all are unverified.  Must NOT falsely claim any 'verified' reviewers."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:AllUnverEdge{i:023d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="mice",
                product_id="wireless_mouse_2026",
                rating=rating,
                verdict={
                    "summary": f"Unverified reviewer {i} opinion",
                    "pros": ["wireless"],
                    "cons": ["battery"],
                },
                source_url=f"https://forums.example/mouse-{i}",
                creator_name=f"MouseUser{i}",
            )
            for i, rating in enumerate([80, 72, 88, 76], start=1)
        ]

        result = assemble_ring_weighted_summary(attestations)

        assert result["verified_count"] == 0
        assert result["unverified_count"] == 4
        assert result["ring_conflict"] is False, (
            "No verified reviews means no ring conflict possible"
        )

        summary = result["summary_text"]
        summary_lower = summary.lower()

        # Must note all are unverified
        assert "unverified" in summary_lower, (
            f"Summary must note all sources are unverified, got: '{summary}'"
        )

        # Must NOT claim any verified reviews exist
        # (Remove "unverified" to check for standalone "verified" claims)
        summary_without_unverified = summary_lower.replace("unverified", "")
        assert "verified reviewer" not in summary_without_unverified, (
            f"Summary must NOT claim verified reviewers exist when there "
            f"are none, got: '{summary}'"
        )
        assert "verified source" not in summary_without_unverified, (
            f"Summary must NOT claim verified sources when there are none, "
            f"got: '{summary}'"
        )

        # weighting_visible should be False — nothing to weight against
        assert result["weighting_visible"] is False, (
            "weighting_visible must be False when only unverified exist"
        )

    # ------------------------------------------------------------------
    # TST-INT-720  Stale reviews: recency disclosure
    # ------------------------------------------------------------------

    def _make_stale_attestations(
        self,
        count: int,
        age_days_min: int,
        age_days_max: int,
        now: float,
    ) -> list[ExpertAttestation]:
        """Helper: create *count* verified positive attestations with
        timestamps spread between *age_days_min* and *age_days_max* days
        before *now*."""
        step = (
            (age_days_max - age_days_min) / max(count - 1, 1)
            if count > 1
            else 0
        )
        return [
            ExpertAttestation(
                expert_did=f"did:plc:StaleReviewer720_{i:03d}_{'0' * 21}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="stale_laptop_2024",
                rating=80,
                verdict={
                    "summary": f"Reviewer {i} liked the laptop",
                    "pros": ["keyboard", "display"],
                    "cons": ["weight"],
                },
                source_url=f"https://example.com/stale-review/{i}",
                creator_name=f"StaleReviewer{i}",
                timestamp=now - (age_days_min + int(step * i)) * 86400,
            )
            for i in range(count)
        ]

    # --- Primary test (TST-INT-720) ---

    # TST-INT-720
    # TRACE: {"suite": "INT", "case": "0720", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "36", "title": "stale_reviews_recency_disclosure"}
    def test_stale_reviews_recency_disclosure(self) -> None:
        """TST-INT-720: 20 reviews, all >365 days old.
        Response includes but flags: 'Reviews are over a year old —
        product may have changed'.

        The system must never silently present stale reviews as if they
        were current.  All 20 reviews remain in the summary (not
        discarded), but a recency disclosure warns the user.
        """
        now = time.time()
        attestations = self._make_stale_attestations(
            count=20, age_days_min=400, age_days_max=500, now=now,
        )

        result = assemble_trust_summary_with_recency(attestations, now=now)

        # 1. All 20 reviews counted — not silently discarded
        assert result["total_reviews"] == 20, (
            f"All 20 stale reviews must be counted, got {result['total_reviews']}"
        )

        # 2. Reviews are included (not dropped)
        assert result["reviews_included"] is True, (
            "Stale reviews must be included, not discarded"
        )

        # 3. All reviews flagged as stale
        assert result["all_stale"] is True, (
            "All reviews are >365 days old — all_stale must be True"
        )

        # 4. Oldest and newest review ages are correct
        assert result["oldest_review_days"] >= 400, (
            f"Oldest review should be >=400 days, got {result['oldest_review_days']}"
        )
        assert result["newest_review_days"] >= 400, (
            f"Newest review should be >=400 days (all stale), "
            f"got {result['newest_review_days']}"
        )
        assert result["oldest_review_days"] > 365, (
            "oldest_review_days must exceed 365 for stale detection"
        )

        # 5. Recency disclosure mentions age and potential change
        disclosure = result["recency_disclosure"]
        disclosure_lower = disclosure.lower()
        assert any(
            term in disclosure_lower
            for term in ("year", "old", "stale")
        ), (
            f"Recency disclosure must mention age (year/old/stale), "
            f"got: '{disclosure}'"
        )
        assert any(
            term in disclosure_lower
            for term in ("may have changed", "outdated", "product")
        ), (
            f"Recency disclosure must note potential product change, "
            f"got: '{disclosure}'"
        )

        # 6. Counter-proof: disclosure does NOT present stale as current
        for forbidden in ("fresh", "recent", "current", "up to date",
                          "up-to-date"):
            assert forbidden not in disclosure_lower, (
                f"Stale disclosure must NOT say '{forbidden}' — "
                f"got: '{disclosure}'"
            )

        # 7. Confidence is NOT inflated by volume of stale data
        assert result["confidence_level"] != "high", (
            "20 stale reviews must NOT produce 'high' confidence — "
            f"got '{result['confidence_level']}'"
        )
        # With 20 reviews, base confidence would be "high" — staleness
        # must cap it lower
        assert result["confidence_level"] in ("moderate", "low"), (
            f"Stale data should cap confidence at 'moderate' or below, "
            f"got '{result['confidence_level']}'"
        )

    # --- TST-INT-720 Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0720", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "37", "title": "fresh_reviews_no_staleness_disclosure"}
    def test_fresh_reviews_no_staleness_disclosure(self) -> None:
        """TST-INT-720 counter-proof: 20 reviews from 30 days ago
        produce no staleness warning.  all_stale must be False and
        recency_disclosure must be empty."""
        now = time.time()
        attestations = self._make_stale_attestations(
            count=20, age_days_min=20, age_days_max=30, now=now,
        )

        result = assemble_trust_summary_with_recency(attestations, now=now)

        assert result["total_reviews"] == 20
        assert result["all_stale"] is False, (
            "All reviews are <365 days old — all_stale must be False"
        )
        assert result["reviews_included"] is True

        # No staleness disclosure for fresh reviews
        assert result["recency_disclosure"] == "", (
            f"Fresh reviews must not produce a staleness disclosure, "
            f"got: '{result['recency_disclosure']}'"
        )

        # Confidence should reflect volume without staleness penalty
        assert result["confidence_level"] == "high", (
            f"20 fresh reviews should yield 'high' confidence, "
            f"got '{result['confidence_level']}'"
        )

        # Newest review age must be well under the threshold
        assert result["newest_review_days"] < 365, (
            f"Newest review is only ~20-30 days old, "
            f"got {result['newest_review_days']} days"
        )

    # TRACE: {"suite": "INT", "case": "0246", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "38", "title": "mixed_fresh_and_stale_reviews"}
    def test_mixed_fresh_and_stale_reviews(self) -> None:
        """TST-INT-720 counter-proof: 10 fresh (30 days) + 10 stale
        (400 days).  all_stale must be False, but recency_disclosure
        must note the mix."""
        now = time.time()
        fresh = [
            ExpertAttestation(
                expert_did=f"did:plc:FreshMixRev720_{i:03d}_{'0' * 21}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="mixed_age_laptop_2025",
                rating=82,
                verdict={
                    "summary": f"Fresh reviewer {i} opinion",
                    "pros": ["performance"],
                    "cons": ["price"],
                },
                source_url=f"https://example.com/fresh-review/{i}",
                creator_name=f"FreshReviewer{i}",
                timestamp=now - 30 * 86400,
            )
            for i in range(10)
        ]
        stale = [
            ExpertAttestation(
                expert_did=f"did:plc:StaleMixRev720_{i:03d}_{'0' * 21}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="mixed_age_laptop_2025",
                rating=78,
                verdict={
                    "summary": f"Stale reviewer {i} opinion",
                    "pros": ["build quality"],
                    "cons": ["battery"],
                },
                source_url=f"https://example.com/stale-review/{i}",
                creator_name=f"StaleReviewer{i}",
                timestamp=now - 400 * 86400,
            )
            for i in range(10)
        ]

        result = assemble_trust_summary_with_recency(fresh + stale, now=now)

        assert result["total_reviews"] == 20
        assert result["all_stale"] is False, (
            "Mix of fresh and stale — all_stale must be False"
        )
        assert result["reviews_included"] is True

        # Disclosure must note the mix — not stay silent
        disclosure = result["recency_disclosure"]
        assert len(disclosure) > 0, (
            "Mixed recency must produce a disclosure, not silence"
        )
        disclosure_lower = disclosure.lower()
        # Should mention both recent and old
        assert any(
            term in disclosure_lower
            for term in ("mix", "recent", "older", "year")
        ), (
            f"Mixed-recency disclosure must reference the age spread, "
            f"got: '{disclosure}'"
        )

        # Must NOT claim all reviews are stale
        assert "all" not in disclosure_lower or "older" not in disclosure_lower, (
            f"Mixed disclosure must not claim ALL reviews are stale, "
            f"got: '{disclosure}'"
        )

    # TRACE: {"suite": "INT", "case": "0247", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "39", "title": "stale_reviews_still_counted"}
    def test_stale_reviews_still_counted(self) -> None:
        """TST-INT-720 counter-proof: stale reviews contribute to
        total_reviews — they are never silently dropped from the count."""
        now = time.time()
        attestations = self._make_stale_attestations(
            count=15, age_days_min=400, age_days_max=500, now=now,
        )

        result = assemble_trust_summary_with_recency(attestations, now=now)

        assert result["total_reviews"] == 15, (
            f"All 15 stale reviews must be counted, got {result['total_reviews']}"
        )
        assert result["positive_count"] == 15, (
            f"All 15 stale reviews are positive (rating=80), "
            f"got {result['positive_count']}"
        )
        assert result["reviews_included"] is True, (
            "Stale reviews must be included, never silently dropped"
        )

    # --- TST-INT-720 Edge cases ---

    # TRACE: {"suite": "INT", "case": "0720", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "40", "title": "exactly_365_days_old_not_stale"}
    def test_exactly_365_days_old_not_stale(self) -> None:
        """TST-INT-720 edge case: reviews exactly 365 days old must NOT
        be flagged as stale.  The threshold is strictly > 365 days."""
        now = time.time()
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:Boundary365Rev_{i:03d}_{'0' * 22}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="boundary_keyboard_2025",
                rating=85,
                verdict={
                    "summary": f"Boundary reviewer {i}",
                    "pros": ["switches"],
                    "cons": ["keycaps"],
                },
                source_url=f"https://example.com/boundary-review/{i}",
                creator_name=f"BoundaryReviewer{i}",
                # Exactly 365 days ago
                timestamp=now - 365 * 86400,
            )
            for i in range(5)
        ]

        result = assemble_trust_summary_with_recency(attestations, now=now)

        assert result["all_stale"] is False, (
            "Reviews exactly 365 days old must NOT be flagged as stale "
            "(threshold is strictly > 365)"
        )
        assert result["recency_disclosure"] == "", (
            f"365-day-old reviews should produce no staleness disclosure, "
            f"got: '{result['recency_disclosure']}'"
        )

    # TRACE: {"suite": "INT", "case": "0248", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "41", "title": "366_days_old_is_stale"}
    def test_366_days_old_is_stale(self) -> None:
        """TST-INT-720 edge case: reviews 366 days old are just past the
        threshold — they must be flagged as stale."""
        now = time.time()
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:Boundary366Rev_{i:03d}_{'0' * 22}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="keyboards",
                product_id="stale_keyboard_2025",
                rating=85,
                verdict={
                    "summary": f"Just-stale reviewer {i}",
                    "pros": ["switches"],
                    "cons": ["keycaps"],
                },
                source_url=f"https://example.com/366-review/{i}",
                creator_name=f"JustStaleReviewer{i}",
                timestamp=now - 366 * 86400,
            )
            for i in range(5)
        ]

        result = assemble_trust_summary_with_recency(attestations, now=now)

        assert result["all_stale"] is True, (
            "Reviews 366 days old (> 365) must be flagged as stale"
        )
        assert result["oldest_review_days"] >= 366, (
            f"oldest_review_days must be >= 366, got {result['oldest_review_days']}"
        )
        disclosure_lower = result["recency_disclosure"].lower()
        assert any(
            term in disclosure_lower
            for term in ("year", "old", "stale")
        ), (
            f"366-day-old reviews must trigger staleness disclosure, "
            f"got: '{result['recency_disclosure']}'"
        )

    # TRACE: {"suite": "INT", "case": "0249", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "42", "title": "single_stale_review"}
    def test_single_stale_review(self) -> None:
        """TST-INT-720 edge case: only 1 review, 400 days old.
        Must be flagged as stale with low confidence AND the staleness
        disclosure."""
        now = time.time()
        attestation = ExpertAttestation(
            expert_did="did:plc:SingleStaleRev720_00000000000000",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="monitors",
            product_id="stale_monitor_2024",
            rating=75,
            verdict={
                "summary": "Decent monitor for its time",
                "pros": ["color accuracy"],
                "cons": ["response time"],
            },
            source_url="https://example.com/single-stale-review",
            creator_name="SingleStaleReviewer",
            timestamp=now - 400 * 86400,
        )

        result = assemble_trust_summary_with_recency(
            [attestation], now=now,
        )

        assert result["total_reviews"] == 1
        assert result["all_stale"] is True, (
            "Single review 400 days old must be flagged as stale"
        )
        assert result["reviews_included"] is True

        # Confidence must be "low" — single review AND stale
        assert result["confidence_level"] == "low", (
            f"Single stale review must yield 'low' confidence, "
            f"got '{result['confidence_level']}'"
        )

        # Disclosure present
        disclosure = result["recency_disclosure"]
        assert len(disclosure) > 0, (
            "Even a single stale review must produce a disclosure"
        )
        disclosure_lower = disclosure.lower()
        assert any(
            term in disclosure_lower for term in ("year", "old", "stale")
        ), (
            f"Single-stale disclosure must mention age, got: '{disclosure}'"
        )

    # TRACE: {"suite": "INT", "case": "0250", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "43", "title": "very_old_reviews_extreme"}
    def test_very_old_reviews_extreme(self) -> None:
        """TST-INT-720 edge case: reviews 1000+ days old must still be
        flagged with appropriate staleness disclosure — age extremity
        does not break the logic."""
        now = time.time()
        attestations = self._make_stale_attestations(
            count=5, age_days_min=1000, age_days_max=1200, now=now,
        )

        result = assemble_trust_summary_with_recency(attestations, now=now)

        assert result["total_reviews"] == 5
        assert result["all_stale"] is True, (
            "1000+ day old reviews must be flagged as stale"
        )
        assert result["reviews_included"] is True
        assert result["oldest_review_days"] >= 1000, (
            f"oldest_review_days must be >= 1000, "
            f"got {result['oldest_review_days']}"
        )

        # Disclosure still works at extreme ages
        disclosure = result["recency_disclosure"]
        assert len(disclosure) > 0, (
            "Very old reviews (1000+ days) must still produce a disclosure"
        )
        disclosure_lower = disclosure.lower()
        assert any(
            term in disclosure_lower for term in ("year", "old", "stale")
        ), (
            f"Extreme-age disclosure must mention staleness, "
            f"got: '{disclosure}'"
        )
        assert any(
            term in disclosure_lower
            for term in ("may have changed", "outdated", "product")
        ), (
            f"Extreme-age disclosure must note potential change, "
            f"got: '{disclosure}'"
        )

    # ------------------------------------------------------------------
    # TST-INT-719  Dense consensus: earned confidence
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0719", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "44", "title": "dense_consensus_earned_confidence"}
    def test_dense_consensus_earned_confidence(self) -> None:
        """TST-INT-719: 50+ reviews with 90%+ agreement.
        Response communicates confidence: 'Strong consensus from 50+
        verified reviewers'.

        Confidence is EARNED through volume + agreement, not fabricated.
        """
        # 48 positive (rating 75-95) + 4 negative (rating 15-25), all Ring 2
        positive_ratings = [
            75, 78, 80, 82, 83, 85, 86, 87, 88, 89,
            90, 91, 92, 93, 94, 95, 76, 77, 79, 81,
            84, 86, 88, 90, 75, 78, 80, 82, 83, 85,
            87, 89, 91, 93, 95, 76, 79, 81, 84, 86,
            88, 90, 92, 94, 77, 80, 83, 85,
        ]
        negative_ratings = [15, 18, 22, 25]

        attestations = []
        for i, rating in enumerate(positive_ratings):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:DensePos{i:028d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="electric_vehicles",
                    product_id="ev_sedan_2026",
                    rating=rating,
                    verdict={
                        "summary": f"Reviewer {i} finds the EV sedan excellent",
                        "pros": ["range", "performance", "software"],
                        "cons": ["charging network"],
                    },
                    source_url=f"https://evreviews.example/sedan-review-{i}",
                    creator_name=f"EVReviewer{i}",
                ),
            )
        for j, rating in enumerate(negative_ratings):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:DenseNeg{j:028d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="electric_vehicles",
                    product_id="ev_sedan_2026",
                    rating=rating,
                    verdict={
                        "summary": f"Negative reviewer {j} found quality issues",
                        "pros": ["design"],
                        "cons": ["build quality", "service", "reliability"],
                    },
                    source_url=f"https://evreviews.example/sedan-negative-{j}",
                    creator_name=f"EVCritic{j}",
                ),
            )

        result = assemble_trust_summary(attestations)
        summary = result["summary_text"]
        summary_lower = summary.lower()

        # 1. Total reviews counted correctly
        assert result["total_reviews"] == 52, (
            f"Expected 52 total reviews, got {result['total_reviews']}"
        )

        # 2. Confidence is "high" — earned through 50+ data volume
        assert result["confidence_level"] == "high", (
            f"52 reviews must yield 'high' confidence, "
            f"got '{result['confidence_level']}'"
        )

        # 3. Correct positive/negative breakdown
        assert result["positive_count"] == 48, (
            f"Expected 48 positive, got {result['positive_count']}"
        )
        assert result["negative_count"] == 4, (
            f"Expected 4 negative, got {result['negative_count']}"
        )

        # 4. Conflict detected — both positive and negative exist
        assert result["has_conflict"] is True, (
            "Must detect conflict when both positive and negative reviews exist"
        )

        # 5. All reviewers are verified (Ring 2)
        assert result["verified_count"] == 52, (
            f"All 52 reviewers are Ring 2, expected 52 verified, "
            f"got {result['verified_count']}"
        )

        # 6. Summary communicates the scale — must mention
        #    the count or a word indicating large volume
        scale_indicators = ("52", "50", "48", "many", "most")
        assert any(ind in summary_lower for ind in scale_indicators), (
            f"Summary must mention the scale of reviews "
            f"(expected one of {scale_indicators}), got: '{summary}'"
        )

        # 7. Summary reflects that the MAJORITY recommend
        majority_indicators = (
            "recommend", "consensus", "most recommend",
            "strong", "majority",
        )
        assert any(ind in summary_lower for ind in majority_indicators), (
            f"Summary must reflect that the majority recommend, "
            f"got: '{summary}'"
        )

        # 8. Summary does NOT claim "unanimous" — 4 negatives exist
        assert "unanimous" not in summary_lower, (
            f"Must not claim 'unanimous' when 4 negative reviews exist, "
            f"got: '{summary}'"
        )

        # 9. Summary does NOT use "all reviewers recommend" phrasing
        assert "all" not in summary_lower or "all recommend" not in summary_lower, (
            f"Must not say 'all reviewers recommend' when negatives exist, "
            f"got: '{summary}'"
        )

        # 10. The negative minority is acknowledged in the summary
        assert "4" in summary or "caution" in summary_lower, (
            f"Summary must acknowledge the 4 negative reviews, "
            f"got: '{summary}'"
        )

    # --- TST-INT-719 Counter-proofs ---

    # TRACE: {"suite": "INT", "case": "0719", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "45", "title": "dense_but_split_no_consensus_language"}
    def test_dense_but_split_no_consensus_language(self) -> None:
        """TST-INT-719 counter-proof: 50 reviews evenly split (26 positive,
        24 negative) must NOT use consensus language.  Confidence is 'high'
        (volume) but the summary must say 'mixed' or 'split'."""
        attestations = []
        for i in range(26):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:SplitPos50_{i:024d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="smart_home",
                    product_id="hub_2026",
                    rating=75 + (i % 20),  # 75-94 range
                    verdict={
                        "summary": f"Positive reviewer {i}",
                        "pros": ["integration", "reliability"],
                        "cons": ["setup complexity"],
                    },
                    source_url=f"https://smarthome.example/hub-pos-{i}",
                    creator_name=f"SmartHomePos{i}",
                ),
            )
        for j in range(24):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:SplitNeg50_{j:024d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="smart_home",
                    product_id="hub_2026",
                    rating=10 + (j % 15),  # 10-24 range
                    verdict={
                        "summary": f"Negative reviewer {j}",
                        "pros": ["concept"],
                        "cons": ["execution", "bugs", "privacy concerns"],
                    },
                    source_url=f"https://smarthome.example/hub-neg-{j}",
                    creator_name=f"SmartHomeNeg{j}",
                ),
            )

        result = assemble_trust_summary(attestations)
        summary_lower = result["summary_text"].lower()

        # Volume gives high confidence
        assert result["total_reviews"] == 50
        assert result["confidence_level"] == "high"

        # But opinion is split — must NOT say consensus
        assert result["has_conflict"] is True
        assert "consensus" not in summary_lower, (
            f"Split opinion (26/24) must NOT claim consensus, "
            f"got: '{result['summary_text']}'"
        )
        assert "unanimous" not in summary_lower, (
            f"Split opinion must NOT claim unanimity, "
            f"got: '{result['summary_text']}'"
        )

        # Must acknowledge the split
        assert "mixed" in summary_lower or "split" in summary_lower, (
            f"Near-even split must say 'mixed' or 'split', "
            f"got: '{result['summary_text']}'"
        )

    # TRACE: {"suite": "INT", "case": "0251", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "46", "title": "few_reviews_cannot_earn_high_confidence"}
    def test_few_reviews_cannot_earn_high_confidence(self) -> None:
        """TST-INT-719 counter-proof: 5 reviews all positive yield
        'moderate' confidence — not enough volume for 'high'.
        Confidence must be earned through data volume."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:FewReviews{i:025d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="fitness_trackers",
                product_id="tracker_2026",
                rating=rating,
                verdict={
                    "summary": f"Reviewer {i} likes the fitness tracker",
                    "pros": ["accuracy", "battery"],
                    "cons": ["strap comfort"],
                },
                source_url=f"https://fitness.example/tracker-review-{i}",
                creator_name=f"FitnessReviewer{i}",
            )
            for i, rating in enumerate([85, 90, 78, 92, 80], start=1)
        ]

        result = assemble_trust_summary(attestations)

        assert result["total_reviews"] == 5
        assert result["positive_count"] == 5
        assert result["negative_count"] == 0

        # 5 reviews = moderate, NOT high
        assert result["confidence_level"] == "moderate", (
            f"5 reviews must yield 'moderate' confidence, "
            f"got '{result['confidence_level']}'"
        )
        assert result["confidence_level"] != "high", (
            "5 reviews must NOT earn 'high' confidence — "
            "insufficient data volume"
        )

    # TRACE: {"suite": "INT", "case": "0252", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "47", "title": "dense_all_unverified_mentions_unverified"}
    def test_dense_all_unverified_mentions_unverified(self) -> None:
        """TST-INT-719 counter-proof: 50 Ring 1 (unverified) reviews that
        are all positive.  Confidence is 'high' for volume but summary
        must note 'unverified' status."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:DenseUnverified{i:022d}",
                expert_trust_ring=TrustRing.RING_1_UNVERIFIED,
                product_category="power_banks",
                product_id="powerbank_2026",
                rating=70 + (i % 25),  # 70-94 range
                verdict={
                    "summary": f"Unverified reviewer {i} likes the power bank",
                    "pros": ["capacity", "portability"],
                    "cons": ["weight"],
                },
                source_url=f"https://forums.example/powerbank-review-{i}",
                creator_name=f"ForumUser{i}",
            )
            for i in range(50)
        ]

        result = assemble_trust_summary(attestations)
        summary_lower = result["summary_text"].lower()

        assert result["total_reviews"] == 50
        assert result["confidence_level"] == "high", (
            f"50 reviews must yield 'high' confidence, "
            f"got '{result['confidence_level']}'"
        )
        assert result["verified_count"] == 0
        assert result["unverified_count"] == 50

        # Must note unverified status in the summary
        assert "unverified" in summary_lower, (
            f"50 unverified reviews must mention 'unverified' in summary, "
            f"got: '{result['summary_text']}'"
        )

        # Must NOT falsely claim "verified sources"
        # (remove occurrences of "unverified" to check for bare "verified")
        without_unverified = summary_lower.replace("unverified", "")
        assert "verified source" not in without_unverified, (
            f"Must not claim 'verified sources' when all are Ring 1, "
            f"got: '{result['summary_text']}'"
        )

    # --- TST-INT-719 Edge cases ---

    # TRACE: {"suite": "INT", "case": "0719", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "48", "title": "exactly_50_reviews_90_percent_agreement"}
    def test_exactly_50_reviews_90_percent_agreement(self) -> None:
        """TST-INT-719 edge case: exactly 50 reviews with exactly 90%
        agreement (45 positive, 5 negative).  Validates the 50+
        threshold boundary for dense consensus."""
        attestations = []
        for i in range(45):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:Edge50Pos{i:025d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="drones",
                    product_id="camera_drone_2026",
                    rating=75 + (i % 20),  # 75-94 range
                    verdict={
                        "summary": f"Positive drone reviewer {i}",
                        "pros": ["camera quality", "stability", "range"],
                        "cons": ["wind resistance"],
                    },
                    source_url=f"https://dronereviews.example/review-pos-{i}",
                    creator_name=f"DroneReviewerPos{i}",
                ),
            )
        for j in range(5):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:Edge50Neg{j:025d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="drones",
                    product_id="camera_drone_2026",
                    rating=15 + (j * 3),  # 15, 18, 21, 24, 27
                    verdict={
                        "summary": f"Negative drone reviewer {j}",
                        "pros": ["portability"],
                        "cons": ["durability", "customer support"],
                    },
                    source_url=f"https://dronereviews.example/review-neg-{j}",
                    creator_name=f"DroneReviewerNeg{j}",
                ),
            )

        result = assemble_trust_summary(attestations)
        summary_lower = result["summary_text"].lower()

        assert result["total_reviews"] == 50
        assert result["confidence_level"] == "high"
        assert result["positive_count"] == 45
        assert result["negative_count"] == 5
        assert result["has_conflict"] is True

        # 45/50 = 90% agreement — meets the dense consensus threshold
        # Summary should reflect the strong majority
        majority_words = ("consensus", "strong", "recommend", "majority")
        assert any(w in summary_lower for w in majority_words), (
            f"90% agreement with 50 reviews should reflect strong majority, "
            f"got: '{result['summary_text']}'"
        )

        # Must NOT claim unanimous
        assert "unanimous" not in summary_lower, (
            f"Must not claim 'unanimous' with 5 negative reviews, "
            f"got: '{result['summary_text']}'"
        )
        assert "all recommend" not in summary_lower, (
            f"Must not say 'all recommend' with 5 negatives, "
            f"got: '{result['summary_text']}'"
        )

    # TRACE: {"suite": "INT", "case": "0253", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "49", "title": "dense_unanimous_positive"}
    def test_dense_unanimous_positive(self) -> None:
        """TST-INT-719 edge case: 60 reviews ALL positive.
        No conflict, summary can say 'consensus' or 'all recommend'."""
        attestations = [
            ExpertAttestation(
                expert_did=f"did:plc:Unanimous60_{i:024d}",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="e_readers",
                product_id="e_reader_2026",
                rating=70 + (i % 25),  # 70-94 range
                verdict={
                    "summary": f"Reviewer {i} highly recommends the e-reader",
                    "pros": ["display", "battery", "weight"],
                    "cons": ["no color"],
                },
                source_url=f"https://ereader.example/review-{i}",
                creator_name=f"EReaderReviewer{i}",
            )
            for i in range(60)
        ]

        result = assemble_trust_summary(attestations)
        summary = result["summary_text"]
        summary_lower = summary.lower()

        assert result["total_reviews"] == 60
        assert result["confidence_level"] == "high"
        assert result["positive_count"] == 60
        assert result["negative_count"] == 0
        assert result["neutral_count"] == 0

        # No conflict — all reviews are positive
        assert result["has_conflict"] is False, (
            "All-positive reviews must not flag conflict"
        )

        # Summary reflects unanimous positive
        assert "consensus" in summary_lower or "all" in summary_lower, (
            f"60 unanimous positive reviews should say 'consensus' or 'all', "
            f"got: '{summary}'"
        )
        assert "60" in summary or "all" in summary_lower, (
            f"Summary should mention the scale (60 or 'all'), "
            f"got: '{summary}'"
        )

        # No conflict language should appear
        assert "mixed" not in summary_lower, (
            f"All-positive reviews must NOT say 'mixed', got: '{summary}'"
        )
        assert "split" not in summary_lower, (
            f"All-positive reviews must NOT say 'split', got: '{summary}'"
        )
        assert "caution" not in summary_lower, (
            f"All-positive reviews must NOT mention 'caution', "
            f"got: '{summary}'"
        )

    # TRACE: {"suite": "INT", "case": "0254", "section": "11", "sectionName": "Trust Network Integration", "subsection": "05", "scenario": "50", "title": "dense_with_neutral_reviews"}
    def test_dense_with_neutral_reviews(self) -> None:
        """TST-INT-719 edge case: 55 reviews — 48 positive, 2 negative,
        5 neutral.  Majority positive, has_conflict True (positive +
        negative coexist), neutral reviews don't affect conflict flag."""
        attestations = []
        # 48 positive
        for i in range(48):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:NeutralMixPos{i:023d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="projectors",
                    product_id="home_projector_2026",
                    rating=75 + (i % 20),  # 75-94
                    verdict={
                        "summary": f"Positive projector reviewer {i}",
                        "pros": ["image quality", "brightness", "connectivity"],
                        "cons": ["fan noise"],
                    },
                    source_url=f"https://projectors.example/review-pos-{i}",
                    creator_name=f"ProjectorReviewerPos{i}",
                ),
            )
        # 2 negative
        for j in range(2):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:NeutralMixNeg{j:023d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="projectors",
                    product_id="home_projector_2026",
                    rating=15 + (j * 10),  # 15, 25
                    verdict={
                        "summary": f"Negative projector reviewer {j}",
                        "pros": ["design"],
                        "cons": ["color accuracy", "lamp life"],
                    },
                    source_url=f"https://projectors.example/review-neg-{j}",
                    creator_name=f"ProjectorReviewerNeg{j}",
                ),
            )
        # 5 neutral
        for k in range(5):
            attestations.append(
                ExpertAttestation(
                    expert_did=f"did:plc:NeutralMixNeu{k:023d}",
                    expert_trust_ring=TrustRing.RING_2_VERIFIED,
                    product_category="projectors",
                    product_id="home_projector_2026",
                    rating=40 + (k * 5),  # 40, 45, 50, 55, 60
                    verdict={
                        "summary": f"Neutral projector reviewer {k}",
                        "pros": ["decent for the price"],
                        "cons": ["nothing exceptional"],
                    },
                    source_url=f"https://projectors.example/review-neutral-{k}",
                    creator_name=f"ProjectorReviewerNeu{k}",
                ),
            )

        result = assemble_trust_summary(attestations)
        summary = result["summary_text"]
        summary_lower = summary.lower()

        # Total and breakdowns
        assert result["total_reviews"] == 55
        assert result["positive_count"] == 48
        assert result["negative_count"] == 2
        assert result["neutral_count"] == 5

        # Conflict is True — positive and negative both present
        assert result["has_conflict"] is True, (
            "Must detect conflict when both positive and negative exist, "
            "even when neutrals are present"
        )

        # Confidence is high (55 reviews)
        assert result["confidence_level"] == "high"

        # 48/55 = 87.3% positive — below 90% threshold, so this is
        # NOT a dense consensus case.  Summary should use "mixed" language
        # because the supermajority threshold is not met.
        # (48 positive + 2 negative + 5 neutral, 48/55 < 0.9)
        assert "unanimous" not in summary_lower, (
            f"Must not claim 'unanimous' with 2 negative + 5 neutral, "
            f"got: '{summary}'"
        )

        # The positive majority should still be reflected
        assert result["positive_count"] > result["negative_count"], (
            "Positive count must exceed negative count"
        )

        # The summary must mention the actual counts so the user
        # can see the breakdown
        assert "48" in summary or "recommend" in summary_lower, (
            f"Summary must mention the positive count or 'recommend', "
            f"got: '{summary}'"
        )
