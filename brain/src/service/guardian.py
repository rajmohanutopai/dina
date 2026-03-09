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

import json
import re
import time
import traceback
from typing import Any
from uuid import uuid4

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

# Maximum briefing items before eviction (MED-08).
_MAX_BRIEFING_ITEMS = 500

# Lightweight PII detection for open-tier auto-scrub (HIGH-03).
_PII_QUICK_RE = re.compile(
    r'(\b\d{3}-\d{2}-\d{4}\b'
    r'|\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b'
    r'|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
    r'|\+\d{1,3}[\s.-]\d[\d\s.-]{6,12}\d)'
)

# Document PII fields — redacted from searchable vault text (Fix 6).
_DOCUMENT_PII_FIELDS = frozenset({
    "license_number",
    "holder_name",
    "date_of_birth",
    "address",
})

# Minimum confidence for critical fields before scheduling reminders.
_CRITICAL_CONFIDENCE = 0.95

# Entity types that indicate medical PII (from GLiNER/Presidio NER).
# Used by _build_disclosure_proposal and _handle_disclosure_approved to
# classify entities as medical and withhold them from cross-persona disclosure.
_MEDICAL_ENTITY_TYPES = frozenset({
    "MEDICAL_CONDITION", "MEDICATION", "BLOOD_TYPE",
    "HEALTH_INSURANCE_ID", "MEDICAL",
})

# Regex fallback — used when Presidio scrubber is unavailable.
# Catches specific diagnoses, vertebral references, drug names, and conditions
# that must NEVER leak from a restricted health persona without explicit approval.
_MEDICAL_PII_REGEX_FALLBACK = re.compile(
    r'(?:'
    r'\bL\d[- /]L\d\b|\bC\d[- /]C\d\b|\bT\d[- /]T\d\b|'
    r'\bherniat\w*\b|\bstenosis\b|'
    r'\bfractur\w*\b|\btumou?r\w*\b|\bmalignant\b|\bbenign\b|'
    r'\bHIV\b|\bhepatitis[- ]\w*\b|'
    r'\bdiabetes\s+type\b|\bbipolar\b|\bschizophren\w*\b|\baneurysm\b'
    r')',
    re.IGNORECASE,
)

