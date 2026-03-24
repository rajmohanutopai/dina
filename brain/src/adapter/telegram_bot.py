"""Telegram Bot API adapter — wraps ``python-telegram-bot`` v22.x.

The adapter owns the transport lifecycle (polling start/stop, message
sending) but contains NO business logic.  Message handling is delegated
to callback functions provided by the service layer at construction time.

Only imported in ``src/main.py`` (composition root) when
``DINA_TELEGRAM_TOKEN`` is set.  If ``python-telegram-bot`` is not
installed the import will raise ``ImportError``, caught gracefully in
the composition root.

Third-party imports:  python-telegram-bot (telegram, telegram.ext).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine

from telegram import Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ..domain.errors import TelegramError

log = logging.getLogger(__name__)

# Type alias for handler callbacks matching python-telegram-bot's signature.
HandlerCallback = Callable[
    [Update, ContextTypes.DEFAULT_TYPE],
    Coroutine[Any, Any, None],
]


class TelegramBotAdapter:
    """Adapter wrapping python-telegram-bot's Application.

    Registers command and message handlers at construction, then manages
    the long-polling lifecycle via ``start()`` / ``stop()``.

    Parameters
    ----------
    bot_token:
        Telegram Bot API token from BotFather.
    message_callback:
        Async callback for incoming text messages (non-command).
    command_callbacks:
        Mapping of command name → async callback (e.g. ``{"start": fn}``).
    """

    def __init__(
        self,
        bot_token: str,
        message_callback: HandlerCallback,
        command_callbacks: dict[str, HandlerCallback] | None = None,
        callback_query_handler: HandlerCallback | None = None,
    ) -> None:
        self._app: Application = (  # type: ignore[type-arg]
            Application.builder().token(bot_token).build()
        )
        self._bot_username: str = ""

        # Register command handlers (e.g. /start, /help).
        for cmd, cb in (command_callbacks or {}).items():
            self._app.add_handler(CommandHandler(cmd, cb))

        # Inline keyboard button callback handler.
        if callback_query_handler:
            self._app.add_handler(CallbackQueryHandler(callback_query_handler))

        # Catch-all text message handler (after commands).
        self._app.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, message_callback)
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Initialise the bot, cache username, and start long polling.

        Raises ``TelegramError`` if the bot token is invalid.
        """
        try:
            await self._app.initialize()
            bot_info = await self._app.bot.get_me()
            self._bot_username = bot_info.username or ""
            log.info(
                "telegram.adapter.started",
                extra={"bot_username": self._bot_username},
            )
            await self._app.start()
            await self._app.updater.start_polling(  # type: ignore[union-attr]
                drop_pending_updates=True,
            )
        except Exception as exc:
            raise TelegramError(f"Failed to start Telegram bot: {exc}") from exc

    async def stop(self) -> None:
        """Stop polling and shut down the application."""
        try:
            if self._app.updater and self._app.updater.running:
                await self._app.updater.stop()
            if self._app.running:
                await self._app.stop()
            await self._app.shutdown()
            log.info("telegram.adapter.stopped")
        except Exception as exc:
            log.warning(
                "telegram.adapter.stop_error",
                extra={"error": str(exc)},
            )

    # ------------------------------------------------------------------
    # Messaging
    # ------------------------------------------------------------------

    async def send_message(
        self, chat_id: int, text: str, **kwargs: object
    ) -> None:
        """Send a text message to a Telegram chat.

        Parameters
        ----------
        chat_id:
            The Telegram chat ID.
        text:
            Message text (supports Markdown if ``parse_mode="Markdown"``
            is passed in kwargs).
        **kwargs:
            Extra parameters forwarded to ``Bot.send_message``
            (e.g. ``parse_mode``, ``reply_to_message_id``).
        """
        try:
            await self._app.bot.send_message(
                chat_id=chat_id, text=text, **kwargs
            )
        except Exception as exc:
            raise TelegramError(
                f"Failed to send message to {chat_id}: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def bot_username(self) -> str:
        """The bot's Telegram username (without @), cached after start()."""
        return self._bot_username
