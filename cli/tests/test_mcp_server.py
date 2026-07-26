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
        request_id="remember-0001",
        persona="health",
    )

    assert out["status"] == "stored"
    fake_client.remember.assert_called_once_with(
        "Lower back pain",
        session="sess-1",
        source_id="remember-0001",
        persona="health",
    )


def test_dina_remember_documents_approval_semantics():
    doc = mcp_server.dina_remember.description or ""
    assert "pending_approval" in doc
    assert "do not claim" in doc


def test_dina_remember_status_forwards_owned_poll(fake_client):
    fake_client.remember_check.return_value = {"status": "stored", "id": "stg-1"}

    out = mcp_server.dina_remember_status.fn(item_id="stg-1", session="sess-1")

    assert out["status"] == "stored"
    fake_client.remember_check.assert_called_once_with("stg-1", session="sess-1")


# ---------------------------------------------------------------------------
# Services — discover, publish, invoke, poll
# ---------------------------------------------------------------------------


def test_dina_find_service_forwards_bounded_search(fake_client):
    fake_client.find_services.return_value = {
        "matches": [],
        "capability_candidates": [],
    }
    out = mcp_server.dina_find_service.fn(
        session="sess-1",
        intent="book a haircut",
        query="Alonso",
        limit=5,
    )
    assert out["matches"] == []
    fake_client.find_services.assert_called_once_with(
        session="sess-1",
        intent="book a haircut",
        capability="",
        query="Alonso",
        lat=None,
        lng=None,
        radius_km=None,
        limit=5,
    )


def test_dina_publish_service_preserves_owner_approval_contract(fake_client):
    fake_client.publish_service.return_value = {
        "status": "pending_approval",
        "task_id": "approval-1",
    }
    config = {"name": "Alonso Salon"}
    out = mcp_server.dina_publish_service.fn(
        rkey="main",
        config=config,
        session="sess-1",
        request_id="publish-1",
    )
    assert out["status"] == "pending_approval"
    fake_client.publish_service.assert_called_once_with(
        rkey="main",
        config=config,
        session="sess-1",
        request_id="publish-1",
    )


def test_dina_invoke_service_and_status_forward_session(fake_client):
    fake_client.send_service_query.return_value = {
        "status": "pending_approval",
        "task_id": "approval-1",
    }
    fake_client.service_query_status.return_value = {
        "task_id": "sq-1",
        "status": "running",
    }
    params = {"date": "2026-07-26"}

    invoked = mcp_server.dina_invoke_service.fn(
        to_did="did:plc:salon",
        capability="appointment_book",
        params=params,
        session="sess-1",
        request_id="invoke-1",
        service_uri="at://did:plc:salon/com.dinakernel.service.profile/main",
    )
    polled = mcp_server.dina_service_status.fn(
        task_id="sq-1",
        session="sess-1",
    )

    assert invoked == {
        "status": "pending_approval",
        "task_id": "approval-1",
    }
    assert polled["status"] == "running"
    fake_client.send_service_query.assert_called_once_with(
        to_did="did:plc:salon",
        capability="appointment_book",
        params=params,
        session="sess-1",
        request_id="invoke-1",
        schema_hash="",
        service_uri="at://did:plc:salon/com.dinakernel.service.profile/main",
        service_name="",
        grant_id="",
        ttl_seconds=60,
    )
    fake_client.service_query_status.assert_called_once_with(
        task_id="sq-1",
        session="sess-1",
    )


def test_dina_service_publication_status_forwards_listing_and_session(fake_client):
    fake_client.service_publication_status.return_value = {
        "rkey": "salon",
        "publication_status": "pending",
        "next_retry_at": 123,
    }
    out = mcp_server.dina_service_publication_status.fn(
        rkey="salon",
        session="sess-1",
    )
    assert out["publication_status"] == "pending"
    fake_client.service_publication_status.assert_called_once_with(
        rkey="salon",
        session="sess-1",
    )


def test_service_tool_descriptions_preserve_async_and_privacy_contracts():
    assert "never sends vault data" in (mcp_server.dina_find_service.description or "")
    assert "pending" in (mcp_server.dina_publish_service.description or "")
    assert "asynchronous" in (mcp_server.dina_invoke_service.description or "")
    assert "same agent session" in (mcp_server.dina_service_status.description or "")
    assert "committed AT URI" in (
        mcp_server.dina_service_publication_status.description or ""
    )
    assert "pending_approval" in (
        mcp_server.dina_publish_service.description or ""
    )
    assert "service_invoke" in (mcp_server.dina_invoke_service.description or "")


# ---------------------------------------------------------------------------
# Talk + delegation
# ---------------------------------------------------------------------------


