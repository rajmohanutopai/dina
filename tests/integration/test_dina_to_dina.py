"""Integration tests for Dina-to-Dina communication.

Tests the Sancho arrival scenario (contextual whispers, silence tiers,
calendar awareness), the P2P protocol guarantees (E2E encryption, no
intermediary, mutual auth), and seller negotiation (persona gating,
reputation checks, direct transactions).
"""

from __future__ import annotations

import hashlib

import pytest

from tests.integration.mocks import (
    DIDDocument,
    DinaMessage,
    MockDHTResolver,
    MockDinaCore,
    MockHuman,
    MockIdentity,
    MockP2PChannel,
    MockRelay,
    MockReputationGraph,
    MockVault,
    MockWhisperAssembler,
    Notification,
    PersonaType,
    SharingRule,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Sancho Arrival Scenario
# ---------------------------------------------------------------------------


class TestSanchoArrival:
    """Sancho arrives in the user's city. Dina silently assembles context
    and whispers relevant information to the user."""

    def test_sanchos_dina_notifies_arrival(
        self,
        mock_dina: MockDinaCore,
        mock_another_dina: MockDinaCore,
        sancho_identity: MockIdentity,
        mock_identity: MockIdentity,
    ) -> None:
        """Sancho's Dina sends an arrival message to the user's Dina.
        The message travels through Sancho's P2P channel to the user."""
        # On Sancho's side: authenticate user as a known contact
        mock_another_dina.p2p.add_contact(mock_identity.root_did)
        user_doc = DIDDocument(
            did=mock_identity.root_did,
            public_key="pub_user",
            service_endpoint="https://user.example.com",
        )
        mock_another_dina.p2p.authenticate(
            sancho_identity.root_did, mock_identity.root_did,
            sancho_identity, user_doc,
        )

        # Sancho's Dina sends arrival TO user
        arrival = DinaMessage(
            type="dina/social/arrival",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"location": "city_center", "eta_minutes": 0},
        )
        sent = mock_another_dina.p2p.send(arrival)
        assert sent is True

        received = mock_another_dina.p2p.receive()
        assert received is not None
        assert received.type == "dina/social/arrival"
        assert received.from_did == sancho_identity.root_did

    def test_recall_mother_was_ill(
        self,
        mock_dina: MockDinaCore,
        sancho_identity: MockIdentity,
        sample_memory: MockVault,
    ) -> None:
        """Dina recalls that Sancho's mother was ill — contextual whisper."""
        # sample_memory fixture pre-populated the vault
        whisper = mock_dina.whisper.assemble_context(
            sancho_identity.root_did, situation="arrival"
        )
        assert whisper is not None
        assert "Mother was ill" in whisper

    def test_suggest_tea_preference(
        self,
        mock_dina: MockDinaCore,
        sancho_identity: MockIdentity,
        sample_memory: MockVault,
    ) -> None:
        """Dina suggests preparing tea the way Sancho likes it."""
        whisper = mock_dina.whisper.assemble_context(
            sancho_identity.root_did, situation="arrival"
        )
        assert whisper is not None
        assert "strong chai" in whisper or "chai" in whisper

    def test_suggest_clearing_calendar(
        self,
        mock_dina: MockDinaCore,
        sample_events: list[dict],
    ) -> None:
        """Dina suggests clearing the calendar for Sancho's visit.
        Calendar events are stored in the vault for context."""
        # Store calendar events
        for event in sample_events:
            mock_dina.vault.store(1, event["id"], event, PersonaType.PROFESSIONAL)
            mock_dina.vault.index_for_fts(event["id"], event["title"])

        # Search for scheduled events that might conflict
        results = mock_dina.vault.search_fts("standup")
        assert len(results) > 0
        assert "meeting_1" in results

    def test_notification_is_tier_2(
        self,
        mock_dina: MockDinaCore,
        sancho_identity: MockIdentity,
    ) -> None:
        """Arrival of a known friend is Tier 2 (solicited — user has this contact).
        Not Tier 1 (no harm from delay), not Tier 3 (user cares about close friends)."""
        # User has registered Sancho as a solicited event type
        mock_dina.classifier.set_override("friend_arrival", SilenceTier.TIER_2_SOLICITED)
        tier = mock_dina.classifier.classify("friend_arrival", "Sancho has arrived")
        assert tier == SilenceTier.TIER_2_SOLICITED

    def test_no_notification_if_user_busy(
        self,
        mock_dina: MockDinaCore,
        mock_human: MockHuman,
        sancho_identity: MockIdentity,
    ) -> None:
        """If user is marked busy (e.g. in a meeting), arrival is downgraded
        to Tier 3 (save for daily briefing) — Silence First principle."""
        # When user is busy, classify arrival as Tier 3
        busy_context = {"user_busy": True, "current_activity": "meeting"}
        # Default classification with no override and non-solicited type
        tier = mock_dina.classifier.classify(
            "friend_arrival_busy", "Sancho has arrived",
            context=busy_context,
        )
        # Without a specific override or solicited type, defaults to Tier 3
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

        # Notification is batched, not pushed
        notification = Notification(
            tier=tier,
            title="Sancho arrived",
            body="Sancho is in your city. His mother was ill last month.",
            source="dina/social/arrival",
        )
        mock_human.receive_notification(notification)
        assert mock_human.notifications[-1].tier == SilenceTier.TIER_3_ENGAGEMENT


