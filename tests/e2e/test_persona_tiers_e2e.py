"""E2E tests for 4-tier persona access control across real multi-node stack.

Tests the full flow with real Core + Brain + PDS containers:
- Create personas with different tiers
- Session lifecycle (start/list/end)
- Vault query with tier enforcement
- Locked persona denied
- Sensitive persona: unlock → query → lock → denied

Requires DINA_E2E=docker and the full multi-node stack running.
"""

from __future__ import annotations

import os
import time

import httpx
import pytest

E2E_MODE = os.environ.get("DINA_E2E") == "docker"

pytestmark = pytest.mark.skipif(not E2E_MODE, reason="requires E2E Docker stack")


@pytest.fixture(scope="module")
def alonso(docker_services):
    """Don Alonso's Core node URL + auth."""
    url = docker_services.core_url("alonso")
    token = docker_services.client_token
    return {"url": url, "headers": {"Authorization": f"Bearer {token}"}}


def _post(node, path, body=None):
    return httpx.post(
        f"{node['url']}{path}", json=body or {},
        headers=node["headers"], timeout=15,
    )


def _get(node, path):
    return httpx.get(
        f"{node['url']}{path}",
        headers=node["headers"], timeout=15,
    )


class TestE2ETierEnforcement:
    """Full E2E persona tier flow on a real node."""

    # TRACE: {"suite": "E2E", "case": "0001", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "01", "title": "e2e_create_all_tiers"}
    def test_e2e_create_all_tiers(self, alonso) -> None:
        """Create personas with all 4 tiers on a real node."""
        ts = int(time.time())
        for tier in ("default", "standard", "sensitive", "locked"):
            resp = _post(alonso, "/v1/personas", {
                "name": f"e2e_{tier}_{ts}", "tier": tier, "passphrase": "e2epass123",
            })
            assert resp.status_code in (201, 409), f"{tier}: {resp.status_code} {resp.text}"

    # TRACE: {"suite": "E2E", "case": "0002", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "02", "title": "e2e_general_persona_queryable"}
    def test_e2e_general_persona_queryable(self, alonso) -> None:
        """The 'general' default persona is queryable without any session."""
        resp = _post(alonso, "/v1/vault/query", {
            "persona": "general", "query": "e2e test", "mode": "fts5",
        })
        assert resp.status_code == 200, f"general query failed: {resp.text}"

    # TRACE: {"suite": "E2E", "case": "0003", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "03", "title": "e2e_session_lifecycle"}
    def test_e2e_session_lifecycle(self, alonso) -> None:
        """Session start → list → end on real node."""
        name = f"e2e_sess_{int(time.time())}"

        r = _post(alonso, "/v1/session/start", {"name": name})
        assert r.status_code == 201

        r = _get(alonso, "/v1/sessions")
        names = [s["name"] for s in r.json().get("sessions", [])]
        assert name in names

        r = _post(alonso, "/v1/session/end", {"name": name})
        assert r.status_code == 200

    # TRACE: {"suite": "E2E", "case": "0004", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "04", "title": "e2e_locked_persona_denied"}
    def test_e2e_locked_persona_denied(self, alonso) -> None:
        """Locked persona query returns 403."""
        name = f"e2e_locked_{int(time.time())}"
        _post(alonso, "/v1/personas", {
            "name": name, "tier": "locked", "passphrase": "e2epass123",
        })
        resp = _post(alonso, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 403

    # TRACE: {"suite": "E2E", "case": "0005", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "05", "title": "e2e_sensitive_unlock_query_lock"}
    def test_e2e_sensitive_unlock_query_lock(self, alonso) -> None:
        """Sensitive persona: create → query fails → unlock → query succeeds → lock → query fails."""
        name = f"e2e_sens_{int(time.time())}"

        # Create
        r = _post(alonso, "/v1/personas", {
            "name": name, "tier": "sensitive", "passphrase": "e2epass123",
        })
        assert r.status_code in (201, 409)

        # Query fails (vault closed)
        r = _post(alonso, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert r.status_code == 403

        # Unlock
        r = _post(alonso, "/v1/persona/unlock", {
            "persona": name, "passphrase": "e2epass123",
        })
        assert r.status_code == 200, f"unlock failed: {r.text}"

        # Query succeeds
        r = _post(alonso, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert r.status_code == 200, f"query after unlock failed: {r.text}"

        # Lock
        r = _post(alonso, "/v1/persona/lock", {"persona": name})
        assert r.status_code == 200

        # Query fails again
        r = _post(alonso, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert r.status_code == 403

    # TRACE: {"suite": "E2E", "case": "0006", "section": "08", "sectionName": "Sensitive Personas", "subsection": "01", "scenario": "06", "title": "e2e_approval_list"}
    def test_e2e_approval_list(self, alonso) -> None:
        """GET /v1/persona/approvals works on real node."""
        resp = _get(alonso, "/v1/persona/approvals")
        assert resp.status_code == 200
        assert "approvals" in resp.json()
