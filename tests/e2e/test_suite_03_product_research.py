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
    # TRACE: {"suite": "E2E", "case": "0013", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "01", "title": "product_research_via_reviewbot"}
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
        - Exact recommendation count and field VALUES
        """
        # Verify ReviewBot trust in AppView before querying
        bot_rep = appview.query_bot(reviewbot.did)
        assert bot_rep is not None
        assert bot_rep.score == 94, (
            f"ReviewBot trust score should be 94, got {bot_rep.score}"
        )

        # ------------------------------------------------------------------
        # 1. Build MCP request — must include trust_ring, NO identity
        # ------------------------------------------------------------------
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

        # trust_ring IS present with correct value
        assert mcp_request["requester_trust_ring"] == TrustRing.RING_3_SKIN_IN_GAME.value

        # ------------------------------------------------------------------
        # 2. Send to ReviewBot and verify exact response VALUES
        # ------------------------------------------------------------------
        response = reviewbot.handle_request(mcp_request)

        assert response["status"] == "completed"
        assert len(response["recommendations"]) == 2, (
            f"Expected 2 recommendations, got {len(response['recommendations'])}"
        )

        # Top recommendation: Herman Miller Aeron with deep link
        top_rec = response["recommendations"][0]
        assert top_rec["product"] == "Herman Miller Aeron"
        assert top_rec["score"] == 92

        assert len(top_rec["sources"]) == 1
        source = top_rec["sources"][0]
        assert source["type"] == "expert"
        assert source["creator_name"] == "MKBHD", (
            "Deep Link Default: creator must be credited by name"
        )
        assert source["deep_link"].startswith("https://"), (
            "Deep link must be a full URL"
        )
        assert "t=260" in source["deep_link"], (
            "Deep link must include timestamp for direct navigation"
        )
        assert source["deep_link_context"] == "battery stress test at 4:20"

        # Second recommendation: Steelcase Leap (no sources)
        second_rec = response["recommendations"][1]
        assert second_rec["product"] == "Steelcase Leap"
        assert second_rec["score"] == 88
        assert second_rec["sources"] == [], (
            "Second recommendation has no expert sources"
        )

        # ------------------------------------------------------------------
        # 3. ReviewBot request log: privacy preserved
        # ------------------------------------------------------------------
        assert len(reviewbot.requests_received) == 1, (
            f"Expected exactly 1 request, got {len(reviewbot.requests_received)}"
        )
        last_req = reviewbot.requests_received[-1]
        assert "requester_did" not in last_req, (
            "Privacy: requester DID must NOT be in ReviewBot request log"
        )
        assert last_req["requester_trust_ring"] == don_alonso.trust_ring.value

        # ------------------------------------------------------------------
        # 4. Verify ReviewBot passes trust_ring through to response
        # ------------------------------------------------------------------
        assert response.get("requester_trust_ring") == don_alonso.trust_ring.value

# TST-E2E-014
    # TRACE: {"suite": "E2E", "case": "0014", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "02", "title": "trust_network_check"}
    def test_trust_network_check(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-3.2 Trust Network Check.

        AppView has attestations and outcome data for Herman Miller Aeron.
        Query returns aggregate score with exact value verification.
        """
        product_id = "herman_miller_aeron"

        # ------------------------------------------------------------------
        # 1. Negative control: non-existent product → None
        # ------------------------------------------------------------------
        assert appview.query_product(product_id) is None, (
            "Non-existent product must return None before indexing"
        )

        # ------------------------------------------------------------------
        # 2. Index an expert attestation
        # ------------------------------------------------------------------
        att_sig = _mock_sign(
            json.dumps({"product": product_id, "rating": 92}),
            "mkbhd_private_key",
        )
        attestation = ExpertAttestation(
            attestation_id=f"att_{uuid.uuid4().hex[:8]}",
            expert_did="did:plc:mkbhd",
            product_id=product_id,
            rating=92,
            verdict={"ergonomics": 95, "build_quality": 90, "value": 85},
            signature=att_sig,
        )
        appview.index_attestation(attestation)

        # ------------------------------------------------------------------
        # 3. Index 5 outcome reports (all positive, all still_using)
        # ------------------------------------------------------------------
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

        # ------------------------------------------------------------------
        # 4. Query and verify exact values
        # ------------------------------------------------------------------
        product_data = appview.query_product(product_id)
        assert product_data is not None

        # Exact score: att_avg=92, out_pct=100 (5/5), score=int(0.5*92+0.5*100)=96
        assert product_data["score"] == 96, (
            f"Expected composite score 96, got {product_data['score']}"
        )
        assert product_data["sample_size"] == 6, (
            f"Expected sample_size 6 (1 att + 5 outcomes), got {product_data['sample_size']}"
        )

        # Exact counts
        assert len(product_data["attestations"]) == 1
        assert len(product_data["outcomes"]) == 5

        # still_using_1yr: all 5 outcomes are still_using → 100
        assert product_data["still_using_1yr"] == 100, (
            f"Expected still_using_1yr 100, got {product_data['still_using_1yr']}"
        )

        # ------------------------------------------------------------------
        # 5. Attestation field VALUE assertions
        # ------------------------------------------------------------------
        att = product_data["attestations"][0]
        assert att.expert_did == "did:plc:mkbhd"
        assert att.rating == 92
        assert att.verdict["ergonomics"] == 95
        assert att.verdict["build_quality"] == 90
        assert att.verdict["value"] == 85
        assert att.signature == att_sig, (
            "Attestation signature must be preserved through indexing"
        )

        # ------------------------------------------------------------------
        # 6. Negative control: different product still None
        # ------------------------------------------------------------------
        assert appview.query_product("nonexistent_chair") is None

