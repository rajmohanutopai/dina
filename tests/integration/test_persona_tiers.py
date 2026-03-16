"""Integration tests for 4-tier persona access control.

These tests run against real Core + Brain Docker containers.
They test the full HTTP flow: create persona → start session → query →
approval_required → approve → query succeeds → end session → denied.

Set DINA_INTEGRATION=docker to run against real containers.
"""

from __future__ import annotations

import json
import os
import time

import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

pytestmark = pytest.mark.skipif(not DOCKER_MODE, reason="requires Docker")


@pytest.fixture
def core(docker_services):
    """Core URL + auth headers."""
    return {
        "url": docker_services.core_url,
        "headers": {"Authorization": f"Bearer {docker_services.client_token}"},
    }


def _post(core, path, body=None):
    return httpx.post(
        f"{core['url']}{path}",
        json=body or {},
        headers=core["headers"],
        timeout=10,
    )


def _get(core, path, params=None):
    return httpx.get(
        f"{core['url']}{path}",
        params=params,
        headers=core["headers"],
        timeout=10,
    )


# ---------------------------------------------------------------------------
# Tier validation
# ---------------------------------------------------------------------------


class TestTierValidation:
    """POST /v1/personas accepts only valid tier names."""

    def test_create_with_valid_tiers(self, core) -> None:
        """All 4 tiers accepted."""
        for tier in ("default", "standard", "sensitive", "locked"):
            name = f"tier_valid_{tier}_{int(time.time())}"
            resp = _post(core, "/v1/personas", {"name": name, "tier": tier, "passphrase": "test1234"})
            assert resp.status_code in (201, 409), f"{tier}: {resp.status_code} {resp.text}"

    def test_reject_legacy_tiers(self, core) -> None:
        """Legacy 'open' and 'restricted' are rejected."""
        for tier in ("open", "restricted", "invalid", ""):
            resp = _post(core, "/v1/personas", {"name": f"tier_bad_{tier}", "tier": tier, "passphrase": "test1234"})
            assert resp.status_code == 400, f"{tier}: expected 400, got {resp.status_code}"

    def test_default_persona_vault_auto_opens(self, core) -> None:
        """Default-tier persona reports vault=open on creation."""
        name = f"auto_open_{int(time.time())}"
        resp = _post(core, "/v1/personas", {"name": name, "tier": "default", "passphrase": "test1234"})
        if resp.status_code == 201:
            data = resp.json()
            assert data.get("vault") == "open", f"expected vault=open: {data}"

    def test_standard_persona_vault_auto_opens(self, core) -> None:
        """Standard-tier persona reports vault=open on creation."""
        name = f"std_open_{int(time.time())}"
        resp = _post(core, "/v1/personas", {"name": name, "tier": "standard", "passphrase": "test1234"})
        if resp.status_code == 201:
            data = resp.json()
            assert data.get("vault") == "open", f"expected vault=open: {data}"


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    """POST /v1/session/start, /end, GET /v1/sessions."""

    def test_session_start(self, core) -> None:
        """Starting a session returns active session with ID and name."""
        name = f"sess_{int(time.time())}"
        resp = _post(core, "/v1/session/start", {"name": name})
        assert resp.status_code == 201, f"start: {resp.text}"
        data = resp.json()
        assert data["name"] == name
        assert data["status"] == "active"
        assert "id" in data

        # Cleanup
        _post(core, "/v1/session/end", {"name": name})

    def test_session_reconnect(self, core) -> None:
        """Starting same-name session returns existing (reconnect)."""
        name = f"reconnect_{int(time.time())}"
        r1 = _post(core, "/v1/session/start", {"name": name})
        r2 = _post(core, "/v1/session/start", {"name": name})
        assert r1.json()["id"] == r2.json()["id"]
        _post(core, "/v1/session/end", {"name": name})

    def test_session_list(self, core) -> None:
        """GET /v1/sessions lists active sessions."""
        name = f"listme_{int(time.time())}"
        _post(core, "/v1/session/start", {"name": name})
        resp = _get(core, "/v1/sessions")
        assert resp.status_code == 200
        names = [s["name"] for s in resp.json().get("sessions", [])]
        assert name in names
        _post(core, "/v1/session/end", {"name": name})

    def test_session_end(self, core) -> None:
        """Ending a session removes it from active list."""
        name = f"endme_{int(time.time())}"
        _post(core, "/v1/session/start", {"name": name})
        resp = _post(core, "/v1/session/end", {"name": name})
        assert resp.status_code == 200

        # Verify gone from active list
        resp = _get(core, "/v1/sessions")
        names = [s["name"] for s in resp.json().get("sessions", [])]
        assert name not in names


# ---------------------------------------------------------------------------
# Approval lifecycle
# ---------------------------------------------------------------------------


class TestApprovalLifecycle:
    """POST /v1/persona/approve, /deny, GET /v1/persona/approvals."""

    def test_list_pending_approvals(self, core) -> None:
        """GET /v1/persona/approvals returns list."""
        resp = _get(core, "/v1/persona/approvals")
        assert resp.status_code == 200
        data = resp.json()
        assert "approvals" in data

    def test_deny_nonexistent_returns_404(self, core) -> None:
        """Denying a nonexistent approval returns 404."""
        resp = _post(core, "/v1/persona/deny", {"id": "nonexistent-id"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Vault query with persona tier enforcement
# ---------------------------------------------------------------------------


class TestVaultTierEnforcement:
    """Vault query respects persona tier based on caller type."""

    def test_query_general_persona_succeeds(self, core) -> None:
        """Query on 'general' (default tier) succeeds for admin."""
        resp = _post(core, "/v1/vault/query", {
            "persona": "general", "query": "test", "mode": "fts5",
        })
        # Should succeed (200) or return empty results — not 403
        assert resp.status_code == 200, f"general query failed: {resp.text}"

    def test_query_standard_persona_succeeds_for_admin(self, core) -> None:
        """Query on standard tier succeeds for admin (CallerType=user)."""
        # Create a standard persona
        name = f"std_q_{int(time.time())}"
        _post(core, "/v1/personas", {"name": name, "tier": "standard", "passphrase": "test1234"})

        resp = _post(core, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200, f"standard query failed: {resp.text}"

    def test_query_locked_persona_returns_403(self, core) -> None:
        """Query on locked tier returns 403 (vault not open)."""
        # Create locked persona (not unlocked)
        name = f"locked_q_{int(time.time())}"
        _post(core, "/v1/personas", {"name": name, "tier": "locked", "passphrase": "test1234"})

        resp = _post(core, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 403, f"locked query should fail: {resp.text}"
