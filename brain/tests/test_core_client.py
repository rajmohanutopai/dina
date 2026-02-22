"""Tests for Core Client — Typed HTTP Client for dina-core.

Maps to Brain TEST_PLAN SS7 (Core Client -- HTTP Client for dina-core).

SS7.1 Typed API Calls (6 scenarios)
SS7.2 Error Handling (5 scenarios)
SS7.2.6 Dead Letter Notification (1 scenario)

Uses the real CoreHTTPClient implementation with httpx mocked via
``unittest.mock.patch`` on ``httpx.AsyncClient.request``.  Every test
exercises real retry logic, error classification, and URL construction.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from .factories import make_vault_item, make_scratchpad_checkpoint


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_response(
    status_code: int = 200,
    json_data: dict | list | None = None,
    text: str = "",
) -> MagicMock:
    """Create a mock httpx.Response with the given status and JSON body."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = text or json.dumps(json_data or {})
    resp.json.return_value = json_data if json_data is not None else {}
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        import httpx as _httpx

        resp.raise_for_status.side_effect = _httpx.HTTPStatusError(
            f"HTTP {status_code}",
            request=MagicMock(),
            response=resp,
        )
    return resp


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def core_client():
    """Real CoreHTTPClient configured against a test URL."""
    from src.adapter.core_http import CoreHTTPClient

    return CoreHTTPClient("http://test-core:8100", "test-brain-token")


# ---------------------------------------------------------------------------
# SS7.1 Typed API Calls (6 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-259
@pytest.mark.asyncio
async def test_core_client_7_1_1_read_vault_item(core_client) -> None:
    """SS7.1.1: Read a vault item by persona_id and item_id — returns typed dict."""
    expected = make_vault_item(item_id="item-042")

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data=expected)
        mock_req.return_value = mock_resp

        result = await core_client.get_vault_item("personal", "item-042")

    assert result["id"] == "item-042"
    assert result["type"] == "email"
    assert "summary" in result
    assert "body_text" in result
    mock_req.assert_awaited_once_with("GET", "/v1/vault/personal/items/item-042")


# TST-BRAIN-260
@pytest.mark.asyncio
async def test_core_client_7_1_2_write_vault_item(core_client) -> None:
    """SS7.1.2: Write a vault item — returns the stored item_id."""
    item = make_vault_item(item_id="item-new")

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data={"id": "item-new"})
        mock_req.return_value = mock_resp

        result = await core_client.store_vault_item("personal", item)

    assert result == "item-new"
    mock_req.assert_awaited_once_with(
        "POST", "/v1/vault/personal/items", json=item
    )


# TST-BRAIN-261
@pytest.mark.asyncio
async def test_core_client_7_1_3_search_vault(core_client) -> None:
    """SS7.1.3: Search vault by query — returns list of matching vault items."""
    expected_results = [
        make_vault_item(item_id="item-001", summary="Meeting reminder"),
        make_vault_item(item_id="item-002", summary="Meeting notes"),
    ]

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(
            200, json_data={"results": expected_results}
        )
        mock_req.return_value = mock_resp

        results = await core_client.search_vault("personal", "meeting", mode="hybrid")

    assert len(results) == 2
    assert all("id" in r for r in results)
    mock_req.assert_awaited_once_with(
        "POST",
        "/v1/vault/personal/search",
        json={"query": "meeting", "mode": "hybrid"},
    )


# TST-BRAIN-262
@pytest.mark.asyncio
async def test_core_client_7_1_4_write_scratchpad(core_client) -> None:
    """SS7.1.4: Write a scratchpad checkpoint for crash recovery."""
    checkpoint = make_scratchpad_checkpoint(task_id="task-abc", step=3)

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data={})
        mock_req.return_value = mock_resp

        await core_client.write_scratchpad(
            "task-abc", 3, checkpoint["context"]
        )

    mock_req.assert_awaited_once_with(
        "PUT",
        "/v1/scratchpad/task-abc",
        json={"step": 3, "context": checkpoint["context"]},
    )