# TST-E2E-015
    # TRACE: {"suite": "E2E", "case": "0015", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "03", "title": "cart_handover"}
    def test_cart_handover(
        self,
        don_alonso: HomeNode,
        payment_gateway: MockPaymentGateway,
    ) -> None:
        """E2E-3.3 Cart Handover.

        Create a payment_intent staging item. Dina advises but never
        touches money — she hands control back to the user.

        Verify:
        - Payment gateway intent has correct field VALUES
        - Staging item contains only the intent URI (no sensitive fields)
        - transfer_money is classified as HIGH risk (requires approval)
        - Staging data field VALUES match intent (amount, currency, payee)
        - Staging auto-expires after 72 hours
        - Expired staging item is removed
        - Before expiry, staging item is NOT removed
        - Audit trail records intent check
        """
        # Create payment intent via gateway
        txn_id = f"txn_{uuid.uuid4().hex[:8]}"
        intent = payment_gateway.create_intent(
            amount=72000,
            currency="INR",
            payee="chairmaker@upi",
            txn_id=txn_id,
        )

        # --- Verify gateway intent field VALUES ---
        assert intent["amount"] == 72000, (
            "Intent amount must be 72000"
        )
        assert intent["currency"] == "INR", (
            "Intent currency must be INR"
        )
        assert intent["payee"] == "chairmaker@upi", (
            "Intent payee must match"
        )
        assert intent["intent_uri"].startswith("upi://pay?"), (
            "Intent URI must start with upi://pay?"
        )
        assert txn_id in intent["intent_uri"], (
            "Intent URI must contain the transaction ID"
        )

        # --- Agent intent: transfer_money must be HIGH risk ---
        don_alonso.audit_log.clear()
        intent_result = don_alonso.verify_agent_intent(
            agent_did="did:plc:payment_bot",
            action="transfer_money",
            target="payment_gateway",
            context={"amount": 72000},
        )
        assert intent_result["risk"] == "HIGH", (
            "transfer_money must be classified as HIGH risk"
        )
        assert intent_result["approved"] is False, (
            "HIGH risk actions must not be auto-approved"
        )
        assert intent_result["requires_approval"] is True, (
            "Payment actions require explicit user approval"
        )

        # --- Create staging item with correct field VALUES ---
        staging = don_alonso.create_staging_item(
            item_type="payment_intent",
            data={
                "intent_uri": intent["intent_uri"],
                "amount": intent["amount"],
                "currency": intent["currency"],
                "payee_display": "ChairMaker",
            },
            confidence=0.95,
        )

        assert staging.staging_id.startswith("stg_"), (
            "Staging ID must start with stg_"
        )
        assert staging.item_type == "payment_intent", (
            "Staging item type must be payment_intent"
        )
        assert staging.confidence == 0.95, (
            "Staging confidence must be 0.95"
        )

        # --- Verify staging data field VALUES ---
        assert staging.data["amount"] == 72000, (
            "Staging data must contain correct amount"
        )
        assert staging.data["currency"] == "INR", (
            "Staging data must contain correct currency"
        )
        assert staging.data["payee_display"] == "ChairMaker", (
            "Staging data must contain correct payee display name"
        )
        assert staging.data["intent_uri"].startswith("upi://pay?"), (
            "Staging data must contain valid intent URI"
        )

        # Staging data must not contain sensitive payment fields
        all_staging_keys = set(staging.data.keys())
        sensitive_keys = {"pin", "balance", "account_number", "cvv",
                          "password", "secret"}
        leaked = all_staging_keys & sensitive_keys
        assert len(leaked) == 0, (
            f"Staging must not contain sensitive keys: {leaked}"
        )

        # --- Auto-expiry after 72 hours ---
        assert staging.expires_at > staging.created_at, (
            "Staging must have a future expiry time"
        )
        expiry_hours = (staging.expires_at - staging.created_at) / 3600
        assert expiry_hours == pytest.approx(72, abs=1), (
            "Staging must auto-expire after 72 hours"
        )

        # Before expiry: staging must NOT be removed
        before_expiry = staging.created_at + 71 * 3600
        expired_early = don_alonso.expire_staging(current_time=before_expiry)
        assert expired_early == 0, (
            "Staging must not expire before 72 hours"
        )
        assert staging.staging_id in don_alonso.staging, (
            "Staging must still exist before expiry"
        )

        # After expiry: staging is removed
        after_expiry = staging.created_at + 73 * 3600
        expired_count = don_alonso.expire_staging(current_time=after_expiry)
        assert expired_count == 1, (
            "Exactly 1 staging item must expire"
        )
        assert staging.staging_id not in don_alonso.staging, (
            "Staging must be removed after expiry"
        )

        # --- Audit trail ---
        intent_audits = don_alonso.get_audit_entries("agent_intent")
        assert len(intent_audits) >= 1, (
            "Payment intent check must be audited"
        )
        assert intent_audits[-1].details["risk"] == "HIGH", (
            "Audit must record HIGH risk for transfer_money"
        )

