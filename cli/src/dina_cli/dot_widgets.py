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

import sys
from importlib import resources
from typing import Any

from fastmcp.server.middleware import Middleware

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


class HostUiProbe(Middleware):
    """Logs whether a connecting host says it can draw MCP Apps UI.

    MCP Apps is negotiated: a host that draws widgets declares the
    ``io.modelcontextprotocol/ui`` extension when it connects. A dot reported
    "The widget is unavailable" (2026-10-25); this says, per connection,
    which host connected and whether it offered UI, and when it reads
    Dina's page. Metadata only: the host's name and capability keys, never
    a message.
    """

    async def on_initialize(self, context, call_next):
        params = getattr(context.message, "params", None)
        info = getattr(params, "clientInfo", None)
        caps = getattr(params, "capabilities", None)
        dumped = caps.model_dump(exclude_none=True) if caps is not None else {}
        extensions = dumped.get("extensions") or {}
        experimental = dumped.get("experimental") or {}
        print(
            "dot-ui-probe initialize client=%s/%s capability_keys=%s extensions=%s experimental=%s"
            % (
                getattr(info, "name", "?"),
                getattr(info, "version", "?"),
                sorted(dumped.keys()),
                sorted(extensions.keys()) if isinstance(extensions, dict) else "?",
                sorted(experimental.keys()) if isinstance(experimental, dict) else "?",
            ),
            file=sys.stderr,
            flush=True,
        )
        return await call_next(context)

    async def on_list_resources(self, context, call_next):
        print("dot-ui-probe resources/list", file=sys.stderr, flush=True)
        return await call_next(context)

    async def on_read_resource(self, context, call_next):
        message = context.message
        uri = str(getattr(message, "uri", None) or getattr(getattr(message, "params", None), "uri", ""))
        print("dot-ui-probe resources/read uri=%s" % uri[:80], file=sys.stderr, flush=True)
        return await call_next(context)