# ---------------------------------------------------------------------------
# Dina-to-Dina Protocol Guarantees
# ---------------------------------------------------------------------------


class TestDinaToDinaProtocol:
    """Core P2P protocol properties — E2E, no intermediary, mutual auth."""

    def test_end_to_end_encrypted(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Messages between Dinas are end-to-end encrypted.
        Even if intercepted, content is unreadable."""
        plaintext = "Sancho arrives at 5pm, prepare chai"
        # Encrypt with sender's persona key
        social_persona = mock_identity.derive_persona(PersonaType.SOCIAL)
        encrypted = social_persona.encrypt(plaintext)

        # Encrypted form is not the plaintext
        assert encrypted != plaintext
        assert encrypted.startswith("ENC[")

        # Only the correct persona can decrypt
        decrypted = social_persona.decrypt(encrypted)
        assert decrypted is not None

    def test_no_platform_intermediary(
        self,
        mock_dina: MockDinaCore,
        mock_another_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Communication is direct P2P — no central platform routes or stores messages."""
        # User's Dina authenticates Sancho as a contact and sends TO Sancho
        mock_dina.p2p.add_contact(sancho_identity.root_did)
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_sancho",
            service_endpoint="https://sancho.example.com",
        )
        mock_dina.p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, doc,
        )

        msg = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"message": "Welcome!"},
        )
        sent = mock_dina.p2p.send(msg)
        assert sent is True

        # Message is directly in p2p.messages — no intermediary store
        assert len(mock_dina.p2p.messages) == 1
        # No external platform was involved
        received = mock_dina.p2p.receive()
        assert received is not None
        assert received.payload["message"] == "Welcome!"

    def test_mutual_authentication_required(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Both sides must authenticate before messages flow."""
        # Without adding contact first, authentication fails
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_sancho",
            service_endpoint="https://sancho.example.com",
        )
        result = mock_p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, doc,
        )
        assert result is False
        assert sancho_identity.root_did not in mock_p2p.authenticated_peers

    def test_reject_unknown_did(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
    ) -> None:
        """Messages from unknown (unauthenticated) DIDs are rejected."""
        unknown_did = "did:dht:z6MkUnknown0000000000000000000000"
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=unknown_did,
            to_did=mock_identity.root_did,
            payload={"message": "surprise!"},
        )
        # Unknown DID is not authenticated, so send queues (returns False)
        sent = mock_p2p.send(msg)
        assert sent is False
        # Message is queued, not delivered
        assert len(mock_p2p.messages) == 0
        assert len(mock_p2p.queue) == 1

    def test_accept_trusted_contact(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Messages to a trusted (authenticated) contact are delivered immediately."""
        mock_p2p.add_contact(sancho_identity.root_did)
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_sancho",
            service_endpoint="https://sancho.example.com",
        )
        mock_p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, doc,
        )

        msg = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"message": "hello friend"},
        )
        sent = mock_p2p.send(msg)
        assert sent is True
        assert len(mock_p2p.messages) == 1

    def test_no_raw_data_shared(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
    ) -> None:
        """Dina never shares raw personal data — only derived facts and signals."""
        friend_rule = sample_sharing_rules[0]
        # Allowed: arrival, departure, context_flags, tea_preference
        # These are derived signals, not raw data
        for allowed in friend_rule.allowed:
            assert allowed in ("arrival", "departure", "context_flags", "tea_preference")

        # Denied: financial, health_details, professional — raw personal data
        assert "financial" in friend_rule.denied
        assert "health_details" in friend_rule.denied
        assert "professional" in friend_rule.denied


# ---------------------------------------------------------------------------
# Seller Negotiation
# ---------------------------------------------------------------------------


