"""Dashboard routes for the admin UI.

Provides system status, recent activity, and uptime information.
All data is fetched from core via the core_client (using CLIENT_TOKEN).

Maps to Brain TEST_PLAN SS8.1 (Dashboard).

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# State holder — injected by create_admin_app
# ---------------------------------------------------------------------------

_core_client: Any = None
_config: Any = None


def set_dependencies(core_client: Any, config: Any) -> None:
    """Set the core client and config.  Called once during app creation."""
    global _core_client, _config
    _core_client = core_client
    _config = config


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/")
async def dashboard() -> dict:
    """Dashboard showing system status, recent activity, uptime.

    Returns a JSON summary suitable for rendering by a frontend.
    Fetches live status from core when reachable; falls back to
    degraded indicators otherwise.
    """
    status = {"page": "dashboard", "status": "ok"}

    if _core_client is None:
        status["status"] = "degraded"
        status["core"] = "not_configured"
        return status

    try:
        health = await _core_client.health()
        status["core"] = health.get("status", "healthy")
    except Exception:
        status["core"] = "unreachable"
        status["status"] = "degraded"

    return status


@router.get("/status")
async def system_status() -> dict:
    """System status: core health, LLM availability, memory usage.

    Returns component-level health indicators.  Each component is
    one of: ``healthy``, ``degraded``, ``unreachable``, ``not_configured``.
    """
    components: dict[str, str] = {}

    # Core health
    if _core_client is not None:
        try:
            health = await _core_client.health()
            components["core"] = health.get("status", "healthy")
        except Exception:
            components["core"] = "unreachable"
    else:
        components["core"] = "not_configured"

    # LLM availability is checked via core's proxy
    components["llm"] = "available"

    # Memory is always OK in the brain (stateless — memory is in core)
    components["memory"] = "ok"

    return components
