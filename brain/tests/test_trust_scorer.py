"""Unit tests for TrustScorer — source trust and provenance assignment.

Tests the trust scoring rules:
    - User content → self / high / normal
    - Known contact (trusted) → contact_ring1 / high / normal
    - Known contact (unknown trust) → contact_ring2 / medium / normal
    - Verified service domain → service / high / normal
    - Unknown sender → unknown / low / caveated
    - Marketing/noreply → marketing / low / briefing_only
    - Missing sender on service item → caveated (never silently normal)
"""

from __future__ import annotations

import pytest

from src.service.trust_scorer import TrustScorer
from src.gen.core_types import Contact


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def scorer() -> TrustScorer:
    """TrustScorer with a known contact list."""
    contacts = [
        Contact(did="did:plc:sancho", trust_level="trusted", name="Sancho"),
        Contact(did="did:plc:albert", trust_level="unknown", name="Albert"),
    ]
    return TrustScorer(contacts=contacts)


@pytest.fixture
def empty_scorer() -> TrustScorer:
    """TrustScorer with no contacts."""
    return TrustScorer()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_user_content_self_high_normal(scorer):
    """User-created content (CLI, admin) gets self / high / normal."""
    item = {"source": "user", "sender": "", "type": "note"}
    result = scorer.score(item)
    assert result["sender_trust"] == "self"
    assert result["source_type"] == "self"
    assert result["confidence"] == "high"
    assert result["retrieval_policy"] == "normal"
    assert result["sender"] == "user"


def test_cli_source_is_self(scorer):
    """CLI source is treated the same as user."""
    item = {"source": "cli", "sender": "", "type": "note"}
    result = scorer.score(item)
    assert result["sender_trust"] == "self"
    assert result["source_type"] == "self"
    assert result["confidence"] == "high"


