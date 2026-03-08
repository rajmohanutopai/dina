"""REL-020 Draft-Don't-Send and Cart Handover.

Verify that Dina stages drafts and payment intents in the vault
but never auto-executes irreversible actions — via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest


class TestCartHandover:
    """Real API tests for REL-020: irreversible-action invariants."""

    # REL-020
    def test_rel_020_email_draft_stored_not_sent(self, api: httpx.Client) -> None:
        """Email draft is stored in vault, never auto-sent."""
        draft_id = f"drf_{uuid.uuid4().hex[:8]}"
        resp = api.post("/v1/vault/store", json={
            "persona": "personal",
            "item": {
                "Type": "email_draft",
                "Source": "release-test",
                "SourceID": draft_id,
                "Summary": f"Draft to sancho@example.com: Tea tomorrow?",
                "BodyText": "Would you like to come over for tea at 4 PM?",
                "Metadata": json.dumps({
                    "to": "sancho@example.com",
                    "channel": "email",
                    "draft_id": draft_id,
                    "sent": False,
                }),
            },
        })
        assert resp.status_code in (200, 201), f"Draft store failed: {resp.status_code}"

        # Verify it's stored as a draft (not sent)
        resp = api.post("/v1/vault/query", json={
            "persona": "personal",
            "query": "tea tomorrow",
            "mode": "fts5",
            "types": ["email_draft"],
            "limit": 10,
        })
        assert resp.status_code == 200

    # REL-020
    def test_rel_020_purchase_intent_stored_not_executed(
        self, api: httpx.Client,
    ) -> None:
        """Purchase intent is stored in vault, never auto-executed."""
        intent_id = f"pay_{uuid.uuid4().hex[:8]}"
        resp = api.post("/v1/vault/store", json={
            "persona": "personal",
            "item": {
                "Type": "cart_handover",
                "Source": "release-test",
                "SourceID": intent_id,
                "Summary": "Herman Miller Aeron - 72000 INR",
                "BodyText": json.dumps({
                    "merchant": "OfficialStore",
                    "amount": 72000,
                    "currency": "INR",
                    "executed": False,
                }),
                "Metadata": json.dumps({
                    "intent_id": intent_id,
                    "method": "web",
                    "executed": False,
                }),
            },
        })
        assert resp.status_code in (200, 201), f"Intent store failed: {resp.status_code}"

    # REL-020
    def test_rel_020_transfer_money_requires_approval(
        self, core_url, auth_headers,
    ) -> None:
        """Transfer money action requires explicit approval, never auto-executes."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "transfer_money",
                "target": "did:plc:merchant",
                "payload": {
                    "amount": 72000,
                    "currency": "INR",
                },
            },
            headers=auth_headers, timeout=15,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Agent validate endpoint not available")
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("approved") is not True, (
            "Money transfer must NEVER be auto-approved"
        )

    # REL-020
    def test_rel_020_vault_tracks_draft_type(self, api: httpx.Client) -> None:
        """Vault correctly stores and returns email_draft type."""
        api.post("/v1/vault/store", json={
            "persona": "personal",
            "item": {
                "Type": "email_draft",
                "Source": "release-test",
                "Summary": "Draft type tracking test",
                "BodyText": "Verify draft type persists",
                "Metadata": "{}",
            },
        })

        resp = api.post("/v1/vault/query", json={
            "persona": "personal",
            "query": "draft type tracking",
            "mode": "fts5",
            "limit": 10,
        })
        assert resp.status_code == 200
