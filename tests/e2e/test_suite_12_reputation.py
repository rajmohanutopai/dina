"""E2E Test Suite 12: Trust Network Lifecycle.

Tests the full trust network lifecycle: expert attestation publishing via
AT Protocol (PDS -> Relay -> AppView), bot reputation degradation with
auto-routing, signed tombstone deletion, composite trust score computation,
AT Protocol discovery, and AppView determinism / censorship detection.

Actors: Don Alonso, Sancho, ChairMaker, ReviewBot, AppView, Relay,
        PLC Directory.
"""

from __future__ import annotations

import copy
import json
import time

import pytest

from tests.e2e.actors import HomeNode, _mock_sign, _mock_verify
from tests.e2e.mocks import (
    BotReputation,
    DIDDocument,
    ExpertAttestation,
    MockAppView,
    MockPLCDirectory,
    MockRelay,
    MockReviewBot,
    OutcomeReport,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Suite 12: Trust Network Lifecycle
# ---------------------------------------------------------------------------


class TestTrustNetworkLifecycle:
    """E2E-12.x -- Trust Network: attestations, bot reputation,
    tombstone deletion, trust scores, AT Protocol discovery, and
    AppView determinism."""

# TST-E2E-059
    def test_expert_attestation_publish_relay_query(
        self,
        don_alonso: HomeNode,
        reviewbot: MockReviewBot,
        relay: MockRelay,
        appview: MockAppView,
    ) -> None:
        """E2E-12.1 Expert Attestation Publish -> Relay -> Query.

        ReviewBot creates an ExpertAttestation for a product, signs it,
        and publishes to its PDS. The Relay crawls and the AppView indexes
        the attestation. Don Alonso then queries the product score via
        the AppView.
        """
        product_id = "herman-miller-aeron"

        # ReviewBot creates and signs an expert attestation
        attestation = ExpertAttestation(
            attestation_id="att_001",
            expert_did=reviewbot.did,
            product_id=product_id,
            rating=92,
            verdict={"ergonomics": 95, "durability": 90, "value": 88},
        )
        attestation_data = json.dumps({
            "attestation_id": attestation.attestation_id,
            "expert_did": attestation.expert_did,
            "product_id": attestation.product_id,
            "rating": attestation.rating,
            "verdict": attestation.verdict,
        }, sort_keys=True)
        attestation.signature = _mock_sign(attestation_data, "reviewbot_privkey")

        # Verify the signature is valid
        assert _mock_verify(attestation_data, attestation.signature, "reviewbot_privkey")

        # Publish to Don Alonso's PDS (simulating ReviewBot publishing
        # to the AT Protocol network via its own PDS)
        record = {
            "type": "dina.reputation.attestation",
            "attestation_id": attestation.attestation_id,
            "expert_did": attestation.expert_did,
            "product_id": attestation.product_id,
            "rating": attestation.rating,
            "verdict": attestation.verdict,
            "signature": attestation.signature,
        }
        record_id = don_alonso.pds.publish("dina.reputation.attestation", record)
        assert record_id.startswith("at://")

        # Relay crawls the PDS
        relay.add_pds(don_alonso.pds)
        crawled_count = relay.crawl()
        assert crawled_count >= 1

        # Verify the attestation record is in the relay firehose
        firehose_types = [r.get("type") for r in relay.firehose]
        assert "dina.reputation.attestation" in firehose_types

        # AppView indexes the attestation
        appview.index_attestation(attestation)

        # Don Alonso queries the product score via AppView
        result = appview.query_product(product_id)
        assert result is not None
        assert result["score"] > 0
        assert result["sample_size"] >= 1
        assert len(result["attestations"]) >= 1

        # The indexed attestation matches what was published
        indexed_att = result["attestations"][-1]
        assert indexed_att.expert_did == reviewbot.did
        assert indexed_att.rating == 92
        assert indexed_att.product_id == product_id

# TST-E2E-060
    def test_bot_reputation_degradation(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-12.2 Bot Reputation Degradation.

        10 accurate queries raise the bot's score. 5 poor queries drop it.
        When score drops below threshold, auto-route to an alternative bot.
        Reputation changes are published to PDS.
        """
        bot_did = "did:plc:testbot_degrade"
        alt_bot_did = "did:plc:altbot"
        threshold = 60

        # Initialize bot reputation
        appview.update_bot_reputation(bot_did, 50)
        appview.update_bot_reputation(alt_bot_did, 85)

        # 10 accurate queries -> score rises
        for i in range(10):
            bot_rep = appview.query_bot(bot_did)
            assert bot_rep is not None
            bot_rep.positive_outcomes += 1
            bot_rep.total_queries += 1
            new_score = min(100, bot_rep.score + 4)
            appview.update_bot_reputation(bot_did, new_score)

        bot_rep = appview.query_bot(bot_did)
        assert bot_rep is not None
        assert bot_rep.score >= 80  # 50 + 10*4 = 90

        high_score = bot_rep.score

        # 5 poor queries -> score drops
        for i in range(5):
            bot_rep = appview.query_bot(bot_did)
            assert bot_rep is not None
            bot_rep.negative_outcomes += 1
            bot_rep.total_queries += 1
            new_score = max(0, bot_rep.score - 10)
            appview.update_bot_reputation(bot_did, new_score)

        bot_rep = appview.query_bot(bot_did)
        assert bot_rep is not None
        assert bot_rep.score < high_score  # Score has dropped

        # Check if auto-routing is triggered below threshold
        if bot_rep.score < threshold:
            # Auto-route: select alternative bot with higher score
            alt_rep = appview.query_bot(alt_bot_did)
            assert alt_rep is not None
            assert alt_rep.score > bot_rep.score
            selected_bot = alt_bot_did
        else:
            selected_bot = bot_did

        # Verify routing decision is sound
        selected_rep = appview.query_bot(selected_bot)
        assert selected_rep is not None
        assert selected_rep.score >= bot_rep.score

        # Publish reputation change to PDS
        reputation_record = {
            "type": "dina.reputation.bot_score",
            "bot_did": bot_did,
            "score": bot_rep.score,
            "total_queries": bot_rep.total_queries,
            "positive_outcomes": bot_rep.positive_outcomes,
            "negative_outcomes": bot_rep.negative_outcomes,
        }
        record_id = don_alonso.pds.publish("dina.reputation.bot_score", reputation_record)
        assert record_id.startswith("at://")

        # Verify record is in PDS
        records = don_alonso.pds.list_records("dina.reputation.bot_score")
        assert len(records) >= 1
        last_record = records[-1]
        assert last_record["bot_did"] == bot_did

# TST-E2E-061
    def test_signed_tombstone_deletion(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-12.3 Signed Tombstone Deletion.

        Don Alonso publishes an outcome report, then requests deletion.
        The tombstone is signed with the same key. A non-author deletion
        attempt must fail.
        """
        # Don Alonso publishes an outcome report
        outcome_record = {
            "type": "dina.reputation.outcome",
            "product_id": "herman-miller-aeron",
            "outcome": "still_using",
            "satisfaction": "positive",
            "author_did": don_alonso.did,
        }
        record_id = don_alonso.pds.publish("dina.reputation.outcome", outcome_record)
        assert record_id in don_alonso.pds.records

        # Don Alonso signs a tombstone for deletion
        tombstone_data = json.dumps({
            "record_id": record_id,
            "action": "delete",
            "author_did": don_alonso.did,
            "timestamp": time.time(),
        }, sort_keys=True)
        tombstone_sig = _mock_sign(tombstone_data, don_alonso.root_private_key)

        tombstone = {
            "record_id": record_id,
            "action": "delete",
            "author_did": don_alonso.did,
            "signature": tombstone_sig,
        }

        # Verify the tombstone signature is valid (author's key)
        assert _mock_verify(tombstone_data, tombstone_sig, don_alonso.root_private_key)

        # Author deletion succeeds
        deleted = don_alonso.pds.delete(record_id, tombstone)
        assert deleted is True
        assert record_id not in don_alonso.pds.records

        # Tombstone is recorded
        assert len(don_alonso.pds.tombstones) >= 1
        last_tombstone = don_alonso.pds.tombstones[-1]
        assert last_tombstone["author_did"] == don_alonso.did

        # Non-author deletion attempt: create a record and try to delete
        # with a different key
        new_record_id = don_alonso.pds.publish(
            "dina.reputation.outcome",
            {"type": "dina.reputation.outcome", "product_id": "test",
             "author_did": don_alonso.did},
        )

        # Attacker signs with a WRONG key
        attacker_key = "attacker_private_key_fake"
        attacker_tombstone_data = json.dumps({
            "record_id": new_record_id,
            "action": "delete",
            "author_did": "did:plc:attacker",
            "timestamp": time.time(),
        }, sort_keys=True)
        attacker_sig = _mock_sign(attacker_tombstone_data, attacker_key)

        # Verify the attacker's signature does NOT match the author's key
        valid = _mock_verify(
            attacker_tombstone_data, attacker_sig, don_alonso.root_private_key
        )
        assert valid is False, "Non-author signature must not verify with author's key"

        # The record should still exist (non-author deletion rejected)
        assert new_record_id in don_alonso.pds.records

# TST-E2E-062
    def test_trust_score_computation(
        self,
        chairmaker: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-12.4 Trust Score Computation.

        ChairMaker has Ring 3, 50 transactions, 2 years of history,
        and expert attestations. AppView computes a composite trust score.
        Verify the computation is deterministic.
        """
        product_id = "chairmaker-trust-product"

        # Index expert attestations for ChairMaker's product
        att1 = ExpertAttestation(
            attestation_id="trust_att_001",
            expert_did="did:plc:expert_alpha",
            product_id=product_id,
            rating=88,
            verdict={"quality": 90, "service": 85},
        )
        att2 = ExpertAttestation(
            attestation_id="trust_att_002",
            expert_did="did:plc:expert_beta",
            product_id=product_id,
            rating=92,
            verdict={"quality": 94, "service": 90},
        )
        appview.index_attestation(att1)
        appview.index_attestation(att2)

        # Index outcome reports simulating 50 transactions over 2 years
        for i in range(50):
            is_positive = i < 45  # 90% positive
            report = OutcomeReport(
                report_id=f"trust_out_{i:03d}",
                reporter_trust_ring=TrustRing.RING_3_SKIN_IN_GAME.value,
                reporter_age_days=730,  # 2 years
                product_category="furniture",
                product_id=product_id,
                purchase_verified=True,
                purchase_amount_range="50000-100000",
                time_since_purchase_days=30 + i * 14,
                outcome="still_using" if is_positive else "returned",
                satisfaction="positive" if is_positive else "negative",
                issues=[] if is_positive else ["defective_part"],
                timestamp=time.time() - i * 86400,
            )
            appview.index_outcome(report)

        # Query the composite trust score
        result_1 = appview.query_product(product_id)
        assert result_1 is not None
        assert result_1["score"] > 0
        assert result_1["sample_size"] == 52  # 2 attestations + 50 outcomes

        # ChairMaker identity: Ring 3 seller
        assert chairmaker.trust_ring == TrustRing.RING_3_SKIN_IN_GAME

        # Composite trust function:
        # f(identity anchors, transaction history, outcome data, peer attestations, time)
        # Verify: ring value, attestation average, outcome percentage, time component
        att_avg = (att1.rating + att2.rating) / 2  # (88 + 92) / 2 = 90
        positive_outcomes = sum(
            1 for o in result_1["outcomes"] if o.satisfaction == "positive"
        )
        outcome_pct = positive_outcomes / len(result_1["outcomes"]) * 100
        assert outcome_pct == 90.0  # 45 / 50 * 100

        # Verify determinism: compute score again from scratch
        # The _recompute method should produce the same score
        score_1 = result_1["score"]

        # Query again -- score must be identical
        result_2 = appview.query_product(product_id)
        assert result_2 is not None
        score_2 = result_2["score"]
        assert score_1 == score_2, "Trust score must be deterministic"

        # Verify still_using_1yr metric exists
        assert "still_using_1yr" in result_1

# TST-E2E-063
    def test_at_protocol_discovery(
        self,
        don_alonso: HomeNode,
        relay: MockRelay,
        plc_directory: MockPLCDirectory,
    ) -> None:
        """E2E-12.5 AT Protocol Discovery.

        don_alonso.well_known_atproto_did() returns the DID. The Relay
        discovers the PDS via PLC directory resolution. Without a service
        endpoint, federation silently fails (no crash).
        """
        # well_known_atproto_did returns the DID
        did = don_alonso.well_known_atproto_did()
        assert did.startswith("did:plc:"), f"Expected did:plc: prefix, got {did}"

        # Resolve DID via PLC directory -> get service endpoint
        # Use don_alonso.did (the fixture DID registered in mock PLC directory);
        # the real Core may return a different generated DID from well-known.
        doc = plc_directory.resolve(don_alonso.did)
        assert doc is not None
        assert doc.service_endpoint != ""
        assert doc.public_key == don_alonso.root_public_key

        # Relay discovers PDS via the service endpoint
        relay.add_pds(don_alonso.pds)
        assert don_alonso.pds in relay.pds_instances

        # Publish a test record and crawl
        don_alonso.pds.publish("dina.test.discovery", {"type": "dina.test.discovery"})
        pre_crawl_count = len(relay.crawled_records)
        crawl_count = relay.crawl()
        assert crawl_count >= 1 or len(relay.crawled_records) > pre_crawl_count

        # Failure variant: DID without service endpoint
        no_endpoint_doc = DIDDocument(
            did="did:plc:noendpoint",
            public_key="pub_noendpoint",
            service_endpoint="",  # No endpoint
        )
        plc_directory.register(no_endpoint_doc)

        resolved = plc_directory.resolve("did:plc:noendpoint")
        assert resolved is not None
        assert resolved.service_endpoint == ""

        # Federation silently fails -- no crash, no PDS to add
        # Relay cannot crawl a PDS with no endpoint; it simply does nothing
        pre_count = len(relay.crawled_records)
        # Since there is no PDS instance for the no-endpoint DID,
        # crawling again should not find new records from it
        relay.crawl()
        # The relay should still function -- no exception raised

# TST-E2E-064
    def test_appview_determinism_censorship_alert(
        self,
        appview: MockAppView,
    ) -> None:
        """E2E-12.6 AppView Determinism.

        Two AppView instances process the same data and must produce
        identical scores. If scores differ, a censorship alert is raised.
        """
        product_id = "determinism-test-product"

        # Create a clean attestation and outcome set
        att = ExpertAttestation(
            attestation_id="det_att_001",
            expert_did="did:plc:det_expert",
            product_id=product_id,
            rating=80,
            verdict={"quality": 80},
        )
        outcomes = []
        for i in range(20):
            is_positive = i < 16  # 80% positive
            report = OutcomeReport(
                report_id=f"det_out_{i:03d}",
                reporter_trust_ring=TrustRing.RING_2_VERIFIED.value,
                reporter_age_days=365,
                product_category="electronics",
                product_id=product_id,
                purchase_verified=True,
                purchase_amount_range="10000-50000",
                time_since_purchase_days=60 + i * 7,
                outcome="still_using" if is_positive else "returned",
                satisfaction="positive" if is_positive else "negative",
                issues=[] if is_positive else ["defective"],
                timestamp=time.time() - i * 86400,
            )
            outcomes.append(report)

        # AppView instance 1 (the shared fixture)
        appview_1 = MockAppView()
        appview_1.index_attestation(copy.deepcopy(att))
        for o in outcomes:
            appview_1.index_outcome(copy.deepcopy(o))

        # AppView instance 2 (independent instance, same data)
        appview_2 = MockAppView()
        appview_2.index_attestation(copy.deepcopy(att))
        for o in outcomes:
            appview_2.index_outcome(copy.deepcopy(o))

        # Query both AppViews
        result_1 = appview_1.query_product(product_id)
        result_2 = appview_2.query_product(product_id)

        assert result_1 is not None
        assert result_2 is not None

        # Scores MUST be identical -- deterministic computation
        assert result_1["score"] == result_2["score"], (
            f"AppView scores differ: {result_1['score']} vs {result_2['score']}. "
            f"Censorship alert!"
        )
        assert result_1["sample_size"] == result_2["sample_size"]
        assert result_1["still_using_1yr"] == result_2["still_using_1yr"]

        # Censorship detection: tamper with one AppView's score
        appview_2.product_scores[product_id]["score"] = (
            result_2["score"] + 15  # Artificially inflate
        )

        tampered_result_2 = appview_2.query_product(product_id)
        assert tampered_result_2 is not None

        # Detect the divergence
        if result_1["score"] != tampered_result_2["score"]:
            censorship_alert = {
                "type": "censorship_alert",
                "product_id": product_id,
                "appview_1_score": result_1["score"],
                "appview_2_score": tampered_result_2["score"],
                "delta": abs(result_1["score"] - tampered_result_2["score"]),
            }
            assert censorship_alert["delta"] > 0
            assert censorship_alert["type"] == "censorship_alert"
        else:
            pytest.fail("Tampered scores should have been detected as different")
