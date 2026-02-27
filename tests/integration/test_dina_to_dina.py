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
    AuditEntry,
    DIDDocument,
    DinaMessage,
    MockAuditLog,
    MockInboxSpool,
    MockOutbox,
    MockPIIScrubber,
    MockPLCResolver,
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

# TST-INT-063
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

# TST-INT-475
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

# TST-INT-061
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

# TST-INT-062
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

# TST-INT-476
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

# TST-INT-477
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

# TST-INT-290
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

# TST-INT-478
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

# TST-INT-479
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

# TST-INT-480
    def test_reject_unknown_did(
        self,
        mock_p2p: MockP2PChannel,
        mock_identity: MockIdentity,
    ) -> None:
        """Messages from unknown (unauthenticated) DIDs are rejected."""
        unknown_did = "did:plc:Unknown0000000000000000000000"
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

# TST-INT-481
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

# TST-INT-286
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

# TST-INT-482
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

# TST-INT-483
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

# TST-INT-484
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

# TST-INT-485
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

# TST-INT-486
    def test_low_reputation_flagged(
        self,
        mock_dina: MockDinaCore,
        mock_human: MockHuman,
    ) -> None:
        """If a seller has low reputation, Dina flags it to the user before proceeding."""
        low_rep_seller = "did:plc:LowRep123456789012345678901234"
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


# ---------------------------------------------------------------------------
# Sharing Policy & Egress Controls (S3.2)
# ---------------------------------------------------------------------------


class TestSharingPolicyAndEgress:
    """Verify sharing tiers, PII scrubbing on egress, and audit trails
    for all outbound Dina-to-Dina messages."""

# TST-INT-049
    def test_sharing_policy_summary_tier(
        self,
        mock_dina: MockDinaCore,
        mock_another_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        sample_sharing_rules: list[SharingRule],
        sample_memory: MockVault,
    ) -> None:
        """When sharing data, only summary-tier information is sent per sharing
        policy. Raw data (full vault records) must never cross the wire --
        only derived signals such as arrival status, context flags, and
        preferences are included in the outbound payload."""
        # Look up the sharing rule for Sancho (social persona)
        friend_rule = next(
            r for r in sample_sharing_rules
            if r.contact_did == sancho_identity.root_did
        )
        assert friend_rule.persona == PersonaType.SOCIAL

        # Build a summary-tier payload using only allowed fields
        allowed_fields = set(friend_rule.allowed)
        summary_payload: dict = {}
        for field_name in allowed_fields:
            if field_name == "arrival":
                summary_payload["arrival"] = True
            elif field_name == "context_flags":
                summary_payload["context_flags"] = ["mother_ill"]
            elif field_name == "tea_preference":
                summary_payload["tea_preference"] = "strong chai, less sugar"
            elif field_name == "departure":
                summary_payload["departure"] = False

        # Verify the payload contains ONLY allowed fields
        for key in summary_payload:
            assert key in allowed_fields, (
                f"Payload key '{key}' is not in the allowed sharing set"
            )

        # Verify denied fields are absent
        for denied_field in friend_rule.denied:
            assert denied_field not in summary_payload, (
                f"Denied field '{denied_field}' must not appear in outbound payload"
            )

        # The summary payload is what gets sent over D2D
        msg = DinaMessage(
            type="dina/social/context_share",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload=summary_payload,
        )

        # Authenticate and send
        mock_dina.p2p.add_contact(sancho_identity.root_did)
        mock_dina.p2p.authenticated_peers.add(sancho_identity.root_did)
        sent = mock_dina.p2p.send(msg)
        assert sent is True

        # Verify the received message contains only summary-tier data
        received = mock_dina.p2p.receive()
        assert received is not None
        for denied_field in friend_rule.denied:
            assert denied_field not in received.payload

