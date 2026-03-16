"""Tests for the DinaClient HTTP layer."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from dina_cli.client import DinaClient, DinaClientError
from dina_cli.config import Config


@pytest.fixture()
def config():
    return Config(
        core_url="http://localhost:8100",
        timeout=5.0,
        device_name="test-device",
    )


@pytest.fixture(autouse=True)
def mock_identity():
    """Mock CLIIdentity so DinaClient doesn't need real keypair on disk."""
    mock_id = MagicMock()
    mock_id.sign_request.return_value = ("did:key:z6MkTest", "2026-01-01T00:00:00Z", "aabb" * 32)
    mock_id.did.return_value = "did:key:z6MkTest"
    with patch("dina_cli.client.CLIIdentity", return_value=mock_id):
        yield mock_id


# TST-CLI-015
def test_vault_store(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"item_id": "abc123"}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        result = client.vault_store("personal", {"type": "note", "summary": "test"})
        assert result["item_id"] == "abc123"
        client.close()


# TST-CLI-016
def test_vault_query(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"items": [{"ID": "1", "Summary": "test"}]}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        items = client.vault_query("personal", "test")
        assert len(items) == 1
        assert items[0]["Summary"] == "test"
        client.close()


# TST-CLI-017
def test_kv_get_found(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.text = "hello"
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        assert client.kv_get("mykey") == "hello"
        client.close()


# TST-CLI-018
def test_kv_get_not_found(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.text = "not found"
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "404", request=MagicMock(), response=mock_resp,
    )

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        assert client.kv_get("missing") is None
        client.close()


# TST-CLI-019
def test_connection_error(config):
    with patch.object(httpx.Client, "request", side_effect=httpx.ConnectError("fail")):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Cannot reach Dina"):
            client.vault_query("personal", "test")
        client.close()


# TST-CLI-020
def test_auth_error(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.text = "unauthorized"
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "401", request=MagicMock(), response=mock_resp,
    )

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Authentication failed"):
            client.vault_query("personal", "test")
        client.close()


# TST-CLI-021
def test_process_event_via_core(config):
    """process_event routes through Core (not Brain), so no brain_token needed."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"status": "approved"}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        result = client.process_event({"type": "agent_intent"})
        assert result["status"] == "approved"
        client.close()


# TST-CLI-022
def test_context_manager(config):
    with patch.object(httpx.Client, "request") as mock_req:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "ok"}
        mock_resp.raise_for_status = MagicMock()
        mock_req.return_value = mock_resp

        with DinaClient(config) as client:
            result = client.did_get()
            assert result["status"] == "ok"


# ── Signature auth tests ─────────────────────────────────────────────────


# TST-CLI-023
def test_signing_headers_set(config, mock_identity):
    """Requests carry X-DID, X-Timestamp, X-Signature headers."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"items": []}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp) as mock_req:
        client = DinaClient(config)
        client.vault_query("personal", "test")

        call_kwargs = mock_req.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers", {})
        assert "X-DID" in headers
        assert "X-Timestamp" in headers
        assert "X-Signature" in headers
        # No Bearer token on Core client.
        assert "Authorization" not in (client._core.headers or {})
        client.close()


# TST-CLI-024
def test_no_bearer_on_core(config):
    """Core client should NOT have an Authorization header."""
    client = DinaClient(config)
    assert "authorization" not in {k.lower() for k in client._core.headers}
    client.close()


# TST-CLI-025
def test_extract_body_json():
    """_extract_body serializes json= kwarg with compact separators."""
    kwargs = {"json": {"key": "value", "num": 42}}
    body = DinaClient._extract_body(kwargs)
    assert body == b'{"key":"value","num":42}'
    assert "json" not in kwargs
    assert kwargs["content"] == body
    assert kwargs["headers"]["Content-Type"] == "application/json"


# TST-CLI-026
def test_extract_body_content_string():
    kwargs = {"content": "hello"}
    body = DinaClient._extract_body(kwargs)
    assert body == b"hello"


# TST-CLI-027
def test_extract_body_empty():
    kwargs = {}
    body = DinaClient._extract_body(kwargs)
    assert body == b""
