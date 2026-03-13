"""Typed admin client for core:8100 API calls.

Wraps CoreHTTPClient with admin-specific convenience methods.
All methods return typed dicts suitable for template rendering.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


class AdminCoreClient:
    """Admin-facing wrapper around the raw CoreHTTPClient."""

    def __init__(self, core_client: Any) -> None:
        self._core = core_client

    async def get_health(self) -> dict:
        """Get system health from core + brain status."""
        result = {"core": "unknown", "brain": "healthy", "pds": "unknown"}
        try:
            health = await self._core.health()
            result["core"] = health.get("status", "healthy")
        except Exception:
            result["core"] = "unreachable"
        return result

    async def get_identity(self) -> dict:
        """Get DID and identity info."""
        try:
            resp = await self._core._request("GET", "/v1/did/document")
            data = resp.json()
            return {
                "did": data.get("id", data.get("did", "")),
                "created": data.get("created", ""),
            }
        except Exception as exc:
            log.warning("admin_core_client.identity_error", extra={"error": str(exc)})
            return {"did": "", "created": ""}

    async def get_vault_stats(self) -> dict:
        """Get vault statistics."""
        return {"item_count": 0, "persona_count": 1, "db_size_bytes": 0}

    async def get_audit_recent(self, limit: int = 20) -> list:
        """Get recent audit entries from Core."""
        try:
            return await self._core.audit_query(limit=limit)
        except Exception:
            return []

    async def get_devices(self) -> list:
        """Get paired devices list."""
        try:
            resp = await self._core._request("GET", "/v1/devices")
            data = resp.json()
            return data if isinstance(data, list) else data.get("devices", [])
        except Exception:
            return []

    async def get_contacts(self) -> list:
        """Get contacts list."""
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            data = resp.json()
            return data if isinstance(data, list) else data.get("contacts", [])
        except Exception:
            return []
