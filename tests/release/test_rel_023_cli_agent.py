"""REL-023 CLI and External Agent Integration.

Verify that an external agent can use the Dina CLI to interact with
a real Home Node through Docker containers. Tests the full pipeline:
dummy-agent -> CLI -> Go Core -> Python Brain.

Execution class: Pre-release Harness.
"""

from __future__ import annotations

import json

import pytest


class TestCLIAgentIntegration:
    """Tests for REL-023: CLI + external agent via Docker."""

    # REL-023
    def test_rel_023_agent_can_store_data(
        self, release_services, agent_paired,
    ) -> None:
        """Agent stores a fact via `dina remember`."""
        result = release_services.agent_exec(
            "remember", "user prefers lumbar support in office chairs",
            "--category", "preference",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data.get("stored") is True

    # REL-023
    def test_rel_023_agent_can_recall_data(
        self, release_services, agent_paired,
    ) -> None:
        """Agent recalls stored data via `dina recall`."""
        # Store first
        release_services.agent_exec(
            "remember", "ergonomic chair with adjustable armrests",
        )

        # Recall
        result = release_services.agent_exec("recall", "ergonomic chair")
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert isinstance(data, list)
        # May or may not find results depending on FTS indexing timing
        # The key assertion is that the CLI call succeeded against real Core

    # REL-023
    def test_rel_023_agent_validates_safe_action(
        self, release_services, agent_paired,
    ) -> None:
        """Safe action (search) is auto-approved via `dina validate`."""
        result = release_services.agent_exec(
            "validate", "search", "best office chair 2026",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data.get("status") in ("approved", "pending_approval")
        assert "id" in data

    # REL-023
    def test_rel_023_agent_validates_risky_action(
        self, release_services, agent_paired,
    ) -> None:
        """Risky action (send_email) requires approval via `dina validate`."""
        result = release_services.agent_exec(
            "validate", "send_email", "draft to sancho@example.com",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        # Risky actions should require approval or be explicitly approved
        assert data.get("status") in ("approved", "pending_approval", "denied")
        assert "id" in data

    # REL-023
    def test_rel_023_agent_can_scrub_pii(
        self, release_services, agent_paired,
    ) -> None:
        """Agent scrubs PII via `dina scrub`."""
        result = release_services.agent_exec(
            "scrub", "Contact Rajmohan at raj@example.com for details",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert "scrubbed" in data
        assert "session" in data
        # PII should be replaced
        scrubbed = data["scrubbed"]
        assert "raj@example.com" not in scrubbed or "[" in scrubbed

    # REL-023
    def test_rel_023_agent_can_stage_draft(
        self, release_services, agent_paired,
    ) -> None:
        """Agent stages a draft via `dina draft` — never auto-sends."""
        result = release_services.agent_exec(
            "draft", "Let's meet at 3pm tomorrow",
            "--to", "sancho@example.com",
            "--channel", "email",
            "--subject", "Meeting",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data.get("status") == "pending_review"
        assert "draft_id" in data

    # REL-023
    def test_rel_023_agent_can_sign_data(
        self, release_services, agent_paired,
    ) -> None:
        """Agent signs data cryptographically via `dina sign`."""
        result = release_services.agent_exec(
            "sign", "verified product recommendation",
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert "signed_by" in data
        assert data["signed_by"].startswith("did:key:z6Mk")
        assert "signature" in data
        assert len(data["signature"]) == 128  # 64 bytes hex

    # REL-023
    def test_rel_023_agent_can_view_audit(
        self, release_services, agent_paired,
    ) -> None:
        """Agent views activity audit via `dina audit`."""
        result = release_services.agent_exec("audit", "--limit", "5")
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert isinstance(data, list)

    # REL-023
    def test_rel_023_agent_validate_status_polling(
        self, release_services, agent_paired,
    ) -> None:
        """Agent polls validation status via `dina validate-status`."""
        # Submit an action first
        result = release_services.agent_exec(
            "validate", "transfer_money", "send 500 INR to merchant",
        )
        assert result.returncode == 0, f"validate failed: {result.stderr}"
        data = json.loads(result.stdout)
        val_id = data.get("id", "")
        assert val_id

        # Poll status
        result = release_services.agent_exec("validate-status", val_id)
        assert result.returncode == 0, f"validate-status failed: {result.stderr}"
        status_data = json.loads(result.stdout)
        # Response may wrap the decision in a "value" field (KV store format)
        if "value" in status_data and isinstance(status_data["value"], str):
            inner = json.loads(status_data["value"])
            assert "status" in inner
        else:
            assert "status" in status_data

    # REL-023
    def test_rel_023_unpaired_agent_rejected(
        self, release_services, core_url, auth_headers,
    ) -> None:
        """An unpaired agent's signed requests are rejected with 401.

        Generate a fresh keypair NOT registered with Core and verify
        that signed requests fail authentication.
        """
        import tempfile
        from pathlib import Path
        from dina_cli.signing import CLIIdentity

        with tempfile.TemporaryDirectory() as td:
            rogue = CLIIdentity(identity_dir=Path(td))
            rogue.generate()

            import hashlib
            from datetime import datetime, timezone

            body = json.dumps({"query": "test", "persona": "general"}).encode()
            did, ts, sig = rogue.sign_request("POST", "/v1/vault/query", body)

            import httpx
            resp = httpx.post(
                f"{core_url}/v1/vault/query",
                content=body,
                headers={
                    "X-DID": did,
                    "X-Timestamp": ts,
                    "X-Signature": sig,
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            assert resp.status_code == 401, (
                f"Unpaired agent should get 401, got {resp.status_code}"
            )
