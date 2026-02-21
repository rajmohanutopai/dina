"""Tests for brain API endpoints — FastAPI routes, request/response validation.

Maps to Brain TEST_PLAN §10 (API Endpoints).
"""

from __future__ import annotations

import pytest

from .factories import (
    TEST_BRAIN_TOKEN,
    TEST_BRAIN_TOKEN_WRONG,
    make_event,
    make_fiduciary_event,
    make_llm_response,
    make_routing_task,
)


# ---------------------------------------------------------------------------
# §10.1 Health Endpoint (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-295
@pytest.mark.asyncio
async def test_api_10_1_1_healthz_returns_200() -> None:
    """§10.1.1: GET /healthz returns 200 with status JSON — no auth required."""
    pytest.skip("FastAPI app not yet implemented")
    # from httpx import AsyncClient
    # async with AsyncClient(app=app, base_url="http://test") as client:
    #     resp = await client.get("/healthz")
    #     assert resp.status_code == 200
    #     body = resp.json()
    #     assert "status" in body


# TST-BRAIN-381
@pytest.mark.asyncio
async def test_api_10_1_2_healthz_includes_components() -> None:
    """§10.1.2: /healthz response includes LLM router and core client status."""
    pytest.skip("FastAPI app not yet implemented")
    # resp = await client.get("/healthz")
    # body = resp.json()
    # assert "llm_router" in body
    # assert "core_client" in body


# ---------------------------------------------------------------------------
# §10.2 POST /v1/process (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-382
@pytest.mark.asyncio
async def test_api_10_2_1_process_valid_event() -> None:
    """§10.2.1: POST /v1/process with valid event returns 200 and result."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event(type="message", body="Hello, Dina")
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 200


# TST-BRAIN-383
@pytest.mark.asyncio
async def test_api_10_2_2_process_missing_auth() -> None:
    """§10.2.2: POST /v1/process without auth returns 401."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event()
    # resp = await client.post("/v1/process", json=event)
    # assert resp.status_code == 401


