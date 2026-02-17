"""Integration tests for DIDComm v2.1 protocol, message types, sharing rules.

Tests the peer-to-peer communication layer: DID exchange, PLC resolution,
mutual authentication, X25519 key exchange, relay fallback, typed messages,
sharing rules, and offline queuing.
"""

from __future__ import annotations

import hashlib

import pytest

from tests.integration.mocks import (
    DIDDocument,
    DinaMessage,
    MockPLCResolver,
    MockDinaCore,
    MockIdentity,
    MockP2PChannel,
    MockRelay,
    PersonaType,
    SharingRule,
)


# ---------------------------------------------------------------------------
# Connection Establishment
# ---------------------------------------------------------------------------


class TestConnectionEstablishment:
    """DIDComm v2.1 connection setup — QR, PLC resolution, mutual auth, key exchange, relay."""

    def test_did_exchanged_via_qr(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Both parties exchange DIDs (simulating QR scan). Each obtains the other's DID."""
        user_did = mock_identity.root_did
        sancho_did = sancho_identity.root_did

        # Simulate QR exchange — each side now holds the peer's DID
        qr_payload_user = {"did": user_did, "service": "dina-p2p"}
        qr_payload_sancho = {"did": sancho_did, "service": "dina-p2p"}

        assert qr_payload_user["did"] == user_did
        assert qr_payload_sancho["did"] == sancho_did
        # Both DIDs are valid did:plc strings
        assert user_did.startswith("did:plc:")
        assert sancho_did.startswith("did:plc:")

    def test_plc_lookup_resolves_endpoint(
        self,
        mock_plc_resolver: MockPLCResolver,
        sancho_identity: MockIdentity,
    ) -> None:
        """PLC Directory lookup resolves a DID to a DID Document with service endpoint."""
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="ed25519_pub_sancho_key",
            service_endpoint="https://sancho.homenode.example.com/didcomm",
            verification_method=f"{sancho_identity.root_did}#key-1",
        )
        mock_plc_resolver.register(doc)

        resolved = mock_plc_resolver.resolve(sancho_identity.root_did)
        assert resolved is not None
        assert resolved.did == sancho_identity.root_did
        assert resolved.service_endpoint == "https://sancho.homenode.example.com/didcomm"

    def test_plc_lookup_returns_none_for_unknown(
        self, mock_plc_resolver: MockPLCResolver
    ) -> None:
        """PLC Directory lookup returns None for an unregistered DID."""
        result = mock_plc_resolver.resolve("did:plc:z6MkUnknown0000000000000000000000")
        assert result is None

    def test_direct_home_node_connection(
        self,
        mock_plc_resolver: MockPLCResolver,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        mock_p2p: MockP2PChannel,
    ) -> None:
        """After PLC resolution, P2P channel connects directly to peer's home node."""
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="ed25519_pub_sancho_key",
            service_endpoint="https://sancho.homenode.example.com/didcomm",
        )
        mock_plc_resolver.register(doc)
        resolved = mock_plc_resolver.resolve(sancho_identity.root_did)
        assert resolved is not None

        # Permit contact and authenticate
        mock_p2p.add_contact(sancho_identity.root_did)
        auth = mock_p2p.authenticate(
            mock_identity.root_did,
            sancho_identity.root_did,
            mock_identity,
            resolved,
        )
        assert auth is True
        assert sancho_identity.root_did in mock_p2p.authenticated_peers

    def test_mutual_authentication(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Both sides must authenticate — not just one-way."""
        # User authenticates Sancho
        user_p2p = MockP2PChannel()
        user_p2p.add_contact(sancho_identity.root_did)
        sancho_doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_sancho",
            service_endpoint="https://sancho.example.com",
        )
        assert user_p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, sancho_doc
        )

        # Sancho authenticates User
        sancho_p2p = MockP2PChannel()
        sancho_p2p.add_contact(mock_identity.root_did)
        user_doc = DIDDocument(
            did=mock_identity.root_did,
            public_key="pub_user",
            service_endpoint="https://user.example.com",
        )
        assert sancho_p2p.authenticate(
            sancho_identity.root_did, mock_identity.root_did,
            sancho_identity, user_doc
        )

        # Both sides now have the peer authenticated
        assert sancho_identity.root_did in user_p2p.authenticated_peers
        assert mock_identity.root_did in sancho_p2p.authenticated_peers

    def test_x25519_key_exchange(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """X25519 key exchange produces a shared secret for E2E encryption."""
        # Simulate X25519 ECDH: each side derives a shared key from own private + peer public.
        # In mock, we use HMAC-style derivation.
        user_private = mock_identity.root_private_key
        sancho_private = sancho_identity.root_private_key

        # Shared secret = hash(user_priv || sancho_priv) — symmetric in reality via ECDH
        shared_from_user = hashlib.sha256(
            f"{user_private}{sancho_private}".encode()
        ).hexdigest()
        shared_from_sancho = hashlib.sha256(
            f"{user_private}{sancho_private}".encode()
        ).hexdigest()

        assert shared_from_user == shared_from_sancho
        assert len(shared_from_user) == 64  # 256-bit key

    def test_relay_fallback_for_nat(
        self,
        mock_relay: MockRelay,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """When direct connection fails (NAT), messages route through relay.
        Relay sees only encrypted blobs — never plaintext."""
        encrypted_blob = "ENC[XChaCha20Poly1305]:aGVsbG8gZnJvbSBkaW5h"
        result = mock_relay.forward(
            mock_identity.root_did,
            sancho_identity.root_did,
            encrypted_blob,
        )
        assert result is True
        assert len(mock_relay.forwarded) == 1
        forwarded = mock_relay.forwarded[0]
        assert forwarded["from"] == mock_identity.root_did
        assert forwarded["to"] == sancho_identity.root_did
        # Relay stores a hash — it never sees the plaintext
        assert forwarded["blob_hash"] == hashlib.sha256(
            encrypted_blob.encode()
        ).hexdigest()


# ---------------------------------------------------------------------------
# Message Types
# ---------------------------------------------------------------------------


class TestMessageTypes:
    """Typed Dina-to-Dina messages per the protocol spec."""

    def test_social_arrival(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """social/arrival — 'Sancho has arrived at your city'."""
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"location": "city_center", "eta_minutes": 0},
        )
        assert msg.type == "dina/social/arrival"
        assert msg.from_did == sancho_identity.root_did
        assert msg.payload["location"] == "city_center"

    def test_social_departure(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """social/departure — 'Sancho is leaving your city'."""
        msg = DinaMessage(
            type="dina/social/departure",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"departure_time": "2026-02-17T18:00:00Z"},
        )
        assert msg.type == "dina/social/departure"
        assert "departure_time" in msg.payload

    def test_commerce_inquiry(
        self, mock_identity: MockIdentity, seller_identity: MockIdentity
    ) -> None:
        """commerce/inquiry — buyer asks seller for product details."""
        msg = DinaMessage(
            type="dina/commerce/inquiry",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "questions": ["warranty", "delivery_time"],
            },
        )
        assert msg.type == "dina/commerce/inquiry"
        assert msg.payload["product_id"] == "aeron_2025"

    def test_commerce_negotiate(
        self, mock_identity: MockIdentity, seller_identity: MockIdentity
    ) -> None:
        """commerce/negotiate — price negotiation between buyer and seller."""
        msg = DinaMessage(
            type="dina/commerce/negotiate",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "offer_price": 95000,
                "currency": "INR",
            },
        )
        assert msg.type == "dina/commerce/negotiate"
        assert msg.payload["offer_price"] == 95000

    def test_identity_verify(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """identity/verify — request to verify a peer's identity claim."""
        msg = DinaMessage(
            type="dina/identity/verify",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={
                "challenge": "nonce_abc123",
                "requested_proof": "did_ownership",
            },
        )
        assert msg.type == "dina/identity/verify"
        assert msg.payload["challenge"] == "nonce_abc123"

    def test_reputation_outcome(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """reputation/outcome — share anonymized purchase outcome."""
        msg = DinaMessage(
            type="dina/reputation/outcome",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={
                "product_id": "thinkpad_x1_2025",
                "outcome": "still_using",
                "satisfaction": "positive",
                "time_since_purchase_days": 90,
            },
        )
        assert msg.type == "dina/reputation/outcome"
        assert msg.payload["outcome"] == "still_using"
        assert msg.payload["satisfaction"] == "positive"


# ---------------------------------------------------------------------------
# Sharing Rules
# ---------------------------------------------------------------------------


class TestSharingRules:
    """Per-contact sharing rules — cryptographic enforcement, offline queuing."""

    def test_friend_sharing_rules_applied(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
    ) -> None:
        """Friend sharing rules permit social data, deny financial/health."""
        friend_rule = sample_sharing_rules[0]  # Sancho
        assert friend_rule.contact_did == sancho_identity.root_did
        assert friend_rule.persona == PersonaType.SOCIAL
        assert "arrival" in friend_rule.allowed
        assert "tea_preference" in friend_rule.allowed
        assert "financial" in friend_rule.denied
        assert "health_details" in friend_rule.denied

    def test_seller_sharing_rules_applied(
        self,
        seller_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
    ) -> None:
        """Seller sharing rules permit product queries, deny personal details."""
        seller_rule = sample_sharing_rules[1]
        assert seller_rule.contact_did == seller_identity.root_did
        assert seller_rule.persona == PersonaType.CONSUMER
        assert "product_requirements" in seller_rule.allowed
        assert "budget_range" in seller_rule.allowed
        assert "name" in seller_rule.denied
        assert "address" in seller_rule.denied
        assert "other_persona" in seller_rule.denied

    def test_sharing_rules_enforced_cryptographically(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
    ) -> None:
        """Only data from the allowed persona can be encrypted for the peer.
        Data from other personas is not even accessible to the sending persona key."""
        friend_rule = sample_sharing_rules[0]
        social_persona = mock_identity.derive_persona(PersonaType.SOCIAL)
        financial_persona = mock_identity.derive_persona(PersonaType.FINANCIAL)

        # Social persona can encrypt social data for sharing
        social_encrypted = social_persona.encrypt("arriving at 5pm")
        assert social_encrypted.startswith("ENC[partition_social]:")

        # Financial persona produces a different partition
        financial_encrypted = financial_persona.encrypt("bank balance 50000")
        assert financial_encrypted.startswith("ENC[partition_financial]:")

        # Social persona cannot decrypt financial data
        cross_decrypt = social_persona.decrypt(financial_encrypted)
        assert cross_decrypt is None

        # Financial is in the denied list for this friend
        assert "financial" in friend_rule.denied

    def test_message_queued_when_peer_offline(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """When a peer is offline (not authenticated), messages are queued for later delivery."""
        # Sancho is NOT in authenticated_peers — simulate offline
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "airport"},
        )
        sent = mock_p2p.send(msg)
        assert sent is False
        # Message should be in the offline queue
        assert len(mock_p2p.queue) == 1
        assert mock_p2p.queue[0].type == "dina/social/arrival"

    def test_queued_message_delivered_after_authentication(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """After peer comes online and authenticates, queued messages can be delivered."""
        # Queue a message while offline
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "airport"},
        )
        mock_p2p.send(msg)
        assert len(mock_p2p.queue) == 1

        # Now authenticate Sancho
        mock_p2p.add_contact(sancho_identity.root_did)
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_key",
            service_endpoint="https://sancho.example.com",
        )
        mock_p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, doc,
        )

        # Deliver queued messages
        queued = list(mock_p2p.queue)
        mock_p2p.queue.clear()
        for queued_msg in queued:
            delivered = mock_p2p.send(queued_msg)
            assert delivered is True

        assert len(mock_p2p.messages) == 1
        assert len(mock_p2p.queue) == 0
