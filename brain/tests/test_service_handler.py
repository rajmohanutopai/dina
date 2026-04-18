"""Tests for the service-query provider path: validation → delegation → bridge.

Exercises the load-bearing behaviour introduced with the transit demo:
- `handle_query` routes auto policy through `_create_execution_task` with the
  request schema_hash persisted in the task payload.
- `handle_query` routes review policy through `_create_approval_task` (not a
  direct send_service_respond) and `execute_and_respond` later creates a
  delegation task instead of sending an empty success response.
- Schema-hash mismatches surface as an error response without a task being
  created.
- `ServicePublisher.publish` emits `capabilitySchemas` + per-capability
  `schema_hash` so AppView can serve the schema to requesters.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.domain.errors import WorkflowConflictError
from src.service.capabilities.registry import compute_schema_hash
from src.service.service_handler import ServiceHandler
from src.service.service_publisher import ServicePublisher


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

ETA_PARAMS_SCHEMA = {
    "type": "object",
    "properties": {
        "route_id": {"type": "string"},
        "lat": {"type": "number"},
        "lng": {"type": "number"},
    },
    "required": ["route_id", "lat", "lng"],
}

ETA_RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "eta_minutes": {"type": "integer"},
        "stop_name": {"type": "string"},
    },
    "required": ["eta_minutes", "stop_name"],
}


def _service_config(response_policy: str, *, include_schema_hash: bool = True) -> dict:
    canonical = {
        "description": "Query estimated time of arrival.",
        "params": ETA_PARAMS_SCHEMA,
        "result": ETA_RESULT_SCHEMA,
    }
    schema = dict(canonical)
    if include_schema_hash:
        schema["schema_hash"] = compute_schema_hash(canonical)
    return {
        "is_discoverable": True,
        "name": "Test Transit",
        "capabilities": {
            "eta_query": {
                "response_policy": response_policy,
                "mcp_server": "transit",
                "mcp_tool": "get_eta",
            }
        },
        "capability_schemas": {"eta_query": schema},
        "service_area": {"lat": 37.77, "lng": -122.43, "radius_km": 10.0},
    }


def _query_body(schema_hash: str, params: dict | None = None) -> dict:
    return {
        "query_id": "q-test",
        "capability": "eta_query",
        "params": params if params is not None else {"route_id": "42", "lat": 37.77, "lng": -122.43},
        "ttl_seconds": 90,
        "schema_hash": schema_hash,
    }


# ---------------------------------------------------------------------------
# handle_query: auto policy
# ---------------------------------------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0612", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "01", "title": "auto_creates_delegation_with_schema_hash"}
@pytest.mark.asyncio
async def test_auto_policy_creates_execution_task_with_persisted_schema_hash():
    config = _service_config("auto")
    expected_hash = config["capability_schemas"]["eta_query"]["schema_hash"]

    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.send_d2d = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    await handler.handle_query("did:plc:requester", _query_body(expected_hash))

    core.create_workflow_task.assert_awaited_once()
    kwargs = core.create_workflow_task.await_args.kwargs
    assert kwargs["kind"] == "delegation"
    payload = json.loads(kwargs["payload"])
    assert payload["type"] == "service_query_execution"
    assert payload["from_did"] == "did:plc:requester"
    assert payload["schema_hash"] == expected_hash
    assert payload["ttl_seconds"] == 90
    # Auto path must not send a D2D response — execution goes through the
    # completion bridge, which is Core's responsibility.
    core.send_d2d.assert_not_called()


# TRACE: {"suite": "BRAIN", "case": "0613", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "02", "title": "schema_hash_mismatch_rejected"}
@pytest.mark.asyncio
async def test_schema_hash_mismatch_returns_error_without_creating_task():
    config = _service_config("auto")
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.send_d2d = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    await handler.handle_query("did:plc:requester", _query_body("stale-hash"))

    core.create_workflow_task.assert_not_called()
    core.send_d2d.assert_awaited_once()
    sent = core.send_d2d.await_args.kwargs
    assert sent["msg_type"] == "service.response"
    assert sent["payload"]["status"] == "error"
    assert sent["payload"]["result"]["error"] == "schema_version_mismatch"


# TRACE: {"suite": "BRAIN", "case": "0614", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "03", "title": "invalid_params_rejected"}
@pytest.mark.asyncio
async def test_invalid_params_rejected_before_task_creation():
    config = _service_config("auto")
    expected_hash = config["capability_schemas"]["eta_query"]["schema_hash"]
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.send_d2d = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    # Missing required route_id.
    await handler.handle_query(
        "did:plc:requester",
        _query_body(expected_hash, params={"lat": 37.77, "lng": -122.43}),
    )

    core.create_workflow_task.assert_not_called()
    core.send_d2d.assert_awaited_once()
    assert core.send_d2d.await_args.kwargs["payload"]["status"] == "error"


# ---------------------------------------------------------------------------
# handle_query: review policy
# ---------------------------------------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0616", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "05", "title": "review_policy_creates_approval"}
@pytest.mark.asyncio
async def test_review_policy_creates_approval_task_only():
    config = _service_config("review")
    expected_hash = config["capability_schemas"]["eta_query"]["schema_hash"]
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.send_d2d = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    await handler.handle_query("did:plc:requester", _query_body(expected_hash))

    core.create_workflow_task.assert_awaited_once()
    kwargs = core.create_workflow_task.await_args.kwargs
    assert kwargs["kind"] == "approval"
    payload = json.loads(kwargs["payload"])
    assert payload["schema_hash"] == expected_hash
    # Nothing on the wire yet — operator hasn't approved.
    core.send_d2d.assert_not_called()


# ---------------------------------------------------------------------------
# execute_and_respond: approval path delegates to a new execution task
# ---------------------------------------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0619", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "02", "scenario": "01", "title": "approval_spawns_exec_task_and_cancels_approval"}
@pytest.mark.asyncio
async def test_execute_and_respond_creates_execution_task_and_cancels_approval():
    config = _service_config("review")
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.cancel_workflow_task = AsyncMock()
    core.send_service_respond = AsyncMock()  # must NOT be called
    handler = ServiceHandler(core_client=core, service_config=config)

    approval_task_id = "approval-abc"
    approval_payload = {
        "type": "service_query_execution",
        "from_did": "did:plc:requester",
        "query_id": "q-review",
        "capability": "eta_query",
        "params": {"route_id": "42", "lat": 37.77, "lng": -122.43},
        "ttl_seconds": 90,
        "schema_hash": "the-hash",
    }

    await handler.execute_and_respond(approval_task_id, approval_payload)

    # Delegation task created with deterministic ID and persisted schema_hash.
    core.create_workflow_task.assert_awaited_once()
    kwargs = core.create_workflow_task.await_args.kwargs
    assert kwargs["kind"] == "delegation"
    assert kwargs["task_id"] == f"svc-exec-from-{approval_task_id}"
    payload = json.loads(kwargs["payload"])
    assert payload["schema_hash"] == "the-hash"
    assert payload["ttl_seconds"] == 90

    # Approval task closed out — idempotent cancel.
    core.cancel_workflow_task.assert_awaited_once_with(approval_task_id)

    # Critically: NO empty /v1/service/respond call. Under the new
    # architecture the completion bridge emits the real response once
    # OpenClaw finishes the delegation task.
    core.send_service_respond.assert_not_called()


# TRACE: {"suite": "BRAIN", "case": "0620", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "02", "scenario": "02", "title": "duplicate_exec_task_tolerated"}
@pytest.mark.asyncio
async def test_execute_and_respond_tolerates_duplicate_execution_task():
    config = _service_config("review")
    core = MagicMock()
    core.create_workflow_task = AsyncMock(
        side_effect=WorkflowConflictError("already exists")
    )
    core.cancel_workflow_task = AsyncMock()
    core.send_service_respond = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    approval_payload = {
        "type": "service_query_execution",
        "from_did": "did:plc:requester",
        "query_id": "q-dup",
        "capability": "eta_query",
        "params": {"route_id": "42", "lat": 37.77, "lng": -122.43},
        "ttl_seconds": 60,
        "schema_hash": "the-hash",
    }

    # Reconciliation retry: execution task already exists. Must not raise,
    # and must still cancel the approval task.
    await handler.execute_and_respond("approval-xyz", approval_payload)
    core.cancel_workflow_task.assert_awaited_once_with("approval-xyz")
    core.send_service_respond.assert_not_called()


# ---------------------------------------------------------------------------
# ServicePublisher: emits capabilitySchemas + schemaHash
# ---------------------------------------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0629", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "04", "scenario": "02", "title": "publisher_refuses_on_did_mismatch"}
@pytest.mark.asyncio
async def test_publish_refuses_when_pds_session_did_mismatches_core():
    """Publisher must not publish under a foreign identity.

    If the PDS session DID doesn't match Core's DID, something is
    misconfigured (wrong credentials, wrong Core). Publishing would put
    this Home Node's service profile under someone else's DID on PLC.
    Guard-rail: publisher logs and returns without calling put_record.
    """
    config = _service_config("auto", include_schema_hash=False)
    core = MagicMock()
    core.get_service_config = AsyncMock(return_value=config)
    core.get_did = AsyncMock(return_value={"id": "did:plc:core-identity"})
    pds = MagicMock()
    # Session authenticated as a different DID than Core's.
    pds.did = "did:plc:someone-else"
    pds.put_record = AsyncMock()

    publisher = ServicePublisher(core_client=core, pds_publisher=pds)
    await publisher.publish()

    pds.put_record.assert_not_called()


# TRACE: {"suite": "BRAIN", "case": "0630", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "04", "scenario": "03", "title": "publisher_passes_default_ttl_seconds"}
@pytest.mark.asyncio
async def test_publish_preserves_default_ttl_seconds_hint():
    """TTL hint must survive the publisher's projection step.

    Earlier the publisher stripped each entry down to
    description/params/result/schema_hash, silently dropping TTL hints.
    With #8 fixed it passes default_ttl_seconds through when present.
    """
    config = _service_config("auto", include_schema_hash=False)
    # Add a TTL hint on the capability schema.
    config["capability_schemas"]["eta_query"]["default_ttl_seconds"] = 180

    core = MagicMock()
    core.get_service_config = AsyncMock(return_value=config)
    core.get_did = AsyncMock(return_value={"id": "did:plc:publisher"})
    pds = MagicMock()
    pds.did = "did:plc:publisher"
    pds.put_record = AsyncMock()

    publisher = ServicePublisher(core_client=core, pds_publisher=pds)
    await publisher.publish()

    record = pds.put_record.await_args.kwargs["record"]
    cap = record["capabilitySchemas"]["eta_query"]
    assert cap.get("default_ttl_seconds") == 180, (
        "publisher dropped default_ttl_seconds before writing to PDS"
    )


# TRACE: {"suite": "BRAIN", "case": "0628", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "04", "scenario": "01", "title": "publisher_emits_capability_schemas_and_hashes"}
@pytest.mark.asyncio
async def test_publish_emits_per_capability_schemas_and_hashes():
    config = _service_config("auto", include_schema_hash=False)
    core = MagicMock()
    core.get_service_config = AsyncMock(return_value=config)
    core.get_did = AsyncMock(return_value={"id": "did:plc:publisher"})

    pds = MagicMock()
    pds.did = "did:plc:publisher"
    pds.put_record = AsyncMock()

    publisher = ServicePublisher(core_client=core, pds_publisher=pds)
    await publisher.publish()

    pds.put_record.assert_awaited_once()
    kwargs = pds.put_record.await_args.kwargs
    assert kwargs["collection"] == "com.dina.service.profile"
    record = kwargs["record"]
    assert "capabilitySchemas" in record, "publisher must emit capabilitySchemas"
    assert "schemaHash" not in record, "top-level schemaHash is deprecated"
    cap = record["capabilitySchemas"]["eta_query"]
    assert cap["params"] == ETA_PARAMS_SCHEMA
    assert cap["result"] == ETA_RESULT_SCHEMA
    # Per-capability hash present and deterministic.
    expected_hash = compute_schema_hash({
        "description": "Query estimated time of arrival.",
        "params": ETA_PARAMS_SCHEMA,
        "result": ETA_RESULT_SCHEMA,
    })
    assert cap["schema_hash"] == expected_hash


# TRACE: {"suite": "BRAIN", "case": "0631", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "04", "scenario": "04", "title": "publisher_scales_service_area_coords_to_e7"}
@pytest.mark.asyncio
async def test_publish_scales_service_area_coords_to_integer_e7():
    """serviceArea must use integer latE7/lngE7 at the PDS boundary.

    AT Protocol's CBOR encoding rejects floats in records — a putRecord
    with floating-point lat/lng returns "Bad record". The publisher
    scales Core's float coords by 1e7 and stores them as integers so the
    record survives lexicon validation; ingester converts back at read.
    """
    config = _service_config("auto", include_schema_hash=False)
    core = MagicMock()
    core.get_service_config = AsyncMock(return_value=config)
    core.get_did = AsyncMock(return_value={"id": "did:plc:publisher"})
    pds = MagicMock()
    pds.did = "did:plc:publisher"
    pds.put_record = AsyncMock()

    publisher = ServicePublisher(core_client=core, pds_publisher=pds)
    await publisher.publish()

    record = pds.put_record.await_args.kwargs["record"]
    area = record["serviceArea"]
    assert area["latE7"] == 377700000, "latE7 must be lat * 1e7 as integer"
    assert area["lngE7"] == -1224300000, "lngE7 must be lng * 1e7 as integer"
    assert area["radiusKm"] == 10
    assert "lat" not in area, "raw float lat must not leak into the record"
    assert "lng" not in area, "raw float lng must not leak into the record"


# ---------------------------------------------------------------------------
# Provider ingress: schema_hash bypass + schema snapshot on task
# ---------------------------------------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0615", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "04", "title": "missing_schema_hash_rejected"}
@pytest.mark.asyncio
async def test_request_missing_schema_hash_is_rejected_when_schema_configured():
    """Schema-configured providers must reject requests that omit the hash.

    Previously, the check short-circuited when the requester didn't supply
    a schema_hash — allowing clients to opt out of version enforcement
    entirely. Now the provider requires the hash whenever it has one.
    """
    config = _service_config("auto")
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    core.send_d2d = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    body = _query_body("")  # hash omitted
    body.pop("schema_hash", None)
    await handler.handle_query("did:plc:requester", body)

    core.create_workflow_task.assert_not_called()
    core.send_d2d.assert_awaited_once()
    assert core.send_d2d.await_args.kwargs["payload"]["result"]["error"] == "schema_version_mismatch"


# TRACE: {"suite": "BRAIN", "case": "0617", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "06", "title": "execution_task_persists_schema_snapshot"}
@pytest.mark.asyncio
async def test_execution_task_persists_schema_snapshot():
    """The task payload must carry the full schema (params + result) so
    the completion bridge validates results against the agreed version,
    not whatever the provider config happens to hold at completion time.
    """
    config = _service_config("auto")
    expected_hash = config["capability_schemas"]["eta_query"]["schema_hash"]
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    await handler.handle_query("did:plc:requester", _query_body(expected_hash))

    payload = json.loads(core.create_workflow_task.await_args.kwargs["payload"])
    snapshot = payload.get("schema_snapshot")
    assert isinstance(snapshot, dict) and snapshot, "schema_snapshot must be persisted on the task"
    assert snapshot["params"] == ETA_PARAMS_SCHEMA
    assert snapshot["result"] == ETA_RESULT_SCHEMA


# TRACE: {"suite": "BRAIN", "case": "0618", "section": "28", "sectionName": "WS2 Schema-Driven Service Discovery", "subsection": "01", "scenario": "07", "title": "task_description_does_not_leak_params"}
@pytest.mark.asyncio
async def test_execution_task_description_does_not_leak_params():
    """Task descriptions surface in logs and admin UI — keep params out."""
    config = _service_config("auto")
    expected_hash = config["capability_schemas"]["eta_query"]["schema_hash"]
    core = MagicMock()
    core.create_workflow_task = AsyncMock()
    handler = ServiceHandler(core_client=core, service_config=config)

    sensitive = {"route_id": "42", "lat": 37.762345, "lng": -122.434567}
    await handler.handle_query(
        "did:plc:requester", _query_body(expected_hash, params=sensitive),
    )

    description = core.create_workflow_task.await_args.kwargs["description"]
    for value in ("37.762345", "-122.434567", "route_id"):
        assert value not in description, f"description leaked {value!r}"
