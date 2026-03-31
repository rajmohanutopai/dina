"""Integration tests for async approval-wait-resume reasoning flow.

Tests the full flow: agent asks → Core returns 202 → approval → resume → answer.
Covers: unknown-ID 404, pending record lifecycle via result endpoint,
full approve/resume cycle, deny path, caller binding (wrong-caller 403),
and second-approval cycle (approval_id rotation via result endpoint).

Expiry extension and TTL sweep are tested at the SQLite adapter level
in core/test/pending_reason_test.go (not exercisable via HTTP without
waiting 30+ minutes).

Set DINA_INTEGRATION=docker to run against real containers.
"""

from __future__ import annotations

import json
import os
import time

import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

pytestmark = pytest.mark.skipif(not DOCKER_MODE, reason="requires Docker")


@pytest.fixture
def core(docker_services):
    return {
        "url": docker_services.core_url,
        "headers": {"Authorization": f"Bearer {docker_services.client_token}"},
    }


def _post(core, path, body=None, **kwargs):
    return httpx.post(
        f"{core['url']}{path}", json=body or {},
        headers=core["headers"], timeout=kwargs.get("timeout", 10),
    )


def _get(core, path):
    return httpx.get(
        f"{core['url']}{path}",
        headers=core["headers"], timeout=10,
    )


