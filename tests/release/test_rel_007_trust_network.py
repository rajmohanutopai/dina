"""REL-007 PDS and Trust Network — trust resolve through AppView.

Verify the Core → AppView trust resolution pipeline works using the
real AT Protocol tier (PLC + PDS + Jetstream + AppView) running in
the release Docker stack.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestTrustNetwork:
    """Real API tests for REL-007: trust network via AppView."""

    # REL-007
    def test_rel_007_trust_resolve_endpoint_exists(
        self, core_url, auth_headers,
    ) -> None:
        """GET /v1/trust/resolve returns a valid response (not 404)."""
        resp = httpx.get(
            f"{core_url}/v1/trust/resolve",
            params={"did": "did:plc:nonexistent"},
            headers=auth_headers,
            timeout=10,
        )
        # Should return 404 (DID not found in AppView) or 200 (found),
        # but NOT 405 (route missing) or 500 (crash).
        assert resp.status_code in (200, 404), (
            f"Trust resolve should return 200/404, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )

    # REL-007
    def test_rel_007_trust_resolve_requires_did_param(
        self, core_url, auth_headers,
    ) -> None:
        """GET /v1/trust/resolve without did= returns 400."""
        resp = httpx.get(
            f"{core_url}/v1/trust/resolve",
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code == 400

    # REL-007
    def test_rel_007_trust_cache_endpoint(
        self, core_url, auth_headers,
    ) -> None:
        """GET /v1/trust/cache returns cached trust entries."""
        resp = httpx.get(
            f"{core_url}/v1/trust/cache",
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "entries" in data

    # REL-007
    def test_rel_007_trust_stats_endpoint(
        self, core_url, auth_headers,
    ) -> None:
        """GET /v1/trust/stats returns trust statistics."""
        resp = httpx.get(
            f"{core_url}/v1/trust/stats",
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code == 200

    # REL-007
    def test_rel_007_trust_sync_endpoint(
        self, core_url, auth_headers,
    ) -> None:
        """POST /v1/trust/sync triggers neighborhood sync."""
        resp = httpx.post(
            f"{core_url}/v1/trust/sync",
            json={},
            headers=auth_headers,
            timeout=15,
        )
        # Handler returns 200 on success — any other status is a real failure
        assert resp.status_code == 200, (
            f"Trust sync should return 200, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )

    # REL-007
    def test_rel_007_appview_accessible_from_core(
        self, core_url, auth_headers,
    ) -> None:
        """Core can reach AppView — trust/resolve returns 404 (not 503).

        If AppView is not configured, Core returns 503. If it is configured
        but the DID doesn't exist, Core returns 404. We expect the latter
        since DINA_APPVIEW_URL is set in the release compose.
        """
        resp = httpx.get(
            f"{core_url}/v1/trust/resolve",
            params={"did": "did:plc:test-lookup"},
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code != 503, (
            "AppView not configured or unreachable from Core. "
            f"Got 503: {resp.text}"
        )
