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
        assert resp.status_code == 401, (
            f"Wrong token should return 401, got {resp.status_code}"
        )

    # REL-017
    def test_rel_017_valid_token_accepted(
        self, core_url, auth_headers,
    ) -> None:
        """Valid Bearer token is accepted — authenticated persona list works."""
        resp = httpx.get(
            f"{core_url}/v1/personas",
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code == 200, (
            f"Authenticated request should succeed, got {resp.status_code}"
        )
        data = resp.json()
        # Handler returns {"personas": [...]}
        if isinstance(data, dict):
            personas = data.get("personas", [])
        else:
            personas = data
        assert isinstance(personas, list), f"Expected personas list, got: {type(personas)}"
        names = [p if isinstance(p, str) else p.get("name", "") for p in personas]
        assert any("general" in n for n in names), (
            f"Default 'general' persona missing from list: {names}"
        )

    # REL-017
    def test_rel_017_admin_persona_create(
        self, core_url, auth_headers,
    ) -> None:
        """Admin can create personas and verify they appear in list."""
        resp = httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "admintest", "tier": "default", "passphrase": "adminpw"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201, 409), (
            f"Admin persona create failed: {resp.status_code} {resp.text}"
        )
        # Verify persona exists in list
        list_resp = httpx.get(f"{core_url}/v1/personas", headers=auth_headers, timeout=10)
        assert list_resp.status_code == 200
        personas = list_resp.json()
        if isinstance(personas, dict):
            personas = personas.get("personas", [])
        names = [p if isinstance(p, str) else p.get("name", "") for p in personas]
        assert any("admintest" in n for n in names), (
            f"Created persona 'admintest' not in list: {names}"
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
        assert resp.status_code == 401, (
            f"Pairing without auth should return 401, got {resp.status_code}"
        )
