"""Dina MCP Server — exposes Dina CLI as MCP tools for agent frameworks.

Run: dina mcp-server
OpenClaw config:
  mcp: { servers: { dina: { command: "dina", args: ["mcp-server"] } } }

All tools use the same Ed25519 signed HTTP client as the CLI.
Pure tool server — no background threads, no WS listeners.
Task execution is handled by `dina agent-daemon` (separate process).
"""

from __future__ import annotations

import json
from typing import Any

from fastmcp import FastMCP

from .client import DinaClient, DinaClientError
from .config import load_config

mcp = FastMCP("dina")

_client: DinaClient | None = None


def _get_client() -> DinaClient:
    global _client
    if _client is None:
        cfg = load_config()
        _client = DinaClient(cfg)
    return _client


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_session_start(name: str = "") -> dict:
    """Start a Dina session. All subsequent actions are scoped to this session.
    Returns session ID. Always start a session before doing work."""
    c = _get_client()
    return c.session_start(name or "mcp-session")


@mcp.tool()
def dina_session_end(session_id: str) -> dict:
    """End a Dina session. Revokes all grants and closes sensitive vaults."""
    c = _get_client()
    c.session_end(session_id)
    return {"status": "ended", "session": session_id}


# ---------------------------------------------------------------------------
# Action validation (safety layer)
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_validate(
    action: str,
    description: str,
    session: str,
    context: dict | None = None,
    count: int = 1,
    reversible: bool = False,
) -> dict:
    """Validate an action before executing it. Dina checks risk and user policy.

    CRITICAL: If status is 'pending_approval', do NOT execute the action.
    The human will be notified via Telegram. Wait for dina_validate_status
    to return 'approved' before proceeding. Never assume approval.

    Args:
        action: Action type (e.g. 'search', 'send_email', 'delete_files')
        description: What the action does
        session: Session ID from dina_session_start
        context: Display-only metadata for the human reviewer
                 (e.g. {"to": "user@co.com", "subject": "Report", "attachment_count": 2})
        count: Number of items affected
        reversible: Whether the action can be undone
    """
    c = _get_client()
    payload: dict[str, Any] = {
        "action": action,
        "target": description,
        "count": count,
        "reversible": reversible,
    }
    if context:
        payload["context"] = context

    result = c.process_event({
        "type": "agent_intent",
        "action": action,
        "target": description,
        "payload": payload,
    }, session=session)

    approved = result.get("approved", False)
    requires = result.get("requires_approval", False)
    proposal_id = result.get("proposal_id", "")

    if approved and not requires:
        status = "approved"
    elif requires:
        status = "pending_approval"
    else:
        status = "denied"

    out: dict[str, Any] = {
        "status": status,
        "risk": result.get("risk", ""),
    }
    if proposal_id:
        out["proposal_id"] = proposal_id
    return out


@mcp.tool()
def dina_validate_status(proposal_id: str, session: str) -> dict:
    """Check approval status of a pending action.
    Returns status: 'approved', 'pending', 'denied', or 'expired'.
    Only proceed with the action when status is 'approved'."""
    c = _get_client()
    return c.get_proposal_status(proposal_id, session=session)


# ---------------------------------------------------------------------------
# Vault operations
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_ask(query: str, session: str) -> dict:
    """Ask Dina a question. She reasons over the encrypted vault.
    May require approval if the query touches sensitive personas."""
    c = _get_client()
    return c.ask(query, session=session)


@mcp.tool()
def dina_remember(text: str, session: str, category: str = "") -> dict:
    """Store a fact in the vault. Dina classifies it into the right persona."""
    c = _get_client()
    return c.remember(text, session=session)


# ---------------------------------------------------------------------------
# Task lifecycle — called by agent when task work is done
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_task_complete(task_id: str, result: str) -> dict:
    """Report that a delegated task is complete.

    IMPORTANT: Call this when you have finished the task. Include a summary
    of what you did and any results. The user will see this in /taskstatus.

    Args:
        task_id: The task ID (from the task prompt)
        result: Human-readable summary of what was accomplished
    """
    c = _get_client()
    c.task_complete(task_id, result)
    return {"status": "completed", "task_id": task_id}


@mcp.tool()
def dina_task_fail(task_id: str, error: str) -> dict:
    """Report that a delegated task failed.

    Call this if you cannot complete the task for any reason.

    Args:
        task_id: The task ID (from the task prompt)
        error: What went wrong
    """
    c = _get_client()
    c.task_fail(task_id, error)
    return {"status": "failed", "task_id": task_id}


@mcp.tool()
def dina_task_progress(task_id: str, message: str) -> dict:
    """Report progress on a running task (optional).

    Args:
        task_id: The task ID (from the task prompt)
        message: Human-readable progress note
    """
    c = _get_client()
    c.task_progress(task_id, message)
    return {"status": "ok", "task_id": task_id}


# ---------------------------------------------------------------------------
# PII scrubbing
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_scrub(text: str) -> dict:
    """Remove PII from text. Returns scrubbed text + pii_id for rehydration.
    Always scrub before passing user content to external APIs."""
    c = _get_client()
    return c.pii_scrub(text)


@mcp.tool()
def dina_status() -> dict:
    """Check Dina connectivity and identity."""
    c = _get_client()
    try:
        c._request(c._core, "GET", "/healthz")
        did = c._identity.did()
        return {"status": "connected", "did": did}
    except Exception as e:
        return {"status": "unreachable", "error": str(e)}


def run_server():
    """Entry point for `dina mcp-server`. Pure tool server, no background threads."""
    mcp.run(transport="stdio")
