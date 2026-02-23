"""POST /v1/process endpoint — inbound event processing.

Delegates to GuardianLoop.process_event() for silence classification,
agent intent review, and event triage.

Maps to Brain TEST_PLAN SS10.2 (POST /v1/process).

No imports from dina_admin — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ProcessEventRequest(BaseModel):
    """Inbound event from core for brain processing.

    The ``type`` field is always required.  All other fields are optional
    because different event types carry different payloads:

    - ``message``       : body is a string
    - ``agent_intent``  : agent_did, action, target, risk_level are populated
    - ``alert``         : priority + body
    - ``vault_unlocked``: persona_id
    """

    type: str
    timestamp: str | None = None
    persona_id: str | None = None
    source: str | None = None
    body: str | dict | None = None
    priority: str | None = None
    # Agent intent fields (Agent Safety Layer)
    agent_did: str | None = None
    action: str | None = None
    target: str | None = None
    risk_level: str | None = None
    # Structured payload (alternative to flat fields above)
    payload: dict | None = None


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
    # Agent intent fields (populated for agent_intent events)
    risk: str | None = None
    approved: bool | None = None
    requires_approval: bool | None = None


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
async def process_event(event: ProcessEventRequest) -> ProcessEventResponse:
    """Process an incoming event from core.

    Delegates to GuardianLoop.process_event() and translates the returned
    dict into a typed ProcessEventResponse.

    Raises
    ------
    HTTPException 500
        If the guardian loop raises an unexpected error.
    HTTPException 400
        If the event type is unrecognised by the guardian.
    """
    if _guardian is None:
        raise HTTPException(
            status_code=503,
            detail="Guardian loop not initialised",
        )

    event_dict = event.model_dump(exclude_none=True)

    try:
        result = await _guardian.process_event(event_dict)
    except ValueError as exc:
        # Unknown event type or invalid payload
        log.warning(
            "process_event.bad_request",
            extra={"event_type": event.type, "error": str(exc)},
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        log.error(
            "process_event.internal_error",
            extra={"event_type": event.type, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal processing error: {type(exc).__name__}",
        ) from exc

    return ProcessEventResponse(
        status=result.get("status", "ok"),
        action=result.get("action"),
        classification=result.get("classification"),
        decision=result.get("decision"),
        response=result.get("response"),
        risk=result.get("risk"),
        approved=result.get("approved"),
        requires_approval=result.get("requires_approval"),
    )
