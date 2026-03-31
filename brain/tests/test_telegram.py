"""Unit tests for the Telegram connector.

Tests the TelegramService (access control, message handling, pairing),
TelegramBotAdapter lifecycle, error handling, edge cases, and config
validation using mocks — no real Telegram API calls, no bot token needed.

Test coverage:
    - /start pairing: allowed, rejected, already-paired
    - /ask command: allowed user, unknown user, empty text, Guardian error
    - /remember command: stores via staging, polls status, empty text, error
    - Plain DM messages: show command hints, not forwarded to Guardian
    - Group messages: mentioned, not mentioned, disallowed group, supergroup
    - Auto-pair on first DM: allowed user auto-pairs without /start
    - Callback query handler: approve/deny button presses
    - Paired users: load from KV, empty KV, KV error, persist on pair
    - Nudge outbound: send, no-bot fallback
    - Vault storage: messages are NOT stored (no _store_message call)
    - Config: parse telegram env vars, no token, Docker Secrets pattern
    - Adapter lifecycle: start/stop, send_message, start failure → TelegramError
    - Port protocol: MockTelegramConnector satisfies TelegramBot protocol
    - Graceful degradation: no effective_user, no message, no text
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.service.telegram import TelegramService
from src.domain.errors import TelegramError


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_guardian():
    """Mock GuardianLoop that returns a canned response.

    Guardian returns {"content": "..."} for reason events.
    """
    guardian = AsyncMock()
    guardian.process_event = AsyncMock(return_value={
        "content": "Hello from Dina!",
    })
    return guardian


@pytest.fixture
def mock_core():
    """Mock CoreClient with KV and vault stubs."""
    core = AsyncMock()
    core.get_kv = AsyncMock(return_value=None)
    core.set_kv = AsyncMock()
    core.store_vault_item = AsyncMock(return_value="item-123")
    core.staging_ingest = AsyncMock(return_value="staging-001")
    core.staging_status = AsyncMock(return_value={"status": "stored", "persona": "finance"})
    core.approve_request = AsyncMock()
    core.deny_request = AsyncMock()
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


def _make_context():
    """Build a mock context with a TelegramChannel in user_data.

    Returns (context, mock_channel) so tests can assert on mock_channel.send.
    The TelegramService handlers call ``ch = self._ch(context)`` which reads
    ``context.user_data["channel"]``, then ``await ch.send(BotResponse(...))``.
    """
    mock_channel = AsyncMock()
    context = MagicMock()
    context.user_data = {"channel": mock_channel}
    return context, mock_channel


def _last_reply_text(mock_channel):
    """Extract the text from the last ch.send(BotResponse(...)) call."""
    return mock_channel.send.call_args[0][0].text


# ---------------------------------------------------------------------------
# /start pairing tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_allowed_user_gets_paired(service, mock_core):
    """Allowed user sending /start should be paired and welcomed."""
    update = _make_update(user_id=111, text="/start")
    context, mock_ch = _make_context()

    await service.handle_start(update, context)

    mock_ch.send.assert_called_once()
    reply_text = _last_reply_text(mock_ch)
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
    context, mock_ch = _make_context()

    await service.handle_start(update, context)

    mock_ch.send.assert_called_once()
    reply_text = _last_reply_text(mock_ch)
    assert "Sorry" in reply_text
    assert 999 not in service._paired_users


@pytest.mark.asyncio
async def test_start_already_paired_user(service):
    """Already-paired user gets a different message."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/start")
    context, mock_ch = _make_context()

    await service.handle_start(update, context)

    reply_text = _last_reply_text(mock_ch)
    assert "already paired" in reply_text


# ---------------------------------------------------------------------------
# /ask command tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_from_allowed_user_calls_guardian(service, mock_guardian):
    """/ask from an allowed user should forward the question to Guardian."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/ask What is my FD status?")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_guardian.process_event.assert_called_once()
    event = mock_guardian.process_event.call_args[0][0]
    assert event["type"] == "reason"
    assert event["prompt"] == "What is my FD status?"
    assert event["source"] == "telegram"

    # Reply was sent with the content field from Guardian.
    mock_ch.send.assert_called_once()
    assert _last_reply_text(mock_ch) == "Hello from Dina!"


@pytest.mark.asyncio
async def test_ask_from_unknown_user_rejected(service, mock_guardian):
    """/ask from an unknown user should not reach Guardian."""
    update = _make_update(user_id=999, text="/ask hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_guardian.process_event.assert_not_called()
    reply_text = _last_reply_text(mock_ch)
    assert "don't recognise" in reply_text


@pytest.mark.asyncio
async def test_ask_empty_text_shows_usage(service, mock_guardian):
    """/ask with no text should show usage hint."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/ask")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_guardian.process_event.assert_not_called()
    reply_text = _last_reply_text(mock_ch)
    assert "Usage" in reply_text


