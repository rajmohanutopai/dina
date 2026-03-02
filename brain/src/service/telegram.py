"""Telegram message handling — access control, Guardian routing, vault storage.

Provides callback functions that the ``TelegramBotAdapter`` registers as
handlers.  All business logic lives here; the adapter is a thin transport.

Access control model:
    - **DM pairing**: A user must be in ``allowed_user_ids`` (config) to
      pair via ``/start``.  Once paired, their Telegram user ID is persisted
      to Core KV and survives restarts.
    - **Group allowlist**: Group messages are processed only if the group's
      chat ID is in ``allowed_group_ids`` AND the message @-mentions the bot.

Message flow (DM):
    1. ``python-telegram-bot`` dispatches update → ``handle_message()``
    2. Access control check (allowed + paired).
    3. Pass to Guardian as ``{"type": "reason", "prompt": <text>, ...}``.
    4. Guardian returns response → ``reply_text()``.
    5. Store exchange in vault for memory/context.

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from telegram import Update
from telegram.ext import ContextTypes

from ..port.core_client import CoreClient

log = logging.getLogger(__name__)

# Core KV key for persisting paired Telegram user IDs.
_KV_PAIRED_USERS = "telegram_paired_users"


class TelegramService:
    """Orchestrates Telegram message handling, access control, and vault storage.

    Parameters
    ----------
    guardian:
        GuardianLoop instance for event processing and reasoning.
    core:
        Typed HTTP client for dina-core (vault storage, KV).
    allowed_user_ids:
        Set of Telegram user IDs allowed to pair via /start.
    allowed_group_ids:
        Set of Telegram group chat IDs where the bot responds.
    """

    def __init__(
        self,
        guardian: Any,  # GuardianLoop — Any to avoid circular import
        core: CoreClient,
        allowed_user_ids: set[int] | None = None,
        allowed_group_ids: set[int] | None = None,
    ) -> None:
        self._guardian = guardian
        self._core = core
        self._allowed_users: set[int] = allowed_user_ids or set()
        self._allowed_groups: set[int] = allowed_group_ids or set()
        self._paired_users: set[int] = set()
        self._bot: Any = None  # Set via set_bot() after construction

    def set_bot(self, bot: Any) -> None:
        """Inject the bot adapter reference (for outbound nudges).

        Called by the composition root after both service and adapter
        are constructed.
        """
        self._bot = bot

    # ------------------------------------------------------------------
    # Startup
    # ------------------------------------------------------------------

    async def load_paired_users(self) -> None:
        """Load previously paired users from Core KV.

        Called once at startup before polling begins.  If KV is empty
        or unreachable, starts with an empty set (safe default).
        """
        try:
            raw = await self._core.get_kv(_KV_PAIRED_USERS)
            if raw:
                user_ids = json.loads(raw)
                self._paired_users = {int(uid) for uid in user_ids}
                log.info(
                    "telegram.paired_users.loaded",
                    extra={"count": len(self._paired_users)},
                )
        except Exception as exc:
            log.warning(
                "telegram.paired_users.load_failed",
                extra={"error": str(exc)},
            )

    # ------------------------------------------------------------------
    # Command handlers
    # ------------------------------------------------------------------

    async def handle_start(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /start command — user pairing flow.

        If the user's Telegram ID is in ``allowed_user_ids``, they are
        paired and welcomed.  Otherwise, a polite rejection is sent.
        """
        if not update.effective_user or not update.effective_chat:
            return

        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        username = update.effective_user.username or str(user_id)

        if user_id in self._paired_users:
            await update.message.reply_text(  # type: ignore[union-attr]
                "You're already paired. Send me a message and I'll help."
            )
            return

        if user_id not in self._allowed_users:
            log.info(
                "telegram.start.rejected",
                extra={"user_id": user_id, "username": username},
            )
            await update.message.reply_text(  # type: ignore[union-attr]
                "Sorry, I can only chat with my owner. "
                "Ask them to add your Telegram user ID to the allowed list."
            )
            return

        # Pair the user.
        await self._pair_user(user_id, chat_id)
        log.info(
            "telegram.start.paired",
            extra={"user_id": user_id, "username": username},
        )
        await update.message.reply_text(  # type: ignore[union-attr]
            "Welcome! You're now paired with Dina. "
            "Send me any message and I'll think about it."
        )

    # ------------------------------------------------------------------
    # Message handler
    # ------------------------------------------------------------------

    async def handle_message(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle incoming text messages (non-command).

        DM messages from paired users are forwarded to Guardian.
        Group messages are only processed if the group is in the
        allowlist and the message @-mentions the bot.
        """
        if not update.effective_user or not update.effective_chat:
            return
        if not update.message or not update.message.text:
            return

        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type
        text = update.message.text

        # --- Group message handling ---
        if chat_type in ("group", "supergroup"):
            if not self._is_allowed_group(chat_id):
                return
            if not self._is_bot_mentioned(text):
                return
            # Strip the @mention from the text before processing.
            text = self._strip_mention(text)

        # --- DM handling ---
        elif chat_type == "private":
            if not self._is_allowed_user(user_id):
                await update.message.reply_text(
                    "I don't recognise you yet. Send /start to pair."
                )
                return

        # --- Process via Guardian ---
        try:
            result = await self._guardian.process_event({
                "type": "reason",
                "prompt": text,
                "persona_id": "default",
                "source": "telegram",
                "chat_id": chat_id,
                "user_id": user_id,
            })

            response_text = self._extract_response(result)
            if response_text:
                await update.message.reply_text(response_text)

        except Exception as exc:
            log.error(
                "telegram.process_failed",
                extra={"error": type(exc).__name__, "chat_id": chat_id},
            )
            await update.message.reply_text(
                "Something went wrong processing your message. Please try again."
            )

        # --- Store in vault for memory ---
        await self._store_message(update, text)

    # ------------------------------------------------------------------
    # Outbound nudge
    # ------------------------------------------------------------------

    async def send_nudge(self, chat_id: int, text: str) -> None:
        """Send a nudge/notification to a Telegram chat.

        Used by other services (e.g. reminder system) to push messages
        to a paired user's Telegram chat.
        """
        if self._bot:
            await self._bot.send_message(chat_id, text)

    # ------------------------------------------------------------------
    # Access control
    # ------------------------------------------------------------------

    def _is_allowed_user(self, user_id: int) -> bool:
        """Check if a user is allowed (configured) or already paired."""
        return user_id in self._allowed_users or user_id in self._paired_users

    def _is_allowed_group(self, chat_id: int) -> bool:
        """Check if a group chat is in the allowlist."""
        return chat_id in self._allowed_groups

    def _is_bot_mentioned(self, text: str) -> bool:
        """Check if the bot is @-mentioned in the text."""
        if not self._bot:
            return False
        bot_username = self._bot.bot_username
        if not bot_username:
            return False
        return f"@{bot_username}" in text

    def _strip_mention(self, text: str) -> str:
        """Remove the @bot_username mention from text."""
        if self._bot and self._bot.bot_username:
            text = text.replace(f"@{self._bot.bot_username}", "").strip()
        return text

    # ------------------------------------------------------------------
    # Pairing persistence
    # ------------------------------------------------------------------

    async def _pair_user(self, user_id: int, chat_id: int) -> None:
        """Persist a paired user to the in-memory set and Core KV."""
        self._paired_users.add(user_id)
        try:
            await self._core.set_kv(
                _KV_PAIRED_USERS,
                json.dumps(sorted(self._paired_users)),
            )
        except Exception as exc:
            log.warning(
                "telegram.pair.persist_failed",
                extra={"user_id": user_id, "error": str(exc)},
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_response(result: dict) -> str:
        """Extract the human-readable response from a Guardian result."""
        # Guardian returns different shapes depending on event type.
        # For "reason" events: {"action": ..., "response": str | dict}
        response = result.get("response", "")
        if isinstance(response, dict):
            return response.get("text", response.get("answer", str(response)))
        return str(response) if response else ""

    async def _store_message(self, update: Update, text: str) -> None:
        """Store the message exchange in vault for memory/context."""
        if not update.effective_user:
            return
        try:
            await self._core.store_vault_item("default", {
                "type": "message",
                "source": "telegram",
                "source_id": f"tg_{update.update_id}",
                "summary": text[:200],
                "body_text": text,
                "sender": str(update.effective_user.id),
                "timestamp": int(time.time()),
            })
        except Exception as exc:
            log.debug(
                "telegram.store_failed",
                extra={"error": str(exc)},
            )
