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
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings")


# ---------------------------------------------------------------------------
# State holder — injected by create_admin_app
# ---------------------------------------------------------------------------

_core_client: Any = None
_config: Any = None
_llm_reload_callback: Callable[[], Awaitable[None]] | None = None

# Keys that contain API secrets — never exposed in GET responses.
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


def _strip_secrets(settings: dict[str, Any]) -> dict[str, Any]:
    """Remove secret keys and replace with *_configured booleans.

    Never exposes API key values — not even redacted.
    """
    result = dict(settings)
    for secret_key in _SECRET_KEYS:
        val = result.pop(secret_key, None)
        # "gemini_api_key" -> "gemini_key_configured"
        bool_key = secret_key.replace("_api_key", "_key_configured")
        result[bool_key] = bool(val)
    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/")
async def get_settings() -> dict:
    """Get current settings.

    Returns a dict of the current brain and system settings.
    API keys are never exposed — only boolean flags indicating
    whether each provider's key is configured.
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

    # Identity info from core
    try:
        did_doc = await _core_client.get_did()
        settings["did"] = did_doc.get("id", "")
        settings["did_created"] = did_doc.get("created_at", "")
    except Exception:
        pass  # Non-fatal — identity may not be set up

    # Strip API keys, replace with boolean flags
    return _strip_secrets(settings)


class SettingsUpdate(BaseModel):
    """Typed model for settings update requests.

    All fields are optional — only provided fields are updated.
    API keys have max_length to prevent abuse.
    Unknown keys are rejected (extra='forbid').
    """
    model_config = ConfigDict(extra="forbid")

    # Preferences
    briefing_enabled: bool | None = None
    briefing_time: str | None = Field(None, max_length=8)
    dnd_enabled: bool | None = None
    dnd_start: str | None = Field(None, max_length=8)
    dnd_end: str | None = Field(None, max_length=8)
    cloud_consent: bool | None = None
    default_persona: str | None = Field(None, max_length=64)
    notification_preferences: dict | None = None
    # LLM provider configuration
    gemini_api_key: str | None = Field(None, max_length=256)
    anthropic_api_key: str | None = Field(None, max_length=256)
    openai_api_key: str | None = Field(None, max_length=256)
    openrouter_api_key: str | None = Field(None, max_length=256)
    openai_model: str | None = Field(None, max_length=128)
    openrouter_model: str | None = Field(None, max_length=128)
    preferred_cloud: str | None = Field(None, max_length=32)
    # Role -> provider mapping
    analysis_provider: str | None = Field(None, max_length=32)
    chat_provider: str | None = Field(None, max_length=32)


@router.put("/")
async def update_settings(settings: SettingsUpdate) -> dict:
    """Update settings.

    Persists user-modifiable settings to core's KV store.
    Returns the updated settings dict (with secrets stripped).

    Uses a typed Pydantic model with ``extra='forbid'`` — unknown
    keys return HTTP 422.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    # Convert to dict, excluding None values (only update provided fields)
    filtered = settings.model_dump(exclude_none=True)

    if len(json.dumps(filtered, default=str)) > 64_000:
        raise HTTPException(status_code=413, detail="Settings payload too large")

    # HIGH-01: Strict boolean coercion — prevent "false" (truthy string) bypass
    if "cloud_consent" in filtered:
        filtered["cloud_consent"] = filtered["cloud_consent"] is True
    ignored: set = set()  # No longer applicable — Pydantic rejects unknown fields
    if ignored:
        log.info(
            "settings.ignored_keys",
            extra={"keys": list(ignored)},
        )

    # Check if any LLM keys are being changed
    llm_keys_changed = bool(filtered.keys() & (_SECRET_KEYS | {
        "openai_model", "openrouter_model", "preferred_cloud",
        "analysis_provider", "chat_provider",
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

        # Strip secrets before returning
        return _strip_secrets(existing)
    except Exception as exc:
        log.error(
            "settings.update_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to update settings in core",
        ) from exc
