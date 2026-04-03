"""Multi-channel parity and resilience tests.

Prevents regressions where features work on one channel (Telegram)
but break on another (Bluesky).  Validates that the shared
CommandDispatcher, channel-specific parsers, push notifications,
and wiring logic all behave consistently across transports.

Test coverage:
    - CommandDispatcher routes /remember correctly (not "Unknown command")
    - Bluesky parser extracts /remember, /delete, /edit args
    - Bluesky confirmation flow: only "publish" triggers, not "yes"
    - _push_notification sends to both Telegram and Bluesky
    - Notification works when only one channel is configured
    - Unknown commands show help text (Telegram)
    - Markdown fallback on parse error (TelegramChannel)
    - PDS publisher wiring is independent of Telegram token
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.domain.request import Command, CommandRequest
from src.domain.response import (
    BotResponse,
    ErrorResponse,
    RichResponse,
)
from src.service.command_dispatcher import CommandDispatcher
from src.service.user_commands import UserCommandService
from src.adapter.bluesky_bot import parse_bluesky_command


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_core():
    """Mock CoreClient with staging stubs."""
    core = AsyncMock()
    core.staging_ingest = AsyncMock(return_value="stg-001")
    core.staging_status = AsyncMock(return_value={
        "status": "stored",
        "persona": "general",
    })
    core.get_kv = AsyncMock(return_value=None)
    core.set_kv = AsyncMock()
    core._request = AsyncMock()
    core.list_contacts = AsyncMock(return_value=[])
    core.store_reminder = AsyncMock()
    return core


@pytest.fixture
def mock_guardian():
    """Mock GuardianLoop with an LLM stub."""
    guardian = AsyncMock()
    guardian.process_event = AsyncMock(return_value={
        "content": "Noted.",
    })
    guardian._llm = AsyncMock()
    guardian._llm.route = AsyncMock(return_value={"content": "{}"})
    return guardian


@pytest.fixture
def user_commands(mock_core):
    """UserCommandService backed by mock core."""
    return UserCommandService(core=mock_core)


@pytest.fixture
def dispatcher(user_commands, mock_guardian):
    """CommandDispatcher wired to mocks."""
    return CommandDispatcher(
        user_commands=user_commands,
        guardian=mock_guardian,
    )


# ---------------------------------------------------------------------------
# 1. CommandDispatcher handles /remember
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0830", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "01", "scenario": "01", "title": "dispatcher_handles_remember"}
@pytest.mark.asyncio
async def test_dispatcher_handles_remember(dispatcher, mock_core):
    """CommandDispatcher routes REMEMBER via dispatch table, not ErrorResponse."""
    req = CommandRequest(
        command=Command.REMEMBER,
        args={"text": "test"},
        source="bluesky",
    )
    resp = await dispatcher.dispatch(req)

    # Must NOT be the "Unknown command" error.
    assert not isinstance(resp, ErrorResponse), (
        f"Dispatcher returned ErrorResponse for REMEMBER: {resp.text}"
    )
    # Staging ingest should have been called.
    mock_core.staging_ingest.assert_awaited_once()


# ---------------------------------------------------------------------------
# 2. Bluesky parser extracts /remember text
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0831", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "01", "scenario": "02", "title": "bluesky_parser_remember"}
def test_bluesky_parser_remember():
    """parse_bluesky_command extracts REMEMBER with full text."""
    result = parse_bluesky_command("/remember Sancho loves tea")

    assert result is not None
    assert result.command == Command.REMEMBER
    assert result.args["text"] == "Sancho loves tea"
    assert result.source == "bluesky"


# ---------------------------------------------------------------------------
# 3. Bluesky parser extracts /delete id
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0832", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "01", "scenario": "03", "title": "bluesky_parser_delete"}
def test_bluesky_parser_delete():
    """parse_bluesky_command extracts REMINDER_DELETE with short ID."""
    result = parse_bluesky_command("/delete abc1")

    assert result is not None
    assert result.command == Command.REMINDER_DELETE
    assert result.args["id"] == "abc1"


# ---------------------------------------------------------------------------
# 4. Bluesky parser extracts /edit id text
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0833", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "01", "scenario": "04", "title": "bluesky_parser_edit"}
def test_bluesky_parser_edit():
    """parse_bluesky_command extracts REMINDER_EDIT with id and text."""
    result = parse_bluesky_command("/edit abc1 Tomorrow 3pm — New msg")

    assert result is not None
    assert result.command == Command.REMINDER_EDIT
    assert result.args["id"] == "abc1"
    assert result.args["text"] == "Tomorrow 3pm — New msg"


# ---------------------------------------------------------------------------
# 5. Bluesky confirmation only on "Publish"
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0834", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "02", "scenario": "01", "title": "bluesky_confirm_publish_only"}
@pytest.mark.asyncio
async def test_bluesky_confirm_publish_only():
    """Only exact 'publish' triggers confirmation, not 'yes' or 'confirm'.

    The BlueskyBotAdapter._handle_dm checks for lower == "publish" when
    _pending_trust is set.  'yes' and 'confirm' should be treated as
    regular messages (routed to ASK), not confirmations.
    """
    from src.adapter.bluesky_bot import BlueskyBotAdapter

    mock_client = AsyncMock()
    mock_client.did = "did:plc:test123"
    mock_client.handle = "test.bsky.social"
    mock_client.send_dm = AsyncMock()

    mock_dispatcher = AsyncMock(spec=CommandDispatcher)
    mock_dispatcher._pending_trust = {"cmd": "vouch", "name": "Alice", "text": "Great"}
    mock_dispatcher.dispatch = AsyncMock(return_value=BotResponse(text="OK"))
    mock_dispatcher.handle_trust_confirm = AsyncMock(return_value=BotResponse(text="Published!"))

    adapter = BlueskyBotAdapter(mock_client, mock_dispatcher, owner_did="did:plc:owner")

    # "publish" should trigger confirmation.
    await adapter._handle_dm("convo1", "publish", "did:plc:owner", "msg1")
    mock_dispatcher.handle_trust_confirm.assert_awaited_once_with(True)

    mock_dispatcher.handle_trust_confirm.reset_mock()

    # "yes" should NOT trigger confirmation — it goes to dispatch.
    await adapter._handle_dm("convo2", "yes", "did:plc:owner", "msg2")
    mock_dispatcher.handle_trust_confirm.assert_not_awaited()
    mock_dispatcher.dispatch.assert_awaited()


# ---------------------------------------------------------------------------
# 6. _push_notification sends to both channels
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0835", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "03", "scenario": "01", "title": "push_notification_both_channels"}
@pytest.mark.asyncio
async def test_push_notification_both_channels():
    """_push_notification sends to both Telegram and Bluesky when both are set."""
    from src.service.guardian import GuardianLoop

    guardian = GuardianLoop(
        core=AsyncMock(),
        llm_router=AsyncMock(),
        scrubber=None,
        entity_vault=AsyncMock(),
        nudge_assembler=AsyncMock(),
        scratchpad=AsyncMock(),
    )

    # Wire mock Telegram service.
    mock_telegram = MagicMock()
    mock_telegram._paired_users = {12345}
    mock_telegram.load_paired_users = AsyncMock()
    mock_telegram._bot = AsyncMock()
    mock_telegram._bot.send_message = AsyncMock()
    guardian._telegram = mock_telegram

    # Wire mock Bluesky bot adapter.
    mock_bluesky = AsyncMock()
    mock_bluesky.send_owner_dm = AsyncMock()
    guardian._bluesky = mock_bluesky

    await guardian._push_notification("Test notification", "test")

    # Both channels should receive the message.
    mock_telegram._bot.send_message.assert_awaited_once_with(12345, "Test notification")
    mock_bluesky.send_owner_dm.assert_awaited_once_with("Test notification")


# ---------------------------------------------------------------------------
# 7. Notification not gated on Telegram only
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0836", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "03", "scenario": "02", "title": "notification_bluesky_without_telegram"}
@pytest.mark.asyncio
async def test_notification_bluesky_without_telegram():
    """When Telegram is None but Bluesky is set, notification still reaches Bluesky."""
    from src.service.guardian import GuardianLoop

    guardian = GuardianLoop(
        core=AsyncMock(),
        llm_router=AsyncMock(),
        scrubber=None,
        entity_vault=AsyncMock(),
        nudge_assembler=AsyncMock(),
        scratchpad=AsyncMock(),
    )

    # No Telegram.
    guardian._telegram = None

    # Wire Bluesky only.
    mock_bluesky = AsyncMock()
    mock_bluesky.send_owner_dm = AsyncMock()
    guardian._bluesky = mock_bluesky

    await guardian._push_notification("Bluesky-only notification", "test")

    # Bluesky should receive the message despite no Telegram.
    mock_bluesky.send_owner_dm.assert_awaited_once_with("Bluesky-only notification")


# ---------------------------------------------------------------------------
# 8. Unknown command shows help
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0837", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "04", "scenario": "01", "title": "unknown_command_shows_help"}
@pytest.mark.asyncio
async def test_unknown_command_shows_help():
    """Unrecognized text via Telegram handle_message returns help, not silence."""
    from src.service.telegram import TelegramService

    mock_core = AsyncMock()
    mock_core.get_kv = AsyncMock(return_value=None)
    mock_core.set_kv = AsyncMock()

    mock_guardian = AsyncMock()

    svc = TelegramService(
        guardian=mock_guardian,
        core=mock_core,
        allowed_user_ids={42},
    )
    svc._paired_users = {42}

    # Build a mock Update that looks like a private DM with an unrecognized message.
    update = MagicMock()
    update.effective_user.id = 42
    update.effective_chat.id = 42
    update.effective_chat.type = "private"
    update.message.text = "/foobar some unknown command"

    # Mock context and channel.
    mock_channel = AsyncMock()
    context = MagicMock()
    context.user_data = {"channel": mock_channel}

    # The handle_approval_response should return None (not an approval).
    svc.handle_approval_response = AsyncMock(return_value=None)

    await svc.handle_message(update, context)

    # Channel should have been called with help text (RichResponse).
    mock_channel.send.assert_awaited_once()
    sent_response = mock_channel.send.call_args[0][0]
    assert isinstance(sent_response, RichResponse)
    assert "/ask" in sent_response.text
    assert "/remember" in sent_response.text


# ---------------------------------------------------------------------------
# 9. Markdown fallback on parse error
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0838", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "04", "scenario": "02", "title": "markdown_fallback_on_parse_error"}
@pytest.mark.asyncio
async def test_markdown_fallback_on_parse_error():
    """TelegramChannel._send_text retries as plain text when Markdown fails."""
    from src.adapter.telegram_channel import TelegramChannel

    mock_message = AsyncMock()
    # First call with Markdown raises (simulating unbalanced *).
    # Second call (plain text) succeeds.
    call_count = 0

    async def _reply_text_side_effect(text, **kwargs):
        nonlocal call_count
        call_count += 1
        if kwargs.get("parse_mode") == "Markdown":
            raise Exception("Can't parse entities: unbalanced *")

    mock_message.reply_text = AsyncMock(side_effect=_reply_text_side_effect)

    channel = TelegramChannel(mock_message, req_id="r1")

    # Text with unbalanced Markdown (bad bold).
    await channel._send_text("Hello *world", markdown=True)

    # Should have been called twice: once with Markdown, once plain.
    assert mock_message.reply_text.await_count == 2
    first_call_kwargs = mock_message.reply_text.call_args_list[0].kwargs
    second_call_kwargs = mock_message.reply_text.call_args_list[1].kwargs
    assert first_call_kwargs.get("parse_mode") == "Markdown"
    assert "parse_mode" not in second_call_kwargs


# ---------------------------------------------------------------------------
# 10. PDS publisher works without Telegram
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0839", "section": "25", "sectionName": "Channel Parity & Resilience", "subsection": "05", "scenario": "01", "title": "pds_publisher_without_telegram"}
def test_pds_publisher_without_telegram():
    """PDS publisher is created even when telegram_token is empty.

    Verifies the main.py wiring logic: PDS publisher construction is
    gated only on DINA_PDS_URL / DINA_PDS_HANDLE / DINA_PDS_ADMIN_PASSWORD,
    not on cfg.telegram_token.  This is a structural test that reads the
    source file directly (avoids importing main.py which requires all
    adapters and env vars at module scope).
    """
    from pathlib import Path

    main_py = Path(__file__).resolve().parents[1] / "src" / "main.py"
    source = main_py.read_text()

    # The PDS publisher block must not be nested inside the telegram_token
    # conditional.  We verify that "pds_publisher_instance = PDSPublisher"
    # appears AFTER the telegram block closes and at the same indent level
    # (i.e., not nested inside it).
    lines = source.split("\n")

    telegram_block_start = None
    telegram_indent = 0
    pds_conditional_start = None
    pds_conditional_indent = 0

    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if "if cfg.telegram_token:" in line or "if cfg.telegram_token" in line:
            telegram_block_start = i
            telegram_indent = len(line) - len(stripped)
        # Find the PDS conditional: "if pds_url and pds_handle and pds_password:"
        if "pds_url" in line and "pds_handle" in line and "pds_password" in line and stripped.startswith("if "):
            pds_conditional_start = i
            pds_conditional_indent = len(line) - len(stripped)

    assert telegram_block_start is not None, (
        "Could not find 'if cfg.telegram_token' in main.py"
    )
    assert pds_conditional_start is not None, (
        "Could not find PDS conditional 'if pds_url and pds_handle...' in main.py"
    )
    # PDS publisher conditional should appear after the telegram block.
    assert pds_conditional_start > telegram_block_start, (
        "PDS publisher conditional must appear after the Telegram block in create_app"
    )
    # The PDS conditional should be at the same indent as the telegram
    # conditional (both are top-level within create_app), not nested inside it.
    assert pds_conditional_indent == telegram_indent, (
        f"PDS conditional (indent={pds_conditional_indent}) should be at the same "
        f"level as Telegram block (indent={telegram_indent}) — not nested inside it"
    )
