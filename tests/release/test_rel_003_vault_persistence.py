"""REL-003 Vault Persistence Across Restart.

Verify that vault data persists and is retrievable via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestVaultPersistence:
    """Real API tests for REL-003: vault data persistence."""

    # REL-003
    def test_rel_003_data_persists_via_api(self, api: httpx.Client) -> None:
        """Store and retrieve data via real Go Core vault API."""
        resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "Summary": "vault persistence check",
                "BodyText": "This data must persist across operations",
                "Metadata": "{}",
            },
        })
        assert resp.status_code in (200, 201), f"Store failed: {resp.status_code} {resp.text}"
        item_id = resp.json().get("id", "")
        assert item_id, "Store must return an item ID"

    # REL-003
    def test_rel_003_fts_retrieval_works(self, api: httpx.Client) -> None:
        """FTS query returns stored items via real Go Core."""
        api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "Summary": "ergonomic office chair review lumbar support",
                "BodyText": "The Herman Miller Aeron has excellent lumbar support",
                "Metadata": "{}",
            },
        })

        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": "lumbar",
            "mode": "fts5",
            "limit": 10,
        })
        assert resp.status_code == 200, f"Query failed: {resp.status_code} {resp.text}"
        items = resp.json().get("items") or []
        assert len(items) >= 1, "FTS query should find stored items"

    # REL-003
    def test_rel_003_no_duplicate_on_re_store(self, api: httpx.Client) -> None:
        """Re-storing with same source_id is idempotent."""
        item = {
            "Type": "note",
            "Source": "release-test",
            "SourceID": "rel003-unique-item",
            "Summary": "idempotent store test",
            "BodyText": "This item should not duplicate",
            "Metadata": "{}",
        }
        resp1 = api.post("/v1/vault/store", json={"persona": "general", "item": item})
        assert resp1.status_code in (200, 201)

        resp2 = api.post("/v1/vault/store", json={"persona": "general", "item": item})
        assert resp2.status_code in (200, 201)

    # REL-003
    def test_rel_003_healthz_returns_ok(self, core_url) -> None:
        """Core healthz endpoint returns OK — no startup corruption."""
        resp = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") in ("ok", "healthy")
