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
    mock_id.sign_request.return_value = (
        "did:key:z6MkTest",
        "2026-01-01T00:00:00Z",
        "cc" * 16,
        "aabb" * 32,
    )
    mock_id.did.return_value = "did:key:z6MkTest"
    with patch("dina_cli.client.CLIIdentity", return_value=mock_id):
        yield mock_id


def _tr(status: int, body: str = "", headers: dict | None = None) -> TransportResponse:
    """Build a TransportResponse for mock returns."""
    return TransportResponse(status=status, headers=headers or {}, body=body)


def _patch_transport(*return_values, side_effect=None):
    """Patch DirectTransport.request — one call or a sequence."""
    if side_effect is not None:
        return patch(
            "dina_cli.transport.DirectTransport.request", side_effect=side_effect
        )
    if len(return_values) == 1:
        return patch(
            "dina_cli.transport.DirectTransport.request", return_value=return_values[0]
        )
    return patch(
        "dina_cli.transport.DirectTransport.request", side_effect=list(return_values)
    )


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
        assert (
            mock_identity.sign_request.call_args.kwargs["query"] == "persona=personal"
        )
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
        assert (
            mock_identity.sign_request.call_args.kwargs["query"]
            == "persona=health%20notes"
        )
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


def test_agent_service_discovery_uses_narrow_session_bound_facade(config):
    with _patch_transport(
        _tr(200, '{"matches":[],"capability_candidates":[]}')
    ) as request:
        client = DinaClient(replace(config, role="agent"))
        result = client.find_services(
            session="sess-1",
            intent="book a haircut",
            limit=5,
        )

        assert result["matches"] == []
        call = request.call_args
        assert call.args[1] == "/v1/agent/service/search"
        assert json.loads(call.kwargs["body"]) == {
            "session_id": "sess-1",
            "limit": 5,
            "intent": "book a haircut",
        }
        client.close()


def test_agent_service_publish_uses_owner_approved_facade(config):
    with _patch_transport(
        _tr(
            202,
            '{"status":"pending_approval","task_id":"approval-1",'
            '"request_id":"publish-1"}',
        )
    ) as request:
        client = DinaClient(replace(config, role="agent"))
        result = client.publish_service(
            rkey="salon/main",
            config={"name": "Salon"},
            session="sess-1",
            request_id="publish-1",
        )

        assert request.call_args.args[1] == "/v1/agent/service/publish"
        assert json.loads(request.call_args.kwargs["body"]) == {
            "session_id": "sess-1",
            "request_id": "publish-1",
            "rkey": "salon/main",
            "config": {"name": "Salon"},
        }
        assert result == {
            "status": "pending_approval",
            "task_id": "approval-1",
            "request_id": "publish-1",
        }
        client.close()


def test_agent_service_publish_reports_missing_pds_identity(config):
    with _patch_transport(
        _tr(202, '{"status":"pending_approval","task_id":"approval-1"}'),
        _tr(
            200,
            '{"rkey":"salon","publication_status":"not_configured",'
            '"stored_status":"pending","can_publish":false,'
            '"last_error":"PDS identity is not configured"}',
        ),
    ):
        client = DinaClient(replace(config, role="agent"))
        result = client.publish_service(
            rkey="salon",
            config={"name": "Salon"},
            session="sess-1",
            request_id="publish-2",
        )
        assert result["status"] == "pending_approval"
        publication = client.service_publication_status(
            rkey="salon",
            session="sess-1",
        )
        assert publication["publication_status"] == "not_configured"
        assert publication["stored_status"] == "pending"
        assert publication["can_publish"] is False
        client.close()


def test_agent_service_invoke_and_status_bind_the_session(config):
    responses = [
        _tr(202, '{"status":"pending_approval","task_id":"approval-1"}'),
        _tr(
            200,
            '{"status":"completed","service_task_id":"sq-1","query_id":"q-1"}',
        ),
        _tr(200, '{"task_id":"sq-1","status":"running"}'),
    ]
    with _patch_transport(*responses) as request:
        client = DinaClient(replace(config, role="agent"))
        client.send_service_query(
            to_did="did:plc:salon",
            capability="appointment_book",
            params={"date": "2026-07-26"},
            session="sess-1",
            request_id="invoke-1",
            service_uri=(
                "at://did:plc:salon/com.dinakernel.service.profile/main"
            ),
        )
        client.action_status(
            action="service_invoke",
            request_id="invoke-1",
            session="sess-1",
        )
        client.service_query_status(task_id="sq-1", session="sess-1")

        invoke = request.call_args_list[0]
        assert invoke.args[1] == "/v1/agent/service/invoke"
        assert json.loads(invoke.kwargs["body"])["request_id"] == "invoke-1"
        action = request.call_args_list[1]
        assert action.args[1] == "/v1/agent/action/status"
        status = request.call_args_list[2]
        assert status.args[1] == "/v1/agent/service/status"
        assert json.loads(status.kwargs["body"]) == {
            "session_id": "sess-1",
            "task_id": "sq-1",
        }
        client.close()


