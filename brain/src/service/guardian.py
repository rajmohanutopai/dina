"""The Guardian Angel Loop — Dina's core reasoning engine.

The guardian loop is the central event processor.  Every event arriving
at brain passes through it:

    1. **Silence classification** — decide whether to interrupt, notify,
       or stay silent (The Four Laws, Law 1: Silence First).
    2. **Event processing** — assemble context, reason, and decide on
       an action (nudge, briefing, intent review, etc.).
    3. **Crash recovery** — checkpoint multi-step reasoning to the
       scratchpad so work can resume after a restart.

Key design principles:

    - **Silence First**: default to ``engagement`` when classification
      is ambiguous.  Never push content unless it is fiduciary.
    - **Anti-Her**: never simulate emotional intimacy.  When the human
      needs connection, connect them to other humans.
    - **Draft-Don't-Send**: never call ``messages.send`` — only draft.
    - **Cart Handover**: never touch money.  Hand control back to user.

Maps to Brain TEST_PLAN SS2 (Guardian Loop).

No imports from adapter/ — only port protocols, domain types, and
sibling services.
"""

from __future__ import annotations

import re
import traceback
from typing import Any

import structlog

from ..domain.enums import IntentRisk, Priority, SilenceDecision
from ..domain.errors import CoreUnreachableError, DinaError, PersonaLockedError
from ..port.core_client import CoreClient
from ..port.scrubber import PIIScrubber

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Keyword / source heuristics for silence classification
# ---------------------------------------------------------------------------

_FIDUCIARY_KEYWORDS = re.compile(
    r"(?:cancel|cancell?ed|security alert|unusual login|sign-in|overdr(?:aft|awn)|"
    r"critical|emergency|alarm|smoke|fire|breach|fraud|overdraft|suspend|"
    r"lab result|potassium|health critical|payment due)",
    re.IGNORECASE,
)

_FIDUCIARY_SOURCES = frozenset({
    "security",
    "health_system",
    "bank",
    "emergency",
    "alarm",
})

_SOLICITED_TYPES = frozenset({
    "reminder",
    "search_result",
})

_ENGAGEMENT_TYPES = frozenset({
    "notification",
    "promo",
    "social",
    "rss",
    "podcast",
})

_ENGAGEMENT_SOURCES = frozenset({
    "social_media",
    "rss",
    "podcast",
    "vendor",
})

# Actions that are categorically blocked — Agent Safety Layer.
_BLOCKED_ACTIONS = frozenset({
    "read_vault",
    "export_data",
    "access_keys",
})

# HIGH risk actions — require user review, high severity.
# Financial transactions, data sharing, destructive operations.
_HIGH_ACTIONS = frozenset({
    "transfer_money",
    "share_data",
    "delete_data",
    "sign_contract",
})

# MODERATE risk actions — require user review, moderate severity.
# Communication, payments via established channels, location sharing.
_MODERATE_ACTIONS = frozenset({
    "send_email",
    "draft_email",
    "draft_create",
    "pay_upi",
    "pay_crypto",
    "web_checkout",
    "share_location",
    "send_message",
    "install_extension",
    "form_fill",
    "calendar_create",
})

# DIDComm message type prefixes and their handlers.
_DIDCOMM_HANDLERS: dict[str, str] = {
    "dina/social/": "nudge_assembly",
    "dina/commerce/": "commerce_handler",
    "dina/identity/": "identity_handler",
    "dina/reputation/": "reputation_handler",
}


