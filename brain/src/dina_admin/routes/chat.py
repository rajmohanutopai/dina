"""Chat endpoint for admin UI dashboard.

POST /api/chat — forwards prompt to brain's /api/v1/reason via
internal HTTP call. Preserves module isolation between dina_admin
and dina_brain.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

_config: Any = None


def set_config(config: Any) -> None:
    """Set config. Called once during app creation."""
    global _config
    _config = config


class ChatRequest(BaseModel):
    """Chat message from the admin UI."""
    prompt: str


@router.post("/chat")
async def chat(request: ChatRequest) -> dict:
    """Forward chat prompt to brain's /api/v1/reason endpoint."""
    if _config is None:
        raise HTTPException(status_code=503, detail="Config not available")

    brain_url = f"http://localhost:{getattr(_config, 'listen_port', 8200)}"
    brain_token = getattr(_config, "brain_token", "")

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            resp = await client.post(
                f"{brain_url}/api/v1/reason",
                json={"prompt": request.prompt},
                headers={"Authorization": f"Bearer {brain_token}"},
            )
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            log.error("chat.brain_error", extra={
                "status": exc.response.status_code,
                "detail": exc.response.text[:200],
            })
            raise HTTPException(
                status_code=502,
                detail="Brain API error",
            ) from exc
        except Exception as exc:
            log.error("chat.error", extra={"error": type(exc).__name__})
            raise HTTPException(
                status_code=502,
                detail=f"Failed to reach brain API: {type(exc).__name__}",
            ) from exc