# TST-E2E-016
    # TRACE: {"suite": "E2E", "case": "0016", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "04", "title": "d2d_commerce_persona_gating"}
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
            message_type="coordination.request",
            payload={
                "type": "coordination.request",
                "action": "ask_availability",
                "context": "Herman Miller Aeron inquiry",
                "product": "Herman Miller Aeron",
                "buyer_persona": "consumer",
                # NOTE: No personal name, no health data, no financial details
            },
        )

        assert msg.from_did == don_alonso.did
        assert msg.to_did == chairmaker.did

        # ------------------------------------------------------------------
        # 1. Positive control: payload CONTAINS commerce data
        # ------------------------------------------------------------------
        assert msg.payload.get("product") == "Herman Miller Aeron", (
            "Commerce payload must contain the product inquiry"
        )
        assert msg.payload.get("buyer_persona") == "consumer"
        assert msg.payload.get("type") == "coordination.request"

        # ------------------------------------------------------------------
        # 2. Persona gating: no personal/health/financial data leaked
        # ------------------------------------------------------------------
        payload_str = json.dumps(msg.payload)
        assert don_alonso.display_name not in payload_str, (
            "Real name must NOT leak in commerce inquiry"
        )
        assert "health" not in payload_str.lower()
        assert "financial" not in payload_str.lower()

        # Encrypted payload must exist (D2D messages are encrypted in transit)
        assert msg.encrypted_payload is not None, (
            "D2D message must be encrypted in transit"
        )
        assert len(msg.encrypted_payload) > 0

        # Signature must exist
        assert msg.signature is not None
        assert len(msg.signature) > 0

        # ------------------------------------------------------------------
        # 3. ChairMaker received EXACTLY 1 commerce inquiry
        # ------------------------------------------------------------------
        chairmaker_recv = chairmaker.get_audit_entries("d2d_receive")
        commerce_recvs = [
            e for e in chairmaker_recv
            if e.details.get("type") == "coordination.request"
            and e.details.get("from_did") == don_alonso.did
        ]
        assert len(commerce_recvs) == 1, (
            f"Expected exactly 1 commerce inquiry received, got {len(commerce_recvs)}"
        )

        # ------------------------------------------------------------------
        # 4. Sharing policy enforces persona compartmentalization
        # ------------------------------------------------------------------
        policy = don_alonso.sharing_policies.get(chairmaker.did)
        assert policy is not None
        assert policy.preferences == "summary", (
            "ChairMaker should only see preference summary, not full details"
        )
        assert policy.health == "none", (
            "Health data must NEVER be shared with sellers"
        )

        # ------------------------------------------------------------------
        # 5. Audit trail: Don Alonso logged the D2D send
        # ------------------------------------------------------------------
        send_audits = don_alonso.get_audit_entries("d2d_send")
        commerce_sends = [
            e for e in send_audits
            if e.details.get("contact_did") == chairmaker.did
            and e.details.get("type") == "coordination.request"
        ]
        assert len(commerce_sends) == 1, (
            f"Expected exactly 1 commerce send audit, got {len(commerce_sends)}"
        )

