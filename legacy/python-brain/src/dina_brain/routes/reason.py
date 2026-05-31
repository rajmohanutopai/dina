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
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

try:
    from ...domain.errors import ApprovalRequiredError as _ApprovalRequiredError
except ImportError:
    from domain.errors import ApprovalRequiredError as _ApprovalRequiredError

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
    persona_tier: Literal["default", "standard", "sensitive", "locked"] | None = Field(default="default")
    provider: str | None = Field(None, max_length=50, pattern=r"^[a-z0-9_-]+$")
    skip_vault_enrichment: bool = False
    # Agent context — forwarded from Core so vault access is attributed
    # to the originating agent, not to Brain.
    agent_did: str | None = Field(None, max_length=200)
    session: str | None = Field(None, max_length=200)
    # Source channel — when "telegram" or "admin", Brain treats the request
    # as user-originated, enabling auto-unlock of sensitive personas.
    source: str | None = Field(None, max_length=50)


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
        "agent_did": request.agent_did,
        "session": request.session,
        "source": request.source,
    }

    try:
        result = await _guardian.process_event(reason_event)
    except _ApprovalRequiredError as exc:
        # BR3: Use JSONResponse (not HTTPException with dict detail) for
        # structured approval-required responses. This is the legacy fallback
        # path — the main approval flow returns pending_approval via result dict.
        return JSONResponse(
            status_code=403,
            content={
                "error": "approval_required",
                "persona": exc.persona,
                "approval_id": exc.approval_id,
            },
        )
    except Exception as exc:
        log.error(
            "reason_query.internal_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=500,
            detail="Reasoning request failed",
        ) from exc

    # Check for pending_approval (async approval-wait-resume).
    # Brain returns this instead of raising ApprovalRequiredError.
    # Core will create a PendingReasonRecord and return 202 to the CLI.
    if isinstance(result, dict) and result.get("status") == "pending_approval":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "status": "pending_approval",
                "approval_id": result.get("approval_id", ""),
                "persona": result.get("persona", ""),
                "message": result.get("message", ""),
            },
        )

    # Check for structured LLM error (no provider, auth failure, timeout, etc.)
    if isinstance(result, dict) and result.get("error_code"):
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=200,
            content={
                "error_code": result["error_code"],
                "message": result.get("message", ""),
                "content": "",
            },
        )

    return ReasonResponse(
        content=result.get("content", ""),
        model=result.get("model"),
        tokens_in=result.get("tokens_in"),
        tokens_out=result.get("tokens_out"),
        vault_context_used=result.get("vault_context_used", False),
    )
