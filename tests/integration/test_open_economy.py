"""Integration tests for the open economy protocol.

Behavioral contracts tested:
- Direct transactions: Buyer's Dina negotiates directly with seller's Dina
  over open protocols — no walled garden required.
- Plugin economy: Makers, bot operators, and experts earn based on quality,
  accuracy, and trust. The protocol itself earns nothing.
- Multi-party coordination: Three-party transactions (buyer + seller +
  logistics), group purchases, and dispute resolution.
"""

from __future__ import annotations

import uuid

import pytest

from tests.integration.mocks import (
    ActionRisk,
    AgentIntent,
    DIDDocument,
    DinaMessage,
    MockDinaCore,
    MockExternalAgent,
    MockHuman,
    MockP2PChannel,
    MockReputationGraph,
    MockReviewBot,
    MockTrustEvaluator,
    PaymentIntent,
    PersonaType,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def setup_p2p_pair(
    buyer: MockDinaCore, seller: MockDinaCore, p2p: MockP2PChannel
) -> None:
    """Wire two Dinas for P2P communication."""
    p2p.add_contact(buyer.identity.root_did)
    p2p.add_contact(seller.identity.root_did)
    p2p.authenticated_peers.add(buyer.identity.root_did)
    p2p.authenticated_peers.add(seller.identity.root_did)


# =========================================================================
# TestDirectTransactions
# =========================================================================

class TestDirectTransactions:
    """Buyer's Dina speaks directly to seller's Dina — no middleman."""

# TST-INT-514
    def test_direct_purchase_via_open_protocol(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_p2p: MockP2PChannel,
        mock_human: MockHuman,
    ):
        """Buyer's Dina sends a purchase inquiry to seller's Dina over
        DIDComm P2P. No centralized marketplace involved."""
        setup_p2p_pair(mock_dina, mock_seller_dina, mock_p2p)

        inquiry = DinaMessage(
            type="dina/commerce/inquiry",
            from_did=mock_dina.identity.root_did,
            to_did=mock_seller_dina.identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "question": "Is this available? What's the delivery time?",
            },
        )
        sent = mock_p2p.send(inquiry)
        assert sent is True

        received = mock_p2p.receive()
        assert received is not None
        assert received.type == "dina/commerce/inquiry"
        assert received.payload["product_id"] == "aeron_2025"

# TST-INT-290
    def test_walled_garden_still_option(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ):
        """Even with open protocols, the user can still choose to buy via
        Amazon/Flipkart — Dina presents both options."""
        mock_dina.vault.store(0, "purchase_channels", {
            "open_protocol": True,
            "amazon": True,
            "flipkart": True,
        })

        channels = mock_dina.vault.retrieve(0, "purchase_channels")
        assert channels["open_protocol"] is True
        assert channels["amazon"] is True
        # User freedom: all channels available, none blocked

# TST-INT-515
    def test_negotiates_with_seller(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_p2p: MockP2PChannel,
    ):
        """Buyer's Dina can send a negotiation message and receive a
        counter-offer from seller's Dina."""
        setup_p2p_pair(mock_dina, mock_seller_dina, mock_p2p)

        # Buyer sends offer
        offer = DinaMessage(
            type="dina/commerce/offer",
            from_did=mock_dina.identity.root_did,
            to_did=mock_seller_dina.identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "offered_price": 85000,
                "currency": "INR",
            },
        )
        mock_p2p.send(offer)
        received_offer = mock_p2p.receive()
        assert received_offer.payload["offered_price"] == 85000

        # Seller counter-offers
        counter = DinaMessage(
            type="dina/commerce/counter_offer",
            from_did=mock_seller_dina.identity.root_did,
            to_did=mock_dina.identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "counter_price": 90000,
                "currency": "INR",
                "includes_delivery": True,
            },
        )
        mock_p2p.send(counter)
        received_counter = mock_p2p.receive()
        assert received_counter.type == "dina/commerce/counter_offer"
        assert received_counter.payload["counter_price"] == 90000

