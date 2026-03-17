"""Unit tests for StagingProcessor — classifies and enriches staged items.

Tests the classification + enrichment pipeline:
    - Claims pending items from Core staging
    - Classifies persona via domain heuristics (highest sensitivity wins)
    - Scores trust via TrustScorer
    - Enriches (L0+L1+embedding) before resolve — strict invariant
    - Calls resolve with fully enriched VaultItem + lineage
    - Enrichment failure → staging_fail (no partial records in vault)
    - Handles failures gracefully
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.service.staging_processor import StagingProcessor


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def core():
    """Mock Core client with staging endpoints."""
    c = AsyncMock()
    c.staging_claim.return_value = []
    c.staging_resolve.return_value = {"status": "stored"}
    c.staging_resolve_multi.return_value = {"status": "stored"}
    c.staging_fail.return_value = {"status": "failed"}
    c.update_contact_last_seen.return_value = None
    return c


@pytest.fixture
def trust_scorer():
    """Mock TrustScorer."""
    from src.service.trust_scorer import TrustScorer
    return TrustScorer()


def _enrich_success(item: dict) -> dict:
    """Simulate successful enrichment (sync — AsyncMock wraps it)."""
    item["content_l0"] = f"L0: {item.get('summary', 'unknown')}"
    item["content_l1"] = f"L1 summary of {item.get('body_text', 'content')}"
    item["embedding"] = [0.1] * 768
    item["enrichment_status"] = "ready"
    item["enrichment_version"] = json.dumps({"prompt_v": 1})
    return item


@pytest.fixture
def enrichment():
    """Mock EnrichmentService that succeeds."""
    svc = AsyncMock()
    svc.enrich_raw.side_effect = _enrich_success
    return svc


@pytest.fixture
def processor(core, trust_scorer, enrichment):
    """StagingProcessor with mock core, enrichment, and real trust scorer."""
    return StagingProcessor(
        core=core, enrichment=enrichment, trust_scorer=trust_scorer,
    )


def _make_item(
    id: str = "stg-1",
    type: str = "email",
    source: str = "gmail",
    source_id: str = "msg-1",
    sender: str = "user@example.com",
    summary: str = "Hello",
    body: str = "Hi there",
    connector_id: str = "gmail-1",
) -> dict:
    return {
        "id": id, "type": type, "source": source, "source_id": source_id,
        "sender": sender, "summary": summary, "body": body,
        "connector_id": connector_id,
    }


# ---------------------------------------------------------------------------
# Core flow: claim → classify → enrich → resolve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_pending_claims_and_classifies(core, processor):
    """process_pending claims items and resolves them."""
    core.staging_claim.return_value = [_make_item()]

    count = await processor.process_pending(limit=10)
    assert count == 1

    core.staging_claim.assert_awaited_once_with(10)
    core.staging_resolve.assert_awaited_once()
    call = core.staging_resolve.call_args
    assert call.args[0] == "stg-1"  # staging_id
    assert call.args[1] == "general"  # persona (email → general by default)


@pytest.mark.asyncio
async def test_process_pending_enriches_before_resolve(core, enrichment, processor):
    """Enrichment runs before resolve. Classified item has L0/L1/embedding."""
    core.staging_claim.return_value = [_make_item()]

    await processor.process_pending()

    # enrich_raw was called
    enrichment.enrich_raw.assert_awaited_once()

    # Classified item sent to resolve has enrichment fields
    classified = core.staging_resolve.call_args.args[2]
    assert classified["enrichment_status"] == "ready"
    assert classified["content_l0"] != ""
    assert classified["content_l1"] != ""
    assert classified["embedding"] is not None
    assert len(classified["embedding"]) == 768


@pytest.mark.asyncio
async def test_enriched_item_has_ready_status(core, processor):
    """Classified item sent to resolve has enrichment_status=ready."""
    core.staging_claim.return_value = [_make_item()]

    await processor.process_pending()

    classified = core.staging_resolve.call_args.args[2]
    assert classified["enrichment_status"] == "ready"
    assert "prompt_v" in classified["enrichment_version"]


@pytest.mark.asyncio
async def test_classification_highest_sensitivity_wins(core, enrichment):
    """Health-related types classify to health persona."""
    processor = StagingProcessor(core=core, enrichment=enrichment)
    core.staging_claim.return_value = [
        _make_item(id="stg-2", type="health_context", sender="dr@clinic.com",
                   summary="Blood test", body="Results attached"),
    ]

    await processor.process_pending()
    call = core.staging_resolve.call_args
    assert call.args[1] == "health"


@pytest.mark.asyncio
async def test_trust_scoring_applied(core, trust_scorer, enrichment):
    """Trust scoring is applied to classified items."""
    processor = StagingProcessor(
        core=core, enrichment=enrichment, trust_scorer=trust_scorer,
    )
    core.staging_claim.return_value = [
        _make_item(id="stg-3", sender="noreply@shop.com",
                   summary="Sale!", body="50% off"),
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["sender_trust"] == "marketing"
    assert classified["retrieval_policy"] == "briefing_only"


@pytest.mark.asyncio
async def test_contact_did_propagated_via_explicit_did(core, enrichment):
    """Item with explicit contact_did → flows into classified item."""
    from src.service.trust_scorer import TrustScorer
    scorer = TrustScorer(contacts=[
        {"did": "did:key:z6MkSharmaDID", "name": "Dr Sharma", "trust_level": "verified"},
    ])
    processor = StagingProcessor(
        core=core, enrichment=enrichment, trust_scorer=scorer,
    )
    core.staging_claim.return_value = [
        {**_make_item(id="stg-contact", sender="dr.sharma@clinic.com"),
         "contact_did": "did:key:z6MkSharmaDID"},
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["contact_did"] == "did:key:z6MkSharmaDID"
    assert classified["sender_trust"] == "contact_ring1"


@pytest.mark.asyncio
async def test_contact_did_resolved_from_sender_via_alias(core, enrichment):
    """Connector item without contact_did → resolved from sender via contact alias.

    This is the real connector path: items arrive with only a sender email,
    no contact_did. TrustScorer matches sender against contact alias to
    resolve the DID.
    """
    from src.service.trust_scorer import TrustScorer
    scorer = TrustScorer(contacts=[
        {"did": "did:key:z6MkSharmaDID", "name": "Dr Sharma",
         "alias": "dr.sharma@clinic.com", "trust_level": "verified"},
    ])
    processor = StagingProcessor(
        core=core, enrichment=enrichment, trust_scorer=scorer,
    )
    # No contact_did on the raw staged item — only sender email.
    core.staging_claim.return_value = [
        _make_item(id="stg-sender", sender="dr.sharma@clinic.com"),
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["contact_did"] == "did:key:z6MkSharmaDID"
    assert classified["sender_trust"] == "contact_ring1"


@pytest.mark.asyncio
async def test_no_contact_did_when_unknown_sender(core, enrichment):
    """Unknown sender → contact_did is empty in classified item."""
    from src.service.trust_scorer import TrustScorer
    scorer = TrustScorer()
    processor = StagingProcessor(
        core=core, enrichment=enrichment, trust_scorer=scorer,
    )
    core.staging_claim.return_value = [
        _make_item(id="stg-unknown", sender="random@stranger.com"),
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["contact_did"] == ""


@pytest.mark.asyncio
async def test_resolve_includes_lineage(core, processor):
    """Classified item includes staging lineage fields."""
    core.staging_claim.return_value = [
        _make_item(id="stg-4", source="gmail", source_id="msg-4",
                   sender="friend@example.com", connector_id="gmail-acct-2"),
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["staging_id"] == "stg-4"
    assert classified["connector_id"] == "gmail-acct-2"
    assert classified["source"] == "gmail"
    assert classified["source_id"] == "msg-4"


# ---------------------------------------------------------------------------
# Enrichment failure → staging_fail (strict invariant)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrichment_failure_calls_staging_fail(core, enrichment):
    """When enrich_raw raises, staging_fail is called and item is not resolved."""
    enrichment.enrich_raw.side_effect = RuntimeError("LLM timeout")
    processor = StagingProcessor(core=core, enrichment=enrichment)
    core.staging_claim.return_value = [_make_item()]

    count = await processor.process_pending()
    assert count == 0

    core.staging_fail.assert_awaited_once()
    fail_call = core.staging_fail.call_args
    assert fail_call.args[0] == "stg-1"
    assert "enrichment failed" in fail_call.args[1]

    # Resolve was NOT called
    core.staging_resolve.assert_not_awaited()


@pytest.mark.asyncio
async def test_enrichment_failure_does_not_extract_events(core, enrichment):
    """No event extraction when enrichment fails."""
    enrichment.enrich_raw.side_effect = RuntimeError("embed failed")
    event_extractor = AsyncMock()
    processor = StagingProcessor(
        core=core, enrichment=enrichment, event_extractor=event_extractor,
    )
    core.staging_claim.return_value = [_make_item()]

    await processor.process_pending()

    event_extractor.extract_and_create.assert_not_awaited()


# ---------------------------------------------------------------------------
# Multi-persona: enrich once, copy to all targets
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_persona_enriches_once(core, enrichment):
    """Cross-persona items: enrichment runs once, fields copied to all targets."""
    processor = StagingProcessor(core=core, enrichment=enrichment)
    # Item with health + work cross-over keywords
    core.staging_claim.return_value = [
        _make_item(id="stg-mp", type="email",
                   summary="Back pain affecting work deadlines",
                   body="My back pain is affecting work productivity and deadlines"),
    ]

    await processor.process_pending()

    # enrich_raw called exactly once (not once per persona)
    assert enrichment.enrich_raw.await_count == 1

    # Resolve was called (single or multi)
    if core.staging_resolve_multi.await_count > 0:
        call = core.staging_resolve_multi.call_args
        for target in call.args[1]:
            assert target["classified_item"]["enrichment_status"] == "ready"
            assert target["classified_item"]["content_l1"] != ""


# ---------------------------------------------------------------------------
# Classification failure (non-enrichment)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_classification_failure_calls_fail(core, enrichment):
    """Classification error calls staging_fail endpoint."""
    processor = StagingProcessor(core=core, enrichment=enrichment)
    core.staging_claim.return_value = [_make_item(id="stg-5")]
    core.staging_resolve.side_effect = Exception("Core rejected")

    count = await processor.process_pending()
    assert count == 0
    core.staging_fail.assert_awaited_once()
    fail_call = core.staging_fail.call_args
    assert fail_call.args[0] == "stg-5"
    assert "Core rejected" in fail_call.args[1]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_pending_items_noop(core, processor):
    """No pending items → no-op, returns 0."""
    core.staging_claim.return_value = []
    count = await processor.process_pending()
    assert count == 0
    core.staging_resolve.assert_not_awaited()


@pytest.mark.asyncio
async def test_claim_failure_returns_zero(core, processor):
    """If claim fails, returns 0 gracefully."""
    core.staging_claim.side_effect = Exception("Core down")
    count = await processor.process_pending()
    assert count == 0


@pytest.mark.asyncio
async def test_finance_type_classifies_to_financial(core, enrichment):
    """Finance-related types classify to financial persona."""
    processor = StagingProcessor(core=core, enrichment=enrichment)
    core.staging_claim.return_value = [
        _make_item(id="stg-6", type="finance_context",
                   sender="bank@hdfcbank.com", summary="Statement",
                   body="Your balance is..."),
    ]

    await processor.process_pending()
    call = core.staging_resolve.call_args
    assert call.args[1] == "financial"


# ---------------------------------------------------------------------------
# Event extraction: stored vs pending_unlock
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pending_unlock_skips_event_extraction(core, enrichment):
    """When resolve returns pending_unlock, no reminders are created."""
    core.staging_resolve.return_value = {"status": "pending_unlock"}
    event_extractor = AsyncMock()
    processor = StagingProcessor(
        core=core, enrichment=enrichment, event_extractor=event_extractor,
    )
    core.staging_claim.return_value = [
        _make_item(id="stg-lock", body="Simple note with no keywords."),
    ]

    await processor.process_pending()

    core.staging_resolve.assert_awaited()
    event_extractor.extract_and_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_stored_triggers_event_extraction(core, enrichment):
    """When resolve returns stored, event extraction runs."""
    core.staging_resolve.return_value = {"status": "stored"}
    event_extractor = AsyncMock()
    event_extractor.extract_and_create.return_value = 1
    processor = StagingProcessor(
        core=core, enrichment=enrichment, event_extractor=event_extractor,
    )
    core.staging_claim.return_value = [
        _make_item(id="stg-ok", body="Simple stored note."),
    ]

    await processor.process_pending()

    event_extractor.extract_and_create.assert_awaited_once()
