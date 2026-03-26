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

from ..port.core_client import CoreClient

log = logging.getLogger(__name__)

# Core KV key for persisting paired Telegram user IDs.
_KV_PAIRED_USERS = "telegram_paired_users"

# Telegram Markdown V1 special characters that need escaping.
_MD_ESCAPE_CHARS = r"_*`["


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
    ) -> None:
        self._guardian = guardian
        self._core = core
        self._allowed_users: set[int] = allowed_user_ids or set()
        self._allowed_groups: set[int] = allowed_group_ids or set()
        self._paired_users: set[int] = set()
        self._bot: Any = None  # Set via set_bot() after construction

    _pds_publisher: Any = None  # Set externally after construction

    def set_bot(self, bot: Any) -> None:
        """Inject the bot adapter reference (for outbound nudges).

        Called by the composition root after both service and adapter
        are constructed.
        """
        self._bot = bot

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

        if user_id in self._paired_users:
            await update.message.reply_text(  # type: ignore[union-attr]
                "You're already paired. Send me a message and I'll help."
            )
            return

        if user_id not in self._allowed_users:
            log.info(
                "telegram.start.rejected",
                extra={"user_id": user_id, "username": username},
            )
            await update.message.reply_text(  # type: ignore[union-attr]
                "Sorry, I can only chat with my owner. "
                "Ask them to add your Telegram user ID to the allowed list."
            )
            return

        # Pair the user.
        await self._pair_user(user_id, chat_id)
        log.info(
            "telegram.start.paired",
            extra={"user_id": user_id, "username": username},
        )
        await update.message.reply_text(  # type: ignore[union-attr]
            "Welcome! You're now paired with Dina. "
            "Send me any message and I'll think about it."
        )

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

        user_id = update.effective_user.id
        if not self._is_allowed_user(user_id):
            await update.message.reply_text(
                "I don't recognise you yet. Send /start to pair."
            )
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
            await update.message.reply_text(
                "Usage: /remember <text>\n"
                "Example: /remember My FD interest rate is now 7.8%"
            )
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

            # Poll staging status by ID (same contract as CLI's remember-status).
            # Core triggers Brain drain after ingest; we wait for terminal state.
            result_msg = "Noted."
            for _ in range(30):  # up to ~30 seconds (pro model is slower)
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
                    # received, classifying — still processing, continue polling
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
                            try:
                                import datetime as _dt
                                dt = _dt.datetime.fromisoformat(fire.replace("Z", "+00:00"))
                                time_str = dt.strftime("%b %d, %I:%M %p")
                            except Exception:
                                time_str = fire
                            emoji = {"birthday": "🎂", "appointment": "📅",
                                     "payment_due": "💳", "deadline": "⏰"}.get(
                                         r.get("kind", ""), "🔔")
                            reminder_lines.append(f"{emoji} {time_str} — {msg}")
                except Exception as _exc:
                    log.debug("telegram.suppressed_error", exc_info=_exc)

            if plan and plan.get("reminders"):
                await update.message.reply_text(result_msg, parse_mode="Markdown")
                await self.send_reminder_plan(update.effective_chat.id, plan)
            else:
                await update.message.reply_text(result_msg, parse_mode="Markdown")
        except Exception as exc:
            log.error(
                "telegram.remember_failed",
                extra={"error": f"{type(exc).__name__}: {exc}"},
            )
            await update.message.reply_text(
                "Sorry, I couldn't save that. Please try again."
            )

    # ------------------------------------------------------------------
    # /edit command (reminder editing)
    # ------------------------------------------------------------------

    async def handle_edit(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /edit command from Telegram command handler."""
        if not update.effective_user or not update.message:
            return
        text = (update.message.text or "").strip()
        if text.lower().startswith("/edit"):
            text = text[len("/edit"):].strip()
        await self._process_edit(update, f"/edit {text}" if text else "/edit")

    async def _process_edit(self, update: Update, raw_text: str) -> None:
        """Process an edit command — accepts raw text including /edit prefix."""
        if not update.message:
            return
        text = raw_text.strip()
        if text.lower().startswith("/edit"):
            text = text[len("/edit"):].strip()
        if not text:
            await update.message.reply_text(
                "Usage: /edit <reminder_id> <new time — new message>"
            )
            return

        # Parse: first token is short reminder ID, rest is the edited text.
        parts = text.split(None, 1)
        if len(parts) < 2:
            await update.message.reply_text(
                "Usage: /edit <id> <new time — new message>"
            )
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
            await update.message.reply_text(f"Reminder `{short_id}` not found.")
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

            time_str = dt.strftime("%b %d, %I:%M %p")
            await update.message.reply_text(
                f"✏️ Reminder updated:\n{time_str} — {message}"
            )
        except Exception as exc:
            log.warning("telegram.edit_failed", extra={"error": str(exc)})
            await update.message.reply_text(
                "Could not parse the edit. Try: /edit <id> Apr 5, 3:00 PM — New message"
            )

    # ------------------------------------------------------------------
    # /send command (D2D messaging)
    # ------------------------------------------------------------------

    async def handle_send(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle /send <contact> <message> — send a D2D message.

        Resolves the contact name to a DID, asks the LLM to classify
        the message type and structure the body, then sends via Core.
        """
        if not update.effective_user or not update.message:
            return

        user_id = update.effective_user.id
        if not self._is_allowed_user(user_id):
            await update.message.reply_text(
                "I don't recognise you yet. Send /start to pair."
            )
            return

        text = (update.message.text or "").strip()
        if text.lower().startswith("/send"):
            text = text[len("/send"):].strip()
        if ":" not in text:
            await update.message.reply_text(
                "Usage: /send Name: message\n"
                "Example: /send Sancho: I'll be there in 30 minutes"
            )
            return

        # Parse: everything before colon is contact name, after is message.
        colon_pos = text.index(":")
        contact_name = text[:colon_pos].strip()
        message_text = text[colon_pos + 1:].strip()
        if not contact_name or not message_text:
            await update.message.reply_text(
                "Usage: /send Name: message\n"
                "Example: /send Sancho: I'll be there in 30 minutes"
            )
            return

        # 1. Resolve contact name → DID.
        contact_did = None
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            for c in resp.json().get("contacts", []):
                if c.get("name", "").lower() == contact_name.lower():
                    contact_did = c.get("did")
                    contact_name = c.get("name")  # use canonical case
                    break
        except Exception as _exc:
            log.debug("telegram.suppressed_error", exc_info=_exc)

        if not contact_did:
            await update.message.reply_text(
                f"Contact '{contact_name}' not found. Check your contacts."
            )
            return

        # 2. Ask LLM to classify the message type and structure the body.
        try:
            import datetime as _dt
            now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            classify_prompt = (
                f"You are classifying a Dina-to-Dina message.\n"
                f"Today: {now}\n"
                f"Sender wants to tell {contact_name}: \"{message_text}\"\n\n"
                f"Classify into one of these v1 message types and structure the body:\n"
                f"- presence.signal: status updates, arriving, leaving, ETA\n"
                f"  Body: {{\"status\": \"arriving|leaving|delayed\", \"eta_minutes\": N, \"location_label\": \"...\"}}\n"
                f"- coordination.request: proposing plans, asking availability\n"
                f"  Body: {{\"action\": \"propose_time|ask_availability|ask_confirmation\", \"context\": \"...\"}}\n"
                f"- coordination.response: accepting, declining plans\n"
                f"  Body: {{\"action\": \"accept|decline|counter_propose\", \"note\": \"...\"}}\n"
                f"- social.update: sharing life events, personal news\n"
                f"  Body: {{\"text\": \"...\", \"category\": \"life_event|context|profile\"}}\n"
                f"- safety.alert: warnings about scams, compromised accounts\n"
                f"  Body: {{\"message\": \"...\", \"severity\": \"low|medium|high|critical\"}}\n\n"
                f"Respond with JSON only:\n"
                f"{{\"type\": \"<message_type>\", \"body\": {{...}}}}"
            )
            resp = await self._guardian._llm.route(
                task_type="classification",
                prompt=classify_prompt,
                messages=[
                    {"role": "system", "content": "Classify D2D message type. JSON only."},
                    {"role": "user", "content": classify_prompt},
                ],
            )
            import json as _json
            raw = resp.get("content", "").strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            classified = _json.loads(raw)
            msg_type = classified.get("type", "social.update")
            body = classified.get("body", {"text": message_text})
        except Exception:
            # Fallback: send as social.update.
            msg_type = "social.update"
            body = {"text": message_text, "category": "context"}

        # 3. Send via Core.
        try:
            import base64
            body_b64 = base64.b64encode(
                json.dumps(body).encode()
            ).decode()
            await self._core._request("POST", "/v1/msg/send", json={
                "to": contact_did,
                "body": body_b64,
                "type": msg_type,
            })
            # Confirm to user.
            type_label = {
                "presence.signal": "📬 Presence",
                "coordination.request": "📅 Coordination",
                "coordination.response": "📅 Response",
                "social.update": "💬 Social update",
                "safety.alert": "🚨 Safety alert",
                "trust.vouch.request": "🤝 Trust request",
            }.get(msg_type, msg_type)
            await update.message.reply_text(
                f"Sent to {contact_name}: {type_label}\n{message_text}"
            )
        except Exception as exc:
            error_msg = str(exc)
            if "not a contact" in error_msg:
                await update.message.reply_text(f"{contact_name} is not in your contacts.")
            elif "egress blocked" in error_msg:
                await update.message.reply_text(f"Sending to {contact_name} is blocked by your policy.")
            else:
                log.warning("telegram.send_failed", extra={"contact": contact_name, "error": error_msg})
                await update.message.reply_text(f"Could not deliver message to {contact_name}. Please try again later.")

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

        user_id = update.effective_user.id
        chat_id = update.effective_chat.id

        if not self._is_allowed_user(user_id):
            await update.message.reply_text(
                "I don't recognise you yet. Send /start to pair."
            )
            return

        if user_id not in self._paired_users:
            await self._pair_user(user_id, chat_id)

        text = (update.message.text or "").strip()
        if text.lower().startswith("/ask"):
            text = text[len("/ask"):].strip()
        if not text:
            await update.message.reply_text(
                "Usage: /ask <question>\n"
                "Example: /ask What is my FD status?"
            )
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
                await update.message.reply_text(response_text)
        except Exception as exc:
            log.error(
                "telegram.ask_failed",
                extra={"error": type(exc).__name__, "chat_id": chat_id},
            )
            await update.message.reply_text(
                "Something went wrong. Please try again."
            )

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
                await update.message.reply_text(
                    "I don't recognise you yet. Send /start to pair."
                )
                return
            # Auto-pair allowed users on first DM so they receive
            # outbound notifications (approvals, nudges) without
            # needing an explicit /start.
            if user_id not in self._paired_users:
                await self._pair_user(user_id, chat_id)

        # --- Check for approval response (approve/deny via text) ---
        approval_response = await self.handle_approval_response(text)
        if approval_response:
            await update.message.reply_text(approval_response, parse_mode="Markdown")
            return

        # --- Handle inline edit from switch_inline_query_current_chat ---
        # The text arrives as "@botname /edit <id> <time> — <msg>"
        stripped = text
        if self._bot and self._bot.bot_username:
            stripped = stripped.replace(f"@{self._bot.bot_username}", "").strip()
        if stripped.startswith("/edit"):
            # Can't modify update.message.text (immutable) — call edit directly.
            await self._process_edit(update, stripped)
            return

        # --- No default action — guide the user ---
        await update.message.reply_text(
            "Here's what I can do:\n\n"
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
            parse_mode="Markdown",
        )

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

        data = query.data

        # Handle reminder buttons.
        if data.startswith("reminder_delete:"):
            rem_id = data[len("reminder_delete:"):]
            try:
                await self._core._request("DELETE", f"/v1/reminder/{rem_id}")
                if query.message:
                    await query.message.reply_text("🗑 Reminder deleted.")
            except Exception:
                if query.message:
                    await query.message.reply_text("Failed to delete reminder.")
            return

        # Trust publish buttons (Publish / Cancel).
        if data.startswith("trust_yes:") or data == "trust_no":
            await self._handle_trust_callback(update)
            return

        # Edit button uses switch_inline_query_current_chat — no callback needed.

        # Handle approval buttons.
        response = await self.handle_approval_response(data)
        if response and query.message:
            try:
                original_text = query.message.text or ""
                await query.message.edit_text(
                    f"{original_text}\n\n{response}",
                    parse_mode="Markdown",
                )
            except Exception:
                await query.message.reply_text(response, parse_mode="Markdown")

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
            try:
                dt = _dt.datetime.fromisoformat(fire.replace("Z", "+00:00"))
                time_str = dt.strftime("%b %d, %I:%M %p")
            except Exception:
                time_str = fire
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
        try:
            resp = await self._core._request("GET", "/healthz")
            health = resp.json()
            # Get DID from /v1/did
            try:
                did_resp = await self._core._request("GET", "/v1/did")
                did_doc = did_resp.json()
                did = did_doc.get("id", "unknown")
            except Exception:
                did = "unknown"

            lines = [
                f"*Your Dina*",
                f"DID: `{did}`",
                f"Status: {health.get('status', '?')}",
                f"Version: {health.get('version', '?')}",
            ]
            await update.message.reply_text("\n".join(lines), parse_mode="Markdown")
        except Exception as exc:
            await update.message.reply_text(f"Failed: {exc}")

    async def handle_vouch(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/vouch Name: reason — vouch for a contact on the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await update.message.reply_text(
                "Usage: /vouch Name: reason\n"
                "Example: /vouch Sancho: Known him for 10 years, trustworthy"
            )
            return

        name, reason = text.split(":", 1)
        name = name.strip()
        reason = reason.strip()

        # Resolve contact name → DID
        did = await self._resolve_contact_did(name)
        if not did:
            await update.message.reply_text(f"Contact '{name}' not found.")
            return

        # Confirmation
        cb_data = json.dumps({"act": "trust_publish", "cmd": "vouch", "did": did, "name": name, "text": reason})
        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("Publish", callback_data=f"trust_yes:{did[:20]}"),
            InlineKeyboardButton("Cancel", callback_data="trust_no"),
        ]])
        # Store pending publish in memory for callback
        self._pending_trust = {"cmd": "vouch", "did": did, "name": name, "text": reason}
        await update.message.reply_text(
            f"Vouch for *{_escape_markdown(name)}*:\n_{_escape_markdown(reason)}_\n\nPublish to Trust Network?",
            parse_mode="Markdown",
            reply_markup=keyboard,
        )

    async def handle_review(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/review Product: review text — publish a product review to the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await update.message.reply_text(
                "Usage: /review Product: your review\n"
                "Example: /review Aeron Chair: Fixed my back pain in 2 weeks"
            )
            return

        product, review = text.split(":", 1)
        product = product.strip()
        review = review.strip()

        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("Publish", callback_data=f"trust_yes:review"),
            InlineKeyboardButton("Cancel", callback_data="trust_no"),
        ]])
        self._pending_trust = {"cmd": "review", "product": product, "text": review}
        await update.message.reply_text(
            f"Review of *{_escape_markdown(product)}*:\n_{_escape_markdown(review)}_\n\nPublish to Trust Network?",
            parse_mode="Markdown",
            reply_markup=keyboard,
        )

    async def handle_flag(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/flag DID_or_name: reason — flag a bad actor on the Trust Network."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        text = " ".join(context.args) if context.args else ""
        if ":" not in text:
            await update.message.reply_text(
                "Usage: /flag Name: reason\n"
                "Example: /flag ScamSeller: Sent counterfeit product"
            )
            return

        target, reason = text.split(":", 1)
        target = target.strip()
        reason = reason.strip()

        # Try to resolve as contact name, otherwise treat as DID
        did = await self._resolve_contact_did(target)
        if not did and target.startswith("did:"):
            did = target

        if not did:
            await update.message.reply_text(f"Could not resolve '{target}'. Use a contact name or DID.")
            return

        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("Publish", callback_data=f"trust_yes:flag"),
            InlineKeyboardButton("Cancel", callback_data="trust_no"),
        ]])
        self._pending_trust = {"cmd": "flag", "did": did, "target": target, "text": reason}
        await update.message.reply_text(
            f"Flag *{_escape_markdown(target)}*:\n_{_escape_markdown(reason)}_\n\nPublish to Trust Network?",
            parse_mode="Markdown",
            reply_markup=keyboard,
        )

    async def handle_trust(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/trust Name_or_DID — query trust score (read-only, no publish)."""
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        text = " ".join(context.args) if context.args else ""
        if not text:
            await update.message.reply_text(
                "Usage: /trust Name or DID\n"
                "Example: /trust Sancho"
            )
            return

        # Resolve name → DID
        did = await self._resolve_contact_did(text.strip())
        if not did and text.strip().startswith("did:"):
            did = text.strip()
        if not did:
            await update.message.reply_text(f"Could not resolve '{text.strip()}'.")
            return

        # Query trust profile from AppView via Core
        try:
            profile = await self._core.query_trust_profile(did)
        except Exception:
            profile = None

        if not profile:
            await update.message.reply_text(f"No trust data found for {text.strip()}.")
            return

        score = profile.get("overallTrustScore", "?")
        atts = profile.get("attestationSummary", {})
        total = atts.get("total", 0)
        pos = atts.get("positive", 0)
        vouches = profile.get("vouchCount", 0)

        await update.message.reply_text(
            f"Trust: *{_escape_markdown(text.strip())}*\n"
            f"Score: {score}\n"
            f"Attestations: {total} ({pos} positive)\n"
            f"Vouches: {vouches}",
            parse_mode="Markdown",
        )

    async def _handle_trust_callback(self, update: Update) -> None:
        """Handle Publish/Cancel callback for trust commands."""
        query = update.callback_query
        await query.answer()
        data = query.data or ""

        if data == "trust_no":
            await query.edit_message_text("Cancelled.")
            self._pending_trust = None
            return

        if not data.startswith("trust_yes:"):
            return

        pending = getattr(self, "_pending_trust", None)
        if not pending:
            await query.edit_message_text("Nothing to publish (expired).")
            return

        if not self._pds_publisher:
            await query.edit_message_text("Trust publishing not configured (no PDS connection).")
            self._pending_trust = None
            return

        cmd = pending["cmd"]
        try:
            if cmd == "vouch":
                result = await self._pds_publisher.publish_vouch(
                    subject_did=pending["did"],
                    text=pending["text"],
                )
                await query.edit_message_text(
                    f"Published vouch for {pending['name']}.\n"
                    f"URI: `{result.get('uri', '?')}`",
                    parse_mode="Markdown",
                )
            elif cmd == "review":
                result = await self._pds_publisher.publish_review(
                    subject_name=pending["product"],
                    text=pending["text"],
                )
                await query.edit_message_text(
                    f"Published review of {pending['product']}.\n"
                    f"URI: `{result.get('uri', '?')}`",
                    parse_mode="Markdown",
                )
            elif cmd == "flag":
                result = await self._pds_publisher.publish_flag(
                    subject_did=pending["did"],
                    text=pending["text"],
                )
                await query.edit_message_text(
                    f"Flagged {pending['target']}.\n"
                    f"URI: `{result.get('uri', '?')}`",
                    parse_mode="Markdown",
                )
        except Exception as exc:
            await query.edit_message_text(f"Publish failed: {exc}")
            log.warning("trust_publish_failed", extra={"cmd": cmd, "error": str(exc)})
        finally:
            self._pending_trust = None

    # ── Contact Management (/contact) ──────────────────────────────────

    async def handle_contact(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE,
    ) -> None:
        """/contact add|delete|list — manage your contacts.

        Usage:
          /contact add Name did:plc:xyz
          /contact delete Name
          /contact list
        """
        if not update.effective_user or not self._is_allowed_user(update.effective_user.id):
            return
        args = context.args or []
        if not args:
            await update.message.reply_text(
                "Usage:\n"
                "  /contact add Name did:plc:...\n"
                "  /contact delete Name\n"
                "  /contact list"
            )
            return

        action = args[0].lower()

        if action == "list":
            try:
                resp = await self._core._request("GET", "/v1/contacts")
                contacts = resp.json().get("contacts", [])
                if not contacts:
                    await update.message.reply_text("No contacts.")
                    return
                lines = []
                for c in contacts:
                    name = c.get("display_name", "") or c.get("name", "?")
                    did = c.get("did", "?")
                    trust = c.get("trust_level", "")
                    lines.append(f"  {name} — `{did[:35]}...` {trust}")
                await update.message.reply_text(
                    f"*Contacts ({len(contacts)}):*\n" + "\n".join(lines),
                    parse_mode="Markdown",
                )
            except Exception as exc:
                await update.message.reply_text(f"Failed: {exc}")
            return

        if action == "add":
            # Parse "add Name: did:plc:..." (colon separator, consistent with /send)
            rest = " ".join(args[1:])
            if ":" not in rest or not rest.split(":", 1)[1].strip().startswith("did:"):
                await update.message.reply_text(
                    "Usage: /contact add Name: did:plc:...\n"
                    "Example: /contact add Sancho: did:plc:abc123"
                )
                return
            name, did = rest.split(":", 1)
            name = name.strip()
            did = did.strip()
            if not did.startswith("did:"):
                await update.message.reply_text("DID must start with did:")
                return
            # Check if contact with this name already exists
            existing = await self._resolve_contact_did(name)
            if existing:
                await update.message.reply_text(f"Contact '{name}' already exists. Use a different name or /contact delete {name} first.", parse_mode="Markdown")
                return
            try:
                await self._core._request(
                    "POST", "/v1/contacts",
                    json={"did": did, "name": name, "trust_level": "verified"},
                )
                await update.message.reply_text(f"Contact added: *{_escape_markdown(name)}* (`{did[:30]}...`)", parse_mode="Markdown")
            except Exception as exc:
                await update.message.reply_text(f"Failed: {exc}")
            return

        if action == "delete" or action == "remove":
            if len(args) < 2:
                await update.message.reply_text("Usage: /contact delete Name")
                return
            name = args[1]
            # Find DID by name — include broken entries (any DID format)
            did = None
            try:
                resp = await self._core._request("GET", "/v1/contacts")
                for c in resp.json().get("contacts", []):
                    display = c.get("display_name", "") or c.get("name", "")
                    if display.lower() == name.lower() and c.get("did"):
                        did = c["did"]
                        break
            except Exception:
                pass
            if not did:
                await update.message.reply_text(f"Contact '{name}' not found.")
                return
            try:
                await self._core._request("DELETE", f"/v1/contacts/{did}")
                await update.message.reply_text(f"Deleted: {name}")
            except Exception as exc:
                await update.message.reply_text(f"Failed: {exc}")
            return

        await update.message.reply_text(
            "Unknown action. Use: add, delete, or list"
        )

    async def _resolve_contact_did(self, name: str) -> str | None:
        """Resolve a contact display name to a DID."""
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            contacts = resp.json().get("contacts", [])
            for c in contacts:
                display = c.get("display_name", "") or c.get("name", "")
                did = c.get("did", "")
                # Skip invalid entries (must be a proper DID)
                if display.lower() == name.lower() and did.startswith("did:plc:"):
                    return did
        except Exception:
            pass
        return None
