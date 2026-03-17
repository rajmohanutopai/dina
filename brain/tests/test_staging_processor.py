"""Unit tests for StagingProcessor — classifies staged items into persona vaults.

Tests the classification pipeline:
    - Claims pending items from Core staging
    - Classifies persona via domain heuristics (highest sensitivity wins)
    - Scores trust via TrustScorer
    - Calls resolve with classified VaultItem + lineage
    - Handles failures gracefully
"""

from __future__ import annotations

from unittest.mock import AsyncMock

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
    c.staging_fail.return_value = {"status": "failed"}
    return c


@pytest.fixture
def trust_scorer():
    """Mock TrustScorer."""
    from src.service.trust_scorer import TrustScorer
    return TrustScorer()


@pytest.fixture
def processor(core, trust_scorer):
    """StagingProcessor with mock core and real trust scorer."""
    return StagingProcessor(core=core, trust_scorer=trust_scorer)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_pending_claims_and_classifies(core, processor):
    """process_pending claims items and resolves them."""
    core.staging_claim.return_value = [
        {"id": "stg-1", "type": "email", "source": "gmail",
         "source_id": "msg-1", "sender": "user@example.com",
         "summary": "Hello", "body": "Hi there", "connector_id": "gmail-1"},
    ]

    count = await processor.process_pending(limit=10)
    assert count == 1

    core.staging_claim.assert_awaited_once_with(10)
    core.staging_resolve.assert_awaited_once()
    call = core.staging_resolve.call_args
    assert call.args[0] == "stg-1"  # staging_id
    assert call.args[1] == "general"  # persona (email → general by default)


@pytest.mark.asyncio
async def test_classification_highest_sensitivity_wins(core):
    """Health-related types classify to health persona (highest sensitivity)."""
    processor = StagingProcessor(core=core)
    core.staging_claim.return_value = [
        {"id": "stg-2", "type": "health_context", "source": "gmail",
         "source_id": "msg-2", "sender": "dr@clinic.com",
         "summary": "Blood test", "body": "Results attached",
         "connector_id": "gmail-1"},
    ]

    await processor.process_pending()
    call = core.staging_resolve.call_args
    assert call.args[1] == "health"  # classified as health


@pytest.mark.asyncio
async def test_trust_scoring_applied(core, trust_scorer, processor):
    """Trust scoring is applied to classified items."""
    core.staging_claim.return_value = [
        {"id": "stg-3", "type": "email", "source": "gmail",
         "source_id": "msg-3", "sender": "noreply@shop.com",
         "summary": "Sale!", "body": "50% off", "connector_id": "gmail-1"},
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["sender_trust"] == "marketing"
    assert classified["retrieval_policy"] == "briefing_only"


@pytest.mark.asyncio
async def test_resolve_includes_lineage(core, processor):
    """Classified item includes staging lineage fields."""
    core.staging_claim.return_value = [
        {"id": "stg-4", "type": "note", "source": "gmail",
         "source_id": "msg-4", "sender": "friend@example.com",
         "summary": "Note", "body": "Content", "connector_id": "gmail-acct-2"},
    ]

    await processor.process_pending()
    classified = core.staging_resolve.call_args.args[2]
    assert classified["staging_id"] == "stg-4"
    assert classified["connector_id"] == "gmail-acct-2"
    assert classified["source"] == "gmail"
    assert classified["source_id"] == "msg-4"


@pytest.mark.asyncio
async def test_classification_failure_calls_fail(core, processor):
    """Classification error calls staging_fail endpoint."""
    core.staging_claim.return_value = [
        {"id": "stg-5", "type": "email", "source": "gmail",
         "source_id": "msg-5", "summary": "Test", "body": "Content",
         "connector_id": "c1"},
    ]
    core.staging_resolve.side_effect = Exception("Core rejected")

    count = await processor.process_pending()
    assert count == 0
    core.staging_fail.assert_awaited_once()
    fail_call = core.staging_fail.call_args
    assert fail_call.args[0] == "stg-5"
    assert "Core rejected" in fail_call.args[1]


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
async def test_finance_type_classifies_to_financial(core):
    """Finance-related types classify to financial persona."""
    processor = StagingProcessor(core=core)
    core.staging_claim.return_value = [
        {"id": "stg-6", "type": "finance_context", "source": "gmail",
         "source_id": "msg-6", "sender": "bank@hdfcbank.com",
         "summary": "Statement", "body": "Your balance is...",
         "connector_id": "gmail-1"},
    ]

    await processor.process_pending()
    call = core.staging_resolve.call_args
    assert call.args[1] == "financial"


@pytest.mark.asyncio
async def test_pending_unlock_skips_event_extraction(core):
    """When resolve returns pending_unlock, no reminders are created."""
    core.staging_resolve.return_value = {"status": "pending_unlock"}
    core.staging_resolve_multi = AsyncMock(return_value={"status": "pending_unlock"})
    core.staging_claim.return_value = [
        {"id": "stg-lock-1", "type": "note", "source": "gmail",
         "source_id": "msg-lock-1", "sender": "someone@example.com",
         "summary": "Simple note",
         "body": "Just a simple note with no special keywords.",
         "connector_id": "gmail-1"},
    ]

    event_extractor = AsyncMock()
    processor = StagingProcessor(
        core=core, event_extractor=event_extractor,
    )
    await processor.process_pending()

    # Resolve was called (item classified to single persona).
    core.staging_resolve.assert_awaited()
    # But event extraction was NOT called (persona is locked).
    event_extractor.extract_and_create.assert_not_awaited()


@pytest.mark.asyncio
async def test_stored_triggers_event_extraction(core):
    """When resolve returns stored, event extraction runs."""
    core.staging_resolve.return_value = {"status": "stored"}
    core.staging_claim.return_value = [
        {"id": "stg-ok-1", "type": "note", "source": "gmail",
         "source_id": "msg-ok-1", "sender": "someone@example.com",
         "summary": "Simple stored note",
         "body": "Just a simple note.",
         "connector_id": "gmail-1"},
    ]

    event_extractor = AsyncMock()
    event_extractor.extract_and_create.return_value = 1
    processor = StagingProcessor(
        core=core, event_extractor=event_extractor,
    )
    await processor.process_pending()

    # Event extraction WAS called (persona stored successfully).
    event_extractor.extract_and_create.assert_awaited_once()