def test_known_contact_trusted_ring1(scorer):
    """Known contact with trust_level=trusted → contact_ring1 / high / normal + contact_did."""
    item = {"source": "gmail", "sender": "sancho@example.com",
            "contact_did": "did:plc:sancho", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring1"
    assert result["source_type"] == "contact"
    assert result["confidence"] == "high"
    assert result["retrieval_policy"] == "normal"
    assert result["contact_did"] == "did:plc:sancho"


def test_known_contact_unknown_trust_ring2(scorer):
    """Known contact with trust_level=unknown → contact_ring2 / medium / normal."""
    item = {"source": "gmail", "sender": "albert@example.com",
            "contact_did": "did:plc:albert", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring2"
    assert result["source_type"] == "contact"
    assert result["confidence"] == "medium"
    assert result["retrieval_policy"] == "normal"


def test_verified_service_domain(scorer):
    """Email from a verified service domain → service / high / normal."""
    item = {"source": "gmail", "sender": "alerts@hdfcbank.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring2"
    assert result["source_type"] == "service"
    assert result["confidence"] == "high"
    assert result["retrieval_policy"] == "normal"


def test_unknown_sender_caveated(scorer):
    """Unknown sender → unknown / low / caveated."""
    item = {"source": "gmail", "sender": "random@unknown-domain.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "unknown"
    assert result["source_type"] == "unknown"
    assert result["confidence"] == "low"
    assert result["retrieval_policy"] == "caveated"


def test_marketing_sender_briefing_only(scorer):
    """Marketing/noreply sender → marketing / low / briefing_only."""
    for sender in ["noreply@shop.com", "no-reply@service.com",
                    "deals@promo.example.com"]:
        item = {"source": "gmail", "sender": sender, "type": "email"}
        result = scorer.score(item)
        assert result["sender_trust"] == "marketing", f"failed for {sender}"
        assert result["source_type"] == "marketing", f"failed for {sender}"
        assert result["confidence"] == "low", f"failed for {sender}"
        assert result["retrieval_policy"] == "briefing_only", f"failed for {sender}"


def test_missing_sender_on_service_item_caveated(empty_scorer):
    """Missing sender on a service-ingested item defaults to caveated, not normal.

    This prevents service-ingested items from silently becoming trusted.
    """
    item = {"source": "gmail", "sender": "", "type": "email"}
    result = empty_scorer.score(item)
    assert result["retrieval_policy"] == "caveated"
    assert result["confidence"] == "low"
    assert result["sender_trust"] == "unknown"


def test_telegram_source_is_self(scorer):
    """Telegram messages from the user are self-authored."""
    item = {"source": "telegram", "sender": "", "type": "note"}
    result = scorer.score(item)
    assert result["sender_trust"] == "self"
    assert result["source_type"] == "self"


def test_subdomain_of_verified_service(scorer):
    """Subdomain of a verified domain (e.g. mail.google.com) is trusted."""
    item = {"source": "gmail", "sender": "alert@mail.google.com", "type": "email"}
    result = scorer.score(item)
    assert result["source_type"] == "service"
    assert result["confidence"] == "high"


def test_update_contacts(empty_scorer):
    """Updating contacts changes scoring for known DIDs."""
    item = {"source": "gmail", "sender": "new@example.com",
            "contact_did": "did:plc:newcontact", "type": "email"}

    # Before adding contact: unknown
    result = empty_scorer.score(item)
    assert result["sender_trust"] == "unknown"

    # After adding contact: known
    empty_scorer.update_contacts([
        Contact(did="did:plc:newcontact", name="New Contact", trust_level="trusted"),
    ])
    result = empty_scorer.score(item)
    assert result["sender_trust"] == "contact_ring1"


# ---------------------------------------------------------------------------
# Sender-based contact matching (no contact_did on item)
# ---------------------------------------------------------------------------


def test_sender_matches_contact_by_name_when_name_is_email():
    """Contact whose name IS the email address matches connector items by sender."""
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:sharma", name="dr.sharma@clinic.com", trust_level="verified"),
    ])
    # No contact_did — sender matches contact name exactly.
    item = {"source": "gmail", "sender": "dr.sharma@clinic.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring1"
    assert result["contact_did"] == "did:plc:sharma"


def test_sender_matches_contact_by_alias():
    """Contact with alias set to email matches connector items by sender.

    This is the recommended way to associate emails with contacts:
    set the alias field to the email address via admin CLI or API.
    """
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:sharma", name="Dr Sharma",
                alias="dr.sharma@clinic.com", trust_level="verified"),
    ])
    # No contact_did — sender matches contact alias.
    item = {"source": "gmail", "sender": "dr.sharma@clinic.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring1"
    assert result["contact_did"] == "did:plc:sharma"


def test_sender_no_match_when_name_differs_from_email():
    """Contact name 'Dr Sharma' does NOT match sender 'dr.sharma@clinic.com'.

    This is expected — name-based matching only works when the contact's
    name or alias is set to the email address. Without that association,
    the sender is unknown.
    """
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:sharma", name="Dr Sharma", trust_level="verified"),
    ])
    item = {"source": "gmail", "sender": "dr.sharma@clinic.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "unknown"
    assert result.get("contact_did", "") == ""


def test_sender_matching_case_insensitive():
    """Sender matching is case-insensitive."""
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:alice", name="Alice", alias="Alice@Example.COM", trust_level="trusted"),
    ])
    item = {"source": "gmail", "sender": "alice@example.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "contact_ring1"
    assert result["contact_did"] == "did:plc:alice"


def test_sender_no_match_stays_unknown():
    """Sender that doesn't match any contact name or alias remains unknown."""
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:bob", name="Bob", trust_level="trusted"),
    ])
    item = {"source": "gmail", "sender": "stranger@unknown.com", "type": "email"}
    result = scorer.score(item)
    assert result["sender_trust"] == "unknown"
    assert result.get("contact_did", "") == ""


def test_contact_did_takes_priority_over_sender():
    """Explicit contact_did match takes priority over sender-based match."""
    scorer = TrustScorer(contacts=[
        Contact(did="did:plc:alice", name="alice@a.com", trust_level="trusted"),
        Contact(did="did:plc:bob", name="alice@a.com", trust_level="unknown"),
    ])
    # contact_did explicitly points to alice
    item = {"source": "gmail", "sender": "alice@a.com",
            "contact_did": "did:plc:alice", "type": "email"}
    result = scorer.score(item)
    assert result["contact_did"] == "did:plc:alice"
    assert result["sender_trust"] == "contact_ring1"


# ---------------------------------------------------------------------------
# Ingress-channel based scoring (server-derived provenance)
# ---------------------------------------------------------------------------


