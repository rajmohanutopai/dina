"""Tier classification for vault items.

Determines whether an item should receive an embedding (Tier 1) or
be stored as text only (Tier 2).

Rule: does the item reveal intent, preference, or personal context?
  - Yes -> Tier 1 (full record + embedding for HNSW semantic search)
  - No  -> Tier 2 (stored text, FTS5 keyword search only)

This is a simple rule-based classifier by item type — no LLM call needed.
The type alone determines the tier because the architecture defines what
each type represents:

  Tier 1 types carry personal meaning:
    purchase_decision, trust_review, health_context, work_context,
    finance_context, family_context, note, email, email_draft,
    document, contact_card, cart_handover

  Tier 2 types are transactional/ephemeral:
    event, bookmark, voice_memo, kv, photo, message, contact
"""

from __future__ import annotations

# Tier 1 (embed) — reveals intent, preference, or personal context.
TIER1_TYPES: frozenset[str] = frozenset({
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
})

# Tier 2 (text only) — transactional, ephemeral, or low-signal.
TIER2_TYPES: frozenset[str] = frozenset({
    "event",
    "bookmark",
    "voice_memo",
    "kv",
    "photo",
    "message",
    "contact",
})


def classify(item: dict) -> int:
    """Classify a vault item as Tier 1 or Tier 2.

    Parameters
    ----------
    item:
        A dict with at least a ``type`` key.

    Returns
    -------
    int
        1 for Tier 1 (embed), 2 for Tier 2 (text only).
    """
    item_type = item.get("type", "")
    if item_type in TIER1_TYPES:
        return 1
    # Unknown types default to Tier 2 (safe — no embedding wasted).
    return 2