def test_dina_talk_forwards_exact_message_and_idempotency_key(fake_client):
    fake_client.talk.return_value = {
        "status": "pending_approval",
        "request_id": "talk-1",
    }
    out = mcp_server.dina_talk.fn(
        contact="Alonso",
        text="Can we meet tomorrow?",
        session="sess-1",
        request_id="talk-1",
        in_reply_to="msg-previous",
    )

    assert out["status"] == "pending_approval"
    fake_client.talk.assert_called_once_with(
        contact="Alonso",
        text="Can we meet tomorrow?",
        session="sess-1",
        request_id="talk-1",
        in_reply_to="msg-previous",
    )


def test_dina_delegate_and_status_preserve_approval_contract(fake_client):
    fake_client.delegate.return_value = {
        "status": "pending_approval",
        "request_id": "delegate-1",
    }
    fake_client.action_status.return_value = {
        "status": "completed",
        "delegation_task_id": "task-1",
        "delegation_submit_status": "queued",
    }

    submitted = mcp_server.dina_delegate.fn(
        runner="codex",
        description="Compare the proposals",
        input={"paths": ["a.md", "b.md"]},
        session="sess-1",
        request_id="delegate-1",
    )
    polled = mcp_server.dina_action_status.fn(
        action="delegate",
        request_id="delegate-1",
        session="sess-1",
    )

    assert submitted["status"] == "pending_approval"
    assert polled["delegation_task_id"] == "task-1"
    fake_client.delegate.assert_called_once_with(
        runner="codex",
        description="Compare the proposals",
        input_data={"paths": ["a.md", "b.md"]},
        session="sess-1",
        request_id="delegate-1",
    )
    fake_client.action_status.assert_called_once_with(
        action="delegate",
        request_id="delegate-1",
        session="sess-1",
    )


def test_talk_and_delegation_descriptions_forbid_approval_bypass():
    talk_doc = mcp_server.dina_talk.description or ""
    delegate_doc = mcp_server.dina_delegate.description or ""
    status_doc = mcp_server.dina_action_status.description or ""
    assert "idempotency" in talk_doc.lower()
    assert "do not bypass" in talk_doc.lower()
    assert "owner approves" in delegate_doc.lower()


def test_peerlens_tools_preserve_search_and_approval_contract(fake_client):
    fake_client.search_peerlens.return_value = {"results": []}
    fake_client.publish_review.return_value = {
        "status": "pending_approval",
        "request_id": "review-1",
    }
    fake_client.review_status.return_value = {
        "publish_status": "published",
        "uri": "at://review/1",
    }

    searched = mcp_server.dina_peerlens.fn(
        session="sess-1",
        query="chair",
        category="furniture",
        tags=["ergonomic"],
        limit=5,
    )
    submitted = mcp_server.dina_review.fn(
        record={
            "subject": {"type": "product", "identifier": "chair-123"},
            "category": "furniture",
            "sentiment": "positive",
        },
        session="sess-1",
        request_id="review-1",
    )
    status = mcp_server.dina_review_status.fn(
        request_id="review-1",
        session="sess-1",
    )

    assert searched == {"results": []}
    assert submitted["status"] == "pending_approval"
    assert status["publish_status"] == "published"
    fake_client.search_peerlens.assert_called_once_with(
        session="sess-1",
        query="chair",
        category="furniture",
        domain="",
        subject_type="",
        sentiment="",
        min_confidence="",
        author_did="",
        tags=["ergonomic"],
        sort="relevant",
        limit=5,
    )
    fake_client.publish_review.assert_called_once_with(
        record={
            "subject": {"type": "product", "identifier": "chair-123"},
            "category": "furniture",
            "sentiment": "positive",
        },
        session="sess-1",
        request_id="review-1",
    )
    fake_client.review_status.assert_called_once_with(
        request_id="review-1",
        session="sess-1",
    )


def test_review_tool_description_forbids_duplicate_publish():
    submit_doc = mcp_server.dina_review.description or ""
    status_doc = mcp_server.dina_review_status.description or ""
    assert "pending_approval" in submit_doc
    assert "do not publish" in submit_doc.lower()
    assert "idempotency" in submit_doc.lower()
    assert "must not create another review" in status_doc.lower()
    assert "pending means wait" in status_doc.lower()
    assert "cancelled" in status_doc.lower()


def test_vault_and_reminder_tools_use_narrow_session_projections(fake_client):
    fake_client.list_vaults.return_value = {
        "vaults": [{"name": "general", "readable": True}],
    }
    fake_client.list_reminders.return_value = {
        "reminders": [],
        "restricted_count": 1,
    }

    vaults = mcp_server.dina_vaults.fn(session="sess-1")
    reminders = mcp_server.dina_reminders.fn(session="sess-1", limit=25)

    assert vaults["vaults"][0]["readable"] is True
    assert reminders["restricted_count"] == 1
    fake_client.list_vaults.assert_called_once_with(session="sess-1")
    fake_client.list_reminders.assert_called_once_with(
        session="sess-1",
        limit=25,
    )


