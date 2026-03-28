"""Telegram message handling — access control, Guardian routing, vault storage.

Provides callback functions that the ``TelegramBotAdapter`` registers as
handlers.  All business logic lives here; the adapter is a thin transport.

Access control model:
    - **DM pairing**: A user must be in ``allowed_user_ids`` (config) to
      pair via ``/start``.  Once paired, their Telegram user ID is persisted
      to Core KV and survives restarts.
    - **Group allowlist**: Group messages are processed only if the group's
      chat ID is in ``allowed_group_ids`` AND the message @-mentions the bot.

Message flow (DM):
    1. ``python-telegram-bot`` dispatches update → ``handle_message()``
    2. Access control check (allowed + paired).
    3. Pass to Guardian as ``{"type": "reason", "prompt": <text>, ...}``.
    4. Guardian returns response → ``reply_text()``.
    5. Store exchange in vault for memory/context.

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

import datetime as _dt
import os
import zoneinfo

from ..domain.response import BotResponse, ConfirmOption, ConfirmResponse, ErrorResponse, RichResponse
from ..port.core_client import CoreClient
from .user_commands import UserCommandService, validate_name, validate_did

log = logging.getLogger(__name__)

# Core KV key for persisting paired Telegram user IDs.
_KV_PAIRED_USERS = "telegram_paired_users"

# Telegram Markdown V1 special characters that need escaping.
_MD_ESCAPE_CHARS = r"_*`["

# User timezone from env (e.g. "Asia/Kolkata"). Falls back to UTC.
try:
    _USER_TZ = zoneinfo.ZoneInfo(os.environ.get("DINA_TIMEZONE", "UTC"))
except Exception:
    _USER_TZ = _dt.timezone.utc


def _format_local_time(iso_str: str) -> str:
    """Convert an ISO datetime string (UTC) to the user's local time display."""
    try:
        dt = _dt.datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        local_dt = dt.astimezone(_USER_TZ)
        return local_dt.strftime("%b %d, %I:%M %p")
    except Exception:
        return iso_str


def _escape_markdown(text: str) -> str:
    """Escape Telegram Markdown V1 special characters in user-supplied text."""
    for ch in _MD_ESCAPE_CHARS:
        text = text.replace(ch, f"\\{ch}")
    return text


