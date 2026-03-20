"""GET /v1/proposals — intent proposal status queries.

Provides polling endpoints for agents waiting on intent approval.
Reads from Guardian's in-memory proposal store.

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
    Agents poll this after receiving requires_approval=True.
    """
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    proposals = getattr(_guardian, "_pending_proposals", {})
    stored = proposals.get(proposal_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Unknown proposal_id")

    return {
        "id": proposal_id,
        "status": stored.get("status", "pending"),
        "kind": stored.get("kind", "intent"),
        "action": stored.get("action", ""),
        "target": stored.get("target", ""),
        "agent_did": stored.get("agent_did", ""),
        "created_at": stored.get("created_at", 0),
        "updated_at": stored.get("updated_at", 0),
    }


@router.get("/v1/proposals")
async def proposal_list() -> dict:
    """List all pending intent proposals. Admin only."""
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not initialised")

    proposals = getattr(_guardian, "_pending_proposals", {})
    intent_proposals = [
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
    ]

    return {"proposals": intent_proposals}
