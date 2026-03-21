"""Unit tests for EnrichmentService — tiered content L0/L1 generation.

Tests the enrichment pipeline:
    - L0 deterministic generation from metadata
    - L0/L1 LLM generation (single call, structured JSON)
    - Low-trust provenance preserved in summaries
    - enrich_raw: in-memory enrichment for staging-before-publish
    - enrich_item: legacy path (reads from Core, PATCHes back)
    - Strict invariant: LLM failure = enrichment failure (no fallback)
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
# enrich_raw — in-memory enrichment before vault publication
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrich_raw_returns_all_fields():
    """enrich_raw populates L0, L1, embedding, status=ready, version."""
    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "Email from Dr. Sharma, March 2024",
        "l1": "Blood test results show B12 at 180 pg/mL (low). "
              "Doctor recommends supplements for 3 months.",
    })}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "email", "source": "gmail",
        "sender": "dr.sharma@clinic.com", "sender_trust": "contact_ring1",
        "confidence": "high", "summary": "Blood test results",
        "body_text": "Your blood test from March 10 shows B12 at 180.",
    }
    result = await svc.enrich_raw(item)

    assert result["content_l0"] != ""
    assert result["content_l1"] != ""
    assert result["enrichment_status"] == "ready"
    assert "prompt_v" in result["enrichment_version"]
    assert result["embedding"] is not None
    assert len(result["embedding"]) == 768


@pytest.mark.asyncio
async def test_enrich_raw_low_trust_caveat():
    """Low-trust items get provenance-aware L1 with 'Unverified...' prefix."""
    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "Unverified email claims vitamin D deficiency",
        "l1": "An unverified source claims vitamin D deficiency.",
    })}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "email", "sender": "spam@unknown.com",
        "sender_trust": "unknown", "confidence": "low",
        "summary": "You have vitamin D deficiency",
        "body_text": "Take our supplement now!",
    }
    result = await svc.enrich_raw(item)

    # L0 should have caveat from deterministic path
    assert "Unverified" in result["content_l0"]
    # L1 from LLM should also have caveat (provenance-aware prompt)
    assert "unverified" in result["content_l1"].lower()


@pytest.mark.asyncio
async def test_enrich_raw_high_trust_no_caveat():
    """High-trust (self/contact_ring1) items get clean L1 without caveats."""
    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "Blood test from Dr. Sharma",
        "l1": "Blood test results show normal B12 levels.",
    })}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "email", "sender": "dr.sharma@clinic.com",
        "sender_trust": "contact_ring1", "confidence": "high",
        "summary": "Blood test results",
        "body_text": "All markers normal.",
    }
    result = await svc.enrich_raw(item)

    assert "Unverified" not in result["content_l0"]
    assert "unverified" not in result["content_l1"].lower()


@pytest.mark.asyncio
async def test_enrich_raw_embedding_from_l1():
    """Embedding is generated from L1, not L2 body_text."""
    llm = AsyncMock()
    l1_text = "Key facts from the blood test results."
    llm.route.return_value = {"content": json.dumps({
        "l0": "Blood test", "l1": l1_text,
    })}
    llm.embed.return_value = [0.5] * 768

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "email", "summary": "test",
        "body_text": "This is the full body which should NOT be embedded",
        "sender_trust": "self", "confidence": "high",
    }
    await svc.enrich_raw(item)

    # embed() should be called with L1 text, not body_text
    llm.embed.assert_called_once()
    embed_arg = llm.embed.call_args[0][0]
    assert embed_arg == l1_text


@pytest.mark.asyncio
async def test_enrich_raw_llm_failure_raises():
    """LLM failure raises (no silent fallback to truncated body)."""
    llm = AsyncMock()
    llm.route.side_effect = Exception("LLM timeout")

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "email", "summary": "test",
        "body_text": "some content", "sender_trust": "self",
    }

    with pytest.raises(RuntimeError, match="LLM failed to generate L1"):
        await svc.enrich_raw(item)


@pytest.mark.asyncio
async def test_enrich_raw_no_llm_raises():
    """enrich_raw with llm=None raises (enrichment requires LLM)."""
    svc = EnrichmentService(core=AsyncMock(), llm=None)
    item = {"type": "note", "summary": "test", "body_text": "content"}

    with pytest.raises(RuntimeError, match="enrichment requires LLM"):
        await svc.enrich_raw(item)


@pytest.mark.asyncio
async def test_enrich_raw_embed_failure_raises():
    """Embedding failure propagates (no silent skip)."""
    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "test", "l1": "test summary",
    })}
    llm.embed.side_effect = Exception("embed timeout")

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "note", "summary": "test",
        "body_text": "content", "sender_trust": "self",
    }

    with pytest.raises(Exception, match="embed timeout"):
        await svc.enrich_raw(item)


@pytest.mark.asyncio
async def test_enrich_raw_summary_only_item():
    """Empty body_text → LLM called with summary as input (calendar events, etc)."""
    llm = AsyncMock()
    llm.route.return_value = {"content": json.dumps({
        "l0": "Calendar event: Team standup",
        "l1": "A team standup meeting scheduled for Monday morning.",
    })}
    llm.embed.return_value = [0.1] * 768

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "event", "summary": "Team standup Monday 9am",
        "body_text": "", "sender_trust": "self", "confidence": "high",
    }

    result = await svc.enrich_raw(item)

    assert result["enrichment_status"] == "ready"
    assert result["content_l1"] != ""
    assert result["embedding"] is not None
    # LLM was called with the summary as input
    llm.route.assert_called_once()


@pytest.mark.asyncio
async def test_enrich_raw_no_body_no_summary_raises():
    """Both body and summary empty → raises (nothing to enrich)."""
    llm = AsyncMock()
    # LLM returns empty L1 since input is empty
    llm.route.return_value = {"content": json.dumps({"l0": "", "l1": ""})}

    svc = EnrichmentService(core=AsyncMock(), llm=llm)
    item = {
        "type": "note", "summary": "", "body_text": "",
        "sender_trust": "self",
    }

    with pytest.raises(RuntimeError, match="LLM failed to generate L1"):
        await svc.enrich_raw(item)


# ---------------------------------------------------------------------------
# enrich_item — legacy path (reads from Core, PATCHes back)
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
async def test_enrich_item_llm_failure_sets_failed():
    """LLM failure → enrich_item returns False and sets status=failed."""
    core = AsyncMock()
    core.get_vault_item.return_value = {
        "id": "item-002", "type": "email", "summary": "test",
        "body_text": "some content here", "sender_trust": "self",
    }
    core.enrich_item.return_value = {}

    llm = AsyncMock()
    llm.route.side_effect = Exception("LLM timeout")

    svc = EnrichmentService(core=core, llm=llm)
    result = await svc.enrich_item("general", "item-002")
    assert result is False

    # Should have been marked as failed
    fail_calls = [c for c in core.enrich_item.call_args_list
                  if c.kwargs.get("enrichment_status") == "failed"]
    assert len(fail_calls) >= 1


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
# enrich_pending sweeper (legacy drain)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrich_pending_finds_and_enriches():
    """enrich_pending scans for pending items and enriches them."""
    core = AsyncMock()
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
    core.get_vault_item.side_effect = lambda persona, item_id, **kw: {
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


# ---------------------------------------------------------------------------
# FC2 — PII scrubbing before cloud LLM calls
# ---------------------------------------------------------------------------


# TST-BRAIN-815
@pytest.mark.asyncio
async def test_fc2_enrichment_scrubs_pii_before_cloud_llm():
    """FC2: EnrichmentService must scrub PII before sending to cloud LLM.

    The entity_vault.scrub() is called on body+summary before LLM call.
    """
    entity_vault = AsyncMock()
    entity_vault.scrub.return_value = ("[PERSON_1] has high blood pressure", {})

    llm = AsyncMock()
    llm.route.return_value = {
        "content": json.dumps({
            "l0": "Health context from [PERSON_1]",
            "l1": "Patient note about blood pressure management.",
        }),
        "model": "test",
    }

    svc = EnrichmentService(
        core=AsyncMock(), llm=llm, entity_vault=entity_vault,
    )

    item = {
        "type": "health_context",
        "source": "gmail",
        "sender": "dr.sharma@clinic.com",
        "summary": "Dr. Sharma: blood pressure results",
        "body_text": "Dr. Sharma reports that Mr. Rajesh has high blood pressure",
        "sender_trust": "contact_ring1",
        "confidence": "high",
    }

    result = await svc.enrich_raw(item)
    assert result["enrichment_status"] == "ready"

    # Entity vault must have been called to scrub body + summary + sender.
    assert entity_vault.scrub.await_count == 3

    # Verify the LLM prompt does NOT contain raw sender email.
    llm_call = llm.route.call_args
    prompt = llm_call.kwargs.get("prompt", "")
    assert "dr.sharma@clinic.com" not in prompt, (
        f"FC2: raw sender email leaked into LLM prompt: {prompt[:200]}"
    )


# TST-BRAIN-816
@pytest.mark.asyncio
async def test_fc2_enrichment_fails_if_scrub_fails():
    """FC2: If PII scrubbing fails, enrichment must fail (fail-closed)."""
    entity_vault = AsyncMock()
    entity_vault.scrub.side_effect = RuntimeError("spaCy model not loaded")

    llm = AsyncMock()
    svc = EnrichmentService(
        core=AsyncMock(), llm=llm, entity_vault=entity_vault,
    )

    item = {
        "type": "note",
        "summary": "Personal note",
        "body_text": "My SSN is 123-45-6789",
    }

    with pytest.raises(RuntimeError, match="PII scrub failed"):
        await svc.enrich_raw(item)

    # LLM must NOT have been called.
    llm.route.assert_not_awaited()


# TST-BRAIN-817
@pytest.mark.asyncio
async def test_fc2_enrichment_no_scrub_when_no_entity_vault():
    """Without entity_vault, enrichment proceeds (backward-compatible for local LLM)."""
    llm = AsyncMock()
    llm.route.return_value = {
        "content": json.dumps({"l0": "Note", "l1": "Summary of note."}),
        "model": "local",
    }

    svc = EnrichmentService(core=AsyncMock(), llm=llm)  # no entity_vault

    item = {
        "type": "note",
        "summary": "A note",
        "body_text": "Some content",
    }

    result = await svc.enrich_raw(item)
    assert result["enrichment_status"] == "ready"
    llm.route.assert_awaited_once()
