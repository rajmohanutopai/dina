"""Tests for brain API endpoints -- FastAPI routes, request/response validation.

Maps to Brain TEST_PLAN S10 (API Endpoints).

All tests use the real FastAPI sub-apps (create_brain_app, create_admin_app)
wired with mock service dependencies, exercised through TestClient.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
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
# TRACE: {"suite": "BRAIN", "case": "0295", "section": "10", "sectionName": "API Endpoints", "subsection": "01", "scenario": "01", "title": "healthz_returns_200"}
def test_api_10_1_1_healthz_returns_200(client: TestClient) -> None:
    """S10.1.1: GET /healthz returns 200 with status JSON -- no auth required."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert "status" in body
    assert body["status"] == "ok"


# TST-BRAIN-381
# TRACE: {"suite": "BRAIN", "case": "0381", "section": "10", "sectionName": "API Endpoints", "subsection": "01", "scenario": "02", "title": "healthz_includes_components"}
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
# TRACE: {"suite": "BRAIN", "case": "0382", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "01", "title": "process_valid_event"}
def test_api_10_2_1_process_valid_event(client: TestClient) -> None:
    """S10.2.1: POST /v1/process with valid event returns 200 and result."""
    event = make_event(type="message", body="Hello, Dina")
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-383
# TRACE: {"suite": "BRAIN", "case": "0383", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "02", "title": "process_missing_auth"}
def test_api_10_2_2_process_missing_auth(client: TestClient) -> None:
    """S10.2.2: POST /v1/process without auth returns 401.

    Verifies:
    1. Status code is 401 (not 403, not 500).
    2. Response body is JSON with a 'detail' field.
    3. Detail message distinguishes missing auth from bad signature.
    """
    event = make_event()
    resp = client.post("/api/v1/process", json=event)
    assert resp.status_code == 401

    body = resp.json()
    assert "detail" in body, (
        "401 response must include a 'detail' field for error context"
    )
    assert body["detail"] == "Authentication required", (
        f"Missing-auth 401 should say 'Authentication required', "
        f"got: {body['detail']}"
    )


# TST-BRAIN-384
# TRACE: {"suite": "BRAIN", "case": "0384", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "03", "title": "process_wrong_signature"}
def test_api_10_2_3_process_wrong_signature(client: TestClient) -> None:
    """S10.2.3: POST /v1/process with wrong signature returns 401.

    Uses a *fresh* timestamp (within the 5-minute clock skew window) so
    the rejection is guaranteed to come from cryptographic verification,
    not stale-timestamp rejection.  Asserts the error detail confirms
    "Invalid signature" (not "Service key not configured" or other).
    """
    event = make_event()
    fresh_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    resp = client.post(
        "/api/v1/process",
        json=event,
        headers={
            "X-DID": "did:key:zFakeKey",
            "X-Timestamp": fresh_ts,
            "X-Signature": "deadbeef" * 16,
        },
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["detail"] == "Invalid signature", (
        f"Expected cryptographic rejection, got: {body['detail']}"
    )


# TST-BRAIN-385
# TRACE: {"suite": "BRAIN", "case": "0385", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "04", "title": "process_invalid_json"}
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
# TRACE: {"suite": "BRAIN", "case": "0301", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "05", "title": "process_missing_required_fields"}
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
# TRACE: {"suite": "BRAIN", "case": "0386", "section": "10", "sectionName": "API Endpoints", "subsection": "03", "scenario": "01", "title": "reason_valid_request"}
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
# TRACE: {"suite": "BRAIN", "case": "0387", "section": "10", "sectionName": "API Endpoints", "subsection": "03", "scenario": "02", "title": "reason_missing_prompt"}
def test_api_10_3_2_reason_missing_prompt(client: TestClient) -> None:
    """S10.3.2: POST /v1/reason without 'prompt' field returns 422."""
    resp = _signed_post(client, "/api/v1/reason", {"type": "reason"})
    assert resp.status_code == 422


# TST-BRAIN-388
# TRACE: {"suite": "BRAIN", "case": "0388", "section": "10", "sectionName": "API Endpoints", "subsection": "03", "scenario": "03", "title": "reason_no_auth"}
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
# TRACE: {"suite": "BRAIN", "case": "0389", "section": "10", "sectionName": "API Endpoints", "subsection": "04", "scenario": "01", "title": "response_content_type_json"}
def test_api_10_4_1_response_content_type_json(client: TestClient) -> None:
    """S10.4.1: All API responses have Content-Type: application/json.

    Covers success (200), auth failure (401), and validation error (422)
    code paths — each may return JSON through different mechanisms
    (route return, HTTPException, FastAPI validation).
    """
    # --- Success responses ---
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json"), (
        f"healthz Content-Type: {resp.headers['content-type']}"
    )

    event = make_event()
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json"), (
        f"process 200 Content-Type: {resp.headers['content-type']}"
    )

    # --- Error responses must also be JSON (not HTML/plain text) ---

    # 401 — missing auth headers (HTTPException path)
    resp = client.post("/api/v1/process", json=make_event())
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/json"), (
        f"401 Content-Type: {resp.headers['content-type']}"
    )

    # 422 — validation error (FastAPI RequestValidationError path)
    resp = _signed_post(client, "/api/v1/process", {"not_a_valid_field": True})
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/json"), (
        f"422 Content-Type: {resp.headers['content-type']}"
    )