class GuardianLoop:
    """The Guardian Angel Loop — Dina's central event processor.

    Parameters
    ----------
    core:
        Typed HTTP client for dina-core.
    llm_router:
        Multi-provider LLM routing service.
    scrubber:
        PII scrubber for sanitising crash tracebacks.
    entity_vault:
        Entity vault service for cloud LLM calls.
    nudge_assembler:
        Nudge assembly service for context-injection.
    scratchpad:
        Cognitive checkpointing service for crash recovery.
    """

    def __init__(
        self,
        core: CoreClient,
        llm_router: Any,  # LLMRouter
        scrubber: PIIScrubber,
        entity_vault: Any,  # EntityVaultService
        nudge_assembler: Any,  # NudgeAssembler
        scratchpad: Any,  # ScratchpadService
    ) -> None:
        self._core = core
        self._llm = llm_router
        self._scrubber = scrubber
        self._entity_vault = entity_vault
        self._nudge = nudge_assembler
        self._scratchpad = scratchpad

        # Tracks which personas are currently unlocked.
        self._unlocked_personas: set[str] = set()

        # Engagement-tier items saved for the morning briefing.
        self._briefing_items: list[dict] = []

    # ------------------------------------------------------------------
    # Silence Classification (SS2.1)
    # ------------------------------------------------------------------

    async def classify_silence(self, event: dict) -> str:
        """Classify an event into a Silence-First priority tier.

        Returns one of ``"fiduciary"``, ``"solicited"``, ``"engagement"``,
        or ``"silent"`` (for background-only events).

        Rules
        -----
        - Flight cancellation, security alerts, health critical, financial
          overdraft -> fiduciary.
        - User-requested reminders, search results -> solicited.
        - Podcast, social media, promos -> engagement.
        - Unknown / ambiguous -> engagement (Silence First default).
        - ``background_sync`` -> ``"silent"`` (log only, no notification).
        - Composite heuristic: trusted sender + urgent keyword -> fiduciary;
          unknown sender + urgent keyword -> NOT fiduciary.
        - Fiduciary overrides DND; solicited is deferred during DND;
          engagement never interrupts.
        """
        event_type = event.get("type", "")
        body = event.get("body", "")
        source = event.get("source", "")
        priority_hint = event.get("priority", "")

        # Background sync — silent log, no notification.
        if event_type == "background_sync":
            return "silent"

        # Explicit fiduciary hint from the event.
        if priority_hint == "fiduciary":
            return "fiduciary"

        # Source-based fiduciary detection.
        if source in _FIDUCIARY_SOURCES:
            return "fiduciary"

        # Keyword-based fiduciary detection.
        if _FIDUCIARY_KEYWORDS.search(body):
            # Composite heuristic: only escalate to fiduciary if source
            # is trusted.  Unknown senders with urgent keywords stay at
            # solicited (avoids spam-as-fiduciary attacks).
            if source in ("unknown_sender",):
                return "solicited"
            return "fiduciary"

        # Explicit solicited hint.
        if priority_hint == "solicited":
            return "solicited"

        # Type-based solicited detection.
        if event_type in _SOLICITED_TYPES:
            return "solicited"

        # Explicit engagement hint.
        if priority_hint == "engagement":
            return "engagement"

        # Type-based engagement detection.
        if event_type in _ENGAGEMENT_TYPES:
            return "engagement"

        # Source-based engagement detection.
        if source in _ENGAGEMENT_SOURCES:
            return "engagement"

        # Default: engagement (Silence First — when in doubt, stay quiet).
        return "engagement"

    # ------------------------------------------------------------------
    # Event Processing (SS2.2, SS2.3)
    # ------------------------------------------------------------------

    async def process_event(self, event: dict) -> dict:
        """Process an incoming event and return an action decision.

        Steps
        -----
        1. Detect special event types (vault lifecycle, agent intent,
           DIDComm messages).
        2. Classify silence level.
        3. If engagement -> save for briefing, ACK task.
        4. If fiduciary / solicited -> assemble nudge via multi-step
           reasoning, checkpoint to scratchpad, send via core.
        5. ACK task after success; no ACK on failure.

        Returns
        -------
        dict
            Action decision dict with at least an ``action`` key.
        """
        event_type = event.get("type", "")
        task_id = event.get("task_id")

        try:
            # ---- Vault lifecycle events (SS2.2) ----
            if event_type == "vault_unlocked":
                return await self._handle_vault_unlocked(event)

            if event_type == "vault_locked":
                return await self._handle_vault_locked(event)

            if event_type == "persona_unlocked":
                return await self._handle_persona_unlocked(event)

            # ---- Agent intent review (SS2.3) ----
            if event_type == "agent_intent":
                return await self.review_intent(event)

            # ---- LLM reasoning (SS10.3) ----
            if event_type == "reason":
                return await self._handle_reason(event)

            # ---- DIDComm message routing (SS2.8) ----
            if event_type and event_type.startswith("dina/"):
                return await self._handle_didcomm(event)

            # ---- Standard event processing ----
            priority = await self.classify_silence(event)

            if priority == "silent":
                log.info("guardian.silent", event_type=event_type)
                if task_id:
                    await self._ack_task(task_id)
                return {"action": "silent_log", "classification": "silent"}

            if priority == "engagement":
                self._briefing_items.append(event)
                log.info("guardian.engagement_saved", event_type=event_type)
                if task_id:
                    await self._ack_task(task_id)
                return {"action": "save_for_briefing", "classification": "engagement"}

            # Fiduciary or solicited — needs active processing.
            # Checkpoint step 1.
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id, 1, {"priority": priority, "event": event}
                )

            # Assemble nudge context.
            contact_did = event.get("contact_did")
            nudge = await self._nudge.assemble_nudge(event, contact_did)

            # Checkpoint step 2.
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id,
                    2,
                    {"priority": priority, "event": event, "nudge": nudge},
                )

            # Deliver nudge to core for client push.
            if nudge:
                try:
                    await self._core.notify("default", {
                        "type": "nudge",
                        "priority": priority,
                        "nudge": nudge,
                    })
                except Exception:
                    log.warning("guardian.nudge_delivery_failed")

            # ACK task.
            if task_id:
                await self._ack_task(task_id)
                await self._scratchpad.clear(task_id)

            action = "interrupt" if priority == "fiduciary" else "notify"
            return {
                "action": action,
                "priority": priority,
                "classification": priority,
                "nudge": nudge,
            }

        except PersonaLockedError:
            persona_id = event.get("persona_id", "unknown")
            log.warning("guardian.persona_locked", persona_id=persona_id)
            return {
                "action": "whisper_unlock_request",
                "persona_id": persona_id,
            }

        except CoreUnreachableError:
            log.error("guardian.core_unreachable")
            return {"action": "degraded_mode"}

        except Exception as exc:
            # Crash handler (SS13): sanitised one-liner to stdout,
            # full traceback to encrypted vault.
            await self._handle_crash(event, exc, task_id)
            return {"action": "error", "error": type(exc).__name__}

    # ------------------------------------------------------------------
    # Agent Intent Review (SS2.3.3 – SS2.3.7)
    # ------------------------------------------------------------------

    async def review_intent(self, intent: dict) -> dict:
        """Review an agent intent against privacy rules and trust level.

        Classification
        --------------
        - ``SAFE``     -> ``auto_approve`` (e.g. ``fetch_weather``, ``search``).
        - ``MODERATE`` -> ``flag_for_review`` (e.g. ``send_email``, ``draft_email``).
        - ``HIGH``     -> ``flag_for_review`` (e.g. ``transfer_money``, ``share_data``).
        - ``BLOCKED``  -> ``deny`` (e.g. untrusted bot reading vault).

        Returns
        -------
        dict
            Decision dict with ``action``, ``risk``, ``reason``,
            ``approved``, and ``requires_approval`` keys.
        """
        # Support both flat and nested (payload) action fields.
        action = intent.get("action", "")
        if not action and isinstance(intent.get("payload"), dict):
            action = intent["payload"].get("action", "")
        trust_level = intent.get("trust_level", "unknown")
        risk_hint = intent.get("risk_level", "")
        agent_did = intent.get("agent_did", "")

        # ---- Blocked: untrusted + vault access ----
        if trust_level == "untrusted" or action in _BLOCKED_ACTIONS:
            decision = IntentRisk.BLOCKED
            reason = f"Blocked: {action} by {trust_level} agent"
            await self._audit_intent(intent, decision, reason)
            return {
                "action": "deny",
                "risk": decision.value,
                "reason": reason,
                "approved": False,
                "requires_approval": False,
            }

        # ---- HIGH risk: requires user review (high severity) ----
        if action in _HIGH_ACTIONS or risk_hint == "high":
            decision = IntentRisk.HIGH
            reason = f"High-risk action: {action} requires user approval"
            await self._audit_intent(intent, decision, reason)
            return {
                "action": "flag_for_review",
                "risk": decision.value,
                "reason": reason,
                "intent": intent,
                "approved": False,
                "requires_approval": True,
            }

        # ---- MODERATE risk: requires user review ----
        if action in _MODERATE_ACTIONS or risk_hint == "risky":
            decision = IntentRisk.MODERATE
            reason = f"Moderate-risk action: {action} requires user approval"
            await self._audit_intent(intent, decision, reason)
            return {
                "action": "flag_for_review",
                "risk": decision.value,
                "reason": reason,
                "intent": intent,
                "approved": False,
                "requires_approval": True,
            }

        # ---- Safe: auto-approve ----
        decision = IntentRisk.SAFE
        reason = f"Safe action: {action}"
        return {
            "action": "auto_approve",
            "risk": decision.value,
            "reason": reason,
            "approved": True,
            "requires_approval": False,
        }

    # ------------------------------------------------------------------
    # Daily Briefing (SS2.5)
    # ------------------------------------------------------------------

    async def generate_briefing(self) -> dict:
        """Generate the morning briefing from engagement-tier items.

        The briefing is ordered by relevance, deduplicated, and includes
        a recap of fiduciary events since the last briefing.

        Returns
        -------
        dict
            Briefing payload with ``items``, ``fiduciary_recap``, and
            ``count`` keys.  Returns an empty briefing if there are no
            engagement items.
        """
        if not self._briefing_items:
            return {"items": [], "fiduciary_recap": [], "count": 0}

        # Deduplicate by body text.
        seen_bodies: set[str] = set()
        unique_items: list[dict] = []
        for item in self._briefing_items:
            body = item.get("body", "")
            if body not in seen_bodies:
                seen_bodies.add(body)
                unique_items.append(item)

        # Sort by relevance heuristic: fiduciary recap first, then
        # by source priority.
        source_priority = {
            "finance": 0,
            "health_system": 1,
            "calendar": 2,
            "messaging": 3,
            "rss": 4,
            "social_media": 5,
            "podcast": 6,
            "vendor": 7,
        }
        unique_items.sort(
            key=lambda x: source_priority.get(x.get("source", ""), 99)
        )

        # Gather fiduciary recap (events already delivered but worth
        # summarising in the morning briefing).
        fiduciary_recap: list[dict] = []
        try:
            # Query core for recent fiduciary events.
            results = await self._core.search_vault(
                "default",
                "priority:fiduciary",
                mode="hybrid",
            )
            if results:
                fiduciary_recap = results[:5]  # Cap at 5 most recent.
        except Exception:
            pass

        briefing = {
            "items": unique_items,
            "fiduciary_recap": fiduciary_recap,
            "count": len(unique_items),
        }

        # Clear engagement buffer after generating briefing.
        self._briefing_items = []

        log.info(
            "guardian.briefing_generated",
            item_count=briefing["count"],
            fiduciary_recap_count=len(fiduciary_recap),
        )
        return briefing

    # ------------------------------------------------------------------
    # Vault Lifecycle Handlers (SS2.2)
    # ------------------------------------------------------------------

    async def _handle_reason(self, event: dict) -> dict:
        """Handle reason events — delegate to LLM router for completion.

        The LLM router returns ``content``, ``model``, ``tokens_in``,
        ``tokens_out`` which the reason route translates into its response.
        """
        prompt = event.get("prompt", "")
        persona_tier = event.get("persona_tier", "open")
        provider = event.get("provider")

        try:
            result = await self._llm.route(
                task_type="complex_reasoning",
                prompt=prompt,
                persona_tier=persona_tier,
                provider=provider,
            )
            return {
                "content": result.get("content", ""),
                "model": result.get("model"),
                "tokens_in": result.get("tokens_in"),
                "tokens_out": result.get("tokens_out"),
            }
        except Exception as exc:
            log.error("guardian.reason_failed", error=str(exc))
            return {"content": "", "model": None, "tokens_in": None, "tokens_out": None}

    async def _handle_vault_unlocked(self, event: dict) -> dict:
        """Handle vault_unlocked event — initialise with decrypted data.

        Idempotent: duplicate vault_unlocked events are no-ops.
        """
        persona_id = event.get("persona_id", "default")

        if persona_id in self._unlocked_personas:
            log.info(
                "guardian.vault_unlocked.idempotent",
                persona_id=persona_id,
            )
            return {"action": "vault_already_unlocked", "persona_id": persona_id}

        self._unlocked_personas.add(persona_id)
        log.info("guardian.vault_unlocked", persona_id=persona_id)
        return {"action": "vault_unlocked", "persona_id": persona_id}

    async def _handle_vault_locked(self, event: dict) -> dict:
        """Handle vault_locked event — flush in-memory state for persona."""
        persona_id = event.get("persona_id", "default")
        self._unlocked_personas.discard(persona_id)

        # Flush any briefing items for this persona.
        self._briefing_items = [
            item
            for item in self._briefing_items
            if item.get("persona_id") != persona_id
        ]

        log.info("guardian.vault_locked", persona_id=persona_id)
        return {"action": "vault_locked", "persona_id": persona_id}

    async def _handle_persona_unlocked(self, event: dict) -> dict:
        """Handle persona_unlocked event — retry queued queries."""
        persona_id = event.get("persona_id", "default")
        self._unlocked_personas.add(persona_id)
        log.info("guardian.persona_unlocked", persona_id=persona_id)
        return {"action": "retry_query", "persona_id": persona_id}

    # ------------------------------------------------------------------
    # DIDComm Message Routing (SS2.8)
    # ------------------------------------------------------------------

    async def _handle_didcomm(self, event: dict) -> dict:
        """Route DIDComm messages to the appropriate handler.

        Parses the message type (``dina/social/arrival``,
        ``dina/commerce/*``, etc.) and routes to the correct handler.
        """
        msg_type = event.get("type", "")

        for prefix, handler in _DIDCOMM_HANDLERS.items():
            if msg_type.startswith(prefix):
                log.info(
                    "guardian.didcomm",
                    msg_type=msg_type,
                    handler=handler,
                )
                # For social messages, run through nudge assembly.
                if handler == "nudge_assembly":
                    from_did = event.get("from")
                    nudge = await self._nudge.assemble_nudge(event, from_did)
                    return {
                        "action": "nudge_assembled",
                        "handler": handler,
                        "nudge": nudge,
                    }
                return {"action": "routed", "handler": handler}

        log.warning("guardian.didcomm.unknown_type", msg_type=msg_type)
        return {"action": "unhandled_didcomm", "type": msg_type}

    # ------------------------------------------------------------------
    # Task ACK Protocol (SS2.3.13 – SS2.3.15)
    # ------------------------------------------------------------------

    async def _ack_task(self, task_id: str) -> None:
        """Send ACK to core after successful task processing.

        If the ACK fails (core unreachable), we log a warning but do
        not re-raise — core will requeue after its 5-minute timeout.
        """
        try:
            await self._core.task_ack(task_id)
            log.info("guardian.task_acked", task_id=task_id)
        except Exception:
            log.warning("guardian.task_ack_failed", task_id=task_id)

    # ------------------------------------------------------------------
    # Audit Trail (SS2.3.6 – SS2.3.7)
    # ------------------------------------------------------------------

    async def _audit_intent(
        self,
        intent: dict,
        decision: IntentRisk,
        reason: str,
    ) -> None:
        """Write an audit trail entry for risky/blocked intents."""
        audit_entry = {
            "agent_did": intent.get("agent_did", ""),
            "action": intent.get("action", ""),
            "decision": decision.value,
            "reason": reason,
        }
        try:
            await self._core.set_kv(
                f"audit:intent:{intent.get('agent_did', '')}:{intent.get('action', '')}",
                str(audit_entry),
            )
        except Exception:
            log.warning("guardian.audit_write_failed")

    # ------------------------------------------------------------------
    # Crash Handler (SS13)
    # ------------------------------------------------------------------

    async def _handle_crash(
        self,
        event: dict,
        exc: Exception,
        task_id: str | None,
    ) -> None:
        """Handle an unrecoverable crash.

        1. Sanitised one-liner to stdout (no PII, no traceback frames).
        2. Full traceback to encrypted vault via core API.
        3. No ACK — core will requeue the task.
        """
        # 1. Sanitised one-liner — type + first relevant line number only.
        tb = traceback.extract_tb(exc.__traceback__)
        line_info = f"line {tb[-1].lineno}" if tb else "unknown line"
        sanitised = f"guardian crash: {type(exc).__name__} at {line_info}"
        log.error("guardian.crash", summary=sanitised)

        # 2. Full traceback to encrypted vault.
        full_tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        crash_report = {
            "error": type(exc).__name__,
            "traceback": "".join(full_tb),
            "task_id": task_id or "unknown",
        }
        try:
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id, -1, {"crash_report": crash_report}
                )
        except Exception:
            # Core unreachable during crash — traceback lost but task
            # will be retried on restart.
            log.warning("guardian.crash_report_failed")
