"""Regression tests for _lookup_discoverable_cached.

Traces to TEST_PLAN §29.4. The enrichment path calls AppView's
`is_discoverable` for every contact-matched entity at staging time.
Without caching, the same DID is looked up repeatedly across batches.
These tests lock down the TTL-cache semantics: hits skip AppView,
expiry forces refresh, failed lookups don't poison, per-DID isolation.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.service.staging_processor import StagingProcessor


def _make_processor(
    *,
    appview_discoverable=(True, ["capability_x"]),
) -> tuple[StagingProcessor, MagicMock]:
    """Build a StagingProcessor with a mocked AppView client.

    Core + most other deps are not exercised by the cache tests — only
    the cache helper method uses the AppView client. We keep the test
    scope tight by not instantiating the full real deps tree.
    """
    appview = MagicMock()
    appview.is_discoverable = AsyncMock(return_value=appview_discoverable)
    proc = StagingProcessor(
        core=MagicMock(),
        enrichment=MagicMock(),
        appview_client=appview,
    )
    return proc, appview


# TRACE: {"suite": "BRAIN", "case": "0870", "section": "29", "sectionName": "Working Memory", "subsection": "04", "scenario": "01", "title": "cache_hit_skips_appview"}
@pytest.mark.asyncio
async def test_cache_hit_skips_appview_call():
    """TST-BRAIN-870: Same DID within TTL → second lookup is served from
    cache; AppView is_discoverable is called exactly once.
    """
    proc, appview = _make_processor()
    did = "did:plc:abc"

    first = await proc._lookup_discoverable_cached(did)
    second = await proc._lookup_discoverable_cached(did)

    assert first == (True, ["capability_x"])
    assert second == first  # cached — identical result
    appview.is_discoverable.assert_awaited_once_with(did)


# TRACE: {"suite": "BRAIN", "case": "0871", "section": "29", "sectionName": "Working Memory", "subsection": "04", "scenario": "02", "title": "ttl_expiry_refreshes"}
@pytest.mark.asyncio
async def test_ttl_expiry_triggers_refresh():
    """TST-BRAIN-871: Past TTL, cache entry is stale and must be
    refreshed from AppView. A provider that changes discoverability
    shows up within one TTL window, not forever.
    """
    proc, appview = _make_processor()
    # Shrink TTL so the test doesn't actually have to wait 30 minutes.
    proc._discoverability_ttl_seconds = 0  # any elapsed time is past TTL
    did = "did:plc:abc"

    await proc._lookup_discoverable_cached(did)
    # Second call: TTL already expired (0s) → must re-fetch.
    await proc._lookup_discoverable_cached(did)

    assert appview.is_discoverable.await_count == 2


# TRACE: {"suite": "BRAIN", "case": "0872", "section": "29", "sectionName": "Working Memory", "subsection": "04", "scenario": "03", "title": "failed_lookup_not_cached"}
@pytest.mark.asyncio
async def test_failed_lookup_does_not_poison_cache():
    """TST-BRAIN-872: A transient AppView failure must NOT cache a
    false/None result. The next call should retry rather than serving
    the failure forever.
    """
    proc, appview = _make_processor()
    # First call raises, then succeeds.
    appview.is_discoverable.side_effect = [
        Exception("appview temporarily down"),
        (True, ["cap_x"]),
    ]
    did = "did:plc:abc"

    first = await proc._lookup_discoverable_cached(did)
    second = await proc._lookup_discoverable_cached(did)

    # Failed lookup returns (None, []) — meaning "unknown", distinguishable
    # from a known-not-discoverable (False, []).
    assert first == (None, [])
    # Second call actually hit AppView (not a cached failure).
    assert appview.is_discoverable.await_count == 2
    assert second == (True, ["cap_x"])


# TRACE: {"suite": "BRAIN", "case": "0873", "section": "29", "sectionName": "Working Memory", "subsection": "04", "scenario": "04", "title": "per_did_cache_isolation"}
@pytest.mark.asyncio
async def test_per_did_cache_isolation():
    """TST-BRAIN-873: Different DIDs must have independent cache
    entries. Caching DID A should not affect lookups for DID B.
    """
    proc, appview = _make_processor()
    # Return different results per DID.
    appview.is_discoverable.side_effect = lambda did: {
        "did:plc:one": (True, ["cap_one"]),
        "did:plc:two": (False, []),
    }[did]

    # Cache DID one.
    a1 = await proc._lookup_discoverable_cached("did:plc:one")
    # First lookup for DID two — must actually call AppView.
    b1 = await proc._lookup_discoverable_cached("did:plc:two")
    # Both DIDs again — both should be cached now.
    a2 = await proc._lookup_discoverable_cached("did:plc:one")
    b2 = await proc._lookup_discoverable_cached("did:plc:two")

    assert a1 == a2 == (True, ["cap_one"])
    assert b1 == b2 == (False, [])
    # Each DID triggered exactly one AppView call.
    assert appview.is_discoverable.await_count == 2