@pytest.mark.asyncio
async def test_ask_auto_pairs_allowed_user(service, mock_core):
    """/ask from an allowed but unpaired user should auto-pair them."""
    # User 111 is allowed but not yet paired.
    assert 111 not in service._paired_users

    update = _make_update(user_id=111, text="/ask hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    assert 111 in service._paired_users
    mock_core.set_kv.assert_called_once()


@pytest.mark.asyncio
async def test_ask_guardian_error_sends_friendly_reply(service, mock_guardian):
    """/ask when Guardian raises should return a friendly error message."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(side_effect=RuntimeError("LLM timeout"))
    update = _make_update(user_id=111, text="/ask crash me")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_ch.send.assert_called_once()
    reply_text = _last_reply_text(mock_ch)
    assert "went wrong" in reply_text or "try again" in reply_text


@pytest.mark.asyncio
async def test_ask_strips_command_prefix(service, mock_guardian):
    """/ask strips the command prefix before sending to Guardian."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/ask  What time is it?  ")
    context, _mock_ch = _make_context()

    await service.handle_ask(update, context)

    event = mock_guardian.process_event.call_args[0][0]
    assert event["prompt"] == "What time is it?"


# ---------------------------------------------------------------------------
# /remember command tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remember_ingests_to_staging(service, mock_core):
    """/remember should ingest the note to staging pipeline."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/remember My FD rate is 7.8%")
    context, _mock_ch = _make_context()

    await service.handle_remember(update, context)

    mock_core.staging_ingest.assert_called_once()
    item = mock_core.staging_ingest.call_args[0][0]
    assert item["type"] == "note"
    assert item["source"] == "telegram"
    assert item["body"] == "My FD rate is 7.8%"
    assert item["ingress_channel"] == "telegram"
    assert item["origin_kind"] == "user"


@pytest.mark.asyncio
async def test_remember_polls_staging_status(service, mock_core):
    """/remember polls staging_status for result after ingest."""
    service._paired_users.add(111)
    # staging_status returns stored immediately.
    mock_core.staging_status = AsyncMock(
        return_value={"status": "stored", "persona": "finance"}
    )
    update = _make_update(user_id=111, text="/remember test note")
    context, _mock_ch = _make_context()

    await service.handle_remember(update, context)

    # staging_status was polled at least once.
    mock_core.staging_status.assert_called()
    # staging_status was called with the staging ID returned by staging_ingest.
    mock_core.staging_status.assert_called_with("staging-001")


@pytest.mark.asyncio
async def test_remember_stored_reply(service, mock_core):
    """/remember returns 'Stored in *persona* vault.' on success."""
    service._paired_users.add(111)
    mock_core.staging_status = AsyncMock(
        return_value={"status": "stored", "persona": "finance"}
    )
    update = _make_update(user_id=111, text="/remember note text")
    context, mock_ch = _make_context()

    await service.handle_remember(update, context)

    reply_text = _last_reply_text(mock_ch)
    assert "Stored" in reply_text
    assert "finance" in reply_text


@pytest.mark.asyncio
async def test_remember_needs_approval_reply(service, mock_core):
    """/remember returns 'Needs approval' when persona needs unlock."""
    service._paired_users.add(111)
    mock_core.staging_status = AsyncMock(
        return_value={"status": "needs_approval", "persona": "health"}
    )
    update = _make_update(user_id=111, text="/remember my HbA1c is 5.8")
    context, mock_ch = _make_context()

    await service.handle_remember(update, context)

    reply_text = _last_reply_text(mock_ch)
    assert "Needs approval" in reply_text
    assert "health" in reply_text


@pytest.mark.asyncio
async def test_remember_empty_text_shows_usage(service, mock_guardian):
    """/remember with no text should show usage hint."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="/remember")
    context, mock_ch = _make_context()

    await service.handle_remember(update, context)

    mock_core_obj = service._core
    mock_core_obj.staging_ingest.assert_not_called()
    reply_text = _last_reply_text(mock_ch)
    assert "Usage" in reply_text


@pytest.mark.asyncio
async def test_remember_from_unknown_user_rejected(service):
    """/remember from an unknown user should get a rejection."""
    update = _make_update(user_id=999, text="/remember something")
    context, mock_ch = _make_context()

    await service.handle_remember(update, context)

    reply_text = _last_reply_text(mock_ch)
    assert "don't recognise" in reply_text


