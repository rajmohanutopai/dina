"""POST /v1/reason endpoint — complex LLM reasoning queries.

Handles multi-step reasoning: embedding generation, hybrid search via core,
PII scrubbing for cloud LLMs, LLM completion, rehydration.

Maps to Brain TEST_PLAN SS10.3 (POST /v1/reason).

No imports from dina_admin — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ReasonRequest(BaseModel):
    """Complex reasoning query from core.

    The ``prompt`` field is always required.  The optional fields allow
    core to pass persona context for privacy-aware LLM routing.
    """

    type: str | None = "reason"
    prompt: str = Field(..., max_length=32_000)
    persona_id: str | None = Field(None, max_length=100)
    persona_tier: Literal["open", "restricted", "locked"] | None = Field(default="open")
    provider: str | None = Field(None, max_length=50)
    skip_vault_enrichment: bool = False


class ReasonResponse(BaseModel):
    """LLM reasoning result returned to core.

    ``content`` contains the rehydrated (PII-restored) answer.
    Token counts and model name are included for observability.
    ``vault_context_used`` indicates whether the agentic reasoning loop
    successfully queried persona vaults for personalization context.
    """

    content: str
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    vault_context_used: bool = False


# ---------------------------------------------------------------------------
# State holders — injected by create_brain_app
# ---------------------------------------------------------------------------

_guardian: Any = None
_sync_engine: Any = None


def set_dependencies(guardian: Any, sync_engine: Any) -> None:
    """Set service dependencies.  Called once during app creation."""
    global _guardian, _sync_engine
    _guardian = guardian
    _sync_engine = sync_engine


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/v1/reason", response_model=ReasonResponse)
async def reason_query(request: ReasonRequest) -> ReasonResponse:
    """Handle a complex query from core requiring LLM reasoning.

    Pipeline:
        1. Generate query embedding (if LLM supports it)
        2. Call core for hybrid search (FTS5 + semantic)
        3. Assemble context from results
        4. PII-scrub context for cloud LLM (skip if local)
        5. Call LLM with assembled context
        6. Rehydrate response (replace PII tokens with originals)
        7. Return answer

    Raises
    ------
    HTTPException 503
        If the guardian loop is not initialised.
    HTTPException 500
        If an unexpected error occurs during reasoning.
    """
    if _guardian is None:
        raise HTTPException(
            status_code=503,
            detail="Guardian loop not initialised",
        )

    reason_event = {
        "type": "reason",
        "prompt": request.prompt,
        "persona_id": request.persona_id,
        "persona_tier": request.persona_tier,
        "provider": request.provider,
        "skip_vault_enrichment": request.skip_vault_enrichment,
    }

    try:
        result = await _guardian.process_event(reason_event)
    except Exception as exc:
        log.error(
            "reason_query.internal_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=500,
            detail="Reasoning request failed",
        ) from exc

    return ReasonResponse(
        content=result.get("content", ""),
        model=result.get("model"),
        tokens_in=result.get("tokens_in"),
        tokens_out=result.get("tokens_out"),
        vault_context_used=result.get("vault_context_used", False),
    )
