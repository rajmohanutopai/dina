"""Tests for the dina MCP server's contract surface (cli/src/dina_cli/mcp_server.py).

Specifically covers the MT-38 fix: agents calling `dina_ask` against a
locked vault must learn the polling protocol, AND there must be a
`dina_ask_status` tool to poll. Without these, the agent's read of a
sensitive vault would silently fail (or worse, the agent would invent
a heuristic answer because it didn't know the request was pending).

FastMCP ≥2 wraps `@mcp.tool()`-decorated functions in a `FunctionTool`
object — direct call (`tool(...)`) no longer works. These tests reach
the underlying callable via `tool.fn(...)` and read the MCP tool
description via `tool.description` (FastMCP exposes the docstring there).
A fake `DinaClient` is injected via `_get_client` monkey-patch — no
FastMCP runtime needed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli import mcp_server
from dina_cli.client import DinaClientError


@pytest.fixture
def fake_client(monkeypatch):
    """Inject a stub DinaClient that records calls + returns canned data."""
    fake = MagicMock()
    monkeypatch.setattr(mcp_server, "_get_client", lambda: fake)
    # Reset any cached singleton from a prior test.
    monkeypatch.setattr(mcp_server, "_client", None)
    return fake


@pytest.fixture
def pii_sessions(tmp_path, monkeypatch):
    """Keep MCP PII mappings isolated from the developer's real config."""
    from dina_cli.session import SessionStore

    store = SessionStore(base_dir=tmp_path)
    monkeypatch.setattr(mcp_server, "_sessions", store)
    return store


# ---------------------------------------------------------------------------
# dina_ask — three response shapes the agent must handle
# ---------------------------------------------------------------------------


def test_dina_ask_returns_synchronous_complete(fake_client):
    """Fast-path: Brain answers within the 3s window. The shape is:
    {status: 'complete', content: '<answer>'}. Agent uses the answer."""
    fake_client.ask.return_value = {"status": "complete", "content": "Raj"}
    out = mcp_server.dina_ask.fn(query="What is my name?", session="ses-1")
    assert out == {"status": "complete", "content": "Raj"}
    fake_client.ask.assert_called_once_with("What is my name?", session="ses-1")


def test_dina_ask_returns_in_flight_with_request_id(fake_client):
    """Slow path: Brain still reasoning. Agent must poll dina_ask_status."""
    fake_client.ask.return_value = {"status": "in_flight", "request_id": "req-abc"}
    out = mcp_server.dina_ask.fn(query="Long reasoning task", session="ses-1")
    assert out["status"] == "in_flight"
    assert out["request_id"] == "req-abc"


def test_dina_ask_returns_pending_approval_with_persona(fake_client):
    """Locked-vault path (MT-38): agent must NOT proceed; poll until
    operator approves or denies. Persona name surfaces so the agent can
    explain to its user what's gated."""
    fake_client.ask.return_value = {
        "status": "pending_approval",
        "request_id": "req-xyz",
        "persona": "financial",
    }
    out = mcp_server.dina_ask.fn(query="What's in my financial vault?", session="ses-1")
    assert out["status"] == "pending_approval"
    assert out["request_id"] == "req-xyz"
    assert out["persona"] == "financial"


def test_dina_ask_docstring_documents_all_three_shapes():
    """The MCP tool description is what the LLM agent reads — if the
    polling contract isn't spelled out, agents won't poll. Lock-in test
    so future edits don't strip the protocol notes."""
    doc = mcp_server.dina_ask.description or ""
    assert "complete" in doc.lower()
    assert "in_flight" in doc.lower()
    assert "pending_approval" in doc.lower()
    assert "dina_ask_status" in doc
    # Critical guidance — never assume approval, never substitute on denied.
    assert "denied" in doc.lower()
    assert "never" in doc.lower()


# ---------------------------------------------------------------------------
# dina_ask_status — polling tool
# ---------------------------------------------------------------------------


def test_dina_ask_status_returns_complete(fake_client):
    """Terminal status: status='complete' with content. Polling stops."""
    fake_client.ask_status.return_value = {"status": "complete", "content": "Raj"}
    out = mcp_server.dina_ask_status.fn(request_id="req-abc", session="sess-1")
    assert out["status"] == "complete"
    assert out["content"] == "Raj"
    fake_client.ask_status.assert_called_once_with("req-abc", session="sess-1")


def test_dina_ask_status_returns_pending_approval(fake_client):
    """Operator hasn't decided yet — keep polling."""
    fake_client.ask_status.return_value = {"status": "pending_approval"}
    out = mcp_server.dina_ask_status.fn(request_id="req-abc", session="sess-1")
    assert out["status"] == "pending_approval"


def test_dina_ask_status_returns_denied(fake_client):
    """Operator declined. Agent must NOT substitute a heuristic answer —
    treat as 'no data available'. The MT-38 contract."""
    fake_client.ask_status.return_value = {"status": "denied"}
    out = mcp_server.dina_ask_status.fn(request_id="req-abc", session="sess-1")
    assert out["status"] == "denied"


def test_dina_ask_status_returns_expired(fake_client):
    """Operator never decided in the TTL window — same outcome as denied
    from the agent's perspective: no data."""
    fake_client.ask_status.return_value = {"status": "expired"}
    out = mcp_server.dina_ask_status.fn(request_id="req-abc", session="sess-1")
    assert out["status"] == "expired"


