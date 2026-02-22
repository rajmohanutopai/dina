"""Settings management routes for the admin UI.

Read and update brain/system settings — all proxied to core using
CLIENT_TOKEN.

Maps to Brain TEST_PLAN SS8 (Admin UI).

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings")


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
async def get_settings() -> dict:
    """Get current settings.

    Returns a dict of the current brain and system settings.
    Sensitive values (tokens, keys) are redacted in the response.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    settings: dict[str, Any] = {}

    # Pull user preferences from core KV
    try:
        raw = await _core_client.get_kv("user_settings")
        if raw is not None:
            settings = json.loads(raw) if isinstance(raw, str) else raw
    except Exception as exc:
        log.warning(
            "settings.get_error",
            extra={"error": type(exc).__name__},
        )
        # Fall through with empty settings — non-fatal

    # Include non-sensitive config values
    if _config is not None:
        settings["core_url"] = getattr(_config, "core_url", None)
        settings["listen_port"] = getattr(_config, "listen_port", None)
        settings["log_level"] = getattr(_config, "log_level", None)
        settings["cloud_llm"] = getattr(_config, "cloud_llm", None)
        # Never expose tokens
        settings["brain_token"] = "***REDACTED***"

    return settings


@router.put("/")
async def update_settings(settings: dict) -> dict:
    """Update settings.

    Persists user-modifiable settings to core's KV store.
    Returns the updated settings dict.

    Only a known set of keys are accepted; unknown keys are ignored
    to prevent injection of arbitrary config.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    # Allowlist of user-modifiable settings
    allowed_keys = {
        "briefing_enabled",
        "briefing_time",
        "dnd_enabled",
        "dnd_start",
        "dnd_end",
        "cloud_consent",
        "default_persona",
        "notification_preferences",
    }

    # Filter to allowed keys only
    filtered = {k: v for k, v in settings.items() if k in allowed_keys}
    ignored = set(settings.keys()) - allowed_keys
    if ignored:
        log.info(
            "settings.ignored_keys",
            extra={"keys": list(ignored)},
        )

    try:
        # Merge with existing settings
        raw = await _core_client.get_kv("user_settings")
        existing = json.loads(raw) if raw else {}
        existing.update(filtered)
        await _core_client.set_kv("user_settings", json.dumps(existing))
        log.info("settings.updated", extra={"keys": list(filtered.keys())})
        return existing
    except Exception as exc:
        log.error(
            "settings.update_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to update settings in core",
        ) from exc
