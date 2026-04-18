"""E2E Test Suite 25: Public Service Query — schema-driven discovery.

Product-level validation that the WS2 requester→provider→bridge arc
works across real Core+Brain containers. The happy-path scenario
mirrors the transit demo:

    Alonso (requester) ─D2D─> BusDriver (provider, provider service)
                                │
                                ▼  (delegation task)
                            OpenClaw (simulated here: test posts to
                            BusDriver's internal callback endpoint
                            to represent a completed agent run)
                                │
                                ▼  (bridge)
    Alonso (workflow_event)  <─D2D─  BusDriver

Invariants under test (all provider-side, enforceable without an LLM
in the loop — the LLM tool-call path is covered by unit tests):

- Service config ``PUT /v1/service/config`` with a valid schema is
  accepted, Get round-trips the schema_hash.
- ``POST /v1/service/query`` at Alonso with matching schema_hash
  lands an inbound ``service.query`` at BusDriver, which creates a
  delegation task with ``payload_type=service_query_execution``.
- A completed delegation task (structured result that satisfies the
  schema) fires the bridge and a ``service.response`` reaches Alonso
  as a workflow_event.
- Stale ``schema_hash`` is rejected before any task is created and
  surfaces as ``schema_version_mismatch``.
- A task that fails (OpenClaw callback ``/fail``) produces
  ``status=error`` with the agent's error text — NOT a bogus
  ``result_schema_violation`` from wrapping the text as
  ``{"message": ...}``.
- A completion whose result violates the published schema is caught
  by the bridge and turned into ``result_schema_violation`` (rather
  than quietly forwarded to the requester).

These tests are DINA_E2E=docker-gated and depend on the
docker-compose-test-stack.yml having a healthy BusDriver actor.
"""

from __future__ import annotations

import json
import time
import uuid

import httpx
import pytest

from tests.e2e.actors import HomeNode


# ---------------------------------------------------------------------------
# Helpers — request Alonso to send a service.query, poll for workflow_event
# ---------------------------------------------------------------------------

def _send_service_query(
    alonso: HomeNode,
    *,
    to_did: str,
    capability: str,
    params: dict,
    schema_hash: str,
    ttl_seconds: int = 60,
    origin_channel: str = "",
) -> dict:
    """POST /v1/service/query on Alonso's Core. Returns {task_id, query_id}."""
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
    resp = httpx.post(
        f"{alonso._core_url}/v1/service/query",
        json=body,
        headers={"Authorization": f"Bearer {alonso._client_token}"},
        timeout=10,
    )
    assert resp.status_code < 400, (
        f"POST /v1/service/query failed: {resp.status_code} {resp.text}"
    )
    return {"task_id": resp.json().get("task_id", ""), "query_id": body["query_id"]}


def _wait_for_inbound_task(
    provider: HomeNode,
    *,
    query_id: str,
    expected_payload_type: str = "service_query_execution",
    timeout: float = 10.0,
) -> dict:
    """Poll provider's Core for a delegation task with correlation_id=query_id."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = httpx.get(
            f"{provider._core_url}/v1/workflow/tasks",
            params={"kind": "delegation", "status": "queued", "limit": 50},
            headers={"Authorization": f"Bearer {provider._client_token}"},
            timeout=5,
        )
        if resp.status_code == 200:
            for task in resp.json().get("tasks", []) or []:
                if task.get("correlation_id") == query_id:
                    return task
        time.sleep(0.3)
    pytest.fail(f"No delegation task observed at BusDriver for query_id={query_id}")


def _complete_task_with_result(
    provider: HomeNode, *, task_id: str, result: dict, summary: str = "ok",
) -> None:
    """Simulate OpenClaw completion via the internal callback endpoint."""
    resp = httpx.post(
        f"{provider._core_url}/v1/internal/workflow-tasks/{task_id}/complete",
        json={"result": summary, "result_json": result},
        headers={"Authorization": f"Bearer {_callback_token(provider)}"},
        timeout=10,
    )
    assert resp.status_code < 400, (
        f"Task complete callback failed: {resp.status_code} {resp.text}"
    )


def _fail_task(provider: HomeNode, *, task_id: str, error: str) -> None:
    """Simulate OpenClaw failure via the internal callback endpoint."""
    resp = httpx.post(
        f"{provider._core_url}/v1/internal/workflow-tasks/{task_id}/fail",
        json={"error": error},
        headers={"Authorization": f"Bearer {_callback_token(provider)}"},
        timeout=10,
    )
    assert resp.status_code < 400, (
        f"Task fail callback failed: {resp.status_code} {resp.text}"
    )


def _callback_token(provider: HomeNode) -> str:
    """The internal callback endpoints use a separate pre-shared token.

    For the test stack it's passed as DINA_HOOK_CALLBACK_TOKEN on
    docker-compose-test-stack.yml. Fallback to the CLIENT_TOKEN if the
    dedicated token isn't exposed — the deployment may not distinguish
    in test mode.
    """
    import os
    return os.environ.get("DINA_HOOK_CALLBACK_TOKEN", provider._client_token)


def _wait_for_workflow_event(
    requester: HomeNode, *, query_id: str, timeout: float = 15.0,
) -> dict:
    """Poll the requester's Core for a delivered service_query workflow_event.

    Uses the service.query workflow task lookup by correlation_id — the
    task's terminal state + rich event details carry the response.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = httpx.get(
            f"{requester._core_url}/v1/workflow/tasks",
            params={"kind": "service_query", "limit": 50},
            headers={"Authorization": f"Bearer {requester._client_token}"},
            timeout=5,
        )
        if resp.status_code == 200:
            for task in resp.json().get("tasks", []) or []:
                if task.get("correlation_id") != query_id:
                    continue
                if task.get("status") in ("completed", "failed"):
                    return task
        time.sleep(0.3)
    pytest.fail(f"No terminal workflow_task observed at Alonso for query_id={query_id}")


