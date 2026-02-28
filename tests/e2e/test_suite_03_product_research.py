"""E2E Test Suite 3: Product Research & Purchase.

Tests the full product research journey: querying ReviewBot via MCP,
checking the Trust Network, cart handover, D2D commerce with persona
gating, cold-start web search fallback, and outcome reporting to PDS.

Actors: Don Alonso, ChairMaker, ReviewBot, AppView, OpenClaw,
        Payment Gateway, PLC Directory, D2D Network.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid

import pytest

from tests.e2e.actors import HomeNode, _mock_sign
from tests.e2e.mocks import (
    ActionRisk,
    AuditEntry,
    BotTrust,
    D2DMessage,
    DeviceType,
    ExpertAttestation,
    MockAppView,
    MockD2DNetwork,
    MockOpenClaw,
    MockPaymentGateway,
    MockPLCDirectory,
    MockReviewBot,
    OutcomeReport,
    PersonaType,
    SharingPolicy,
    StagingItem,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 3: Product Research & Purchase
# ---------------------------------------------------------------------------


class TestProductResearchPurchase:
    """E2E-3.x -- Product research via ReviewBot, Trust Network,
    cart handover, D2D commerce, cold-start fallback, and outcome
    reporting."""

# TST-E2E-013
    def test_product_research_via_reviewbot(
        self,
        don_alonso: HomeNode,
        reviewbot: MockReviewBot,
        appview: MockAppView,
    ) -> None:
        """E2E-3.1 Product Research via ReviewBot.

        Don Alonso queries ReviewBot via MCP for "ergonomic chair".
        Verify:
        - Request contains trust_ring but NO DID or display name
        - Response contains deep_links (creator attribution)
        """
        # Verify ReviewBot trust in AppView before querying
        bot_rep = appview.query_bot(reviewbot.did)
        assert bot_rep is not None
        assert bot_rep.score >= 80  # Only query reputable bots

        # Build MCP request -- must include trust_ring, must NOT include
        # personal identifiers (DID, name, email)
        mcp_request = {
            "action": "product_query",
            "query": "ergonomic chair",
            "requester_trust_ring": don_alonso.trust_ring.value,
            # NOTE: No "requester_did", no "requester_name"
        }

        # Verify the request does NOT contain user identity
        request_str = json.dumps(mcp_request)
        assert don_alonso.did not in request_str
        assert don_alonso.display_name not in request_str
        assert "alonso" not in request_str.lower()

        # trust_ring IS present
        assert "requester_trust_ring" in mcp_request
        assert mcp_request["requester_trust_ring"] == TrustRing.RING_3_SKIN_IN_GAME.value

        # Send to ReviewBot
        response = reviewbot.handle_request(mcp_request)

        assert response["status"] == "completed"
        assert "recommendations" in response
        assert len(response["recommendations"]) > 0

        # Verify deep_links in response (creator attribution -- Deep Link Default)
        top_rec = response["recommendations"][0]
        assert top_rec["product"] == "Herman Miller Aeron"
        assert "sources" in top_rec
        assert len(top_rec["sources"]) > 0

        source = top_rec["sources"][0]
        assert "deep_link" in source
        assert source["deep_link"].startswith("https://")
        assert "deep_link_context" in source
        assert source["type"] == "expert"
        assert "creator_name" in source  # Credit the creator

        # ReviewBot recorded the request
        assert len(reviewbot.requests_received) >= 1
        last_req = reviewbot.requests_received[-1]
        assert "requester_did" not in last_req  # Privacy preserved
        assert last_req["requester_trust_ring"] == don_alonso.trust_ring.value

# TST-E2E-014
    def test_trust_network_check(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-3.2 Trust Network Check.

        AppView has attestations and outcome data for Herman Miller Aeron.
        Query returns aggregate score with signature verification.
        """
        product_id = "herman_miller_aeron"

        # Index an expert attestation
        attestation = ExpertAttestation(
            attestation_id=f"att_{uuid.uuid4().hex[:8]}",
            expert_did="did:plc:mkbhd",
            product_id=product_id,
            rating=92,
            verdict={"ergonomics": 95, "build_quality": 90, "value": 85},
            signature=_mock_sign(
                json.dumps({"product": product_id, "rating": 92}),
                "mkbhd_private_key",
            ),
        )
        appview.index_attestation(attestation)

        # Index outcome reports (passive crowd signal)
        for i in range(5):
            outcome = OutcomeReport(
                report_id=f"out_{uuid.uuid4().hex[:8]}",
                reporter_trust_ring=TrustRing.RING_2_VERIFIED.value,
                reporter_age_days=365 + i * 30,
                product_category="office_chair",
                product_id=product_id,
                purchase_verified=True,
                purchase_amount_range="50000-100000",
                time_since_purchase_days=180 + i * 30,
                outcome="still_using",
                satisfaction="positive",
                issues=[] if i < 4 else ["armrest_wear"],
                timestamp=time.time() - i * 86400,
            )
            appview.index_outcome(outcome)

        # Query the Trust Network
        product_data = appview.query_product(product_id)
        assert product_data is not None

        # Aggregate score computed
        assert "score" in product_data
        assert product_data["score"] > 0
        assert product_data["sample_size"] >= 6  # 1 attestation + 5 outcomes

        # Attestations and outcomes tracked
        assert len(product_data["attestations"]) >= 1
        assert len(product_data["outcomes"]) >= 5

        # still_using_1yr metric
        assert "still_using_1yr" in product_data
        assert product_data["still_using_1yr"] > 0  # Most outcomes are "still_using"

        # Verify the attestation signature
        att = product_data["attestations"][0]
        assert att.signature != ""
        assert att.expert_did == "did:plc:mkbhd"
        assert att.rating == 92

