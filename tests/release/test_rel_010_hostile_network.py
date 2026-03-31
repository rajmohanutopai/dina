"""REL-010 Hostile Network — D2D under network fault.

Verify that D2D messaging handles unreachable peers gracefully:
no crash, clear error, and the node remains operational.

Execution class: Harness.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest


class TestHostileNetwork:
    """Real API tests for REL-010: D2D under network fault."""

    # REL-010
    # TRACE: {"suite": "REL", "case": "0010", "section": "10", "sectionName": "Hostile Network", "subsection": "01", "scenario": "01", "title": "rel_010_send_to_nonexistent_peer_fails_gracefully"}
    def test_rel_010_send_to_nonexistent_peer_fails_gracefully(
        self, core_url, auth_headers,
    ) -> None:
        """Sending a D2D message to an unknown DID fails gracefully."""
        body_payload = json.dumps({"test": "hostile"})

        resp = httpx.post(
            f"{core_url}/v1/msg/send",
            json={
                "to": "did:plc:nonexistent-peer",
                "body": base64.b64encode(body_payload.encode()).decode(),
                "type": "dina/test/hostile",
            },
            headers=auth_headers,
            timeout=15,
        )
        # Should fail with a clear error — NOT 500 (crash)
        assert resp.status_code in (400, 404, 502), (
            f"Unknown peer should return 400/404/502, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )
        data = resp.json()
        assert "error" in data, (
            f"Error response should contain 'error' field: {data}"
        )

    # REL-010
    # TRACE: {"suite": "REL", "case": "0010", "section": "10", "sectionName": "Hostile Network", "subsection": "01", "scenario": "02", "title": "rel_010_core_healthy_after_failed_send"}
    def test_rel_010_core_healthy_after_failed_send(
        self, core_url,
    ) -> None:
        """Core remains healthy after a failed D2D send."""
        resp = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp.status_code == 200

    # REL-010
    # TRACE: {"suite": "REL", "case": "0010", "section": "10", "sectionName": "Hostile Network", "subsection": "01", "scenario": "03", "title": "rel_010_invalid_did_rejected"}
    def test_rel_010_invalid_did_rejected(
        self, core_url, auth_headers,
    ) -> None:
        """Sending to a malformed DID returns 400."""
        resp = httpx.post(
            f"{core_url}/v1/msg/send",
            json={
                "to": "not-a-valid-did",
                "body": base64.b64encode(b"test").decode(),
                "type": "dina/test/invalid",
            },
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code == 400, (
            f"Malformed DID should be rejected: {resp.status_code} {resp.text}"
        )

    # REL-010
    # TRACE: {"suite": "REL", "case": "0010", "section": "10", "sectionName": "Hostile Network", "subsection": "01", "scenario": "04", "title": "rel_010_empty_body_handled_without_crash"}
    def test_rel_010_empty_body_handled_without_crash(
        self, core_url, auth_headers, actor_b_did,
    ) -> None:
        """Empty body D2D send does not crash the server.

        The wire protocol may accept empty body (valid envelope) or reject
        it (400). Either is fine — the invariant is no 500/502 crash.
        """
        resp = httpx.post(
            f"{core_url}/v1/msg/send",
            json={
                "to": actor_b_did,
                "body": "",
                "type": "dina/test/empty",
            },
            headers=auth_headers,
            timeout=10,
        )
        assert resp.status_code < 500, (
            f"Empty body caused server crash: {resp.status_code} {resp.text[:200]}"
        )
        # If rejected, must have an error field
        if resp.status_code >= 400:
            data = resp.json()
            assert "error" in data, f"Rejection missing error field: {data}"

    # REL-010
    # TRACE: {"suite": "REL", "case": "0010", "section": "10", "sectionName": "Hostile Network", "subsection": "01", "scenario": "05", "title": "rel_010_node_b_healthy_after_fault_tests"}
    def test_rel_010_node_b_healthy_after_fault_tests(
        self, core_b_url,
    ) -> None:
        """Node B remains healthy — fault tests didn't affect the peer."""
        resp = httpx.get(f"{core_b_url}/healthz", timeout=5)
        assert resp.status_code == 200
