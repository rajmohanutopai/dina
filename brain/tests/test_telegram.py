"""Unit tests for the Telegram connector.

Tests the TelegramService (access control, message handling, pairing)
and TelegramBotAdapter lifecycle using mocks — no real Telegram API
calls, no bot token needed.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.service.telegram import TelegramService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_guardian():
    """Mock GuardianLoop that returns a canned response."""
    guardian = AsyncMock()
    guardian.process_event = AsyncMock(return_value={
        "action": "respond",
        "response": "Hello from Dina!",
    })
    return guardian


@pytest.fixture
def mock_core():
    """Mock CoreClient with KV and vault stubs."""
    core = AsyncMock()
    core.get_kv = AsyncMock(return_value=None)
    core.set_kv = AsyncMock()
    core.store_vault_item = AsyncMock(return_value="item-123")
    return core


@pytest.fixture
def mock_bot():
    """Mock TelegramBotAdapter."""
    bot = MagicMock()
    bot.bot_username = "dina_test_bot"
    bot.send_message = AsyncMock()
    return bot


@pytest.fixture
def service(mock_guardian, mock_core, mock_bot):
    """TelegramService wired with mocks, user 111 is allowed."""
    svc = TelegramService(
        guardian=mock_guardian,
        core=mock_core,
        allowed_user_ids={111, 222},
        allowed_group_ids={-1001},
    )
    svc.set_bot(mock_bot)
    return svc


def _make_update(
    user_id: int = 111,
    chat_id: int = 111,
    chat_type: str = "private",
    text: str = "What's the weather?",
    username: str = "testuser",
    update_id: int = 42,
):
    """Build a mock telegram.Update object."""
    update = MagicMock()
    update.update_id = update_id
    update.effective_user = MagicMock()
    update.effective_user.id = user_id
    update.effective_user.username = username
    update.effective_chat = MagicMock()
    update.effective_chat.id = chat_id
    update.effective_chat.type = chat_type
    update.message = MagicMock()
    update.message.text = text
    update.message.reply_text = AsyncMock()
    return update


# ---------------------------------------------------------------------------
# /start pairing tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_allowed_user_gets_paired(service, mock_core):
    """Allowed user sending /start should be paired and welcomed."""
    update = _make_update(user_id=111, text="/start")
    context = MagicMock()

    await service.handle_start(update, context)

    update.message.reply_text.assert_called_once()
    reply_text = update.message.reply_text.call_args[0][0]
    assert "Welcome" in reply_text
    assert 111 in service._paired_users
    # Pairing persisted to KV.
    mock_core.set_kv.assert_called_once()
    key, value = mock_core.set_kv.call_args[0]
    assert key == "telegram_paired_users"
    assert 111 in json.loads(value)


@pytest.mark.asyncio
async def test_start_unknown_user_rejected(service):
    """Unknown user sending /start should get a polite rejection."""
    update = _make_update(user_id=999, text="/start")
    context = MagicMock()

    await service.handle_start(update, context)

    update.message.reply_text.assert_called_once()
    reply_text = update.message.reply_text.call_args[0][0]
    assert "Sorry" in reply_text
    assert 999 not in service._paired_users


@pytest.mark.asyncio
async def test_start_already_paired_user(service):
    """Already-paired user gets a different message."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/start")
    context = MagicMock()

    await service.handle_start(update, context)

    reply_text = update.message.reply_text.call_args[0][0]
    assert "already paired" in reply_text