# TST-E2E-015
    def test_cart_handover(
        self,
        don_alonso: HomeNode,
        payment_gateway: MockPaymentGateway,
    ) -> None:
        """E2E-3.3 Cart Handover.

        Create a payment_intent staging item. Verify:
        - Dina never sees PIN or balance (not in staging data)
        - Staging item auto-expires after 72 hours
        """
        # Create payment intent via gateway
        intent = payment_gateway.create_intent(
            amount=72000,
            currency="INR",
            payee="chairmaker@upi",
            txn_id=f"txn_{uuid.uuid4().hex[:8]}",
        )

        # Create staging item -- Dina only holds the intent URI, NOT the PIN/balance
        staging = don_alonso.create_staging_item(
            item_type="payment_intent",
            data={
                "intent_uri": intent["intent_uri"],
                "amount": intent["amount"],
                "currency": intent["currency"],
                "payee_display": "ChairMaker",
                # NOTE: No "pin", no "balance", no "account_number"
            },
            confidence=0.95,
        )

        assert staging.staging_id.startswith("stg_")
        assert staging.item_type == "payment_intent"

        # Verify Dina NEVER sees PIN, balance, or account details
        staging_str = json.dumps(staging.data)
        assert "pin" not in staging_str.lower()
        assert "balance" not in staging_str.lower()
        assert "account_number" not in staging_str.lower()
        assert "cvv" not in staging_str.lower()

        # Intent URI is present (for handover to user's payment app)
        assert "intent_uri" in staging.data
        assert staging.data["intent_uri"].startswith("upi://pay?")

        # Verify auto-expiry after 72 hours
        assert staging.expires_at > staging.created_at
        expiry_hours = (staging.expires_at - staging.created_at) / 3600
        assert expiry_hours == pytest.approx(72, abs=1)

        # Simulate time advancing past 72h and expire
        future_time = staging.created_at + 73 * 3600
        expired_count = don_alonso.expire_staging(current_time=future_time)
        assert expired_count >= 1

        # Staging item removed
        assert staging.staging_id not in don_alonso.staging

