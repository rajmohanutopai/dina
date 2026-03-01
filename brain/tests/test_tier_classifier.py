"""Tests for the tier classifier.

Verifies that vault item types are correctly classified as Tier 1 (embed)
or Tier 2 (text only, no embedding).
"""

import pytest

from src.service.tier_classifier import TIER1_TYPES, TIER2_TYPES, classify


# --------------------------------------------------------------------------
# Tier 1 — items that reveal intent/preference/personal context
# --------------------------------------------------------------------------

@pytest.mark.parametrize("item_type", [
    "purchase_decision",
    "trust_review",
    "health_context",
    "work_context",
    "finance_context",
    "family_context",
    "note",
    "email",
    "email_draft",
    "document",
    "contact_card",
    "cart_handover",
])
def test_tier1_types_classified_correctly(item_type: str) -> None:
    """Tier 1 types should return 1 (embed)."""
    assert classify({"type": item_type}) == 1


# --------------------------------------------------------------------------
# Tier 2 — transactional/ephemeral items (no embedding)
# --------------------------------------------------------------------------

@pytest.mark.parametrize("item_type", [
    "event",
    "bookmark",
    "voice_memo",
    "kv",
    "photo",
    "message",
    "contact",
])
def test_tier2_types_classified_correctly(item_type: str) -> None:
    """Tier 2 types should return 2 (text only)."""
    assert classify({"type": item_type}) == 2


# --------------------------------------------------------------------------
# Edge cases
# --------------------------------------------------------------------------

def test_unknown_type_defaults_to_tier2() -> None:
    """Unknown types default to Tier 2 (safe — no embedding wasted)."""
    assert classify({"type": "some_future_type"}) == 2


def test_missing_type_defaults_to_tier2() -> None:
    """Items without a type key default to Tier 2."""
    assert classify({}) == 2


def test_empty_type_defaults_to_tier2() -> None:
    """Empty string type defaults to Tier 2."""
    assert classify({"type": ""}) == 2


# --------------------------------------------------------------------------
# Set completeness
# --------------------------------------------------------------------------

def test_tier1_and_tier2_are_disjoint() -> None:
    """Tier 1 and Tier 2 sets must not overlap."""
    overlap = TIER1_TYPES & TIER2_TYPES
    assert len(overlap) == 0, f"Overlapping types: {overlap}"


def test_all_known_vault_types_classified() -> None:
    """Every valid vault item type should appear in either TIER1 or TIER2."""
    # From core/internal/domain/vault_limits.go
    all_types = {
        "email", "message", "event", "note", "photo",
        "email_draft", "cart_handover", "contact_card",
        "document", "bookmark", "voice_memo", "kv",
        "contact", "health_context", "work_context",
        "finance_context", "family_context",
        "purchase_decision", "trust_review",
    }
    classified = TIER1_TYPES | TIER2_TYPES
    unclassified = all_types - classified
    assert len(unclassified) == 0, f"Unclassified types: {unclassified}"