# ---------------------------------------------------------------------------
# DM message tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_from_allowed_user_processed(service, mock_guardian):
    """DM from an allowed user should go through Guardian."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="Hello Dina")
    context = MagicMock()

    await service.handle_message(update, context)

    # Guardian was called with the message.
    mock_guardian.process_event.assert_called_once()
    event = mock_guardian.process_event.call_args[0][0]
    assert event["type"] == "reason"
    assert event["prompt"] == "Hello Dina"
    assert event["source"] == "telegram"

    # Reply was sent.
    update.message.reply_text.assert_called_once_with("Hello from Dina!")


@pytest.mark.asyncio
async def test_dm_from_unknown_user_rejected(service, mock_guardian):
    """DM from an unknown user should not reach Guardian."""
    update = _make_update(user_id=999, text="Hello")
    context = MagicMock()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()
    reply_text = update.message.reply_text.call_args[0][0]
    assert "don't recognise" in reply_text


# ---------------------------------------------------------------------------
# Group message tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_group_message_with_mention_processed(service, mock_guardian):
    """Group message mentioning @bot should be processed."""
    service._paired_users.add(111)
    update = _make_update(
        user_id=111,
        chat_id=-1001,
        chat_type="group",
        text="@dina_test_bot what time is it?",
    )
    context = MagicMock()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_called_once()
    # Bot mention should be stripped from the prompt.
    event = mock_guardian.process_event.call_args[0][0]
    assert "@dina_test_bot" not in event["prompt"]
    assert "what time is it?" in event["prompt"]


@pytest.mark.asyncio
async def test_group_message_without_mention_ignored(service, mock_guardian):
    """Group message without @bot mention should be ignored."""
    update = _make_update(
        user_id=111,
        chat_id=-1001,
        chat_type="group",
        text="just chatting among friends",
    )
    context = MagicMock()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()


@pytest.mark.asyncio
async def test_group_message_disallowed_group_ignored(service, mock_guardian):
    """Message in a non-allowlisted group should be ignored."""
    update = _make_update(
        user_id=111,
        chat_id=-9999,
        chat_type="supergroup",
        text="@dina_test_bot hello",
    )
    context = MagicMock()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()


# ---------------------------------------------------------------------------
# Paired users persistence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_paired_users_from_kv(service, mock_core):
    """Paired users should be loaded from Core KV on startup."""
    mock_core.get_kv = AsyncMock(return_value=json.dumps([111, 333]))

    await service.load_paired_users()

    assert service._paired_users == {111, 333}


@pytest.mark.asyncio
async def test_load_paired_users_empty_kv(service, mock_core):
    """Empty KV should result in empty paired set (no error)."""
    mock_core.get_kv = AsyncMock(return_value=None)

    await service.load_paired_users()

    assert service._paired_users == set()


@pytest.mark.asyncio
async def test_load_paired_users_kv_error(service, mock_core):
    """KV error should be handled gracefully (empty set)."""
    mock_core.get_kv = AsyncMock(side_effect=Exception("connection refused"))

    await service.load_paired_users()

    assert service._paired_users == set()


# ---------------------------------------------------------------------------
# Nudge (outbound)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_nudge(service, mock_bot):
    """send_nudge should call bot.send_message."""
    await service.send_nudge(111, "Reminder: meeting at 3pm")

    mock_bot.send_message.assert_called_once_with(111, "Reminder: meeting at 3pm")


# ---------------------------------------------------------------------------
# Vault storage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_message_stored_in_vault(service, mock_core, mock_guardian):
    """Processed messages should be stored in vault."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="Store this")
    context = MagicMock()

    await service.handle_message(update, context)

    mock_core.store_vault_item.assert_called_once()
    args = mock_core.store_vault_item.call_args[0]
    assert args[0] == "default"  # persona_id
    item = args[1]
    assert item["type"] == "message"
    assert item["source"] == "telegram"
    assert item["body_text"] == "Store this"


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------


def test_config_telegram_fields():
    """Config should parse Telegram env vars."""
    import os
    env = {
        "DINA_BRAIN_TOKEN": "test-token",
        "DINA_TELEGRAM_TOKEN": "123:ABC",
        "DINA_TELEGRAM_ALLOWED_USERS": "111,222,333",
        "DINA_TELEGRAM_ALLOWED_GROUPS": "-1001,-1002",
    }
    with patch.dict(os.environ, env, clear=False):
        from src.infra.config import load_brain_config
        cfg = load_brain_config()

    assert cfg.telegram_token == "123:ABC"
    assert cfg.telegram_allowed_users == frozenset({111, 222, 333})
    assert cfg.telegram_allowed_groups == frozenset({-1001, -1002})


def test_config_no_telegram_token():
    """Config should set telegram_token=None when env var is missing."""
    import os
    env = {
        "DINA_BRAIN_TOKEN": "test-token",
    }
    # Clear any TELEGRAM env vars that might be set.
    clean_env = {k: v for k, v in os.environ.items() if "TELEGRAM" not in k}
    clean_env.update(env)
    with patch.dict(os.environ, clean_env, clear=True):
        from src.infra.config import load_brain_config
        cfg = load_brain_config()

    assert cfg.telegram_token is None
    assert cfg.telegram_allowed_users == frozenset()
    assert cfg.telegram_allowed_groups == frozenset()


# ---------------------------------------------------------------------------
# Adapter lifecycle tests (with mocked python-telegram-bot)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_adapter_start_stop():
    """Adapter start/stop should call Application lifecycle methods."""
    with patch("src.adapter.telegram_bot.Application") as MockApp:
        mock_app_instance = MagicMock()
        mock_app_instance.initialize = AsyncMock()
        mock_app_instance.start = AsyncMock()
        mock_app_instance.stop = AsyncMock()
        mock_app_instance.shutdown = AsyncMock()
        mock_app_instance.running = True

        mock_updater = MagicMock()
        mock_updater.start_polling = AsyncMock()
        mock_updater.stop = AsyncMock()
        mock_updater.running = True
        mock_app_instance.updater = mock_updater

        mock_bot_obj = MagicMock()
        mock_bot_obj.get_me = AsyncMock(return_value=MagicMock(username="test_bot"))
        mock_app_instance.bot = mock_bot_obj

        # Mock the builder pattern.
        mock_builder = MagicMock()
        mock_builder.token.return_value = mock_builder
        mock_builder.build.return_value = mock_app_instance
        MockApp.builder.return_value = mock_builder

        from src.adapter.telegram_bot import TelegramBotAdapter

        adapter = TelegramBotAdapter(
            bot_token="fake:token",
            message_callback=AsyncMock(),
        )
        # Replace the internal app with our mock.
        adapter._app = mock_app_instance

        await adapter.start()
        assert adapter.bot_username == "test_bot"
        mock_app_instance.initialize.assert_called_once()
        mock_updater.start_polling.assert_called_once()

        await adapter.stop()
        mock_updater.stop.assert_called_once()
        mock_app_instance.stop.assert_called_once()
        mock_app_instance.shutdown.assert_called_once()