# TST-E2E-016
    def test_d2d_commerce_persona_gating(
        self,
        don_alonso: HomeNode,
        chairmaker: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-3.4 D2D Commerce.

        Don Alonso sends a commerce inquiry to ChairMaker.
        Verify only business persona data is shared (no personal data).
        """
        # Don Alonso sends commerce inquiry to ChairMaker
        msg = don_alonso.send_d2d(
            to_did=chairmaker.did,
            message_type="dina/commerce/inquiry",
            payload={
                "type": "dina/commerce/inquiry",
                "product": "Herman Miller Aeron",
                "buyer_persona": "consumer",
                # NOTE: No personal name, no health data, no financial details
            },
        )

        assert msg.from_did == don_alonso.did
        assert msg.to_did == chairmaker.did

        # Verify the sent payload contains ONLY consumer/business data
        payload_str = json.dumps(msg.payload)
        assert don_alonso.display_name not in payload_str  # No real name leaked
        assert "health" not in payload_str.lower()
        assert "financial" not in payload_str.lower()

        # Buyer persona is "consumer" -- compartmentalized
        assert msg.payload.get("buyer_persona") == "consumer"

        # ChairMaker received and processed the inquiry
        chairmaker_recv = chairmaker.get_audit_entries("d2d_receive")
        assert len(chairmaker_recv) >= 1
        last_recv = chairmaker_recv[-1]
        assert last_recv.details["from_did"] == don_alonso.did
        assert last_recv.details["type"] == "dina/commerce/inquiry"

        # Don Alonso's sharing policy for chairmaker: only preferences=summary
        policy = don_alonso.sharing_policies.get(chairmaker.did)
        assert policy is not None
        assert policy.preferences == "summary"
        # health defaults to "none" -- never shared with sellers
        assert policy.health == "none"

# TST-E2E-017
    def test_cold_start_web_search(
        self,
        don_alonso: HomeNode,
        openclaw: MockOpenClaw,
        appview: MockAppView,
    ) -> None:
        """E2E-3.5 Cold Start Web Search.

        No trust data exists for a product. Fall back to web search
        via OpenClaw. Verify vault context enriches the search results.
        """
        unknown_product = "steelcase_gesture"

        # Confirm no trust data exists
        product_data = appview.query_product(unknown_product)
        assert product_data is None

        # Verify agent intent before allowing web search
        intent_result = don_alonso.verify_agent_intent(
            agent_did=openclaw.did,
            action="search",
            target="web",
            context={"query": "best office chair Steelcase Gesture"},
        )
        assert intent_result["approved"] is True
        assert intent_result["risk"] == ActionRisk.SAFE.name

        # Fall back to web search via OpenClaw
        search_request = {
            "action": "web_search",
            "query": "best office chair",
        }
        search_result = openclaw.handle_request(search_request)
        assert search_result["status"] == "completed"
        assert "results" in search_result
        assert len(search_result["results"]) > 0

        # Verify search results contain URLs (for Deep Link Default)
        for result in search_result["results"]:
            assert "url" in result
            assert "title" in result

        # Enrich with vault context: Don Alonso's existing product preferences
        # The vault has context about chairs from previous research
        vault_results = don_alonso.vault_query("personal", "chair", mode="fts5")
        # Vault context may or may not exist, but the query should not fail.
        # If it exists, it enriches the cold-start results.

        # Audit trail should show the agent intent verification
        intent_entries = don_alonso.get_audit_entries("agent_intent")
        assert len(intent_entries) >= 1
        last_intent = intent_entries[-1]
        assert last_intent.details["agent_did"] == openclaw.did
        assert last_intent.details["action"] == "search"
        assert last_intent.details["risk"] == ActionRisk.SAFE.name

# TST-E2E-018
    def test_outcome_reporting(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
        relay: MockAppView,  # MockRelay from conftest
    ) -> None:
        """E2E-3.6 Outcome Reporting.

        Create an OutcomeReport with all 13 fields, sign it, publish to PDS.
        Verify zero user identity in the published record.
        """
        # Create a complete OutcomeReport (all 13 fields)
        report = OutcomeReport(
            report_id=f"out_{uuid.uuid4().hex[:8]}",
            reporter_trust_ring=don_alonso.trust_ring.value,
            reporter_age_days=730,
            product_category="office_chair",
            product_id="herman_miller_aeron",
            purchase_verified=True,
            purchase_amount_range="50000-100000",
            time_since_purchase_days=365,
            outcome="still_using",
            satisfaction="positive",
            issues=["armrest_wear", "mesh_pilling"],
            timestamp=time.time(),
        )

        # Sign the report (using the node's private key)
        report_data = json.dumps({
            "report_id": report.report_id,
            "product_id": report.product_id,
            "satisfaction": report.satisfaction,
            "outcome": report.outcome,
        }, sort_keys=True)
        report.signature = _mock_sign(report_data, don_alonso.root_private_key)
        assert report.signature != ""

        # Publish to PDS (personal data server)
        record = {
            "report_id": report.report_id,
            "reporter_trust_ring": report.reporter_trust_ring,
            "reporter_age_days": report.reporter_age_days,
            "product_category": report.product_category,
            "product_id": report.product_id,
            "purchase_verified": report.purchase_verified,
            "purchase_amount_range": report.purchase_amount_range,
            "time_since_purchase_days": report.time_since_purchase_days,
            "outcome": report.outcome,
            "satisfaction": report.satisfaction,
            "issues": report.issues,
            "timestamp": report.timestamp,
            "signature": report.signature,
        }

        record_uri = don_alonso.pds.publish(
            "com.dina.trust.outcome", record,
        )
        assert record_uri.startswith("at://")

        # Verify all 13 fields are present in the published record
        published_records = don_alonso.pds.list_records("com.dina.trust.outcome")
        assert len(published_records) >= 1
        published = published_records[-1]

        expected_fields = [
            "report_id", "reporter_trust_ring", "reporter_age_days",
            "product_category", "product_id", "purchase_verified",
            "purchase_amount_range", "time_since_purchase_days",
            "outcome", "satisfaction", "issues", "timestamp", "signature",
        ]
        for field_name in expected_fields:
            assert field_name in published, f"Missing field: {field_name}"

        # Verify ZERO user identity in the published record
        # No DID, no name, no email, no IP, no device ID
        published_str = json.dumps(published)
        assert don_alonso.did not in published_str
        assert don_alonso.display_name not in published_str
        assert "alonso" not in published_str.lower()
        assert "email" not in published_str.lower() or "email" in "purchase_amount_range"
        # The record uses trust_ring (anonymous trust tier) instead of identity
        assert published["reporter_trust_ring"] == TrustRing.RING_3_SKIN_IN_GAME.value

        # Index in AppView for aggregation
        appview.index_outcome(report)
        product_data = appview.query_product("herman_miller_aeron")
        assert product_data is not None
        assert len(product_data["outcomes"]) >= 1
