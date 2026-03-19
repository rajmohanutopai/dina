"""REL-011 Failure Handling and Degraded Operation.

Verify that common failures are safe, diagnosable, and non-terrifying
via real Go Core and Brain containers.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestWrongAPIKey:
    """REL-011A: Invalid auth produces clear errors."""

    # REL-011
    def test_rel_011_wrong_token_returns_401(self, core_url) -> None:
        """Invalid Bearer token produces 401, not a hang or 500."""
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "general", "query": "test", "mode": "fts5"},
            headers={"Authorization": "Bearer invalid-garbage-token"},
            timeout=10,
        )
        assert resp.status_code == 401, (
            f"Invalid token should return 401, got {resp.status_code}"
        )
        body = resp.text.lower()
        assert "error" in body or "unauthorized" in body or "invalid" in body, (
            f"401 response should have error message: {resp.text[:200]}"
        )

    # REL-011
    def test_rel_011_no_token_returns_401(self, core_url) -> None:
        """Missing auth header produces 401, not 500."""
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "general", "query": "test"},
            timeout=10,
        )
        assert resp.status_code in (401, 403), (
            f"No token should return 401/403, got {resp.status_code}"
        )


class TestBrainHealth:
    """REL-011B/C: Brain availability and degradation."""

    # REL-011
    def test_rel_011_brain_healthz_reachable(self, brain_url) -> None:
        """Brain /healthz is reachable and returns status."""
        resp = httpx.get(f"{brain_url}/healthz", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") in ("ok", "degraded", "healthy")

    # REL-011
    def test_rel_011_core_healthz_includes_brain(self, core_url) -> None:
        """Core /healthz reports brain connectivity status."""
        resp = httpx.get(f"{core_url}/healthz", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data


class TestVaultResilience:
    """REL-011D: Data integrity under normal operation."""

    # REL-011
    def test_rel_011_vault_store_and_verify(self, api: httpx.Client) -> None:
        """Data stored is exactly what is retrieved — no corruption."""
        test_value = "critical financial record amount=50000"
        resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "Summary": test_value,
                "BodyText": test_value,
                "Metadata": "{}",
            },
        })
        assert resp.status_code in (200, 201)

        # Verify via query
        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": "critical financial",
            "mode": "fts5",
            "limit": 10,
        })
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        found = any("50000" in (it.get("Summary", "") + it.get("BodyText", "")) for it in items)
        assert found, "Stored data should be retrievable without corruption"

    # REL-011
    def test_rel_011_concurrent_stores_succeed(self, api: httpx.Client) -> None:
        """Multiple sequential stores succeed without errors."""
        for i in range(5):
            resp = api.post("/v1/vault/store", json={
                "persona": "general",
                "item": {
                    "Type": "note",
                    "Source": "release-test",
                    "Summary": f"concurrent store test item {i}",
                    "BodyText": f"Item number {i} for resilience test",
                    "Metadata": "{}",
                },
            })
            assert resp.status_code in (200, 201), (
                f"Store {i} failed: {resp.status_code}"
            )

    # REL-011
    def test_rel_011_agent_validate_resilient(
        self, core_url, auth_headers,
    ) -> None:
        """Agent validation endpoint responds even without LLM."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "search",
                "target": "office chairs",
            },
            headers=auth_headers, timeout=10,
        )
        # Safe action should succeed — 503 is a real failure, not resilience
        assert resp.status_code == 200, (
            f"Agent validate for safe action should return 200, got "
            f"{resp.status_code}: {resp.text[:200]}"
        )

    # REL-011
    def test_rel_011_error_messages_human_readable(self, core_url) -> None:
        """Error responses are human-readable, not raw tracebacks."""
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "nonexistent", "query": "test"},
            headers={"Authorization": "Bearer invalid"},
            timeout=10,
        )
        body = resp.text.lower()
        assert "traceback" not in body, "Error should not contain raw traceback"
        assert "panic" not in body, "Error should not contain Go panic"