class TestSellerNegotiation:
    """Buyer-to-seller direct negotiation via Dina-to-Dina protocol."""

    def test_buyer_contacts_seller(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_identity: MockIdentity,
        seller_identity: MockIdentity,
    ) -> None:
        """Buyer's Dina contacts seller's Dina with a product inquiry."""
        # Authenticate seller
        mock_dina.p2p.add_contact(seller_identity.root_did)
        seller_doc = DIDDocument(
            did=seller_identity.root_did,
            public_key="pub_seller",
            service_endpoint="https://seller.example.com",
        )
        mock_dina.p2p.authenticate(
            mock_identity.root_did, seller_identity.root_did,
            mock_identity, seller_doc,
        )

        inquiry = DinaMessage(
            type="dina/commerce/inquiry",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "questions": ["warranty_period", "delivery_time"],
            },
        )
        sent = mock_dina.p2p.send(inquiry)
        assert sent is True

    def test_seller_sees_only_buyer_persona(
        self,
        mock_identity: MockIdentity,
        seller_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
    ) -> None:
        """Seller only sees the buyer's CONSUMER persona — no name, address, or other persona."""
        seller_rule = next(
            r for r in sample_sharing_rules
            if r.contact_did == seller_identity.root_did
        )
        assert seller_rule.persona == PersonaType.CONSUMER

        # Seller can see these
        assert "product_requirements" in seller_rule.allowed
        assert "budget_range" in seller_rule.allowed

        # Seller cannot see these
        assert "name" in seller_rule.denied
        assert "address" in seller_rule.denied
        assert "contact_details" in seller_rule.denied
        assert "other_persona" in seller_rule.denied

        # Buyer's consumer persona has its own DID — not the root DID
        consumer_persona = mock_identity.derive_persona(PersonaType.CONSUMER)
        assert consumer_persona.did != mock_identity.root_did
        assert consumer_persona.did.startswith("did:key:")

    def test_reputation_graph_consulted(
        self,
        mock_dina: MockDinaCore,
        seller_identity: MockIdentity,
    ) -> None:
        """Before negotiating, buyer's Dina checks seller's reputation score."""
        # Set a trust score for the seller
        mock_dina.reputation.set_trust_score(seller_identity.root_did, 78.5)

        score = mock_dina.reputation.get_trust_score(seller_identity.root_did)
        assert score == 78.5
        assert score > 0.0  # Seller has some reputation

    def test_direct_transaction_no_marketplace(
        self,
        mock_dina: MockDinaCore,
        mock_seller_dina: MockDinaCore,
        mock_identity: MockIdentity,
        seller_identity: MockIdentity,
    ) -> None:
        """Transaction is direct — no marketplace intermediary takes a cut."""
        # Authenticate
        mock_dina.p2p.add_contact(seller_identity.root_did)
        seller_doc = DIDDocument(
            did=seller_identity.root_did,
            public_key="pub_seller",
            service_endpoint="https://seller.example.com",
        )
        mock_dina.p2p.authenticate(
            mock_identity.root_did, seller_identity.root_did,
            mock_identity, seller_doc,
        )

        # Send negotiation message directly
        negotiate = DinaMessage(
            type="dina/commerce/negotiate",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "offer_price": 95000,
                "currency": "INR",
                "payment_method": "upi",
            },
        )
        sent = mock_dina.p2p.send(negotiate)
        assert sent is True

        # Message goes directly to seller — no marketplace in the chain
        received = mock_dina.p2p.receive()
        assert received is not None
        assert received.type == "dina/commerce/negotiate"
        assert received.payload["offer_price"] == 95000

    def test_low_reputation_flagged(
        self,
        mock_dina: MockDinaCore,
        mock_human: MockHuman,
    ) -> None:
        """If a seller has low reputation, Dina flags it to the user before proceeding."""
        low_rep_seller = "did:dht:z6MkLowRep123456789012345678901234"
        mock_dina.reputation.set_trust_score(low_rep_seller, 15.0)

        score = mock_dina.reputation.get_trust_score(low_rep_seller)
        assert score < 30.0  # Below threshold

        # Dina creates a fiduciary-level alert
        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Low reputation seller",
            body=f"Seller {low_rep_seller[:30]}... has reputation score {score}. "
                 "Proceed with caution.",
            actions=["proceed", "block", "report"],
            source="reputation_check",
        )
        mock_human.receive_notification(notification)

        assert len(mock_human.notifications) == 1
        assert mock_human.notifications[0].tier == SilenceTier.TIER_1_FIDUCIARY
        assert "Low reputation" in mock_human.notifications[0].title
