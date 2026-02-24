"""Settings management routes for the admin UI.

Read and update brain/system settings — all proxied to core using
CLIENT_TOKEN.

Maps to Brain TEST_PLAN SS8 (Admin UI).

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Awaitable

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings")


# ---------------------------------------------------------------------------
# State holder — injected by create_admin_app
# ---------------------------------------------------------------------------

_core_client: Any = None
_config: Any = None
_llm_reload_callback: Callable[[], Awaitable[None]] | None = None

# Keys that contain API secrets — must be redacted in GET responses.
_SECRET_KEYS = frozenset({
    "gemini_api_key",
    "anthropic_api_key",
    "openai_api_key",
    "openrouter_api_key",
})


def set_dependencies(core_client: Any, config: Any) -> None:
    """Set the core client and config.  Called once during app creation."""
    global _core_client, _config
    _core_client = core_client
    _config = config


def set_llm_reload_callback(callback: Callable[[], Awaitable[None]]) -> None:
    """Set the callback that rebuilds LLM providers from stored keys."""
    global _llm_reload_callback
    _llm_reload_callback = callback


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _redact_key(key: str) -> str:
    """Redact an API key to show only the last 4 characters."""
    if not key or len(key) <= 4:
        return "***"
    return f"***...{key[-4:]}"


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

    # Identity info from core
    try:
        did_doc = await _core_client.get_did()
        settings["did"] = did_doc.get("id", "")
        settings["did_created"] = did_doc.get("created_at", "")
    except Exception:
        pass  # Non-fatal — identity may not be set up

    # Redact API keys — only expose last 4 chars
    for secret_key in _SECRET_KEYS:
        if secret_key in settings and settings[secret_key]:
            settings[secret_key] = _redact_key(settings[secret_key])

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
        # LLM provider configuration
        "gemini_api_key",
        "anthropic_api_key",
        "openai_api_key",
        "openrouter_api_key",
        "openai_model",
        "openrouter_model",
        "preferred_cloud",
    }

    # Filter to allowed keys only
    filtered = {k: v for k, v in settings.items() if k in allowed_keys}
    ignored = set(settings.keys()) - allowed_keys
    if ignored:
        log.info(
            "settings.ignored_keys",
            extra={"keys": list(ignored)},
        )

    # Check if any LLM keys are being changed
    llm_keys_changed = bool(filtered.keys() & (_SECRET_KEYS | {
        "openai_model", "openrouter_model", "preferred_cloud",
    }))

    try:
        # Merge with existing settings
        raw = await _core_client.get_kv("user_settings")
        existing = json.loads(raw) if raw else {}
        existing.update(filtered)
        await _core_client.set_kv("user_settings", json.dumps(existing))
        log.info("settings.updated", extra={"keys": list(filtered.keys())})

        # Hot-reload LLM providers if any LLM-related keys changed
        if llm_keys_changed and _llm_reload_callback is not None:
            try:
                await _llm_reload_callback()
                log.info("settings.llm_reloaded")
            except Exception as exc:
                log.warning(
                    "settings.llm_reload_failed",
                    extra={"error": type(exc).__name__},
                )

        # Redact secrets before returning
        result = dict(existing)
        for secret_key in _SECRET_KEYS:
            if secret_key in result and result[secret_key]:
                result[secret_key] = _redact_key(result[secret_key])
        return result
    except Exception as exc:
        log.error(
            "settings.update_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to update settings in core",
        ) from exc
