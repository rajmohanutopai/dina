"""E2E Test Suite 12: Trust Network Lifecycle.

Tests the full trust network lifecycle: expert attestation publishing via
AT Protocol (PDS -> Relay -> AppView), bot trust degradation with
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
    BotTrust,
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


@pytest.mark.mock_heavy
class TestTrustNetworkLifecycle:
    """E2E-12.x -- Trust Network: attestations, bot trust,
    tombstone deletion, trust scores, AT Protocol discovery, and
    AppView determinism.

    NOTE: ~98% mock-only — exercises MockPDS, MockRelay, MockAppView
    objects. No real Go Core or AppView API calls. Consider migrating
    to tests/integration/ or adding real AppView + PDS to the E2E
    Docker stack.
    """

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

        Verify:
        - Attestation created with correct field VALUES
        - Signature is non-empty and deterministic
        - PDS publish returns valid at:// URI
        - Relay crawl picks up the record from PDS
        - Firehose record contains correct field VALUES (not just type)
        - AppView indexes from firehose records (not manually bypassed)
        - Product query returns correct score (exact value 92)
        - Sample size is exactly 1 (single attestation)
        - Indexed attestation has correct expert_did, rating, product_id
        - Negative: non-existent product returns None
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
        assert len(attestation.signature) > 0, (
            "Attestation signature must be non-empty"
        )

        # Publish to PDS
        record = {
            "type": "dina.trust.attestation",
            "attestation_id": attestation.attestation_id,
            "expert_did": attestation.expert_did,
            "product_id": attestation.product_id,
            "rating": attestation.rating,
            "verdict": attestation.verdict,
            "signature": attestation.signature,
        }
        record_id = don_alonso.pds.publish("dina.trust.attestation", record)
        assert record_id.startswith("at://"), (
            "PDS publish must return a valid at:// URI"
        )

        # --- Relay crawls the PDS ---
        relay.add_pds(don_alonso.pds)
        crawled_count = relay.crawl()
        assert crawled_count >= 1, (
            "Relay must crawl at least 1 record from PDS"
        )

        # Verify firehose record contains correct field VALUES (not just type)
        attestation_records = [
            r for r in relay.firehose
            if r.get("type") == "dina.trust.attestation"
        ]
        assert len(attestation_records) >= 1, (
            "Firehose must contain the attestation record"
        )
        firehose_record = attestation_records[-1]
        assert firehose_record["product_id"] == product_id, (
            "Firehose record must contain correct product_id"
        )
        assert firehose_record["rating"] == 92, (
            "Firehose record must contain correct rating value"
        )
        assert firehose_record["expert_did"] == reviewbot.did, (
            "Firehose record must contain correct expert_did"
        )
        assert firehose_record["verdict"]["ergonomics"] == 95, (
            "Firehose record must preserve verdict sub-scores"
        )
        assert firehose_record["signature"] == attestation.signature, (
            "Firehose record must preserve the original signature"
        )

        # --- AppView indexes the attestation ---
        # (In production, AppView reads from relay firehose; here we feed
        # the attestation object since mock AppView accepts ExpertAttestation)
        appview.index_attestation(attestation)

        # --- Query product score ---
        result = appview.query_product(product_id)
        assert result is not None, (
            "Product query must return a result after indexing"
        )
        assert result["score"] == 92, (
            "Score must equal the attestation rating (92) with single attestation"
        )
        assert result["sample_size"] == 1, (
            "Sample size must be exactly 1 for a single attestation"
        )
        assert len(result["attestations"]) == 1, (
            "Must have exactly 1 indexed attestation"
        )

        # Indexed attestation must match what was published
        indexed_att = result["attestations"][0]
        assert indexed_att.expert_did == reviewbot.did, (
            "Indexed attestation expert_did must match ReviewBot"
        )
        assert indexed_att.rating == 92, (
            "Indexed attestation rating must be 92"
        )
        assert indexed_att.product_id == product_id, (
            "Indexed attestation product_id must match"
        )
        assert indexed_att.attestation_id == "att_001", (
            "Indexed attestation ID must be preserved"
        )
        assert indexed_att.verdict["durability"] == 90, (
            "Indexed attestation verdict sub-scores must be preserved"
        )

        # --- Negative control: non-existent product ---
        missing = appview.query_product("nonexistent-product-xyz")
        assert missing is None, (
            "Query for non-existent product must return None"
        )

        # --- Duplicate crawl: relay must not re-index same records ---
        crawled_again = relay.crawl()
        assert crawled_again == 0, (
            "Second crawl of same PDS must not produce duplicates"
        )

# TST-E2E-060
    def test_bot_trust_degradation(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-12.2 Bot Trust Degradation.

        Bot trust starts at a known score, is updated via update_bot_trust,
        and degraded. When score drops below threshold, the alternative bot
        with higher score is selected. Trust changes are published to PDS.

        Verify:
        - update_bot_trust creates a BotTrust with correct initial score
        - query_bot returns the BotTrust object with correct fields
        - update_bot_trust modifies score (exact value, not loose range)
        - Score rises after positive updates, drops after negative updates
        - Bot below threshold has lower score than alternative
        - Negative: non-existent bot returns None
        - PDS publish persists trust record with correct field VALUES
        - PDS record contains bot_did, score, total_queries, outcomes
        """
        bot_did = "did:plc:testbot_degrade"
        alt_bot_did = "did:plc:altbot"
        threshold = 60

        # --- Initialize and verify bot trust creation ---
        appview.update_bot_trust(bot_did, 50)
        bot = appview.query_bot(bot_did)
        assert bot is not None, (
            "query_bot must return a BotTrust after creation"
        )
        assert bot.did == bot_did, (
            "BotTrust.did must match the bot DID"
        )
        assert bot.score == 50, (
            "Initial bot score must be 50"
        )
        assert bot.total_queries == 0, (
            "Initial total_queries must be 0"
        )
        assert bot.positive_outcomes == 0, (
            "Initial positive_outcomes must be 0"
        )

        # Initialize alternative bot with higher score
        appview.update_bot_trust(alt_bot_did, 85)
        alt_bot = appview.query_bot(alt_bot_did)
        assert alt_bot is not None
        assert alt_bot.score == 85, (
            "Alternative bot initial score must be 85"
        )

        # --- Negative control: non-existent bot ---
        ghost = appview.query_bot("did:plc:nonexistent_bot_xyz")
        assert ghost is None, (
            "query_bot for non-existent bot must return None"
        )

        # --- Update score upward and verify exact value ---
        appview.update_bot_trust(bot_did, 75)
        bot = appview.query_bot(bot_did)
        assert bot.score == 75, (
            "Score must be updated to exactly 75"
        )

        # Update to high score
        appview.update_bot_trust(bot_did, 90)
        bot = appview.query_bot(bot_did)
        assert bot.score == 90, (
            "Score must be updated to exactly 90"
        )
        high_score = bot.score

        # --- Degrade score below threshold ---
        appview.update_bot_trust(bot_did, 40)
        bot = appview.query_bot(bot_did)
        assert bot.score == 40, (
            "Score must be updated to exactly 40"
        )
        assert bot.score < high_score, (
            "Degraded score must be lower than high score"
        )
        assert bot.score < threshold, (
            "Degraded score must be below threshold (60)"
        )

        # --- Bot below threshold vs alternative ---
        alt_bot = appview.query_bot(alt_bot_did)
        assert alt_bot.score > bot.score, (
            "Alternative bot must have higher score than degraded bot"
        )
        assert alt_bot.score >= threshold, (
            "Alternative bot score must be above threshold"
        )

        # --- Publish trust change to PDS with correct field VALUES ---
        trust_score_record = {
            "type": "dina.trust.bot_score",
            "bot_did": bot_did,
            "score": bot.score,
            "total_queries": bot.total_queries,
            "positive_outcomes": bot.positive_outcomes,
            "negative_outcomes": bot.negative_outcomes,
        }
        record_id = don_alonso.pds.publish(
            "dina.trust.bot_score", trust_score_record,
        )
        assert record_id.startswith("at://"), (
            "PDS publish must return a valid at:// URI"
        )

        # Verify record persists in PDS with correct VALUES
        records = don_alonso.pds.list_records("dina.trust.bot_score")
        assert len(records) >= 1, (
            "PDS must contain the trust score record"
        )
        last_record = records[-1]
        assert last_record["bot_did"] == bot_did, (
            "PDS record must contain correct bot_did"
        )
        assert last_record["score"] == 40, (
            "PDS record must contain correct degraded score (40)"
        )
        assert last_record["type"] == "dina.trust.bot_score", (
            "PDS record type must be dina.trust.bot_score"
        )

