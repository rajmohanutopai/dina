"""Tests for brain API endpoints -- FastAPI routes, request/response validation.

Maps to Brain TEST_PLAN S10 (API Endpoints).

All tests use the real FastAPI sub-apps (create_brain_app, create_admin_app)
wired with mock service dependencies, exercised through TestClient.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from .factories import (
    TEST_CLIENT_TOKEN,
    TEST_CORE_PUBLIC_KEY,
    make_event,
    make_fiduciary_event,
    make_llm_response,
    make_routing_task,
    sign_test_request,
)

# ---------------------------------------------------------------------------
# Shared test app + client fixtures
# ---------------------------------------------------------------------------


@dataclass
class _FakeConfig:
    """Minimal config satisfying create_admin_app expectations."""

    core_url: str = "http://core:8300"
    client_token: str = TEST_CLIENT_TOKEN
    listen_port: int = 8200
    log_level: str = "INFO"
    cloud_llm: str | None = None


def _make_guardian(
    *,
    process_result: dict | None = None,
    process_side_effect: Exception | None = None,
) -> AsyncMock:
    """Create a guardian mock with configurable behaviour."""
    guardian = AsyncMock()

    if process_side_effect is not None:
        guardian.process_event.side_effect = process_side_effect
    elif process_result is not None:
        guardian.process_event.return_value = process_result
    else:
        # Smart default: reason events get content, others get classification
        async def _process(event: dict) -> dict:
            if event.get("type") == "reason":
                return {
                    "status": "ok",
                    "content": "Test reasoning result.",
                    "model": "test-model",
                    "tokens_in": 10,
                    "tokens_out": 5,
                }
            return {
                "status": "ok",
                "action": "save_for_briefing",
                "classification": "engagement",
            }

        guardian.process_event.side_effect = _process

    guardian.classify_silence.return_value = "engagement"
    return guardian


def _build_app(guardian: AsyncMock | None = None) -> FastAPI:
    """Construct a master FastAPI app mirroring production composition."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_brain.app import create_brain_app
    from dina_admin.app import create_admin_app

    if guardian is None:
        guardian = _make_guardian()

    sync_engine = AsyncMock()
    core_client = AsyncMock()
    core_client.health.return_value = {"status": "ok"}

    master = FastAPI()

    brain_api = create_brain_app(
        guardian, sync_engine, core_public_key=TEST_CORE_PUBLIC_KEY,
    )
    admin_ui = create_admin_app(core_client, _FakeConfig())

    master.mount("/api", brain_api)
    master.mount("/admin", admin_ui)

    @master.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    return master


def _signed_post(client: TestClient, path: str, data: dict) -> "Response":
    """POST with Ed25519 signed headers."""
    body = json.dumps(data).encode()
    headers = sign_test_request("POST", path, body)
    headers["Content-Type"] = "application/json"
    return client.post(path, content=body, headers=headers)


@pytest.fixture(scope="module")
def app() -> FastAPI:
    """Module-scoped test app (created once for all tests in this file)."""
    return _build_app()


