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
        "is_public": True,
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
