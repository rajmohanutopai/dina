"""REL-002 First Conversation — harness portion.

Verify the Core→Brain conversation path works via real API.
The manual portion (LLM quality, UX feel) remains in test_rel_manual.py.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestFirstConversation:
    """Real API tests for REL-002: first conversation path."""

    # REL-002
    def test_rel_002_brain_reachable_from_core(
        self, core_url, auth_headers,
    ) -> None:
        """Core healthz confirms Brain connectivity."""
        resp = httpx.get(f"{core_url}/healthz", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        # Healthz should indicate brain status
        brain_ok = data.get("brain") or data.get("brain_status")
        if brain_ok is not None:
            assert brain_ok in (True, "ok", "healthy"), (
                f"Brain not healthy from Core perspective: {data}"
            )

    # REL-002
    def test_rel_002_vault_store_simulates_remember(
        self, api: httpx.Client,
    ) -> None:
        """Store user context simulating 'Remember my name is Raj'."""
        resp = api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "SourceID": "rel002-remember-raj",
                "Summary": "User's name is Raj, has back pain",
                "BodyText": "Remember that my name is Raj and I have back pain",
                "Metadata": "{}",
            },
        })
        assert resp.status_code in (200, 201), (
            f"Store failed: {resp.status_code} {resp.text}"
        )

    # REL-002
    def test_rel_002_vault_recall_uses_context(
        self, api: httpx.Client,
    ) -> None:
        """Recall retrieves stored context (simulates RAG path)."""
        # Store context
        api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "SourceID": "rel002-office-chair",
                "Summary": "User needs office chair for back pain",
                "BodyText": "I need a new office chair because of back pain",
                "Metadata": "{}",
            },
        })

        # Recall
        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": "office chair",
            "mode": "fts5",
            "limit": 10,
        })
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        assert len(items) >= 1, "Should recall stored context"

    # REL-002
    def test_rel_002_brain_process_accepts_signed_request(
        self, brain_url, brain_signer,
    ) -> None:
        """Brain /api/v1/process accepts a signed request from Core."""
        resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={
                "type": "agent_intent",
                "action": "search",
                "target": "office chair",
            },
            timeout=15,
        )
        # Brain should accept the signed request (200) or indicate
        # the LLM is not configured (503/422) — but NOT 401
        assert resp.status_code != 401, (
            "Brain rejected signed Core request — service auth broken"
        )
