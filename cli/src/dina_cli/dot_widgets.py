"""Dina's cards in a ChatGPT dot (HOSTED_DINA §6.4).

ChatGPT draws a tool's UI from an MCP Apps resource: the tool names a
``ui://`` page in ``_meta.ui.resourceUri`` and puts its data in the result's
structured content. Dina has one page, ``card-v1.html``, which draws a
CardSpec — the same fixed block vocabulary the phone app draws
(``packages/protocol/src/services/card-spec.ts``). Core builds the card
(``packages/core/src/client/tender_card.ts``, the builder the phone and the
owner's page use too), so a tender reads the same everywhere. The text
answer stays beside it, for the model and for Slack or Teams.

The URI carries its version: hosts cache by URI, so a breaking change to
the page ships as ``card-v2.html``.
"""

from __future__ import annotations

from importlib import resources
from typing import Any

CARD_URI = "ui://dina/card-v1.html"
MCP_APP_MIME = "text/html;profile=mcp-app"

#: Tool metadata naming the card: the MCP Apps field, and ChatGPT's alias.
CARD_TOOL_META: dict[str, Any] = {
    "ui": {"resourceUri": CARD_URI},
    "openai/outputTemplate": CARD_URI,
}


def card_html() -> str:
    """The page, shipped inside the package."""
    return resources.files("dina_cli").joinpath("widgets/card-v1.html").read_text("utf-8")