def test_agent_service_publication_status_uses_narrow_facade(config):
    with _patch_transport(
        _tr(200, '{"rkey":"salon","publication_status":"published"}')
    ) as request:
        client = DinaClient(replace(config, role="agent"))
        result = client.service_publication_status(
            rkey="salon",
            session="sess-1",
        )
        assert result["publication_status"] == "published"
        assert request.call_args.args[1] == (
            "/v1/agent/service/publication-status"
        )
        assert json.loads(request.call_args.kwargs["body"]) == {
            "session_id": "sess-1",
            "rkey": "salon",
        }
        client.close()


def test_agent_service_methods_fail_before_transport_without_session(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="service discovery requires a session"):
        client.find_services(session="", intent="salon")
    with pytest.raises(ValueError, match="service publication requires a session"):
        client.publish_service(
            rkey="main", config={}, session="", request_id="publish-1"
        )
    with pytest.raises(ValueError, match="stable request_id"):
        client.publish_service(rkey="main", config={}, session="sess-1")
    with pytest.raises(ValueError, match="service query requires a session"):
        client.send_service_query(
            to_did="did:plc:salon",
            capability="appointment_book",
            params={},
        )
    with pytest.raises(ValueError, match="stable request_id"):
        client.send_service_query(
            to_did="did:plc:salon",
            capability="appointment_book",
            params={},
            session="sess-1",
        )
    with pytest.raises(ValueError, match="service status requires a session"):
        client.service_query_status(task_id="sq-1", session="")
    with pytest.raises(
        ValueError, match="service publication status requires a session"
    ):
        client.service_publication_status(rkey="main", session="")
    client.close()


def test_talk_delegate_and_action_status_bind_exact_session_and_request(config):
    responses = [
        _tr(202, '{"status":"pending_approval","request_id":"talk-1"}'),
        _tr(202, '{"status":"pending_approval","request_id":"delegate-1"}'),
        _tr(200, '{"status":"completed","delivery_status":"delivered"}'),
    ]
    with _patch_transport(*responses) as request:
        client = DinaClient(replace(config, role="agent"))
        client.talk(
            contact="Alonso",
            text="Can we meet tomorrow?",
            session="sess-1",
            request_id="talk-1",
            in_reply_to="msg-previous",
        )
        client.delegate(
            runner="codex",
            description="Compare the two proposals",
            input_data={"paths": ["a.md", "b.md"]},
            session="sess-1",
            request_id="delegate-1",
        )
        result = client.action_status(
            action="talk",
            request_id="talk-1",
            session="sess-1",
        )

        assert result["delivery_status"] == "delivered"
        talk_request, delegate_request, status_request = request.call_args_list
        assert talk_request.args[1] == "/v1/agent/talk"
        assert json.loads(talk_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "request_id": "talk-1",
            "contact": "Alonso",
            "text": "Can we meet tomorrow?",
            "in_reply_to": "msg-previous",
        }
        assert delegate_request.args[1] == "/v1/agent/delegate"
        assert json.loads(delegate_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "request_id": "delegate-1",
            "runner": "codex",
            "description": "Compare the two proposals",
            "input": {"paths": ["a.md", "b.md"]},
        }
        assert status_request.args[1] == "/v1/agent/action/status"
        assert json.loads(status_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "action": "talk",
            "request_id": "talk-1",
        }
        client.close()


def test_talk_and_delegate_require_stable_request_and_session(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="live Dina session"):
        client.talk(
            contact="Alonso",
            text="Hello",
            session="",
            request_id="talk-1",
        )
    with pytest.raises(ValueError, match="stable request_id"):
        client.delegate(
            runner="codex",
            description="Check docs",
            input_data={},
            session="sess-1",
            request_id="",
        )
    with pytest.raises(ValueError, match="action must be"):
        client.action_status(
            action="other",
            request_id="req-1",
            session="sess-1",
        )