def test_vault_and_reminder_descriptions_forbid_raw_or_restricted_reads():
    vault_doc = mcp_server.dina_vaults.description or ""
    reminder_doc = mcp_server.dina_reminders.description or ""
    assert "without reading their contents" in vault_doc.lower()
    assert "storage directly" in vault_doc.lower()
    assert "cannot select or bypass a restricted vault" in reminder_doc.lower()


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


def test_coding_profile_removes_runner_and_reasoning_tools(monkeypatch):
    removed = []
    monkeypatch.setattr(mcp_server.mcp, "remove_tool", removed.append)

    mcp_server.configure_profile("coding")

    assert removed == [
        "dina_task_complete",
        "dina_task_fail",
        "dina_task_progress",
        "dina_context_prepare",
        "dina_memory_propose",
        "dina_reasoning_status",
        "dina_reasoning_begin",
        "dina_reasoning_claim",
        "dina_reasoning_heartbeat",
        "dina_reasoning_complete",
        "dina_reasoning_fail",
    ]


def test_connected_profile_keeps_reasoning_but_removes_runner_tools(monkeypatch):
    removed = []
    monkeypatch.setattr(mcp_server.mcp, "remove_tool", removed.append)

    mcp_server.configure_profile("connected")

    assert removed == [
        "dina_task_complete",
        "dina_task_fail",
        "dina_task_progress",
    ]


def test_reasoning_mcp_tools_forward_only_claim_contract_fields(fake_client):
    fake_client.context_prepare.return_value = {"status": "complete", "items": []}
    fake_client.memory_propose.return_value = {"status": "stored"}
    fake_client.reasoning_begin.return_value = {"submission": {}, "claim": None}
    fake_client.reasoning_complete.return_value = {"accepted": True}

    context = mcp_server.dina_context_prepare.fn(
        session="sess-1",
        query="What should I buy?",
        purpose="Recommend",
        personas=["health"],
        limit=5,
    )
    memory = mcp_server.dina_memory_propose.fn(
        session="sess-1",
        request_id="memory-request-1",
        source_text="I have back pain.",
        proposal={
            "persona": "health",
            "subject": {"kind": "health", "label": "Back pain"},
            "facts": [{"text": "I have back pain.", "confidence": 1}],
            "reminderCandidates": [],
        },
    )
    begun = mcp_server.dina_reasoning_begin.fn(
        backend_id="backend-1",
        session="sess-1",
        task_kind="answer.compose",
        input={"prompt": "Question"},
        purpose="Answer",
        idempotency_key="turn-1",
    )
    completed = mcp_server.dina_reasoning_complete.fn(
        task_id="task-1",
        backend_id="backend-1",
        session="sess-1",
        claim_id="claim-1",
        context_ticket_id="ticket-1",
        execution_id="exec-1",
        policy_snapshot_hash="a" * 64,
        context_projection_hash=None,
        result={"answer": "Result"},
        evidence_ids=["review-1"],
    )

    assert context == {"status": "complete", "items": []}
    assert memory == {"status": "stored"}
    assert begun["claim"] is None
    assert completed == {"accepted": True}
    fake_client.context_prepare.assert_called_once_with(
        session="sess-1",
        query="What should I buy?",
        purpose="Recommend",
        personas=["health"],
        limit=5,
    )
    fake_client.memory_propose.assert_called_once_with(
        session="sess-1",
        request_id="memory-request-1",
        source_text="I have back pain.",
        proposal={
            "persona": "health",
            "subject": {"kind": "health", "label": "Back pain"},
            "facts": [{"text": "I have back pain.", "confidence": 1}],
            "reminderCandidates": [],
        },
    )
    fake_client.reasoning_begin.assert_called_once_with(
        backend_id="backend-1",
        session="sess-1",
        task_kind="answer.compose",
        input_data={"prompt": "Question"},
        purpose="Answer",
        idempotency_key="turn-1",
    )
    fake_client.reasoning_complete.assert_called_once_with(
        task_id="task-1",
        backend_id="backend-1",
        session="sess-1",
        claim_id="claim-1",
        context_ticket_id="ticket-1",
        execution_id="exec-1",
        policy_snapshot_hash="a" * 64,
        context_projection_hash=None,
        result={"answer": "Result"},
        evidence_ids=["review-1"],
    )


def test_reasoning_tool_docs_preserve_worker_security_contract():
    context = mcp_server.dina_context_prepare.description or ""
    memory = mcp_server.dina_memory_propose.description or ""
    begin = mcp_server.dina_reasoning_begin.description or ""
    complete = mcp_server.dina_reasoning_complete.description or ""
    heartbeat = mcp_server.dina_reasoning_heartbeat.description or ""
    normalized_context = " ".join(context.split())

    assert "not a Core-validated Dina result" in normalized_context
    assert "Core validates" in memory
    assert "changed replays" in memory
    assert "Do not perform external effects" in begin
    assert "resultSchema" in begin
    assert "allowedEvidenceIds" in complete
    assert "does not prove any later external effect" in complete
    assert "stale-claim" in heartbeat
