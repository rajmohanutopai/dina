"""Channel protocol — transport-agnostic message delivery.

Handlers receive a Channel and call ``send()`` to deliver responses.
Each channel implementation renders the response in its native format
and appends cross-cutting metadata (req_id).

Implementations:
    TelegramChannel — reply_text + inline keyboards
    BlueskyChannel  — post/DM replies (to build)
    CLIChannel      — stdout (future)
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..domain.response import BotResponse


@runtime_checkable
class Channel(Protocol):
    """Protocol for sending responses to a user."""

    @property
    def req_id(self) -> str:
        """The request ID for this interaction."""
        ...

    async def send(self, response: BotResponse) -> None:
        """Render and deliver a response."""
        ...

    async def edit(self, response: BotResponse) -> None:
        """Update a previously sent response (e.g., after confirmation).

        Channels that don't support editing (CLI, Bluesky) should
        send a new message instead.
        """
        ...