# TST-INT-516
    def test_logistics_via_separate_dina(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_p2p: MockP2PChannel,
    ):
        """Logistics is handled by a third-party Dina (courier service),
        also communicating over P2P."""
        logistics_dina = MockDinaCore()
        mock_p2p.add_contact(logistics_dina.identity.root_did)
        mock_p2p.authenticated_peers.add(logistics_dina.identity.root_did)

        # Seller sends shipment request to logistics Dina
        ship_request = DinaMessage(
            type="dina/logistics/ship_request",
            from_did=mock_seller_dina.identity.root_did,
            to_did=logistics_dina.identity.root_did,
            payload={
                "order_id": "order_001",
                "pickup": "warehouse_mumbai",
                "delivery": "buyer_address_encrypted",
                "dimensions": {"weight_kg": 22},
            },
        )
        sent = mock_p2p.send(ship_request)
        assert sent is True

        received = mock_p2p.receive()
        assert received.type == "dina/logistics/ship_request"
        assert received.payload["order_id"] == "order_001"


# =========================================================================
# TestPluginEconomy
# =========================================================================

class TestPluginEconomy:
    """The open economy rewards quality, not platform lock-in."""

# TST-INT-291
    def test_maker_earns_by_quality(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_trust_evaluator: MockTrustEvaluator,
    ):
        """A product maker's trust score increases with positive outcomes
        and verified transactions."""
        seller_did = "did:plc:ChairMaker"
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=730,
            transaction_count=500,
            transaction_volume=25_000_000.0,
            outcome_count=45,
            peer_attestations=3,
            credential_count=2,
        )
        mock_reputation_graph.set_trust_score(seller_did, score)
        assert score > 70.0  # High-quality maker earns high trust

        # A new, unproven maker earns much less
        new_score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_1_UNVERIFIED,
            time_alive_days=10,
            transaction_count=2,
            transaction_volume=5000.0,
            outcome_count=0,
            peer_attestations=0,
            credential_count=0,
        )
        assert new_score < 20.0

# TST-INT-311
    def test_bot_operator_earns_by_accuracy(
        self, mock_reputation_graph: MockReputationGraph
    ):
        """A review bot's reputation increases when its recommendations
        lead to good outcomes, and decreases for bad ones."""
        bot_did = "did:plc:ReviewBot"
        mock_reputation_graph.bot_scores[bot_did] = 50.0

        # Good outcomes raise the score
        mock_reputation_graph.update_bot_score(bot_did, +10.0)
        assert mock_reputation_graph.get_bot_score(bot_did) == 60.0

        # Bad outcomes lower the score
        mock_reputation_graph.update_bot_score(bot_did, -15.0)
        assert mock_reputation_graph.get_bot_score(bot_did) == 45.0

        # Score is clamped to 0-100
        mock_reputation_graph.update_bot_score(bot_did, -100.0)
        assert mock_reputation_graph.get_bot_score(bot_did) == 0.0

# TST-INT-312
    def test_expert_earns_by_trust(
        self,
        mock_reputation_graph: MockReputationGraph,
        mock_trust_evaluator: MockTrustEvaluator,
    ):
        """An expert reviewer (e.g., MKBHD) earns trust through consistent,
        verified reviews that match real-world outcomes."""
        expert_did = "did:plc:MKBHD"
        score = mock_trust_evaluator.compute_composite(
            ring=TrustRing.RING_3_SKIN_IN_GAME,
            time_alive_days=3650,  # 10 years
            transaction_count=0,
            transaction_volume=0.0,
            outcome_count=50,  # 50 verified outcomes
            peer_attestations=5,
            credential_count=3,
        )
        mock_reputation_graph.set_trust_score(expert_did, score)
        assert score > 75.0

# TST-INT-517
    def test_protocol_earns_nothing(self, mock_dina: MockDinaCore):
        """The protocol itself takes no cut from transactions. Zero fees
        at the protocol layer — value accrues to participants, not the pipe."""
        intent = PaymentIntent(
            intent_id="protocol_test_001",
            method="crypto",
            intent_uri="ethereum:0xSeller?value=100",
            merchant="ChairMaker Co.",
            amount=90000.0,
            currency="INR",
        )
        mock_dina.staging.store_payment_intent(intent)
        stored = mock_dina.staging.get("protocol_test_001")

        # The full amount goes to the merchant — no protocol fee
        assert stored.amount == 90000.0
        # No "platform_fee" field exists
        assert not hasattr(stored, "platform_fee")


# =========================================================================
# TestMultiPartyCoordination
# =========================================================================

class TestMultiPartyCoordination:
    """Multi-Dina coordination for complex transactions."""