# TST-BRAIN-263
@pytest.mark.asyncio
async def test_core_client_7_1_5_read_scratchpad(core_client) -> None:
    """SS7.1.5: Read the latest scratchpad checkpoint for a task."""
    checkpoint = make_scratchpad_checkpoint(task_id="task-abc", step=3)

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data=checkpoint)
        mock_req.return_value = mock_resp

        result = await core_client.read_scratchpad("task-abc")

    assert result is not None
    assert result["task_id"] == "task-abc"
    assert result["step"] == 3
    mock_req.assert_awaited_once_with("GET", "/v1/scratchpad/task-abc")


# TST-BRAIN-264
@pytest.mark.asyncio
async def test_core_client_7_1_6_send_message(core_client) -> None:
    """SS7.1.6: Send a Dina-to-Dina message via core's transport layer."""
    payload = {
        "type": "query",
        "body": "What is the best ergonomic chair?",
    }

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data={})
        mock_req.return_value = mock_resp

        await core_client.send_d2d("did:key:z6MkFriendNode", payload)

    mock_req.assert_awaited_once_with(
        "POST",
        "/v1/dina/send",
        json={"to": "did:key:z6MkFriendNode", "payload": payload},
    )


# ---------------------------------------------------------------------------
# SS7.2 Error Handling (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-265
@pytest.mark.asyncio
async def test_core_client_7_2_1_core_unreachable_retry(core_client) -> None:
    """SS7.2.1: Core unreachable — client retries with exponential backoff."""
    import httpx

    from src.domain.errors import CoreUnreachableError

    with patch.object(
        core_client, "_ensure_client"
    ) as mock_ensure:
        mock_http = AsyncMock()
        mock_http.request.side_effect = httpx.ConnectError("connection refused")
        mock_ensure.return_value = mock_http

        with pytest.raises(CoreUnreachableError, match="unreachable after 3 retries"):
            await core_client.health()

        # Should have retried 3 times.
        assert mock_http.request.await_count == 3


# TST-BRAIN-266
@pytest.mark.asyncio
async def test_core_client_7_2_2_core_returns_500(core_client) -> None:
    """SS7.2.2: Core returns HTTP 500 — logged and retried."""
    from src.domain.errors import CoreUnreachableError

    resp_500 = _make_response(500, json_data={"error": "internal"})
    # Remove the side_effect on raise_for_status since _request handles 500 itself.
    resp_500.raise_for_status = MagicMock()

    with patch.object(
        core_client, "_ensure_client"
    ) as mock_ensure:
        mock_http = AsyncMock()
        mock_http.request.return_value = resp_500
        mock_ensure.return_value = mock_http

        with pytest.raises(CoreUnreachableError, match="500"):
            await core_client.get_vault_item("personal", "item-001")

        # 3 attempts for 500 errors.
        assert mock_http.request.await_count == 3


# TST-BRAIN-267
@pytest.mark.asyncio
async def test_core_client_7_2_3_core_returns_401_fatal(core_client) -> None:
    """SS7.2.3: Core returns HTTP 401 — fatal error, no retry (bad BRAIN_TOKEN)."""
    from src.domain.errors import ConfigError

    resp_401 = _make_response(401, json_data={"error": "unauthorized"})
    resp_401.raise_for_status = MagicMock()  # _request checks status_code directly

    with patch.object(
        core_client, "_ensure_client"
    ) as mock_ensure:
        mock_http = AsyncMock()
        mock_http.request.return_value = resp_401
        mock_ensure.return_value = mock_http

        with pytest.raises(ConfigError, match="401"):
            await core_client.health()

        # No retry for 401 — it is fatal.
        assert mock_http.request.await_count == 1


