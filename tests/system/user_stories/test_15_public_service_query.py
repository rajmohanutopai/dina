"""User Story 15: Public Service Query — schema-driven discovery.

SEQUENTIAL TEST — tests MUST run in order (00 → 08).
Each test builds on state from the previous one.

Story
-----
Don Alonso needs to know when the next #42 bus arrives at Castro Station.
His Home Node sends a service.query to BusDriver (a public transit provider
already published on the Trust Network), BusDriver's Home Node validates
the query against the capability schema, delegates execution to its local
agent, the agent computes a schedule-based ETA, BusDriver bridges the
result back as a service.response, and Alonso's Home Node delivers a
workflow_event to the user.

This is the full WS2 requester↔provider arc exercised end-to-end across
two real Core+Brain actor pairs. The "local agent" step is simulated by
the test via the internal workflow-task completion callback, which is the
same endpoint main-dina's dina-agent would hit after claiming + executing
via OpenClaw. Exercising the actual pull-based claim ceremony is in scope
for Session C (release test REL-025 via dummy-agent CLI).

Why Dina is unique
------------------
Conventional service discovery means a centralized registry that
gatekeepers ranking and availability. Dina's requesters search a
decentralized Trust Network (AppView indexing AT Protocol records),
validate the provider's published schema client-side, and send typed
D2D queries directly to the provider's Home Node. No middleman owns
the contract, and the requester proves schema agreement via the
hash-in-the-query before bytes ever leave their device.

Contract under test
-------------------
- `ServiceConfigService.Put()` accepts a valid public capability with
  canonical schema_hash (provider gate).
- `POST /v1/service/query` at Alonso's Core creates a workflow_task and
  sends a D2D envelope to BusDriver.
- BusDriver's service_handler validates schema_hash + params before
  creating a delegation task (`payload_type=service_query_execution`,
  `schema_snapshot` persisted).
- Internal completion callback fires the bridge, which validates the
  result against the snapshot and emits a `service.response`.
- Alonso's Core routes the response into a terminal workflow_task for
  the original query_id, which surfaces as a workflow_event to Brain
  (and ultimately the user).
- Regression paths: stale schema_hash rejected; invalid params rejected;
  failed task surfaces agent error (not `result_schema_violation`).

Pipeline
--------
::

  Alonso publishes no service
    → configures BusDriver as a public `eta_query` provider (test setup)
    → Alonso's Core POST /v1/service/query {to_did, capability, params, schema_hash}
    → WS2: durable workflow_task created; D2D service.query sent
    → BusDriver's handle_query: validate hash + params → create delegation task
    → Internal callback (simulated dina-agent) POSTs result to /complete
    → Workflow.Complete bridges: validate result against snapshot → D2D service.response
    → Alonso's Core: inbound response matched to query's task → terminal + workflow_event
    → User sees "Bus 42 arrives in 7 min at Castro Station"
"""

from __future__ import annotations

import json
import time
import uuid

import httpx
import pytest


# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# Canonical schema + hash for the eta_query capability. The hex digest is
# what Brain's compute_schema_hash() and Core's canonicalSchemaHash()
# produce for this exact shape. Drift in either canonicaliser breaks this
# test (which is the point — regression guard for the cross-language
# canonical agreement).
ETA_QUERY_SCHEMA_HASH = "c48434dfc06a33520eb7543f29ef3a0aba7582d9ace25f5b9a838f84d27172ce"

ETA_QUERY_SCHEMA = {
    "description": "Query ETA",
    "params": {
        "type": "object",
        "required": ["route_id"],
        "properties": {
            "route_id": {"type": "string"},
        },
    },
    "result": {
        "type": "object",
        "required": ["eta_minutes"],
        "properties": {
            "eta_minutes": {"type": "integer"},
        },
    },
    "schema_hash": ETA_QUERY_SCHEMA_HASH,
}


# ---------------------------------------------------------------------------
# Fixtures local to this story (busdriver isn't in the shared conftest yet)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="class")
def busdriver_core(system_services):
    """Core URL for the BusDriver actor."""
    return system_services.core_url("busdriver")


@pytest.fixture(scope="class")
def busdriver_brain(system_services):
    """Brain URL for the BusDriver actor."""
    return system_services.brain_url("busdriver")


@pytest.fixture(scope="class")
def busdriver_did(system_services) -> str:
    return system_services.actor_did("busdriver")


