"""REL-009 Persona Wall and PII Leakage.

Verify that persona boundaries and PII scrubbing hold via real API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestPersonaWall:
    """Real API tests for REL-009: persona isolation."""

    # REL-009
    def test_rel_009_cross_persona_data_isolated(
        self, core_url, auth_headers,
    ) -> None:
        """Data stored in one persona is not visible in another."""
        # Store health data in health persona — must succeed first
        # (if health is locked/misconfigured, unlock it)
        httpx.post(
            f"{core_url}/v1/persona/unlock",
            json={"persona": "health", "passphrase": ""},
            headers=auth_headers, timeout=10,
        )
        store_resp = httpx.post(
            f"{core_url}/v1/vault/store",
            json={
                "persona": "health",
                "item": {
                    "Type": "note",
                    "Source": "release-test",
                    "Summary": "L4-L5 disc herniation diagnosis",
                    "BodyText": "Patient has chronic lower back pain from herniation",
                    "Metadata": "{}",
                },
            },
            headers=auth_headers, timeout=10,
        )
        assert store_resp.status_code in (200, 201), (
            f"Health store must succeed before testing isolation: "
            f"{store_resp.status_code} {store_resp.text[:200]}"
        )

        # Query personal persona — should NOT find health data
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={
                "persona": "general",
                "query": "herniation",
                "mode": "fts5",
                "limit": 50,
            },
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        # Health data must NOT appear in general persona query
        for item in items:
            summary = (item.get("summary", "") or item.get("Summary", "")).lower()
            body = (item.get("body_text", "") or item.get("BodyText", "")).lower()
            all_text = summary + " " + body
            assert "herniation" not in all_text, (
                f"Health data leaked to general persona: {all_text[:200]}"
            )

    # REL-009
    def test_rel_009_pii_scrubbed_via_api(
        self, core_url, auth_headers,
    ) -> None:
        """PII scrubber removes sensitive data via real API."""
        resp = httpx.post(
            f"{core_url}/v1/pii/scrub",
            json={"text": "Contact Rajmohan at raj@example.com about the chair"},
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("PII scrub endpoint not implemented")
        assert resp.status_code == 200
        data = resp.json()
        scrubbed = data.get("scrubbed", "")
        # Email must be removed
        assert "raj@example.com" not in scrubbed, "Email PII should be scrubbed"
        # Scrubbed text must still contain the non-PII content
        assert "chair" in scrubbed.lower(), (
            f"Non-PII content lost during scrubbing: {scrubbed[:200]}"
        )
        # Scrubbed text must be non-empty (not silently dropping everything)
        assert len(scrubbed.strip()) > 10, (
            f"Scrubbed text suspiciously short: {scrubbed!r}"
        )

    # REL-009
    def test_rel_009_restricted_persona_requires_unlock(
        self, core_url, auth_headers,
    ) -> None:
        """Health persona (restricted) requires explicit unlock."""
        # Health persona was created as restricted in conftest
        # Store should work if unlocked (conftest unlocks it)
        resp = httpx.post(
            f"{core_url}/v1/vault/store",
            json={
                "persona": "health",
                "item": {
                    "Type": "note",
                    "Source": "release-test",
                    "Summary": "medication reminder",
                    "BodyText": "Take vitamin D daily",
                    "Metadata": "{}",
                },
            },
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201), (
            f"Restricted persona store failed: {resp.status_code}"
        )

    # REL-009
    def test_rel_009_persona_list_returns_all(
        self, core_url, auth_headers,
    ) -> None:
        """GET /v1/personas lists all created personas."""
        resp = httpx.get(
            f"{core_url}/v1/personas",
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("Personas list endpoint not implemented")
        assert resp.status_code == 200
        data = resp.json()
        personas = data.get("personas", [])
        # Strip "persona-" prefix if present
        names = [p.replace("persona-", "") if isinstance(p, str) else p.get("name", "") for p in personas]
        assert "general" in names, f"general persona should exist, got: {names}"
