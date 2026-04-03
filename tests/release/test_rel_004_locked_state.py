"""REL-004 Locked-State and Seal Verification.

Verify that Dina stays sealed before unlock and fails cleanly while sealed.

Execution class: Harness.
"""

from __future__ import annotations

import httpx
import pytest


class TestLockedState:
    """Real API tests for REL-004: locked persona behavior."""

    # REL-004
    # TRACE: {"suite": "REL", "case": "0004", "section": "04", "sectionName": "Locked State", "subsection": "01", "scenario": "01", "title": "rel_004_locked_persona_returns_403"}
    def test_rel_004_locked_persona_returns_403(
        self, core_url, auth_headers,
    ) -> None:
        """Locked persona vault access returns 403."""
        # Create and lock a test persona
        httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "locktest", "tier": "locked", "passphrase": "lockpw"},
            headers=auth_headers, timeout=10,
        )

        # Attempt to query the locked persona
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "locktest", "query": "test", "mode": "fts5"},
            headers=auth_headers, timeout=10,
        )
        # Locked persona must return 403 (forbidden) — NOT 500 (crash)
        assert resp.status_code in (403, 423), (
            f"Locked persona should return 403/423, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )

    # REL-004
    # TRACE: {"suite": "REL", "case": "0004", "section": "04", "sectionName": "Locked State", "subsection": "01", "scenario": "02", "title": "rel_004_unlock_resumes_access"}
    def test_rel_004_unlock_resumes_access(
        self, core_url, auth_headers,
    ) -> None:
        """Unlocking a persona resumes vault access."""
        # Create persona
        httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "unlocktest", "tier": "locked", "passphrase": "unlockpw"},
            headers=auth_headers, timeout=10,
        )

        # Unlock it
        resp = httpx.post(
            f"{core_url}/v1/persona/unlock",
            json={"persona": "unlocktest", "passphrase": "unlockpw"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200, f"Unlock failed: {resp.status_code} {resp.text}"

        # Now vault access should work
        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "unlocktest", "query": "test", "mode": "fts5"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200, f"Query after unlock failed: {resp.status_code}"

    # REL-004
    # TRACE: {"suite": "REL", "case": "0004", "section": "04", "sectionName": "Locked State", "subsection": "01", "scenario": "03", "title": "rel_004_no_data_in_locked_error"}
    def test_rel_004_no_data_in_locked_error(
        self, core_url, auth_headers,
    ) -> None:
        """Error response for locked persona does not leak vault data."""
        # Create and keep locked
        httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "leaktest", "tier": "locked", "passphrase": "leakpw"},
            headers=auth_headers, timeout=10,
        )

        resp = httpx.post(
            f"{core_url}/v1/vault/query",
            json={"persona": "leaktest", "query": "secret data"},
            headers=auth_headers, timeout=10,
        )
        # Must fail with 403/423 — NOT 200 (data leak) or 500 (crash)
        assert resp.status_code in (403, 423), (
            f"Locked persona query should return 403/423, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )
        # Error body must not leak vault data
        body = resp.text.lower()
        assert "secret data" not in body, "Vault data leaked in error response"

    # REL-004
    # TRACE: {"suite": "REL", "case": "0004", "section": "04", "sectionName": "Locked State", "subsection": "01", "scenario": "04", "title": "rel_004_wrong_passphrase_rejected"}
    def test_rel_004_wrong_passphrase_rejected(
        self, core_url, auth_headers,
    ) -> None:
        """Wrong passphrase does not unlock a persona."""
        httpx.post(
            f"{core_url}/v1/personas",
            json={"name": "wrongpw", "tier": "locked", "passphrase": "correct"},
            headers=auth_headers, timeout=10,
        )

        resp = httpx.post(
            f"{core_url}/v1/persona/unlock",
            json={"persona": "wrongpw", "passphrase": "incorrect"},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (401, 403), (
            f"Wrong passphrase should fail, got {resp.status_code}"
        )