@pytest.mark.asyncio
async def test_remember_ingest_failure_sends_error_reply(service, mock_core):
    """/remember ingest failure sends a friendly error reply."""
    service._paired_users.add(111)
    mock_core.staging_ingest = AsyncMock(side_effect=Exception("core down"))
    update = _make_update(user_id=111, text="/remember test")
    context, mock_ch = _make_context()

    await service.handle_remember(update, context)

    reply_text = _last_reply_text(mock_ch)
    assert "couldn't save" in reply_text or "Sorry" in reply_text


@pytest.mark.asyncio
async def test_remember_auto_pairs_allowed_user(service, mock_core):
    """/remember from an allowed but unpaired user should auto-pair them."""
    assert 111 not in service._paired_users
    mock_core.staging_status = AsyncMock(
        return_value={"status": "stored", "persona": "personal"}
    )
    update = _make_update(user_id=111, text="/remember auto pair me")
    context, _mock_ch = _make_context()

    await service.handle_remember(update, context)

    assert 111 in service._paired_users


# ---------------------------------------------------------------------------
# Plain DM message tests — no Guardian call, shows command hints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dm_plain_message_shows_command_hints(service, mock_guardian):
    """Plain DM from an allowed user should NOT go to Guardian.

    Instead, the service responds with a hint about /ask and /remember.
    """
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="Hello Dina")
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    # Guardian must NOT be called for plain DMs.
    mock_guardian.process_event.assert_not_called()

    # User gets command hints.
    reply_text = _last_reply_text(mock_ch)
    assert "/ask" in reply_text
    assert "/remember" in reply_text


@pytest.mark.asyncio
async def test_dm_plain_message_not_stored(service, mock_core):
    """Plain DM messages must NOT be stored in vault (no staging_ingest call)."""
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="Random message")
    context, _mock_ch = _make_context()

    await service.handle_message(update, context)

    # Plain DM handler must not call staging_ingest.
    mock_core.staging_ingest.assert_not_called()
    mock_core.store_vault_item.assert_not_called()


@pytest.mark.asyncio
async def test_dm_from_unknown_user_rejected(service, mock_guardian):
    """DM from an unknown user should not reach Guardian."""
    update = _make_update(user_id=999, text="Hello")
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()
    reply_text = _last_reply_text(mock_ch)
    assert "don't recognise" in reply_text


@pytest.mark.asyncio
async def test_dm_auto_pairs_allowed_user(service, mock_core):
    """Allowed but unpaired user sending any DM should be auto-paired."""
    # User 111 is allowed but not yet in paired set.
    assert 111 not in service._paired_users

    update = _make_update(user_id=111, text="First message")
    context, _mock_ch = _make_context()

    await service.handle_message(update, context)

    # Auto-pairing happened.
    assert 111 in service._paired_users
    mock_core.set_kv.assert_called_once()


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
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    # Group messages with @mention go through the approval-check/hint path;
    # the text (minus @mention) is checked for approval commands, then hints.
    # Guardian is NOT called directly from handle_message — only from handle_ask.
    # Verify the bot mention was stripped (service didn't crash, reply was sent).
    # At minimum: no exception raised, and the @mention processing ran.
    mock_ch.send.assert_called()


@pytest.mark.asyncio
async def test_group_message_without_mention_ignored(service, mock_guardian):
    """Group message without @bot mention should be ignored."""
    update = _make_update(
        user_id=111,
        chat_id=-1001,
        chat_type="group",
        text="just chatting among friends",
    )
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()
    mock_ch.send.assert_not_called()


@pytest.mark.asyncio
async def test_group_message_disallowed_group_ignored(service, mock_guardian):
    """Message in a non-allowlisted group should be ignored."""
    update = _make_update(
        user_id=111,
        chat_id=-9999,
        chat_type="supergroup",
        text="@dina_test_bot hello",
    )
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()
    mock_ch.send.assert_not_called()


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
# Vault storage: plain DMs are NOT stored (no _store_message call)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
# TST-BRAIN-813
async def test_plain_dm_message_not_stored_via_staging(service, mock_core, mock_guardian):
    """Plain DM messages are NOT staged — Telegram questions are read-only.

    Only /remember explicitly stores. Plain DMs and /ask never call
    staging_ingest or store_vault_item.
    """
    service._paired_users.add(111)
    update = _make_update(user_id=111, text="Store this?")
    context, _mock_ch = _make_context()

    await service.handle_message(update, context)

    # Must NOT store plain DM content.
    mock_core.staging_ingest.assert_not_called()
    mock_core.store_vault_item.assert_not_called()
    # Guardian also must not be called.
    mock_guardian.process_event.assert_not_called()


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


