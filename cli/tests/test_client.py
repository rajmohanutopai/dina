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