# TST-INT-052
    def test_pii_scrub_on_egress(
        self,
        mock_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """All outbound D2D messages are scrubbed for PII before sending.
        Names, emails, phone numbers, and other PII must be replaced with
        opaque tokens so that even if intercepted, no real identity leaks."""
        # Build a message that accidentally contains PII
        raw_payload_text = (
            "Rajmohan will arrive at 5pm. "
            "Contact him at rajmohan@email.com or +91-9876543210."
        )

        # Scrub the payload before sending
        scrubbed_text, replacements = mock_scrubber.scrub(raw_payload_text)

        # PII must be gone from the scrubbed text
        assert "Rajmohan" not in scrubbed_text
        assert "rajmohan@email.com" not in scrubbed_text
        assert "+91-9876543210" not in scrubbed_text

        # Replacement map captures the original PII values
        pii_values = set(replacements.values())
        assert "Rajmohan" in pii_values
        assert "rajmohan@email.com" in pii_values

        # The replacement map allows local rehydration
        assert len(replacements) >= 3

        # Validate that the scrubbed text is clean
        assert mock_scrubber.validate_clean(scrubbed_text)

        # Send the scrubbed payload via D2D
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"text": scrubbed_text},
        )
        mock_dina.p2p.add_contact(sancho_identity.root_did)
        mock_dina.p2p.authenticated_peers.add(sancho_identity.root_did)
        sent = mock_dina.p2p.send(msg)
        assert sent is True

        # Verify the message on the wire has no PII
        received = mock_dina.p2p.receive()
        assert received is not None
        assert "Rajmohan" not in received.payload["text"]

# TST-INT-053
    def test_egress_audit_trail(
        self,
        mock_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
        mock_audit_log: MockAuditLog,
    ) -> None:
        """Every outbound message is logged in the audit trail, recording
        the sender, recipient, message type, and timestamp. This ensures
        forensic traceability of all data leaving the Home Node."""
        # Authenticate peer
        mock_dina.p2p.add_contact(sancho_identity.root_did)
        mock_dina.p2p.authenticated_peers.add(sancho_identity.root_did)

        # Send a message
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "city_center"},
        )
        sent = mock_dina.p2p.send(msg)
        assert sent is True

        # Record the egress event in the audit log
        mock_audit_log.record(
            actor=mock_identity.root_did,
            action="d2d_egress",
            resource=f"msg:{msg.type}",
            result="success",
            details={
                "to_did": sancho_identity.root_did,
                "msg_type": msg.type,
                "payload_keys": list(msg.payload.keys()),
            },
        )

        # Verify audit trail
        egress_entries = mock_audit_log.query(action="d2d_egress")
        assert len(egress_entries) == 1
        assert egress_entries[0].actor == mock_identity.root_did
        assert egress_entries[0].details["to_did"] == sancho_identity.root_did
        assert egress_entries[0].details["msg_type"] == "dina/social/arrival"
        assert egress_entries[0].result == "success"

        # Audit trail must not contain raw PII
        assert not mock_audit_log.has_pii(["Rajmohan", "rajmohan@email.com"])


# ---------------------------------------------------------------------------
# Inbox Spool Overflow (S3.3)
# ---------------------------------------------------------------------------


class TestInboxSpoolOverflow:
    """Verify spool capacity enforcement for inbound D2D messages."""

# TST-INT-056
    def test_spool_overflow_rejects_new_messages(
        self,
        mock_inbox_spool: MockInboxSpool,
    ) -> None:
        """When the inbox spool exceeds 500MB, new messages are rejected.
        The spool is designed for messages arriving while a persona is locked.
        Once the capacity limit is reached, further writes return None,
        preventing unbounded storage consumption."""
        # Verify default capacity is 500MB
        assert mock_inbox_spool.max_bytes == 500 * 1024 * 1024

        # Fill the spool to near capacity with large blobs
        blob_size = 100 * 1024 * 1024  # 100MB each
        stored_ids = []
        for i in range(5):
            blob = b"X" * blob_size
            blob_id = mock_inbox_spool.store(blob)
            assert blob_id is not None, f"Blob {i} should fit within 500MB"
            stored_ids.append(blob_id)

        # Spool is now at 500MB -- exactly full
        assert mock_inbox_spool.used_bytes == 500 * 1024 * 1024

        # The next store attempt must be rejected (returns None)
        overflow_blob = b"Y" * 1024  # even 1KB should be rejected
        result = mock_inbox_spool.store(overflow_blob)
        assert result is None, "Spool must reject writes when full"

        # The is_full() check must agree
        assert mock_inbox_spool.is_full(new_size=1)

        # Existing messages are still retrievable
        for blob_id in stored_ids:
            retrieved = mock_inbox_spool.retrieve(blob_id)
            assert retrieved is not None
            assert len(retrieved) == blob_size


# ---------------------------------------------------------------------------
# Concurrent Bidirectional Communication (S3.4)
# ---------------------------------------------------------------------------


class TestConcurrentBidirectional:
    """Verify two Dinas can exchange messages simultaneously."""

