"""Chat endpoint for admin UI dashboard.

POST /api/chat — calls GuardianLoop directly (no internal HTTP/token hop).
Preserves module isolation by dependency injection from composition root.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

_guardian: Any = None


def set_guardian(guardian: Any) -> None:
    """Set GuardianLoop dependency. Called once during app creation."""
    global _guardian
    _guardian = guardian


class ChatRequest(BaseModel):
    """Chat message from the admin UI."""
    prompt: str = Field(..., max_length=32_000)
    persona_tier: str = Field(default="open", max_length=20)


@router.post("/chat")
async def chat(request: ChatRequest) -> dict:
    """Run a reasoning query through GuardianLoop."""
    if _guardian is None:
        raise HTTPException(status_code=503, detail="Guardian not available")
    reason_event = {
        "type": "reason",
        "prompt": request.prompt,
        "persona_tier": request.persona_tier,
    }
    try:
        result = await _guardian.process_event(reason_event)
        return {
            "content": result.get("content", ""),
            "model": result.get("model"),
            "tokens_in": result.get("tokens_in"),
            "tokens_out": result.get("tokens_out"),
            "vault_context_used": result.get("vault_context_used", False),
        }
    except Exception as exc:
        log.error("chat.error", extra={"error": str(exc)})
        raise HTTPException(status_code=500, detail="Reasoning request failed") from exc