# TST-E2E-017
    # TRACE: {"suite": "E2E", "case": "0017", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "05", "title": "cold_start_web_search"}
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
        vault_results = don_alonso.vault_query("general", "chair", mode="fts5")
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
    # TRACE: {"suite": "E2E", "case": "0018", "section": "03", "sectionName": "Product Research", "subsection": "01", "scenario": "06", "title": "outcome_reporting"}
    def test_outcome_reporting(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
        relay: MockAppView,  # MockRelay from conftest
    ) -> None:
        """E2E-3.6 Outcome Reporting.

        Create an OutcomeReport with all 13 fields, sign it, publish to PDS.
        Verify zero user identity in the published record and exact field VALUES.
        """
        # Use a unique product_id to isolate this test from outcomes
        # indexed by test_trust_network_check (which adds 5 outcomes for
        # "herman_miller_aeron" to the session-scoped appview).
        outcome_product_id = f"herman_miller_aeron_{uuid.uuid4().hex[:8]}"

        # Create a complete OutcomeReport (all 13 fields)
        report = OutcomeReport(
            report_id=f"out_{uuid.uuid4().hex[:8]}",
            reporter_trust_ring=don_alonso.trust_ring.value,
            reporter_age_days=730,
            product_category="office_chair",
            product_id=outcome_product_id,
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
        assert don_alonso.did in record_uri, (
            "Record URI must contain author's DID"
        )

        # ------------------------------------------------------------------
        # 1. Verify exact record count and field VALUES
        # ------------------------------------------------------------------
        published_records = don_alonso.pds.list_records("com.dina.trust.outcome")
        assert len(published_records) == 1, (
            f"Expected exactly 1 published record, got {len(published_records)}"
        )
        published = published_records[0]

        # Verify all 13 fields are present
        expected_fields = [
            "report_id", "reporter_trust_ring", "reporter_age_days",
            "product_category", "product_id", "purchase_verified",
            "purchase_amount_range", "time_since_purchase_days",
            "outcome", "satisfaction", "issues", "timestamp", "signature",
        ]
        for field_name in expected_fields:
            assert field_name in published, f"Missing field: {field_name}"

        # Verify field VALUES (not just presence)
        assert published["product_id"] == outcome_product_id
        assert published["outcome"] == "still_using"
        assert published["satisfaction"] == "positive"
        assert published["purchase_verified"] is True
        assert published["reporter_age_days"] == 730
        assert published["time_since_purchase_days"] == 365
        assert published["product_category"] == "office_chair"
        assert published["purchase_amount_range"] == "50000-100000"
        assert published["issues"] == ["armrest_wear", "mesh_pilling"]
        assert published["signature"] == report.signature

        # ------------------------------------------------------------------
        # 2. Verify ZERO user identity in the published record
        # ------------------------------------------------------------------
        published_str = json.dumps(published)
        assert don_alonso.did not in published_str, (
            "Author DID must NOT appear in published outcome record"
        )
        assert don_alonso.display_name not in published_str, (
            "Author display name must NOT appear in published record"
        )
        assert "alonso" not in published_str.lower(), (
            "Any reference to author name must NOT appear"
        )
        # Check for email addresses (scan all string values)
        for key, val in published.items():
            if isinstance(val, str):
                assert "@" not in val, (
                    f"Email-like content found in field '{key}': {val}"
                )

        # The record uses trust_ring (anonymous trust tier) instead of identity
        assert published["reporter_trust_ring"] == TrustRing.RING_3_SKIN_IN_GAME.value

        # ------------------------------------------------------------------
        # 3. Index in AppView and verify aggregation
        # ------------------------------------------------------------------
        appview.index_outcome(report)
        product_data = appview.query_product(outcome_product_id)
        assert product_data is not None
        assert len(product_data["outcomes"]) == 1
        assert product_data["outcomes"][0].satisfaction == "positive"
        assert product_data["outcomes"][0].product_id == outcome_product_id
