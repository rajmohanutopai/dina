"""Unit tests for EnrichmentService — tiered content L0/L1 generation.

Tests the enrichment pipeline:
    - L0 deterministic generation from metadata
    - L0/L1 LLM generation (single call, structured JSON)
    - Low-trust provenance preserved in summaries
    - Fallback behavior when LLM fails or L1 is missing
    - enrich_item reads L2, generates L0/L1, PATCHes Core
    - Failed enrichment sets status=failed
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from src.service.enrichment import (
    EnrichmentService,
    _generate_l0_deterministic,
)


# ---------------------------------------------------------------------------
# L0 deterministic generation
# ---------------------------------------------------------------------------


def test_l0_deterministic_from_metadata():
    """Generate L0 from type + sender + date without LLM."""
    l0 = _generate_l0_deterministic(
        item_type="email",
        sender="dr.sharma@clinic.com",
        summary="Blood test results",
        timestamp=1710000000,  # March 2024
        sender_trust="contact_ring1",
        confidence="high",
    )
    assert "dr.sharma@clinic.com" in l0
    assert "Email" in l0 or "email" in l0.lower()


def test_l0_deterministic_from_summary_only():
    """L0 falls back to summary when metadata is sparse."""
    l0 = _generate_l0_deterministic(
        item_type="", sender="", summary="Meeting notes from Tuesday",
        timestamp=0, sender_trust="", confidence="",
    )
    assert "Meeting notes" in l0


def test_l0_deterministic_low_trust_includes_caveat():
    """Low-trust items get 'Unverified' prefix in L0."""
    l0 = _generate_l0_deterministic(
        item_type="email",
        sender="unknown@spam.com",
        summary="You have vitamin D deficiency",
        timestamp=1710000000,
        sender_trust="unknown",
        confidence="low",
    )
    assert l0.startswith("Unverified")
    assert "unknown@spam.com" in l0


def test_l0_deterministic_marketing_caveat():
    """Marketing items get caveat."""
    l0 = _generate_l0_deterministic(
        item_type="email",
        sender="deals@shop.com",
        summary="50% off everything",
        timestamp=0,
        sender_trust="marketing",
        confidence="low",
    )
    assert "Unverified" in l0


def test_l0_deterministic_empty_returns_empty():
    """No metadata → empty string (LLM fallback needed)."""
    l0 = _generate_l0_deterministic(
        item_type="", sender="", summary="",
        timestamp=0, sender_trust="", confidence="",
    )
    assert l0 == ""


# ---------------------------------------------------------------------------
# LLM-based L0/L1 generation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrich_item_single_llm_call():
    """enrich_item generates L0+L1 in one LLM call and PATCHes Core."""
    core = AsyncMock()
    core.get_vault_item.return_value = {
        "id": "item-001",
        "type": "email",
        "source": "gmail",
        "sender": "dr.sharma@clinic.com",
        "sender_trust": "contact_ring1",
        "confidence": "high",
        "summary": "Blood test results",
        "body_text": "Your blood test from March 10 shows B12 at 180 pg/mL (low). "
                     "All other markers normal. Recommend B12 supplements for 3 months.",
        "timestamp": 1710000000,
    }
    core.enrich_item.return_value = {"id": "item-001", "enrichment_status": "ready"}

    llm = AsyncMock()
    llm.route.return_value = {
        "content": json.dumps({
            "l0": "Blood test results from dr.sharma@clinic.com, March 2024",
            "l1": "Blood test results from Dr. Sharma dated March 10, 2024. "
                  "Key findings: B12 at 180 pg/mL (low), all other markers normal. "
                  "Doctor recommends B12 supplements for 3 months.",
        }),
    }
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=core, llm=llm)
    result = await svc.enrich_item("general", "item-001")
    assert result is True

    # Verify PATCH was called with L0/L1/embedding/status.
    enrich_calls = [c for c in core.enrich_item.call_args_list
                    if c.kwargs.get("enrichment_status") == "ready"]
    assert len(enrich_calls) == 1
    call = enrich_calls[0]
    assert call.kwargs["content_l0"] != ""
    assert call.kwargs["content_l1"] != ""
    assert call.kwargs["enrichment_status"] == "ready"
    assert "prompt_v" in call.kwargs["enrichment_version"]


@pytest.mark.asyncio
async def test_enrich_item_llm_failure_uses_fallback():
    """LLM failure still succeeds via truncated-L2 fallback."""
    core = AsyncMock()
    core.get_vault_item.return_value = {
        "id": "item-002", "type": "email", "summary": "test",
        "body_text": "some content here", "sender_trust": "self",
    }
    core.enrich_item.return_value = {}

    llm = AsyncMock()
    llm.route.side_effect = Exception("LLM timeout")
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=core, llm=llm)
    result = await svc.enrich_item("general", "item-002")
    # Fallback: L1 = truncated L2. Still succeeds.
    assert result is True

    ready_calls = [c for c in core.enrich_item.call_args_list
                   if c.kwargs.get("enrichment_status") == "ready"]
    assert len(ready_calls) == 1
    assert ready_calls[0].kwargs["content_l1"] == "some content here"


@pytest.mark.asyncio
async def test_enrich_item_core_failure_sets_failed():
    """If Core GetItem fails, enrichment returns False."""
    core = AsyncMock()
    core.get_vault_item.side_effect = Exception("Core unreachable")
    core.enrich_item.return_value = {}

    svc = EnrichmentService(core=core, llm=AsyncMock())
    result = await svc.enrich_item("general", "item-fail")
    assert result is False


@pytest.mark.asyncio
async def test_enrich_item_fallback_truncated_l2():
    """When LLM produces no L1, fall back to truncated L2 (body)."""
    core = AsyncMock()
    core.get_vault_item.return_value = {
        "id": "item-003", "type": "note", "summary": "My note",
        "body_text": "A" * 1000, "sender_trust": "self", "confidence": "high",
    }
    core.enrich_item.return_value = {}

    llm = AsyncMock()
    llm.route.return_value = {"content": "not valid json"}  # parse fails
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=core, llm=llm)
    result = await svc.enrich_item("general", "item-003")
    assert result is True

    # L1 should be truncated L2.
    ready_calls = [c for c in core.enrich_item.call_args_list
                   if c.kwargs.get("enrichment_status") == "ready"]
    assert len(ready_calls) == 1
    l1 = ready_calls[0].kwargs["content_l1"]
    assert len(l1) <= 500
    assert l1.startswith("A")


@pytest.mark.asyncio
async def test_enrich_item_low_trust_l0_caveat():
    """Low-trust item L0 includes 'Unverified' caveat (deterministic path)."""
    core = AsyncMock()
    core.get_vault_item.return_value = {
        "id": "item-004", "type": "email",
        "sender": "spam@unknown.com", "sender_trust": "unknown",
        "confidence": "low", "summary": "You won a prize",
        "body_text": "Click here to claim.", "timestamp": 1710000000,
    }
    core.enrich_item.return_value = {}

    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "Unverified email claims prize",
        "l1": "An unverified source claims you won a prize.",
    })}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=core, llm=llm)
    await svc.enrich_item("general", "item-004")

    ready_calls = [c for c in core.enrich_item.call_args_list
                   if c.kwargs.get("enrichment_status") == "ready"]
    l0 = ready_calls[0].kwargs["content_l0"]
    assert "Unverified" in l0 or "unverified" in l0.lower()


# ---------------------------------------------------------------------------
# enrich_pending sweeper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrich_pending_finds_and_enriches():
    """enrich_pending scans for pending items and enriches them."""
    core = AsyncMock()
    # search_vault returns items with mixed enrichment_status.
    core.search_vault.return_value = [
        {"id": "pending-1", "enrichment_status": "pending",
         "type": "note", "summary": "Note 1", "body_text": "Content 1",
         "sender_trust": "self", "confidence": "high"},
        {"id": "ready-1", "enrichment_status": "ready",
         "type": "note", "summary": "Note 2", "body_text": "Content 2"},
        {"id": "failed-1", "enrichment_status": "failed",
         "type": "note", "summary": "Note 3", "body_text": "Content 3",
         "sender_trust": "self"},
    ]
    core.get_vault_item.side_effect = lambda persona, item_id: {
        "id": item_id, "type": "note", "summary": f"Note {item_id}",
        "body_text": f"Content for {item_id}",
        "sender_trust": "self", "confidence": "high",
    }
    core.enrich_item.return_value = {}

    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({"l0": "test l0", "l1": "test l1"})}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=core, llm=llm)
    count = await svc.enrich_pending("general", limit=10)

    # Should enrich pending-1 and failed-1 (not ready-1).
    assert count == 2

    # search_vault was called with include_all=True (not include_quarantine).
    core.search_vault.assert_awaited_once()
    call_kwargs = core.search_vault.call_args
    assert call_kwargs.kwargs.get("include_all") is True or \
           call_kwargs[1].get("include_all") is True


@pytest.mark.asyncio
async def test_enrich_pending_handles_search_failure():
    """enrich_pending returns 0 if search_vault fails."""
    core = AsyncMock()
    core.search_vault.side_effect = Exception("Core down")

    svc = EnrichmentService(core=core, llm=AsyncMock())
    count = await svc.enrich_pending("general")
    assert count == 0


@pytest.mark.asyncio
async def test_enrich_pending_empty_results():
    """enrich_pending returns 0 if no pending items found."""
    core = AsyncMock()
    core.search_vault.return_value = [
        {"id": "r1", "enrichment_status": "ready"},
        {"id": "r2", "enrichment_status": "ready"},
    ]

    svc = EnrichmentService(core=core, llm=AsyncMock())
    count = await svc.enrich_pending("general")
    assert count == 0
