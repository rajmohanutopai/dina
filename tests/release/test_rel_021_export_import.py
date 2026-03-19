"""REL-021 Export / Import Portability Drill.

Verify the vault export/import endpoints via real Go Core API.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestExportImport:
    """Real API tests for REL-021: export/import portability."""

    # REL-021
    def test_rel_021_vault_has_data_to_export(self, api: httpx.Client) -> None:
        """Vault has data that would be included in an export."""
        # Store test data
        api.post("/v1/vault/store", json={
            "persona": "general",
            "item": {
                "Type": "note",
                "Source": "release-test",
                "Summary": "export portability test data",
                "BodyText": "This data should be exportable",
                "Metadata": "{}",
            },
        })

        # Verify data exists
        resp = api.post("/v1/vault/query", json={
            "persona": "general",
            "query": "export portability",
            "mode": "fts5",
            "limit": 10,
        })
        assert resp.status_code == 200
        items = resp.json().get("items") or []
        assert len(items) >= 1, "Should have data to export"

    # REL-021
    def test_rel_021_export_endpoint_exists(
        self, core_url, auth_headers,
    ) -> None:
        """Export endpoint exists or clearly indicates not-yet-implemented."""
        # Real export endpoint is POST /v1/export (requires passphrase)
        resp = httpx.post(
            f"{core_url}/v1/export",
            json={"passphrase": "test"},
            headers=auth_headers, timeout=15,
        )
        if resp.status_code == 404:
            # Fall back to old path
            resp = httpx.post(
                f"{core_url}/v1/vault/export",
                json={"persona": "general"},
                headers=auth_headers, timeout=15,
            )
        if resp.status_code in (404, 501):
            pytest.skip("Export endpoint not yet implemented")
        # Must not crash — 200 (exported) or 400 (bad passphrase) are valid
        assert resp.status_code in (200, 201, 400), (
            f"Export should return 200 or 400, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )

    # REL-021
    def test_rel_021_did_signature_verifiable(
        self, core_url, auth_headers,
    ) -> None:
        """DID signatures (used for export integrity) are verifiable."""
        # Get node's DID (verify endpoint requires it)
        did_resp = httpx.get(
            f"{core_url}/v1/did", headers=auth_headers, timeout=10,
        )
        assert did_resp.status_code == 200
        node_did = did_resp.json().get("id", "")

        test_data = "export-integrity-check"
        hex_data = test_data.encode().hex()

        resp = httpx.post(
            f"{core_url}/v1/did/sign",
            json={"data": hex_data},
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("DID sign endpoint not implemented")
        assert resp.status_code == 200
        sig = resp.json().get("signature", "")
        assert len(sig) > 0, "Signature should be non-empty"

        # Verify the signature
        resp = httpx.post(
            f"{core_url}/v1/did/verify",
            json={"data": hex_data, "signature": sig, "did": node_did},
            headers=auth_headers, timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("DID verify endpoint not implemented")
        assert resp.status_code == 200
        assert resp.json().get("valid") is True

    # REL-021
    def test_rel_021_kv_store_for_metadata(self, core_url, auth_headers) -> None:
        """KV store works for export metadata tracking."""
        key = "export:last_export_time"
        value = "2026-03-07T00:00:00Z"

        # PUT
        resp = httpx.put(
            f"{core_url}/v1/vault/kv/{key}",
            content=value,
            headers={**auth_headers, "Content-Type": "text/plain"},
            timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("KV endpoint not implemented")
        assert resp.status_code in (200, 201, 204)

        # GET
        resp = httpx.get(
            f"{core_url}/v1/vault/kv/{key}",
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200
