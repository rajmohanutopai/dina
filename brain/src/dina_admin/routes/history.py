"""History routes for the admin UI.

Paginated list of vault items fetched from core.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/history")

_core_client: Any = None


def set_core_client(core_client: Any) -> None:
    """Set the core client. Called once during app creation."""
    global _core_client
    _core_client = core_client


@router.get("/")
async def list_history(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    persona_id: str = Query("default"),
    q: str = Query(""),
) -> dict:
    """List vault items with pagination and optional search.

    Uses ``POST /v1/vault/query`` on core with all non-KV item types.
    The ``q`` parameter filters results by matching against type, source,
    or summary fields (case-insensitive substring match).
    """
    if _core_client is None:
        return {"items": [], "page": page, "limit": limit, "total": 0}

    try:
        items = await _core_client.query_vault(
            persona_id,
            "",
            types=["email", "message", "event", "note", "photo",
                   "email_draft", "cart_handover"],
            limit=200,
        )
        # Normalise keys to snake_case for the frontend.
        normalised = [
            {
                "id": it.id or "",
                "type": it.type or "",
                "source": it.source or "",
                "summary": it.summary or "",
                "timestamp": it.ingested_at or it.timestamp or 0,
            }
            for it in items
        ]
        # Client-side search filter
        if q:
            q_lower = q.lower()
            normalised = [
                item for item in normalised
                if q_lower in (item["type"] or "").lower()
                or q_lower in (item["source"] or "").lower()
                or q_lower in (item["summary"] or "").lower()
            ]
        total = len(normalised)
        start = (page - 1) * limit
        end = start + limit
        return {
            "items": normalised[start:end],
            "page": page,
            "limit": limit,
            "total": total,
        }
    except Exception as exc:
        log.error("history.list_error", extra={"error": type(exc).__name__})
        return {"items": [], "page": page, "limit": limit, "total": 0}
