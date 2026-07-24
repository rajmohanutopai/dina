"""Tests for the DinaClient HTTP layer."""

from __future__ import annotations

import json
from dataclasses import replace
from unittest.mock import MagicMock, patch

import httpx
import pytest

from dina_cli.client import DinaClient, DinaClientError
from dina_cli.config import Config
from dina_cli.transport import TransportError, TransportResponse


@pytest.fixture()
def config():
    return Config(
        core_url="http://localhost:8100",
        timeout=5.0,
        device_name="test-device",
        transport_mode="direct",  # skip the auto-select healthz probe in unit tests
    )


@pytest.fixture(autouse=True)
def mock_identity():
    """Mock CLIIdentity so DinaClient doesn't need real keypair on disk."""
    mock_id = MagicMock()
    mock_id.sign_request.return_value = ("did:key:z6MkTest", "2026-01-01T00:00:00Z", "cc" * 16, "aabb" * 32)
    mock_id.did.return_value = "did:key:z6MkTest"
    with patch("dina_cli.client.CLIIdentity", return_value=mock_id):
        yield mock_id


def _tr(status: int, body: str = "", headers: dict | None = None) -> TransportResponse:
    """Build a TransportResponse for mock returns."""
    return TransportResponse(status=status, headers=headers or {}, body=body)


def _patch_transport(*return_values, side_effect=None):
    """Patch DirectTransport.request — one call or a sequence."""
    if side_effect is not None:
        return patch("dina_cli.transport.DirectTransport.request", side_effect=side_effect)
    if len(return_values) == 1:
        return patch("dina_cli.transport.DirectTransport.request", return_value=return_values[0])
    return patch("dina_cli.transport.DirectTransport.request", side_effect=list(return_values))


# TST-CLI-015
# TRACE: {"suite": "CLI", "case": "0015", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "01", "title": "vault_store"}
def test_vault_store(config, mock_identity):
    with _patch_transport(_tr(200, json.dumps({"item_id": "abc123"}))) as request:
        client = DinaClient(config)
        item = {"type": "note", "summary": "test"}
        result = client.vault_store("personal", item)
        assert result["item_id"] == "abc123"
        call = request.call_args
        assert call.args[1] == "/v1/vault/store?persona=personal"
        assert json.loads(call.kwargs["body"]) == item
        assert mock_identity.sign_request.call_args.kwargs["query"] == "persona=personal"
        client.close()


# TST-CLI-016
# TRACE: {"suite": "CLI", "case": "0016", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "02", "title": "vault_query"}
def test_vault_query(config):
    body = json.dumps({"items": [{"ID": "1", "Summary": "test"}]})
    with _patch_transport(_tr(200, body)):
        client = DinaClient(config)
        items = client.vault_query("personal", "test")
        assert len(items) == 1
        assert items[0]["Summary"] == "test"
        client.close()


def test_agent_vault_query_binds_session_in_signed_body(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"items":[]}'),
    ) as mock_req:
        client = DinaClient(replace(config, role="agent"))
        client.vault_query("health", "lab results", session="sess-1")

        call = mock_req.call_args
        assert call.args[1] == "/v1/vault/query?persona=health"
        assert json.loads(call.kwargs["body"])["session_id"] == "sess-1"
        assert "X-Session" not in call.args[2]
        client.close()


def test_agent_vault_query_requires_session(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="requires a session"):
        client.vault_query("health", "lab results")
    client.close()


def test_query_signing_matches_core_percent_encoding(config, mock_identity):
    with _patch_transport(_tr(200, '{"items":[]}')):
        client = DinaClient(config)
        client.vault_query("health notes", "test")
        assert mock_identity.sign_request.call_args.kwargs["query"] == "persona=health%20notes"
        client.close()


# TST-CLI-017
# TRACE: {"suite": "CLI", "case": "0017", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "03", "title": "kv_get_found"}
def test_kv_get_found(config):
    with _patch_transport(_tr(200, "hello")):
        client = DinaClient(config)
        assert client.kv_get("mykey") == "hello"
        client.close()


# TST-CLI-018
# TRACE: {"suite": "CLI", "case": "0018", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "04", "title": "kv_get_not_found"}
def test_kv_get_not_found(config):
    with _patch_transport(_tr(404, '{"error":"not found"}')):
        client = DinaClient(config)
        assert client.kv_get("missing") is None
        client.close()


# TST-CLI-019
# TRACE: {"suite": "CLI", "case": "0019", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "05", "title": "connection_error"}
def test_connection_error(config):
    with _patch_transport(side_effect=TransportError("fail")):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Cannot reach Dina"):
            client.vault_query("personal", "test")
        client.close()


