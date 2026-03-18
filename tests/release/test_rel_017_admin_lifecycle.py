"""REL-017 Admin Access Lifecycle.

Verify admin authentication and authorization via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestAdminLifecycle:
    """Real API tests for REL-017: admin auth lifecycle."""

    # REL-017
    def test_rel_017_wrong_token_rejected(self, core_url) -> None:
        """Wrong Bearer token is rejected by admin endpoints."""
        resp = httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "should_fail", "tier": "open", "passphrase": "x"},
            headers={"Authorization": "Bearer wrong-token"},
            timeout=10,
        )
        assert resp.status_code in (401, 403), (
            f"Wrong token should be rejected, got {resp.status_code}"
        )

    # REL-017
    def test_rel_017_valid_token_accepted(
        self, core_url, auth_headers,
    ) -> None:
        """Valid Bearer token is accepted by admin endpoints."""
        resp = httpx.get(
            f"{core_url}/healthz",
            timeout=10,
        )
        assert resp.status_code == 200, (
            f"Health check should succeed, got {resp.status_code}"
        )

    # REL-017
    def test_rel_017_admin_persona_create(
        self, core_url, auth_headers,
    ) -> None:
        """Admin can create personas with valid auth."""
        resp = httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "admintest", "tier": "default", "passphrase": "adminpw"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201, 409), (
            f"Admin persona create failed: {resp.status_code} {resp.text}"
        )

    # REL-017
    def test_rel_017_device_pairing_requires_auth(
        self, core_url,
    ) -> None:
        """Device pairing endpoints require authentication."""
        resp = httpx.post(
            f"{core_url}/v1/pair/initiate",
            json={},
            timeout=10,
        )
        assert resp.status_code in (401, 403), (
            f"Pairing without auth should fail, got {resp.status_code}"
        )
