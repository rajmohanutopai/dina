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
) -> dict:
    """List vault items with pagination."""
    if _core_client is None:
        return {"items": [], "page": page, "limit": limit, "total": 0}

    try:
        results = await _core_client.search_vault(persona_id, "*")
        items = results if isinstance(results, list) else []
        start = (page - 1) * limit
        end = start + limit
        return {
            "items": items[start:end],
            "page": page,
            "limit": limit,
            "total": len(items),
        }
    except Exception as exc:
        log.error("history.list_error", extra={"error": type(exc).__name__})
        return {"items": [], "page": page, "limit": limit, "total": 0}