# TST-CLI-020
# TRACE: {"suite": "CLI", "case": "0020", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "06", "title": "auth_error"}
def test_auth_error(config):
    with _patch_transport(_tr(401, '{"error":"unauthorized"}')):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Authentication failed"):
            client.vault_query("personal", "test")
        client.close()


# TST-CLI-021
# TRACE: {"suite": "CLI", "case": "0021", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "07", "title": "process_event_via_core"}
def test_process_event_via_core(config):
    """process_event routes through Core (not Brain), so no brain_token needed."""
    with _patch_transport(_tr(200, json.dumps({"status": "approved"}))):
        client = DinaClient(config)
        result = client.process_event({"type": "agent_intent"})
        assert result["status"] == "approved"
        client.close()


def test_agent_validation_and_status_bind_session_in_signed_inputs(config):
    agent_config = replace(config, role="agent")
    responses = [
        _tr(200, '{"requires_approval":true,"proposal_id":"prop-1"}'),
        _tr(200, '{"status":"pending"}'),
    ]
    with patch(
        "dina_cli.transport.DirectTransport.request",
        side_effect=responses,
    ) as mock_req:
        client = DinaClient(agent_config)
        client.process_event(
            {"type": "agent_intent", "action": "send_email"},
            session="sess-1",
        )
        client.get_proposal_status("prop-1", session="sess-1")

        submit = mock_req.call_args_list[0]
        assert json.loads(submit.kwargs["body"])["session_id"] == "sess-1"
        assert "X-Session" not in submit.args[2]
        status = mock_req.call_args_list[1]
        assert status.args[1] == "/v1/intent/proposals/prop-1/status?session_id=sess-1"
        assert "X-Session" not in status.args[2]
        client.close()


def test_agent_validation_requires_session_before_transport(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="requires a session"):
        client.process_event({"type": "agent_intent", "action": "send_email"})
    with pytest.raises(ValueError, match="requires a session"):
        client.get_proposal_status("prop-1")
    client.close()


def test_agent_pii_scrub_uses_narrow_coding_facade(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"scrubbed":"[EMAIL_1]","entities":[]}'),
    ) as mock_req:
        client = DinaClient(replace(config, role="agent"))
        client.pii_scrub("raj@example.com")

        assert mock_req.call_args.args[1] == "/v1/agent/scrub"
        client.close()


def test_non_agent_pii_scrub_keeps_internal_route(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"scrubbed":"[EMAIL_1]","entities":[]}'),
    ) as mock_req:
        client = DinaClient(config)
        client.pii_scrub("raj@example.com")

        assert mock_req.call_args.args[1] == "/v1/pii/scrub"
        client.close()


# TST-CLI-022
# TRACE: {"suite": "CLI", "case": "0022", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "08", "title": "context_manager"}
def test_context_manager(config):
    with _patch_transport(_tr(200, json.dumps({"status": "ok"}))):
        with DinaClient(config) as client:
            result = client.did_get()
            assert result["status"] == "ok"


# ── Signature auth tests ─────────────────────────────────────────────────


# TST-CLI-023
# TRACE: {"suite": "CLI", "case": "0023", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "09", "title": "signing_headers_set"}
def test_signing_headers_set(config, mock_identity):
    """Requests carry X-DID, X-Timestamp, X-Signature headers."""
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, json.dumps({"items": []})),
    ) as mock_req:
        client = DinaClient(config)
        client.vault_query("personal", "test")

        # Transport.request(method, path, headers, body=, request_id=)
        headers = mock_req.call_args.args[2]
        assert "X-DID" in headers
        assert "X-Timestamp" in headers
        assert "X-Signature" in headers
        # No Authorization header — Core uses signature, not bearer.
        assert "Authorization" not in headers
        client.close()


# TST-CLI-024
# TRACE: {"suite": "CLI", "case": "0024", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "10", "title": "no_bearer_on_core"}
def test_no_bearer_on_core(config):
    """DinaClient never attaches an Authorization header to signed requests."""
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, "{}"),
    ) as mock_req:
        client = DinaClient(config)
        client.did_get()
        headers = mock_req.call_args.args[2]
        assert "authorization" not in {k.lower() for k in headers}
        client.close()


# TST-CLI-025
# TRACE: {"suite": "CLI", "case": "0025", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "11", "title": "extract_body_json"}
def test_extract_body_json():
    """_extract_body serializes json= kwarg with compact separators."""
    kwargs = {"json": {"key": "value", "num": 42}}
    body = DinaClient._extract_body(kwargs)
    assert body == b'{"key":"value","num":42}'
    assert "json" not in kwargs
    assert kwargs["content"] == body
    assert kwargs["headers"]["Content-Type"] == "application/json"


