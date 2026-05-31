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
_llm_router: Any = None


def set_dependencies(core_client: Any, config: Any) -> None:
    """Set the core client and config.  Called once during app creation."""
    global _core_client, _config
    _core_client = core_client
    _config = config


def set_llm_router(llm_router: Any) -> None:
    """Set the LLM router for dynamic availability checks (LOW-10)."""
    global _llm_router
    _llm_router = llm_router


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/")
async def dashboard() -> dict:
    """Dashboard showing system status, recent activity, stats.

    Returns a JSON summary suitable for rendering by a frontend.
    Fetches live status and counts from core.
    """
    status: dict[str, Any] = {"page": "dashboard", "status": "ok"}

    if _core_client is None:
        status["status"] = "degraded"
        status["core"] = "not_configured"
        return status

    # Core health
    try:
        health = await _core_client.health()
        status["core"] = health.get("status", "healthy")
    except Exception:
        status["core"] = "unreachable"
        status["status"] = "degraded"

    # Stats: personas
    try:
        personas = await _core_client.list_personas()
        status["personas"] = len(personas)
    except Exception:
        status["personas"] = 0

    # Stats: devices
    try:
        devices = await _core_client.list_devices()
        status["devices"] = len(devices)
    except Exception:
        status["devices"] = 0

    # Stats: vault items + recent activity
    try:
        items = await _core_client.query_vault(
            "default", "",
            types=["email", "message", "event", "note", "photo",
                   "email_draft", "cart_handover"],
            limit=200,
        )
        status["items"] = len(items)
        # Recent 5 items for activity table
        recent = [
            {
                "type": it.type or "",
                "source": it.source or "",
                "summary": it.summary or "",
                "timestamp": it.ingested_at or it.timestamp or 0,
            }
            for it in items[:5]
        ]
        status["recent_activity"] = recent
    except Exception:
        status["items"] = 0
        status["recent_activity"] = []

    return status


@router.get("/status")
async def system_status() -> dict:
    """System status: core health, LLM availability, item counts.

    Returns component-level health indicators and statistics for the
    dashboard stat cards.
    """
    components: dict[str, Any] = {}

    # Core health
    if _core_client is not None:
        try:
            health = await _core_client.health()
            components["core"] = health.get("status", "healthy")
        except Exception:
            components["core"] = "unreachable"
    else:
        components["core"] = "not_configured"

    # LLM availability
    if _llm_router and _llm_router.available_models():
        components["llm"] = "available"
    else:
        components["llm"] = "unavailable"
    components["pds"] = "not_configured"

    # Stats: vault items
    try:
        items = await _core_client.query_vault(
            "default", "",
            types=["email", "message", "event", "note", "photo",
                   "email_draft", "cart_handover"],
            limit=200,
        )
        components["items"] = len(items)
    except Exception:
        components["items"] = 0

    # Stats: personas
    try:
        personas = await _core_client.list_personas()
        components["personas"] = len(personas)
    except Exception:
        components["personas"] = 0

    # Stats: contacts
    try:
        contacts = await _core_client.list_contacts()
        components["contacts"] = len(contacts)
    except Exception:
        components["contacts"] = 0

    # Stats: devices
    try:
        devices = await _core_client.list_devices()
        components["devices"] = len(devices)
    except Exception:
        components["devices"] = 0

    return components
