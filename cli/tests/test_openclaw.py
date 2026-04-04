"""Tests for the OpenClaw Gateway WebSocket RPC client (v3 protocol).

Tests validate the current Gateway handshake:
- Protocol version 3
- Role: operator, scopes: ["operator.admin"]
- Device auth: id (fingerprint), publicKey (base64url), signature (v3 payload), signedAt (ms), nonce
- Client block: id, displayName, version, platform, deviceFamily, mode
- Device token persistence from hello-ok.auth.deviceToken
- Retry with cached device token on AUTH_TOKEN_MISMATCH
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from dina_cli.openclaw import (
    OpenClawClient,
    OpenClawError,
    OpenClawRPCError,
    _build_device_auth_payload_v3,
    _CLIENT_ID,
    _CLIENT_MODE,
    _DEVICE_FAMILY,
    _PLATFORM,
    _PROTOCOL_VERSION,
    _ROLE,
    _SCOPES,
)


class _MockWebSocket:
    def __init__(self, recv_frames: list[dict]):
        self._recv_frames = [json.dumps(f) for f in recv_frames]
        self._recv_idx = 0
        self.sent: list[dict] = []

    def recv(self, timeout=None):
        if self._recv_idx >= len(self._recv_frames):
            raise TimeoutError("no more frames")
        frame = self._recv_frames[self._recv_idx]
        self._recv_idx += 1
        return frame

    def send(self, data):
        self.sent.append(json.loads(data))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def _mock_ws(recv_frames):
    mock = _MockWebSocket(recv_frames)
    return (lambda url, **kw: mock), mock


def _challenge(nonce="test-nonce-abc"):
    return {"type": "event", "event": "connect.challenge", "payload": {"nonce": nonce, "ts": 1737264000000}}


def _hello_ok(device_token=""):
    payload = {"type": "hello-ok", "protocol": 3, "server": {"version": "2026.4.2"}}
    if device_token:
        payload["auth"] = {"deviceToken": device_token}
    return {"type": "res", "id": "1", "ok": True, "payload": payload}


def _res(req_id, payload=None, ok=True):
    f: dict = {"type": "res", "id": req_id, "ok": ok}
    f["payload"] = payload if payload is not None else {}
    return f


def _res_rpc_err(req_id, message, code="", details=None):
    err: dict = {"code": code, "message": message}
    if details:
        err["details"] = details
    return {"type": "res", "id": req_id, "ok": False, "error": err}


def _event(name, payload=None):
    return {"type": "event", "event": name, "payload": payload or {}}


def _make_client(**overrides):
    """Build an OpenClawClient with device identity (required for v3)."""
    defaults = {
        "base_url": "http://localhost:3000",
        "token": "test-token",
        "device_id": "dev-fingerprint-1",
        "device_public_key": "public-key-base64url",
        "device_name": "test-device",
        "sign_fn": lambda data: b"\x01\x02\x03",
    }
    defaults.update(overrides)
    return OpenClawClient(**defaults)


class TestOpenClawClient:

    # TRACE: {"suite": "CLI", "case": "0015", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "01", "title": "ws_url_conversion"}
    def test_ws_url_conversion(self):
        c = OpenClawClient("http://localhost:3000", token="t")
        assert c._ws_url() == "ws://localhost:3000/ws"
        c2 = OpenClawClient("https://gw.example.com", token="t")
        assert c2._ws_url() == "wss://gw.example.com/ws"

    # TRACE: {"suite": "CLI", "case": "0016", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "02", "title": "health_reachable_signed_connect"}
    def test_health_reachable_signed_connect(self):
        factory, mock = _mock_ws([
            _challenge(),
            _hello_ok(),
            _res("2", {"ok": True}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = _make_client()
            assert c.health() is True

        # Verify v3 connect contract
        connect = mock.sent[0]["params"]
        assert connect["minProtocol"] == _PROTOCOL_VERSION
        assert connect["maxProtocol"] == _PROTOCOL_VERSION
        assert connect["auth"]["token"] == "test-token"
        assert connect["role"] == _ROLE
        assert connect["scopes"] == _SCOPES
        # Client block
        client = connect["client"]
        assert client["id"] == _CLIENT_ID
        assert client["mode"] == _CLIENT_MODE
        assert client["platform"] == _PLATFORM
        assert client["deviceFamily"] == _DEVICE_FAMILY
        assert "displayName" in client
        assert "version" in client
        # Device block
        device = connect["device"]
        assert device["id"] == "dev-fingerprint-1"
        assert device["publicKey"] == "public-key-base64url"
        assert device["nonce"] == "test-nonce-abc"
        assert isinstance(device["signedAt"], int)
        assert device["signature"]  # non-empty

    # TRACE: {"suite": "CLI", "case": "0017", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "03", "title": "connect_builds_v3_signature_payload"}
    def test_connect_builds_v3_signature_payload(self):
        """Verify the exact v3 signature payload format."""
        captured_data = []

        def capture_sign(data: bytes) -> bytes:
            captured_data.append(data)
            return b"\xaa\xbb\xcc"

        factory, mock = _mock_ws([_challenge(nonce="nonce-xyz"), _hello_ok(), _res("2", {"ok": True})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = _make_client(sign_fn=capture_sign)
            c.health()

        assert len(captured_data) == 1
        payload_str = captured_data[0].decode()
        parts = payload_str.split("|")
        assert parts[0] == "v3"
        assert parts[1] == "dev-fingerprint-1"  # device_id
        assert parts[2] == _CLIENT_ID
        assert parts[3] == _CLIENT_MODE
        assert parts[4] == _ROLE
        assert parts[5] == ",".join(_SCOPES)
        # parts[6] = signedAtMs (integer string)
        assert parts[6].isdigit()
        assert parts[7] == "test-token"  # token used for signature
        assert parts[8] == "nonce-xyz"
        assert parts[9] == _PLATFORM.lower()
        assert parts[10] == _DEVICE_FAMILY.lower()

    # TRACE: {"suite": "CLI", "case": "0018", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "04", "title": "connect_persists_device_token_from_hello_ok"}
    def test_connect_persists_device_token_from_hello_ok(self):
        saved_tokens = []
        factory, _ = _mock_ws([
            _challenge(),
            _hello_ok(device_token="dt-persisted-123"),
            _res("2", {"ok": True}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = _make_client(save_device_token=lambda t: saved_tokens.append(t))
            c.health()

        assert saved_tokens == ["dt-persisted-123"]
        assert c._device_token == "dt-persisted-123"

    # TRACE: {"suite": "CLI", "case": "0019", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "05", "title": "connect_retries_with_cached_device_token"}
    def test_connect_retries_with_cached_device_token(self):
        """On AUTH_TOKEN_MISMATCH from trusted local endpoint, retry once with cached device token."""
        call_count = [0]

        def multi_ws(url, **kw):
            call_count[0] += 1
            if call_count[0] == 1:
                # First attempt: shared token → mismatch
                return _MockWebSocket([
                    _challenge(),
                    _res_rpc_err("1", "token mismatch", "INVALID_REQUEST",
                                 {"code": "AUTH_TOKEN_MISMATCH", "canRetryWithDeviceToken": True}),
                ])
            else:
                # Retry with device token → success
                # IDs continue from client's counter: connect=2, agent=3, wait=4
                return _MockWebSocket([
                    _challenge(),
                    {"type": "res", "id": "2", "ok": True, "payload": {"type": "hello-ok", "protocol": 3}},
                    _res("3", {"runId": "r"}),
                    _res("4", {"result": "ok"}),
                ])

        with patch("dina_cli.openclaw.ws_connect", side_effect=multi_ws):
            c = _make_client(device_token="cached-dt-456")
            result = c.run_task("test retry")

        assert call_count[0] == 2
        assert result == {"result": "ok"}

    # TRACE: {"suite": "CLI", "case": "0020", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "06", "title": "health_unreachable"}
    def test_health_unreachable(self):
        with patch("dina_cli.openclaw.ws_connect", side_effect=OSError("refused")):
            c = _make_client()
            assert c.health() is False

    # TRACE: {"suite": "CLI", "case": "0021", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "07", "title": "run_task_full_protocol"}
    def test_run_task_full_protocol(self):
        factory, mock = _mock_ws([
            _challenge(),
            _hello_ok(),
            _res("2", {"runId": "run-123"}),
            _event("agent.progress", {"progress": 0.5}),
            _res("3", {"chairs": ["ErgoMax"]}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = _make_client()
            result = c.run_task("Research chairs", dina_session="task-abc")

        assert result == {"chairs": ["ErgoMax"]}
        assert mock.sent[1]["method"] == "agent"
        assert mock.sent[1]["params"]["message"] == "Research chairs"
        assert mock.sent[2]["method"] == "agent.wait"
        assert mock.sent[2]["params"]["runId"] == "run-123"

    # TRACE: {"suite": "CLI", "case": "0022", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "08", "title": "run_task_terminal_completed"}
    def test_run_task_terminal_completed(self):
        factory, _ = _mock_ws([
            _challenge(), _hello_ok(), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "completed", "result": {"ok": True}}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            result = _make_client().run_task("test")
        assert result == {"ok": True}

    # TRACE: {"suite": "CLI", "case": "0023", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "09", "title": "run_task_terminal_failed"}
    def test_run_task_terminal_failed(self):
        factory, _ = _mock_ws([
            _challenge(), _hello_ok(), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "failed", "error": "LLM quota exceeded"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="failed.*LLM quota"):
                _make_client().run_task("test")

    # TRACE: {"suite": "CLI", "case": "0024", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "10", "title": "run_task_terminal_cancelled"}
    def test_run_task_terminal_cancelled(self):
        factory, _ = _mock_ws([
            _challenge(), _hello_ok(), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "cancelled", "reason": "user"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="cancelled"):
                _make_client().run_task("test")

    # TRACE: {"suite": "CLI", "case": "0025", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "11", "title": "run_task_requires_device_identity"}
    def test_run_task_requires_device_identity(self):
        """run_task raises if device identity is missing."""
        factory, _ = _mock_ws([
            _challenge(),
            _res_rpc_err("1", "device identity required", "INVALID_REQUEST",
                         {"code": "DEVICE_AUTH_DEVICE_ID_MISMATCH"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")

    # TRACE: {"suite": "CLI", "case": "0026", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "12", "title": "run_task_message_in_agent_params"}
    def test_run_task_message_in_agent_params(self):
        """Agent RPC sends message field (gateway v3 schema)."""
        factory, mock = _mock_ws([
            _challenge(), _hello_ok(), _res("2", {"runId": "r"}), _res("3", {}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            _make_client().run_task("Find best standing desk")
        assert mock.sent[1]["params"]["message"] == "Find best standing desk"

    # TRACE: {"suite": "CLI", "case": "0027", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "13", "title": "run_task_pairing_required_actionable"}
    def test_run_task_pairing_required_actionable(self):
        """PAIRING_REQUIRED error produces an actionable message."""
        factory, _ = _mock_ws([
            _challenge(),
            _res_rpc_err("1", "device not approved", "INVALID_REQUEST",
                         {"code": "PAIRING_REQUIRED"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="pairing"):
                _make_client().run_task("test")

    # TRACE: {"suite": "CLI", "case": "0028", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "14", "title": "run_task_connection_refused"}
    def test_run_task_connection_refused(self):
        with patch("dina_cli.openclaw.ws_connect", side_effect=OSError("refused")):
            with pytest.raises(OpenClawError, match="unreachable"):
                _make_client().run_task("test")

    # TRACE: {"suite": "CLI", "case": "0029", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "15", "title": "run_task_bad_challenge"}
    def test_run_task_bad_challenge(self):
        factory, _ = _mock_ws([_event("error", {"message": "unauthorized"})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="connect.challenge"):
                _make_client().run_task("test")

    # TRACE: {"suite": "CLI", "case": "0030", "section": "04", "sectionName": "OpenClaw", "subsection": "02", "scenario": "16", "title": "connect_uses_cached_device_token_when_no_shared_token"}
    def test_connect_uses_cached_device_token_when_no_shared_token(self):
        factory, mock = _mock_ws([
            _challenge(),
            _hello_ok(),
            _res("2", {"ok": True}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = _make_client(token="", device_token="dt-only-token")
            c.health()

        auth = mock.sent[0]["params"]["auth"]
        assert auth.get("deviceToken") == "dt-only-token"
