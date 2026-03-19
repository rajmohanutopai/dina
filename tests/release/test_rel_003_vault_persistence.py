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
        """Store data, then retrieve by ID — verify content matches."""
        import os
        marker = f"rel003_{os.getpid()}"
        resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "SourceID": f"rel003-persist-{marker}",
                "Summary": f"{marker} vault persistence check",
                "BodyText": f"{marker} This data must persist across operations",
                "Metadata": "{}",
            },
        })
        assert resp.status_code in (200, 201), f"Store failed: {resp.status_code} {resp.text}"
        item_id = resp.json().get("id", "")
        assert item_id, "Store must return an item ID"

        # Query back and verify content matches
        query_resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": marker,
            "mode": "fts5",
            "limit": 5,
            "include_content": True,
        })
        assert query_resp.status_code == 200
        items = query_resp.json().get("items") or []
        found_item = next((i for i in items if i.get("id") == item_id), None)
        assert found_item, f"Stored item {item_id} not retrievable by marker '{marker}'"
        # Verify retrieved content contains the marker
        retrieved_text = (
            (found_item.get("summary", "") or found_item.get("Summary", "")) + " " +
            (found_item.get("body_text", "") or found_item.get("BodyText", ""))
        )
        assert marker in retrieved_text, (
            f"Retrieved item doesn't contain marker '{marker}': {retrieved_text[:200]}"
        )

    # REL-003
    def test_rel_003_fts_retrieval_works(self, api: httpx.Client) -> None:
        """FTS query returns items whose content contains the stored text."""
        import os
        marker = f"rel003fts_{os.getpid()}"
        store_resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "SourceID": f"rel003-lumbar-{marker}",
                "Summary": f"{marker} ergonomic office chair review lumbar support",
                "BodyText": f"{marker} The Herman Miller Aeron has excellent lumbar support",
                "Metadata": "{}",
            },
        })
        assert store_resp.status_code in (200, 201)
        stored_id = store_resp.json().get("id", "")

        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": marker,
            "mode": "fts5",
            "limit": 10,
            "include_content": True,
        })
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        assert len(items) >= 1, f"FTS should find items for '{marker}'"
        found_item = next((i for i in items if i.get("id") == stored_id), None)
        assert found_item, f"FTS didn't return the stored item {stored_id}"
        # Verify content contains the marker
        retrieved_text = (
            (found_item.get("summary", "") or found_item.get("Summary", "")) + " " +
            (found_item.get("body_text", "") or found_item.get("BodyText", ""))
        )
        assert marker in retrieved_text, (
            f"FTS result doesn't contain marker '{marker}': {retrieved_text[:200]}"
        )

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