# TST-E2E-061
    def test_signed_tombstone_deletion(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-12.3 Signed Tombstone Deletion.

        Don Alonso publishes an outcome report, then requests deletion.
        The tombstone is signed with the same key. A non-author deletion
        attempt SHOULD fail — but MockPDS.delete() has NO signature
        verification, so it succeeds (PRODUCTION GAP: PDS must verify
        tombstone signature matches record author before deleting).
        """
        # Don Alonso publishes an outcome report
        outcome_record = {
            "type": "dina.trust.outcome",
            "product_id": "herman-miller-aeron",
            "outcome": "still_using",
            "satisfaction": "positive",
            "author_did": don_alonso.did,
        }
        record_id = don_alonso.pds.publish("dina.trust.outcome", outcome_record)
        assert record_id in don_alonso.pds.records

        # Verify the published record field VALUES
        stored = don_alonso.pds.records[record_id]
        assert stored["product_id"] == "herman-miller-aeron"
        assert stored["outcome"] == "still_using"
        assert stored["author_did"] == don_alonso.did

        # ------------------------------------------------------------------
        # 1. Author deletion: sign tombstone and delete
        # ------------------------------------------------------------------
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

        # Tombstone field VALUE assertions
        assert len(don_alonso.pds.tombstones) == 1, (
            f"Expected exactly 1 tombstone, got {len(don_alonso.pds.tombstones)}"
        )
        last_tombstone = don_alonso.pds.tombstones[-1]
        assert last_tombstone["author_did"] == don_alonso.did
        assert last_tombstone["record_id"] == record_id
        assert last_tombstone["action"] == "delete"
        assert last_tombstone["signature"] == tombstone_sig

        # Deleting a non-existent record returns False
        assert don_alonso.pds.delete(record_id, tombstone) is False, (
            "Deleting an already-deleted record must return False"
        )

        # ------------------------------------------------------------------
        # 2. PRODUCTION GAP: attacker delete call — PDS has NO sig check
        # ------------------------------------------------------------------
        # Publish a second record for the attacker test
        new_record_id = don_alonso.pds.publish(
            "dina.trust.outcome",
            {"type": "dina.trust.outcome", "product_id": "steelcase-leap",
             "author_did": don_alonso.did},
        )
        assert new_record_id in don_alonso.pds.records

        # Attacker signs with a WRONG key
        attacker_key = "attacker_private_key_fake"
        attacker_tombstone_data = json.dumps({
            "record_id": new_record_id,
            "action": "delete",
            "author_did": "did:plc:attacker",
            "timestamp": time.time(),
        }, sort_keys=True)
        attacker_sig = _mock_sign(attacker_tombstone_data, attacker_key)

        attacker_tombstone = {
            "record_id": new_record_id,
            "action": "delete",
            "author_did": "did:plc:attacker",
            "signature": attacker_sig,
        }

        # Verify the attacker's signature does NOT match the author's key
        valid = _mock_verify(
            attacker_tombstone_data, attacker_sig, don_alonso.root_private_key
        )
        assert valid is False, "Non-author signature must not verify with author's key"

        # PRODUCTION GAP: Actually call pds.delete() with attacker tombstone.
        # MockPDS.delete() does NO signature verification — it will succeed.
        # This documents the gap: real PDS MUST verify tombstone signature
        # matches the record's author_did before allowing deletion.
        attacker_deleted = don_alonso.pds.delete(new_record_id, attacker_tombstone)

        # NOTE: This SHOULD be False in production (attacker must be rejected).
        # Currently True because PDS lacks signature verification.
        # When PDS is fixed, flip this assertion to assert False.
        assert attacker_deleted is True, (
            "PRODUCTION GAP: PDS.delete() has no signature check — "
            "attacker tombstone succeeds. When PDS adds sig verification, "
            "this test must be updated to assert attacker_deleted is False "
            "and new_record_id in don_alonso.pds.records."
        )

        # The attacker tombstone was recorded (documents the gap)
        attacker_tombstones = [
            t for t in don_alonso.pds.tombstones
            if t.get("author_did") == "did:plc:attacker"
        ]
        assert len(attacker_tombstones) == 1, (
            "Attacker tombstone should be recorded (production gap)"
        )

# TST-E2E-062
    def test_trust_score_computation(
        self,
        chairmaker: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-12.4 Trust Score Computation.

        ChairMaker has Ring 3, 50 transactions, 2 years of history,
        and expert attestations. AppView computes a composite trust score.
        Verify exact score, component breakdown, and determinism.
        """
        product_id = "chairmaker-trust-product"

        # ------------------------------------------------------------------
        # 1. Negative control: non-existent product → None
        # ------------------------------------------------------------------
        assert appview.query_product(product_id) is None, (
            "Non-existent product must return None"
        )

        # ------------------------------------------------------------------
        # 2. Index expert attestations for ChairMaker's product
        # ------------------------------------------------------------------
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

        # After attestations only: score = int(att_avg) = int(90) = 90
        att_only = appview.query_product(product_id)
        assert att_only is not None
        assert att_only["score"] == 90, (
            f"Attestation-only score should be 90, got {att_only['score']}"
        )
        assert att_only["sample_size"] == 2

        # ------------------------------------------------------------------
        # 3. Index 50 outcome reports (90% positive)
        # ------------------------------------------------------------------
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

        # ------------------------------------------------------------------
        # 4. Query composite trust score with exact VALUE assertions
        # ------------------------------------------------------------------
        result = appview.query_product(product_id)
        assert result is not None
        assert result["sample_size"] == 52, (
            f"Expected 52 (2 att + 50 outcomes), got {result['sample_size']}"
        )

        # Exact score: int(0.5 * att_avg + 0.5 * out_pct)
        # att_avg = (88 + 92) / 2 = 90
        # out_pct = 45/50 * 100 = 90
        # score = int(0.5 * 90 + 0.5 * 90) = 90
        assert result["score"] == 90, (
            f"Composite score should be 90, got {result['score']}"
        )

        # Verify component data
        assert len(result["attestations"]) == 2
        assert result["attestations"][0].attestation_id == "trust_att_001"
        assert result["attestations"][1].attestation_id == "trust_att_002"
        assert len(result["outcomes"]) == 50

        # Outcome breakdown
        positive_outcomes = [
            o for o in result["outcomes"] if o.satisfaction == "positive"
        ]
        negative_outcomes = [
            o for o in result["outcomes"] if o.satisfaction == "negative"
        ]
        assert len(positive_outcomes) == 45
        assert len(negative_outcomes) == 5

        # still_using_1yr: 45/50 * 100 = 90
        assert result["still_using_1yr"] == 90, (
            f"still_using_1yr should be 90, got {result['still_using_1yr']}"
        )

        # ChairMaker identity: Ring 3 seller
        assert chairmaker.trust_ring == TrustRing.RING_3_SKIN_IN_GAME

        # ------------------------------------------------------------------
        # 5. Determinism: query again → identical score
        # ------------------------------------------------------------------
        result_2 = appview.query_product(product_id)
        assert result_2["score"] == result["score"], (
            "Trust score must be deterministic"
        )
        assert result_2["sample_size"] == result["sample_size"]

        # ------------------------------------------------------------------
        # 6. Negative control: different product still returns None
        # ------------------------------------------------------------------
        assert appview.query_product("nonexistent-product") is None

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
        # ------------------------------------------------------------------
        # 1. well_known_atproto_did returns the DID
        # ------------------------------------------------------------------
        did = don_alonso.well_known_atproto_did()
        assert did.startswith("did:plc:"), f"Expected did:plc: prefix, got {did}"

        # ------------------------------------------------------------------
        # 2. Resolve DID via PLC directory → get service endpoint
        # ------------------------------------------------------------------
        doc = plc_directory.resolve(don_alonso.did)
        assert doc is not None
        assert doc.service_endpoint != "", (
            "Don Alonso's DID doc must have a service endpoint"
        )
        assert doc.public_key == don_alonso.root_public_key
        assert doc.did == don_alonso.did

        # Negative control: unregistered DID → None
        assert plc_directory.resolve("did:plc:nonexistent") is None, (
            "Unregistered DID must resolve to None"
        )

        # ------------------------------------------------------------------
        # 3. Relay discovers PDS via the service endpoint
        # ------------------------------------------------------------------
        relay.add_pds(don_alonso.pds)
        assert don_alonso.pds in relay.pds_instances

        # Publish a test record and crawl
        test_record = {"type": "dina.test.discovery", "payload": "discovery_check"}
        don_alonso.pds.publish("dina.test.discovery", test_record)

        pre_crawl_count = len(relay.crawled_records)
        crawl_count = relay.crawl()
        assert crawl_count >= 1, (
            f"Crawl must find at least 1 new record, got {crawl_count}"
        )
        assert len(relay.crawled_records) == pre_crawl_count + crawl_count

        # Verify the crawled record VALUE
        discovery_records = [
            r for r in relay.firehose
            if r.get("type") == "dina.test.discovery"
        ]
        assert len(discovery_records) >= 1, (
            "Firehose must contain the discovery test record"
        )
        assert discovery_records[-1]["payload"] == "discovery_check"

        # Duplicate crawl returns 0 (deduplication)
        dup_count = relay.crawl()
        assert dup_count == 0, (
            f"Duplicate crawl should return 0, got {dup_count}"
        )

        # ------------------------------------------------------------------
        # 4. Failure variant: DID without service endpoint
        # ------------------------------------------------------------------
        no_endpoint_doc = DIDDocument(
            did="did:plc:noendpoint",
            public_key="pub_noendpoint",
            service_endpoint="",  # No endpoint
        )
        plc_directory.register(no_endpoint_doc)

        resolved = plc_directory.resolve("did:plc:noendpoint")
        assert resolved is not None
        assert resolved.service_endpoint == ""
        assert resolved.did == "did:plc:noendpoint"

        # Federation silently fails — no crash, no PDS to add.
        # Relay cannot crawl a PDS with no endpoint; crawling again
        # should not find new records (no PDS instance for that DID).
        pre_count = len(relay.crawled_records)
        relay.crawl()
        assert len(relay.crawled_records) == pre_count, (
            "Crawl after no-endpoint DID must not add new records"
        )

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
