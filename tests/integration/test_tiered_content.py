"""Integration tests for tiered content L0/L1/L2.

Tests the two-phase storage model:
  1. Store L2 (body) immediately → FTS5 searchable
  2. PATCH enrich with L0/L1/embedding → full semantic search

Set DINA_INTEGRATION=docker to run against real containers.
"""

from __future__ import annotations

import json
import os
import time

import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"
LITE_MODE = os.environ.get("DINA_LITE") == "docker"

# Task 8.16 migration prep. Two markers:
#   1. Docker-or-Lite gate (extended from original Docker-only)
#   2. skip_in_lite — L0/L1/L2 content-tier model's PATCH-enrich flow
#      needs Brain's `/api/v1/process` (classification) + embedding
#      service (Phase 5c). The storage primitives (FTS5 + HNSW) are
#      already in Lite via @dina/storage-node + @dina/core; what's
#      missing is the Brain route that orchestrates the PATCH pipeline.
#      LITE_SKIPS.md category `pending-route`.
pytestmark = [
    pytest.mark.skipif(
        not (DOCKER_MODE or LITE_MODE),
        reason="requires DINA_INTEGRATION=docker or DINA_LITE=docker",
    ),
    pytest.mark.skip_in_lite(
        reason="L0/L1/L2 content-tier model's PATCH-enrich flow depends on "
        "Brain's `/api/v1/process` + embedding service (Phase 5c). "
        "Storage primitives (FTS5 + HNSW) are in Lite; the Brain route "
        "that drives the pipeline isn't. LITE_SKIPS.md category `pending-route`."
    ),
]


@pytest.fixture
def core(docker_services):
    return {
        "url": docker_services.core_url,
        "headers": {"Authorization": f"Bearer {docker_services.client_token}"},
    }


def _post(core, path, body=None):
    return httpx.post(
        f"{core['url']}{path}", json=body or {},
        headers=core["headers"], timeout=10,
    )


def _get(core, path):
    return httpx.get(
        f"{core['url']}{path}",
        headers=core["headers"], timeout=10,
    )


def _patch(core, path, body):
    return httpx.patch(
        f"{core['url']}{path}", json=body,
        headers=core["headers"], timeout=10,
    )


class TestTieredContentStorage:
    """Store L2, then enrich with L0/L1, verify round-trip."""

    # TRACE: {"suite": "INT", "case": "0218", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "01", "title": "store_then_enrich"}
    def test_store_then_enrich(self, core) -> None:
        """Store item (L2), PATCH enrich (L0/L1), GetItem returns all."""
        # Phase 1: Store L2.
        item = {
            "type": "email",
            "summary": "Blood test results",
            "body_text": "Full blood test report with all values...",
            "source": "gmail",
            "source_id": f"tc-{int(time.time())}",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        assert resp.status_code == 201, f"store: {resp.text}"
        item_id = resp.json()["id"]

        # Verify enrichment_status = pending.
        get1 = _get(core, f"/v1/vault/item/{item_id}?persona=general")
        assert get1.status_code == 200
        assert get1.json().get("enrichment_status") == "pending"

        # Phase 2: PATCH enrich.
        enrich_body = {
            "content_l0": "Blood test results from gmail, 2026",
            "content_l1": "Blood test report showing all markers normal.",
            "enrichment_status": "ready",
            "enrichment_version": json.dumps({"prompt_v": 1, "embed_model": "test"}),
        }
        patch_resp = _patch(
            core, f"/v1/vault/item/{item_id}/enrich?persona=general",
            enrich_body,
        )
        assert patch_resp.status_code == 200, f"enrich: {patch_resp.text}"

        # Verify L0/L1 populated.
        get2 = _get(core, f"/v1/vault/item/{item_id}?persona=general")
        assert get2.status_code == 200
        data = get2.json()
        assert data.get("content_l0") == enrich_body["content_l0"]
        assert data.get("content_l1") == enrich_body["content_l1"]
        assert data.get("enrichment_status") == "ready"
        # L2 preserved.
        assert data.get("body_text", data.get("body", "")) == item["body_text"]

    # TRACE: {"suite": "INT", "case": "0219", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "02", "title": "unenriched_item_searchable_via_fts5"}
    def test_unenriched_item_searchable_via_fts5(self, core) -> None:
        """Unenriched item (pending) is still findable via FTS5 keyword search."""
        tag = f"unenriched-{int(time.time())}"
        item = {
            "type": "note",
            "summary": f"{tag} important document",
            "body_text": f"The {tag} contains critical information.",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        assert resp.status_code == 201

        # Search by keyword — should find it even without L0/L1.
        search = _post(core, "/v1/vault/query", {
            "persona": "general", "query": tag, "mode": "fts5",
        })
        assert search.status_code == 200
        results = search.json().get("items", [])
        found = any(tag in (r.get("summary", r.get("Summary", "")) +
                            r.get("body_text", r.get("body", "")))
                    for r in results)
        assert found, f"{tag} not found in FTS5 results"

    # TRACE: {"suite": "INT", "case": "0220", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "03", "title": "enrich_is_idempotent"}
    def test_enrich_is_idempotent(self, core) -> None:
        """PATCHing enrich twice with different data updates correctly."""
        item = {"type": "note", "summary": f"idem-{int(time.time())}"}
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        item_id = resp.json()["id"]

        # First enrich.
        _patch(core, f"/v1/vault/item/{item_id}/enrich?persona=general", {
            "content_l0": "First L0",
            "content_l1": "First L1",
            "enrichment_status": "ready",
            "enrichment_version": json.dumps({"prompt_v": 1}),
        })

        # Second enrich (re-enrichment with new version).
        _patch(core, f"/v1/vault/item/{item_id}/enrich?persona=general", {
            "content_l0": "Updated L0",
            "content_l1": "Updated L1",
            "enrichment_version": json.dumps({"prompt_v": 2}),
        })

        data = _get(core, f"/v1/vault/item/{item_id}?persona=general").json()
        assert data.get("content_l0") == "Updated L0"
        assert data.get("content_l1") == "Updated L1"

    # TRACE: {"suite": "INT", "case": "0221", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "04", "title": "two_phase_full_lifecycle"}
    def test_two_phase_full_lifecycle(self, core) -> None:
        """Full lifecycle: store L2 → search (FTS5) → enrich → search returns enriched."""
        tag = f"lifecycle-{int(time.time())}"
        item = {
            "type": "email",
            "summary": f"{tag} doctor appointment",
            "body_text": f"Your {tag} appointment is confirmed for next Tuesday.",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        item_id = resp.json()["id"]

        # Phase 1: FTS5 finds it immediately.
        s1 = _post(core, "/v1/vault/query", {
            "persona": "general", "query": tag, "mode": "fts5",
        })
        assert any(tag in str(r) for r in s1.json().get("items", []))

        # Phase 2: Enrich.
        _patch(core, f"/v1/vault/item/{item_id}/enrich?persona=general", {
            "content_l0": f"{tag} doctor appointment confirmed",
            "content_l1": f"Appointment for {tag} confirmed for next Tuesday.",
            "enrichment_status": "ready",
        })

        # Verify enriched data returned by GetItem.
        data = _get(core, f"/v1/vault/item/{item_id}?persona=general").json()
        assert data.get("content_l0") != ""
        assert data.get("content_l1") != ""
        assert data.get("enrichment_status") == "ready"
        # L2 preserved.
        assert tag in data.get("body_text", data.get("body", ""))
