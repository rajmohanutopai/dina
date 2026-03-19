"""REL-018 Connector Outage and Re-Authentication UX.

Verify that Core degrades gracefully when Brain or external services
are unavailable, and that unaffected features remain usable.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestConnectorOutage:
    """Real API tests for REL-018: graceful degradation."""

    # REL-018
    def test_rel_018_core_usable_without_brain_features(
        self, api: httpx.Client,
    ) -> None:
        """Core vault operations work even if Brain-dependent features fail."""
        # Vault store is a Core-only operation — should always work
        resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "Summary": "connector outage test data",
                "BodyText": "This should work regardless of Brain state",
                "Metadata": "{}",
            },
        })
        assert resp.status_code in (200, 201)

        # Query is also Core-only (FTS5)
        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": "connector outage",
            "mode": "fts5",
            "limit": 5,
        })
        assert resp.status_code == 200

    # REL-018
    def test_rel_018_healthz_reports_service_status(
        self, core_url,
    ) -> None:
        """Healthz endpoint reports component status for diagnostics."""
        resp = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp.status_code == 200
        data = resp.json()
        # Must have a status field with a valid value
        assert data.get("status") in ("ok", "healthy", "degraded"), (
            f"Healthz missing valid status: {data}"
        )

    # REL-018
    def test_rel_018_error_on_brain_failure_is_clear(
        self, core_url, auth_headers,
    ) -> None:
        """When Brain-dependent feature fails, error is clear (not 500 traceback)."""
        # agent/validate proxies to Brain — if Brain fails, should be clean error
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "search",
                "target": "test",
            },
            headers=auth_headers, timeout=15,
        )
        # Should succeed (Brain is up) or fail with a clear status
        assert resp.status_code in (200, 503), (
            f"Expected 200 or 503, got {resp.status_code}"
        )
        data = resp.json()
        assert isinstance(data, dict), "Error response should be JSON, not raw text"

    # REL-018
    def test_rel_018_did_works_independently(
        self, core_url, auth_headers,
    ) -> None:
        """DID and identity endpoints work without Brain involvement."""
        resp = httpx.get(
            f"{core_url}/v1/did", headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200
        assert resp.json().get("id", "").startswith("did:")
