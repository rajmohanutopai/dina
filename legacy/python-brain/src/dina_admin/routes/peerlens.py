"""Trust cache API routes for the admin UI.

Proxies trust cache requests to core's /v1/trust/* endpoints.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter()

_core_client: Any = None


def set_core_client(client: Any) -> None:
    """Set the core client. Called once during app creation."""
    global _core_client
    _core_client = client


@router.get("/api/trust/cache")
async def get_trust_cache() -> dict:
    """List all cached trust entries."""
    if _core_client is None:
        return {"entries": [], "error": "core client not configured"}
    try:
        resp = await _core_client.get("/v1/trust/cache")
        return resp
    except Exception as exc:
        log.warning("trust.cache_fetch_failed", extra={"error": str(exc)})
        return {"entries": [], "error": str(exc)}


@router.get("/api/trust/stats")
async def get_trust_stats() -> dict:
    """Get trust cache statistics."""
    if _core_client is None:
        return {"count": 0, "last_sync_at": 0, "error": "core client not configured"}
    try:
        resp = await _core_client.get("/v1/trust/stats")
        return resp
    except Exception as exc:
        log.warning("trust.stats_fetch_failed", extra={"error": str(exc)})
        return {"count": 0, "last_sync_at": 0, "error": str(exc)}


@router.post("/api/trust/sync")
async def trigger_sync() -> dict:
    """Trigger a manual trust neighborhood sync."""
    if _core_client is None:
        return {"synced_count": 0, "error": "core client not configured"}
    try:
        resp = await _core_client.post("/v1/trust/sync")
        return resp
    except Exception as exc:
        log.warning("trust.sync_failed", extra={"error": str(exc)})
        return {"synced_count": 0, "error": str(exc)}
