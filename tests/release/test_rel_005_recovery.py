"""REL-005 Recovery Phrase, Disaster Recovery, and Identity Continuity.

Verify DID derivation and identity stability via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestRecovery:
    """Real API tests for REL-005: identity recovery."""

    # REL-005
    # TRACE: {"suite": "REL", "case": "0005", "section": "05", "sectionName": "Recovery", "subsection": "01", "scenario": "01", "title": "rel_005_did_is_stable"}
    def test_rel_005_did_is_stable(self, core_url, auth_headers) -> None:
        """DID from /v1/did is a valid did:key or did:plc."""
        resp = httpx.get(
            f"{core_url}/v1/did",
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200, f"DID endpoint failed: {resp.status_code}"
        data = resp.json()
        did = data.get("id", data.get("did", ""))
        assert did.startswith("did:"), f"Expected DID, got: {did}"

    # REL-005
    # TRACE: {"suite": "REL", "case": "0005", "section": "05", "sectionName": "Recovery", "subsection": "01", "scenario": "02", "title": "rel_005_did_consistent_across_calls"}
    def test_rel_005_did_consistent_across_calls(
        self, core_url, auth_headers,
    ) -> None:
        """Multiple calls to /v1/did return the same DID."""
        dids = set()
        for _ in range(3):
            resp = httpx.get(f"{core_url}/v1/did", headers=auth_headers, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                dids.add(data.get("id", data.get("did", "")))
        assert len(dids) == 1, f"DID should be stable, got: {dids}"

    # REL-005
    # TRACE: {"suite": "REL", "case": "0005", "section": "05", "sectionName": "Recovery", "subsection": "01", "scenario": "03", "title": "rel_005_did_sign_and_verify"}
    def test_rel_005_did_sign_and_verify(self, core_url, auth_headers) -> None:
        """Sign data via /v1/did/sign and verify via /v1/did/verify."""
        # Get the node's DID first (verify endpoint requires it)
        did_resp = httpx.get(
            f"{core_url}/v1/did", headers=auth_headers, timeout=10,
        )
        assert did_resp.status_code == 200
        node_did = did_resp.json().get("id", "")

        test_data = "release-test-recovery-data"
        hex_data = test_data.encode().hex()

        # Sign
        resp = httpx.post(
            f"{core_url}/v1/did/sign",
            json={"data": hex_data},
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("DID sign endpoint not implemented")
        assert resp.status_code == 200, f"Sign failed: {resp.status_code} {resp.text}"
        signature = resp.json().get("signature", "")
        assert signature, "Sign must return a signature"

        # Verify
        resp = httpx.post(
            f"{core_url}/v1/did/verify",
            json={"data": hex_data, "signature": signature, "did": node_did},
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("DID verify endpoint not implemented")
        assert resp.status_code == 200
        assert resp.json().get("valid") is True

    # REL-005
    # TRACE: {"suite": "REL", "case": "0005", "section": "05", "sectionName": "Recovery", "subsection": "01", "scenario": "04", "title": "rel_005_well_known_atproto_did"}
    def test_rel_005_well_known_atproto_did(self, core_url) -> None:
        """/.well-known/atproto-did returns the node's DID."""
        resp = httpx.get(f"{core_url}/.well-known/atproto-did", timeout=5)
        if resp.status_code == 404:
            pytest.skip("AT Protocol DID endpoint not implemented")
        assert resp.status_code == 200
        text = resp.text.strip()
        assert text.startswith("did:"), f"Expected DID, got: {text}"