def test_peerlens_search_review_and_status_use_narrow_facades(config):
    responses = [
        _tr(200, '{"results":[],"total_estimate":0}'),
        _tr(202, '{"status":"pending_approval","request_id":"review-1"}'),
        _tr(200, '{"publish_status":"published","uri":"at://review/1"}'),
    ]
    with _patch_transport(*responses) as request:
        client = DinaClient(replace(config, role="agent"))
        client.search_peerlens(
            session="sess-1",
            query="ergonomic chair",
            subject_type="product",
            sentiment="positive",
            tags=["back-support"],
            limit=5,
        )
        client.publish_review(
            record={
                "subject": {"type": "product", "identifier": "chair-123"},
                "category": "furniture",
                "sentiment": "positive",
                "text": "Supportive.",
            },
            session="sess-1",
            request_id="review-1",
        )
        status = client.review_status(request_id="review-1", session="sess-1")

        assert status["publish_status"] == "published"
        search_request, review_request, status_request = request.call_args_list
        assert search_request.args[1] == "/v1/agent/peerlens/search"
        assert json.loads(search_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "sort": "relevant",
            "limit": 5,
            "q": "ergonomic chair",
            "subject_type": "product",
            "sentiment": "positive",
            "tags": ["back-support"],
        }
        assert review_request.args[1] == "/v1/agent/peerlens/attest"
        assert json.loads(review_request.kwargs["body"])["request_id"] == "review-1"
        assert status_request.args[1] == "/v1/agent/peerlens/status"
        assert json.loads(status_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "request_id": "review-1",
        }
        client.close()


def test_peerlens_methods_require_session_and_stable_request(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="live Dina session"):
        client.search_peerlens(session="", query="chair")
    with pytest.raises(ValueError, match="stable request_id"):
        client.publish_review(record={}, session="sess-1", request_id="")
    with pytest.raises(ValueError, match="live Dina session"):
        client.review_status(request_id="review-1", session="")


def test_vaults_and_reminders_use_session_bound_facades(config):
    responses = [
        _tr(200, '{"vaults":[{"name":"general","readable":true}]}'),
        _tr(200, '{"reminders":[],"restricted_count":1}'),
    ]
    with _patch_transport(*responses) as request:
        client = DinaClient(replace(config, role="agent"))
        vaults = client.list_vaults(session="sess-1")
        reminders = client.list_reminders(session="sess-1", limit=25)

        assert vaults["vaults"][0]["name"] == "general"
        assert reminders["restricted_count"] == 1
        vault_request, reminder_request = request.call_args_list
        assert vault_request.args[1] == "/v1/agent/vaults"
        assert json.loads(vault_request.kwargs["body"]) == {
            "session_id": "sess-1",
        }
        assert reminder_request.args[1] == "/v1/agent/reminders"
        assert json.loads(reminder_request.kwargs["body"]) == {
            "session_id": "sess-1",
            "limit": 25,
        }
        client.close()


def test_vaults_and_reminders_require_session_and_bounded_limit(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="live Dina session"):
        client.list_vaults(session="")
    with pytest.raises(ValueError, match="live Dina session"):
        client.list_reminders(session="")
    with pytest.raises(ValueError, match="between 1 and 100"):
        client.list_reminders(session="sess-1", limit=101)
    client.close()
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
            source_id="remember-0001",
            persona="health",
        )

        assert result["status"] == "stored"
        assert mock_req.call_args.args[1] == "/v1/agent/memory"
        assert json.loads(mock_req.call_args.kwargs["body"]) == {
            "content": "Lower back pain",
            "session_id": "sess-1",
            "request_id": "remember-0001",
            "persona": "health",
        }
        client.close()


def test_agent_remember_requires_stable_request_id(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="stable source_id/request_id"):
        client.remember("Lower back pain", session="sess-1")
    client.close()


def test_agent_remember_status_uses_owned_facade(config):
    agent_config = replace(config, role="agent")
    with patch(
        "dina_cli.transport.DirectTransport.request",
        return_value=_tr(200, '{"status":"stored","id":"stg-1"}'),
    ) as mock_req:
        client = DinaClient(agent_config)
        result = client.remember_check("stg-1", session="sess-1")

        assert result["status"] == "stored"
        assert mock_req.call_args.args[1] == "/v1/agent/memory/status"
        assert json.loads(mock_req.call_args.kwargs["body"]) == {
            "item_id": "stg-1",
            "session_id": "sess-1",
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
            "approval_surface": "host",
            "host_session_id": "claude-abc",
            "cwd": "/work",
        }
        client.close()