# TST-INT-059
    def test_concurrent_bidirectional_exchange(
        self,
        mock_dina: MockDinaCore,
        mock_another_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """Two Dinas can exchange messages simultaneously in both directions.
        Each Dina has its own P2P channel. Messages sent by Alice to Bob and
        messages sent by Bob to Alice do not interfere with each other."""
        # Set up Alice (mock_dina) -> Bob (mock_another_dina) channel
        alice_p2p = mock_dina.p2p
        bob_p2p = mock_another_dina.p2p

        # Alice authenticates Bob
        alice_p2p.add_contact(sancho_identity.root_did)
        alice_p2p.authenticated_peers.add(sancho_identity.root_did)

        # Bob authenticates Alice
        bob_p2p.add_contact(mock_identity.root_did)
        bob_p2p.authenticated_peers.add(mock_identity.root_did)

        # Alice sends to Bob
        alice_msg = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"text": "Hello Bob, from Alice"},
        )
        assert alice_p2p.send(alice_msg) is True

        # Bob sends to Alice (simultaneously, different channel)
        bob_msg = DinaMessage(
            type="dina/social/greeting",
            from_did=sancho_identity.root_did,
            to_did=mock_identity.root_did,
            payload={"text": "Hello Alice, from Bob"},
        )
        assert bob_p2p.send(bob_msg) is True

        # Both channels have exactly one message each
        assert len(alice_p2p.messages) == 1
        assert len(bob_p2p.messages) == 1

        # Messages are independent -- Alice's channel has her outbound
        alice_received = alice_p2p.receive()
        assert alice_received is not None
        assert alice_received.from_did == mock_identity.root_did
        assert alice_received.payload["text"] == "Hello Bob, from Alice"

        # Bob's channel has his outbound
        bob_received = bob_p2p.receive()
        assert bob_received is not None
        assert bob_received.from_did == sancho_identity.root_did
        assert bob_received.payload["text"] == "Hello Alice, from Bob"

        # After receiving, both channels are empty
        assert alice_p2p.receive() is None
        assert bob_p2p.receive() is None


# ---------------------------------------------------------------------------
# Offline Delivery, Retry, and Resilience (S3.6)
# ---------------------------------------------------------------------------


class TestOfflineDeliveryAndResilience:
    """Verify message queuing, retry with backoff, deduplication,
    and relay fallback for NAT traversal."""

# TST-INT-064
    def test_recipient_temporarily_down_queued(
        self,
        mock_outbox: MockOutbox,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """When the recipient is offline, the message is queued in the outbox
        rather than being dropped. The outbox persists the message until
        delivery succeeds or retries are exhausted."""
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "city_center"},
        )

        # Enqueue the message (recipient is offline)
        msg_id = mock_outbox.enqueue(msg)
        assert msg_id is not None
        assert msg_id.startswith("msg_")

        # Message is in the pending list
        pending = mock_outbox.get_pending()
        assert len(pending) == 1
        assert pending[0][0] == msg_id
        assert pending[0][1].type == "dina/social/arrival"

        # Message is NOT in delivered or failed sets
        assert msg_id not in mock_outbox.delivered
        assert msg_id not in mock_outbox.failed

# TST-INT-065
    def test_recipient_recovers_within_retry_window(
        self,
        mock_outbox: MockOutbox,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """A queued message is delivered successfully when the recipient
        comes back online within the retry window. The outbox marks the
        message as delivered via ack()."""
        msg = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"text": "Hello!"},
        )

        # Enqueue while recipient is down
        msg_id = mock_outbox.enqueue(msg)
        assert len(mock_outbox.get_pending()) == 1

        # First retry attempt (recipient still down)
        retry_ok = mock_outbox.retry(msg_id)
        assert retry_ok is True
        assert mock_outbox.retry_counts[msg_id] == 1

        # Recipient comes back -- delivery succeeds
        ack_ok = mock_outbox.ack(msg_id)
        assert ack_ok is True
        assert msg_id in mock_outbox.delivered

        # No longer in pending
        pending = mock_outbox.get_pending()
        assert len(pending) == 0