# General health terms safe for minimal disclosure proposals.
# Used as fallback when scrubber is unavailable.
_GENERAL_HEALTH_TERMS = re.compile(
    r'(?:back pain|chronic|lumbar|standing desk|ergonomic|posture|'
    r'support chair|sitting|mobility|discomfort|stiffness)',
    re.IGNORECASE,
)

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
    "dina/trust/": "trust_handler",
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
        vault_context: Any = None,  # VaultContextAssembler
    ) -> None:
        self._core = core
        self._llm = llm_router
        self._scrubber = scrubber
        self._entity_vault = entity_vault
        self._nudge = nudge_assembler
        self._scratchpad = scratchpad
        self._vault_context = vault_context

        # Tracks which personas are currently unlocked.
        self._unlocked_personas: set[str] = set()

        # Engagement-tier items saved for the morning briefing.
        self._briefing_items: list[dict] = []

        # Pending disclosure proposals — maps disclosure_id → proposal.
        # Entries expire after 1 hour.  Max 1000 entries.
        self._pending_proposals: dict[str, dict] = {}

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
        if isinstance(body, dict):
            body = json.dumps(body, default=str)
        elif not isinstance(body, str):
            body = str(body) if body is not None else ""
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

            # ---- Delegation request (SS4.4 — Agent Safety Layer) ----
            if event_type == "delegation_request":
                return await self._handle_delegation_request(event)

            # ---- Cross-persona disclosure (SS5 — Persona Wall) ----
            if event_type == "cross_persona_request":
                return await self._handle_cross_persona_request(event)

            if event_type == "disclosure_approved":
                return await self._handle_disclosure_approved(event)

            # ---- Document ingestion (SS4.1) ----
            if event_type == "document_ingest":
                return await self._handle_document_ingest(event)

            # ---- Reminder fired (SS4.3) ----
            if event_type == "reminder_fired":
                return await self._handle_reminder_fired(event)

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
                if len(self._briefing_items) >= _MAX_BRIEFING_ITEMS:
                    self._briefing_items = self._briefing_items[-_MAX_BRIEFING_ITEMS // 2:]
                    log.warning("guardian.briefing.cap_reached")
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
                    if priority == "fiduciary":
                        raise  # must not lose fiduciary notifications
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
            return {"action": "error", "status": "error", "error": type(exc).__name__}

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

        # Scrub PII from engagement items before inclusion in briefing.
        # Outcome data must never contain user DIDs or personal names.
        scrubbed_items: list[dict] = []
        for item in self._briefing_items:
            scrubbed = dict(item)
            body = scrubbed.get("body", "")
            if body:
                scrubbed_text, _entities = self._scrubber.scrub(body)
                scrubbed["body"] = scrubbed_text
            scrubbed_items.append(scrubbed)

        # Deduplicate by body text.
        seen_bodies: set[str] = set()
        unique_items: list[dict] = []
        for item in scrubbed_items:
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
    # Document Ingestion (SS4.1 — License Renewal Story)
    # ------------------------------------------------------------------

    async def _handle_document_ingest(self, event: dict) -> dict:
        """Extract structured data from a document via LLM.

        Pipeline (the Deterministic Sandwich — ingestion boundary):
            1. PII-scrub the document text before any LLM call.
            2. Call LLM with scrubbed text for structured extraction.
            3. Rehydrate extracted field values from the ephemeral vault.
            4. Store document in vault (all PII in metadata only).
            5. Gate on confidence — only schedule reminder if critical
               fields meet the threshold (≥ 0.95).
            6. Return extraction results with per-field confidence.
        """
        body = event.get("body", "")
        persona_id = event.get("persona_id", "personal")
        source = event.get("source", "document_scan")

        # Step 1: PII-scrub the document before sending to cloud LLM.
        # Raw PII (license number, name, DOB, address) must never leave
        # the Home Node.  The entity vault creates an ephemeral mapping
        # (token → original) that we use to rehydrate after extraction.
        pii_vault: dict | None = None
        scrubbed_body = body
        if self._entity_vault:
            try:
                scrubbed_body, pii_vault = await self._entity_vault.scrub(body)
            except Exception as exc:
                log.error("guardian.document_ingest.scrub_failed", error=str(exc))
                return {
                    "status": "error",
                    "action": "document_ingested",
                    "error": "PII scrub failed — refusing to send raw PII to cloud LLM",
                }
        else:
            # No entity vault configured — cannot guarantee PII safety.
            return {
                "status": "error",
                "action": "document_ingested",
                "error": "Entity vault not available — cannot scrub PII before LLM call",
            }

        extraction_prompt = (
            "You are a document data extraction system. Extract ALL structured fields "
            "from this document text. Respond with ONLY valid JSON, no other text.\n\n"
            "Required JSON schema:\n"
            "{\n"
            '  "fields": {\n'
            '    "license_number": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "holder_name": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "date_of_birth": {"value": "YYYY-MM-DD", "confidence": 0.0-1.0},\n'
            '    "expiry_date": {"value": "YYYY-MM-DD", "confidence": 0.0-1.0},\n'
            '    "address": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "vehicle_class": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "issuing_rto": {"value": "...", "confidence": 0.0-1.0}\n'
            "  },\n"
            '  "document_type": "driving_license"\n'
            "}\n\n"
            "Set confidence to 1.0 if the field is clearly readable, lower if "
            "ambiguous. If a field is not found, set value to null and confidence to 0.0.\n"
            "Return the ORIGINAL values from the document exactly as written, even if "
            "they appear as anonymised tokens.\n\n"
            f"Document text:\n{scrubbed_body}"
        )

        # Step 2: Call LLM with scrubbed text.
        result = await self._llm.route(
            task_type="complex_reasoning",
            prompt=extraction_prompt,
            persona_tier="open",
        )

        content = result.get("content", "")

        # Parse JSON from LLM response (strip markdown fences if present).
        json_text = content.strip()
        if json_text.startswith("```"):
            lines = json_text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            json_text = "\n".join(lines)

        try:
            extracted = json.loads(json_text)
        except json.JSONDecodeError:
            log.error("guardian.document_ingest.json_parse_failed", content=content[:200])
            return {
                "status": "error",
                "action": "document_ingest_failed",
                "error": "LLM did not return valid JSON",
            }

        fields = extracted.get("fields", {})

        # Step 3: Rehydrate extracted field values — the LLM may have
        # returned PII tokens (e.g. <<PII_PERSON_1_abc>>) instead of
        # real names.  Restore originals before storing in vault metadata.
        if pii_vault and self._entity_vault:
            for field_name, field_data in fields.items():
                val = field_data.get("value")
                if isinstance(val, str) and val:
                    field_data["value"] = self._entity_vault.rehydrate(val, pii_vault)
            pii_vault.clear()

        # Step 4: Build vault items — redact ALL PII from searchable text.
        # Only metadata (encrypted at rest by SQLCipher) holds real values.
        expiry_field = fields.get("expiry_date", {})
        expiry = expiry_field.get("value")
        expiry_confidence = expiry_field.get("confidence", 0.0)
        license_num = fields.get("license_number", {}).get("value", "")

        # Summary: generic label, no PII (no holder name).
        doc_summary = "Driving License Document"

        # Body text: use the entity-vault-scrubbed text as base.
        # The two-tier scrub (Tier 1 regex + Tier 2 Presidio NER) already
        # replaced names, dates, addresses, IDs with tokens in-place.
        # String-replacing LLM-extracted values against raw text is brittle
        # because the LLM normalises formats (e.g. "15-03-1985" → "1985-03-15").
        doc_body = scrubbed_body
        pii_scrubbed: list[str] = list(
            fn for fn in _DOCUMENT_PII_FIELDS if fields.get(fn, {}).get("value")
        )

        doc_id = f"doc-{uuid4().hex[:12]}"
        doc_item = {
            "id": doc_id,
            "Type": "document",
            "Source": source,
            "Summary": doc_summary,
            "BodyText": doc_body,
            "Metadata": json.dumps({
                "document_type": "driving_license",
                "extracted_fields": fields,
                "license_number": license_num,
            }),
        }

        # Store document.
        await self._core.store_vault_item(persona_id, doc_item)

        # Create temporal event entry.
        reminder_vault_id = f"evt-{uuid4().hex[:12]}"
        reminder_item = {
            "id": reminder_vault_id,
            "Type": "event",
            "Source": "reminder_system",
            "Summary": f"License renewal due - {expiry or 'unknown'}",
            "BodyText": f"Driving license expires {expiry}. Document ID: {doc_id}",
            "Metadata": json.dumps({
                "trigger_date": expiry,
                "document_id": doc_id,
                "reminder_type": "license_expiry",
            }),
        }
        await self._core.store_vault_item(persona_id, reminder_item)

        # Step 5: Gate on confidence — only schedule reminder if the
        # critical expiry_date field meets the threshold.
        reminder_id = ""
        needs_confirmation = True
        if expiry and expiry_confidence >= _CRITICAL_CONFIDENCE:
            needs_confirmation = False
            try:
                from datetime import datetime, timedelta

                # LLM may return dates in various formats despite
                # the prompt requesting YYYY-MM-DD.
                expiry_dt = None
                for _fmt in ("%Y-%m-%d", "%d-%m-%Y", "%m-%d-%Y", "%Y/%m/%d", "%d/%m/%Y"):
                    try:
                        expiry_dt = datetime.strptime(expiry, _fmt)
                        break
                    except ValueError:
                        continue
                if expiry_dt is None:
                    raise ValueError(f"Unrecognised date format: {expiry!r}")
                trigger_dt = expiry_dt - timedelta(days=30)
                trigger_at = int(trigger_dt.timestamp())

                reminder_id = await self._core.store_reminder({
                    "type": "license_expiry",
                    "message": f"Driving license expires {expiry}",
                    "trigger_at": trigger_at,
                    "metadata": json.dumps({
                        "vault_item_id": doc_id,
                        "persona": persona_id,
                        "expiry_date": expiry,
                    }),
                })
            except Exception as exc:
                log.warning("guardian.document_ingest.reminder_failed", error=str(exc))
        elif expiry:
            log.warning(
                "guardian.document_ingest.low_confidence",
                field="expiry_date",
                confidence=expiry_confidence,
            )

        return {
            "status": "ok",
            "action": "document_ingested",
            "response": {
                "extracted_fields": fields,
                "vault_items": {
                    "document_id": doc_id,
                    "reminder_vault_id": reminder_vault_id,
                },
                "reminder_id": reminder_id,
                "pii_scrubbed": pii_scrubbed,
                "needs_confirmation": needs_confirmation,
            },
        }

    # ------------------------------------------------------------------
    # Reminder Fired (SS4.3 — License Renewal Story)
    # ------------------------------------------------------------------

    async def _handle_reminder_fired(self, event: dict) -> dict:
        """Compose a contextual notification when a reminder fires.

        Pipeline (the Deterministic Sandwich — notification boundary):
            1. Parse reminder metadata (vault_item_id, persona).
            2. Retrieve the original document from vault.
            3. Query vault for related personal context.
            4. PII-scrub the assembled prompt before cloud LLM call.
            5. Call LLM to compose a contextual notification.
            6. Rehydrate the notification, then send via Core /v1/notify.
        """
        body = event.get("body") or event.get("payload", {})
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                body = {}

        reminder_type = body.get("reminder_type", "")
        message = body.get("message", "")
        metadata_str = body.get("metadata", "{}")
        if isinstance(metadata_str, str):
            try:
                metadata = json.loads(metadata_str)
            except json.JSONDecodeError:
                metadata = {}
        else:
            metadata = metadata_str

        vault_item_id = metadata.get("vault_item_id", "")
        persona = metadata.get("persona", "personal")
        expiry_date = metadata.get("expiry_date", "")

        # Retrieve the original document from vault.
        doc_context = ""
        if vault_item_id:
            try:
                doc = await self._core.get_vault_item(persona, vault_item_id)
                if doc:
                    doc_context = (
                        f"Document: {doc.get('Summary', '')}\n"
                        f"Details: {doc.get('Metadata', '')}\n"
                    )
            except Exception as exc:
                log.warning("guardian.reminder.doc_fetch_failed", error=str(exc))

        # Query vault for personal context (address, insurance, previous renewals).
        personal_context = ""
        try:
            results = await self._core.query_vault(
                persona, "RTO renewal insurance address driving", mode="fts5", limit=10
            )
            for item in results:
                personal_context += f"- {item.get('Summary', '')}: {item.get('BodyText', '')}\n"
        except Exception as exc:
            log.warning("guardian.reminder.context_fetch_failed", error=str(exc))

        # Compose contextual notification via LLM.
        notification_prompt = (
            "You are Dina, a sovereign personal AI assistant. A reminder has fired "
            "and you need to compose a brief, helpful notification for your human.\n\n"
            f"Reminder: {message}\n"
            f"Expiry date: {expiry_date}\n\n"
        )
        if doc_context:
            notification_prompt += f"Original document:\n{doc_context}\n"
        if personal_context:
            notification_prompt += f"Related personal context:\n{personal_context}\n"
        notification_prompt += (
            "\nCompose a concise notification (2-4 sentences) that:\n"
            "1. States the specific deadline and days remaining\n"
            "2. References relevant personal context (RTO location, insurance, previous experience)\n"
            "3. Offers a concrete next step\n"
            "Be warm but concise. No emojis. No fluff."
        )

        # PII-scrub the assembled prompt before sending to cloud LLM.
        # The prompt may contain vault metadata (extracted fields, license
        # identifiers) — these must not leave the Home Node.
        # FAIL-CLOSED: if scrub fails, use the generic reminder message
        # instead of sending raw PII to the cloud LLM.
        pii_vault: dict | None = None
        scrubbed_prompt = None
        if self._entity_vault:
            try:
                scrubbed_prompt, pii_vault = await self._entity_vault.scrub(
                    notification_prompt,
                )
            except Exception as exc:
                log.error("guardian.reminder.scrub_failed", error=str(exc))

        if scrubbed_prompt is not None:
            try:
                result = await self._llm.route(
                    task_type="complex_reasoning",
                    prompt=scrubbed_prompt,
                    persona_tier="open",
                )
                notification_text = result.get("content", message)
            except Exception as exc:
                log.warning("guardian.reminder.llm_failed", error=str(exc))
                notification_text = message
        else:
            # Scrub failed or no entity vault — use the generic reminder
            # message.  Never send raw PII to the cloud LLM.
            log.warning("guardian.reminder.skipping_llm", reason="PII scrub unavailable")
            notification_text = message

        # Rehydrate PII tokens in the LLM response so the human sees
        # real names, addresses, dates — not anonymised placeholders.
        if pii_vault and self._entity_vault:
            notification_text = self._entity_vault.rehydrate(
                notification_text, pii_vault,
            )
            pii_vault.clear()

        # Send notification via Core.
        try:
            await self._core.notify("default", {
                "type": "reminder_notification",
                "priority": "solicited",
                "text": notification_text,
                "reminder_type": reminder_type,
            })
        except Exception:
            log.warning("guardian.reminder.notify_failed")

        return {
            "status": "ok",
            "action": "reminder_notification_sent",
            "response": {
                "notification_text": notification_text,
                "reminder_type": reminder_type,
                "vault_context_used": bool(personal_context),
            },
        }

    # ------------------------------------------------------------------
    # Delegation Request (SS4.4 — Agent Safety Layer)
    # ------------------------------------------------------------------

    async def _handle_delegation_request(self, event: dict) -> dict:
        """Validate and risk-assess a delegation request.

        Unlike test_08's LLM-only path, this enforces the schema
        deterministically: PII fields must NOT appear in permitted_fields
        or data_payload.  The delegation then flows through review_intent
        (share_data → HIGH risk → flag_for_review).

        Parameters
        ----------
        event:
            Must include ``payload`` dict with delegation fields:
            ``agent_did``, ``action``, ``permitted_fields``,
            ``denied_fields``, ``data_payload``, ``constraints``.
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "delegation_invalid",
                "error": "Missing delegation payload",
            }

        # Required fields.
        required = ("agent_did", "action", "permitted_fields", "denied_fields")
        missing = [f for f in required if f not in payload]
        if missing:
            return {
                "status": "error",
                "action": "delegation_invalid",
                "error": f"Missing required fields: {', '.join(missing)}",
            }

        # PII enforcement: no PII field in permitted_fields or data_payload.
        permitted = set(payload.get("permitted_fields", []))
        data_payload = payload.get("data_payload", {})
        violations: list[str] = []

        for pii_field in _DOCUMENT_PII_FIELDS:
            if pii_field in permitted:
                violations.append(f"{pii_field} in permitted_fields")
            if pii_field in data_payload:
                violations.append(f"{pii_field} in data_payload")

        if violations:
            return {
                "status": "error",
                "action": "delegation_rejected",
                "error": f"PII violation: {'; '.join(violations)}",
                "violations": violations,
                "approved": False,
            }

        # Schema validated — route through intent review for risk assessment.
        intent = {
            "agent_did": payload.get("agent_did", ""),
            "action": payload.get("action", "share_data"),
            "target": payload.get("agent_name", payload.get("agent_did", "")),
            "trust_level": event.get("trust_level", "verified"),
            "risk_level": payload.get("risk_level", ""),
        }
        risk_result = await self.review_intent(intent)

        return {
            "status": "ok",
            "action": risk_result.get("action", "flag_for_review"),
            "risk": risk_result.get("risk", "HIGH"),
            "delegation_valid": True,
            "pii_clean": True,
            "approved": risk_result.get("approved", False),
            "requires_approval": risk_result.get("requires_approval", True),
        }

    # ------------------------------------------------------------------
    # Cross-Persona Disclosure (SS5 — Persona Wall)
    # ------------------------------------------------------------------

    async def _handle_cross_persona_request(self, event: dict) -> dict:
        """Handle a request for data from one persona on behalf of another.

        Enforces the Persona Wall: restricted/locked personas NEVER
        disclose automatically.  Instead, the Guardian queries the source
        vault, builds a minimal disclosure proposal (withholding specific
        diagnoses and PII), and returns it for user approval.

        Parameters
        ----------
        event:
            Must include ``payload`` dict with:
            - ``source_persona`` (str, required): persona holding the data
            - ``query`` (str, required): what the agent needs
            - ``requesting_agent`` (str): who is asking
            - ``target_persona`` (str): destination persona
            - ``source_persona_tier`` (str): tier of source persona
            - ``reason`` (str): why the data is needed
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "cross_persona_invalid",
                "error": "Missing payload",
            }

        source_persona = payload.get("source_persona", "")
        query = payload.get("query", "")
        requesting_agent = payload.get("requesting_agent", "unknown_agent")
        target_persona = payload.get("target_persona", "")
        reason = payload.get("reason", "")
        # Fail-closed: default to restricted if tier not provided.
        tier = (payload.get("source_persona_tier", "restricted") or "restricted").strip().lower()
        if tier not in ("open", "restricted", "locked"):
            tier = "restricted"

        if not source_persona or not query:
            return {
                "status": "error",
                "action": "cross_persona_invalid",
                "error": "source_persona and query are required",
            }

        disclosure_id = f"disc-{uuid4().hex[:12]}"

        # Deterministic tier gate — restricted/locked always blocks auto-disclosure.
        blocked = tier in ("restricted", "locked")

        if not blocked:
            # Open tier — still generate proposal but mark as non-blocked.
            pass

        # Query source vault for relevant items.
        vault_items: list[dict] = []
        try:
            vault_items = await self._core.query_vault(
                source_persona, query, mode="fts5", limit=10,
            )
        except PersonaLockedError:
            return {
                "status": "ok",
                "action": "disclosure_proposed",
                "response": {
                    "blocked": True,
                    "block_reason": f"Persona '{source_persona}' is locked",
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "proposal": {
                        "safe_to_share": "",
                        "withheld": ["Persona is locked — all data withheld"],
                        "rationale": "Cannot access locked persona",
                    },
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "target_persona": target_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": True,
            }
        except Exception as exc:
            log.warning("guardian.cross_persona.vault_query_failed", error=str(exc))
            return {
                "status": "error",
                "action": "disclosure_error",
                "error": f"Vault query failed: {exc}",
                "response": {
                    "blocked": blocked,
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": blocked,
            }

        if not vault_items:
            return {
                "status": "ok",
                "action": "no_relevant_data",
                "response": {
                    "blocked": blocked,
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": blocked,
            }

        # Build disclosure proposal using deterministic scan.
        proposal = self._build_disclosure_proposal(vault_items, query)

        # Store proposal for binding verification at approval time.
        self._pending_proposals[disclosure_id] = {
            "safe_to_share": proposal.get("safe_to_share", ""),
            "withheld": proposal.get("withheld", []),
            "source_persona": source_persona,
            "created_at": time.monotonic(),
        }
        self._evict_proposals()

        block_reason = ""
        if blocked:
            block_reason = (
                f"Source persona '{source_persona}' has {tier} tier — "
                f"automatic cross-persona disclosure denied"
            )

        log.info(
            "guardian.cross_persona.proposal_built",
            disclosure_id=disclosure_id,
            blocked=blocked,
            safe_len=len(proposal.get("safe_to_share", "")),
            withheld_count=len(proposal.get("withheld", [])),
        )

        return {
            "status": "ok",
            "action": "disclosure_proposed",
            "response": {
                "blocked": blocked,
                "block_reason": block_reason,
                "persona_tier": tier,
                "disclosure_id": disclosure_id,
                "proposal": proposal,
                "requesting_agent": requesting_agent,
                "source_persona": source_persona,
                "target_persona": target_persona,
                "query": query,
            },
            "approved": False,
            "requires_approval": True,
        }

    def _build_disclosure_proposal(
        self, vault_items: list[dict], query: str,
    ) -> dict:
        """Build a minimal disclosure proposal from vault items.

        Uses Presidio + GLiNER NER (when available) to classify sentences
        as containing medical PII (withheld) or general health terms (safe).
        Falls back to regex patterns when the scrubber is unavailable.

        Returns dict with ``safe_to_share``, ``withheld``, ``rationale``.
        """
        safe_fragments: list[str] = []
        withheld: list[str] = []

        for item in vault_items:
            body = item.get("BodyText", "") or item.get("body_text", "") or ""
            summary = item.get("Summary", "") or item.get("summary", "") or ""
            text = f"{summary} {body}".strip()
            if not text:
                continue

            # Split into sentences for fine-grained control.
            sentences = re.split(r'(?<=[.!?])\s+', text)
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue

                should_withhold, detected_values = self._classify_sentence_medical(
                    sentence,
                )

                if should_withhold:
                    for val in detected_values:
                        if val not in withheld:
                            withheld.append(val)
                    continue

                # Check for general health terms — safe to propose.
                if _GENERAL_HEALTH_TERMS.search(sentence):
                    safe_fragments.append(sentence)

        # Deduplicate safe fragments.
        seen: set[str] = set()
        unique_safe: list[str] = []
        for frag in safe_fragments:
            key = frag.lower().strip()
            if key not in seen:
                seen.add(key)
                unique_safe.append(frag)

        safe_to_share = " ".join(unique_safe) if unique_safe else ""

        # Final safety net: scan safe_to_share for any medical PII that
        # slipped through sentence splitting.
        if safe_to_share:
            _, final_detections = self._classify_sentence_medical(safe_to_share)
            for val in final_detections:
                if val not in withheld:
                    withheld.append(val)
                safe_to_share = safe_to_share.replace(val, "[REDACTED]")

        if not withheld:
            withheld.append("specific diagnoses")

        rationale = (
            "Extracted general health context relevant to the query. "
            "Specific diagnoses, medications, doctor names, and hospital "
            "details have been withheld pending user approval."
        )

        return {
            "safe_to_share": safe_to_share,
            "withheld": withheld,
            "rationale": rationale,
        }

    def _classify_sentence_medical(
        self, sentence: str,
    ) -> tuple[bool, list[str]]:
        """Classify whether a sentence contains medical PII.

        Uses Presidio + GLiNER NER (via ``self._scrubber.detect()``)
        when available, falling back to regex patterns.

        Returns
        -------
        tuple[bool, list[str]]
            ``(should_withhold, detected_values)`` — True if the sentence
            contains medical entities (diagnoses, medications, doctor names),
            with the specific values that were detected.
        """
        detected_values: list[str] = []

        # Primary path: Presidio + GLiNER NER.
        if self._scrubber is not None:
            try:
                entities = self._scrubber.detect(sentence)
                for ent in entities:
                    ent_type = ent.get("type", "")
                    ent_value = ent.get("value", "")
                    if ent_type in _MEDICAL_ENTITY_TYPES:
                        detected_values.append(ent_value)
                    elif ent_type == "PERSON":
                        # Doctor names are PII — withhold.
                        detected_values.append(ent_value)
                    elif ent_type in ("ORG", "ORGANIZATION"):
                        # In medical disclosure context, ORGs are likely
                        # hospitals/clinics/pharmacies — withhold.
                        detected_values.append(ent_value)
                if detected_values:
                    return True, detected_values
            except Exception:
                # Fall through to regex fallback.
                pass

        # Fallback: regex patterns.
        if _MEDICAL_PII_REGEX_FALLBACK.search(sentence):
            matches = _MEDICAL_PII_REGEX_FALLBACK.findall(sentence)
            return True, matches

        return False, []

    _PROPOSAL_TTL = 3600.0   # 1 hour
    _PROPOSAL_MAX = 1000

    def _evict_proposals(self) -> None:
        """Remove expired and excess pending proposals."""
        now = time.monotonic()
        expired = [
            k for k, v in self._pending_proposals.items()
            if now - v.get("created_at", 0) > self._PROPOSAL_TTL
        ]
        for k in expired:
            del self._pending_proposals[k]
        if len(self._pending_proposals) > self._PROPOSAL_MAX:
            sorted_keys = sorted(
                self._pending_proposals,
                key=lambda k: self._pending_proposals[k].get("created_at", 0),
            )
            for k in sorted_keys[: len(self._pending_proposals) - self._PROPOSAL_MAX]:
                del self._pending_proposals[k]

    async def _handle_disclosure_approved(self, event: dict) -> dict:
        """Handle user approval of a cross-persona disclosure.

        The approved_text must match the safe_to_share from the stored
        proposal (binding check).  A final PII check gates sharing —
        if medical patterns are found, disclosure is blocked.

        Parameters
        ----------
        event:
            Must include ``payload`` dict with:
            - ``approved_text`` (str, required): text the user approved
            - ``disclosure_id`` (str): from the proposal
            - ``requesting_agent`` (str): who gets the data
            - ``source_persona`` (str): which persona it came from
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": "Missing payload",
            }

        approved_text = payload.get("approved_text", "")
        disclosure_id = payload.get("disclosure_id", f"disc-{uuid4().hex[:12]}")
        requesting_agent = payload.get("requesting_agent", "unknown_agent")
        source_persona = payload.get("source_persona", "")

        if not approved_text:
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": "approved_text is required",
            }

        # Binding check: approved_text must match the stored proposal.
        stored = self._pending_proposals.pop(disclosure_id, None)
        if stored is None:
            log.warning(
                "guardian.disclosure.unknown_id",
                disclosure_id=disclosure_id,
            )
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": f"Unknown or expired disclosure_id: {disclosure_id}",
            }

        expected_safe = stored.get("safe_to_share", "")
        if approved_text != expected_safe:
            log.warning(
                "guardian.disclosure.text_mismatch",
                disclosure_id=disclosure_id,
                expected_len=len(expected_safe),
                received_len=len(approved_text),
            )
            return {
                "status": "error",
                "action": "disclosure_blocked",
                "error": "approved_text does not match the generated proposal",
            }

        # Final PII check — gates sharing, not just audit.
        entities_found: list[str] = []
        medical_patterns_found: list[str] = []

        # Check with entity vault scrubber if available.
        if self._entity_vault:
            try:
                _, vault = await self._entity_vault.scrub(approved_text)
                entities_found = list(vault.keys()) if vault else []
                vault.clear() if vault else None
            except Exception as exc:
                log.warning(
                    "guardian.disclosure.scrub_check_failed",
                    error=str(exc),
                )

        # Check for medical PII — NER first, regex fallback.
        _, medical_detections = self._classify_sentence_medical(approved_text)
        for val in medical_detections:
            if val not in medical_patterns_found:
                medical_patterns_found.append(val)

        # Gate decision is based on medical patterns only.  Generic PII
        # entities (e.g. SWIFT/BIC false positives on ordinary words) are
        # audit-only — the proposal was already scrubbed for medical content.
        medical_clean = len(medical_patterns_found) == 0
        pii_clean = medical_clean

        # Write audit record to KV.
        audit_record = {
            "disclosure_id": disclosure_id,
            "requesting_agent": requesting_agent,
            "source_persona": source_persona,
            "approved_text_length": len(approved_text),
            "pii_clean": pii_clean,
            "entities_found_count": len(entities_found),
            "medical_patterns_found": medical_patterns_found,
        }
        try:
            await self._core.set_kv(
                f"disclosure:{disclosure_id}",
                json.dumps(audit_record),
            )
        except Exception as exc:
            log.warning(
                "guardian.disclosure.audit_write_failed",
                error=str(exc),
            )

        # PII gate: block only if medical patterns found.
        if not medical_clean:
            log.warning(
                "guardian.disclosure.pii_gate_blocked",
                disclosure_id=disclosure_id,
                medical_patterns=medical_patterns_found,
                entities_count=len(entities_found),
            )
            return {
                "status": "ok",
                "action": "disclosure_blocked",
                "response": {
                    "disclosure_id": disclosure_id,
                    "block_reason": "Final PII check found medical patterns in approved text",
                    "pii_check": {
                        "entities_found": entities_found,
                        "medical_patterns_found": medical_patterns_found,
                        "clean": False,
                    },
                },
                "approved": False,
                "requires_approval": True,
            }

        log.info(
            "guardian.disclosure.shared",
            disclosure_id=disclosure_id,
            pii_clean=pii_clean,
        )

        return {
            "status": "ok",
            "action": "disclosure_shared",
            "response": {
                "disclosure_id": disclosure_id,
                "shared_text": approved_text,
                "requesting_agent": requesting_agent,
                "source_persona": source_persona,
                "pii_check": {
                    "entities_found": entities_found,
                    "medical_patterns_found": medical_patterns_found,
                    "clean": pii_clean,
                },
            },
            "approved": True,
            "requires_approval": False,
        }

    # ------------------------------------------------------------------
    # Vault Lifecycle Handlers (SS2.2)
    # ------------------------------------------------------------------

    async def _handle_reason(self, event: dict) -> dict:
        """Handle reason events via agentic reasoning with vault tools.

        Pipeline:
            1. PII scrub — for sensitive personas before any cloud LLM call.
            2. Agentic reasoning — the LLM autonomously calls vault tools
               (list_personas, search_vault) via function calling, gathers
               relevant context, and generates a personalized response.
               Falls back to direct LLM call if vault context is disabled.
            3. Rehydrate PII tokens in the response.

        The reasoning agent handles tool calling, context assembly, and
        final response generation in a single agentic loop.  The LLM
        decides which tools to call — no hardcoded classification.
        """
        prompt = event.get("prompt", "")
        persona_tier = event.get("persona_tier", "open")
        persona_tier = (persona_tier or "open").strip().lower()
        if persona_tier not in ("open", "restricted", "locked"):
            log.warning("guardian.invalid_persona_tier", extra={"tier": persona_tier})
            persona_tier = "restricted"
        provider = event.get("provider")
        skip_vault = event.get("skip_vault_enrichment", False)

        try:
            vault = None
            llm_prompt = prompt

            # Step 1: Scrub PII for sensitive personas before cloud LLM routing.
            if persona_tier in ("restricted", "locked") and self._entity_vault:
                llm_prompt, vault = await self._entity_vault.scrub(llm_prompt)
            elif persona_tier == "open" and self._entity_vault:
                if _PII_QUICK_RE.search(llm_prompt):
                    llm_prompt, vault = await self._entity_vault.scrub(llm_prompt)
                    log.info("guardian.open_tier.auto_scrub")

            # Step 2: Agentic reasoning with vault tools.
            if self._vault_context and not skip_vault:
                try:
                    # Only scrub tool results when the prompt was also
                    # scrubbed (vault is non-None).  For open-tier queries
                    # without PII, scrubbing tool results is unnecessary
                    # and can interfere with the agentic loop.
                    ev = self._entity_vault if vault is not None else None
                    result = await self._vault_context.reason(
                        llm_prompt, persona_tier,
                        entity_vault=ev,
                        provider=provider,
                    )
                    vault_enriched = result.get("vault_context_used", False)
                    if vault_enriched:
                        log.info(
                            "guardian.reason.vault_enriched",
                            tools_called=len(result.get("tools_called", [])),
                        )
                except Exception as exc:
                    log.warning(
                        "guardian.reason.agent_failed",
                        error=str(exc),
                    )
                    # Fallback: direct LLM call without vault context
                    result = await self._llm.route(
                        task_type="complex_reasoning",
                        prompt=llm_prompt,
                        persona_tier=persona_tier,
                        provider=provider,
                    )
                    vault_enriched = False
            else:
                # No vault context agent — direct LLM call
                result = await self._llm.route(
                    task_type="complex_reasoning",
                    prompt=llm_prompt,
                    persona_tier=persona_tier,
                    provider=provider,
                )
                vault_enriched = False

            # Step 3: Rehydrate PII tokens in the response.
            # Merge tool-result vault (from scrubbed tool responses) with
            # the prompt vault so all PII tokens get rehydrated.
            tool_vault = result.get("_tool_vault", {})
            if tool_vault:
                vault = {**(vault or {}), **tool_vault}

            content = result.get("content", "")
            if vault and self._entity_vault:
                content = self._entity_vault.rehydrate(content, vault)
                vault.clear()

            return {
                "content": content,
                "model": result.get("model"),
                "tokens_in": result.get("tokens_in"),
                "tokens_out": result.get("tokens_out"),
                "vault_context_used": vault_enriched,
            }
        except Exception as exc:
            log.error("guardian.reason_failed", error=str(exc))
            raise

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
            agent_did = (intent.get("agent_did") or "unknown")[:100]
            action = re.sub(r'[^a-zA-Z0-9_.-]', '_', (intent.get("action") or "unknown"))[:50]
            uid = uuid4().hex[:12]
            await self._core.set_kv(
                f"audit:intent:{agent_did}:{action}:{uid}",
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
