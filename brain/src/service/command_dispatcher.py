"""Shared command dispatcher — routes CommandRequests to business logic.

Transport-agnostic. Called by Telegram, Bluesky, CLI, or any future
channel. Returns structured BotResponse objects that the channel renders.

The dispatcher owns:
  - Command routing (which service method to call)
  - Response construction (structured response types)
  - Confirmation flow state (pending_trust)

The dispatcher does NOT own:
  - Input parsing (adapter's job)
  - Response rendering/formatting (channel's job)
  - Business logic (UserCommandService / Guardian)
"""

from __future__ import annotations

import logging
from typing import Any

from ..domain.request import Command, CommandRequest
from ..domain.response import (
    BotResponse,
    ConfirmOption,
    ConfirmResponse,
    ContactListResponse,
    ErrorResponse,
    RichResponse,
    SendResponse,
    StatusResponse,
    TextFormat,
    TrustScoreResponse,
)
from .user_commands import UserCommandService, validate_name, validate_did

log = logging.getLogger(__name__)


class CommandDispatcher:
    """Routes parsed commands to business logic and returns responses."""

    def __init__(
        self,
        user_commands: UserCommandService,
        guardian: Any = None,
    ) -> None:
        self._cmds = user_commands
        self._guardian = guardian
        self._pending_trust: dict | None = None

    async def dispatch(self, request: CommandRequest) -> BotResponse:
        """Route a command and return the response."""
        handler = _DISPATCH_TABLE.get(request.command)
        if handler:
            return await handler(self, request)
        return ErrorResponse(text="Unknown command.")

    # ── Status ──────────────────────────────────────────────────────

    async def _handle_status(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.get_status()
        if not result.ok:
            return ErrorResponse(text=result.message)
        d = result.data
        return StatusResponse(
            text="", did=d["did"], status=d["status"], version=d["version"],
        )

    # ── Contacts ────────────────────────────────────────────────────

    async def _handle_contact_list(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.list_contacts()
        if not result.ok:
            return ErrorResponse(text=result.message)
        return ContactListResponse(text="", contacts=result.data["contacts"])

    async def _handle_contact_add(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.add_contact(req.args["name"], req.args["did"])
        if result.ok:
            return RichResponse(text=f"Contact added: {req.args['name']}")
        return ErrorResponse(text=result.message)

    async def _handle_contact_delete(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.delete_contact(req.args["name"])
        return BotResponse(text=result.message)

    async def _handle_contact_cleanup(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.cleanup_contacts()
        return BotResponse(text=result.message)

    # ── Trust ───────────────────────────────────────────────────────

    async def _handle_trust(self, req: CommandRequest) -> BotResponse:
        result = await self._cmds.query_trust(req.args["target"])
        if not result.ok:
            return ErrorResponse(text=result.message)
        d = result.data
        return TrustScoreResponse(
            text="", display_name=d["display_name"], did=d["did"],
            score=d["score"], total_attestations=d["total_attestations"],
            positive_attestations=d["positive_attestations"],
            vouch_count=d["vouch_count"],
        )

    async def _handle_vouch(self, req: CommandRequest) -> BotResponse:
        name, reason = req.args["name"], req.args["reason"]
        err = validate_name(name)
        if err:
            return ErrorResponse(text=err)
        did = await self._cmds.resolve_contact_did(name)
        if not did:
            return ErrorResponse(text=f"Contact '{name}' not found.")
        self._pending_trust = {"cmd": "vouch", "name": name, "text": reason}
        return ConfirmResponse(
            text=f"Vouch for {name}:\n{reason}\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm",
                              data={"callback_data": f"trust_yes:{did[:20]}"}),
                ConfirmOption(label="Cancel", action="cancel",
                              data={"callback_data": "trust_no"}),
            ],
        )

    async def _handle_review(self, req: CommandRequest) -> BotResponse:
        product, review_text = req.args["product"], req.args["text"]
        err = validate_name(product)
        if err:
            return ErrorResponse(text=err)
        self._pending_trust = {"cmd": "review", "product": product, "text": review_text}
        return ConfirmResponse(
            text=f"Review of {product}:\n{review_text}\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm",
                              data={"callback_data": "trust_yes:review"}),
                ConfirmOption(label="Cancel", action="cancel",
                              data={"callback_data": "trust_no"}),
            ],
        )

    async def _handle_flag(self, req: CommandRequest) -> BotResponse:
        target, reason = req.args["target"], req.args["reason"]
        if target.startswith("did:"):
            err = validate_did(target)
        else:
            err = validate_name(target)
        if err:
            return ErrorResponse(text=err)
        did = await self._cmds.resolve_contact_did(target)
        if not did and target.startswith("did:"):
            did = target
        if not did:
            return ErrorResponse(text=f"Could not resolve '{target}'.")
        self._pending_trust = {"cmd": "flag", "target": target, "text": reason}
        return ConfirmResponse(
            text=f"Flag {target}:\n{reason}\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm",
                              data={"callback_data": "trust_yes:flag"}),
                ConfirmOption(label="Cancel", action="cancel",
                              data={"callback_data": "trust_no"}),
            ],
        )

    # ── Trust confirm callback ──────────────────────────────────────

    async def handle_trust_confirm(self, confirmed: bool) -> BotResponse:
        """Handle confirmation. Called by any adapter after user confirms/cancels."""
        if not confirmed:
            self._pending_trust = None
            return BotResponse(text="Cancelled.")
        pending = self._pending_trust
        if not pending:
            return BotResponse(text="Nothing to publish (expired).")
        cmd = pending["cmd"]
        try:
            if cmd == "vouch":
                result = await self._cmds.publish_vouch(pending["name"], pending["text"])
            elif cmd == "review":
                result = await self._cmds.publish_review(pending["product"], pending["text"])
            elif cmd == "flag":
                result = await self._cmds.publish_flag(pending["target"], pending["text"])
            else:
                self._pending_trust = None
                return ErrorResponse(text="Unknown command.")
            if result.ok:
                uri = result.data.get("uri", "?") if result.data else "?"
                return RichResponse(text=f"{result.message}\nURI: {uri}")
            return ErrorResponse(text=result.message)
        except Exception as exc:
            log.warning("trust_publish_failed", extra={"cmd": cmd, "error": str(exc)})
            return ErrorResponse(text=f"Publish failed: {exc}")
        finally:
            self._pending_trust = None

    # ── D2D Send ────────────────────────────────────────────────────

    async def _handle_send(self, req: CommandRequest) -> BotResponse:
        if not self._guardian:
            return ErrorResponse(text="Send not available.")
        contact, message = req.args["contact"], req.args["message"]
        result = await self._cmds.send_d2d(contact, message, self._guardian._llm)
        if result.ok:
            type_label = {
                "presence.signal": "Presence",
                "coordination.request": "Coordination",
                "coordination.response": "Response",
                "social.update": "Social update",
                "safety.alert": "Safety alert",
            }.get(result.data.get("type", ""), result.data.get("type", ""))
            return SendResponse(
                text="", contact=contact,
                message_type=type_label, message_text=message,
            )
        return ErrorResponse(text=result.message)

    # ── Ask ──────────────────────────────────────────────────────────

    async def _handle_ask(self, req: CommandRequest) -> BotResponse:
        if not self._guardian:
            return ErrorResponse(text="Ask not available.")
        try:
            result = await self._guardian.process_event({
                "type": "reason",
                "prompt": req.args.get("prompt", ""),
                "persona_id": "default",
                "source": req.source,
                "request_id": req.args.get("req_id", ""),
            })
            text = ""
            if isinstance(result, dict):
                text = result.get("response", result.get("content", ""))
                if isinstance(text, dict):
                    text = text.get("text", str(text))
            return RichResponse(text=text or "No response.")
        except Exception as exc:
            log.error("dispatch.ask_failed", extra={"error": str(exc)})
            return ErrorResponse(text="Something went wrong. Please try again.")

    # ── Remember ──────────────────────────────────────────────────────

    async def _handle_remember(self, req: CommandRequest) -> BotResponse:
        """Store a memory via staging pipeline."""
        text = req.args.get("text", "")
        if not text:
            return ErrorResponse(text="Usage: remember <text>")
        if not self._guardian:
            return ErrorResponse(text="Remember not available.")
        try:
            # Use Core's staging_ingest (same path as Telegram /remember).
            import time as _time
            staging_id = await self._cmds._core.staging_ingest({
                "type": "note",
                "source": req.source or "channel",
                "source_id": f"ch_{int(_time.time())}",
                "summary": text[:200],
                "body": text,
                "sender": req.user_id,
                "metadata": "{}",
                "ingress_channel": req.source or "channel",
                "origin_kind": "user",
            })
            # Poll for result.
            import asyncio
            result_msg = "Stored."
            for _ in range(15):
                await asyncio.sleep(1)
                try:
                    status = await self._cmds._core.staging_status(staging_id)
                    s = status.get("status", "")
                    persona = status.get("persona", "")
                    if s == "stored":
                        result_msg = f"Stored in {persona} vault." if persona else "Stored."
                        break
                    elif s in ("needs_approval", "pending_unlock"):
                        result_msg = f"Needs approval for {persona} vault." if persona else "Needs approval."
                        break
                    elif s == "failed":
                        result_msg = "Failed to store."
                        break
                except Exception:
                    break
            return BotResponse(text=result_msg)
        except Exception as exc:
            log.error("dispatch.remember_failed", extra={"error": str(exc)})
            return ErrorResponse(text="Could not save. Please try again.")

    # ── Help ─────────────────────────────────────────────────────────

    async def _handle_help(self, req: CommandRequest) -> BotResponse:
        return RichResponse(
            text="Here's what I can do:\n\n"
                 "Memory\n"
                 "  ask <question> — ask me anything\n"
                 "  remember <text> — store a memory\n\n"
                 "Dina-to-Dina\n"
                 "  send Name: message — message another Dina\n"
                 "  contact list — show your contacts\n"
                 "  contact add Name: did:plc:... — add a contact\n\n"
                 "Trust Network\n"
                 "  review Product: your review — publish a review\n"
                 "  vouch Name: reason — vouch for someone\n"
                 "  flag Name: reason — flag a bad actor\n"
                 "  trust Name — check trust score\n\n"
                 "Info\n"
                 "  status — your DID and node health",
        )


# Dispatch table.
_DISPATCH_TABLE: dict = {
    Command.STATUS: CommandDispatcher._handle_status,
    Command.CONTACT_LIST: CommandDispatcher._handle_contact_list,
    Command.CONTACT_ADD: CommandDispatcher._handle_contact_add,
    Command.CONTACT_DELETE: CommandDispatcher._handle_contact_delete,
    Command.CONTACT_CLEANUP: CommandDispatcher._handle_contact_cleanup,
    Command.TRUST: CommandDispatcher._handle_trust,
    Command.VOUCH: CommandDispatcher._handle_vouch,
    Command.REVIEW: CommandDispatcher._handle_review,
    Command.FLAG: CommandDispatcher._handle_flag,
    Command.SEND: CommandDispatcher._handle_send,
    Command.ASK: CommandDispatcher._handle_ask,
    Command.REMEMBER: CommandDispatcher._handle_remember,
    Command.HELP: CommandDispatcher._handle_help,
}
