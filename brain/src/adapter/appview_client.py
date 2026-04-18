"""AppView HTTP client for service discovery.

Implements the requester-side lookups against the Trust Network's
service registry:

    GET /xrpc/com.dina.service.search   — find services by capability + geo
    GET /xrpc/com.dina.service.isPublic  — check if a DID is a public service

Third-party imports: httpx.
"""

from __future__ import annotations

import httpx


class AppViewClient:
    """Async HTTP client for AppView service discovery endpoints."""

    def __init__(self, appview_url: str) -> None:
        self._url = appview_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=10)

    async def search_services(
        self,
        capability: str,
        lat: float | None = None,
        lng: float | None = None,
        radius_km: float = 5,
        q: str | None = None,
    ) -> list[dict]:
        """Search for public services by capability, optionally by location.

        When ``lat`` and ``lng`` are supplied the results are ranked by
        proximity + text + trust. When omitted (non-geospatial queries),
        distance scoring is skipped and ranking falls back to text + trust.
        """
        params: dict[str, str | float] = {
            "capability": capability,
            "radiusKm": radius_km,
        }
        if lat is not None and lng is not None:
            params["lat"] = lat
            params["lng"] = lng
        if q:
            params["q"] = q
        resp = await self._client.get(
            f"{self._url}/xrpc/com.dina.service.search", params=params,
        )
        resp.raise_for_status()
        return resp.json().get("services", [])

    async def is_public(self, did: str) -> tuple[bool, list[str]]:
        """Check whether a DID is registered as a public service.

        Returns (is_public, capabilities) tuple.
        """
        resp = await self._client.get(
            f"{self._url}/xrpc/com.dina.service.isPublic", params={"did": did},
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("isPublic", False), data.get("capabilities", [])