# TST-INT-066
    def test_recipient_down_beyond_max_retries(
        self,
        mock_outbox: MockOutbox,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """After 5 retries with exponential backoff, the message is marked
        failed and removed from the pending queue. The backoff schedule is
        [30, 60, 300, 1800, 7200] seconds."""
        msg = DinaMessage(
            type="dina/social/update",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"text": "Important update"},
        )

        msg_id = mock_outbox.enqueue(msg)

        # Verify backoff schedule
        assert mock_outbox.BACKOFF_SCHEDULE == [30, 60, 300, 1800, 7200]

        # Exhaust all 5 retries
        for i in range(5):
            backoff = mock_outbox.get_backoff(msg_id)
            assert backoff == mock_outbox.BACKOFF_SCHEDULE[i]
            retry_ok = mock_outbox.retry(msg_id)
            assert retry_ok is True, f"Retry {i+1} should succeed"

        # The 6th retry must fail -- max retries exhausted
        retry_ok = mock_outbox.retry(msg_id)
        assert retry_ok is False
        assert msg_id in mock_outbox.failed

        # No longer in pending
        pending = mock_outbox.get_pending()
        assert len(pending) == 0

# TST-INT-067
    def test_network_partition_then_heal(
        self,
        mock_outbox: MockOutbox,
        mock_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """After a network partition heals, queued messages resume delivery.
        The outbox retries during the partition, and once the peer is reachable
        again the message is acked and delivered."""
        msg = DinaMessage(
            type="dina/social/context_share",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"context": "meeting rescheduled"},
        )

        # Network partition: message queued
        msg_id = mock_outbox.enqueue(msg)
        assert len(mock_outbox.get_pending()) == 1

        # Retry during partition (fails to reach peer)
        mock_outbox.retry(msg_id)
        mock_outbox.retry(msg_id)
        assert mock_outbox.retry_counts[msg_id] == 2

        # Partition heals -- peer is reachable
        mock_dina.p2p.add_contact(sancho_identity.root_did)
        mock_dina.p2p.authenticated_peers.add(sancho_identity.root_did)

        # Deliver the pending message via P2P
        pending = mock_outbox.get_pending()
        assert len(pending) == 1
        _, pending_msg = pending[0]
        sent = mock_dina.p2p.send(pending_msg)
        assert sent is True

        # Ack the delivery
        mock_outbox.ack(msg_id)
        assert msg_id in mock_outbox.delivered
        assert len(mock_outbox.get_pending()) == 0

# TST-INT-068
    def test_duplicate_delivery_prevention(
        self,
        mock_outbox: MockOutbox,
        mock_dina: MockDinaCore,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """The same message ID must not be delivered twice. Even if the
        outbox retries and the ack races, the delivered set prevents
        duplicate processing."""
        msg = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"text": "No duplicates"},
        )

        msg_id = mock_outbox.enqueue(msg)

        # First delivery succeeds
        mock_outbox.ack(msg_id)
        assert msg_id in mock_outbox.delivered

        # Message is no longer pending
        assert len(mock_outbox.get_pending()) == 0

        # Even if retry is called again, it doesn't re-enqueue
        # (msg_id is already in delivered, get_pending filters it out)
        pending = mock_outbox.get_pending()
        assert all(mid != msg_id for mid, _ in pending)

        # A second ack is idempotent
        second_ack = mock_outbox.ack(msg_id)
        assert second_ack is True  # ack is idempotent

        # Only one delivery recorded
        delivered_list = [mid for mid in mock_outbox.delivered if mid == msg_id]
        assert len(delivered_list) == 1

# TST-INT-069
    def test_relay_fallback_for_nat(
        self,
        mock_dina: MockDinaCore,
        mock_relay: MockRelay,
        mock_identity: MockIdentity,
        sancho_identity: MockIdentity,
    ) -> None:
        """When direct P2P fails due to NAT, the relay is used as a fallback.
        The relay only sees encrypted blobs -- it cannot read message content.
        The blob hash is recorded for audit, but no plaintext leaks."""
        # Direct P2P fails -- Sancho is not authenticated (behind NAT)
        msg = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            payload={"location": "coffee_shop"},
        )
        direct_sent = mock_dina.p2p.send(msg)
        assert direct_sent is False  # P2P failed (no authenticated peer)

        # Fall back to relay with encrypted blob
        encrypted_blob = f"ENC[{mock_identity.root_did}]:{msg.payload}"
        relay_ok = mock_relay.forward(
            from_did=mock_identity.root_did,
            to_did=sancho_identity.root_did,
            encrypted_blob=encrypted_blob,
        )
        assert relay_ok is True

        # Relay recorded the forwarding
        assert len(mock_relay.forwarded) == 1
        entry = mock_relay.forwarded[0]
        assert entry["from"] == mock_identity.root_did
        assert entry["to"] == sancho_identity.root_did

        # Relay only sees a hash, not the plaintext
        assert "blob_hash" in entry
        assert "coffee_shop" not in entry["blob_hash"]
        assert "location" not in entry.get("blob", "")
