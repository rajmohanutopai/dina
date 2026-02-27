"""POST /v1/pii/scrub endpoint — Tier 2 NER-based PII scrubbing.

Exposes the Brain's PII scrubber (spaCy NER) for direct invocation.
This enables integration tests and external callers to exercise
Tier 2 scrubbing independently of the full reason pipeline.

Maps to Brain TEST_PLAN SS3 (PII Scrubber) and SS10 (API Endpoints).

No imports from dina_admin — module boundary enforced.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ScrubRequest(BaseModel):
    """Input text for PII scrubbing."""

    text: str = Field(..., max_length=100_000)


class ScrubResponse(BaseModel):
    """Result of PII scrubbing."""

    scrubbed: str
    entities: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# State holder — injected by create_brain_app
# ---------------------------------------------------------------------------

_scrubber: Any = None


def set_scrubber(scrubber: Any) -> None:
    """Set the PII scrubber instance.  Called once during app creation."""
    global _scrubber
    _scrubber = scrubber


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/v1/pii/scrub", response_model=ScrubResponse)
async def scrub_pii(request: ScrubRequest) -> ScrubResponse:
    """Scrub PII from the provided text using Tier 2 NER.

    If no scrubber is available (spaCy not installed), returns
    the text unchanged with an empty entity list.

    Returns
    -------
    ScrubResponse
        ``scrubbed`` text and a list of ``entities`` with keys
        ``type``, ``value``, and ``token``.
    """
    if _scrubber is None:
        log.warning("pii.scrub.no_scrubber")
        raise HTTPException(
            status_code=503,
            detail="PII scrubber unavailable",
        )

    try:
        scrubbed, entities = await asyncio.to_thread(_scrubber.scrub, request.text)
    except Exception as exc:
        log.error(
            "pii.scrub.error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=500,
            detail="PII scrubbing failed",
        ) from exc

    return ScrubResponse(scrubbed=scrubbed, entities=entities)
