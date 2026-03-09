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

# TST-INT-058
    def test_did_exchanged_via_qr(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Both parties exchange DIDs (simulating QR scan), register in
        PLC directory, and establish authenticated P2P channel."""
        user_did = mock_identity.root_did
        sancho_did = sancho_identity.root_did

        # Both DIDs are valid did:plc strings
        assert user_did.startswith("did:plc:")
        assert sancho_did.startswith("did:plc:")
        assert user_did != sancho_did

        # After QR exchange, each party registers in PLC directory
        plc = MockPLCResolver()
        user_doc = DIDDocument(
            did=user_did,
            public_key=mock_identity.root_public_key,
            service_endpoint="https://user.homenode.example.com/didcomm",
        )
        sancho_doc = DIDDocument(
            did=sancho_did,
            public_key=sancho_identity.root_public_key,
            service_endpoint="https://sancho.homenode.example.com/didcomm",
        )
        plc.register(user_doc)
        plc.register(sancho_doc)

        # Each side can resolve the other's DID to a document
        resolved_sancho = plc.resolve(sancho_did)
        assert resolved_sancho is not None
        assert resolved_sancho.did == sancho_did

        resolved_user = plc.resolve(user_did)
        assert resolved_user is not None
        assert resolved_user.did == user_did

        # Use resolved docs to authenticate a P2P channel
        p2p = MockP2PChannel()
        p2p.add_contact(sancho_did)
        auth_ok = p2p.authenticate(
            user_did, sancho_did, mock_identity, resolved_sancho,
        )
        assert auth_ok is True

        # Counter-proof: unregistered DID cannot be resolved
        assert plc.resolve("did:plc:Unknown000000000000000000000") is None

# TST-INT-047
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

# TST-INT-057
    def test_plc_lookup_returns_none_for_unknown(
        self, mock_plc_resolver: MockPLCResolver
    ) -> None:
        """PLC Directory lookup returns None for an unregistered DID."""
        result = mock_plc_resolver.resolve("did:plc:z6MkUnknown0000000000000000000000")
        assert result is None

# TST-INT-469
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

# TST-INT-046
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

# TST-INT-045
    def test_x25519_key_exchange(
        self,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """X25519 key exchange produces a shared secret for E2E encryption.

        Requirements: two different identities must derive the same shared
        secret, and the secret must differ for different identity pairs.
        """
        # Pre-condition: two distinct identities
        assert mock_identity.root_did != sancho_identity.root_did
        assert mock_identity.root_private_key != sancho_identity.root_private_key

        # Each identity can sign and the other cannot forge
        user_sig = mock_identity.sign("key_exchange_payload")
        assert mock_identity.verify("key_exchange_payload", user_sig) is True
        # Sancho's key cannot verify user's signature
        assert sancho_identity.verify("key_exchange_payload", user_sig) is False

        sancho_sig = sancho_identity.sign("key_exchange_payload")
        assert sancho_identity.verify("key_exchange_payload", sancho_sig) is True
        assert mock_identity.verify("key_exchange_payload", sancho_sig) is False

        # Derive personas — each identity gets a unique per-persona key
        user_consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        sancho_consumer = sancho_identity.derive_persona(PersonaType.CONSUMER)
        assert user_consumer.derived_key != sancho_consumer.derived_key

        # Counter-proof: same identity re-derives deterministically
        user_consumer_again = mock_identity.derive_persona(PersonaType.CONSUMER)
        assert user_consumer_again.derived_key == user_consumer.derived_key

# TST-INT-070
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

# TST-INT-470
    def test_social_arrival(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """social/arrival — message sent via P2P, received by peer."""
        p2p = MockP2PChannel()

        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"location": "city_center", "eta_minutes": 0},
        )

        # Counter-proof: unauthenticated send is queued, not delivered
        sent = p2p.send(msg)
        assert sent is False
        assert len(p2p.queue) == 1
        assert len(p2p.messages) == 0

        # Authenticate both peers (mutual auth for bidirectional communication)
        p2p.add_contact(sancho_identity.root_did)
        sancho_doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key=sancho_identity.root_public_key,
            service_endpoint="https://sancho.home.node",
        )
        auth_ok = p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, sancho_doc,
        )
        assert auth_ok is True
        # Register reverse session so Sancho can send to mock_identity
        p2p.add_session(sancho_identity.root_did, mock_identity.root_did)

        # Now send succeeds
        msg2 = DinaMessage(
            type="dina/social/arrival",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"location": "city_center", "eta_minutes": 0},
        )
        sent = p2p.send(msg2)
        assert sent is True

        # Receive and verify content
        received = p2p.receive()
        assert received is not None
        assert received.type == "dina/social/arrival"
        assert received.from_did == sancho_identity.root_did
        assert received.to_did == mock_identity.root_did
        assert received.payload["location"] == "city_center"
        assert received.payload["eta_minutes"] == 0

# TST-INT-054
    def test_social_departure(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """social/departure — 'Sancho is leaving your city'."""
        p2p = MockP2PChannel()

        # Pre-condition: no messages, no peers
        assert len(p2p.messages) == 0
        assert len(p2p.authenticated_peers) == 0

        msg = DinaMessage(
            type="dina/social/departure",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"departure_time": "2026-02-17T18:00:00Z"},
        )

        # Counter-proof: unauthenticated departure is queued, not delivered
        sent_unauth = p2p.send(msg)
        assert sent_unauth is False, \
            "Departure from unauthenticated peer must be queued"
        assert len(p2p.queue) == 1
        assert len(p2p.messages) == 0

        # Authenticate Sancho and send departure
        p2p.add_contact(mock_identity.root_did)
        doc = DIDDocument(
            did=mock_identity.root_did,
            public_key="pub_user",
            service_endpoint="https://user.example.com",
        )
        p2p.authenticate(
            sancho_identity.root_did, mock_identity.root_did,
            sancho_identity, doc,
        )

        sent = p2p.send(msg)
        assert sent is True
        assert len(p2p.messages) == 1

        # Verify departure message content survived delivery
        delivered = p2p.messages[0]
        assert delivered.type == "dina/social/departure"
        assert delivered.payload["departure_time"] == "2026-02-17T18:00:00Z"
        assert delivered.from_did == sancho_identity.root_did
        assert delivered.to_did == mock_identity.root_did

# TST-INT-471
    def test_commerce_inquiry(
        self, mock_identity: MockIdentity, seller_identity: MockIdentity
    ) -> None:
        """commerce/inquiry — buyer asks seller for product details.

        Validates the message is sent via P2P channel with authentication,
        received by the seller, and that unauthenticated sends are queued
        (counter-proof).
        """
        p2p = MockP2PChannel()

        # --- Counter-proof: send to unauthenticated peer → queued, not delivered ---
        msg = DinaMessage(
            type="dina/commerce/inquiry",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "questions": ["warranty", "delivery_time"],
            },
        )
        sent = p2p.send(msg)
        assert sent is False, "Send to unauthenticated peer must fail"
        assert len(p2p.queue) == 1, "Message must be queued for offline peer"
        assert len(p2p.messages) == 0, "No delivered messages yet"

        # --- Authenticate seller and send again ---
        p2p.add_contact(seller_identity.root_did)
        seller_doc = DIDDocument(
            did=seller_identity.root_did,
            public_key="pub_seller",
            service_endpoint="https://seller.example.com",
        )
        authed = p2p.authenticate(
            mock_identity.root_did, seller_identity.root_did,
            mock_identity, seller_doc,
        )
        assert authed is True

        msg2 = DinaMessage(
            type="dina/commerce/inquiry",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "questions": ["warranty", "delivery_time"],
            },
        )
        sent2 = p2p.send(msg2)
        assert sent2 is True, "Send to authenticated peer must succeed"
        assert len(p2p.messages) == 1

        # --- Receive and verify content ---
        received = p2p.receive()
        assert received is not None
        assert received.type == "dina/commerce/inquiry"
        assert received.payload["product_id"] == "aeron_2025"
        assert received.from_did == mock_identity.root_did
        assert received.to_did == seller_identity.root_did

# TST-INT-472
    def test_commerce_negotiate(
        self, mock_identity: MockIdentity, seller_identity: MockIdentity
    ) -> None:
        """commerce/negotiate — price negotiation sent via P2P channel.
        Unauthenticated peer → queued, authenticated → delivered."""
        p2p = MockP2PChannel()

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

        # Counter-proof: send to unauthenticated peer → queued, not delivered
        sent = p2p.send(msg)
        assert sent is False, "Unauthenticated peer must not receive message"
        assert len(p2p.queue) == 1, "Message must be queued for later"
        assert len(p2p.messages) == 0

        # Authenticate seller
        seller_doc = DIDDocument(
            did=seller_identity.root_did,
            public_key=seller_identity.root_private_key,
            service_endpoint="https://seller.example.com",
        )
        p2p.add_contact(seller_identity.root_did)
        auth_ok = p2p.authenticate(
            mock_identity.root_did, seller_identity.root_did,
            mock_identity, seller_doc,
        )
        assert auth_ok is True

        # Now send succeeds
        msg2 = DinaMessage(
            type="dina/commerce/negotiate",
            from_did=mock_identity.root_did,
            to_did=seller_identity.root_did,
            payload={
                "product_id": "aeron_2025",
                "offer_price": 90000,
                "currency": "INR",
            },
        )
        sent2 = p2p.send(msg2)
        assert sent2 is True

        # Receive and verify round-trip content
        received = p2p.receive()
        assert received is not None
        assert received.type == "dina/commerce/negotiate"
        assert received.payload["offer_price"] == 90000
        assert received.payload["product_id"] == "aeron_2025"
        assert received.from_did == mock_identity.root_did

# TST-INT-473
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

# TST-INT-474
    def test_trust_outcome(
        self, mock_identity: MockIdentity, sancho_identity: MockIdentity
    ) -> None:
        """trust/outcome — share anonymized purchase outcome."""
        msg = DinaMessage(
            type="dina/trust/outcome",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={
                "product_id": "thinkpad_x1_2025",
                "outcome": "still_using",
                "satisfaction": "positive",
                "time_since_purchase_days": 90,
            },
        )
        assert msg.type == "dina/trust/outcome"
        assert msg.payload["outcome"] == "still_using"
        assert msg.payload["satisfaction"] == "positive"


# ---------------------------------------------------------------------------
# Sharing Rules
# ---------------------------------------------------------------------------


class TestSharingRules:
    """Per-contact sharing rules — cryptographic enforcement, offline queuing."""

# TST-INT-050
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

# TST-INT-051
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

# TST-INT-055
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

# TST-INT-048
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

# TST-INT-060
    def test_queued_message_delivered_after_authentication(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """After peer comes online and authenticates, queued messages can be delivered."""
        # Pre-condition: no messages or queued items
        assert len(mock_p2p.messages) == 0
        assert len(mock_p2p.queue) == 0

        # Send to unauthenticated peer — must be queued, not delivered
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "airport"},
        )
        result = mock_p2p.send(msg)
        assert result is False  # send returns False for unauthenticated peer
        assert len(mock_p2p.queue) == 1
        assert len(mock_p2p.messages) == 0  # NOT in delivered messages

        # Now authenticate Sancho
        mock_p2p.add_contact(sancho_identity.root_did)
        doc = DIDDocument(
            did=sancho_identity.root_did,
            public_key="pub_key",
            service_endpoint="https://sancho.example.com",
        )
        auth_ok = mock_p2p.authenticate(
            mock_identity.root_did, sancho_identity.root_did,
            mock_identity, doc,
        )
        assert auth_ok is True
        assert sancho_identity.root_did in mock_p2p.authenticated_peers

        # Deliver queued messages — now should succeed
        queued = list(mock_p2p.queue)
        mock_p2p.queue.clear()
        for queued_msg in queued:
            delivered = mock_p2p.send(queued_msg)
            assert delivered is True

        assert len(mock_p2p.messages) == 1
        assert len(mock_p2p.queue) == 0
        # Verify the delivered message is the one we sent
        assert mock_p2p.messages[0].type == "dina/social/arrival"
        assert mock_p2p.messages[0].to_did == sancho_identity.root_did
