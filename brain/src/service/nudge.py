"""Nudge assembly — context-injection for conversation awareness.

When a user opens a conversation with a contact, the nudge assembler
gathers relevant context from the vault:

    - Recent messages with the contact.
    - Relationship notes.
    - Pending tasks/promises ("I'll send the PDF tomorrow").
    - Calendar events (upcoming lunch, meeting).

If no relevant context exists for the contact, no nudge is generated
(Silence First — do not interrupt without value).

Persona boundaries are respected: locked personas are excluded from
nudge context to avoid leaking cross-compartment data.

Maps to Brain TEST_PLAN SS2.6 (Context Injection / The Nudge) and
SS2.8 (D2D Payload Preparation).

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from ..port.core_client import CoreClient


def _quote_fts_value(value: str) -> str:
    """Quote a value for FTS5 column-filter queries (MEDIUM-08)."""
    return '"' + value.replace('"', '""') + '"'

log = structlog.get_logger(__name__)


def _get(d: dict, key: str, default: str = "") -> str:
    """Get a value from a dict, trying lowercase, Title, and Go-style keys.

    Go's JSON marshaler emits capitalized struct field names (e.g.
    ``Summary``, ``BodyText``, ``ID``).  Python code typically uses
    lowercase.  This helper bridges the two conventions.
    """
    return (
        d.get(key)
        or d.get(key[0].upper() + key[1:])  # Summary, BodyText
        or d.get(key.upper())  # ID
        or default
    )

# Patterns that indicate a pending promise in message text.
_PROMISE_PATTERNS = re.compile(
    r"(?:I(?:'ll| will) send|I(?:'ll| will) share|I(?:'ll| will) forward|"
    r"I(?:'ll| will) get back|let me send|remind me to send)",
    re.IGNORECASE,
)


class NudgeAssembler:
    """Assembles contextual nudges when the user opens a conversation.

    Parameters
    ----------
    core:
        Typed HTTP client for dina-core (vault queries).
    llm:
        LLM router for summarisation of gathered context.
    entity_vault:
        Entity vault service for PII scrubbing if cloud LLM is used.
    """

    def __init__(
        self,
        core: CoreClient,
        llm: Any,  # LLMRouter
        entity_vault: Any,  # EntityVaultService
    ) -> None:
        self._core = core
        self._llm = llm
        self._entity_vault = entity_vault

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def assemble_nudge(
        self,
        event: dict,
        contact_did: str | None = None,
    ) -> dict | None:
        """Assemble a contextual nudge for a conversation-open event.

        Steps
        -----
        1. Query recent messages with the contact.
        2. Query relationship notes.
        3. Check pending tasks / promises.
        4. Check calendar events.
        5. If no relevant context -> return ``None`` (Silence First).
        6. Format nudge with sources.

        Persona boundaries are respected: locked personas are excluded
        from the context query.

        Parameters
        ----------
        event:
            The conversation-open event dict.
        contact_did:
            The DID of the contact the conversation is with.  If
            ``None``, extracted from ``event["contact_did"]``.

        Returns
        -------
        dict or None
            A nudge payload dict with keys ``text``, ``sources``,
            ``tier``, and ``trigger``; or ``None`` if there is
            insufficient context to produce a useful nudge.
        """
        did = contact_did or event.get("contact_did")
        if not did:
            log.info("nudge.no_contact_did", event_type=event.get("type"))
            return None

        persona_id = event.get("persona_id", "default")

        # 1. Recent messages with this contact.
        recent_messages = await self._query_recent_messages(persona_id, did)

        # 2. Relationship notes.
        relationship_notes = await self._query_relationship_notes(
            persona_id, did
        )

        # 3. Pending promises.
        promises = self._detect_promises(recent_messages)

        # 4. Calendar events.
        calendar_events = await self._query_calendar_events(persona_id, did)

        # 5. Evaluate: enough context for a nudge?
        has_context = bool(
            recent_messages or relationship_notes or promises or calendar_events
        )
        if not has_context:
            log.info("nudge.no_context", contact_did=did)
            return None

        # 6. Build nudge text.
        nudge_parts: list[str] = []
        sources: list[str] = []

        if promises:
            for promise in promises:
                nudge_parts.append(f"You promised: {promise['text']}")
                if promise.get("source_id"):
                    sources.append(promise["source_id"])

        if relationship_notes:
            for note in relationship_notes:
                summary = _get(note, "summary")
                if summary:
                    nudge_parts.append(summary)
                item_id = _get(note, "id") or _get(note, "ID")
                if item_id:
                    sources.append(item_id)

        if calendar_events:
            for evt in calendar_events:
                summary = _get(evt, "summary")
                if summary:
                    nudge_parts.append(f"Upcoming: {summary}")
                item_id = _get(evt, "id") or _get(evt, "ID")
                if item_id:
                    sources.append(item_id)

        if recent_messages and not nudge_parts:
            # Fall back to summarising recent messages.
            last_msg = recent_messages[0]
            summary = _get(last_msg, "summary")
            if summary:
                nudge_parts.append(f"Last exchange: {summary}")
            item_id = _get(last_msg, "id") or _get(last_msg, "ID")
            if item_id:
                sources.append(item_id)

        nudge_text = " | ".join(nudge_parts) if nudge_parts else ""

        if not nudge_text:
            return None

        nudge = {
            "text": nudge_text,
            "sources": sources,
            "tier": 2,  # solicited — user opened the conversation
            "trigger": f"conversation_open:{did}",
        }

        log.info(
            "nudge.assembled",
            contact_did=did,
            part_count=len(nudge_parts),
            source_count=len(sources),
        )
        return nudge

    async def prepare_d2d_payload(self, event: dict) -> dict:
        """Prepare a tiered payload for D2D (Dina-to-Dina) send.

        Brain always includes both summary and full tiers.  Brain never
        pre-filters by sharing policy — that is Core's responsibility.
        Core strips tiers based on the contact's policy before encryption
        and outbox.

        Parameters
        ----------
        event:
            The event dict containing data to share.

        Returns
        -------
        dict
            Tiered payload with ``summary`` and ``full`` keys for each
            data category present in the event.
        """
        payload: dict[str, Any] = {}
        body = event.get("body", {})

        if isinstance(body, str):
            # Simple string body — wrap in a generic tier.
            payload["message"] = {
                "summary": body[:140] if len(body) > 140 else body,
                "full": body,
            }
        elif isinstance(body, dict):
            # Structured body — build tiers for each category.
            for category, value in body.items():
                if isinstance(value, dict) and "summary" in value:
                    # Already tiered.
                    payload[category] = value
                elif isinstance(value, str):
                    payload[category] = {
                        "summary": value[:140] if len(value) > 140 else value,
                        "full": value,
                    }
                else:
                    payload[category] = {
                        "summary": str(value)[:140],
                        "full": value,
                    }
        else:
            payload["message"] = {
                "summary": str(body)[:140],
                "full": body,
            }

        log.info(
            "nudge.d2d_prepared",
            categories=list(payload.keys()),
        )
        return payload

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _query_recent_messages(
        self, persona_id: str, contact_did: str
    ) -> list[dict]:
        """Query vault for recent messages with the contact.

        Filters to message types only (``message``, ``email``).
        The DID is searched via FTS5 (indexed in the ``contact_did``
        column and also often present in ``body``/``summary``).
        """
        try:
            results = await self._core.query_vault(
                persona_id,
                _quote_fts_value(contact_did),
                mode="hybrid",
                types=["message", "email"],
            )
            return results or []
        except Exception:
            log.warning(
                "nudge.message_query_failed",
                persona_id=persona_id,
                # Never log the DID in case it leaks persona boundaries.
            )
            return []

    async def _query_relationship_notes(
        self, persona_id: str, contact_did: str
    ) -> list[dict]:
        """Query vault for relationship notes about the contact.

        Filters to note-like types (``relationship_note``, ``note``,
        ``contact_card``).
        """
        try:
            results = await self._core.query_vault(
                persona_id,
                _quote_fts_value(contact_did),
                mode="hybrid",
                types=["relationship_note", "note", "contact_card"],
            )
            return results or []
        except Exception:
            return []

    async def _query_calendar_events(
        self, persona_id: str, contact_did: str
    ) -> list[dict]:
        """Query vault for upcoming calendar events with the contact.

        Filters to event type only.
        """
        try:
            results = await self._core.query_vault(
                persona_id,
                _quote_fts_value(contact_did),
                mode="hybrid",
                types=["event"],
            )
            return results or []
        except Exception:
            return []

    def _detect_promises(self, messages: list[dict]) -> list[dict]:
        """Scan recent messages for pending promises.

        Looks for patterns like "I'll send the PDF tomorrow" in message
        summaries or body text.
        """
        promises: list[dict] = []
        for msg in messages:
            text = _get(msg, "summary") or _get(msg, "bodyText") or _get(msg, "body_text")
            match = _PROMISE_PATTERNS.search(text)
            if match:
                promises.append({
                    "text": text,
                    "source_id": _get(msg, "id") or _get(msg, "ID"),
                })
        return promises
