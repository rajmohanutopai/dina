"""Tests for the dina MCP server's contract surface (cli/src/dina_cli/mcp_server.py).

Specifically covers the MT-38 fix: agents calling `dina_ask` against a
locked vault must learn the polling protocol, AND there must be a
`dina_ask_status` tool to poll. Without these, the agent's read of a
sensitive vault would silently fail (or worse, the agent would invent
a heuristic answer because it didn't know the request was pending).

The MCP tool decorator preserves the wrapped function's callability,
so these tests import the tools as plain Python functions and inject a
fake `DinaClient` via `_get_client` monkey-patch — no FastMCP runtime
needed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli import mcp_server


@pytest.fixture
def fake_client(monkeypatch):
    """Inject a stub DinaClient that records calls + returns canned data."""
    fake = MagicMock()
    monkeypatch.setattr(mcp_server, "_get_client", lambda: fake)
    # Reset any cached singleton from a prior test.
    monkeypatch.setattr(mcp_server, "_client", None)
    return fake


# ---------------------------------------------------------------------------
# dina_ask — three response shapes the agent must handle
# ---------------------------------------------------------------------------


def test_dina_ask_returns_synchronous_complete(fake_client):
    """Fast-path: Brain answers within the 3s window. The shape is:
    {status: 'complete', content: '<answer>'}. Agent uses the answer."""
    fake_client.ask.return_value = {"status": "complete", "content": "Raj"}
    out = mcp_server.dina_ask(query="What is my name?", session="ses-1")
    assert out == {"status": "complete", "content": "Raj"}
    fake_client.ask.assert_called_once_with("What is my name?", session="ses-1")


def test_dina_ask_returns_in_flight_with_request_id(fake_client):
    """Slow path: Brain still reasoning. Agent must poll dina_ask_status."""
    fake_client.ask.return_value = {"status": "in_flight", "request_id": "req-abc"}
    out = mcp_server.dina_ask(query="Long reasoning task", session="ses-1")
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
    out = mcp_server.dina_ask(query="What's in my financial vault?", session="ses-1")
    assert out["status"] == "pending_approval"
    assert out["request_id"] == "req-xyz"
    assert out["persona"] == "financial"


def test_dina_ask_docstring_documents_all_three_shapes():
    """The MCP tool description is what the LLM agent reads — if the
    polling contract isn't spelled out, agents won't poll. Lock-in test
    so future edits don't strip the protocol notes."""
    doc = mcp_server.dina_ask.__doc__ or ""
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
    out = mcp_server.dina_ask_status(request_id="req-abc")
    assert out["status"] == "complete"
    assert out["content"] == "Raj"
    fake_client.ask_status.assert_called_once_with("req-abc")


def test_dina_ask_status_returns_pending_approval(fake_client):
    """Operator hasn't decided yet — keep polling."""
    fake_client.ask_status.return_value = {"status": "pending_approval"}
    out = mcp_server.dina_ask_status(request_id="req-abc")
    assert out["status"] == "pending_approval"


def test_dina_ask_status_returns_denied(fake_client):
    """Operator declined. Agent must NOT substitute a heuristic answer —
    treat as 'no data available'. The MT-38 contract."""
    fake_client.ask_status.return_value = {"status": "denied"}
    out = mcp_server.dina_ask_status(request_id="req-abc")
    assert out["status"] == "denied"


def test_dina_ask_status_returns_expired(fake_client):
    """Operator never decided in the TTL window — same outcome as denied
    from the agent's perspective: no data."""
    fake_client.ask_status.return_value = {"status": "expired"}
    out = mcp_server.dina_ask_status(request_id="req-abc")
    assert out["status"] == "expired"


def test_dina_ask_status_returns_failed_with_error(fake_client):
    """Reasoning itself errored. Agent surfaces the error rather than
    pretending to have an answer."""
    fake_client.ask_status.return_value = {"status": "failed", "error": "LLM timed out"}
    out = mcp_server.dina_ask_status(request_id="req-abc")
    assert out["status"] == "failed"
    assert "error" in out


def test_dina_ask_status_docstring_lists_terminal_states():
    """The status tool's docstring is what tells the agent which
    polling outcomes are terminal. Lock-in test — every state the CLI
    flow recognises must appear in the doc."""
    doc = mcp_server.dina_ask_status.__doc__ or ""
    for state in ("complete", "in_flight", "pending_approval",
                  "denied", "failed", "expired"):
        assert state in doc, f"missing state {state!r} in dina_ask_status docstring"
