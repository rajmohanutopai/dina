"""Tests for Guardian's service.query response routing + retry.

Exercises ``_handle_service_query_result`` (the workflow_event handler
that formats a provider response and delivers it) and
``_retry_service_query_after_schema_mismatch``. Both were introduced /
rewritten in the recent rounds and aren't covered elsewhere.

Invariants under test:

- Responses route to ``origin_channel`` when present (``telegram:<id>``
  → that specific chat; ``bluesky`` → owner DM). No origin_channel =>
  legacy broadcast fallback.
- Bluesky-origin requests do not spray to Telegram; Telegram-origin
  requests do not spray to Bluesky.
- ``schema_version_mismatch`` triggers a single targeted retry through
  the orchestrator, guarded by a KV marker for at-most-once.
- Retries without a ``to_did`` in the original task payload do not fire
  (no silent rerouting).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.service.guardian import GuardianLoop


def _guardian():
    """Build a minimally-wired GuardianLoop sufficient for routing tests.

    We bypass the full dependency graph and attach the attributes the
    service-query handler actually reads: ``_core``,
    ``_service_query_orchestrator``, ``_telegram``, ``_bluesky``.
    """
    g = GuardianLoop.__new__(GuardianLoop)
    g._core = AsyncMock()
    g._core.get_kv = AsyncMock(return_value=None)
    g._core.set_kv = AsyncMock()
    g._core.get_workflow_task = AsyncMock(return_value=None)
    g._core.ack_workflow_event = AsyncMock()

    orch = MagicMock()
    orch.retry_with_fresh_schema = AsyncMock(return_value=True)
    orch.handle_user_query = AsyncMock()
    g._service_query_orchestrator = orch
    return g


def _attach_telegram(g, paired=(111, 222)):
    tg = MagicMock()
    tg._bot = MagicMock()
    tg._bot.send_message = AsyncMock()
    tg.load_paired_users = AsyncMock()
    tg._paired_users = set(paired)
    g._telegram = tg
    return tg


def _attach_bluesky(g):
    bsky = MagicMock()
    bsky.send_owner_dm = AsyncMock()
    g._bluesky = bsky
    return bsky


def _ok_details(origin_channel="", query_id="q-1"):
    return {
        "response_status": "success",
        "capability": "eta_query",
        "service_name": "SF Transit",
        "query_id": query_id,
        "origin_channel": origin_channel,
        "result": {"eta_minutes": 7, "stop_name": "Castro Station"},
    }


# ---------------------------------------------------------------------------
# origin_channel routing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_routes_to_specific_telegram_chat_from_origin_channel():
    g = _guardian()
    tg = _attach_telegram(g)

    await g._handle_service_query_result(_ok_details(origin_channel="telegram:555"))

    # Sent to the specific chat_id, not every paired user.
    tg._bot.send_message.assert_awaited_once()
    chat_id, _message = tg._bot.send_message.await_args.args
    assert chat_id == 555
    # load_paired_users shouldn't be called on the targeted path.
    tg.load_paired_users.assert_not_called()


@pytest.mark.asyncio
async def test_broadcasts_when_origin_channel_absent():
    g = _guardian()
    tg = _attach_telegram(g, paired={111, 222})

    await g._handle_service_query_result(_ok_details(origin_channel=""))

    # Fell back to the legacy fan-out path — one send per paired user.
    assert tg._bot.send_message.await_count == 2
    sent_chat_ids = {c.args[0] for c in tg._bot.send_message.await_args_list}
    assert sent_chat_ids == {111, 222}


@pytest.mark.asyncio
async def test_bluesky_origin_does_not_spray_telegram():
    g = _guardian()
    tg = _attach_telegram(g)
    bsky = _attach_bluesky(g)

    await g._handle_service_query_result(_ok_details(origin_channel="bluesky:dm"))

    bsky.send_owner_dm.assert_awaited_once()
    tg._bot.send_message.assert_not_called()


@pytest.mark.asyncio
async def test_telegram_origin_does_not_spray_bluesky():
    g = _guardian()
    tg = _attach_telegram(g)
    bsky = _attach_bluesky(g)

    await g._handle_service_query_result(_ok_details(origin_channel="telegram:42"))

    tg._bot.send_message.assert_awaited_once()
    bsky.send_owner_dm.assert_not_called()


@pytest.mark.asyncio
async def test_telegram_origin_with_string_chat_id_passes_through():
    # Some adapters may store chat_id as a string (channel username).
    # The handler must accept it rather than crashing on int conversion.
    g = _guardian()
    tg = _attach_telegram(g)

    await g._handle_service_query_result(
        _ok_details(origin_channel="telegram:@somegroup"),
    )

    chat_id, _ = tg._bot.send_message.await_args.args
    assert chat_id == "@somegroup"


# ---------------------------------------------------------------------------
# schema_version_mismatch retry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_schema_mismatch_triggers_targeted_retry():
    g = _guardian()
    _attach_telegram(g)

    # Task payload contains the original to_did — retry must reuse it.
    g._core.get_workflow_task = AsyncMock(return_value={
        "payload": {
            "capability": "eta_query",
            "params": {"route_id": "42", "location": {"lat": 37.77, "lng": -122.43}},
            "to_did": "did:plc:original",
            "origin_channel": "telegram:555",
            "user_text": "bus 42",
        },
    })

    details = {
        "response_status": "error",
        "error": "schema_version_mismatch",
        "capability": "eta_query",
        "query_id": "q-stale",
        "origin_channel": "telegram:555",
    }
    await g._handle_service_query_result(details, task_id="task-abc")

    # Targeted retry was issued. handle_user_query (which re-runs
    # discovery) must NOT be called — that would allow silent rerouting.
    orch = g._service_query_orchestrator
    orch.retry_with_fresh_schema.assert_awaited_once()
    kwargs = orch.retry_with_fresh_schema.await_args.kwargs
    assert kwargs["to_did"] == "did:plc:original"
    assert kwargs["origin_channel"] == "telegram:555"
    orch.handle_user_query.assert_not_called()
    # KV marker written for at-most-once.
    g._core.set_kv.assert_awaited_once()
    marker_key = g._core.set_kv.await_args.args[0]
    assert marker_key == "service_query:schema_retry:q-stale"


@pytest.mark.asyncio
async def test_schema_mismatch_skips_retry_when_marker_present():
    g = _guardian()
    _attach_telegram(g)
    # Marker already set → second retry must be suppressed.
    g._core.get_kv = AsyncMock(return_value="2026-04-17T05:00:00+00:00")
    g._core.get_workflow_task = AsyncMock(return_value={
        "payload": {
            "capability": "eta_query",
            "params": {"route_id": "42"},
            "to_did": "did:plc:original",
        },
    })

    details = {
        "response_status": "error",
        "error": "schema_version_mismatch",
        "capability": "eta_query",
        "query_id": "q-dup",
        "origin_channel": "telegram:555",
    }
    await g._handle_service_query_result(details, task_id="task-abc")

    orch = g._service_query_orchestrator
    orch.retry_with_fresh_schema.assert_not_called()
    # Falls through to normal error notification.
    g._telegram._bot.send_message.assert_awaited()


@pytest.mark.asyncio
async def test_schema_mismatch_without_to_did_does_not_retry():
    g = _guardian()
    _attach_telegram(g)
    # Legacy task without to_did in payload → refuse to retry (could
    # silently reroute to a different provider).
    g._core.get_workflow_task = AsyncMock(return_value={
        "payload": {"capability": "eta_query", "params": {"route_id": "42"}},
    })

    details = {
        "response_status": "error",
        "error": "schema_version_mismatch",
        "capability": "eta_query",
        "query_id": "q-legacy",
        "origin_channel": "telegram:555",
    }
    await g._handle_service_query_result(details, task_id="task-legacy")

    g._service_query_orchestrator.retry_with_fresh_schema.assert_not_called()
    # User still informed via the normal error path.
    g._telegram._bot.send_message.assert_awaited()


@pytest.mark.asyncio
async def test_non_mismatch_error_takes_normal_error_path():
    g = _guardian()
    _attach_telegram(g)
    details = {
        "response_status": "error",
        "error": "provider_timeout",
        "capability": "eta_query",
        "query_id": "q-timeout",
        "origin_channel": "telegram:555",
    }
    await g._handle_service_query_result(details, task_id="task-timeout")

    g._service_query_orchestrator.retry_with_fresh_schema.assert_not_called()
    # Error message still delivered to the originating chat.
    tg = g._telegram
    tg._bot.send_message.assert_awaited_once()
    chat_id, _ = tg._bot.send_message.await_args.args
    assert chat_id == 555
