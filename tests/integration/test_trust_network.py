"""Integration tests for the Trust Network.

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


# ---------------------------------------------------------------------------
# Expert Attestations
# ---------------------------------------------------------------------------


class TestExpertAttestations:
    """YouTube reviews and expert verdicts become signed attestations."""

# TST-INT-297
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
    def test_high_participation_rate_from_verified_users(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Verified users (Ring 2+) contribute more outcomes, making the data reliable."""
        # Simulate 20 outcomes from verified users, 5 from unverified
        for i in range(20):
            mock_trust_network.add_outcome(OutcomeReport(
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
            mock_trust_network.add_outcome(OutcomeReport(
                reporter_trust_ring=TrustRing.RING_1_UNVERIFIED,
                reporter_age_days=10 + i,
                product_category="laptops",
                product_id="thinkpad_x1_2025",
                purchase_verified=False,
                time_since_purchase_days=10,
                outcome="returned",
                satisfaction="negative",
            ))

        total = len(mock_trust_network.outcomes)
        verified = [
            o for o in mock_trust_network.outcomes
            if o.reporter_trust_ring != TrustRing.RING_1_UNVERIFIED
        ]
        assert total == 25
        assert len(verified) == 20
        # 80% participation from verified users
        assert len(verified) / total >= 0.8

# TST-INT-310
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
# Bot Reputation
# ---------------------------------------------------------------------------


class TestBotReputation:
    """Review bots and task agents have tracked, visible reputation scores."""

# TST-INT-314
    def test_reputation_tracked(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Every bot has a reputation score tracked in the graph."""
        mock_trust_network.update_bot_score(mock_review_bot.bot_did, 0)
        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        # Default is 50.0, delta 0 keeps it at 50.0
        assert score == 50.0

        # Record good performance
        mock_trust_network.update_bot_score(mock_review_bot.bot_did, 10)
        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        assert score == 60.0

# TST-INT-536
    def test_compromised_bot_drops_score(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """If a bot is found compromised or gives bad recommendations,
        its reputation score drops sharply."""
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
    def test_auto_routes_to_better_bot(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """Dina auto-routes queries to the highest-reputation bot for a category."""
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

        # If BotB's reputation drops below BotC, routing switches
        mock_trust_network.update_bot_score("did:plc:BotB", -20)
        new_best = max(
            mock_trust_network.bot_scores,
            key=lambda did: mock_trust_network.get_bot_score(did),
        )
        assert new_best == "did:plc:BotC"

# TST-INT-311
    def test_reputation_visible_to_user(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot reputation scores are visible to the user — full transparency."""
        mock_trust_network.bot_scores[mock_review_bot.bot_did] = 94.0

        score = mock_trust_network.get_bot_score(mock_review_bot.bot_did)
        assert score == 94.0

        # User can see all bot scores
        assert mock_review_bot.bot_did in mock_trust_network.bot_scores
        # Score is a simple float, easy to display
        assert isinstance(score, float)
        assert 0.0 <= score <= 100.0

# TST-INT-304
    def test_reputation_score_capped_at_100(
        self, mock_trust_network: MockTrustNetwork
    ) -> None:
        """Reputation score cannot exceed 100.0."""
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
    def test_pds_cannot_forge_records(
        self,
        mock_trust_network: MockTrustNetwork,
        mock_identity: MockIdentity,
    ) -> None:
        """Records are signed by the author's DID key. A PDS operator
        cannot modify a record without invalidating the signature."""
        author_did = mock_identity.root_did
        verdict_data = {
            "product_id": "thinkpad_x1_2025",
            "rating": 92,
            "summary": "Excellent laptop",
        }
        canonical = json.dumps(verdict_data, sort_keys=True).encode()
        signature = mock_identity.sign(canonical)

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

        stored = mock_trust_network.attestations[0]
        # Original signature verifies
        assert mock_identity.verify(canonical, stored.signature)

        # Tampered data does NOT verify with original signature
        tampered_data = dict(verdict_data)
        tampered_data["rating"] = 50
        tampered_canonical = json.dumps(tampered_data, sort_keys=True).encode()
        assert not mock_identity.verify(tampered_canonical, stored.signature)

# TST-INT-301
    def test_bundled_pds_in_docker_compose(
        self,
        mock_compose: MockDockerCompose,
    ) -> None:
        """Type B deployment: PDS runs as a container inside the
        docker-compose stack alongside core and brain."""
        assert "pds" in mock_compose.containers
        pds = mock_compose.containers["pds"]

        # PDS has a health-check on AT Protocol endpoint
        assert pds.healthcheck is not None
        assert "/xrpc/_health" in pds.healthcheck.endpoint

        # Start the stack — PDS starts before core (dependency order)
        mock_compose.up()
        start_order = mock_compose._resolve_start_order()
        assert start_order.index("pds") < start_order.index("core")
        assert pds.running

# TST-INT-302
    def test_external_pds_push(
        self,
        mock_identity: MockIdentity,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """Type A: user pushes reputation records to an external PDS.
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
    def test_custom_lexicon_validation(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Reputation records use custom com.dina.reputation.* lexicons.
        The AppView indexes only matching lexicons."""
        records = [
            {
                "id": "rec_1",
                "lexicon": "com.dina.reputation.review",
                "author_did": "did:plc:Author1",
                "product_id": "laptop_1",
                "rating": 90,
                "signature": "sig_1",
            },
            {
                "id": "rec_2",
                "lexicon": "com.dina.reputation.outcome",
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

        # Only the two com.dina.reputation.* records are indexed
        assert indexed == 2
        assert len(mock_app_view.indexed_records) == 2
        lexicons = {r["lexicon"] for r in mock_app_view.indexed_records}
        assert all(lex.startswith("com.dina.reputation.") for lex in lexicons)

# TST-INT-305
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
    def test_aggregate_scores_computed_not_stored(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Aggregate reputation scores are computed on-the-fly by the
        AppView, never persisted as a separate record."""
        records = [
            {
                "id": f"rec_{i}",
                "lexicon": "com.dina.reputation.review",
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
            r.get("lexicon") != "com.dina.reputation.aggregate"
            for r in mock_app_view.indexed_records
        )
        # Only the 3 individual review records
        assert len(mock_app_view.indexed_records) == 3

# TST-INT-316
    def test_pds_down_records_still_available_via_relay(
        self,
        mock_app_view: MockAppView,
        mock_relay: MockRelay,
    ) -> None:
        """When a PDS is down, records that were already replicated to the
        relay/AppView remain available for queries."""
        # Records were previously replicated to the AppView
        records = [
            {
                "id": "rec_replicated_1",
                "lexicon": "com.dina.reputation.review",
                "author_did": "did:plc:Author1",
                "product_id": "laptop_offline",
                "rating": 88,
                "signature": "sig_replicated",
            },
        ]
        mock_app_view.consume_firehose(records)

        # Simulate PDS going down — relay had already forwarded data
        mock_relay.forward(
            "did:plc:Author1", "did:plc:AppView",
            "encrypted_record_blob_for_laptop_offline",
        )
        pds_is_down = True  # simulated

        # Despite PDS being down, AppView still has the records
        assert pds_is_down
        results = mock_app_view.query_by_product("laptop_offline")
        assert len(results) == 1
        assert results[0]["rating"] == 88

# TST-INT-317
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
    def test_foundation_pds_stores_only_reputation_data(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """The Foundation PDS stores only reputation records (reviews,
        outcomes). No personal data (messages, contacts, health) is stored."""
        records = [
            {
                "id": "rep_1",
                "lexicon": "com.dina.reputation.review",
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

        # Only the reputation record is indexed
        assert indexed == 1
        assert len(mock_app_view.indexed_records) == 1
        assert mock_app_view.indexed_records[0]["lexicon"] == "com.dina.reputation.review"

# TST-INT-319
    def test_relay_crawls_pds_via_delta_sync(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """The relay uses cursor-based delta sync to crawl new records
        from PDS instances incrementally."""
        batch_1 = [
            {
                "id": "rec_1",
                "lexicon": "com.dina.reputation.review",
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
                "lexicon": "com.dina.reputation.review",
                "author_did": "did:plc:Author2",
                "product_id": "phone_2",
                "rating": 78,
                "signature": "sig_2",
            },
            {
                "id": "rec_3",
                "lexicon": "com.dina.reputation.outcome",
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
    def test_discovery_to_pds_federation(
        self,
        mock_identity: MockIdentity,
        mock_plc_resolver: MockPLCResolver,
    ) -> None:
        """DID resolution discovers the PDS endpoint, enabling federation.
        Given a DID, the resolver returns the service endpoint where
        reputation records are stored."""
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
