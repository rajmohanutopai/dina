"""Integration tests for source trust & provenance.

Tests vault item provenance storage and retrieval_policy filtering
against real Core + Brain Docker containers.

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

# Task 8.22 migration prep. Source trust + provenance + retrieval-
# policy filtering is part of the M3 Trust Network gate (tasks
# 8.20-8.26). Lite's provenance + retrieval-policy subsystem lands
# with Phase 5+. LITE_SKIPS.md category `pending-feature`.
pytestmark = [
    pytest.mark.skipif(
        not (DOCKER_MODE or LITE_MODE),
        reason="requires DINA_INTEGRATION=docker or DINA_LITE=docker",
    ),
    pytest.mark.skip_in_lite(
        reason="Source trust + provenance + retrieval_policy filtering is "
        "M3 scope (tasks 8.20-8.26). Lite's provenance subsystem lands with "
        "Phase 5+. LITE_SKIPS.md category `pending-feature`."
    ),
]


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


# ---------------------------------------------------------------------------
# Provenance round-trip
# ---------------------------------------------------------------------------


class TestProvenanceStorage:
    """Store items with provenance fields and verify round-trip."""

    # TRACE: {"suite": "INT", "case": "0205", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "01", "title": "store_with_full_provenance"}
    def test_store_with_full_provenance(self, core) -> None:
        """All 6 provenance fields are stored and returned."""
        item = {
            "type": "email",
            "summary": "Dr Sharma appointment",
            "body_text": "Your appointment is confirmed.",
            "source": "gmail",
            "source_id": f"msg-prov-{int(time.time())}",
            "sender": "dr.sharma@clinic.com",
            "sender_trust": "contact_ring1",
            "source_type": "service",
            "confidence": "high",
            "retrieval_policy": "normal",
            "contradicts": "",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        assert resp.status_code == 201, f"store: {resp.text}"
        item_id = resp.json()["id"]

        # Retrieve and verify provenance.
        get_resp = httpx.get(
            f"{core['url']}/v1/vault/item/{item_id}",
            headers=core["headers"],
            timeout=10,
        )
        assert get_resp.status_code == 200, f"get: {get_resp.text}"
        data = get_resp.json()
        assert data.get("sender") == "dr.sharma@clinic.com"
        assert data.get("sender_trust") == "contact_ring1"
        assert data.get("source_type") == "service"
        assert data.get("confidence") == "high"
        assert data.get("retrieval_policy") == "normal"

    # TRACE: {"suite": "INT", "case": "0206", "section": "11", "sectionName": "Trust Network Integration", "subsection": "01", "scenario": "02", "title": "store_with_contradicts"}
    def test_store_with_contradicts(self, core) -> None:
        """contradicts field is stored and returned."""
        item = {
            "type": "note",
            "summary": "Blood type correction",
            "sender": "user",
            "sender_trust": "self",
            "confidence": "high",
            "retrieval_policy": "normal",
            "contradicts": "item-old-blood-type-123",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        assert resp.status_code == 201
        item_id = resp.json()["id"]

        get_resp = httpx.get(
            f"{core['url']}/v1/vault/item/{item_id}",
            headers=core["headers"],
            timeout=10,
        )
        assert get_resp.status_code == 200
        assert get_resp.json().get("contradicts") == "item-old-blood-type-123"


# ---------------------------------------------------------------------------
# Retrieval policy filtering
# ---------------------------------------------------------------------------


class TestRetrievalPolicyFiltering:
    """Default search excludes quarantine + briefing_only."""

    # TRACE: {"suite": "INT", "case": "0207", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "01", "title": "default_search_excludes_quarantine_and_briefing"}
    def test_default_search_excludes_quarantine_and_briefing(self, core) -> None:
        """Store normal, caveated, quarantine, briefing_only items.
        Default search returns only normal + caveated.
        """
        tag = f"rpf-{int(time.time())}"
        items = [
            {"type": "note", "summary": f"{tag} normal item",
             "retrieval_policy": "normal", "sender_trust": "self", "confidence": "high"},
            {"type": "note", "summary": f"{tag} caveated item",
             "retrieval_policy": "caveated", "sender_trust": "unknown", "confidence": "low"},
            {"type": "note", "summary": f"{tag} quarantine item",
             "retrieval_policy": "quarantine", "sender_trust": "unknown", "confidence": "low"},
            {"type": "note", "summary": f"{tag} briefing item",
             "retrieval_policy": "briefing_only", "sender_trust": "marketing", "confidence": "low"},
        ]
        for item in items:
            resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
            assert resp.status_code == 201, f"store: {resp.text}"

        # Default search.
        search = _post(core, "/v1/vault/query", {
            "persona": "general", "query": tag, "mode": "fts5",
        })
        assert search.status_code == 200
        results = search.json().get("items", [])
        summaries = [r.get("summary", r.get("Summary", "")) for r in results]
        assert any("normal" in s for s in summaries), f"normal missing: {summaries}"
        assert any("caveated" in s for s in summaries), f"caveated missing: {summaries}"
        assert not any("quarantine" in s for s in summaries), f"quarantine leaked: {summaries}"
        assert not any("briefing" in s for s in summaries), f"briefing leaked: {summaries}"

    # TRACE: {"suite": "INT", "case": "0208", "section": "11", "sectionName": "Trust Network Integration", "subsection": "02", "scenario": "02", "title": "include_all_returns_everything"}
    def test_include_all_returns_everything(self, core) -> None:
        """With include_all=true, all policies are returned."""
        tag = f"incall-{int(time.time())}"
        for policy in ("normal", "quarantine"):
            _post(core, "/v1/vault/store", {"persona": "general", "item": {
                "type": "note", "summary": f"{tag} {policy}",
                "retrieval_policy": policy,
            }})

        search = _post(core, "/v1/vault/query", {
            "persona": "general", "query": tag, "mode": "fts5",
            "include_all": True,
        })
        assert search.status_code == 200
        results = search.json().get("items", [])
        summaries = [r.get("summary", r.get("Summary", "")) for r in results]
        assert any("quarantine" in s for s in summaries), f"quarantine missing with include_all: {summaries}"


# ---------------------------------------------------------------------------
# User write defaults
# ---------------------------------------------------------------------------


class TestUserWriteDefaults:
    """Direct user writes get self/high/normal defaults."""

    # TRACE: {"suite": "INT", "case": "0209", "section": "11", "sectionName": "Trust Network Integration", "subsection": "03", "scenario": "01", "title": "store_without_provenance_gets_defaults"}
    def test_store_without_provenance_gets_defaults(self, core) -> None:
        """Storing without provenance fields defaults to self/high/normal (admin caller)."""
        item = {
            "type": "note",
            "summary": f"user note {int(time.time())}",
        }
        resp = _post(core, "/v1/vault/store", {"persona": "general", "item": item})
        assert resp.status_code == 201
        item_id = resp.json()["id"]

        get_resp = httpx.get(
            f"{core['url']}/v1/vault/item/{item_id}",
            headers=core["headers"],
            timeout=10,
        )
        assert get_resp.status_code == 200
        data = get_resp.json()
        # Admin/user caller → self/high/normal defaults.
        assert data.get("sender_trust") == "self", f"got: {data}"
        assert data.get("confidence") == "high", f"got: {data}"
        assert data.get("retrieval_policy") == "normal", f"got: {data}"
