"""Transport-agnostic command request types.

Every adapter (Telegram, Bluesky, CLI) parses its native input into
a CommandRequest. The CommandDispatcher routes it to the appropriate
UserCommandService method and returns a BotResponse.

Adapters never contain business logic — they only parse and render.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Command(Enum):
    """Known command types."""
    ASK = "ask"
    REMEMBER = "remember"
    SEND = "send"
    STATUS = "status"
    CONTACT_ADD = "contact_add"
    CONTACT_DELETE = "contact_delete"
    CONTACT_LIST = "contact_list"
    CONTACT_CLEANUP = "contact_cleanup"
    REVIEW = "review"
    VOUCH = "vouch"
    FLAG = "flag"
    TRUST = "trust"
    REMINDER_DELETE = "reminder_delete"
    REMINDER_EDIT = "reminder_edit"
    HELP = "help"


@dataclass
class CommandRequest:
    """Parsed command from any transport."""
    command: Command
    args: dict = field(default_factory=dict)
    source: str = ""        # "telegram", "bluesky", "cli", "web"
    user_id: str = ""       # transport-specific user ID
    raw_text: str = ""      # original unparsed text
