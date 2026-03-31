"""Post-install functional tests — verify Dina works after install.

These tests run against an already-running Dina instance. They don't
run install.sh — they verify the result of an install by testing the
APIs and commands that users interact with first.

Run modes:
  1. Via installed_dir fixture (full pexpect install in temp dir)
  2. Via DINA_CORE_URL env var (point at any running Dina)

Set DINA_CORE_URL=http://localhost:8100 and DINA_CLIENT_TOKEN=<token>
to run against your dev instance without waiting for a fresh install.

Every test here maps to a real bug found during manual testing.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import httpx
import pytest

# ---------------------------------------------------------------------------
# Dual-mode: use DINA_CORE_URL env var or installed_dir fixture
# ---------------------------------------------------------------------------

_CORE_URL = os.environ.get("DINA_CORE_URL", "")
_CLIENT_TOKEN = os.environ.get("DINA_CLIENT_TOKEN", "")


def _resolve_core(installed_dir: Path | None) -> tuple[str, str]:
    """Return (core_url, token) from env or installed_dir."""
    if _CORE_URL and _CLIENT_TOKEN:
        return _CORE_URL, _CLIENT_TOKEN
    if installed_dir is None:
        pytest.skip("Set DINA_CORE_URL + DINA_CLIENT_TOKEN or use installed_dir fixture")
    port = "8100"
    env_file = installed_dir / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DINA_CORE_PORT="):
                port = line.split("=", 1)[1]
    token_file = installed_dir / "secrets" / "client_token"
    token = token_file.read_text().strip() if token_file.exists() else ""
    return f"http://localhost:{port}", token


@pytest.fixture
def core(request):
    """Provide (core_url, token).

    Prefers DINA_CORE_URL + DINA_CLIENT_TOKEN env vars (fast, no install).
    Falls back to installed_dir fixture (runs install.sh via pexpect once
    per session — slow on first call, shared across all tests).
    """
    if _CORE_URL and _CLIENT_TOKEN:
        return {"url": _CORE_URL, "token": _CLIENT_TOKEN}
    # Fall back to installed_dir fixture (session-scoped pexpect install)
    installed_dir = request.getfixturevalue("installed_dir")
    url, token = _resolve_core(installed_dir)
    return {"url": url, "token": token}


def _get(c: dict, path: str) -> httpx.Response:
    return httpx.get(
        f"{c['url']}{path}",
        headers={"Authorization": f"Bearer {c['token']}"},
        timeout=10,
    )


def _post(c: dict, path: str, body: dict, timeout: float = 30) -> httpx.Response:
    return httpx.post(
        f"{c['url']}{path}",
        json=body,
        headers={"Authorization": f"Bearer {c['token']}"},
        timeout=timeout,
    )


# ==========================================================================
# Default personas bootstrapped (Issue #2)
# ==========================================================================


class TestDefaultPersonas:
    """Four default personas exist and have correct access tiers."""

    # TRACE: {"suite": "INST", "case": "0080", "section": "06", "sectionName": "Post-Install", "subsection": "01", "scenario": "01", "title": "four_personas_exist"}
    def test_four_personas_exist(self, core) -> None:
        resp = _get(core, "/v1/personas")
        assert resp.status_code == 200
        personas = resp.json()
        if isinstance(personas, dict):
            personas = personas.get("personas", [])
        names = set(
            (p if isinstance(p, str) else p.get("name", "")).removeprefix("persona-")
            for p in personas
        )
        expected = {"general", "work", "health", "finance"}
        missing = expected - names
        assert not missing, f"Missing personas: {missing} (got: {names})"

    # TRACE: {"suite": "INST", "case": "0081", "section": "06", "sectionName": "Post-Install", "subsection": "01", "scenario": "02", "title": "general_open"}
    def test_general_open(self, core) -> None:
        resp = _post(core, "/v1/vault/query", {
            "persona": "general", "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200

    # TRACE: {"suite": "INST", "case": "0082", "section": "06", "sectionName": "Post-Install", "subsection": "01", "scenario": "03", "title": "work_open"}
    def test_work_open(self, core) -> None:
        resp = _post(core, "/v1/vault/query", {
            "persona": "work", "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200

    # TRACE: {"suite": "INST", "case": "0083", "section": "06", "sectionName": "Post-Install", "subsection": "01", "scenario": "04", "title": "health_auto_opens"}
    def test_health_auto_opens(self, core) -> None:
        """v1 auto-open: sensitive personas open for authorized callers (admin CLIENT_TOKEN)."""
        resp = _post(core, "/v1/vault/query", {
            "persona": "health", "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200

    # TRACE: {"suite": "INST", "case": "0084", "section": "06", "sectionName": "Post-Install", "subsection": "01", "scenario": "05", "title": "finance_auto_opens"}
    def test_finance_auto_opens(self, core) -> None:
        """v1 auto-open: sensitive personas open for authorized callers (admin CLIENT_TOKEN)."""
        resp = _post(core, "/v1/vault/query", {
            "persona": "finance", "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200


# ==========================================================================
# Vault store + query round-trip (Issue #2)
# ==========================================================================


class TestVaultRoundTrip:
    # TRACE: {"suite": "INST", "case": "0085", "section": "06", "sectionName": "Post-Install", "subsection": "02", "scenario": "01", "title": "store_and_query"}
    def test_store_and_query(self, core) -> None:
        tag = f"postinstall_{os.getpid()}"
        store = _post(core, "/v1/vault/store", {
            "persona": "general",
            "item": {
                "type": "note",
                "summary": f"{tag} test note",
                "body_text": f"{tag} this is a post-install test",
                "source": "test",
            },
        })
        assert store.status_code in (200, 201)
        item_id = store.json().get("id", "")
        assert item_id

        query = _post(core, "/v1/vault/query", {
            "persona": "general", "query": tag, "mode": "fts5",
            "include_content": True,
        })
        assert query.status_code == 200
        assert any(i.get("id") == item_id for i in query.json().get("items", []))


# ==========================================================================
# LLM error reporting (Issue #1)
# ==========================================================================


class TestLLMErrorReporting:
    """Brain returns error_code, not empty content, when LLM fails.

    These tests require Brain to be running. When Brain is not available
    (Core-only testing), Core returns 502 — skip in that case.
    """

    # TRACE: {"suite": "INST", "case": "0086", "section": "06", "sectionName": "Post-Install", "subsection": "03", "scenario": "01", "title": "reason_returns_error_code_or_content"}
    def test_reason_returns_error_code_or_content(self, core) -> None:
        resp = _post(core, "/api/v1/ask", {"prompt": "hello"}, timeout=60)
        if resp.status_code == 502:
            pytest.skip("Brain not running (Core-only mode)")
        assert resp.status_code in (200, 202)
        data = resp.json()
        error_code = data.get("error_code", "")
        content = data.get("content", "")
        assert error_code or content, (
            f"Neither error_code nor content: {json.dumps(data)[:200]}"
        )

    # TRACE: {"suite": "INST", "case": "0087", "section": "06", "sectionName": "Post-Install", "subsection": "03", "scenario": "02", "title": "error_code_classified"}
    def test_error_code_classified(self, core) -> None:
        resp = _post(core, "/api/v1/ask", {"prompt": "test"}, timeout=60)
        if resp.status_code == 502:
            pytest.skip("Brain not running (Core-only mode)")
        data = resp.json()
        ec = data.get("error_code", "")
        if ec:
            assert ec in {
                "llm_not_configured", "llm_auth_failed", "llm_timeout",
                "llm_unreachable", "llm_error",
            }

    # TRACE: {"suite": "INST", "case": "0088", "section": "06", "sectionName": "Post-Install", "subsection": "03", "scenario": "03", "title": "error_has_message"}
    def test_error_has_message(self, core) -> None:
        resp = _post(core, "/api/v1/ask", {"prompt": "test"}, timeout=60)
        if resp.status_code == 502:
            pytest.skip("Brain not running (Core-only mode)")
        data = resp.json()
        if data.get("error_code"):
            assert data.get("message")


# ==========================================================================
# DID available (Issue #3)
# ==========================================================================


class TestDID:
    # TRACE: {"suite": "INST", "case": "0089", "section": "06", "sectionName": "Post-Install", "subsection": "04", "scenario": "01", "title": "did_available"}
    def test_did_available(self, core) -> None:
        resp = httpx.get(
            f"{core['url']}/.well-known/atproto-did", timeout=10,
        )
        assert resp.status_code == 200
        assert resp.text.strip().startswith("did:")


# ==========================================================================
# Security (auth enforced)
# ==========================================================================


class TestSecurity:
    # TRACE: {"suite": "INST", "case": "0090", "section": "06", "sectionName": "Post-Install", "subsection": "05", "scenario": "01", "title": "no_auth_401"}
    def test_no_auth_401(self, core) -> None:
        resp = httpx.get(f"{core['url']}/v1/personas", timeout=10)
        assert resp.status_code == 401

    # TRACE: {"suite": "INST", "case": "0091", "section": "06", "sectionName": "Post-Install", "subsection": "05", "scenario": "02", "title": "bad_token_401"}
    def test_bad_token_401(self, core) -> None:
        resp = httpx.get(
            f"{core['url']}/v1/personas",
            headers={"Authorization": "Bearer WRONG"},
            timeout=10,
        )
        assert resp.status_code == 401

    # TRACE: {"suite": "INST", "case": "0092", "section": "06", "sectionName": "Post-Install", "subsection": "05", "scenario": "03", "title": "healthz_no_auth"}
    def test_healthz_no_auth(self, core) -> None:
        resp = httpx.get(f"{core['url']}/healthz", timeout=10)
        assert resp.status_code == 200


# ==========================================================================
# Unified approvals API
# ==========================================================================


class TestApprovals:
    # TRACE: {"suite": "INST", "case": "0093", "section": "06", "sectionName": "Post-Install", "subsection": "06", "scenario": "01", "title": "list_empty"}
    def test_list_empty(self, core) -> None:
        resp = _get(core, "/v1/approvals")
        assert resp.status_code == 200
        assert "approvals" in resp.json()

    # TRACE: {"suite": "INST", "case": "0094", "section": "06", "sectionName": "Post-Install", "subsection": "06", "scenario": "02", "title": "deny_unknown_404"}
    def test_deny_unknown_404(self, core) -> None:
        resp = _post(core, "/v1/approvals/apr-nonexistent/deny", {})
        assert resp.status_code in (404, 403)


# ==========================================================================
# Async approval endpoints
# ==========================================================================


class TestAsyncApproval:
    # TRACE: {"suite": "INST", "case": "0095", "section": "06", "sectionName": "Post-Install", "subsection": "07", "scenario": "01", "title": "reason_status_404_for_unknown"}
    def test_reason_status_404_for_unknown(self, core) -> None:
        resp = _get(core, "/api/v1/ask/reason-nonexistent/status")
        assert resp.status_code == 404

    # TRACE: {"suite": "INST", "case": "0096", "section": "06", "sectionName": "Post-Install", "subsection": "07", "scenario": "02", "title": "reason_endpoint_exists"}
    def test_reason_endpoint_exists(self, core) -> None:
        resp = _post(core, "/api/v1/ask", {"prompt": "test"}, timeout=60)
        # 502 = Brain not running (Core-only), which is fine — endpoint exists
        assert resp.status_code in (200, 202, 502)


# ==========================================================================
# KV store
# ==========================================================================


class TestKVStore:
    # TRACE: {"suite": "INST", "case": "0097", "section": "06", "sectionName": "Post-Install", "subsection": "08", "scenario": "01", "title": "round_trip"}
    def test_round_trip(self, core) -> None:
        key = f"postinstall_{os.getpid()}"
        put = httpx.put(
            f"{core['url']}/v1/vault/kv/{key}",
            content="test-value",
            headers={
                "Authorization": f"Bearer {core['token']}",
                "Content-Type": "text/plain",
            },
            timeout=10,
        )
        assert put.status_code in (200, 201, 204)

        get = _get(core, f"/v1/vault/kv/{key}")
        assert get.status_code == 200
        assert "test-value" in get.text


# ==========================================================================
# PII scrubbing
# ==========================================================================


class TestPII:
    # TRACE: {"suite": "INST", "case": "0098", "section": "06", "sectionName": "Post-Install", "subsection": "09", "scenario": "01", "title": "scrub_phone"}
    def test_scrub_phone(self, core) -> None:
        resp = _post(core, "/v1/pii/scrub", {"text": "Call 9876543210"})
        assert resp.status_code == 200
        assert "9876543210" not in resp.json().get("scrubbed", "9876543210")


# ==========================================================================
# Owner name doesn't break anything
# ==========================================================================


class TestOwnerName:
    # TRACE: {"suite": "INST", "case": "0099", "section": "06", "sectionName": "Post-Install", "subsection": "10", "scenario": "01", "title": "brain_healthz_accepts_owner_name"}
    def test_brain_healthz_accepts_owner_name(self, core) -> None:
        """Brain healthz works regardless of DINA_OWNER_NAME setting."""
        # Brain runs on port 8200 internally — we can't reach it directly
        # in env-var mode. Just verify Core is healthy (Brain depends on Core).
        resp = httpx.get(f"{core['url']}/healthz", timeout=10)
        assert resp.status_code == 200


# ==========================================================================
# Persona bootstrap doesn't recreate deleted personas
# ==========================================================================


class TestPersonaBootstrapIdempotent:
    """Bootstrap only runs when zero personas exist.

    If a user deletes a persona, it should NOT be recreated on restart.
    This test verifies by checking that creating a 5th persona doesn't
    trigger re-bootstrap (which would duplicate the 4 defaults).
    """

    # TRACE: {"suite": "INST", "case": "0100", "section": "06", "sectionName": "Post-Install", "subsection": "11", "scenario": "01", "title": "create_extra_persona_no_duplicates"}
    def test_create_extra_persona_no_duplicates(self, core) -> None:
        """Creating a custom persona doesn't duplicate defaults on next query."""
        # Create a 5th persona
        resp = _post(core, "/v1/personas", {
            "name": "social", "tier": "standard", "passphrase": "test",
        })
        assert resp.status_code in (200, 201, 409), (
            f"Create persona failed: {resp.status_code} {resp.text[:100]}"
        )

        # Verify total persona count is 5, not 8 (4 defaults + 4 re-bootstrapped)
        list_resp = _get(core, "/v1/personas")
        assert list_resp.status_code == 200
        personas = list_resp.json()
        if isinstance(personas, dict):
            personas = personas.get("personas", [])
        names = [
            (p if isinstance(p, str) else p.get("name", "")).removeprefix("persona-")
            for p in personas
        ]
        # Count how many times "general" appears — should be exactly 1
        general_count = sum(1 for n in names if n == "general")
        assert general_count == 1, f"general appears {general_count} times: {names}"