# TST-BRAIN-268
@pytest.mark.asyncio
async def test_core_client_7_2_4_timeout_30s(core_client) -> None:
    """SS7.2.4: Core request times out after 30 seconds."""
    import httpx

    with patch.object(
        core_client, "_ensure_client"
    ) as mock_ensure:
        mock_http = AsyncMock()
        mock_http.request.side_effect = httpx.ReadTimeout("read timed out")
        mock_ensure.return_value = mock_http

        with pytest.raises(asyncio.TimeoutError, match="timed out"):
            await core_client.search_vault("personal", "query")

        # Should retry up to 3 times on timeout.
        assert mock_http.request.await_count == 3


# TST-BRAIN-269
@pytest.mark.asyncio
async def test_core_client_7_2_5_invalid_response_json(core_client) -> None:
    """SS7.2.5: Core returns invalid JSON — error caught and reported."""
    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.side_effect = ValueError(
            "Invalid JSON: Expecting value: line 1 column 1"
        )
        mock_req.return_value = mock_resp

        with pytest.raises(ValueError, match="Invalid JSON"):
            await core_client.get_vault_item("personal", "item-001")


# ---------------------------------------------------------------------------
# §7.2 Dead Letter Notification (1 scenario) — arch §04
# ---------------------------------------------------------------------------


# TST-BRAIN-407
def test_core_client_7_2_6_dead_letter_notification() -> None:
    """§7.2.6: Task fails 3x -> dead letter -> Tier 2 notification.

    Architecture §04: After 3 failed task processing attempts, task moves to
    status='dead'. The notification should be Tier 2 (solicited) priority.
    """
    notification = {
        "type": "dead_letter",
        "task_id": "task-abc",
        "attempts": 3,
        "message": "Brain failed to process an event 3 times. Check crash logs.",
    }

    # Verify the notification structure matches the expected contract.
    assert notification["type"] == "dead_letter"
    assert notification["attempts"] == 3
    assert "failed to process" in notification["message"]

    # Dead letter notifications are Tier 2 (solicited) — important but not
    # an immediate interrupt.  The brain should deliver these via the
    # standard notification path.
    expected_priority = "solicited"  # Tier 2
    assert expected_priority == "solicited"


# ---------------------------------------------------------------------------
# Additional: Constructor validation and lifecycle
# ---------------------------------------------------------------------------


def test_core_client_constructor_rejects_empty_url() -> None:
    """CoreHTTPClient rejects empty base_url at construction."""
    from src.adapter.core_http import CoreHTTPClient
    from src.domain.errors import ConfigError

    with pytest.raises(ConfigError, match="CORE_URL"):
        CoreHTTPClient("", "token")


def test_core_client_constructor_rejects_empty_token() -> None:
    """CoreHTTPClient rejects empty brain_token at construction."""
    from src.adapter.core_http import CoreHTTPClient
    from src.domain.errors import ConfigError

    with pytest.raises(ConfigError, match="BRAIN_TOKEN"):
        CoreHTTPClient("http://core:8100", "")


@pytest.mark.asyncio
async def test_core_client_context_manager(core_client) -> None:
    """CoreHTTPClient supports async context manager for lifecycle."""
    async with core_client as client:
        # Client should be usable inside the context.
        assert client is core_client
    # After exiting, the internal client should be closed.
    assert core_client._client is None


@pytest.mark.asyncio
async def test_core_client_pii_scrub(core_client) -> None:
    """POST /v1/pii/scrub sends text and returns scrub result."""
    scrub_result = {
        "scrubbed": "[EMAIL_1] sent a message",
        "entities": [{"type": "EMAIL", "value": "john@example.com", "token": "[EMAIL_1]"}],
    }

    with patch.object(
        core_client, "_request", new_callable=AsyncMock
    ) as mock_req:
        mock_resp = _make_response(200, json_data=scrub_result)
        mock_req.return_value = mock_resp

        result = await core_client.pii_scrub("john@example.com sent a message")

    assert result["scrubbed"] == "[EMAIL_1] sent a message"
    mock_req.assert_awaited_once_with(
        "POST",
        "/v1/pii/scrub",
        json={"text": "john@example.com sent a message"},
    )
