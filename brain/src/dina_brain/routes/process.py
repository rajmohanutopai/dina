"""POST /v1/process endpoint — inbound event processing.

Delegates to GuardianLoop.process_event() for silence classification,
agent intent review, and event triage.

Maps to Brain TEST_PLAN SS10.2 (POST /v1/process).

No imports from dina_admin — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Discriminator, Field, Tag

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Typed event variants — discriminated union on the "type" field.
#
# Each variant declares required fields for its event type.  Common optional
# fields (task_id, timestamp, persona_id, source) are on the base class.
# ---------------------------------------------------------------------------


class _EventBase(BaseModel):
    """Common fields shared by all event types."""

    model_config = {"populate_by_name": True}

    task_id: str | None = None
    timestamp: str | None = None
    persona_id: str | None = None
    source: str | None = None


# ── Vault lifecycle ──────────────────────────────────────────────────────

class VaultUnlockedEvent(_EventBase):
    type: Literal["vault_unlocked"]


class VaultLockedEvent(_EventBase):
    type: Literal["vault_locked"]


class PersonaUnlockedEvent(_EventBase):
    type: Literal["persona_unlocked"]


# ── Agent Safety Layer ───────────────────────────────────────────────────

class AgentIntentEvent(_EventBase):
    type: Literal["agent_intent"]
    agent_did: str
    action: str
    target: str | None = None
    risk_level: str | None = None
    trust_level: str | None = None
    session: str | None = None
    payload: dict | None = None


class DelegationRequestEvent(_EventBase):
    type: Literal["delegation_request"]
    payload: dict
    trust_level: str | None = None


class CrossPersonaRequestEvent(_EventBase):
    type: Literal["cross_persona_request"]
    payload: dict


class IntentApprovedEvent(_EventBase):
    type: Literal["intent_approved"]
    proposal_id: str | None = None
    approved_text: str | None = None
    payload: dict | None = None


class IntentDeniedEvent(_EventBase):
    type: Literal["intent_denied"]
    proposal_id: str | None = None
    reason: str | None = None
    payload: dict | None = None


class DisclosureApprovedEvent(_EventBase):
    type: Literal["disclosure_approved"]
    disclosure_id: str | None = None
    approved_text: str | None = None
    payload: dict | None = None


# ── Document & Reminders ─────────────────────────────────────────────────

class DocumentIngestEvent(_EventBase):
    type: Literal["document_ingest"]
    body: str | dict
    priority: str | None = None


class ReminderFiredEvent(_EventBase):
    type: Literal["reminder_fired"]
    body: str | dict | None = None
    payload: dict | None = None


# ── Persona access control ───────────────────────────────────────────────

class ApprovalNeededEvent(_EventBase):
    type: Literal["approval_needed"]
    payload: dict | None = None
    # Top-level fields (for direct calls); payload takes precedence.
    id: str | None = Field(None, description="Approval request ID")
    persona: str | None = None
    client_did: str | None = None
    session: str | None = None
    reason: str | None = None
    preview: str | None = None


# ── Pull Economy ─────────────────────────────────────────────────────────

class AgentResponseEvent(_EventBase):
    type: Literal["agent_response"]
    body: str | dict | None = None
    metadata: dict | None = None


class ReasonEvent(_EventBase):
    type: Literal["reason"]
    prompt: str | None = None
    body: str | dict | None = None
    persona_tier: str | None = None
    provider: str | None = None
    skip_vault_enrichment: bool = False
    agent_did: str | None = None
    session: str | None = None


# ── Relationship maintenance ─────────────────────────────────────────────

class ContactNeglectEvent(_EventBase):
    type: Literal["contact_neglect"]
    metadata: dict | None = None


# ── Post-publication ─────────────────────────────────────────────────────

class PostPublishEvent(_EventBase):
    type: Literal["post_publish"]
    payload: dict | None = None


# ── Standard / DIDComm / catch-all ───────────────────────────────────────

class StandardEvent(_EventBase):
    """Catch-all for standard events (message, alert, notification, reminder)
    and DIDComm messages (dina/social/*, dina/commerce/*, etc.).

    DIDComm types use dynamic prefixes that can't be Literal variants.
    Standard events flow through the silence classifier.
    """

    type: str
    body: str | dict | None = None
    priority: str | None = None
    from_did: str | None = Field(None, alias="from")
    contact_did: str | None = None
    agent_did: str | None = None
    action: str | None = None
    target: str | None = None
    risk_level: str | None = None
    trust_level: str | None = None
    payload: dict | None = None
    context: dict | None = None


# ── Discriminator function ───────────────────────────────────────────────

_TYPE_TAG_MAP: dict[str, str] = {
    "vault_unlocked": "vault_unlocked",
    "vault_locked": "vault_locked",
    "persona_unlocked": "persona_unlocked",
    "agent_intent": "agent_intent",
    "delegation_request": "delegation_request",
    "cross_persona_request": "cross_persona_request",
    "intent_approved": "intent_approved",
    "intent_denied": "intent_denied",
    "disclosure_approved": "disclosure_approved",
    "document_ingest": "document_ingest",
    "reminder_fired": "reminder_fired",
    "approval_needed": "approval_needed",
    "agent_response": "agent_response",
    "reason": "reason",
    "contact_neglect": "contact_neglect",
    "post_publish": "post_publish",
}


def _event_discriminator(v: Any) -> str:
    """Route incoming JSON to the correct event variant.

    Known type strings get their own typed model.  DIDComm prefixes
    (dina/*) and standard events (message, alert, etc.) fall through
    to StandardEvent.
    """
    if isinstance(v, dict):
        t = v.get("type", "")
    else:
        t = getattr(v, "type", "")
    return _TYPE_TAG_MAP.get(t, "standard")


ProcessEventRequest = Annotated[
    Union[
        Annotated[VaultUnlockedEvent, Tag("vault_unlocked")],
        Annotated[VaultLockedEvent, Tag("vault_locked")],
        Annotated[PersonaUnlockedEvent, Tag("persona_unlocked")],
        Annotated[AgentIntentEvent, Tag("agent_intent")],
        Annotated[DelegationRequestEvent, Tag("delegation_request")],
        Annotated[CrossPersonaRequestEvent, Tag("cross_persona_request")],
        Annotated[IntentApprovedEvent, Tag("intent_approved")],
        Annotated[IntentDeniedEvent, Tag("intent_denied")],
        Annotated[DisclosureApprovedEvent, Tag("disclosure_approved")],
        Annotated[DocumentIngestEvent, Tag("document_ingest")],
        Annotated[ReminderFiredEvent, Tag("reminder_fired")],
        Annotated[ApprovalNeededEvent, Tag("approval_needed")],
        Annotated[AgentResponseEvent, Tag("agent_response")],
        Annotated[ReasonEvent, Tag("reason")],
        Annotated[ContactNeglectEvent, Tag("contact_neglect")],
        Annotated[PostPublishEvent, Tag("post_publish")],
        Annotated[StandardEvent, Tag("standard")],
    ],
    Discriminator(_event_discriminator),
]


class ProcessEventResponse(BaseModel):
    """Result of event processing from the guardian loop.

    At least ``status`` is always set.  The remaining fields are populated
    depending on the event type and the guardian's decision.
    """

    status: str = "ok"
    action: str | None = None
    classification: str | None = None
    decision: str | None = None
    response: dict | None = None
    # Nudge payload (populated for DIDComm social messages)
    nudge: dict | None = None
    # Agent intent fields (populated for agent_intent events)
    risk: str | None = None
    approved: bool | None = None
    requires_approval: bool | None = None
    proposal_id: str | None = None


# ---------------------------------------------------------------------------
# State holder — injected by create_brain_app
# ---------------------------------------------------------------------------

_guardian: Any = None


def set_guardian(guardian: Any) -> None:
    """Set the guardian loop instance.  Called once during app creation."""
    global _guardian
    _guardian = guardian


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/v1/process", response_model=ProcessEventResponse)
async def process_event(
    event: Annotated[ProcessEventRequest, Field(discriminator=None)],
) -> ProcessEventResponse:
    """Process an incoming event from core.

    The request body is validated against typed event variants based on
    the ``type`` field.  Known types (agent_intent, vault_unlocked, etc.)
    get strict schema validation.  Unknown types and DIDComm messages
    (dina/*) fall through to the permissive StandardEvent model.

    Delegates to GuardianLoop.process_event() and translates the returned
    dict into a typed ProcessEventResponse.
    """
    if _guardian is None:
        raise HTTPException(
            status_code=503,
            detail="Guardian loop not initialised",
        )

    event_dict = event.model_dump(by_alias=True, exclude_none=True)

    try:
        result = await _guardian.process_event(event_dict)
    except ValueError as exc:
        # BR2: Log full error server-side; return generic message to caller.
        # str(exc) may contain internal rejection reasons or data structure names.
        log.warning(
            "process_event.bad_request",
            extra={"event_type": event.type, "error": str(exc)},
        )
        raise HTTPException(status_code=400, detail="Invalid request") from exc
    except Exception as exc:
        log.error(
            "process_event.internal_error",
            extra={"event_type": event.type, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=500,
            detail="Processing request failed",
        ) from exc

    if result.get("action") == "error":
        raise HTTPException(
            status_code=500,
            detail=result.get("error", "internal error"),
        )

    return ProcessEventResponse(
        status=result.get("status", "ok"),
        action=result.get("action"),
        classification=result.get("classification"),
        decision=result.get("decision"),
        response=result.get("response"),
        nudge=result.get("nudge"),
        risk=result.get("risk"),
        approved=result.get("approved"),
        requires_approval=result.get("requires_approval"),
        proposal_id=result.get("proposal_id"),
    )
