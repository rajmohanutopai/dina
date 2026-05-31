"""Port interface for Telegram Bot communication.

Implementations live in ``src/adapter/``.  The service layer depends
only on this protocol — never on the concrete adapter.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class TelegramBot(Protocol):
    """Async interface for a Telegram Bot transport.

    The adapter wraps a Telegram Bot API library and exposes a minimal
    surface for the service layer: send messages, start/stop polling,
    and read the bot's username (for @mention gating in groups).
    """

    async def send_message(self, chat_id: int, text: str, **kwargs: object) -> None:
        """Send a text message to a Telegram chat.

        Parameters:
            chat_id: The Telegram chat ID to send to.
            text:    The message text.
            **kwargs: Optional parameters (parse_mode, reply_to_message_id, etc.).
        """
        ...

    async def start(self) -> None:
        """Initialise the bot and begin long-polling for updates."""
        ...

    async def stop(self) -> None:
        """Stop polling and release resources."""
        ...

    @property
    def bot_username(self) -> str:
        """The bot's Telegram username (without @), cached after start()."""
        ...