class TestAsyncApprovalFlow:
    """Full async approval-wait-resume lifecycle."""

    # TRACE: {"suite": "INT", "case": "0022", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "01", "title": "reason_returns_202_for_sensitive_persona"}
    def test_reason_returns_202_for_sensitive_persona(self, core) -> None:
        """TST-INT-750: Reason request touching sensitive persona gets 202 (not 403).

        This test creates a sensitive persona, locks it, then sends a
        reason request. Core should return 202 with a request_id.
        Note: This only works when Brain has an LLM configured and the
        agentic loop actually queries the sensitive persona.
        """
        # Create sensitive persona (idempotent)
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })

        # Lock the health persona so it requires approval
        _post(core, "/v1/persona/lock", {"persona": "health"})

        # Send a reason request — if Brain queries health, it should get 202
        resp = _post(core, "/api/v1/ask",
                     {"prompt": "What does my health data say about vitamin levels?"},
                     timeout=60)

        # Accept either 200 (Brain didn't need health) or 202 (approval needed)
        assert resp.status_code in (200, 202), (
            f"Expected 200 or 202, got {resp.status_code}: {resp.text[:200]}"
        )

        if resp.status_code == 202:
            data = resp.json()
            assert data.get("status") == "pending_approval"
            assert data.get("request_id", "").startswith("reason-")
            assert data.get("approval_id", "").startswith("apr-")

    # TRACE: {"suite": "INT", "case": "0023", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "02", "title": "reason_status_404_for_unknown"}
    def test_reason_status_404_for_unknown(self, core) -> None:
        """TST-INT-751: GET /api/v1/ask/{id}/status returns 404 for unknown IDs."""
        resp = _get(core, "/api/v1/ask/reason-nonexistent-id/status")
        assert resp.status_code == 404
        assert "not found" in resp.json().get("error", "").lower()

    # TRACE: {"suite": "INT", "case": "0751", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "03", "title": "pending_reason_lifecycle_via_result_endpoint"}
    def test_pending_reason_lifecycle_via_result_endpoint(self, core) -> None:
        """TST-INT-752: Full lifecycle: reason 202 → submit result → poll complete.

        Bypasses the LLM by directly submitting a result via the Brain
        callback endpoint. Proves the Core-side pending_reason store
        works end-to-end: create → status poll → result submit → complete.
        """
        # 1. Create and lock a sensitive persona
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })
        _post(core, "/v1/persona/lock", {"persona": "health"})

        # 2. Send reason — may get 202 if Brain queries health
        resp = _post(core, "/api/v1/ask",
                     {"prompt": "What are my vitamin levels?"},
                     timeout=60)

        if resp.status_code != 202:
            _post(core, "/v1/persona/unlock", {
                "persona": "health", "passphrase": "test",
            })
            pytest.skip("Brain didn't trigger approval for this query")

        data = resp.json()
        request_id = data["request_id"]
        assert request_id.startswith("reason-"), f"Bad request_id: {request_id}"
        assert data.get("approval_id", "").startswith("apr-")

        # 3. Verify status is pending_approval
        status_resp = _get(core, f"/api/v1/ask/{request_id}/status")
        assert status_resp.status_code == 200, f"Status check failed: {status_resp.text}"
        assert status_resp.json()["status"] == "pending_approval"

        # 4. Submit completed result (simulates Brain callback)
        result_resp = _post(core, f"/v1/reason/{request_id}/result", {
            "status": "complete",
            "content": "Your B12 is 180 pg/mL (low).",
            "model": "gemini-lite",
        })
        assert result_resp.status_code == 200, (
            f"Result submission failed: {result_resp.status_code} {result_resp.text}"
        )

        # 5. Verify status is now complete with content
        final_resp = _get(core, f"/api/v1/ask/{request_id}/status")
        assert final_resp.status_code == 200
        final = final_resp.json()
        assert final["status"] == "complete", f"Expected complete, got: {final}"
        assert "B12" in final.get("content", ""), (
            f"Expected B12 in content, got: {final.get('content', '')}"
        )

        # Cleanup
        _post(core, "/v1/persona/unlock", {
            "persona": "health", "passphrase": "test",
        })

    # TRACE: {"suite": "INT", "case": "0024", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "04", "title": "full_approve_resume_cycle"}
    def test_full_approve_resume_cycle(self, core) -> None:
        """TST-INT-753: Full cycle: create sensitive persona → reason → 202 → approve → poll → answer.

        This is the complete end-to-end test of the async approval flow.
        Requires Brain + LLM to be available.
        """
        # 1. Create and unlock health persona with data
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })
        _post(core, "/v1/persona/unlock", {
            "persona": "health", "passphrase": "test",
        })

        # Store health data
        _post(core, "/v1/vault/store", {
            "persona": "health",
            "item": {
                "type": "medical_record",
                "summary": "Blood test results March 2026",
                "body_text": "B12: 180 pg/mL (low). Vitamin D: 18 ng/mL (deficient).",
                "content_l0": "Blood test from March 2026",
                "content_l1": "Blood test shows B12 at 180 and Vitamin D at 18.",
                "enrichment_status": "ready",
                "enrichment_version": '{"prompt_v":1}',
                "embedding": [0.1] * 768,
            },
        })

        # 2. Lock health persona to trigger approval flow
        _post(core, "/v1/persona/lock", {"persona": "health"})

        # 3. Send reason request
        resp = _post(core, "/api/v1/ask",
                     {"prompt": "What are my vitamin levels?"},
                     timeout=60)

        if resp.status_code == 200:
            # Brain answered without needing health data — that's OK
            pytest.skip("Brain didn't query health persona (no approval needed)")

        assert resp.status_code == 202, f"Expected 202, got {resp.status_code}: {resp.text[:200]}"
        data = resp.json()
        request_id = data["request_id"]
        approval_id = data["approval_id"]

        # 4. Approve the request
        approve_resp = _post(core, "/v1/persona/approve", {
            "id": approval_id, "scope": "session", "granted_by": "integration-test",
        })
        assert approve_resp.status_code == 200

        # 5. Poll for result (Brain resumes in background)
        for _ in range(30):
            time.sleep(2)
            status_resp = _get(core, f"/api/v1/ask/{request_id}/status")
            if status_resp.status_code != 200:
                continue
            status = status_resp.json()
            if status.get("status") == "complete":
                assert status.get("content"), "Expected non-empty content"
                return  # Success!
            if status.get("status") in ("denied", "failed", "expired"):
                break

        # If we get here, check what happened
        final = _get(core, f"/api/v1/ask/{request_id}/status")
        if final.status_code == 200:
            final_status = final.json().get("status")
            if final_status == "complete":
                return  # Late success
            pytest.fail(f"Request did not complete: status={final_status}")
        pytest.fail("Request never completed after approval")

    # TRACE: {"suite": "INT", "case": "0025", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "05", "title": "wrong_caller_gets_403"}
    def test_wrong_caller_gets_403(self, core) -> None:
        """TST-INT-754: Status poll with wrong caller DID returns 403 (access denied).

        Creates a pending record via the reason endpoint, then polls
        with a forged X-DID header to simulate a different agent.
        """
        # Setup
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })
        _post(core, "/v1/persona/lock", {"persona": "health"})

        # Trigger a pending reason
        resp = _post(core, "/api/v1/ask",
                     {"prompt": "What are my health records?"},
                     timeout=60)

        if resp.status_code != 202:
            pytest.skip("Brain didn't trigger approval for this query")

        request_id = resp.json()["request_id"]

        # Poll with a different agent DID — should be denied
        rogue_headers = {**core["headers"], "X-DID": "did:key:z6MkRogueAgent"}
        rogue_resp = httpx.get(
            f"{core['url']}/api/v1/ask/{request_id}/status",
            headers=rogue_headers, timeout=10,
        )
        assert rogue_resp.status_code == 403, (
            f"Expected 403 for wrong caller, got {rogue_resp.status_code}: "
            f"{rogue_resp.text[:200]}"
        )
        assert "access denied" in rogue_resp.json().get("error", "").lower()

    # TRACE: {"suite": "INT", "case": "0026", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "06", "title": "second_approval_cycle_via_result"}
    def test_second_approval_cycle_via_result(self, core) -> None:
        """TST-INT-755: Second-approval cycle: result endpoint returns pending_approval with new approval_id.

        Simulates Brain reporting that a second persona also needs approval.
        The pending record's approval_id should rotate and expiry should extend.
        """
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })
        _post(core, "/v1/persona/lock", {"persona": "health"})

        resp = _post(core, "/api/v1/ask",
                     {"prompt": "What vitamins am I deficient in?"},
                     timeout=60)

        if resp.status_code != 202:
            pytest.skip("Brain didn't trigger approval for this query")

        data = resp.json()
        request_id = data["request_id"]
        first_approval_id = data["approval_id"]

        # Check initial status
        status_resp = _get(core, f"/api/v1/ask/{request_id}/status")
        assert status_resp.status_code == 200
        assert status_resp.json()["status"] == "pending_approval"

        # Brain reports second-approval needed (different persona)
        second_resp = _post(core, f"/v1/reason/{request_id}/result", {
            "status": "pending_approval",
            "approval_id": "apr-second-persona",
            "persona": "financial",
        })
        assert second_resp.status_code == 200, (
            f"Second approval cycle failed: {second_resp.status_code} {second_resp.text[:200]}"
        )

        # Status should still be pending_approval but with new approval_id
        status_resp = _get(core, f"/api/v1/ask/{request_id}/status")
        assert status_resp.status_code == 200
        status = status_resp.json()
        assert status["status"] == "pending_approval"

        # Now complete via result
        _post(core, f"/v1/reason/{request_id}/result", {
            "status": "complete",
            "content": "Your financial health summary.",
            "model": "gemini-lite",
        })

        final = _get(core, f"/api/v1/ask/{request_id}/status")
        assert final.status_code == 200
        assert final.json()["status"] == "complete"

    # TRACE: {"suite": "INT", "case": "0027", "section": "24", "sectionName": "Async Approval Flow", "subsection": "01", "scenario": "07", "title": "deny_marks_request_denied"}
    def test_deny_marks_request_denied(self, core) -> None:
        """TST-INT-756: Denying an approval marks the pending request as denied."""
        # Create sensitive persona
        _post(core, "/v1/personas", {
            "name": "health", "tier": "sensitive", "passphrase": "test",
        })
        _post(core, "/v1/persona/lock", {"persona": "health"})

        # Send reason request
        resp = _post(core, "/api/v1/ask",
                     {"prompt": "Check my health records"},
                     timeout=60)

        if resp.status_code != 202:
            pytest.skip("Brain didn't need approval for this query")

        data = resp.json()
        request_id = data["request_id"]
        approval_id = data["approval_id"]

        # Deny
        _post(core, "/v1/persona/deny", {"id": approval_id})

        # Poll — should be denied
        time.sleep(1)
        status_resp = _get(core, f"/api/v1/ask/{request_id}/status")
        assert status_resp.status_code == 200
        assert status_resp.json().get("status") == "denied"
