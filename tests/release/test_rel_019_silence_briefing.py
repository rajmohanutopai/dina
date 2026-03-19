"""REL-019 Silence Protocol and Daily Briefing.

Verify silence tier classification via real Brain/Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestSilenceBriefing:
    """Real API tests for REL-019: silence tier classification."""

    # REL-019
    def test_rel_019_fiduciary_event_classified(
        self, core_url, auth_headers,
    ) -> None:
        """Fiduciary-level action (bank transfer) is classified as high risk."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "transfer_money",
                "target": "did:plc:unknown_merchant",
                "payload": {
                    "amount": 4999,
                    "currency": "USD",
                    "reason": "URGENT: Unauthorized transaction detected",
                },
            },
            headers=auth_headers, timeout=15,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Agent validate endpoint not available")
        assert resp.status_code == 200, f"agent validate failed: {resp.status_code}"
        data = resp.json()
        # Money transfer must be flagged AND not auto-approved
        assert data.get("approved") is not True, (
            f"Bank transfer must NOT be auto-approved: {data}"
        )
        assert data.get("risk") == "HIGH", (
            f"transfer_money must be classified HIGH, got risk={data.get('risk')}: {data}"
        )

    # REL-019
    def test_rel_019_safe_action_auto_approved(
        self, core_url, auth_headers,
    ) -> None:
        """Safe action (search) is auto-approved via agent validation."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "search",
                "target": "best office chair 2026",
            },
            headers=auth_headers, timeout=15,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Agent validate endpoint not available")
        assert resp.status_code == 200
        data = resp.json()
        # Safe action must be approved AND classified as safe
        assert data.get("approved") is True, (
            f"Safe search action should be auto-approved: {data}"
        )
        risk = data.get("risk", "")
        assert risk == "SAFE" or data.get("action") == "auto_approve", (
            f"Search should be classified SAFE, got risk={risk}: {data}"
        )

    # REL-019
    def test_rel_019_risky_action_requires_approval(
        self, core_url, auth_headers,
    ) -> None:
        """High-risk action (transfer_money) requires approval."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "transfer_money",
                "target": "did:plc:merchant",
            },
            headers=auth_headers, timeout=15,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Agent validate endpoint not available")
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("approved") is not True, (
            "HIGH risk actions must NOT be auto-approved"
        )
        assert data.get("requires_approval") is True or data.get("risk") in ("HIGH", "BLOCKED"), (
            f"High-risk action should require approval: {data}"
        )

    # REL-019
    def test_rel_019_agent_validate_returns_structured(
        self, core_url, auth_headers,
    ) -> None:
        """Agent validation returns structured response (not raw text)."""
        resp = httpx.post(
            f"{core_url}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "action": "send_email",
                "target": "sancho@example.com",
            },
            headers=auth_headers, timeout=15,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Agent validate endpoint not available")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        # Should have at least one of: risk, approved, requires_approval
        assert any(k in data for k in ("risk", "approved", "requires_approval")), (
            f"Response should be structured, got: {data}"
        )
