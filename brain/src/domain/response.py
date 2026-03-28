"""Transport-agnostic response types for user-facing commands.

Every handler returns one or more BotResponse objects. Channel
renderers (Telegram, Bluesky, CLI) know how to display each type.

Response types carry STRUCTURED DATA, not formatted strings.
Each channel's renderer decides how to format for its transport.

Formatting hints:
    TextFormat.BOLD     → Telegram: *bold*, Bluesky: facet, CLI: CAPS
    TextFormat.CODE     → Telegram: `code`, Bluesky: code facet, CLI: as-is
    TextFormat.ITALIC   → Telegram: _italic_, Bluesky: italic facet, CLI: as-is
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class TextFormat(Enum):
    """Formatting hints — each channel renders these natively."""
    PLAIN = "plain"
    RICH = "rich"       # channel applies its native rich text


@dataclass
class BotResponse:
    """Base response from any command handler."""
    text: str
    format: TextFormat = TextFormat.PLAIN


@dataclass
class RichResponse(BotResponse):
    """Response with structured formatting (bold, code spans)."""
    format: TextFormat = TextFormat.RICH


@dataclass
class ConfirmResponse(BotResponse):
    """Response requiring user confirmation."""
    format: TextFormat = TextFormat.RICH
    options: list[ConfirmOption] = field(default_factory=list)


@dataclass
class ConfirmOption:
    """A confirmation option — transport-agnostic."""
    label: str              # "Publish", "Cancel"
    action: str             # "confirm", "cancel"
    data: dict = field(default_factory=dict)  # opaque payload for callback


@dataclass
class StatusResponse(BotResponse):
    """Node status — structured, not formatted."""
    did: str = ""
    status: str = ""
    version: str = ""


@dataclass
class ContactListResponse(BotResponse):
    """Contact list — structured data."""
    contacts: list[dict] = field(default_factory=list)


@dataclass
class TrustScoreResponse(BotResponse):
    """Trust score query result."""
    display_name: str = ""
    did: str = ""
    score: Any = None
    total_attestations: int = 0
    positive_attestations: int = 0
    vouch_count: int = 0


@dataclass
class SendResponse(BotResponse):
    """D2D message sent confirmation."""
    contact: str = ""
    message_type: str = ""
    message_text: str = ""


@dataclass
class ErrorResponse(BotResponse):
    """Error response."""
    pass
