"""Tests for Core Client — Typed HTTP Client for dina-core.

Maps to Brain TEST_PLAN SS7 (Core Client -- HTTP Client for dina-core).

SS7.1 Typed API Calls (6 scenarios)
SS7.2 Error Handling (5 scenarios)
"""

from __future__ import annotations

import pytest

from .factories import make_vault_item, make_scratchpad_checkpoint


# ---------------------------------------------------------------------------
# SS7.1 Typed API Calls (6 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-259
@pytest.mark.asyncio
async def test_core_client_7_1_1_read_vault_item(mock_core_client) -> None:
    """SS7.1.1: Read a vault item by persona_id and item_id — returns typed dict."""
    expected = make_vault_item(item_id="item-042")

    pytest.skip("CoreClient not yet implemented")

    # Expected: GET /v1/vault/{persona_id}/items/{item_id}
    # Returns a typed vault item dict with all required fields.
    # mock_core_client.get_vault_item.return_value = expected
    # result = await mock_core_client.get_vault_item("personal", "item-042")
    # assert result["id"] == "item-042"
    # assert result["type"] == "email"
    # assert "summary" in result
    # assert "body_text" in result
    # mock_core_client.get_vault_item.assert_awaited_once_with("personal", "item-042")


# TST-BRAIN-260
@pytest.mark.asyncio
async def test_core_client_7_1_2_write_vault_item(mock_core_client) -> None:
    """SS7.1.2: Write a vault item — returns the stored item_id."""
    item = make_vault_item(item_id="item-new")

    pytest.skip("CoreClient not yet implemented")

    # Expected: POST /v1/vault/{persona_id}/items
    # Body is the vault item dict, response is the assigned item_id.
    # mock_core_client.store_vault_item.return_value = "item-new"
    # result = await mock_core_client.store_vault_item("personal", item)
    # assert result == "item-new"
    # mock_core_client.store_vault_item.assert_awaited_once_with("personal", item)


# TST-BRAIN-261
@pytest.mark.asyncio
async def test_core_client_7_1_3_search_vault(mock_core_client) -> None:
    """SS7.1.3: Search vault by query — returns list of matching vault items."""
    expected_results = [
        make_vault_item(item_id="item-001", summary="Meeting reminder"),
        make_vault_item(item_id="item-002", summary="Meeting notes"),
    ]

    pytest.skip("CoreClient not yet implemented")

    # Expected: POST /v1/vault/{persona_id}/search
    # Body includes query string and search mode (hybrid by default).
    # Returns a list of matching vault items ranked by relevance.
    # mock_core_client.search_vault.return_value = expected_results
    # results = await mock_core_client.search_vault("personal", "meeting", mode="hybrid")
    # assert len(results) == 2
    # assert all("id" in r for r in results)
    # mock_core_client.search_vault.assert_awaited_once_with(
    #     "personal", "meeting", mode="hybrid"
    # )


# TST-BRAIN-262
@pytest.mark.asyncio
async def test_core_client_7_1_4_write_scratchpad(mock_core_client) -> None:
    """SS7.1.4: Write a scratchpad checkpoint for crash recovery."""
    checkpoint = make_scratchpad_checkpoint(task_id="task-abc", step=3)

    pytest.skip("CoreClient not yet implemented")

    # Expected: PUT /v1/scratchpad/{task_id}
    # Stores the current step and accumulated context so the brain can
    # resume after a crash without re-processing from scratch.
    # await mock_core_client.write_scratchpad(
    #     "task-abc", 3, checkpoint["context"]
    # )
    # mock_core_client.write_scratchpad.assert_awaited_once_with(
    #     "task-abc", 3, checkpoint["context"]
    # )


# TST-BRAIN-263
@pytest.mark.asyncio
async def test_core_client_7_1_5_read_scratchpad(mock_core_client) -> None:
    """SS7.1.5: Read the latest scratchpad checkpoint for a task."""
    checkpoint = make_scratchpad_checkpoint(task_id="task-abc", step=3)

    pytest.skip("CoreClient not yet implemented")

    # Expected: GET /v1/scratchpad/{task_id}
    # Returns the latest checkpoint or None if no checkpoint exists.
    # mock_core_client.read_scratchpad.return_value = checkpoint
    # result = await mock_core_client.read_scratchpad("task-abc")
    # assert result["task_id"] == "task-abc"
    # assert result["step"] == 3
    # mock_core_client.read_scratchpad.assert_awaited_once_with("task-abc")


# TST-BRAIN-264
@pytest.mark.asyncio
async def test_core_client_7_1_6_send_message(mock_core_client) -> None:
    """SS7.1.6: Send a Dina-to-Dina message via core's transport layer."""
    pytest.skip("CoreClient message sending not yet implemented")

    # Expected: POST /v1/messages/send
    # Core handles the P2P transport — brain only provides the message payload
    # and the recipient DID. Core signs, encrypts, and delivers.
    # message = {
    #     "to": "did:key:z6MkFriendNode",
    #     "type": "query",
    #     "body": "What is the best ergonomic chair?",
    # }
    # await mock_core_client.send_message(message)
    # mock_core_client.send_message.assert_awaited_once()