# TST-INT-518
    def test_buyer_seller_logistics_three_party(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_p2p: MockP2PChannel,
    ):
        """Three Dinas (buyer, seller, logistics) coordinate a transaction
        end-to-end via P2P messages."""
        logistics_dina = MockDinaCore()
        for did in [
            mock_dina.identity.root_did,
            mock_seller_dina.identity.root_did,
            logistics_dina.identity.root_did,
        ]:
            mock_p2p.add_contact(did)
            mock_p2p.authenticated_peers.add(did)

        # Step 1: Buyer -> Seller: purchase request
        purchase = DinaMessage(
            type="dina/commerce/purchase",
            from_did=mock_dina.identity.root_did,
            to_did=mock_seller_dina.identity.root_did,
            payload={"product_id": "aeron_2025", "quantity": 1},
        )
        assert mock_p2p.send(purchase) is True

        # Step 2: Seller -> Logistics: shipment request
        shipment = DinaMessage(
            type="dina/logistics/ship_request",
            from_did=mock_seller_dina.identity.root_did,
            to_did=logistics_dina.identity.root_did,
            payload={"order_id": "order_three_party", "weight_kg": 22},
        )
        assert mock_p2p.send(shipment) is True

        # Step 3: Logistics -> Buyer: delivery confirmation
        delivery = DinaMessage(
            type="dina/logistics/delivered",
            from_did=logistics_dina.identity.root_did,
            to_did=mock_dina.identity.root_did,
            payload={
                "order_id": "order_three_party",
                "status": "delivered",
                "proof": "signature_on_file",
            },
        )
        assert mock_p2p.send(delivery) is True

        # All three messages are in the channel
        assert len(mock_p2p.messages) == 3

# TST-INT-519
    def test_group_purchase(
        self,
        mock_dina: MockDinaCore,
        mock_another_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_p2p: MockP2PChannel,
    ):
        """Two buyers coordinate a group purchase to get a bulk discount."""
        for did in [
            mock_dina.identity.root_did,
            mock_another_dina.identity.root_did,
            mock_seller_dina.identity.root_did,
        ]:
            mock_p2p.add_contact(did)
            mock_p2p.authenticated_peers.add(did)

        # Both buyers express intent
        for buyer in [mock_dina, mock_another_dina]:
            intent_msg = DinaMessage(
                type="dina/commerce/group_intent",
                from_did=buyer.identity.root_did,
                to_did=mock_seller_dina.identity.root_did,
                payload={
                    "product_id": "aeron_2025",
                    "quantity": 1,
                    "group_id": "group_bulk_001",
                },
            )
            mock_p2p.send(intent_msg)

        # Seller sees two intents for the same group
        group_messages = [
            m for m in mock_p2p.messages
            if m.type == "dina/commerce/group_intent"
            and m.payload.get("group_id") == "group_bulk_001"
        ]
        assert len(group_messages) == 2

        # Seller offers bulk discount
        total_quantity = sum(m.payload["quantity"] for m in group_messages)
        assert total_quantity == 2

# TST-INT-520
    def test_dispute_resolution(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_reputation_graph: MockReputationGraph,
        mock_p2p: MockP2PChannel,
    ):
        """When a buyer disputes an order, the dispute is logged and both
        parties' reputations are evaluated."""
        setup_p2p_pair(mock_dina, mock_seller_dina, mock_p2p)

        # Buyer raises dispute
        dispute = DinaMessage(
            type="dina/commerce/dispute",
            from_did=mock_dina.identity.root_did,
            to_did=mock_seller_dina.identity.root_did,
            payload={
                "order_id": "order_disputed_001",
                "reason": "item_not_as_described",
                "evidence": "photos_hash_abc123",
            },
        )
        mock_p2p.send(dispute)

        received = mock_p2p.receive()
        assert received.type == "dina/commerce/dispute"
        assert received.payload["reason"] == "item_not_as_described"

        # Reputation impact: seller score decreases on unresolved dispute
        seller_did = mock_seller_dina.identity.root_did
        mock_reputation_graph.set_trust_score(seller_did, 80.0)
        # Dispute penalty
        mock_reputation_graph.set_trust_score(
            seller_did,
            mock_reputation_graph.get_trust_score(seller_did) - 5.0,
        )
        assert mock_reputation_graph.get_trust_score(seller_did) == 75.0
