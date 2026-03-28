"""Bluesky channel — renders BotResponse types as Bluesky posts/DMs.

Each response type gets Bluesky-native formatting:
- StatusResponse → plain text post with DID
- ConfirmResponse → text with "Reply YES to confirm, NO to cancel"
- ContactListResponse → formatted text list
- etc.

Appends ``[req_id]`` to every message for log correlation.
"""

from __future__ import annotations

import logging
from typing import Any

from ..domain.response import (
    BotResponse,
    ConfirmResponse,
    ContactListResponse,
    ErrorResponse,
    SendResponse,
    StatusResponse,
    TextFormat,
    TrustScoreResponse,
)

log = logging.getLogger(__name__)


class BlueskyChannel:
    """Delivers BotResponse objects via Bluesky post replies or DMs.

    Parameters
    ----------
    client:
        BlueskyClient instance for API calls.
    reply_ref:
        For post replies: {"root": {...}, "parent": {...}} AT Protocol reply ref.
        None for DMs.
    convo_id:
        For DMs: the conversation ID. None for post replies.
    req_id:
        Request ID for log correlation.
    """

    def __init__(
        self,
        client: Any,  # BlueskyClient
        reply_ref: dict | None = None,
        convo_id: str | None = None,
        req_id: str = "",
    ) -> None:
        self._client = client
        self._reply_ref = reply_ref
        self._convo_id = convo_id
        self._req_id = req_id

    @property
    def req_id(self) -> str:
        return self._req_id

    def _append_req_id(self, text: str) -> str:
        if self._req_id:
            return f"{text}\n[{self._req_id}]"
        return text

    async def send(self, response: BotResponse) -> None:
        """Render and send a BotResponse via Bluesky."""
        if isinstance(response, StatusResponse):
            text = self._render_status(response)
        elif isinstance(response, ContactListResponse):
            text = self._render_contact_list(response)
        elif isinstance(response, TrustScoreResponse):
            text = self._render_trust_score(response)
        elif isinstance(response, SendResponse):
            text = self._render_send(response)
        elif isinstance(response, ConfirmResponse):
            text = self._render_confirm(response)
        elif isinstance(response, ErrorResponse):
            text = self._append_req_id(response.text)
        else:
            text = self._append_req_id(response.text)

        # Bluesky post limit is 300 chars (graphemes). Truncate if needed.
        if len(text) > 290:
            text = text[:287] + "..."

        await self._deliver(text)

    async def edit(self, response: BotResponse) -> None:
        """Bluesky doesn't support editing. Send a new message instead."""
        await self.send(response)

    async def _deliver(self, text: str) -> None:
        """Send via DM or post reply depending on context."""
        try:
            if self._convo_id:
                await self._client.send_dm(self._convo_id, text)
            elif self._reply_ref:
                await self._client.reply_post(text, self._reply_ref)
            else:
                log.warning("bluesky_channel.no_delivery_target")
        except Exception as exc:
            log.warning("bluesky_channel.send_failed", extra={"error": str(exc)})

    # ── Renderers ──────────────────────────────────────────────────

    def _render_status(self, r: StatusResponse) -> str:
        return self._append_req_id(
            f"Your Dina\n"
            f"DID: {r.did}\n"
            f"Status: {r.status}\n"
            f"Version: {r.version}"
        )

    def _render_contact_list(self, r: ContactListResponse) -> str:
        if not r.contacts:
            return self._append_req_id("No contacts.")
        lines = []
        for c in r.contacts:
            name = c.get("display_name", "") or c.get("name", "?")
            did = c.get("did", "?")[:30]
            lines.append(f"  {name} — {did}...")
        return self._append_req_id(f"Contacts ({len(r.contacts)}):\n" + "\n".join(lines))

    def _render_trust_score(self, r: TrustScoreResponse) -> str:
        return self._append_req_id(
            f"Trust: {r.display_name}\n"
            f"Score: {r.score}\n"
            f"Attestations: {r.total_attestations} ({r.positive_attestations} positive)\n"
            f"Vouches: {r.vouch_count}"
        )

    def _render_send(self, r: SendResponse) -> str:
        return self._append_req_id(
            f"Sent to {r.contact}: {r.message_type}\n{r.message_text}"
        )

    def _render_confirm(self, r: ConfirmResponse) -> str:
        # Bluesky has no inline buttons. Use text-based confirmation.
        options = " / ".join(opt.label for opt in r.options) if r.options else "YES / NO"
        return self._append_req_id(f"{r.text}\n\nReply: {options}")