def test_dina_ask_status_returns_failed_with_error(fake_client):
    """Reasoning itself errored. Agent surfaces the error rather than
    pretending to have an answer."""
    fake_client.ask_status.return_value = {"status": "failed", "error": "LLM timed out"}
    out = mcp_server.dina_ask_status.fn(request_id="req-abc", session="sess-1")
    assert out["status"] == "failed"
    assert "error" in out


def test_dina_ask_status_docstring_lists_terminal_states():
    """The status tool's docstring is what tells the agent which
    polling outcomes are terminal. Lock-in test — every state the CLI
    flow recognises must appear in the doc."""
    doc = mcp_server.dina_ask_status.description or ""
    for state in ("complete", "in_flight", "pending_approval",
                  "denied", "failed", "expired"):
        assert state in doc, f"missing state {state!r} in dina_ask_status docstring"


# ---------------------------------------------------------------------------
# dina_remember — narrow coding-agent memory facade
# ---------------------------------------------------------------------------


def test_dina_remember_forwards_session_and_optional_persona(fake_client):
    fake_client.remember.return_value = {
        "status": "stored",
        "persona": "health",
        "id": "mem-1",
    }

    out = mcp_server.dina_remember.fn(
        text="Lower back pain",
        session="sess-1",
        persona="health",
    )

    assert out["status"] == "stored"
    fake_client.remember.assert_called_once_with(
        "Lower back pain",
        session="sess-1",
        persona="health",
    )


def test_dina_remember_documents_approval_semantics():
    doc = mcp_server.dina_remember.description or ""
    assert "approval_required" in doc
    assert "must not claim" in doc


# ---------------------------------------------------------------------------
# Status — public health is not proof of pairing
# ---------------------------------------------------------------------------


def test_dina_status_requires_authenticated_probe(fake_client):
    fake_client._identity.did.return_value = "did:key:z6MkPaired"

    out = mcp_server.dina_status.fn()

    assert out == {
        "status": "connected",
        "paired": True,
        "did": "did:key:z6MkPaired",
    }
    fake_client._request.assert_called_once_with(
        fake_client._core,
        "GET",
        "/healthz",
    )
    fake_client.session_list.assert_called_once_with()


def test_dina_status_does_not_treat_public_health_as_pairing(fake_client):
    fake_client.session_list.side_effect = DinaClientError("HTTP 403")

    out = mcp_server.dina_status.fn()

    assert out["status"] == "unavailable"
    assert out["paired"] is False
    assert "403" in out["error"]


# ---------------------------------------------------------------------------
# PII scrub / rehydrate — the pair must be usable through MCP
# ---------------------------------------------------------------------------


def test_dina_scrub_persists_mapping_and_hides_raw_entities(fake_client, pii_sessions):
    fake_client.pii_scrub.return_value = {
        "scrubbed": "Email [EMAIL_1]",
        "entities": [
            {
                "type": "EMAIL",
                "token": "[EMAIL_1]",
                "value": "raj@example.com",
            }
        ],
    }

    out = mcp_server.dina_scrub.fn(text="Email raj@example.com")

    assert out["scrubbed"] == "Email [EMAIL_1]"
    assert out["pii_id"].startswith("pii_")
    assert "entities" not in out
    assert pii_sessions.load(out["pii_id"]) == [
        {"token": "[EMAIL_1]", "value": "raj@example.com"}
    ]


def test_dina_scrub_rejects_a_mapping_without_original_values(
    fake_client, pii_sessions
):
    fake_client.pii_scrub.return_value = {
        "scrubbed": "Email [EMAIL_1]",
        "entities": [{"type": "EMAIL", "token": "[EMAIL_1]"}],
    }

    with pytest.raises(ValueError, match="original value"):
        mcp_server.dina_scrub.fn(text="Email raj@example.com")


def test_dina_rehydrate_restores_locally(fake_client, pii_sessions):
    pii_sessions.save(
        "pii_deadbeef",
        [{"type": "EMAIL", "value": "raj@example.com"}],
    )

    out = mcp_server.dina_rehydrate.fn(
        text="Email [EMAIL_1]",
        pii_id="pii_deadbeef",
    )

    assert out == {"restored": "Email raj@example.com"}
    fake_client.assert_not_called()
    with pytest.raises(FileNotFoundError):
        pii_sessions.load("pii_deadbeef")


def test_dina_scrub_without_pii_can_still_rehydrate(fake_client, pii_sessions):
    fake_client.pii_scrub.return_value = {"scrubbed": "No secrets", "entities": []}
    scrubbed = mcp_server.dina_scrub.fn(text="No secrets")

    assert mcp_server.dina_rehydrate.fn(
        text=scrubbed["scrubbed"],
        pii_id=scrubbed["pii_id"],
    ) == {"restored": "No secrets"}


@pytest.mark.parametrize("pii_id", ["", "../config", "pii_nothex", "pii_1234"])
def test_dina_rehydrate_rejects_untrusted_session_ids(pii_id, pii_sessions):
    with pytest.raises(ValueError, match="Invalid pii_id"):
        mcp_server.dina_rehydrate.fn(text="[EMAIL_1]", pii_id=pii_id)


def test_dina_rehydrate_reports_missing_session(pii_sessions):
    with pytest.raises(ValueError, match="was not found"):
        mcp_server.dina_rehydrate.fn(text="[EMAIL_1]", pii_id="pii_deadbeef")


def test_coding_profile_removes_runner_task_tools(monkeypatch):
    removed = []
    monkeypatch.setattr(mcp_server.mcp, "remove_tool", removed.append)

    mcp_server.configure_profile("coding")

    assert removed == [
        "dina_task_complete",
        "dina_task_fail",
        "dina_task_progress",
    ]