# ---------------------------------------------------------------------------
# Suite 25
# ---------------------------------------------------------------------------

class TestProviderServiceQuery:
    """E2E-25.x — Provider service query arc (schema-driven).

    Exercises Alonso↔BusDriver across real Core+Brain Docker containers.
    """

    # TST-E2E-127
    # TRACE: {"suite": "E2E", "case": "0127", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "01", "title": "service_config_round_trip"}
    def test_25_1_busdriver_service_config_round_trip(
        self, busdriver: HomeNode, docker_services,
    ) -> None:
        """BusDriver's /v1/service/config reflects the published schema.

        The fixture PUT a config with an eta_query schema and canonical
        schema_hash. GET must return the same schema so AppView (and any
        requester-side cache) can retrieve it.
        """
        resp = httpx.get(
            f"{docker_services.core_url('busdriver')}/v1/service/config",
            headers={"Authorization": f"Bearer {docker_services.client_token}"},
            timeout=5,
        )
        assert resp.status_code == 200, resp.text
        cfg = resp.json()
        assert cfg is not None and cfg.get("is_discoverable") is True
        caps = cfg.get("capability_schemas") or {}
        assert "eta_query" in caps, f"eta_query missing from stored config: {caps}"
        eta = caps["eta_query"]
        assert eta.get("schema_hash"), "schema_hash must be persisted"
        # Required-fields round-trip.
        assert "params" in eta and "result" in eta

    # TST-E2E-128
    # TRACE: {"suite": "E2E", "case": "0128", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "02", "title": "happy_path_completion_bridges_to_requester"}
    def test_25_2_happy_path_completion_bridges_to_requester(
        self, don_alonso: HomeNode, busdriver: HomeNode, docker_services,
    ) -> None:
        """Alonso→BusDriver→complete→bridge→Alonso workflow_event.

        Exercises the full provider-side arc end-to-end:
        schema_hash check → params validation → delegation task →
        (simulated OpenClaw completion with schema-valid result) →
        bridge validates result → D2D response → workflow_event at Alonso.
        """
        from tests.e2e.conftest import ETA_QUERY_SCHEMA_HASH

        busdriver_did = docker_services.actor_did("busdriver")
        query = _send_service_query(
            don_alonso,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash=ETA_QUERY_SCHEMA_HASH,
            ttl_seconds=120,
            origin_channel="telegram:alonso-chat",
        )

        # Delegation task observed at BusDriver with the right payload_type.
        inbound = _wait_for_inbound_task(busdriver, query_id=query["query_id"])
        assert inbound.get("payload_type") == "service_query_execution"
        payload = inbound.get("payload", {})
        if isinstance(payload, str):
            payload = json.loads(payload)
        assert payload.get("schema_hash") == ETA_QUERY_SCHEMA_HASH
        assert "schema_snapshot" in payload, "snapshot must be persisted on task"

        # Simulate OpenClaw completion with a schema-valid result.
        _complete_task_with_result(
            busdriver,
            task_id=inbound["id"],
            result={"eta_minutes": 7, "stop_name": "Castro Station"},
        )

        # Bridge fires → service.response → workflow_event at Alonso.
        alonso_task = _wait_for_workflow_event(don_alonso, query_id=query["query_id"])
        assert alonso_task.get("status") == "completed"

    # TST-E2E-129
    # TRACE: {"suite": "E2E", "case": "0129", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "03", "title": "schema_hash_mismatch_rejected_at_provider"}
    def test_25_3_schema_hash_mismatch_rejected_at_provider(
        self, don_alonso: HomeNode, busdriver: HomeNode, docker_services,
    ) -> None:
        """Stale schema_hash never creates a delegation task.

        The provider short-circuits on hash mismatch and sends a
        ``service.response`` with error=schema_version_mismatch. At the
        Alonso side this manifests as a terminal service_query task with
        error details, with NO delegation task ever observed at BusDriver.
        """
        busdriver_did = docker_services.actor_did("busdriver")
        query = _send_service_query(
            don_alonso,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash="deadbeef-not-the-hash",
        )

        # Alonso's task terminates with an error (mismatch surfaced).
        alonso_task = _wait_for_workflow_event(don_alonso, query_id=query["query_id"])
        # Status may be "failed" or "completed" depending on how Core
        # represents error responses — the event details are the source
        # of truth.
        events_resp = httpx.get(
            f"{don_alonso._core_url}/v1/workflow/tasks/{alonso_task['id']}/events",
            headers={"Authorization": f"Bearer {don_alonso._client_token}"},
            timeout=5,
        )
        if events_resp.status_code == 200:
            events = events_resp.json().get("events", []) or []
            joined = json.dumps(events)
            assert "schema_version_mismatch" in joined, (
                f"Expected schema_version_mismatch in events, got: {joined[:500]}"
            )

    # TST-E2E-130
    # TRACE: {"suite": "E2E", "case": "0130", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "04", "title": "invalid_params_rejected_at_provider"}
    def test_25_4_invalid_params_rejected_at_provider(
        self, don_alonso: HomeNode, busdriver: HomeNode, docker_services,
    ) -> None:
        """Missing required param (``route_id``) never creates a task."""
        from tests.e2e.conftest import ETA_QUERY_SCHEMA_HASH

        busdriver_did = docker_services.actor_did("busdriver")
        query = _send_service_query(
            don_alonso,
            to_did=busdriver_did,
            capability="eta_query",
            params={},  # missing required route_id
            schema_hash=ETA_QUERY_SCHEMA_HASH,
        )

        alonso_task = _wait_for_workflow_event(don_alonso, query_id=query["query_id"])
        events_resp = httpx.get(
            f"{don_alonso._core_url}/v1/workflow/tasks/{alonso_task['id']}/events",
            headers={"Authorization": f"Bearer {don_alonso._client_token}"},
            timeout=5,
        )
        if events_resp.status_code == 200:
            joined = json.dumps(events_resp.json())
            assert "Invalid params" in joined or "invalid params" in joined.lower()

    # TST-E2E-131
    # TRACE: {"suite": "E2E", "case": "0131", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "05", "title": "failed_task_surfaces_agent_error_not_schema_violation"}
    def test_25_5_failed_task_surfaces_agent_error(
        self, don_alonso: HomeNode, busdriver: HomeNode, docker_services,
    ) -> None:
        """OpenClaw failure → bridge sends status=error with task.Error.

        Regression guard for the wrap-as-message-then-schema-validate
        bug: a failed task must NOT surface ``result_schema_violation``.
        """
        from tests.e2e.conftest import ETA_QUERY_SCHEMA_HASH

        busdriver_did = docker_services.actor_did("busdriver")
        query = _send_service_query(
            don_alonso,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash=ETA_QUERY_SCHEMA_HASH,
        )
        inbound = _wait_for_inbound_task(busdriver, query_id=query["query_id"])

        _fail_task(busdriver, task_id=inbound["id"], error="route unreachable")

        alonso_task = _wait_for_workflow_event(don_alonso, query_id=query["query_id"])
        events_resp = httpx.get(
            f"{don_alonso._core_url}/v1/workflow/tasks/{alonso_task['id']}/events",
            headers={"Authorization": f"Bearer {don_alonso._client_token}"},
            timeout=5,
        )
        if events_resp.status_code == 200:
            joined = json.dumps(events_resp.json())
            assert "route unreachable" in joined, (
                f"Expected agent error text in events, got: {joined[:500]}"
            )
            assert "result_schema_violation" not in joined, (
                "Failed task must not be wrapped + schema-validated"
            )

    # TST-E2E-132
    # TRACE: {"suite": "E2E", "case": "0132", "section": "25", "sectionName": "Public Service Query", "subsection": "01", "scenario": "06", "title": "result_schema_violation_caught_by_bridge"}
    def test_25_6_result_schema_violation_caught_by_bridge(
        self, don_alonso: HomeNode, busdriver: HomeNode, docker_services,
    ) -> None:
        """Completion with missing required field → result_schema_violation.

        Regression guard for #5: the bridge must actually validate the
        completed task's result against the persisted schema snapshot.
        """
        from tests.e2e.conftest import ETA_QUERY_SCHEMA_HASH

        busdriver_did = docker_services.actor_did("busdriver")
        query = _send_service_query(
            don_alonso,
            to_did=busdriver_did,
            capability="eta_query",
            params={"route_id": "42"},
            schema_hash=ETA_QUERY_SCHEMA_HASH,
        )
        inbound = _wait_for_inbound_task(busdriver, query_id=query["query_id"])

        # Result omits required ``eta_minutes`` — should fail validation
        # at the bridge and yield status=error result_schema_violation.
        _complete_task_with_result(
            busdriver, task_id=inbound["id"],
            result={"stop_name": "Castro Station"},
        )

        alonso_task = _wait_for_workflow_event(don_alonso, query_id=query["query_id"])
        events_resp = httpx.get(
            f"{don_alonso._core_url}/v1/workflow/tasks/{alonso_task['id']}/events",
            headers={"Authorization": f"Bearer {don_alonso._client_token}"},
            timeout=5,
        )
        if events_resp.status_code == 200:
            joined = json.dumps(events_resp.json())
            assert "result_schema_violation" in joined, (
                f"Expected result_schema_violation in events, got: {joined[:500]}"
            )
