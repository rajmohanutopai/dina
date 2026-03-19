"""REL-015 Install Re-Run and Idempotent Bootstrap.

Verify that re-running operations does not silently mutate
identity, secrets, or operating mode via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestInstallRerun:
    """Real API tests for REL-015: idempotent operations."""

    # REL-015
    def test_rel_015_did_stable_across_requests(
        self, core_url, auth_headers,
    ) -> None:
        """DID remains the same across multiple /v1/did calls."""
        dids = []
        for _ in range(3):
            resp = httpx.get(
                f"{core_url}/v1/did",
                headers=auth_headers, timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                dids.append(data.get("id", data.get("did", "")))

        assert len(set(dids)) == 1, f"DID should be stable, got: {dids}"

    # REL-015
    def test_rel_015_persona_recreate_idempotent(
        self, core_url, auth_headers,
    ) -> None:
        """Re-creating an existing persona is idempotent."""
        # First create
        resp1 = httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "general", "tier": "default", "passphrase": "test"},
            headers=auth_headers, timeout=10,
        )
        assert resp1.status_code in (200, 201, 409)

        # Second create — must be idempotent (same response, no error)
        resp2 = httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "general", "tier": "default", "passphrase": "test"},
            headers=auth_headers, timeout=10,
        )
        assert resp2.status_code in (200, 201, 409), (
            f"Persona recreate should be idempotent, got {resp2.status_code}"
        )
        # Both calls must not crash — and if both return data, IDs should match
        id1 = resp1.json().get("id", resp1.json().get("persona_id", ""))
        id2 = resp2.json().get("id", resp2.json().get("persona_id", ""))
        if id1 and id2:
            assert id1 == id2, f"Persona ID changed on recreate: {id1} → {id2}"

    # REL-015
    def test_rel_015_healthz_stable(self, core_url) -> None:
        """Healthz returns consistent results across calls."""
        statuses = set()
        for _ in range(3):
            resp = httpx.get(f"{core_url}/healthz", timeout=5)
            if resp.status_code == 200:
                statuses.add(resp.json().get("status"))
        assert len(statuses) == 1, f"Health status should be stable, got: {statuses}"

    # REL-015
    def test_rel_015_vault_data_survives_re_unlock(
        self, core_url, auth_headers,
    ) -> None:
        """Vault data survives persona re-unlock."""
        # Store data
        httpx.post(
            f"{core_url}/v1/vault/store",
            json={
                "persona": "general",
                "item": {
                    "Type": "note",
                    "Source": "release-test",
                    "Summary": "pre-relock data persistence test",
                    "BodyText": "This should survive unlock cycles",
                    "Metadata": "{}",
                },
            },
            headers=auth_headers, timeout=10,
        )

        # Re-unlock (should be no-op if already unlocked)
        httpx.post(
            f"{core_url}/v1/persona/unlock",
            json={"persona": "general", "passphrase": "test"},
            headers=auth_headers, timeout=10,
        )

        # Data should still be there
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "general", "query": "pre-relock", "mode": "fts5"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        assert len(items) >= 1, "Data should survive re-unlock"
        # Verify item contains the stored text
        texts = " ".join(
            (i.get("summary", "") or i.get("Summary", "")).lower()
            for i in items
        )
        assert "pre-relock" in texts, (
            f"Survived items don't contain stored text: {texts[:200]}"
        )