class TelegramService:
    """Orchestrates Telegram message handling, access control, and vault storage.

    Parameters
    ----------
    guardian:
        GuardianLoop instance for event processing and reasoning.
    core:
        Typed HTTP client for dina-core (vault storage, KV).
    allowed_user_ids:
        Set of Telegram user IDs allowed to pair via /start.
    allowed_group_ids:
        Set of Telegram group chat IDs where the bot responds.
    """

    def __init__(
        self,
        guardian: Any,  # GuardianLoop — Any to avoid circular import
        core: CoreClient,
        allowed_user_ids: set[int] | None = None,
        allowed_group_ids: set[int] | None = None,
        user_commands: UserCommandService | None = None,
    ) -> None:
        self._guardian = guardian
        self._core = core
        self._allowed_users: set[int] = allowed_user_ids or set()
        self._allowed_groups: set[int] = allowed_group_ids or set()
        self._paired_users: set[int] = set()
        self._bot: Any = None  # Set via set_bot() after construction
        self._cmds = user_commands or UserCommandService(core)

    @property
    def _pds_publisher(self) -> Any:
        return self._cmds.pds_publisher

    @_pds_publisher.setter
    def _pds_publisher(self, pub: Any) -> None:
        self._cmds.pds_publisher = pub

    def set_bot(self, bot: Any) -> None:
        """Inject the bot adapter reference (for outbound nudges).

        Called by the composition root after both service and adapter
        are constructed.
        """
        self._bot = bot

    @staticmethod
    def _ch(context: Any) -> Any:
        """Get the TelegramChannel from context. Falls back to None."""
        return context.user_data.get("channel") if hasattr(context, "user_data") else None

    # ------------------------------------------------------------------
    # Startup
    # ------------------------------------------------------------------

    async def load_paired_users(self) -> None:
        """Load previously paired users from Core KV.

        Called once at startup before polling begins.  If KV is empty
        or unreachable, starts with an empty set (safe default).
        """
        try:
            raw = await self._core.get_kv(_KV_PAIRED_USERS)
            if raw:
                user_ids = json.loads(raw)
                self._paired_users = {int(uid) for uid in user_ids}
                log.info(
                    "telegram.paired_users.loaded",
                    extra={"count": len(self._paired_users)},
                )
        except Exception as exc:
            log.warning(
                "telegram.paired_users.load_failed",
                extra={"error": str(exc)},
            )

    # ------------------------------------------------------------------
    # Command handlers
    # ------------------------------------------------------------------

    async def handle_start(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /start command — user pairing flow.

        If the user's Telegram ID is in ``allowed_user_ids``, they are
        paired and welcomed.  Otherwise, a polite rejection is sent.
        """
        if not update.effective_user or not update.effective_chat:
            return

        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        username = update.effective_user.username or str(user_id)

        ch = self._ch(context)

        if user_id in self._paired_users:
            await ch.send(BotResponse(
                text="You're already paired. Send me a message and I'll help."
            ))
            return

        if user_id not in self._allowed_users:
            log.info(
                "telegram.start.rejected",
                extra={"user_id": user_id, "username": username},
            )
            await ch.send(BotResponse(
                text="Sorry, I can only chat with my owner. "
                "Ask them to add your Telegram user ID to the allowed list."
            ))
            return

        # Pair the user.
        await self._pair_user(user_id, chat_id)
        log.info(
            "telegram.start.paired",
            extra={"user_id": user_id, "username": username},
        )
        await ch.send(BotResponse(
            text="Welcome! You're now paired with Dina. "
            "Send me any message and I'll think about it."
        ))

    # ------------------------------------------------------------------
    # /remember command
    # ------------------------------------------------------------------

    async def handle_remember(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /remember <text> — store a memory via staging pipeline.

        Mirrors ``dina remember``. The text is ingested into staging,
        classified by Brain, and stored in the appropriate persona vault.
        Sensitive personas will trigger an approval notification.
        """
        if not update.effective_user or not update.effective_chat:
            return
        if not update.message:
            return

        ch = self._ch(context)
        user_id = update.effective_user.id
        if not self._is_allowed_user(user_id):
            await ch.send(BotResponse(
                text="I don't recognise you yet. Send /start to pair."
            ))
            return

        # Auto-pair on first interaction.
        if user_id not in self._paired_users:
            await self._pair_user(user_id, update.effective_chat.id)

        # Extract text after /remember command.
        text = (update.message.text or "").strip()
        # Remove the /remember prefix.
        if text.lower().startswith("/remember"):
            text = text[len("/remember"):].strip()
        if not text:
            await ch.send(BotResponse(
                text="Usage: /remember <text>\n"
                "Example: /remember My FD interest rate is now 7.8%"
            ))
            return

        try:
            staging_id = await self._core.staging_ingest({
                "type": "note",
                "source": "telegram",
                "source_id": f"tg_{update.update_id}",
                "summary": text[:200],
                "body": text,
                "sender": str(user_id),
                "metadata": json.dumps({"timestamp": int(time.time())}),
                "ingress_channel": "telegram",
                "origin_kind": "user",
            })

            # Poll staging status — wait for Brain classification + Core resolve.
            result_msg = "Stored."
            for _ in range(30):
                await asyncio.sleep(1)
                try:
                    status = await self._core.staging_status(staging_id)
                    s = status.get("status", "")
                    persona = status.get("persona", "")
                    vault_label = f" *{persona}*" if persona else ""
                    if s == "stored":
                        result_msg = f"Stored in{vault_label} vault."
                        break
                    elif s in ("needs_approval", "pending_unlock"):
                        result_msg = f"Needs approval for{vault_label} vault."
                        break
                    elif s == "failed":
                        result_msg = "Failed to store."
                        break
                except Exception as _exc:
                    log.debug("telegram.suppressed_error", exc_info=_exc)
                    break

            # Check staging status for reminder plan (set during processing).
            # The plan is stored in Core KV by the staging processor so any
            # caller (Telegram, dina-admin, CLI) can retrieve it.
            reminder_lines = []
            plan = None
            if result_msg.startswith("Stored"):
                # Small delay — KV write completes before resolve, but
                # allow propagation time.
                await asyncio.sleep(1)
                try:
                    kv_key = f"reminder_plan:{staging_id}"
                    plan_raw = await self._core.get_kv(kv_key)
                    log.info("telegram.remember.kv_read key=%s found=%s", kv_key, plan_raw is not None)
                    if plan_raw:
                        import json as _json
                        plan = _json.loads(plan_raw)
                        for r in plan.get("reminders", []):
                            fire = r.get("fire_at", "")
                            msg = r.get("message", "")
                            time_str = _format_local_time(fire)
                            emoji = {"birthday": "🎂", "appointment": "📅",
                                     "payment_due": "💳", "deadline": "⏰"}.get(
                                         r.get("kind", ""), "🔔")
                            reminder_lines.append(f"{emoji} {time_str} — {msg}")
                except Exception as _exc:
                    log.debug("telegram.suppressed_error", exc_info=_exc)

            if plan and plan.get("reminders"):
                await ch.send(RichResponse(text=result_msg))
                await self.send_reminder_plan(update.effective_chat.id, plan)
            else:
                await ch.send(RichResponse(text=result_msg))
        except Exception as exc:
            log.error(
                "telegram.remember_failed",
                extra={"error": f"{type(exc).__name__}: {exc}"},
            )
            await ch.send(ErrorResponse(
                text="Sorry, I couldn't save that. Please try again."
            ))

    # ------------------------------------------------------------------
    # /edit command (reminder editing)
    # ------------------------------------------------------------------

    async def handle_edit(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /edit command from Telegram command handler."""
        if not update.effective_user or not update.message:
            return
        ch = self._ch(context)
        text = (update.message.text or "").strip()
        if text.lower().startswith("/edit"):
            text = text[len("/edit"):].strip()
        await self._process_edit(update, f"/edit {text}" if text else "/edit", ch=ch)

    async def _process_edit(self, update: Update, raw_text: str, *, ch: Any) -> None:
        """Process an edit command — accepts raw text including /edit prefix."""
        if not update.message:
            return
        text = raw_text.strip()
        if text.lower().startswith("/edit"):
            text = text[len("/edit"):].strip()
        if not text:
            await ch.send(BotResponse(text="Usage: /edit <reminder_id> <new time — new message>"))
            return

        # Parse: first token is short reminder ID, rest is the edited text.
        parts = text.split(None, 1)
        if len(parts) < 2:
            await ch.send(BotResponse(text="Usage: /edit <id> <new time — new message>"))
            return
        short_id = parts[0]
        edited_text = parts[1]

        # Resolve short ID to full reminder ID.
        import hashlib
        rem_id = None
        try:
            resp = await self._core._request("GET", "/v1/reminders/pending")
            for r in resp.json().get("reminders", []):
                rid = r.get("id", "")
                if hashlib.md5(rid.encode()).hexdigest()[:4] == short_id or rid == short_id:
                    rem_id = rid
                    break
        except Exception as _exc:
            log.debug("telegram.suppressed_error", exc_info=_exc)
        if not rem_id:
            await ch.send(ErrorResponse(text=f"Reminder `{short_id}` not found."))
            return

        # Ask LLM to parse the new time and message.
        try:
            import datetime as _dt
            now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            prompt = (
                f"Today is {now}. The user wants to update a reminder.\n"
                f"New text: \"{edited_text}\"\n\n"
                f"Extract the date/time and message. Respond with JSON only:\n"
                f'{{"fire_at": "YYYY-MM-DDTHH:MM:SSZ", "message": "the reminder text"}}'
            )
            resp = await self._guardian._llm.route(
                task_type="classification",
                prompt=prompt,
                messages=[
                    {"role": "system", "content": "Parse reminder time and message. JSON only."},
                    {"role": "user", "content": prompt},
                ],
            )
            import json as _json
            raw = resp.get("content", "").strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            parsed = _json.loads(raw)

            fire_at = parsed.get("fire_at", "")
            message = parsed.get("message", edited_text)
            dt = _dt.datetime.fromisoformat(fire_at.replace("Z", "+00:00"))
            trigger_ts = int(dt.timestamp())

            # Delete old + create new (Core doesn't have an update endpoint).
            try:
                await self._core._request("DELETE", f"/v1/reminder/{rem_id}")
            except Exception as _exc:
                log.debug("telegram.suppressed_error", exc_info=_exc)
            await self._core.store_reminder({
                "type": "",
                "message": message,
                "trigger_at": trigger_ts,
                "metadata": "{}",
                "source_item_id": "",
                "source": "telegram",
                "persona": "general",
                "kind": "reminder",
            })

            time_str = _format_local_time(fire_at)
            await ch.send(BotResponse(text=f"✏️ Reminder updated:\n{time_str} — {message}"))
        except Exception as exc:
            log.warning("telegram.edit_failed", extra={"error": str(exc)})
            await ch.send(ErrorResponse(text="Could not parse the edit. Try: /edit <id> Apr 5, 3:00 PM — New message"))

    # ------------------------------------------------------------------
    # /send command (D2D messaging)
    # ------------------------------------------------------------------

    async def handle_send(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /send <contact>: <message> — send a D2D message."""
        if not update.effective_user or not update.message:
            return

        ch = self._ch(context)
        user_id = update.effective_user.id
        if not self._is_allowed_user(user_id):
            await ch.send(BotResponse(
                text="I don't recognise you yet. Send /start to pair."
            ))
            return

        text = (update.message.text or "").strip()
        if text.lower().startswith("/send"):
            text = text[len("/send"):].strip()
        if ":" not in text:
            await ch.send(BotResponse(
                text="Usage: /send Name: message\n"
                "Example: /send Sancho: I'll be there in 30 minutes"
            ))
            return

        colon_pos = text.index(":")
        contact_name = text[:colon_pos].strip()
        message_text = text[colon_pos + 1:].strip()
        if not contact_name or not message_text:
            await ch.send(BotResponse(
                text="Usage: /send Name: message\n"
                "Example: /send Sancho: I'll be there in 30 minutes"
            ))
            return

        result = await self._cmds.send_d2d(
            contact_name, message_text, self._guardian._llm,
        )
        if result.ok:
            type_label = {
                "presence.signal": "Presence",
                "coordination.request": "Coordination",
                "coordination.response": "Response",
                "social.update": "Social update",
                "safety.alert": "Safety alert",
                "trust.vouch.request": "Trust request",
            }.get(result.data.get("type", ""), result.data.get("type", ""))
            await ch.send(BotResponse(
                text=f"Sent to {contact_name}: {type_label}\n{message_text}"
            ))
        else:
            await ch.send(ErrorResponse(text=result.message))

    # ------------------------------------------------------------------
    # /ask command
    # ------------------------------------------------------------------

    async def handle_ask(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /ask <text> — vault query via Guardian.

        Mirrors ``dina ask``. Read-only — never stores data.
        """
        if not update.effective_user or not update.effective_chat:
            return
        if not update.message:
            return

        ch = self._ch(context)
        user_id = update.effective_user.id
        chat_id = update.effective_chat.id

        if not self._is_allowed_user(user_id):
            await ch.send(BotResponse(
                text="I don't recognise you yet. Send /start to pair."
            ))
            return

        if user_id not in self._paired_users:
            await self._pair_user(user_id, chat_id)

        text = (update.message.text or "").strip()
        if text.lower().startswith("/ask"):
            text = text[len("/ask"):].strip()
        if not text:
            await ch.send(BotResponse(
                text="Usage: /ask <question>\n"
                "Example: /ask What is my FD status?"
            ))
            return

        try:
            result = await self._guardian.process_event({
                "type": "reason",
                "prompt": text,
                "persona_id": "default",
                "source": "telegram",
                "chat_id": chat_id,
                "user_id": user_id,
            })
            response_text = self._extract_response(result)
            if response_text:
                try:
                    await ch.send(RichResponse(text=response_text))
                except Exception:
                    # Markdown parse error — retry as plain text.
                    await ch.send(BotResponse(text=response_text))
        except Exception as exc:
            log.error(
                "telegram.ask_failed",
                extra={"error": type(exc).__name__, "chat_id": chat_id},
            )
            await ch.send(ErrorResponse(text="Something went wrong. Please try again."))

    # ------------------------------------------------------------------
    # Message handler (default = ask)
    # ------------------------------------------------------------------

    async def handle_message(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle incoming text messages (non-command).

        Default behavior is read-only vault query (same as /ask).
        DM messages from paired users are forwarded to Guardian.
        Group messages are only processed if the group is in the
        allowlist and the message @-mentions the bot.
        """
        if not update.effective_user or not update.effective_chat:
            return
        if not update.message or not update.message.text:
            return

        ch = self._ch(context)
        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type
        text = update.message.text

        # --- Group message handling ---
        if chat_type in ("group", "supergroup"):
            if not self._is_allowed_group(chat_id):
                return
            if not self._is_bot_mentioned(text):
                return
            # Strip the @mention from the text before processing.
            text = self._strip_mention(text)

        # --- DM handling ---
        elif chat_type == "private":
            if not self._is_allowed_user(user_id):
                await ch.send(BotResponse(
                    text="I don't recognise you yet. Send /start to pair."
                ))
                return
            # Auto-pair allowed users on first DM so they receive
            # outbound notifications (approvals, nudges) without
            # needing an explicit /start.
            if user_id not in self._paired_users:
                await self._pair_user(user_id, chat_id)

        # --- Check for approval response (approve/deny via text) ---
        approval_response = await self.handle_approval_response(text)
        if approval_response:
            await ch.send(RichResponse(text=approval_response))
            return

        # --- Handle inline edit from switch_inline_query_current_chat ---
        # The text arrives as "@botname /edit <id> <time> — <msg>"
        stripped = text
        if self._bot and self._bot.bot_username:
            stripped = stripped.replace(f"@{self._bot.bot_username}", "").strip()
        if stripped.startswith("/edit"):
            # Can't modify update.message.text (immutable) — call edit directly.
            await self._process_edit(update, stripped, ch=ch)
            return

        # --- No default action — guide the user ---
        await ch.send(RichResponse(
            text="Here's what I can do:\n\n"
            "*Memory*\n"
            "/ask <question> — ask me anything\n"
            "/remember <text> — store a memory\n\n"
            "*Dina-to-Dina*\n"
            "/send Name: message — message another Dina\n"
            "/contact list — show your contacts\n"
            "/contact add Name: did:plc:... — add a contact\n\n"
            "*Trust Network*\n"
            "/review Product: your review — publish a review\n"
            "/vouch Name: reason — vouch for someone\n"
            "/flag Name: reason — flag a bad actor\n"
            "/trust Name — check trust score\n\n"
            "*Info*\n"
            "/status — your DID and node health",
        ))

    # ------------------------------------------------------------------
    # Outbound nudge
    # ------------------------------------------------------------------

    async def send_nudge(self, chat_id: int, text: str) -> None:
        """Send a nudge/notification to a Telegram chat.

        Used by other services (e.g. reminder system) to push messages
        to a paired user's Telegram chat.
        """
        if self._bot:
            await self._bot.send_message(chat_id, text)

    async def send_approval_prompt(self, approval: dict) -> None:
        """Send an approval request to all paired Telegram users.

        The approval dict should contain: id, persona, client_did, session, reason.
        Users reply with the approval ID to approve, or 'deny <id>' to deny.
        """
        if not self._bot:
            return
        # Lazy retry: if paired users failed to load at startup (race
        # condition — Brain starts before Core is ready), try again now.
        if not self._paired_users:
            await self.load_paired_users()
        if not self._paired_users:
            return

        # Escape Markdown special chars in user-supplied fields to prevent
        # broken formatting or injection via query text.
        aid = approval.get("id", "")
        persona = approval.get("persona", "")
        agent = approval.get("client_did", "")
        reason = approval.get("reason", "")
        preview = _escape_markdown(approval.get("preview", ""))

        # Skip empty/bogus approvals (e.g. Brain's own vault queries)
        if not aid or not persona:
            return

        # Build a concise, human-readable notification.
        # e.g. "🔐 config-test-primary wants to store in health"
        #       "My HbA1c is 5.8 percent..."
        verb = "store in" if "Store" in reason else "access"
        if agent:
            title = f"{_escape_markdown(agent)} wants to {verb} *{persona}*"
        else:
            title = f"Request to {verb} *{persona}*"

        lines = [f"🔐 {title}\n"]
        if preview:
            lines.append(f"_{preview}_")
        msg = "\n".join(lines)

        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("✅ Approve", callback_data=f"approve {aid}"),
                InlineKeyboardButton("🚫 Deny", callback_data=f"deny {aid}"),
            ],
            [
                InlineKeyboardButton("✅ Approve (once)", callback_data=f"approve-single {aid}"),
            ],
        ])

        # For DMs, chat_id == user_id
        for chat_id in self._paired_users:
            try:
                await self._bot.send_message(
                    chat_id, msg, parse_mode="Markdown", reply_markup=keyboard,
                )
            except Exception:
                log.warning("telegram.approval_send_failed chat_id=%s", chat_id)

    async def handle_approval_response(self, text: str) -> str | None:
        """Check if a message is an approval response and process it.

        Returns a response message if it was an approval command, None otherwise.
        """
        text = text.strip().lower()
        if text.startswith("approve-single "):
            approval_id = text[len("approve-single "):].strip()
            if self._core:
                try:
                    await self._core.approve_request(approval_id, scope="single", granted_by="telegram")
                    return f"✅ Approved (single use): `{approval_id}`"
                except Exception as exc:
                    # BS4: Generic message to Telegram; details server-side only.
                    log.warning("telegram.approve_failed", extra={"id": approval_id, "error": str(exc)})
                    return "❌ Approval failed. Check the admin dashboard for details."
        elif text.startswith("approve "):
            approval_id = text[8:].strip()
            if self._core:
                try:
                    await self._core.approve_request(approval_id, scope="session", granted_by="telegram")
                    return f"✅ Approved: `{approval_id}`"
                except Exception as exc:
                    log.warning("telegram.approve_failed", extra={"id": approval_id, "error": str(exc)})
                    return "❌ Approval failed. Check the admin dashboard for details."
        elif text.startswith("deny "):
            approval_id = text[5:].strip()
            if self._core:
                try:
                    await self._core.deny_request(approval_id)
                    return f"🚫 Denied: `{approval_id}`"
                except Exception as exc:
                    log.warning("telegram.deny_failed", extra={"id": approval_id, "error": str(exc)})
                    return "❌ Denial failed. Check the admin dashboard for details."
        return None

    # ------------------------------------------------------------------
    # Inline keyboard callback handler
    # ------------------------------------------------------------------

    async def handle_callback_query(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle inline keyboard button presses (approve/deny/reminders)."""
        query = update.callback_query
        if not query or not query.data:
            return
        await query.answer()  # Acknowledge the button press

        ch = self._ch(context)
        data = query.data

        # Handle reminder buttons.
        if data.startswith("reminder_delete:"):
            rem_id = data[len("reminder_delete:"):]
            try:
                await self._core._request("DELETE", f"/v1/reminder/{rem_id}")
                if ch:
                    await ch.send(BotResponse(text="🗑 Reminder deleted."))
            except Exception:
                if ch:
                    await ch.send(ErrorResponse(text="Failed to delete reminder."))
            return

        # Trust publish buttons (Publish / Cancel).
        if data.startswith("trust_yes:") or data == "trust_no":
            await self._handle_trust_callback(update, ch)
            return

        # Edit button uses switch_inline_query_current_chat — no callback needed.

        # Handle approval buttons.
        response = await self.handle_approval_response(data)
        if response and ch:
            await ch.edit(RichResponse(text=response))

    # ------------------------------------------------------------------
    # Access control
    # ------------------------------------------------------------------

    def _is_allowed_user(self, user_id: int) -> bool:
        """Check if a user is allowed (configured) or already paired."""
        return user_id in self._allowed_users or user_id in self._paired_users

    def _is_allowed_group(self, chat_id: int) -> bool:
        """Check if a group chat is in the allowlist."""
        return chat_id in self._allowed_groups

    def _is_bot_mentioned(self, text: str) -> bool:
        """Check if the bot is @-mentioned in the text."""
        if not self._bot:
            return False
        bot_username = self._bot.bot_username
        if not bot_username:
            return False
        return f"@{bot_username}" in text

    def _strip_mention(self, text: str) -> str:
        """Remove the @bot_username mention from text."""
        if self._bot and self._bot.bot_username:
            text = text.replace(f"@{self._bot.bot_username}", "").strip()
        return text

    # ------------------------------------------------------------------
    # Pairing persistence
    # ------------------------------------------------------------------

    async def _pair_user(self, user_id: int, chat_id: int) -> None:
        """Persist a paired user to the in-memory set and Core KV."""
        self._paired_users.add(user_id)
        try:
            await self._core.set_kv(
                _KV_PAIRED_USERS,
                json.dumps(sorted(self._paired_users)),
            )
        except Exception as exc:
            log.warning(
                "telegram.pair.persist_failed",
                extra={"user_id": user_id, "error": str(exc)},
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def send_reminder_plan(self, chat_id: int, plan: dict) -> None:
        """Send a formatted reminder plan with Edit/Delete buttons to a chat.

        Shared by /remember (Telegram) and D2D handler — same UX everywhere.
        """
        if not plan or not plan.get("reminders") or not self._bot:
            return

        import datetime as _dt
        import urllib.parse

        lines = []
        buttons = []
        for idx, r in enumerate(plan["reminders"], 1):
            fire = r.get("fire_at", "")
            msg = r.get("message", "")
            short_id = r.get("short_id", "?")
            rem_id = r.get("id", "")
            time_str = _format_local_time(fire)
            emoji = {"birthday": "🎂", "appointment": "📅",
                     "payment_due": "💳", "deadline": "⏰"}.get(
                         r.get("kind", ""), "🔔")
            lines.append(f"\\[{short_id}] {emoji} {time_str} — {msg}")
            if rem_id:
                edit_text = f"/edit {short_id} {time_str} — {msg}"
                buttons.append([
                    InlineKeyboardButton(
                        f"🗑 Delete [{short_id}]",
                        callback_data=f"reminder_delete:{rem_id}",
                    ),
                    InlineKeyboardButton(
                        f"✏️ Edit [{short_id}]",
                        switch_inline_query_current_chat=edit_text,
                    ),
                ])

        keyboard = InlineKeyboardMarkup(buttons) if buttons else None
        text = "*Reminders set:*\n" + "\n".join(lines)
        await self._bot.send_message(chat_id, text, parse_mode="Markdown",
                                     reply_markup=keyboard)

    @staticmethod
    def _extract_response(result: dict) -> str:
        """Extract the human-readable response from a Guardian result."""
        # Guardian returns different shapes depending on event type.
        # For "reason" events: {"content": "...", "model": "..."}
        # For other events: {"action": ..., "response": str | dict}
        content = result.get("content", "")
        if content:
            return str(content)
        response = result.get("response", "")
        if isinstance(response, dict):
            return response.get("text", response.get("answer", str(response)))
        return str(response) if response else ""

    async def _store_message(self, update: Update, text: str) -> None:
        """Store the message exchange via staging for memory/context.

        Uses staging_ingest with ingress_channel=telegram so that
        Brain classifies and enriches the item before it reaches vault.
        Brain is a trusted service — Core allows it to set ingress_channel.
        """
        if not update.effective_user:
            return
        try:
            await self._core.staging_ingest({
                "type": "message",
                "source": "telegram",
                "source_id": f"tg_{update.update_id}",
                "summary": text[:200],
                "body": text,
                "sender": str(update.effective_user.id),
                "metadata": json.dumps({"timestamp": int(time.time())}),
                "ingress_channel": "telegram",
                "origin_kind": "user",
            })
        except Exception as exc:
            log.debug(
                "telegram.store_failed",
                extra={"error": str(exc)},
            )

    # ── Trust Network Commands (/vouch, /review, /flag, /trust) ──────────

    async def handle_status(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/status — show your Dina's identity and health."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        result = await self._cmds.get_status()
        if not result.ok:
            await ch.send(ErrorResponse(text=result.message))
            return
        d = result.data
        lines = [
            "*Your Dina*",
            f"DID: `{d['did']}`",
            f"Status: {d['status']}",
            f"Version: {d['version']}",
        ]
        await ch.send(RichResponse(text="\n".join(lines)))

    async def handle_vouch(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/vouch Name: reason — vouch for a contact on the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await ch.send(BotResponse(
                text="Usage: /vouch Name: reason\n"
                "Example: /vouch Sancho: Known him for 10 years, trustworthy"
            ))
            return

        name, reason = text.split(":", 1)
        name = name.strip()
        reason = reason.strip()

        # Validate inputs
        err = validate_name(name)
        if err:
            await ch.send(ErrorResponse(text=err))
            return

        # Resolve contact name → DID
        did = await self._cmds.resolve_contact_did(name)
        if not did:
            await ch.send(ErrorResponse(text=f"Contact '{name}' not found."))
            return

        self._pending_trust = {"cmd": "vouch", "name": name, "text": reason}
        await ch.send(ConfirmResponse(
            text=f"Vouch for *{_escape_markdown(name)}*:\n_{_escape_markdown(reason)}_\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm", data={"callback_data": f"trust_yes:{did[:20]}"}),
                ConfirmOption(label="Cancel", action="cancel", data={"callback_data": "trust_no"}),
            ],
        ))

    async def handle_review(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/review Product: review text — publish a product review to the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await ch.send(BotResponse(
                text="Usage: /review Product: your review\n"
                "Example: /review Aeron Chair: Fixed my back pain in 2 weeks"
            ))
            return

        product, review = text.split(":", 1)
        product = product.strip()
        review = review.strip()

        # Validate product name
        err = validate_name(product)
        if err:
            await ch.send(ErrorResponse(text=err))
            return

        self._pending_trust = {"cmd": "review", "product": product, "text": review}
        await ch.send(ConfirmResponse(
            text=f"Review of *{_escape_markdown(product)}*:\n_{_escape_markdown(review)}_\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm", data={"callback_data": "trust_yes:review"}),
                ConfirmOption(label="Cancel", action="cancel", data={"callback_data": "trust_no"}),
            ],
        ))

    async def handle_flag(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/flag DID_or_name: reason — flag a bad actor on the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await ch.send(BotResponse(
                text="Usage: /flag Name: reason\n"
                "Example: /flag ScamSeller: Sent counterfeit product"
            ))
            return

        target, reason = text.split(":", 1)
        target = target.strip()
        reason = reason.strip()

        # Validate target — either a name or a DID
        if target.startswith("did:"):
            err = validate_did(target)
        else:
            err = validate_name(target)
        if err:
            await ch.send(ErrorResponse(text=err))
            return

        # Try to resolve as contact name, otherwise treat as DID
        did = await self._cmds.resolve_contact_did(target)
        if not did and target.startswith("did:"):
            did = target

        if not did:
            await ch.send(ErrorResponse(text=f"Could not resolve '{target}'. Use a contact name or DID."))
            return

        self._pending_trust = {"cmd": "flag", "target": target, "text": reason}
        await ch.send(ConfirmResponse(
            text=f"Flag *{_escape_markdown(target)}*:\n_{_escape_markdown(reason)}_\n\nPublish to Trust Network?",
            options=[
                ConfirmOption(label="Publish", action="confirm", data={"callback_data": "trust_yes:flag"}),
                ConfirmOption(label="Cancel", action="cancel", data={"callback_data": "trust_no"}),
            ],
        ))

    async def handle_trust(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/trust Name_or_DID — query trust score (read-only, no publish)."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        text = " ".join(context.args) if context.args else ""
        if not text:
            await ch.send(BotResponse(
                text="Usage: /trust Name or DID\n"
                "Example: /trust Sancho"
            ))
            return

        result = await self._cmds.query_trust(text)
        if not result.ok:
            await ch.send(ErrorResponse(text=result.message))
            return

        d = result.data
        await ch.send(BotResponse(
            text=f"Trust: *{_escape_markdown(d['display_name'])}*\n"
            f"Score: {d['score']}\n"
            f"Attestations: {d['total_attestations']} ({d['positive_attestations']} positive)\n"
            f"Vouches: {d['vouch_count']}",
        ))

    async def _handle_trust_callback(self, update: Update, ch: Any) -> None:
        """Handle Publish/Cancel callback for trust commands."""
        query = update.callback_query
        await query.answer()
        data = query.data or ""

        if data == "trust_no":
            await ch.edit(BotResponse(text="Cancelled."))
            self._pending_trust = None
            return

        if not data.startswith("trust_yes:"):
            return

        pending = getattr(self, "_pending_trust", None)
        if not pending:
            await ch.edit(BotResponse(text="Nothing to publish (expired)."))
            return

        cmd = pending["cmd"]
        try:
            if cmd == "vouch":
                result = await self._cmds.publish_vouch(
                    name=pending["name"], reason=pending["text"],
                )
            elif cmd == "review":
                result = await self._cmds.publish_review(
                    product=pending["product"], review_text=pending["text"],
                )
            elif cmd == "flag":
                result = await self._cmds.publish_flag(
                    target=pending["target"], reason=pending["text"],
                )
            else:
                await ch.edit(ErrorResponse(text="Unknown command."))
                self._pending_trust = None
                return

            if result.ok:
                uri = result.data.get("uri", "?") if result.data else "?"
                await ch.edit(RichResponse(
                    text=f"{result.message}\nURI: `{uri}`",
                ))
            else:
                await ch.edit(ErrorResponse(text=result.message))
        except Exception as exc:
            await ch.edit(ErrorResponse(text=f"Publish failed: {exc}"))
            log.warning("trust_publish_failed", extra={"cmd": cmd, "error": str(exc)})
        finally:
            self._pending_trust = None

    # ── Contact Management (/contact) ──────────────────────────────────

    async def handle_contact(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/contact add|delete|list — manage your contacts."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        ch = self._ch(context)
        args = context.args or []
        if not args:
            await ch.send(BotResponse(
                text="Supported actions:\n"
                "  /contact add Name: did:plc:...\n"
                "  /contact delete Name\n"
                "  /contact list\n"
                "  /contact cleanup"
            ))
            return

        action = args[0].lower()

        if action == "list":
            result = await self._cmds.list_contacts()
            if not result.ok:
                await ch.send(ErrorResponse(text=result.message))
                return
            contacts = result.data["contacts"]
            if not contacts:
                await ch.send(BotResponse(text="No contacts."))
                return
            lines = []
            for c in contacts:
                name = c.get("display_name", "") or c.get("name", "?")
                did = c.get("did", "?")
                trust = c.get("trust_level", "")
                lines.append(f"  {name} — `{did[:35]}...` {trust}")
            await ch.send(RichResponse(
                text=f"*Contacts ({len(contacts)}):*\n" + "\n".join(lines),
            ))
            return

        if action == "add":
            rest = " ".join(args[1:])
            if ":" not in rest or not rest.split(":", 1)[1].strip().startswith("did:"):
                await ch.send(BotResponse(
                    text="Usage: /contact add Name: did:plc:...\n"
                    "Example: /contact add Sancho: did:plc:abc123"
                ))
                return
            name, did = rest.split(":", 1)
            name = name.strip()
            did = did.strip()
            result = await self._cmds.add_contact(name, did)
            if result.ok:
                await ch.send(RichResponse(
                    text=f"Contact added: *{_escape_markdown(name)}* (`{did[:30]}...`)",
                ))
            else:
                await ch.send(ErrorResponse(text=result.message))
            return

        if action in ("delete", "remove"):
            if len(args) < 2:
                await ch.send(BotResponse(text="Usage: /contact delete Name"))
                return
            name = " ".join(args[1:])
            result = await self._cmds.delete_contact(name)
            await ch.send(BotResponse(text=result.message))
            return

        if action == "cleanup":
            result = await self._cmds.cleanup_contacts()
            await ch.send(BotResponse(text=result.message))
            return

        await ch.send(BotResponse(
            text="Supported actions:\n"
            "  /contact add Name: did:plc:...\n"
            "  /contact delete Name\n"
            "  /contact list\n"
            "  /contact cleanup"
        ))