# ---------------------------------------------------------------------------
# Adapter error handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_adapter_start_invalid_token_raises_telegram_error():
    """Adapter.start() should raise TelegramError on bad token."""
    from src.adapter.telegram_bot import TelegramBotAdapter

    adapter = TelegramBotAdapter(
        bot_token="invalid:token",
        message_callback=AsyncMock(),
    )
    # Make initialize() fail (simulates invalid token).
    adapter._app = MagicMock()
    adapter._app.initialize = AsyncMock(side_effect=Exception("Unauthorized"))

    with pytest.raises(TelegramError, match="Failed to start"):
        await adapter.start()


@pytest.mark.asyncio
async def test_adapter_send_message_error_raises_telegram_error():
    """Adapter.send_message() should raise TelegramError on failure."""
    from src.adapter.telegram_bot import TelegramBotAdapter

    adapter = TelegramBotAdapter(
        bot_token="fake:token",
        message_callback=AsyncMock(),
    )
    mock_bot_obj = MagicMock()
    mock_bot_obj.send_message = AsyncMock(side_effect=Exception("Chat not found"))
    adapter._app = MagicMock()
    adapter._app.bot = mock_bot_obj

    with pytest.raises(TelegramError, match="Failed to send message"):
        await adapter.send_message(99999, "hello")


@pytest.mark.asyncio
async def test_adapter_stop_error_handled_gracefully():
    """Adapter.stop() should not raise even if internal stop fails."""
    from src.adapter.telegram_bot import TelegramBotAdapter

    adapter = TelegramBotAdapter(
        bot_token="fake:token",
        message_callback=AsyncMock(),
    )
    mock_updater = MagicMock()
    mock_updater.running = True
    mock_updater.stop = AsyncMock(side_effect=RuntimeError("already stopped"))
    adapter._app = MagicMock()
    adapter._app.updater = mock_updater
    adapter._app.running = False

    # Should not raise.
    await adapter.stop()


# ---------------------------------------------------------------------------
# Service edge cases — missing fields in Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_message_no_effective_user(service, mock_guardian):
    """Update with no effective_user should be silently ignored."""
    update = _make_update()
    update.effective_user = None
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()


@pytest.mark.asyncio
async def test_handle_message_no_message_text(service, mock_guardian):
    """Update with no message text should be silently ignored."""
    update = _make_update()
    update.message.text = None
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()


@pytest.mark.asyncio
async def test_handle_message_empty_message(service, mock_guardian):
    """Update with message=None should be silently ignored."""
    update = _make_update()
    update.message = None
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    mock_guardian.process_event.assert_not_called()


@pytest.mark.asyncio
async def test_handle_start_no_effective_user(service):
    """Handle /start with no effective_user should be silently ignored."""
    update = _make_update()
    update.effective_user = None
    context, _mock_ch = _make_context()

    await service.handle_start(update, context)
    # No exception, no reply.


@pytest.mark.asyncio
async def test_handle_start_no_effective_chat(service):
    """Handle /start with no effective_chat should be silently ignored."""
    update = _make_update()
    update.effective_chat = None
    context, _mock_ch = _make_context()

    await service.handle_start(update, context)