def test_gate_rejects_ambiguous_session_inputs_before_transport(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="either session or host_session"):
        client.gate("Read", {}, session="sess-1", host_session="claude-abc")
    client.close()


def test_gate_rejects_caller_selected_mode(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="resolved by Dina Core"):
        client.gate("Read", {}, mode="classify_only", host_session="claude-abc")
    client.close()


def test_reasoning_backend_wire_contracts(config):
    responses = [
        _tr(200, '{"status":"complete","items":[]}'),
        _tr(200, '{"status":"stored","proposal_id":"stg-1"}'),
        _tr(200, '{"queued":1}'),
        _tr(200, '{"submission":{"taskId":"r-1"},"claim":null}'),
        _tr(200, '{"claim":{"taskId":"r-1"}}'),
        _tr(200, '{"ok":true}'),
        _tr(200, '{"accepted":true}'),
        _tr(200, '{"accepted":true,"terminal":false}'),
    ]
    with patch(
        "dina_cli.transport.DirectTransport.request",
        side_effect=responses,
    ) as mock_req:
        client = DinaClient(replace(config, role="agent"))
        client.context_prepare(
            session="sess-1",
            query="What chair fits me?",
            purpose="Recommend a chair",
            personas=["health", "financial"],
            limit=8,
        )
        client.memory_propose(
            session="sess-1",
            request_id="memory-request-1",
            source_text="I have back pain.",
            proposal={
                "persona": "health",
                "subject": {"kind": "health", "label": "Lower back pain"},
                "facts": [{"text": "I have back pain.", "confidence": 1}],
                "reminderCandidates": [],
            },
        )
        client.reasoning_status("backend-1", "sess-1")
        client.reasoning_begin(
            backend_id="backend-1",
            session="sess-1",
            task_kind="answer.compose",
            input_data={"prompt": "Question"},
            purpose="Answer the owner",
            idempotency_key="inline-1",
        )
        client.reasoning_claim(
            backend_id="backend-1",
            session="sess-1",
            lease_ms=60_000,
        )
        client.reasoning_heartbeat(
            task_id="r-1",
            backend_id="backend-1",
            session="sess-1",
            claim_id="claim-1",
            context_ticket_id="ticket-1",
            lease_ms=60_000,
        )
        client.reasoning_complete(
            task_id="r-1",
            backend_id="backend-1",
            session="sess-1",
            claim_id="claim-1",
            context_ticket_id="ticket-1",
            execution_id="exec-1",
            policy_snapshot_hash="a" * 64,
            context_projection_hash=None,
            result={"answer": "Result"},
            evidence_ids=[],
        )
        client.reasoning_fail(
            task_id="r-1",
            backend_id="backend-1",
            session="sess-1",
            claim_id="claim-1",
            context_ticket_id="ticket-1",
            error="temporary model failure",
            retryable=True,
        )

        calls = mock_req.call_args_list
        assert calls[0].args[0:2] == (
            "POST",
            "/v1/agent/context/prepare",
        )
        assert json.loads(calls[0].kwargs["body"]) == {
            "session_id": "sess-1",
            "query": "What chair fits me?",
            "purpose": "Recommend a chair",
            "personas": ["health", "financial"],
            "limit": 8,
        }
        assert calls[1].args[0:2] == (
            "POST",
            "/v1/agent/memory/propose",
        )
        assert json.loads(calls[1].kwargs["body"])["request_id"] == "memory-request-1"
        assert calls[2].args[0:2] == (
            "GET",
            "/v1/reasoning/status?backend_id=backend-1&session_id=sess-1",
        )
        assert json.loads(calls[3].kwargs["body"]) == {
            "backend_id": "backend-1",
            "session_id": "sess-1",
            "task_kind": "answer.compose",
            "input": {"prompt": "Question"},
            "purpose": "Answer the owner",
            "idempotency_key": "inline-1",
        }
        assert calls[4].args[1] == "/v1/reasoning/claim"
        assert json.loads(calls[5].kwargs["body"])["claim_id"] == "claim-1"
        completion = json.loads(calls[6].kwargs["body"])
        assert completion["context_projection_hash"] is None
        assert completion["evidence_ids"] == []
        failure = json.loads(calls[7].kwargs["body"])
        assert failure["retryable"] is True
        client.close()


def test_reasoning_claim_rejects_invalid_lease_locally(config):
    client = DinaClient(replace(config, role="agent"))
    with pytest.raises(ValueError, match="lease_ms"):
        client.reasoning_claim(
            backend_id="backend-1",
            session="sess-1",
            lease_ms=999,
        )
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