# ---------------------------------------------------------------------------
# SS7.2 Error Handling (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-265
@pytest.mark.asyncio
async def test_core_client_7_2_1_core_unreachable_retry(mock_core_client) -> None:
    """SS7.2.1: Core unreachable — client retries with exponential backoff."""
    pytest.skip("CoreClient retry logic not yet implemented")

    # Expected: On ConnectionError, the client retries up to 3 times with
    # exponential backoff (e.g., 1s, 2s, 4s). After all retries fail,
    # raises a CoreUnreachableError.
    # import asyncio
    # mock_core_client.health.side_effect = ConnectionError("connection refused")
    # with pytest.raises(ConnectionError):
    #     await mock_core_client.health()
    # assert mock_core_client.health.await_count == 3  # 3 retries


# TST-BRAIN-266
@pytest.mark.asyncio
async def test_core_client_7_2_2_core_returns_500(mock_core_client) -> None:
    """SS7.2.2: Core returns HTTP 500 — logged and retried."""
    pytest.skip("CoreClient 500 handling not yet implemented")

    # Expected: On HTTP 500, the error is logged with the request details
    # and the call is retried. After max retries, raises a CoreServerError.
    # mock_core_client.get_vault_item.side_effect = Exception("HTTP 500: Internal Server Error")
    # with pytest.raises(Exception, match="500"):
    #     await mock_core_client.get_vault_item("personal", "item-001")


# TST-BRAIN-267
@pytest.mark.asyncio
async def test_core_client_7_2_3_core_returns_401_fatal(mock_core_client) -> None:
    """SS7.2.3: Core returns HTTP 401 — fatal error, no retry (bad BRAIN_TOKEN)."""
    pytest.skip("CoreClient 401 handling not yet implemented")

    # Expected: HTTP 401 indicates a bad BRAIN_TOKEN. This is a fatal
    # configuration error — no retry. Raises immediately with a clear
    # message about token misconfiguration.
    # mock_core_client.health.side_effect = PermissionError("HTTP 401: Unauthorized")
    # with pytest.raises(PermissionError, match="401"):
    #     await mock_core_client.health()
    # # No retry — 401 is fatal
    # assert mock_core_client.health.await_count == 1


# TST-BRAIN-268
@pytest.mark.asyncio
async def test_core_client_7_2_4_timeout_30s(mock_core_client) -> None:
    """SS7.2.4: Core request times out after 30 seconds."""
    pytest.skip("CoreClient timeout not yet implemented")

    # Expected: Each HTTP request to core has a 30-second timeout.
    # On timeout, raises asyncio.TimeoutError.
    # import asyncio
    # mock_core_client.search_vault.side_effect = asyncio.TimeoutError()
    # with pytest.raises(asyncio.TimeoutError):
    #     await mock_core_client.search_vault("personal", "query")


# TST-BRAIN-269
@pytest.mark.asyncio
async def test_core_client_7_2_5_invalid_response_json(mock_core_client) -> None:
    """SS7.2.5: Core returns invalid JSON — error caught and reported."""
    pytest.skip("CoreClient JSON validation not yet implemented")

    # Expected: If core returns malformed JSON (e.g., truncated response),
    # the client catches the JSON decode error and raises a structured
    # CoreResponseError with the raw response body for debugging.
    # mock_core_client.get_vault_item.side_effect = ValueError(
    #     "Invalid JSON: Expecting value: line 1 column 1"
    # )
    # with pytest.raises(ValueError, match="Invalid JSON"):
    #     await mock_core_client.get_vault_item("personal", "item-001")


# ---------------------------------------------------------------------------
# §7.2 Dead Letter Notification (1 scenario) — arch §04
# ---------------------------------------------------------------------------


# TST-BRAIN-407
def test_core_client_7_2_6_dead_letter_notification(mock_core_client) -> None:
    """§7.2.6: Task fails 3x → dead letter → Tier 2 notification.

    Architecture §04: After 3 failed task processing attempts, task moves to
    status='dead'. Brain receives Tier 2 notification: "Brain failed to process
    an event 3 times. Check crash logs."
    """
    pytest.skip("Dead letter notification not yet implemented")
    # notification = {
    #     "type": "dead_letter",
    #     "task_id": "task-abc",
    #     "attempts": 3,
    #     "message": "Brain failed to process an event 3 times. Check crash logs.",
    # }
    # result = await brain.handle_dead_letter(notification)
    # assert result["notification_priority"] == "solicited"  # Tier 2
