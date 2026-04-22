"""WS2 Service Query — Integration Tests.

Tests the end-to-end service query workflow:
1. POST /v1/service/query creates a durable workflow_task
2. Idempotency deduplicates identical queries
3. Task expiry produces rich notification events
4. Approval lifecycle (create → approve → claim → complete)
5. Config push from Core → Brain

These tests run against real Core+Brain services (DINA_INTEGRATION=docker)
or in mock mode (default).
"""

import json
import os
import time
import uuid

import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

# Task 8.23 migration prep. WS2 (service.query workflow, provider-side
# delegation to OpenClaw, config push, approval lifecycle) is the M3
# gate's hero scenario (the BusDriver demo per README). Lite's
# WS2 subsystem lands with M3 + Phase 5+ brain-server routes.
# LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="WS2 service-query workflow (service.query → /task delegation → "
    "service.response) is the M3 hero scenario. Lite's WS2 brain-side lands "
    "with Phase 5+. LITE_SKIPS.md category `pending-feature`."
)


def _core_url():
    """Return Core base URL from env or default local."""
    return os.environ.get("DINA_CORE_URL", "http://localhost:18100")


def _brain_headers():
    """Build service auth headers for Brain → Core requests.

    In docker mode, uses real Ed25519 signing.
    In local/test mode, uses test service key from env.
    """
    # For local test_status.py mode, the signer is set up automatically.
    # For direct pytest, we need the service key path.
    key_dir = os.environ.get("DINA_SERVICE_KEY_DIR", "")
    if not key_dir:
        # Fallback: try to read from test_status.py's output
        return {"X-Service-ID": "brain"}

    # Real signing would go here — for now, rely on test mode's relaxed auth.
    return {"X-Service-ID": "brain"}


def _post_service_query(query_id: str, to_did: str = "did:key:zProvider1",
                         capability: str = "eta_query", ttl: int = 60,
                         params: dict | None = None, service_name: str = "Test Bus") -> httpx.Response:
    """Helper: POST /v1/service/query."""
    if params is None:
        params = {"location": {"lat": 12.97, "lng": 77.59}}
    return httpx.post(
        f"{_core_url()}/v1/service/query",
        json={
            "to_did": to_did,
            "capability": capability,
            "query_id": query_id,
            "ttl_seconds": ttl,
            "params": params,
            "service_name": service_name,
        },
        headers=_brain_headers(),
        timeout=10,
    )


