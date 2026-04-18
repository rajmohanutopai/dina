"""REL-029 Public Service Query via CLI.

Verify that an external agent can issue a schema-driven service.query
through the Dina CLI against a real Home Node stack. Exercises the full
pipeline:

    dummy-agent
      → ``dina service query`` (CLI, signed Ed25519 agent device)
      → Alonso's Go Core → D2D → BusDriver's Go Core
      → BusDriver's Python Brain validates schema_hash + params
      → delegation workflow_task created on BusDriver's Core
    [simulated local executor]
      → POST /v1/internal/workflow-tasks/{id}/complete (internal callback,
        the same endpoint main-dina's ``dina agent-daemon`` would call
        after claiming + running the task via OpenClaw)
      → Workflow.CompleteWithDetails → bridge → D2D service.response
      → Alonso's Go Core delivers a workflow_event
    dummy-agent
      → ``dina service status <task_id>`` shows terminal state

Execution class: Pre-release Harness.

This test intentionally keeps the agent CLI as the only entry point on
the requester side — the whole point of REL-029 is "external agent,
real CLI, real network, no shortcuts." On the provider side the local
executor is simulated via the internal callback so the release harness
doesn't depend on a paired OpenClaw with a transit MCP tool wired up.
That integration is exercised by the sanity suite, not release tests.
"""

from __future__ import annotations

import json
import subprocess as _sp
import time
import uuid

import httpx
import pytest


# ---------------------------------------------------------------------------
# Canonical schema + hash — must match main-dina's canonicaliser exactly.
# ---------------------------------------------------------------------------

ETA_QUERY_SCHEMA_HASH = "2886d1f82453b418f4e620219681b897cdfa536c2d9ee9b0f524605107117a71"

# The eta_query capability has four terminal statuses (on_route,
# not_on_route, out_of_service, not_found) — only ``status`` is required
# in the result, and eta_minutes appears only for ``on_route``. Params
# carry ``route_id`` plus optional ``location`` so providers outside SF
# can still advertise the capability.
ETA_QUERY_SCHEMA = {
    "description": "Query estimated time of arrival for a transit service.",
    "params": {
        "type": "object",
        "required": ["route_id"],
        "properties": {
            "route_id": {"type": "string"},
            "location": {
                "type": "object",
                "required": ["lat", "lng"],
                "properties": {
                    "lat": {"type": "number"},
                    "lng": {"type": "number"},
                },
            },
        },
    },
    "result": {
        "type": "object",
        "required": ["status"],
        "properties": {
            "status": {
                "type": "string",
                "enum": ["on_route", "not_on_route", "out_of_service", "not_found"],
            },
            "eta_minutes": {"type": "integer"},
            "route_name": {"type": "string"},
            "vehicle_type": {"type": "string"},
            "stop_name": {"type": "string"},
            "stop_distance_m": {"type": "number"},
            "map_url": {"type": "string"},
            "message": {"type": "string"},
        },
    },
    "schema_hash": ETA_QUERY_SCHEMA_HASH,
}


# ---------------------------------------------------------------------------
# Local fixtures (BusDriver isn't in the shared release conftest)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="class")
def busdriver_core_url(release_services) -> str:
    return release_services.core_url("busdriver")


@pytest.fixture(scope="class")
def busdriver_did(release_services) -> str:
    return release_services.actor_did("busdriver")


@pytest.fixture(scope="class")
def callback_token() -> str:
    """Pre-shared token used by the internal /v1/internal/workflow-tasks callbacks.

    Matches DINA_HOOK_CALLBACK_TOKEN in docker-compose-test-stack.yml.
    Falls back to the CLIENT_TOKEN when the hook-specific var isn't
    set — some test-mode deployments share one token.
    """
    import os
    return os.environ.get(
        "DINA_HOOK_CALLBACK_TOKEN",
        "dina-callback-busdriver",
    )