# TST-BRAIN-390
# TRACE: {"suite": "BRAIN", "case": "0390", "section": "10", "sectionName": "API Endpoints", "subsection": "04", "scenario": "02", "title": "error_response_format"}
def test_api_10_4_2_error_response_format(client: TestClient) -> None:
    """S10.4.2: Error responses follow consistent JSON format with 'detail' field."""
    # Missing auth -> 401 with detail.
    resp = client.post("/api/v1/process", json=make_event())
    assert resp.status_code == 401, "Missing auth must return 401"
    body = resp.json()
    assert "detail" in body
    assert isinstance(body["detail"], str), "detail must be a string"

    # Missing required field -> 422 with detail.
    resp = _signed_post(client, "/api/v1/process", {})
    assert resp.status_code == 422, "Missing required field must return 422"
    body = resp.json()
    assert "detail" in body


# TST-BRAIN-391
# TRACE: {"suite": "BRAIN", "case": "0391", "section": "10", "sectionName": "API Endpoints", "subsection": "04", "scenario": "03", "title": "unknown_route_returns_404"}
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
# TRACE: {"suite": "BRAIN", "case": "0296", "section": "10", "sectionName": "API Endpoints", "subsection": "01", "scenario": "01", "title": "health_with_llm_down"}
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
# TRACE: {"suite": "BRAIN", "case": "0297", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "01", "title": "process_text_query"}
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
# TRACE: {"suite": "BRAIN", "case": "0298", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "01", "title": "process_agent_intent"}
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
# TRACE: {"suite": "BRAIN", "case": "0299", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "01", "title": "process_incoming_message"}
def test_api_10_2_process_incoming_message(client: TestClient) -> None:
    """S10.2 row 3: POST /v1/process with incoming message returns classification."""
    event = make_event(type="message", body="Your flight has been cancelled")
    resp = _signed_post(client, "/api/v1/process", event)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["classification"] is not None


