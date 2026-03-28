"""Telegram channel — renders BotResponse types for Telegram.

Each response type gets Telegram-native formatting:
- StatusResponse → Markdown with DID in code block
- ConfirmResponse → inline keyboard buttons
- ContactListResponse → formatted list with DIDs
- etc.

Appends ``[req_id]`` to every message for log correlation.
"""

from __future__ import annotations

from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message

from ..domain.response import (
    BotResponse,
    ConfirmOption,
    ConfirmResponse,
    ContactListResponse,
    ErrorResponse,
    SendResponse,
    StatusResponse,
    TextFormat,
    TrustScoreResponse,
)

# Telegram Markdown V1 special characters.
_MD_ESCAPE = r"_*`["


def _esc(text: str) -> str:
    """Escape Telegram Markdown V1 special characters."""
    for ch in _MD_ESCAPE:
        text = text.replace(ch, f"\\{ch}")
    return text


class TelegramChannel:
    """Delivers BotResponse objects via Telegram reply_text."""

    def __init__(self, message: Message, req_id: str = "") -> None:
        self._message = message
        self._req_id = req_id

    @property
    def req_id(self) -> str:
        return self._req_id

    def _append_req_id(self, text: str, is_markdown: bool = False) -> str:
        if self._req_id:
            if is_markdown:
                return f"{text}\n`[{self._req_id}]`"
            return f"{text}\n[{self._req_id}]"
        return text

    async def send(self, response: BotResponse) -> None:
        """Render and send a BotResponse via Telegram."""
        # Dispatch to type-specific renderer.
        if isinstance(response, StatusResponse):
            await self._send_status(response)
        elif isinstance(response, ContactListResponse):
            await self._send_contact_list(response)
        elif isinstance(response, TrustScoreResponse):
            await self._send_trust_score(response)
        elif isinstance(response, SendResponse):
            await self._send_d2d(response)
        elif isinstance(response, ConfirmResponse):
            await self._send_confirm(response)
        elif isinstance(response, ErrorResponse):
            await self._send_text(response.text, is_error=True)
        else:
            # BotResponse / RichResponse — render text with format hint.
            is_md = response.format == TextFormat.RICH
            await self._send_text(response.text, markdown=is_md)

    async def edit(self, response: BotResponse) -> None:
        """Edit the original message (for callback query responses)."""
        is_md = response.format == TextFormat.RICH
        text = self._append_req_id(response.text, is_markdown=is_md)
        kwargs: dict[str, Any] = {}
        if is_md:
            kwargs["parse_mode"] = "Markdown"
        await self._message.edit_text(text, **kwargs)

    # ── Type-specific renderers ────────────────────────────────────

    async def _send_text(self, text: str, markdown: bool = False, is_error: bool = False) -> None:
        text_with_id = self._append_req_id(text, is_markdown=markdown)
        if markdown:
            try:
                await self._message.reply_text(text_with_id, parse_mode="Markdown")
                return
            except Exception:
                # Markdown parse error (unbalanced *, _, `) — send plain.
                pass
        await self._message.reply_text(self._append_req_id(text, is_markdown=False))

    async def _send_status(self, r: StatusResponse) -> None:
        text = (
            f"*Your Dina*\n"
            f"DID: `{r.did}`\n"
            f"Status: {r.status}\n"
            f"Version: {r.version}"
        )
        await self._send_text(text, markdown=True)

    async def _send_contact_list(self, r: ContactListResponse) -> None:
        if not r.contacts:
            await self._send_text("No contacts.")
            return
        lines = []
        for c in r.contacts:
            name = c.get("display_name", "") or c.get("name", "?")
            did = c.get("did", "?")
            trust = c.get("trust_level", "")
            lines.append(f"  {name} — `{did[:35]}...` {trust}")
        text = f"*Contacts ({len(r.contacts)}):*\n" + "\n".join(lines)
        await self._send_text(text, markdown=True)

    async def _send_trust_score(self, r: TrustScoreResponse) -> None:
        text = (
            f"Trust: *{_esc(r.display_name)}*\n"
            f"Score: {r.score}\n"
            f"Attestations: {r.total_attestations} ({r.positive_attestations} positive)\n"
            f"Vouches: {r.vouch_count}"
        )
        await self._send_text(text, markdown=True)

    async def _send_d2d(self, r: SendResponse) -> None:
        text = f"Sent to {r.contact}: {r.message_type}\n{r.message_text}"
        await self._send_text(text)

    async def _send_confirm(self, r: ConfirmResponse) -> None:
        text = self._append_req_id(r.text, is_markdown=True)
        buttons = []
        for opt in r.options:
            # Build callback_data from action + data for Telegram.
            cb = opt.data.get("callback_data", opt.action)
            buttons.append(InlineKeyboardButton(opt.label, callback_data=cb))
        keyboard = InlineKeyboardMarkup([buttons]) if buttons else None
        kwargs: dict[str, Any] = {"parse_mode": "Markdown"}
        if keyboard:
            kwargs["reply_markup"] = keyboard
        await self._message.reply_text(text, **kwargs)