@pytest.fixture(scope="class")
def callback_token() -> str:
    """Pre-shared token the internal workflow-task callbacks expect.

    Matches DINA_HOOK_CALLBACK_TOKEN in docker-compose-test-stack.yml.
    Falls back to the CLIENT_TOKEN if the hook-specific var isn't set
    (E2E-style test-mode deployments often share one token).
    """
    import os
    return os.environ.get(
        "DINA_HOOK_CALLBACK_TOKEN",
        "dina-callback-busdriver",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post_service_query(
    *, alonso_core: str, admin_headers: dict, to_did: str,
    capability: str, params: dict, schema_hash: str,
    ttl_seconds: int = 60, origin_channel: str = "",
) -> dict:
    body = {
        "to_did": to_did,
        "capability": capability,
        "params": params,
        "query_id": str(uuid.uuid4()),
        "ttl_seconds": ttl_seconds,
        "service_name": "SF Transit Authority",
        "schema_hash": schema_hash,
    }
    if origin_channel:
        body["origin_channel"] = origin_channel
    r = httpx.post(
        f"{alonso_core}/v1/service/query",
        json=body, headers=admin_headers, timeout=10,
    )
    assert r.status_code < 400, (
        f"POST /v1/service/query failed: {r.status_code} {r.text[:300]}"
    )
    data = r.json()
    return {"task_id": data.get("task_id", ""), "query_id": body["query_id"]}


def _wait_for_provider_task(
    *, busdriver_core: str, admin_headers: dict, query_id: str,
    timeout: float = 10.0,
) -> dict:
    """Poll BusDriver's workflow_tasks for a matching delegation task."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = httpx.get(
            f"{busdriver_core}/v1/workflow/tasks",
            params={"kind": "delegation", "limit": 50},
            headers=admin_headers, timeout=5,
        )
        if r.status_code == 200:
            for task in r.json().get("tasks", []) or []:
                if task.get("correlation_id") == query_id:
                    return task
        time.sleep(0.3)
    pytest.fail(
        f"BusDriver never created a delegation task for query_id={query_id}"
    )


def _complete_task(
    *, busdriver_core: str, callback_token: str,
    task_id: str, result: dict, summary: str = "ok",
) -> None:
    r = httpx.post(
        f"{busdriver_core}/v1/internal/workflow-tasks/{task_id}/complete",
        json={"result": summary, "result_json": result},
        headers={"Authorization": f"Bearer {callback_token}"},
        timeout=10,
    )
    assert r.status_code < 400, (
        f"Internal complete callback failed: {r.status_code} {r.text[:300]}"
    )


def _fail_task(
    *, busdriver_core: str, callback_token: str,
    task_id: str, error: str,
) -> None:
    r = httpx.post(
        f"{busdriver_core}/v1/internal/workflow-tasks/{task_id}/fail",
        json={"error": error},
        headers={"Authorization": f"Bearer {callback_token}"},
        timeout=10,
    )
    assert r.status_code < 400, (
        f"Internal fail callback failed: {r.status_code} {r.text[:300]}"
    )


def _wait_for_requester_terminal_task(
    *, alonso_core: str, admin_headers: dict, query_id: str,
    timeout: float = 20.0,
) -> dict:
    """Poll Alonso's workflow_tasks for the service_query task to terminalise.

    The requester-side service_query task is created by POST
    /v1/service/query and terminates (completed/failed) when the D2D
    response arrives or TTL expires.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = httpx.get(
            f"{alonso_core}/v1/workflow/tasks",
            params={"kind": "service_query", "limit": 50},
            headers=admin_headers, timeout=5,
        )
        if r.status_code == 200:
            for task in r.json().get("tasks", []) or []:
                if task.get("correlation_id") != query_id:
                    continue
                if task.get("status") in ("completed", "failed"):
                    return task
        time.sleep(0.3)
    pytest.fail(
        f"Alonso never saw a terminal service_query task for query_id={query_id}"
    )


def _task_events(
    *, core_url: str, admin_headers: dict, task_id: str,
) -> list[dict]:
    r = httpx.get(
        f"{core_url}/v1/workflow/tasks/{task_id}/events",
        headers=admin_headers, timeout=5,
    )
    if r.status_code != 200:
        return []
    return r.json().get("events", []) or []


# ---------------------------------------------------------------------------
# Story 15: Public Service Query
# ---------------------------------------------------------------------------

class TestPublicServiceQuery:
    """User Story 15: Schema-driven public service discovery + query."""

    # ==================================================================
    # test_00: Publish BusDriver's service config
    # ==================================================================

    # TST-USR-150
    def test_00_publish_busdriver_service_config(
        self, busdriver_core, admin_headers,
    ):
        """Configure BusDriver's Home Node as a public ``eta_query`` provider.

        Admin flow: ``PUT /v1/service/config`` with is_public=true, one
        capability, and a canonically-hashed schema. The Put gate
        verifies the supplied schema_hash matches the canonical form, so
        a drift between Python's compute_schema_hash and Go's
        canonicalSchemaHash fails here — this is the cross-language
        agreement regression guard at the story level.
        """
        cfg = {
            "is_public": True,
            "name": "SF Transit Authority",
            "description": "Schedule-based bus ETAs for SF Muni routes.",
            "capabilities": {
                "eta_query": {"response_policy": "auto"},
            },
            "capability_schemas": {"eta_query": ETA_QUERY_SCHEMA},
            "service_area": {"lat": 37.77, "lng": -122.43, "radius_km": 25.0},
        }
        r = httpx.put(
            f"{busdriver_core}/v1/service/config",
            json=cfg, headers=admin_headers, timeout=10,
        )
        assert r.status_code < 400, (
            f"PUT /v1/service/config failed: {r.status_code} {r.text[:300]}"
        )
        _state["config_published"] = True

    # TST-USR-151
    def test_01_service_config_round_trips(
        self, busdriver_core, admin_headers,
    ):
        """GET /v1/service/config returns the stored schema intact."""
        assert _state.get("config_published"), "test_00 did not publish config"
        r = httpx.get(
            f"{busdriver_core}/v1/service/config",
            headers=admin_headers, timeout=5,
        )
        assert r.status_code == 200
        cfg = r.json()
        assert cfg and cfg.get("is_public") is True
        eta = (cfg.get("capability_schemas") or {}).get("eta_query") or {}
        assert eta.get("schema_hash") == ETA_QUERY_SCHEMA_HASH, (
            f"schema_hash drifted between PUT and GET: "
            f"{eta.get('schema_hash')} vs {ETA_QUERY_SCHEMA_HASH}"
        )

    # ==================================================================
    # test_02 / test_03 / test_04: Happy path — query, delegation, bridge
    # ==================================================================

    # TST-USR-152
    def test_02_alonso_sends_valid_service_query(
        self, alonso_core, admin_headers, busdriver_did,
    ):
        """Alonso's Core accepts the query and returns a task_id."""
        query = _post_service_query(
            alonso_core=alonso_core, admin_headers=admin_headers,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash=ETA_QUERY_SCHEMA_HASH,
            ttl_seconds=120,
            origin_channel="telegram:alonso-chat",
        )
        assert query["task_id"], "No task_id returned for valid query"
        _state["happy_query_id"] = query["query_id"]
        _state["happy_task_id_alonso"] = query["task_id"]

    # TST-USR-153
    def test_03_busdriver_creates_delegation_task(
        self, busdriver_core, admin_headers,
    ):
        """BusDriver's handle_query validates + creates a delegation task."""
        qid = _state["happy_query_id"]
        task = _wait_for_provider_task(
            busdriver_core=busdriver_core, admin_headers=admin_headers,
            query_id=qid,
        )
        assert task.get("payload_type") == "service_query_execution", (
            f"Expected payload_type=service_query_execution, got {task.get('payload_type')!r}"
        )
        payload = task.get("payload", {})
        if isinstance(payload, str):
            payload = json.loads(payload)
        assert payload.get("schema_hash") == ETA_QUERY_SCHEMA_HASH
        snapshot = payload.get("schema_snapshot") or {}
        assert snapshot, "schema_snapshot missing — bridge cannot validate later"
        assert snapshot.get("params") == ETA_QUERY_SCHEMA["params"]
        assert snapshot.get("result") == ETA_QUERY_SCHEMA["result"]
        _state["happy_task_id_busdriver"] = task["id"]

    # TST-USR-154
    def test_04_simulated_agent_completes_task(
        self, busdriver_core, callback_token,
    ):
        """Internal callback — same endpoint dina-agent hits after OpenClaw."""
        task_id = _state["happy_task_id_busdriver"]
        _complete_task(
            busdriver_core=busdriver_core, callback_token=callback_token,
            task_id=task_id,
            result={"eta_minutes": 7, "stop_name": "Castro Station"},
        )

    # TST-USR-155
    def test_05_alonso_receives_terminal_workflow_task(
        self, alonso_core, admin_headers,
    ):
        """Bridge-emitted service.response terminates Alonso's query task."""
        qid = _state["happy_query_id"]
        task = _wait_for_requester_terminal_task(
            alonso_core=alonso_core, admin_headers=admin_headers,
            query_id=qid,
        )
        assert task.get("status") == "completed", (
            f"Expected completed service_query task, got status={task.get('status')}"
        )
        _state["happy_alonso_terminal_id"] = task["id"]

    # ==================================================================
    # test_06: Schema hash mismatch rejected (negative)
    # ==================================================================

    # TST-USR-156
    def test_06_stale_schema_hash_rejected_without_delegation(
        self, alonso_core, busdriver_core, admin_headers, busdriver_did,
    ):
        """Stale hash surfaces ``schema_version_mismatch`` with no delegation."""
        query = _post_service_query(
            alonso_core=alonso_core, admin_headers=admin_headers,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash="deadbeef-not-the-hash",
        )
        qid = query["query_id"]
        terminal = _wait_for_requester_terminal_task(
            alonso_core=alonso_core, admin_headers=admin_headers,
            query_id=qid,
        )
        events = _task_events(
            core_url=alonso_core, admin_headers=admin_headers,
            task_id=terminal["id"],
        )
        joined = json.dumps(events)
        assert "schema_version_mismatch" in joined, (
            f"Expected schema_version_mismatch in Alonso's events, got: {joined[:400]}"
        )

        # No delegation task was ever created on BusDriver's side.
        r = httpx.get(
            f"{busdriver_core}/v1/workflow/tasks",
            params={"kind": "delegation", "limit": 50},
            headers=admin_headers, timeout=5,
        )
        if r.status_code == 200:
            for task in r.json().get("tasks", []) or []:
                assert task.get("correlation_id") != qid, (
                    "Provider created a delegation task for a stale-hash request"
                )

    # ==================================================================
    # test_07: Invalid params rejected (negative)
    # ==================================================================

    # TST-USR-157
    def test_07_missing_required_param_rejected(
        self, alonso_core, admin_headers, busdriver_did,
    ):
        """eta_query without ``route_id`` fails provider's params validation."""
        query = _post_service_query(
            alonso_core=alonso_core, admin_headers=admin_headers,
            to_did=busdriver_did,
            capability="eta_query",
            params={},  # missing required route_id
            schema_hash=ETA_QUERY_SCHEMA_HASH,
        )
        terminal = _wait_for_requester_terminal_task(
            alonso_core=alonso_core, admin_headers=admin_headers,
            query_id=query["query_id"],
        )
        events = _task_events(
            core_url=alonso_core, admin_headers=admin_headers,
            task_id=terminal["id"],
        )
        joined = json.dumps(events).lower()
        assert "invalid params" in joined or "route_id" in joined, (
            f"Expected params-validation error in events, got: {joined[:400]}"
        )

    # ==================================================================
    # test_08: Failed task surfaces agent error (negative)
    # ==================================================================

    # TST-USR-158
    def test_08_failed_task_surfaces_agent_error_not_schema_violation(
        self, alonso_core, busdriver_core, admin_headers, callback_token,
        busdriver_did,
    ):
        """Agent failure → ``status=error`` with task.Error, not wrapped.

        Regression guard: before the failed-task branch landed, a failed
        task's error text was wrapped as ``{"message": ...}``, then the
        bridge's result-schema validator turned it into
        ``result_schema_violation`` — the requester never saw the actual
        error. This test locks in that the real error reaches the user.
        """
        query = _post_service_query(
            alonso_core=alonso_core, admin_headers=admin_headers,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash=ETA_QUERY_SCHEMA_HASH,
        )
        qid = query["query_id"]

        provider_task = _wait_for_provider_task(
            busdriver_core=busdriver_core, admin_headers=admin_headers,
            query_id=qid,
        )
        _fail_task(
            busdriver_core=busdriver_core, callback_token=callback_token,
            task_id=provider_task["id"],
            error="route unreachable",
        )

        terminal = _wait_for_requester_terminal_task(
            alonso_core=alonso_core, admin_headers=admin_headers,
            query_id=qid,
        )
        events = _task_events(
            core_url=alonso_core, admin_headers=admin_headers,
            task_id=terminal["id"],
        )
        joined = json.dumps(events)
        assert "route unreachable" in joined, (
            f"Expected agent error verbatim in Alonso's events, got: {joined[:400]}"
        )
        assert "result_schema_violation" not in joined, (
            "Failed task was mistakenly wrapped + schema-validated"
        )