# ---------------------------------------------------------------------------
# Guardian error handling (via /ask)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_guardian_error_sends_error_reply(service, mock_guardian):
    """If Guardian raises during /ask, user should get a friendly error message."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(
        side_effect=RuntimeError("LLM timeout")
    )
    update = _make_update(user_id=111, text="/ask Crash me")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_ch.send.assert_called()
    reply_text = _last_reply_text(mock_ch)
    assert "went wrong" in reply_text or "try again" in reply_text


@pytest.mark.asyncio
async def test_ask_empty_response_not_sent(service, mock_guardian):
    """Guardian returning empty content/response should not send a reply."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(return_value={
        "content": "",
        "response": "",
    })
    update = _make_update(user_id=111, text="/ask Hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    # ch.send should not be called for an empty response.
    calls = [c for c in mock_ch.send.call_args_list
             if c[0][0].text == ""]
    assert len(calls) == 0


@pytest.mark.asyncio
async def test_ask_content_field_takes_precedence_over_response(service, mock_guardian):
    """_extract_response should prefer 'content' field over 'response' field."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(return_value={
        "content": "From content field",
        "response": "From response field",
    })
    update = _make_update(user_id=111, text="/ask Hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_ch.send.assert_called_once()
    assert _last_reply_text(mock_ch) == "From content field"


@pytest.mark.asyncio
async def test_ask_response_field_fallback(service, mock_guardian):
    """_extract_response falls back to 'response' when 'content' is absent."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(return_value={
        "action": "respond",
        "response": "Fallback answer",
    })
    update = _make_update(user_id=111, text="/ask Hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_ch.send.assert_called_once()
    assert _last_reply_text(mock_ch) == "Fallback answer"


@pytest.mark.asyncio
async def test_ask_dict_response_extracted(service, mock_guardian):
    """Guardian returning a dict 'response' should extract text correctly."""
    service._paired_users.add(111)
    mock_guardian.process_event = AsyncMock(return_value={
        "action": "respond",
        "response": {"text": "structured answer", "confidence": 0.9},
    })
    update = _make_update(user_id=111, text="/ask Hello")
    context, mock_ch = _make_context()

    await service.handle_ask(update, context)

    mock_ch.send.assert_called_once()
    assert _last_reply_text(mock_ch) == "structured answer"


# ---------------------------------------------------------------------------
# Vault storage failure (graceful) — via /ask
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_vault_store_failure_does_not_crash(service, mock_core, mock_guardian):
    """/ask should still return Guardian's response even if vault is unavailable."""
    service._paired_users.add(111)
    mock_core.store_vault_item = AsyncMock(side_effect=Exception("vault down"))
    update = _make_update(user_id=111, text="/ask Store this")
    context, mock_ch = _make_context()

    # Should not raise.
    await service.handle_ask(update, context)

    # Guardian still processed the /ask.
    mock_guardian.process_event.assert_called_once()
    mock_ch.send.assert_called_once()
    assert _last_reply_text(mock_ch) == "Hello from Dina!"


# ---------------------------------------------------------------------------
# KV persistence failure on pairing (graceful)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pair_kv_failure_still_pairs_in_memory(service, mock_core):
    """If KV write fails during pairing, user should still be paired in memory."""
    mock_core.set_kv = AsyncMock(side_effect=Exception("KV unreachable"))
    update = _make_update(user_id=222, text="/start")
    context, mock_ch = _make_context()

    await service.handle_start(update, context)

    # Paired in memory despite KV failure.
    assert 222 in service._paired_users
    # User still gets the welcome message.
    reply_text = _last_reply_text(mock_ch)
    assert "Welcome" in reply_text


# ---------------------------------------------------------------------------
# Nudge edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_nudge_no_bot_set():
    """send_nudge with no bot set should silently do nothing."""
    svc = TelegramService(
        guardian=AsyncMock(),
        core=AsyncMock(),
    )
    # No set_bot() called — bot is None.
    await svc.send_nudge(111, "test")  # Should not raise.


# ---------------------------------------------------------------------------
# Multiple users pairing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multiple_users_pair_independently(service, mock_core):
    """Two different allowed users should pair independently."""
    context, _mock_ch = _make_context()

    update1 = _make_update(user_id=111, text="/start")
    await service.handle_start(update1, context)
    assert 111 in service._paired_users

    update2 = _make_update(user_id=222, text="/start", chat_id=222)
    await service.handle_start(update2, context)
    assert 222 in service._paired_users

    # KV should have been called twice — both users persisted.
    assert mock_core.set_kv.call_count == 2
    last_kv_value = json.loads(mock_core.set_kv.call_args[0][1])
    assert 111 in last_kv_value
    assert 222 in last_kv_value


# ---------------------------------------------------------------------------
# Group: supergroup type also works
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_supergroup_message_with_mention(service, mock_guardian):
    """Supergroup messages with mention should reach the reply path."""
    service._paired_users.add(111)
    update = _make_update(
        user_id=111,
        chat_id=-1001,
        chat_type="supergroup",
        text="@dina_test_bot help me",
    )
    context, mock_ch = _make_context()

    await service.handle_message(update, context)

    # Message was processed (bot mention stripped, command hints sent).
    mock_ch.send.assert_called()


# ---------------------------------------------------------------------------
# Port protocol conformance
# ---------------------------------------------------------------------------


def test_adapter_satisfies_port_protocol():
    """TelegramBotAdapter should satisfy the TelegramBot protocol."""
    from src.port.telegram import TelegramBot
    from src.adapter.telegram_bot import TelegramBotAdapter

    assert isinstance(TelegramBotAdapter, type)
    # Verify all required methods exist on the adapter.
    for method in ("send_message", "start", "stop"):
        assert hasattr(TelegramBotAdapter, method), f"Missing method: {method}"
    assert hasattr(TelegramBotAdapter, "bot_username"), "Missing property: bot_username"


# ---------------------------------------------------------------------------
# Config edge cases
# ---------------------------------------------------------------------------


def test_config_allowed_users_with_spaces():
    """Spaces in DINA_TELEGRAM_ALLOWED_USERS should be handled."""
    import os
    env = {
        "DINA_BRAIN_TOKEN": "test-token",
        "DINA_TELEGRAM_TOKEN": "123:ABC",
        "DINA_TELEGRAM_ALLOWED_USERS": " 111 , 222 , 333 ",
    }
    with patch.dict(os.environ, env, clear=False):
        from src.infra.config import load_brain_config
        cfg = load_brain_config()

    assert cfg.telegram_allowed_users == frozenset({111, 222, 333})


def test_config_allowed_users_with_invalid_entries():
    """Non-numeric entries in allowed users should be silently skipped."""
    import os
    env = {
        "DINA_BRAIN_TOKEN": "test-token",
        "DINA_TELEGRAM_TOKEN": "123:ABC",
        "DINA_TELEGRAM_ALLOWED_USERS": "111,abc,333,,",
    }
    with patch.dict(os.environ, env, clear=False):
        from src.infra.config import load_brain_config
        cfg = load_brain_config()

    assert cfg.telegram_allowed_users == frozenset({111, 333})


# ---------------------------------------------------------------------------
# Approval delivery and response handling (InlineKeyboardMarkup)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_approval_prompt_sends_to_all_paired(service, mock_bot):
    """send_approval_prompt sends an inline-keyboard message to each paired user."""
    service._paired_users = {111, 222}

    approval = {
        "id": "apr-001",
        "persona": "health",
        "client_did": "did:key:z6MkAgent",
        "session": "chair-research",
        "reason": "Store office chairs for back pain",
    }
    await service.send_approval_prompt(approval)

    assert mock_bot.send_message.await_count == 2
    # Verify message contains approval details.
    call_args = mock_bot.send_message.await_args_list[0]
    msg = call_args.args[1]
    assert "health" in msg
    assert call_args.kwargs.get("parse_mode") == "Markdown"
    # Inline keyboard must be present.
    assert "reply_markup" in call_args.kwargs


@pytest.mark.asyncio
async def test_send_approval_prompt_includes_inline_keyboard(service, mock_bot):
    """Approval prompt must include an InlineKeyboardMarkup with approve/deny buttons."""
    from telegram import InlineKeyboardMarkup

    service._paired_users = {111}
    approval = {
        "id": "apr-kb",
        "persona": "health",
        "client_did": "did:key:z6MkAgent",
        "session": "test",
        "reason": "Store something",
    }
    await service.send_approval_prompt(approval)

    call_kwargs = mock_bot.send_message.await_args.kwargs
    keyboard = call_kwargs.get("reply_markup")
    assert keyboard is not None
    assert isinstance(keyboard, InlineKeyboardMarkup)

    # Flatten buttons.
    buttons = [btn for row in keyboard.inline_keyboard for btn in row]
    callback_data_values = [btn.callback_data for btn in buttons]
    assert any("approve apr-kb" in d for d in callback_data_values)
    assert any("deny apr-kb" in d for d in callback_data_values)
    assert any("approve-single apr-kb" in d for d in callback_data_values)


@pytest.mark.asyncio
async def test_send_approval_prompt_escapes_markdown(service, mock_bot):
    """Markdown special chars in reason/agent fields are escaped."""
    service._paired_users = {111}

    approval = {
        "id": "apr-002",
        "persona": "health",
        "client_did": "did:key:*agent*",
        "session": "test",
        "reason": "search *bold* _italic_ `code` [link](url)",
        "preview": "some *bold* text",
    }
    await service.send_approval_prompt(approval)

    msg = mock_bot.send_message.await_args.args[1]
    # Raw Markdown chars in preview must be escaped.
    assert "\\*bold\\*" in msg


@pytest.mark.asyncio
async def test_send_approval_prompt_no_bot(service):
    """No-op when bot is not set."""
    service._bot = None
    service._paired_users = {111}
    # Should not raise.
    await service.send_approval_prompt({"id": "apr-x", "persona": "health"})


@pytest.mark.asyncio
async def test_send_approval_prompt_no_paired_users(service, mock_bot):
    """No-op when no users are paired."""
    service._paired_users = set()
    await service.send_approval_prompt({"id": "apr-x", "persona": "health"})
    mock_bot.send_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_approval_prompt_skips_empty_approval(service, mock_bot):
    """send_approval_prompt returns early when id or persona is missing."""
    service._paired_users = {111}

    # Missing 'persona' — should be skipped.
    await service.send_approval_prompt({"id": "apr-x"})
    mock_bot.send_message.assert_not_awaited()

    # Missing 'id' — should be skipped.
    mock_bot.send_message.reset_mock()
    await service.send_approval_prompt({"persona": "health"})
    mock_bot.send_message.assert_not_awaited()

    # Both missing — skipped.
    mock_bot.send_message.reset_mock()
    await service.send_approval_prompt({})
    mock_bot.send_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_approval_prompt_send_failure_logged(service, mock_bot):
    """Send failure is logged but does not raise."""
    service._paired_users = {111}
    mock_bot.send_message.side_effect = Exception("Telegram API down")
    # Should not raise — best-effort delivery.
    await service.send_approval_prompt({"id": "apr-fail", "persona": "health"})


@pytest.mark.asyncio
async def test_send_approval_prompt_lazy_loads_paired_users(service, mock_bot, mock_core):
    """send_approval_prompt retries load_paired_users when _paired_users is empty."""
    # Start with no paired users (simulates startup race).
    service._paired_users = set()
    # KV returns a user on lazy load.
    mock_core.get_kv = AsyncMock(return_value=json.dumps([111]))

    approval = {"id": "apr-lazy", "persona": "health"}
    await service.send_approval_prompt(approval)

    # After lazy load, message was sent.
    mock_bot.send_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_handle_approval_response_approve(service, mock_core):
    """'approve <id>' calls core.approve_request and returns success."""
    result = await service.handle_approval_response("approve apr-001")
    assert result is not None
    assert "apr-001" in result
    assert "✅" in result
    mock_core.approve_request.assert_awaited_once_with(
        "apr-001", scope="session", granted_by="telegram",
    )


@pytest.mark.asyncio
async def test_handle_approval_response_deny(service, mock_core):
    """'deny <id>' calls core.deny_request and returns success."""
    result = await service.handle_approval_response("deny apr-002")
    assert result is not None
    assert "apr-002" in result
    assert "🚫" in result
    mock_core.deny_request.assert_awaited_once_with("apr-002")


@pytest.mark.asyncio
async def test_handle_approval_response_approve_failure(service, mock_core):
    """Approve failure returns generic error (BS4: no internal details leaked)."""
    mock_core.approve_request = AsyncMock(side_effect=Exception("not found"))
    result = await service.handle_approval_response("approve bad-id")
    assert "❌" in result
    # BS4: Must NOT leak exception details to Telegram chat.
    assert "not found" not in result
    assert "dashboard" in result


@pytest.mark.asyncio
async def test_handle_approval_response_not_a_command(service):
    """Non-command text returns None."""
    result = await service.handle_approval_response("hello world")
    assert result is None


@pytest.mark.asyncio
async def test_handle_approval_response_case_insensitive(service, mock_core):
    """Commands are case-insensitive."""
    result = await service.handle_approval_response("  Approve APR-003  ")
    assert result is not None
    mock_core.approve_request.assert_awaited_once()


# ---------------------------------------------------------------------------
# Approve-single (one-time grant)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_approval_response_approve_single(service, mock_core):
    """'approve-single <id>' calls core.approve_request with scope=single."""
    result = await service.handle_approval_response("approve-single apr-010")
    assert result is not None
    assert "apr-010" in result
    assert "single" in result.lower()
    mock_core.approve_request.assert_awaited_once_with(
        "apr-010", scope="single", granted_by="telegram",
    )


@pytest.mark.asyncio
async def test_handle_approval_response_approve_single_failure(service, mock_core):
    """approve-single failure returns generic error (BS4: no details leaked)."""
    mock_core.approve_request = AsyncMock(side_effect=Exception("expired"))
    result = await service.handle_approval_response("approve-single bad-id")
    assert "❌" in result
    # BS4: Must NOT leak exception details to Telegram chat.
    assert "expired" not in result
    assert "dashboard" in result


@pytest.mark.asyncio
async def test_approval_prompt_shows_three_button_options(service, mock_bot):
    """Approval prompt InlineKeyboardMarkup must have approve, approve-single, and deny."""
    from telegram import InlineKeyboardMarkup

    service._paired_users = {111}
    approval = {
        "id": "apr-020",
        "persona": "health",
        "client_did": "did:key:z6MkAgent",
        "session": "research",
        "reason": "Store test query",
    }
    await service.send_approval_prompt(approval)

    keyboard = mock_bot.send_message.await_args.kwargs.get("reply_markup")
    assert isinstance(keyboard, InlineKeyboardMarkup)
    buttons = [btn for row in keyboard.inline_keyboard for btn in row]
    callback_data_values = [btn.callback_data for btn in buttons]
    assert any("approve apr-020" in d and "single" not in d for d in callback_data_values)
    assert any("approve-single apr-020" in d for d in callback_data_values)
    assert any("deny apr-020" in d for d in callback_data_values)


# ---------------------------------------------------------------------------
# Callback query handler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_callback_query_approve(service, mock_core):
    """Inline keyboard Approve button calls approve_request and edits the message."""
    update = MagicMock()
    query = MagicMock()
    query.data = "approve apr-cb-001"
    query.answer = AsyncMock()
    query.message = MagicMock()
    query.message.text = "🔐 Agent wants to store in *health*"
    query.message.edit_text = AsyncMock()
    query.message.reply_text = AsyncMock()
    update.callback_query = query
    context, mock_ch = _make_context()

    await service.handle_callback_query(update, context)

    query.answer.assert_awaited_once()
    mock_core.approve_request.assert_awaited_once_with(
        "apr-cb-001", scope="session", granted_by="telegram",
    )
    # Original message edited via channel.
    mock_ch.edit.assert_called_once()
    edited_text = mock_ch.edit.call_args[0][0].text
    assert "✅" in edited_text


@pytest.mark.asyncio
async def test_handle_callback_query_deny(service, mock_core):
    """Inline keyboard Deny button calls deny_request and edits the message."""
    update = MagicMock()
    query = MagicMock()
    query.data = "deny apr-cb-002"
    query.answer = AsyncMock()
    query.message = MagicMock()
    query.message.text = "🔐 Agent wants to store in *health*"
    query.message.edit_text = AsyncMock()
    query.message.reply_text = AsyncMock()
    update.callback_query = query
    context, mock_ch = _make_context()

    await service.handle_callback_query(update, context)

    query.answer.assert_awaited_once()
    mock_core.deny_request.assert_awaited_once_with("apr-cb-002")
    mock_ch.edit.assert_called_once()
    edited_text = mock_ch.edit.call_args[0][0].text
    assert "🚫" in edited_text


@pytest.mark.asyncio
async def test_handle_callback_query_approve_single(service, mock_core):
    """Inline keyboard Approve (once) button calls approve_request with scope=single."""
    update = MagicMock()
    query = MagicMock()
    query.data = "approve-single apr-cb-003"
    query.answer = AsyncMock()
    query.message = MagicMock()
    query.message.text = "🔐 Agent wants to store in *health*"
    query.message.edit_text = AsyncMock()
    query.message.reply_text = AsyncMock()
    update.callback_query = query
    context, mock_ch = _make_context()

    await service.handle_callback_query(update, context)

    mock_core.approve_request.assert_awaited_once_with(
        "apr-cb-003", scope="single", granted_by="telegram",
    )
    mock_ch.edit.assert_called_once()


@pytest.mark.asyncio
async def test_handle_callback_query_no_query(service):
    """handle_callback_query is a no-op when callback_query is None."""
    update = MagicMock()
    update.callback_query = None
    context, _mock_ch = _make_context()

    # Should not raise.
    await service.handle_callback_query(update, context)


@pytest.mark.asyncio
async def test_handle_callback_query_no_data(service):
    """handle_callback_query is a no-op when callback_query.data is None."""
    update = MagicMock()
    query = MagicMock()
    query.data = None
    query.answer = AsyncMock()
    update.callback_query = query
    context, _mock_ch = _make_context()

    await service.handle_callback_query(update, context)

    query.answer.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_callback_query_edit_failure_propagates(service, mock_core):
    """If ch.edit raises, the exception propagates (no silent swallow)."""
    update = MagicMock()
    query = MagicMock()
    query.data = "approve apr-cb-edit-fail"
    query.answer = AsyncMock()
    query.message = MagicMock()
    query.message.text = "original"
    update.callback_query = query
    context, mock_ch = _make_context()
    mock_ch.edit = AsyncMock(side_effect=Exception("message not modified"))

    with pytest.raises(Exception, match="message not modified"):
        await service.handle_callback_query(update, context)

    # Approve still went through before the edit failed.
    mock_core.approve_request.assert_awaited_once()