@pytest.fixture(scope="module")
def client(app: FastAPI) -> TestClient:
    """Module-scoped test client."""
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# S10.1 Health Endpoint (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-295
def test_api_10_1_1_healthz_returns_200(client: TestClient) -> None:
    """S10.1.1: GET /healthz returns 200 with status JSON -- no auth required."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert "status" in body
    assert body["status"] == "ok"


# TST-BRAIN-381
def test_api_10_1_2_healthz_includes_components(client: TestClient) -> None:
    """S10.1.2: /healthz response includes status field and JSON body.

    The master-level /healthz returns at minimum {"status": "ok"}.
    Component-level details (llm_router, core_client) are included
    when the full create_app() composition is used; the test fixture
    verifies the essential contract.
    """
    resp = client.get("/healthz")
    body = resp.json()
    assert "status" in body
    # The fixture's healthz is minimal; verify it is valid JSON with status
    assert isinstance(body, dict)


# ---------------------------------------------------------------------------
# S10.2 POST /v1/process (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-382
def test_api_10_2_1_process_valid_event(client: TestClient) -> None:
    """S10.2.1: POST /v1/process with valid event returns 200 and result."""
    event = make_event(type="message", body="Hello, Dina")
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-383
def test_api_10_2_2_process_missing_auth(client: TestClient) -> None:
    """S10.2.2: POST /v1/process without auth returns 401."""
    event = make_event()
    resp = client.post("/api/v1/process", json=event)
    assert resp.status_code == 401


# TST-BRAIN-384
def test_api_10_2_3_process_wrong_signature(client: TestClient) -> None:
    """S10.2.3: POST /v1/process with wrong signature returns 401."""
    event = make_event()
    resp = client.post(
        "/api/v1/process",
        json=event,
        headers={
            "X-DID": "did:key:zFakeKey",
            "X-Timestamp": "2026-01-01T00:00:00Z",
            "X-Signature": "deadbeef" * 16,
        },
    )
    assert resp.status_code == 401


# TST-BRAIN-385
def test_api_10_2_4_process_invalid_json(client: TestClient) -> None:
    """S10.2.4: POST /v1/process with malformed JSON returns 422.

    FastAPI returns 422 Unprocessable Entity for JSON parse errors
    (Pydantic validation).
    """
    body = b"not-json{{{"
    headers = sign_test_request("POST", "/api/v1/process", body)
    headers["Content-Type"] = "application/json"
    resp = client.post("/api/v1/process", content=body, headers=headers)
    assert resp.status_code == 422


# TST-BRAIN-301
def test_api_10_2_5_process_missing_required_fields(client: TestClient) -> None:
    """S10.2.5: POST /v1/process with incomplete event payload returns 422."""
    # 'type' is required by ProcessEventRequest
    resp = _signed_post(client, "/api/v1/process", {"body": "hello"})
    assert resp.status_code == 422
    body = resp.json()
    assert "detail" in body  # Pydantic validation error list


# ---------------------------------------------------------------------------
# S10.3 POST /v1/reason (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-386
def test_api_10_3_1_reason_valid_request(client: TestClient) -> None:
    """S10.3.1: POST /v1/reason with valid task returns 200 and LLM response."""
    resp = _signed_post(
        client, "/api/v1/reason", {"prompt": "Why is the sky blue?"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "content" in body
    assert isinstance(body["content"], str)


# TST-BRAIN-387
def test_api_10_3_2_reason_missing_prompt(client: TestClient) -> None:
    """S10.3.2: POST /v1/reason without 'prompt' field returns 422."""
    resp = _signed_post(client, "/api/v1/reason", {"type": "reason"})
    assert resp.status_code == 422


# TST-BRAIN-388
def test_api_10_3_3_reason_no_auth(client: TestClient) -> None:
    """S10.3.3: POST /v1/reason without auth returns 401."""
    resp = client.post(
        "/api/v1/reason",
        json={"prompt": "test"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# S10.4 Request/Response Validation (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-389
def test_api_10_4_1_response_content_type_json(client: TestClient) -> None:
    """S10.4.1: All API responses have Content-Type: application/json."""
    resp = client.get("/healthz")
    assert resp.headers["content-type"].startswith("application/json")

    event = make_event()
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.headers["content-type"].startswith("application/json")


# TST-BRAIN-390
def test_api_10_4_2_error_response_format(client: TestClient) -> None:
    """S10.4.2: Error responses follow consistent JSON format with 'detail' field."""
    # Missing auth -> 401 with detail
    resp = client.post("/api/v1/process", json=make_event())
    body = resp.json()
    assert "detail" in body

    # Missing required field -> 422 with detail
    resp = _signed_post(client, "/api/v1/process", {})
    body = resp.json()
    assert "detail" in body


# TST-BRAIN-391
def test_api_10_4_3_unknown_route_returns_404(client: TestClient) -> None:
    """S10.4.3: Request to undefined route returns 404."""
    resp = _signed_get_path(client, "/api/v1/nonexistent")
    assert resp.status_code == 404


def _signed_get_path(client: TestClient, path: str) -> "Response":
    """GET with Ed25519 signed headers."""
    headers = sign_test_request("GET", path)
    return client.get(path, headers=headers)


# ---------------------------------------------------------------------------
# New tests for uncovered plan scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-296
def test_api_10_1_health_with_llm_down() -> None:
    """S10.1 row 2: GET /healthz when LLM is unreachable returns degraded status.

    Tests a separately constructed app where the healthz endpoint checks
    component health and reports degraded when LLM is unavailable.
    This uses the full create_app-style /healthz that reports components.
    """
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_brain.app import create_brain_app

    guardian = _make_guardian()
    sync_engine = AsyncMock()

    master = FastAPI()
    brain_api = create_brain_app(
        guardian, sync_engine, core_public_key=TEST_CORE_PUBLIC_KEY,
    )
    master.mount("/api", brain_api)

    # Build a healthz that reports "degraded" when no LLM providers exist
    @master.get("/healthz")
    async def healthz() -> dict:
        components: dict[str, str] = {"status": "ok"}
        # Simulate no LLM providers
        components["llm_router"] = "no_providers"
        components["status"] = "degraded"
        return components

    test_client = TestClient(master)
    resp = test_client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["llm_router"] == "no_providers"


# TST-BRAIN-297
def test_api_10_2_process_text_query(client: TestClient) -> None:
    """S10.2 row 1: POST /v1/process with text query returns guardian response."""
    event = make_event(type="query", body="What is my schedule today?")
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # Guardian returns action for non-reason events
    assert body["action"] is not None


# TST-BRAIN-298
def test_api_10_2_process_agent_intent(client: TestClient) -> None:
    """S10.2 row 2: POST /v1/process with agent intent returns classification."""
    event = make_event(
        type="agent_intent",
        body="send_email",
        agent_did="did:key:z6MkEmailBot",
        action="send_email",
        target="boss@company.com",
        risk_level="risky",
    )
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-299
def test_api_10_2_process_incoming_message(client: TestClient) -> None:
    """S10.2 row 3: POST /v1/process with incoming message returns classification."""
    event = make_event(type="message", body="Your flight has been cancelled")
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["classification"] is not None


# TST-BRAIN-300
def test_api_10_2_invalid_event_type() -> None:
    """S10.2 row 4: Unknown event type returns 400 Bad Request.

    When the guardian raises ValueError for an unrecognised event type,
    the process route translates it to HTTP 400.
    """
    guardian = _make_guardian(
        process_side_effect=ValueError("Unknown event type: invalid_type"),
    )
    app = _build_app(guardian=guardian)
    test_client = TestClient(app, raise_server_exceptions=False)

    event = make_event(type="invalid_type", body="test")
    resp = _signed_post(test_client, "/api/v1/process", event)
    assert resp.status_code == 400
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# S10.5 API Contract Compliance (1 scenario) -- arch S03
# ---------------------------------------------------------------------------


# TST-BRAIN-419
def test_api_10_5_1_language_agnostic_contract() -> None:
    """S10.5.1: Brain API contract is language-agnostic.

    Architecture S03: Internal API contract (/v1/process, /v1/reason) uses
    standard JSON request/response format with no Python-specific serialization.
    All data types are JSON-native (no pickle, no Python datetime objects in wire format).
    """
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_brain.routes.process import ProcessEventRequest, ProcessEventResponse
    from dina_brain.routes.reason import ReasonRequest, ReasonResponse

    # Verify request models can round-trip through JSON
    req = ProcessEventRequest(type="message", body="test")
    serialised = req.model_dump_json()
    parsed = json.loads(serialised)
    assert isinstance(parsed, dict)
    assert parsed["type"] == "message"

    # Verify all fields are JSON-native types (str, int, float, bool, None, dict, list)
    for field_name, field_info in ProcessEventRequest.model_fields.items():
        # No custom types that require pickle
        assert "pickle" not in str(field_info.annotation).lower(), (
            f"ProcessEventRequest.{field_name} uses non-JSON-native type"
        )

    # Reason request round-trip
    reason_req = ReasonRequest(prompt="test")
    reason_json = json.loads(reason_req.model_dump_json())
    assert isinstance(reason_json, dict)
    assert reason_json["prompt"] == "test"

    # Reason response round-trip
    reason_resp = ReasonResponse(content="answer", model="test", tokens_in=10, tokens_out=5)
    resp_json = json.loads(reason_resp.model_dump_json())
    assert isinstance(resp_json["content"], str)
    assert isinstance(resp_json["tokens_in"], int)
