"""Tests for the ``/service_query`` Telegram entrypoint.

The schema-driven requester path demands structured params. Earlier the
command just forwarded lat/lng and stuffed "bus 42" into free text, so
eta_query hit the sender-side validator and failed locally before any
D2D send. These tests lock in:

- eta_query parses ``route_id`` from args[3] (required by schema).
- non-eta capabilities still get ``user_text`` as a free-form bag.
- missing route_id surfaces a usage error, never an orchestrator call.
- ``origin_channel=telegram:<chat_id>`` is forwarded so the response
  can route back to the chat that issued the query (not a broadcast).
- unknown/unallowed users are silently ignored.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.service.telegram import TelegramService


@pytest.fixture
def mock_guardian():
    g = MagicMock()
    # Orchestrator is attached to the guardian instance in real wiring.
    g._service_query_orchestrator = MagicMock()
    g._service_query_orchestrator.handle_user_query = AsyncMock()
    return g


@pytest.fixture
def service(mock_guardian):
    svc = TelegramService(
        guardian=mock_guardian,
        core=AsyncMock(),
        allowed_user_ids={111},
        allowed_group_ids=set(),
    )
    svc.set_bot(MagicMock())
    return svc


def _update(user_id=111, chat_id=111):
    u = MagicMock()
    u.effective_user = MagicMock()
    u.effective_user.id = user_id
    u.effective_chat = MagicMock()
    u.effective_chat.id = chat_id
    u.message = MagicMock()
    u.message.reply_text = AsyncMock()
    return u


def _ctx(args):
    ch = AsyncMock()
    ctx = MagicMock()
    ctx.user_data = {"channel": ch}
    ctx.args = args
    return ctx, ch


# ---------------------------------------------------------------------------
# eta_query — schema-driven argument parsing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_service_query_eta_forwards_route_id_and_origin_channel(
    service, mock_guardian,
):
    ctx, ch = _ctx(["eta_query", "37.77", "-122.43", "42", "bus", "42"])
    await service.handle_service_query(_update(chat_id=555), ctx)

    orch = mock_guardian._service_query_orchestrator
    orch.handle_user_query.assert_awaited_once()
    kwargs = orch.handle_user_query.await_args.kwargs
    # Structured params: location + route_id (schema-required).
    assert kwargs["capability"] == "eta_query"
    assert kwargs["params"]["location"] == {"lat": 37.77, "lng": -122.43}
    assert kwargs["params"]["route_id"] == "42"
    # Trailing args beyond route_id become user_text for ranking context.
    assert kwargs["user_text"] == "bus 42"
    # origin_channel carries the specific chat so replies route back.
    assert kwargs["origin_channel"] == "telegram:555"


@pytest.mark.asyncio
async def test_service_query_eta_missing_route_id_rejected_locally(
    service, mock_guardian,
):
    ctx, ch = _ctx(["eta_query", "37.77", "-122.43"])
    await service.handle_service_query(_update(), ctx)

    # Never reached the orchestrator — user-facing error instead.
    mock_guardian._service_query_orchestrator.handle_user_query.assert_not_called()
    ch.send.assert_called()
    sent_text = ch.send.call_args[0][0].text
    assert "route" in sent_text.lower()


# ---------------------------------------------------------------------------
# Other capabilities — free-form user_text fallback
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_service_query_other_capability_uses_user_text_fallback(
    service, mock_guardian,
):
    ctx, ch = _ctx(["weather_lookup", "37.77", "-122.43", "today", "evening"])
    await service.handle_service_query(_update(chat_id=321), ctx)

    orch = mock_guardian._service_query_orchestrator
    kw = orch.handle_user_query.await_args.kwargs
    assert kw["capability"] == "weather_lookup"
    # Non-eta capability: all trailing args → user_text.
    assert kw["user_text"] == "today evening"
    # Params only carry location; the schema decides what else is required.
    assert kw["params"] == {"location": {"lat": 37.77, "lng": -122.43}}
    assert kw["origin_channel"] == "telegram:321"


# ---------------------------------------------------------------------------
# Validation / edge cases
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_service_query_too_few_args_shows_usage(service, mock_guardian):
    ctx, ch = _ctx(["eta_query", "37.77"])
    await service.handle_service_query(_update(), ctx)
    mock_guardian._service_query_orchestrator.handle_user_query.assert_not_called()
    sent_text = ch.send.call_args[0][0].text
    assert "Usage" in sent_text or "usage" in sent_text.lower()


@pytest.mark.asyncio
async def test_service_query_invalid_coords_rejected(service, mock_guardian):
    ctx, ch = _ctx(["eta_query", "not-a-number", "-122.43", "42"])
    await service.handle_service_query(_update(), ctx)
    mock_guardian._service_query_orchestrator.handle_user_query.assert_not_called()
    sent_text = ch.send.call_args[0][0].text
    assert "coord" in sent_text.lower() or "lat" in sent_text.lower()


@pytest.mark.asyncio
async def test_service_query_orchestrator_not_configured(service, mock_guardian):
    mock_guardian._service_query_orchestrator = None
    ctx, ch = _ctx(["eta_query", "37.77", "-122.43", "42"])
    await service.handle_service_query(_update(), ctx)
    sent_text = ch.send.call_args[0][0].text
    assert "DINA_APPVIEW_URL" in sent_text or "not configured" in sent_text.lower()


@pytest.mark.asyncio
async def test_service_query_unallowed_user_silently_ignored(service, mock_guardian):
    ctx, ch = _ctx(["eta_query", "37.77", "-122.43", "42"])
    await service.handle_service_query(_update(user_id=999), ctx)
    # No orchestrator call, no reply — the handler returns early.
    mock_guardian._service_query_orchestrator.handle_user_query.assert_not_called()
    ch.send.assert_not_called()


@pytest.mark.asyncio
async def test_service_query_forwards_nonzero_chat_id(service, mock_guardian):
    # Make sure chat_id isn't accidentally dropped when it's a group chat ID
    # (negative) or a large int.
    ctx, ch = _ctx(["eta_query", "37.77", "-122.43", "42"])
    await service.handle_service_query(_update(chat_id=-100123456), ctx)
    kw = mock_guardian._service_query_orchestrator.handle_user_query.await_args.kwargs
    assert kw["origin_channel"] == "telegram:-100123456"