class TestIngressChannelScoring:
    """Tests for the primary provenance path — (ingress_channel, origin_kind).

    When ingress_channel is set (by Core's auth middleware), it takes
    precedence over source-string matching. This prevents trust spoofing
    by connectors that could set source="telegram".
    """

    def test_cli_user_self_high_normal(self, scorer):
        """(cli, user) → self / high / normal."""
        item = {"ingress_channel": "cli", "origin_kind": "user",
                "sender": "user", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "self"
        assert result["source_type"] == "self"
        assert result["confidence"] == "high"
        assert result["retrieval_policy"] == "normal"
        assert result["sender"] == "user"

    def test_cli_agent_unknown_medium_caveated(self, scorer):
        """(cli, agent) → unknown / medium / caveated."""
        item = {"ingress_channel": "cli", "origin_kind": "agent",
                "sender": "agent", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["source_type"] == "service"
        assert result["confidence"] == "medium"
        assert result["retrieval_policy"] == "caveated"

    def test_telegram_self_high_normal(self, scorer):
        """(telegram) → self / high / normal — user's own Telegram messages."""
        item = {"ingress_channel": "telegram", "sender": "", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "self"
        assert result["source_type"] == "self"
        assert result["confidence"] == "high"
        assert result["retrieval_policy"] == "normal"

    def test_admin_self_high_normal(self, scorer):
        """(admin) → self / high / normal — admin-submitted content."""
        item = {"ingress_channel": "admin", "sender": "admin", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "self"
        assert result["source_type"] == "self"
        assert result["confidence"] == "high"
        assert result["retrieval_policy"] == "normal"

    def test_connector_always_unknown_low_caveated(self, scorer):
        """(connector) → always unknown / low / caveated.

        Connectors NEVER fall through to source-string matching —
        this prevents a connector from spoofing source="telegram"
        to escalate trust.
        """
        item = {"ingress_channel": "connector", "sender": "alerts@google.com",
                "source": "telegram", "type": "email"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["source_type"] == "service"
        assert result["confidence"] == "low"
        assert result["retrieval_policy"] == "caveated"

    def test_connector_with_verified_domain_still_caveated(self, scorer):
        """Even verified service domains get caveated when via connector."""
        item = {"ingress_channel": "connector",
                "sender": "alerts@hdfcbank.com", "type": "email"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["confidence"] == "low"
        assert result["retrieval_policy"] == "caveated"

    def test_connector_with_known_contact_still_caveated(self, scorer):
        """Even known contacts get caveated when via connector channel."""
        item = {"ingress_channel": "connector",
                "sender": "sancho@example.com",
                "contact_did": "did:plc:sancho", "type": "email"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["confidence"] == "low"
        assert result["retrieval_policy"] == "caveated"

    # TST-BRAIN-820
    def test_d2d_known_trusted_contact(self, scorer):
        """(d2d) with known trusted contact → contact_ring1 / medium / caveated."""
        item = {"ingress_channel": "d2d", "sender": "did:plc:sancho",
                "contact_did": "did:plc:sancho", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "contact_ring1"
        assert result["source_type"] == "contact"
        assert result["confidence"] == "medium"
        assert result["retrieval_policy"] == "caveated"
        assert result["contact_did"] == "did:plc:sancho"

    # TST-BRAIN-821
    def test_d2d_known_unknown_trust_contact(self, scorer):
        """(d2d) with unknown-trust contact → contact_ring2 / medium / caveated."""
        item = {"ingress_channel": "d2d", "sender": "did:plc:albert",
                "contact_did": "did:plc:albert", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "contact_ring2"
        assert result["source_type"] == "contact"
        assert result["confidence"] == "medium"
        assert result["retrieval_policy"] == "caveated"

    # TST-BRAIN-822
    def test_d2d_unknown_sender(self, scorer):
        """(d2d) with unknown sender → unknown / low / quarantine."""
        item = {"ingress_channel": "d2d", "sender": "did:plc:stranger",
                "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["source_type"] == "unknown"
        assert result["confidence"] == "low"
        assert result["retrieval_policy"] == "quarantine"

    def test_ingress_channel_takes_precedence_over_source(self, scorer):
        """ingress_channel=connector overrides source=user (would be self trust).

        This is the key anti-spoofing test: a connector item with
        source="user" must NOT get self/high/normal trust.
        """
        item = {"ingress_channel": "connector", "source": "user",
                "sender": "", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "unknown"
        assert result["retrieval_policy"] == "caveated"
        # Must NOT be "self"
        assert result["source_type"] != "self"

    def test_no_ingress_channel_falls_to_source_matching(self, scorer):
        """Without ingress_channel, scoring falls back to source-string matching."""
        item = {"source": "user", "sender": "", "type": "note"}
        result = scorer.score(item)
        assert result["sender_trust"] == "self"
        assert result["source_type"] == "self"
        assert result["confidence"] == "high"