# TST-CLI-026
# TRACE: {"suite": "CLI", "case": "0026", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "12", "title": "extract_body_content_string"}
def test_extract_body_content_string():
    kwargs = {"content": "hello"}
    body = DinaClient._extract_body(kwargs)
    assert body == b"hello"


# TST-CLI-027
# TRACE: {"suite": "CLI", "case": "0027", "section": "02", "sectionName": "Client", "subsection": "01", "scenario": "13", "title": "extract_body_empty"}
def test_extract_body_empty():
    kwargs = {}
    body = DinaClient._extract_body(kwargs)
    assert body == b""


def test_agent_remember_uses_session_bound_facade(config):
    agent_config = replace(config, role="agent")
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"status":"stored","persona":"health"}'),
    ) as mock_req:
        client = DinaClient(agent_config)
        result = client.remember(
            "Lower back pain",
            session="sess-1",
            persona="health",
        )

        assert result["status"] == "stored"
        assert mock_req.call_args.args[1] == "/v1/agent/memory"
        assert json.loads(mock_req.call_args.kwargs["body"]) == {
            "content": "Lower back pain",
            "session_id": "sess-1",
            "persona": "health",
        }
        client.close()


def test_user_remember_retains_legacy_staging_route(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"status":"stored"}'),
    ) as mock_req:
        client = DinaClient(config)
        client.remember("Buy milk", session="sess-1", source_id="src-1")

        assert mock_req.call_args.args[1] == "/api/v1/remember"
        assert json.loads(mock_req.call_args.kwargs["body"])["source_id"] == "src-1"
        client.close()


def test_session_wire_contracts(config):
    responses = [
        _tr(200, '{"session_id":"sess-1","status":"open"}'),
        _tr(200, '{"sessions":[]}'),
        _tr(200, '{"ok":true}'),
    ]
    with patch(
        "dina_cli.transport.DirectTransport.request",
        side_effect=responses,
    ) as mock_req:
        client = DinaClient(config)
        client.session_start("host-task")
        client.session_list()
        client.session_end("sess-1")

        calls = mock_req.call_args_list
        assert calls[0].args[1] == "/v1/session/start"
        assert json.loads(calls[0].kwargs["body"]) == {"host_session_id": "host-task"}
        assert calls[1].args[0:2] == ("GET", "/v1/sessions")
        assert calls[2].args[1] == "/v1/session/end"
        assert json.loads(calls[2].kwargs["body"]) == {"session_id": "sess-1"}
        client.close()


def test_gate_can_bind_the_signed_host_session_without_an_extra_start_call(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"outcome":"allow"}'),
    ) as mock_req:
        client = DinaClient(replace(config, role="agent"))
        client.gate(
            "Read",
            {"file_path": "notes.txt"},
            host_session="claude-abc",
            cwd="/work",
        )

        assert mock_req.call_args.args[1] == "/v1/agent/gate"
        assert json.loads(mock_req.call_args.kwargs["body"]) == {
            "tool_name": "Read",
            "tool_input": {"file_path": "notes.txt"},
            "mode": "enforce",
            "host_session_id": "claude-abc",
            "cwd": "/work",
        }
        client.close()


def test_gate_rejects_ambiguous_session_inputs_before_transport(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="either session or host_session"):
        client.gate("Read", {}, session="sess-1", host_session="claude-abc")
    client.close()


def test_agent_ask_and_status_bind_the_session_in_signed_inputs(config):
    agent_config = replace(config, role="agent")
    responses = [
        _tr(202, '{"status":"in_flight","request_id":"ask-1"}'),
        _tr(200, '{"status":"complete","content":"answer"}'),
    ]
    with patch(
        "dina_cli.transport.DirectTransport.request",
        side_effect=responses,
    ) as mock_req:
        client = DinaClient(agent_config)
        client.ask("What do I prefer?", session="sess-1")
        client.ask_status("ask-1", session="sess-1")

        submit, status = mock_req.call_args_list
        assert submit.args[1] == "/api/v1/ask"
        assert json.loads(submit.kwargs["body"]) == {
            "prompt": "What do I prefer?",
            "session_id": "sess-1",
        }
        assert "X-Session" not in submit.args[2]
        assert status.args[1] == "/api/v1/ask/ask-1/status?session_id=sess-1"
        client.close()


def test_user_ask_retains_legacy_session_header(config):
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"status":"complete"}'),
    ) as mock_req:
        client = DinaClient(config)
        client.ask("Question", session="sess-user")

        assert json.loads(mock_req.call_args.kwargs["body"]) == {"prompt": "Question"}
        assert mock_req.call_args.args[2]["X-Session"] == "sess-user"
        client.close()
