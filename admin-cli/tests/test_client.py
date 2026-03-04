"""Tests for the AdminClient socket transport layer."""

from __future__ import annotations

import os
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import MagicMock, patch

import httpx
import pytest

from dina_admin_cli.client import AdminClient, AdminClientError
from dina_admin_cli.config import Config


@pytest.fixture()
def config(tmp_path):
    return Config(
        socket_path=str(tmp_path / "admin.sock"),
        timeout=5.0,
    )


def _mock_response(status=200, json_data=None, text="ok"):
    resp = MagicMock()
    resp.status_code = status
    resp.text = text
    resp.json.return_value = json_data or {}
    resp.raise_for_status = MagicMock()
    return resp


# ── Health ───────────────────────────────────────────────────────────────────


def test_healthz(config):
    resp = _mock_response(json_data={"status": "ok"})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.healthz()
        assert result["status"] == "ok"
        client.close()


def test_readyz(config):
    resp = _mock_response(json_data={"status": "ok"})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.readyz()
        assert result["status"] == "ok"
        client.close()


# ── Personas ─────────────────────────────────────────────────────────────────


def test_list_personas(config):
    resp = _mock_response(json_data=[{"id": "persona-personal", "name": "personal"}])
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.list_personas()
        assert len(result) == 1
        assert result[0]["name"] == "personal"
        client.close()


def test_create_persona(config):
    resp = _mock_response(json_data={"id": "persona-work", "status": "created"})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.create_persona("work", "open", "mypassphrase")
        assert result["status"] == "created"
        client.close()


def test_unlock_persona(config):
    resp = _mock_response(json_data={"status": "unlocked"})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.unlock_persona("personal", "mypassphrase")
        assert result["status"] == "unlocked"
        client.close()


# ── Devices ──────────────────────────────────────────────────────────────────


def test_list_devices(config):
    resp = _mock_response(json_data={"devices": [{"id": "d-1", "name": "laptop"}]})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.list_devices()
        assert len(result["devices"]) == 1
        client.close()


def test_initiate_pairing(config):
    resp = _mock_response(json_data={"code": "123456", "expires_in": 300})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.initiate_pairing()
        assert result["code"] == "123456"
        client.close()


def test_revoke_device(config):
    resp = _mock_response(status=204)
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        client.revoke_device("d-1")  # Should not raise
        client.close()


# ── Identity ─────────────────────────────────────────────────────────────────


def test_get_did(config):
    resp = _mock_response(json_data={"id": "did:key:z6Mk..."})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.get_did()
        assert result["id"].startswith("did:")
        client.close()


def test_sign_data(config):
    resp = _mock_response(json_data={"signature": "aabb" * 32})
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        result = client.sign_data("hello")
        assert "signature" in result
        client.close()


# ── Error handling ───────────────────────────────────────────────────────────


def test_connect_error(config):
    with patch.object(httpx.Client, "request", side_effect=httpx.ConnectError("fail")):
        client = AdminClient(config)
        with pytest.raises(AdminClientError, match="Cannot connect to socket"):
            client.healthz()
        client.close()


def test_socket_error_file_not_found(config):
    """Socket transport raises AdminClientError with helpful message for missing socket."""
    client = AdminClient.__new__(AdminClient)
    client._config = config
    client._http = MagicMock()
    client._http.request.side_effect = FileNotFoundError("No such file")
    with pytest.raises(AdminClientError, match="Socket not found"):
        client._request("GET", "/healthz")


def test_socket_error_permission_denied(config):
    """Socket transport raises AdminClientError for permission errors."""
    client = AdminClient.__new__(AdminClient)
    client._config = config
    client._http = MagicMock()
    client._http.request.side_effect = PermissionError("Permission denied")
    with pytest.raises(AdminClientError, match="Permission denied"):
        client._request("GET", "/healthz")


def test_socket_error_connection_refused(config):
    """Socket transport raises AdminClientError for refused connections."""
    client = AdminClient.__new__(AdminClient)
    client._config = config
    client._http = MagicMock()
    client._http.request.side_effect = ConnectionRefusedError("refused")
    with pytest.raises(AdminClientError, match="Core not listening"):
        client._request("GET", "/healthz")


def test_not_implemented_error(config):
    resp = MagicMock()
    resp.status_code = 501
    resp.text = "not implemented"
    resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "501", request=MagicMock(), response=resp,
    )
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        with pytest.raises(AdminClientError, match="Not implemented"):
            client.sign_data("test")
        client.close()


def test_server_error(config):
    resp = MagicMock()
    resp.status_code = 500
    resp.text = "internal server error"
    resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "500", request=MagicMock(), response=resp,
    )
    with patch.object(httpx.Client, "request", return_value=resp):
        client = AdminClient(config)
        with pytest.raises(AdminClientError, match="Server error"):
            client.healthz()
        client.close()


def test_timeout_error(config):
    """Timeout surfaces as AdminClientError, not raw httpx exception."""
    client = AdminClient.__new__(AdminClient)
    client._config = config
    client._http = MagicMock()
    client._http.request.side_effect = httpx.ReadTimeout("timed out")
    with pytest.raises(AdminClientError, match="timed out"):
        client._request("GET", "/healthz")


def test_generic_request_error(config):
    """Unexpected httpx.RequestError surfaces as AdminClientError."""
    client = AdminClient.__new__(AdminClient)
    client._config = config
    client._http = MagicMock()
    client._http.request.side_effect = httpx.RequestError("something broke")
    with pytest.raises(AdminClientError, match="Request failed"):
        client._request("GET", "/healthz")


# ── Context manager ──────────────────────────────────────────────────────────


def test_context_manager(config):
    resp = _mock_response(json_data={"status": "ok"})
    with patch.object(httpx.Client, "request", return_value=resp):
        with AdminClient(config) as client:
            result = client.healthz()
            assert result["status"] == "ok"


# ── No Authorization header ─────────────────────────────────────────────────


def test_no_bearer_header(config):
    """Socket-only client never sends Authorization header."""
    client = AdminClient(config)
    assert "authorization" not in client._http.headers
    client.close()


# ── Socket integration test ─────────────────────────────────────────────────


class _HealthHandler(BaseHTTPRequestHandler):
    """Minimal handler that returns JSON for /healthz and checks no Bearer header."""

    def do_GET(self):  # noqa: N802
        # Record whether an Authorization header was sent
        self.server.last_auth_header = self.headers.get("Authorization")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, format, *args):
        pass  # suppress logs


def test_socket_integration_no_bearer():
    """Integration: AdminClient connects over a real Unix socket and sends no Bearer token."""
    # Use /tmp for short path (macOS AF_UNIX 104-char limit)
    sock_path = tempfile.mktemp(prefix="dina-integ-", suffix=".sock", dir="/tmp")
    try:
        # Start a minimal HTTP server on a Unix socket
        server = HTTPServer(("", 0), _HealthHandler)
        server.socket.close()
        server.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.socket.bind(sock_path)
        server.socket.listen(1)
        server.last_auth_header = "UNSET"

        t = threading.Thread(target=server.handle_request, daemon=True)
        t.start()

        cfg = Config(socket_path=sock_path, timeout=5.0)
        with AdminClient(cfg) as client:
            result = client.healthz()
            assert result["status"] == "ok"

        t.join(timeout=5)
        # Verify no Bearer token was sent over the socket
        assert server.last_auth_header is None
        server.socket.close()
    finally:
        if os.path.exists(sock_path):
            os.unlink(sock_path)