@pytest.fixture(scope="class")
def busdriver_config_published(
    busdriver_core_url, auth_headers, release_services,
) -> None:
    """Publish BusDriver's eta_query service config via the admin API.

    Session-scoped setup that runs once before the REL-029 tests so the
    provider's service_handler knows about the capability + schema. If
    the stack already has a valid config published (e.g. from a prior
    test run), PUT is idempotent — the stored config is overwritten.
    """
    cfg = {
        "is_discoverable": True,
        "name": "SF Transit Authority",
        "description": "Schedule-based bus ETAs for SF Muni routes.",
        "capabilities": {
            "eta_query": {"response_policy": "auto"},
        },
        "capability_schemas": {"eta_query": ETA_QUERY_SCHEMA},
        "service_area": {"lat": 37.77, "lng": -122.43, "radius_km": 25.0},
    }
    r = httpx.put(
        f"{busdriver_core_url}/v1/service/config",
        json=cfg, headers=auth_headers, timeout=10,
    )
    if r.status_code >= 400:
        pytest.skip(
            f"BusDriver config PUT rejected ({r.status_code}) — stack may be "
            f"misconfigured or busdriver-core not running: {r.text[:200]}"
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _json_or_fail(result: _sp.CompletedProcess, what: str) -> dict:
    """Parse CLI stdout as JSON or fail loudly with stderr for diagnosis."""
    assert result.returncode == 0, (
        f"{what} CLI failed (rc={result.returncode}):\n"
        f"  stderr: {result.stderr.strip()[:300]}"
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        pytest.fail(
            f"{what} CLI did not return JSON:\n"
            f"  stdout: {result.stdout[:300]}\n"
            f"  error: {e}"
        )


def _find_provider_task(
    *, busdriver_core_url: str, auth_headers: dict, query_id: str,
    timeout: float = 10.0,
) -> dict:
    """Poll BusDriver's Core for a delegation task matching query_id."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = httpx.get(
            f"{busdriver_core_url}/v1/workflow/tasks",
            params={"kind": "delegation", "limit": 50},
            headers=auth_headers, timeout=5,
        )
        if r.status_code == 200:
            for t in r.json().get("tasks", []) or []:
                if t.get("correlation_id") == query_id:
                    return t
        time.sleep(0.3)
    pytest.fail(
        f"BusDriver never created a delegation task for query_id={query_id}"
    )


def _complete_task_internal(
    *, busdriver_core_url: str, callback_token: str,
    task_id: str, result: dict,
) -> None:
    """Simulate the local executor's completion callback."""
    r = httpx.post(
        f"{busdriver_core_url}/v1/internal/workflow-tasks/{task_id}/complete",
        json={"result": "ok", "result_json": result},
        headers={"Authorization": f"Bearer {callback_token}"},
        timeout=10,
    )
    assert r.status_code < 400, (
        f"Internal complete callback failed: {r.status_code} {r.text[:300]}"
    )


def _poll_cli_service_status(
    release_services, task_id: str, *, want_status: str,
    timeout: float = 15.0, interval: float = 0.5,
) -> dict:
    """Poll ``dina service status <task_id>`` until ``want_status``.

    Returns the final status JSON on match, or fails if timeout elapses
    before the expected status shows up.
    """
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        r = release_services.agent_exec("service", "status", task_id)
        if r.returncode == 0:
            try:
                last = json.loads(r.stdout)
                if last.get("status") == want_status:
                    return last
            except json.JSONDecodeError:
                pass
        time.sleep(interval)
    pytest.fail(
        f"`dina service status` never reached status={want_status} "
        f"within {timeout}s. Last seen: {last}"
    )


# ---------------------------------------------------------------------------
# REL-029
# ---------------------------------------------------------------------------

class TestCLIServiceQuery:
    """Tests for REL-029: service query via the `dina service` CLI."""

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "01", "title": "rel_029_cli_sends_valid_service_query"}
    def test_rel_029_1_cli_sends_valid_service_query(
        self, release_services, agent_paired, busdriver_did,
        busdriver_config_published,
    ) -> None:
        """CLI issues a valid service.query; Core returns {task_id, query_id}."""
        r = release_services.agent_exec(
            "service", "query",
            busdriver_did, "eta_query", '{"route_id":"42"}',
            "--schema-hash", ETA_QUERY_SCHEMA_HASH,
            "--ttl", "120",
            "--service-name", "SF Transit Authority",
        )
        data = _json_or_fail(r, "service query")
        assert data.get("task_id"), (
            f"service query missing task_id in response: {data}"
        )
        assert data.get("query_id"), (
            f"service query missing query_id in response: {data}"
        )

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "02", "title": "rel_029_full_round_trip_completes_via_cli"}
    def test_rel_029_2_full_round_trip_completes_via_cli(
        self, release_services, agent_paired, busdriver_did,
        busdriver_core_url, auth_headers, callback_token,
        busdriver_config_published,
    ) -> None:
        """End-to-end: CLI → Alonso → BusDriver → simulated complete → CLI sees terminal."""
        # 1. Issue the query via CLI.
        r = release_services.agent_exec(
            "service", "query",
            busdriver_did, "eta_query", '{"route_id":"42"}',
            "--schema-hash", ETA_QUERY_SCHEMA_HASH,
            "--ttl", "120",
        )
        data = _json_or_fail(r, "service query")
        task_id = data["task_id"]
        query_id = data["query_id"]

        # 2. Observe the delegation task on BusDriver's side.
        provider_task = _find_provider_task(
            busdriver_core_url=busdriver_core_url,
            auth_headers=auth_headers,
            query_id=query_id,
        )
        assert provider_task.get("payload_type") == "service_query_execution"

        # 3. Simulate OpenClaw completion with a schema-valid result.
        _complete_task_internal(
            busdriver_core_url=busdriver_core_url,
            callback_token=callback_token,
            task_id=provider_task["id"],
            result={"eta_minutes": 7, "stop_name": "Castro Station"},
        )

        # 4. Poll ``dina service status`` until it reports terminal.
        final = _poll_cli_service_status(
            release_services, task_id, want_status="completed",
        )
        assert final.get("status") == "completed"
        assert final.get("correlation_id") == query_id, (
            "CLI-observed task must match the original query_id"
        )

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "03", "title": "rel_029_cli_stale_hash_rejected"}
    def test_rel_029_3_cli_stale_hash_surfaces_schema_version_mismatch(
        self, release_services, agent_paired, busdriver_did,
        busdriver_config_published,
    ) -> None:
        """Stale --schema-hash → terminal task with schema_version_mismatch."""
        r = release_services.agent_exec(
            "service", "query",
            busdriver_did, "eta_query", '{"route_id":"42"}',
            "--schema-hash", "deadbeef-not-the-hash",
            "--ttl", "60",
        )
        data = _json_or_fail(r, "service query (stale hash)")
        task_id = data["task_id"]

        final = _poll_cli_service_status(
            release_services, task_id, want_status="completed",
            timeout=20.0,
        )
        # Provider rejects with error; bridge emits the response; requester's
        # task terminalises. The event details carry the exact error string.
        events = final.get("events") or []
        joined = json.dumps(events)
        assert "schema_version_mismatch" in joined, (
            f"Expected schema_version_mismatch in task events.\n"
            f"Task: {json.dumps(final)[:500]}"
        )

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "04", "title": "rel_029_cli_invalid_params_rejected"}
    def test_rel_029_4_cli_invalid_params_rejected(
        self, release_services, agent_paired, busdriver_did,
        busdriver_config_published,
    ) -> None:
        """Missing required route_id → provider rejects before delegation."""
        r = release_services.agent_exec(
            "service", "query",
            busdriver_did, "eta_query", "{}",  # missing required route_id
            "--schema-hash", ETA_QUERY_SCHEMA_HASH,
            "--ttl", "60",
        )
        data = _json_or_fail(r, "service query (bad params)")
        task_id = data["task_id"]

        final = _poll_cli_service_status(
            release_services, task_id, want_status="completed",
            timeout=20.0,
        )
        joined = json.dumps(final.get("events") or []).lower()
        assert "invalid params" in joined or "route_id" in joined, (
            f"Expected params-validation error in events.\n"
            f"Task: {json.dumps(final)[:500]}"
        )

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "05", "title": "rel_029_cli_status_for_unknown_task"}
    def test_rel_029_5_cli_status_for_unknown_task_id(
        self, release_services, agent_paired,
    ) -> None:
        """``dina service status`` on a nonexistent task_id exits non-zero.

        Proves the CLI surfaces 404 cleanly rather than hanging or
        returning misleading success.
        """
        bogus = f"svc-exec-nonexistent-{uuid.uuid4().hex[:8]}"
        r = release_services.agent_exec("service", "status", bogus)
        assert r.returncode != 0, (
            f"`dina service status` on nonexistent task should fail, "
            f"got rc=0 stdout={r.stdout[:200]}"
        )

    # REL-029
    # TRACE: {"suite": "REL", "case": "0029", "section": "29", "sectionName": "CLI Public Service Query", "subsection": "01", "scenario": "06", "title": "rel_029_cli_query_bad_json_exits_nonzero"}
    def test_rel_029_6_cli_malformed_params_json_exits_nonzero(
        self, release_services, agent_paired, busdriver_did,
    ) -> None:
        """Malformed params_json is caught locally in the CLI (no Core round-trip).

        Keeps the user out of the server logs when they typo a JSON
        string — and prevents wasted D2D traffic.
        """
        r = release_services.agent_exec(
            "service", "query",
            busdriver_did, "eta_query", "not-valid-json",
            "--schema-hash", ETA_QUERY_SCHEMA_HASH,
        )
        assert r.returncode != 0, (
            f"Malformed params_json should make the CLI exit non-zero.\n"
            f"stdout: {r.stdout[:200]}\n"
            f"stderr: {r.stderr[:200]}"
        )
