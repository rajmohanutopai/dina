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
        brain_url="http://localhost:8200",
        client_token="test-token",
        brain_token="test-brain-token",
        persona="personal",
        timeout=5.0,
    )


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


def test_kv_get_found(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.text = "hello"
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        assert client.kv_get("mykey") == "hello"
        client.close()


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


def test_connection_error(config):
    with patch.object(httpx.Client, "request", side_effect=httpx.ConnectError("fail")):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Cannot reach Dina"):
            client.vault_query("personal", "test")
        client.close()


def test_auth_error(config):
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.text = "unauthorized"
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "401", request=MagicMock(), response=mock_resp,
    )

    with patch.object(httpx.Client, "request", return_value=mock_resp):
        client = DinaClient(config)
        with pytest.raises(DinaClientError, match="Invalid token"):
            client.vault_query("personal", "test")
        client.close()


def test_process_event_no_brain():
    """Brain not configured raises clear error."""
    config = Config(
        core_url="http://localhost:8100",
        brain_url="http://localhost:8200",
        client_token="test-token",
        brain_token="",  # No brain token
        persona="personal",
        timeout=5.0,
    )
    client = DinaClient(config)
    with pytest.raises(DinaClientError, match="Brain not configured"):
        client.process_event({"type": "agent_intent"})
    client.close()


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


# ── Signature mode tests ─────────────────────────────────────────────────


def test_signature_mode_sets_headers(sig_config, tmp_path):
    """In signature mode, requests carry X-DID, X-Timestamp, X-Signature."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"items": []}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp) as mock_req, \
         patch("dina_cli.client.CLIIdentity") as MockIdentity:
        mock_id = MagicMock()
        mock_id.sign_request.return_value = ("did:key:z6MkTest", "2026-01-01T00:00:00Z", "abcd" * 32)
        MockIdentity.return_value = mock_id
        client = DinaClient(sig_config)
        client.vault_query("personal", "test")

        # Check the request was called with signing headers.
        call_kwargs = mock_req.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers", {})
        assert headers.get("X-DID") == "did:key:z6MkTest"
        assert headers.get("X-Timestamp") == "2026-01-01T00:00:00Z"
        assert headers.get("X-Signature") == "abcd" * 32
        # No Bearer token.
        assert "Authorization" not in (client._core.headers or {})
        client.close()


def test_signature_mode_no_bearer(sig_config):
    """Signature mode Core client should NOT have an Authorization header."""
    with patch("dina_cli.client.CLIIdentity") as MockIdentity:
        mock_id = MagicMock()
        MockIdentity.return_value = mock_id
        client = DinaClient(sig_config)
        assert "authorization" not in {k.lower() for k in client._core.headers}
        client.close()


def test_signature_mode_brain_still_bearer(sig_config):
    """Brain client always uses Bearer, even when Core uses signatures."""
    with patch("dina_cli.client.CLIIdentity") as MockIdentity:
        MockIdentity.return_value = MagicMock()
        client = DinaClient(sig_config)
        assert client._brain is not None
        auth = client._brain.headers.get("authorization", "")
        assert auth.startswith("Bearer ")
        client.close()


def test_token_mode_no_signing_headers(config):
    """In token mode, requests should NOT carry X-DID headers."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"items": []}
    mock_resp.raise_for_status = MagicMock()

    with patch.object(httpx.Client, "request", return_value=mock_resp) as mock_req:
        client = DinaClient(config)
        client.vault_query("personal", "test")

        call_kwargs = mock_req.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers", {})
        assert "X-DID" not in headers
        assert "X-Signature" not in headers
        client.close()


def test_extract_body_json():
    """_extract_body serializes json= kwarg with compact separators."""
    kwargs = {"json": {"key": "value", "num": 42}}
    body = DinaClient._extract_body(kwargs)
    assert body == b'{"key":"value","num":42}'
    assert "json" not in kwargs
    assert kwargs["content"] == body
    assert kwargs["headers"]["Content-Type"] == "application/json"


def test_extract_body_content_string():
    kwargs = {"content": "hello"}
    body = DinaClient._extract_body(kwargs)
    assert body == b"hello"


def test_extract_body_empty():
    kwargs = {}
    body = DinaClient._extract_body(kwargs)
    assert body == b""
