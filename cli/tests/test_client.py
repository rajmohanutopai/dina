"""Tests for the DinaClient HTTP layer."""

from __future__ import annotations

import json
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
def test_vault_store(config):
    with _patch_transport(_tr(200, json.dumps({"item_id": "abc123"}))):
        client = DinaClient(config)
        result = client.vault_store("personal", {"type": "note", "summary": "test"})
        assert result["item_id"] == "abc123"
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