# TST-BRAIN-384
@pytest.mark.asyncio
async def test_api_10_2_3_process_wrong_token() -> None:
    """§10.2.3: POST /v1/process with wrong BRAIN_TOKEN returns 401."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event()
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN_WRONG}"},
    # )
    # assert resp.status_code == 401


# TST-BRAIN-385
@pytest.mark.asyncio
async def test_api_10_2_4_process_invalid_json() -> None:
    """§10.2.4: POST /v1/process with malformed JSON returns 400."""
    pytest.skip("FastAPI app not yet implemented")
    # resp = await client.post(
    #     "/v1/process",
    #     content="not-json{{{",
    #     headers={
    #         "Authorization": f"Bearer {TEST_BRAIN_TOKEN}",
    #         "Content-Type": "application/json",
    #     },
    # )
    # assert resp.status_code == 400


# TST-BRAIN-301
@pytest.mark.asyncio
async def test_api_10_2_5_process_missing_required_fields() -> None:
    """§10.2.5: POST /v1/process with incomplete event payload returns 422."""
    pytest.skip("FastAPI app not yet implemented")
    # event = {"type": "message"}  # missing 'body' and other required fields
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 422
    # body = resp.json()
    # assert "detail" in body  # Pydantic validation error


# ---------------------------------------------------------------------------
# §10.3 POST /v1/reason (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-386
@pytest.mark.asyncio
async def test_api_10_3_1_reason_valid_request() -> None:
    """§10.3.1: POST /v1/reason with valid task returns 200 and LLM response."""
    pytest.skip("FastAPI app not yet implemented")
    # task = make_routing_task(task_type="reason", prompt="Why is the sky blue?")
    # resp = await client.post(
    #     "/v1/reason",
    #     json=task,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 200
    # body = resp.json()
    # assert "content" in body


# TST-BRAIN-387
@pytest.mark.asyncio
async def test_api_10_3_2_reason_missing_prompt() -> None:
    """§10.3.2: POST /v1/reason without 'prompt' field returns 422."""
    pytest.skip("FastAPI app not yet implemented")
    # task = {"type": "reason"}  # missing 'prompt'
    # resp = await client.post(
    #     "/v1/reason",
    #     json=task,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 422


# TST-BRAIN-388
@pytest.mark.asyncio
async def test_api_10_3_3_reason_no_auth() -> None:
    """§10.3.3: POST /v1/reason without auth returns 401."""
    pytest.skip("FastAPI app not yet implemented")
    # task = make_routing_task(task_type="reason")
    # resp = await client.post("/v1/reason", json=task)
    # assert resp.status_code == 401


# ---------------------------------------------------------------------------
# §10.4 Request/Response Validation (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-389
@pytest.mark.asyncio
async def test_api_10_4_1_response_content_type_json() -> None:
    """§10.4.1: All API responses have Content-Type: application/json."""
    pytest.skip("FastAPI app not yet implemented")
    # resp = await client.get(
    #     "/healthz",
    # )
    # assert resp.headers["content-type"].startswith("application/json")


# TST-BRAIN-390
@pytest.mark.asyncio
async def test_api_10_4_2_error_response_format() -> None:
    """§10.4.2: Error responses follow consistent JSON format with 'detail' field."""
    pytest.skip("FastAPI app not yet implemented")
    # resp = await client.post("/v1/process")  # no body, no auth
    # body = resp.json()
    # assert "detail" in body


# TST-BRAIN-391
@pytest.mark.asyncio
async def test_api_10_4_3_unknown_route_returns_404() -> None:
    """§10.4.3: Request to undefined route returns 404."""
    pytest.skip("FastAPI app not yet implemented")
    # resp = await client.get(
    #     "/v1/nonexistent",
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 404


# ---------------------------------------------------------------------------
# New tests for uncovered plan scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-296
@pytest.mark.asyncio
async def test_api_10_1_health_with_llm_down() -> None:
    """§10.1 row 2: GET /healthz when LLM is unreachable returns degraded status."""
    pytest.skip("FastAPI app not yet implemented")
    # Mock LLM router as unreachable
    # resp = await client.get("/healthz")
    # assert resp.status_code == 200
    # body = resp.json()
    # assert body["status"] == "degraded"
    # assert body["llm"] == "unreachable"


# TST-BRAIN-297
@pytest.mark.asyncio
async def test_api_10_2_process_text_query() -> None:
    """§10.2 row 1: POST /v1/process with text query returns guardian response."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event(type="query", body="What is my schedule today?")
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 200
    # body = resp.json()
    # assert "response" in body


# TST-BRAIN-298
@pytest.mark.asyncio
async def test_api_10_2_process_agent_intent() -> None:
    """§10.2 row 2: POST /v1/process with agent intent returns approval/rejection."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event(type="agent_intent", body={"action": "send_email", "to": "alice"})
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 200
    # body = resp.json()
    # assert body["decision"] in ("approved", "rejected", "flagged")


# TST-BRAIN-299
@pytest.mark.asyncio
async def test_api_10_2_process_incoming_message() -> None:
    """§10.2 row 3: POST /v1/process with incoming message returns classification."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event(type="message", body="Your flight has been cancelled")
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 200
    # body = resp.json()
    # assert "classification" in body
    # assert "action" in body


# TST-BRAIN-300
@pytest.mark.asyncio
async def test_api_10_2_invalid_event_type() -> None:
    """§10.2 row 4: Unknown event type returns 400 Bad Request."""
    pytest.skip("FastAPI app not yet implemented")
    # event = make_event(type="unknown_type", body="test")
    # resp = await client.post(
    #     "/v1/process",
    #     json=event,
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert resp.status_code == 400


# ---------------------------------------------------------------------------
# §10.5 API Contract Compliance (1 scenario) — arch §03
# ---------------------------------------------------------------------------


# TST-BRAIN-419
def test_api_10_5_1_language_agnostic_contract() -> None:
    """§10.5.1: Brain API contract is language-agnostic.

    Architecture §03: Internal API contract (/v1/process, /v1/reason) is
    documented, versioned, language-agnostic. Brain can be rewritten in Go
    or other language without breaking the contract.
    """
    pytest.skip("API contract compliance check not yet implemented")
    # Verify that /v1/process and /v1/reason endpoints use standard
    # JSON request/response format with no Python-specific serialization.
    # All data types must be JSON-native (no pickle, no Python datetime objects).