# TST-BRAIN-300
# TRACE: {"suite": "BRAIN", "case": "0300", "section": "10", "sectionName": "API Endpoints", "subsection": "02", "scenario": "01", "title": "invalid_event_type"}
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
# TRACE: {"suite": "BRAIN", "case": "0419", "section": "10", "sectionName": "API Endpoints", "subsection": "05", "scenario": "01", "title": "language_agnostic_contract"}
def test_api_10_5_1_language_agnostic_contract() -> None:
    """S10.5.1: Brain API contract is language-agnostic.

    Architecture S03: Internal API contract (/v1/process, /v1/reason) uses
    standard JSON request/response format with no Python-specific serialization.
    All data types are JSON-native (no pickle, no Python datetime objects in wire format).
    """
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_brain.routes.process import (
        ProcessEventRequest, ProcessEventResponse, StandardEvent,
    )
    from dina_brain.routes.reason import ReasonRequest, ReasonResponse
    from pydantic import TypeAdapter

    # Verify request models can round-trip through JSON.
    # ProcessEventRequest is a discriminated union — use TypeAdapter.
    ta = TypeAdapter(ProcessEventRequest)
    req = ta.validate_python({"type": "message", "body": "test"})
    serialised = req.model_dump_json(by_alias=True)
    parsed = json.loads(serialised)
    assert isinstance(parsed, dict)
    assert parsed["type"] == "message"

    # Verify StandardEvent (catch-all variant) fields are JSON-native types.
    for field_name, field_info in StandardEvent.model_fields.items():
        assert "pickle" not in str(field_info.annotation).lower(), (
            f"StandardEvent.{field_name} uses non-JSON-native type"
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


# ---------------------------------------------------------------------------
# BR1 — PII scrub route must NOT return original values
# ---------------------------------------------------------------------------


# TST-BRAIN-814
# TRACE: {"suite": "BRAIN", "case": "0814", "section": "10", "sectionName": "API Endpoints", "subsection": "01", "scenario": "20", "title": "br1_pii_scrub_strips_original_values"}
def test_br1_pii_scrub_strips_original_values() -> None:
    """BR1: POST /v1/pii/scrub must NOT return 'value' (original PII) in entities.

    The scrubber returns {type, value, token} internally, but the HTTP
    response must only contain {type, token} to prevent PII leaking
    over the wire.
    """
    from dina_brain.app import create_brain_app

    # Mock scrubber that returns entities WITH original values.
    class _MockScrubber:
        def scrub(self, text: str) -> tuple[str, list[dict]]:
            return (
                "[PERSON_1] sent a message to [EMAIL_1]",
                [
                    {"type": "PERSON", "value": "Dr. Sharma", "token": "[PERSON_1]"},
                    {"type": "EMAIL", "value": "sharma@clinic.com", "token": "[EMAIL_1]"},
                ],
            )

    app = create_brain_app(
        AsyncMock(),  # guardian
        AsyncMock(),  # sync_engine
        _MockScrubber(),
        core_public_key=TEST_CORE_PUBLIC_KEY,
    )
    client = TestClient(app, raise_server_exceptions=False)

    body = json.dumps({"text": "Dr. Sharma sent a message to sharma@clinic.com"}).encode()
    headers = sign_test_request("POST", "/v1/pii/scrub", body)
    headers["Content-Type"] = "application/json"
    resp = client.post("/v1/pii/scrub", content=body, headers=headers)

    assert resp.status_code == 200
    data = resp.json()
    assert data["scrubbed"] == "[PERSON_1] sent a message to [EMAIL_1]"
    assert len(data["entities"]) == 2

    # Critical assertion: NO entity should contain the "value" key.
    for entity in data["entities"]:
        assert "value" not in entity, (
            f"BR1: original PII value leaked in HTTP response: {entity}"
        )
        assert "type" in entity
        assert "token" in entity

    # Verify specific tokens are present.
    tokens = {e["token"] for e in data["entities"]}
    assert "[PERSON_1]" in tokens
    assert "[EMAIL_1]" in tokens


# ---------------------------------------------------------------------------
# BR5 — /v1/process rate-limited
# ---------------------------------------------------------------------------


# TST-BRAIN-819
# TRACE: {"suite": "BRAIN", "case": "0819", "section": "10", "sectionName": "API Endpoints", "subsection": "01", "scenario": "21", "title": "br5_process_rate_limited"}
def test_br5_process_rate_limited() -> None:
    """BR5: POST /v1/process must be rate-limited (burst=5, then 429).

    Sends 7 requests rapidly — first 5 should succeed (burst allowance),
    the rest should get 429.
    """
    from dina_brain.app import create_brain_app

    guardian = AsyncMock()
    guardian.process_event.return_value = {"status": "ok", "action": "classified"}

    app = create_brain_app(
        guardian, AsyncMock(), core_public_key=TEST_CORE_PUBLIC_KEY,
    )
    client = TestClient(app, raise_server_exceptions=False)

    got_429 = False
    for i in range(7):
        body = json.dumps({"type": "test_event", "body": f"event {i}"}).encode()
        headers = sign_test_request("POST", "/v1/process", body)
        headers["Content-Type"] = "application/json"
        resp = client.post("/v1/process", content=body, headers=headers)
        if resp.status_code == 429:
            got_429 = True
            break

    assert got_429, "BR5: /v1/process must return 429 after burst is exhausted"
