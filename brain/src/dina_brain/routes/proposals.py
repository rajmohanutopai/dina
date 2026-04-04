"""GET /v1/proposals — intent proposal status queries.

Provides polling endpoints for agents waiting on intent approval.
Reads from Guardian's in-memory proposal store.

Only intent proposals (kind=intent) are exposed through these
endpoints.  Disclosure proposals are accessed through separate
cross-persona routes.

No imports from dina_admin — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter()

_guardian: Any = None


def set_guardian(guardian: Any) -> None:
    """Set the guardian loop instance. Called once during app creation."""
    global _guardian
    _guardian = guardian


@router.get("/v1/proposals/{proposal_id}/status")
async def proposal_status(proposal_id: str) -> dict:
    """Query the lifecycle state of an intent proposal.

    Returns status: pending, approved, denied, or expired.
    Only returns intent proposals (kind=intent).  Returns 404 for
    disclosure proposals or unknown IDs.
    """
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    proposals = getattr(_guardian, "_pending_proposals", {})
    stored = proposals.get(proposal_id)
    if stored is None or stored.get("kind") != "intent":
        raise HTTPException(status_code=404, detail="Unknown proposal_id")

    return {
        "id": proposal_id,
        "status": stored.get("status", "pending"),
        "kind": "intent",
        "action": stored.get("action", ""),
        "target": stored.get("target", ""),
        "agent_did": stored.get("agent_did", ""),
        "decision_reason": stored.get("decision_reason", ""),
        "created_at": stored.get("created_at", 0),
        "updated_at": stored.get("updated_at", 0),
    }


@router.get("/v1/proposals")
async def proposal_list() -> dict:
    """List pending intent proposals. Admin only.

    Only returns intent proposals with status=pending.
    Terminal proposals (approved/denied/expired) are excluded.
    """
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    proposals = getattr(_guardian, "_pending_proposals", {})
    pending_intents = [
        {
            "id": pid,
            "status": p.get("status", "pending"),
            "action": p.get("action", ""),
            "target": p.get("target", ""),
            "agent_did": p.get("agent_did", ""),
            "risk": p.get("risk", ""),
            "created_at": p.get("created_at", 0),
        }
        for pid, p in proposals.items()
        if p.get("kind") == "intent"
        and p.get("status") == "pending"
    ]

    return {"proposals": pending_intents}


@router.post("/v1/proposals/{proposal_id}/approve")
async def proposal_approve(proposal_id: str) -> dict:
    """Approve a pending intent proposal via the real Guardian flow."""
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    # Route through Guardian's intent_approved handler (persistence + audit).
    result = await _guardian.process_event({
        "type": "intent_approved",
        "payload": {"proposal_id": proposal_id},
    })
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error", "approval failed"))

    # Queue any linked delegated task (idempotent).
    # This path bypasses Core's HandleApprove — no second hook.
    queue_warning = ""
    core = getattr(_guardian, "_core", None)
    if core and hasattr(core, "queue_task_by_proposal"):
        try:
            await core.queue_task_by_proposal(proposal_id)
        except Exception as qe:
            queue_warning = f"task queueing failed: {qe}"
            log.warning("proposals.task_queue_failed",
                        extra={"proposal_id": proposal_id, "error": str(qe)})

    resp: dict = {"id": proposal_id, "status": "approved"}
    if queue_warning:
        resp["warning"] = queue_warning
    return resp


@router.post("/v1/proposals/{proposal_id}/deny")
async def proposal_deny(proposal_id: str) -> dict:
    """Deny a pending intent proposal via the real Guardian flow."""
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    result = await _guardian.process_event({
        "type": "intent_denied",
        "payload": {"proposal_id": proposal_id, "reason": "Denied via API"},
    })
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error", "denial failed"))

    return {"id": proposal_id, "status": "denied"}
