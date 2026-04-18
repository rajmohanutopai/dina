"""Tests for ServiceQueryOrchestrator — the structured /service_query path.

Historically this path picked the first AppView hit and sent the query
without schema lookup, validation, schema_hash, or origin_channel.
That bypassed the schema-driven requester flow the LLM path already
honoured. These tests lock in the new behaviour:

- the capability schema and schema_hash from AppView flow into
  send_service_query,
- sender-side params validation rejects bad requests locally,
- origin_channel is forwarded so the response can route back to the
  issuing surface,
- the ttl defaults to the provider-published hint when present.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.service.service_query import ServiceQueryOrchestrator


ETA_PARAMS_SCHEMA = {
    "type": "object",
    "properties": {
        "location": {
            "type": "object",
            "properties": {
                "lat": {"type": "number"},
                "lng": {"type": "number"},
            },
            "required": ["lat", "lng"],
        },
        "route_id": {"type": "string"},
    },
    "required": ["location", "route_id"],
}


def _candidate(schema_hash: str = "cap-hash", include_schema: bool = True, ttl: int | None = None) -> dict:
    cap_schema = {
        "description": "Query ETA",
        "params": ETA_PARAMS_SCHEMA,
        "result": {"type": "object"},
        "schema_hash": schema_hash,
    }
    if ttl is not None:
        cap_schema["default_ttl_seconds"] = ttl
    candidate = {
        "operatorDid": "did:plc:provider",
        "name": "Test Transit",
    }
    if include_schema:
        candidate["capabilitySchemas"] = {"eta_query": cap_schema}
    return candidate


def _params() -> dict:
    return {
        "route_id": "42",
        "location": {"lat": 37.77, "lng": -122.43},
    }


def _orchestrator(candidate: dict | None):
    appview = MagicMock()
    appview.search_services = AsyncMock(
        return_value=[candidate] if candidate else [],
    )
    core = MagicMock()
    core.send_service_query = AsyncMock()
    notifier = AsyncMock()
    return ServiceQueryOrchestrator(appview, core, notifier), core, notifier


# TRACE: {"suite": "BRAIN", "case": "0621", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "01", "title": "orchestrator_forwards_schema_hash_and_origin_channel"}
@pytest.mark.asyncio
async def test_orchestrator_forwards_schema_hash_and_origin_channel():
    orch, core, notifier = _orchestrator(_candidate(schema_hash="hash-abc"))

    await orch.handle_user_query(
        "eta_query", _params(), origin_channel="telegram:12345",
    )

    core.send_service_query.assert_awaited_once()
    kw = core.send_service_query.await_args.kwargs
    assert kw["schema_hash"] == "hash-abc"
    assert kw["origin_channel"] == "telegram:12345"
    assert kw["capability"] == "eta_query"
    assert kw["to_did"] == "did:plc:provider"


# TRACE: {"suite": "BRAIN", "case": "0622", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "02", "title": "orchestrator_rejects_invalid_params_locally"}
@pytest.mark.asyncio
async def test_orchestrator_rejects_invalid_params_locally():
    """Bad params should never leave the Brain."""
    orch, core, notifier = _orchestrator(_candidate())

    # Missing required route_id — sender-side validation must catch it.
    bad = {"location": {"lat": 37.77, "lng": -122.43}}
    await orch.handle_user_query("eta_query", bad)

    core.send_service_query.assert_not_called()
    notifier.assert_awaited()
    assert "Invalid query params" in notifier.await_args.args[0]


# TRACE: {"suite": "BRAIN", "case": "0623", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "03", "title": "orchestrator_uses_schema_default_ttl"}
@pytest.mark.asyncio
async def test_orchestrator_uses_schema_default_ttl():
    orch, core, _ = _orchestrator(_candidate(ttl=180))
    await orch.handle_user_query("eta_query", _params())
    kw = core.send_service_query.await_args.kwargs
    assert kw["ttl_seconds"] == 180


@pytest.mark.asyncio
async def test_orchestrator_handles_candidate_without_schema():
    """Legacy AppView entries with no capabilitySchemas still send, but
    without a schema_hash (the provider can still respond; it just won't
    do hash-based version enforcement)."""
    orch, core, _ = _orchestrator(_candidate(include_schema=False))
    await orch.handle_user_query("eta_query", _params())
    kw = core.send_service_query.await_args.kwargs
    assert kw["schema_hash"] == ""


# TRACE: {"suite": "BRAIN", "case": "0625", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "05", "title": "orchestrator_no_candidates_notifies"}
@pytest.mark.asyncio
async def test_orchestrator_no_candidates_notifies_and_returns():
    orch, core, notifier = _orchestrator(None)
    await orch.handle_user_query("eta_query", _params())
    core.send_service_query.assert_not_called()
    notifier.assert_awaited_once()
    assert "No services found" in notifier.await_args.args[0]


# TRACE: {"suite": "BRAIN", "case": "0624", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "04", "title": "orchestrator_handles_non_geospatial"}
@pytest.mark.asyncio
async def test_orchestrator_handles_non_geospatial_query():
    """Schema-driven path must work for capabilities without a location.

    Orchestrator used to refuse any query whose params didn't have
    location.lat/lng — that baked geography into the contract. After
    #12, a non-geospatial call should reach send_service_query without
    a location requirement.
    """
    # Candidate with a non-geospatial params schema (just a query string).
    appview = MagicMock()
    appview.search_services = AsyncMock(return_value=[{
        "operatorDid": "did:plc:lookup",
        "name": "Lookup Service",
        "capabilitySchemas": {
            "keyword_lookup": {
                "description": "Keyword lookup.",
                "params": {
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                    "required": ["q"],
                },
                "result": {"type": "object"},
                "schema_hash": "kw-hash",
            },
        },
    }])
    core = MagicMock()
    core.send_service_query = AsyncMock()
    notifier = AsyncMock()
    orch = ServiceQueryOrchestrator(appview, core, notifier)

    await orch.handle_user_query("keyword_lookup", {"q": "astronomy"})

    core.send_service_query.assert_awaited_once()
    kw = core.send_service_query.await_args.kwargs
    assert kw["schema_hash"] == "kw-hash"
    assert kw["params"] == {"q": "astronomy"}
    # search_services was called without lat/lng (None) — the AppView
    # endpoint must be called and must not demand coordinates.
    appview.search_services.assert_awaited_once()
    sv_kw = appview.search_services.await_args.kwargs
    assert sv_kw["lat"] is None and sv_kw["lng"] is None


# TRACE: {"suite": "BRAIN", "case": "0626", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "06", "title": "retry_preserves_original_to_did"}
@pytest.mark.asyncio
async def test_retry_with_fresh_schema_targets_original_provider():
    """A schema_version_mismatch retry must go back to the same DID.

    If orchestrator re-ran discovery and picked the first candidate
    blindly, provider A's mismatch could silently reroute the query to
    provider B. Retry refreshes AppView but filters to the original DID.
    """
    original_did = "did:plc:original"
    other_did = "did:plc:different"
    appview = MagicMock()
    appview.search_services = AsyncMock(return_value=[
        # Higher-ranked unrelated provider.
        {"operatorDid": other_did, "name": "Other", "capabilitySchemas": {
            "eta_query": {"params": ETA_PARAMS_SCHEMA, "result": {}, "schema_hash": "other"},
        }},
        # The original provider with refreshed schema_hash.
        {"operatorDid": original_did, "name": "Original", "capabilitySchemas": {
            "eta_query": {"params": ETA_PARAMS_SCHEMA, "result": {}, "schema_hash": "fresh"},
        }},
    ])
    core = MagicMock()
    core.send_service_query = AsyncMock()
    notifier = AsyncMock()
    orch = ServiceQueryOrchestrator(appview, core, notifier)

    issued = await orch.retry_with_fresh_schema(
        to_did=original_did,
        capability="eta_query",
        params=_params(),
        origin_channel="telegram:42",
    )
    assert issued is True
    kw = core.send_service_query.await_args.kwargs
    assert kw["to_did"] == original_did
    assert kw["schema_hash"] == "fresh"
    assert kw["origin_channel"] == "telegram:42"


# TRACE: {"suite": "BRAIN", "case": "0627", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "03", "scenario": "07", "title": "retry_fails_closed_when_provider_missing"}
@pytest.mark.asyncio
async def test_retry_returns_false_if_provider_not_in_fresh_candidates():
    """If AppView no longer has the original provider, retry fails
    closed rather than rerouting silently."""
    appview = MagicMock()
    appview.search_services = AsyncMock(return_value=[
        {"operatorDid": "did:plc:someone-else", "name": "Other",
         "capabilitySchemas": {"eta_query": {"params": {}, "result": {}, "schema_hash": "x"}}},
    ])
    core = MagicMock()
    core.send_service_query = AsyncMock()
    orch = ServiceQueryOrchestrator(appview, core, AsyncMock())

    issued = await orch.retry_with_fresh_schema(
        to_did="did:plc:original",
        capability="eta_query",
        params=_params(),
    )
    assert issued is False
    core.send_service_query.assert_not_called()