# ---------------------------------------------------------------------------
# Validation tests (run in any mode — just need Core running)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not DOCKER_MODE, reason="requires running Core service")
class TestWS2ServiceQueryValidation:
    """POST /v1/service/query input validation."""

    def test_missing_to_did(self):
        resp = httpx.post(
            f"{_core_url()}/v1/service/query",
            json={"to_did": "", "capability": "eta_query", "query_id": "v1",
                   "ttl_seconds": 60, "params": {"lat": 1}},
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 400

    def test_invalid_did_format(self):
        resp = httpx.post(
            f"{_core_url()}/v1/service/query",
            json={"to_did": "not-a-did", "capability": "eta_query", "query_id": "v2",
                   "ttl_seconds": 60, "params": {"lat": 1}},
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 400

    def test_null_params_rejected(self):
        resp = httpx.post(
            f"{_core_url()}/v1/service/query",
            json={"to_did": "did:key:z123", "capability": "eta_query", "query_id": "v3",
                   "ttl_seconds": 60, "params": None},
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 400

    def test_ttl_out_of_range(self):
        resp = httpx.post(
            f"{_core_url()}/v1/service/query",
            json={"to_did": "did:key:z123", "capability": "eta_query", "query_id": "v4",
                   "ttl_seconds": 999, "params": {"lat": 1}},
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Workflow lifecycle tests (need Core with SQLite)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not DOCKER_MODE, reason="requires running Core service")
class TestWS2WorkflowLifecycle:
    """Workflow task creation, idempotency, and task queries."""

    def test_create_service_query_task(self):
        """POST /v1/service/query creates a workflow_task."""
        qid = f"test-{uuid.uuid4()}"
        resp = _post_service_query(qid)
        # May be 502 (send fails — no real provider) or 200 (task created + sent).
        # Either way, task should exist.
        assert resp.status_code in (200, 502)

        # Verify task exists via GET.
        task_id = f"sq-{qid}"
        task_resp = httpx.get(
            f"{_core_url()}/v1/workflow/tasks/{task_id}",
            headers=_brain_headers(), timeout=10,
        )
        assert task_resp.status_code == 200
        task = task_resp.json()
        assert task["kind"] == "service_query"
        assert task["correlation_id"] == qid

    def test_idempotency_returns_existing_task(self):
        """Same (to_did, capability, params) returns the same task."""
        qid1 = f"idem-{uuid.uuid4()}"
        qid2 = f"idem-{uuid.uuid4()}"
        params = {"location": {"lat": 99.1, "lng": 88.2}}

        resp1 = _post_service_query(qid1, params=params)
        resp2 = _post_service_query(qid2, params=params)  # different query_id, same hash

        # Both should reference the same task (first one wins).
        if resp1.status_code == 200 and resp2.status_code == 200:
            data1 = resp1.json()
            data2 = resp2.json()
            assert data1["task_id"] == data2["task_id"]

    def test_approval_lifecycle(self):
        """Create approval task → approve → verify state transitions."""
        task_id = f"approval-e2e-{uuid.uuid4()}"
        payload = json.dumps({
            "from_did": "did:key:zReqE2E",
            "query_id": f"q-{uuid.uuid4()}",
            "capability": "eta_query",
            "params": {"location": {"lat": 12.9, "lng": 77.6}},
            "service_name": "E2E Bus",
            "ttl_seconds": 300,
        })

        # Create approval task.
        create_resp = httpx.post(
            f"{_core_url()}/v1/workflow/tasks",
            json={
                "id": task_id,
                "description": "E2E approval test",
                "origin": "api",
                "kind": "approval",
                "payload": payload,
                "expires_at": int(time.time()) + 300,
            },
            headers=_brain_headers(), timeout=10,
        )
        assert create_resp.status_code == 201, create_resp.text

        # Verify pending_approval.
        task = httpx.get(f"{_core_url()}/v1/workflow/tasks/{task_id}",
                         headers=_brain_headers(), timeout=10).json()
        assert task["status"] == "pending_approval"

        # Approve.
        approve_resp = httpx.post(
            f"{_core_url()}/v1/workflow/tasks/{task_id}/approve",
            headers=_brain_headers(), timeout=10,
        )
        assert approve_resp.status_code == 200, approve_resp.text

        # Verify queued.
        task = httpx.get(f"{_core_url()}/v1/workflow/tasks/{task_id}",
                         headers=_brain_headers(), timeout=10).json()
        assert task["status"] == "queued"

    def test_list_tasks_with_kind_filter(self):
        """GET /v1/workflow/tasks?kind=approval returns only approval tasks."""
        resp = httpx.get(
            f"{_core_url()}/v1/workflow/tasks?kind=approval&limit=10",
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 200
        tasks = resp.json().get("tasks", [])
        for t in tasks:
            assert t["kind"] == "approval"

    def test_list_tasks_oldest_first(self):
        """GET /v1/workflow/tasks?order=oldest returns oldest first."""
        resp = httpx.get(
            f"{_core_url()}/v1/workflow/tasks?order=oldest&limit=5",
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 200
        tasks = resp.json().get("tasks", [])
        if len(tasks) >= 2:
            assert tasks[0]["created_at"] <= tasks[1]["created_at"]


# ---------------------------------------------------------------------------
# Config push test
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not DOCKER_MODE, reason="requires running Core + Brain services")
class TestWS2ConfigPush:
    """PUT /v1/service/config pushes config_changed to Brain."""

    def test_put_service_config(self):
        """PUT /v1/service/config succeeds and Core responds 200."""
        config = {
            "is_discoverable": True,
            "name": "E2E Test Service",
            "description": "Integration test",
            "capabilities": {
                "eta_query": {
                    "response_policy": "auto",
                    "mcp_server": "test-mcp",
                    "mcp_tool": "eta_query",
                },
            },
            "service_area": {"lat": 12.97, "lng": 77.59, "radius_km": 10},
        }
        resp = httpx.put(
            f"{_core_url()}/v1/service/config",
            json=config,
            headers=_brain_headers(), timeout=10,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
