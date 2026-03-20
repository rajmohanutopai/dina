"""Tests for the OpenClaw Gateway WebSocket RPC client.

Tests validate the official Gateway framing:
- Requests: {type: "req", id, method, params}
- Responses: {type: "res", id, ok: bool, payload: {...}}
- Events: {type: "event", event: "name", payload: {...}}
- Connect: minProtocol, maxProtocol, auth{token}, client{name,version},
  scopes[], device{id,name,type,publicKey,signature,signedAt,nonce}
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from dina_cli.openclaw import OpenClawClient, OpenClawError


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
    return {"type": "event", "event": "connect.challenge", "payload": {"nonce": nonce}}


def _res(req_id, payload=None, ok=True):
    f: dict = {"type": "res", "id": req_id, "ok": ok}
    f["payload"] = payload if payload is not None else {}
    return f


def _res_err(req_id, error):
    return {"type": "res", "id": req_id, "ok": False, "payload": {"error": error}}


def _event(name, payload=None):
    return {"type": "event", "event": name, "payload": payload or {}}


class TestOpenClawClient:

    def test_ws_url_conversion(self):
        c = OpenClawClient("http://localhost:3000", token="t")
        assert c._ws_url() == "ws://localhost:3000/ws"
        c2 = OpenClawClient("https://gw.example.com", token="t")
        assert c2._ws_url() == "wss://gw.example.com/ws"

    def test_health_reachable(self):
        factory, mock = _mock_ws([
            _challenge(),
            _res("1"),
            _res("2", {"status": "ok"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = OpenClawClient("http://localhost:3000", token="test-token",
                               device_id="did:key:z6MkTest")
            assert c.health() is True

        # Verify full connect contract
        connect = mock.sent[0]["params"]
        assert connect["minProtocol"] == 1
        assert connect["maxProtocol"] >= 1
        assert connect["auth"]["token"] == "test-token"
        assert connect["client"]["name"] == "dina-cli"
        assert connect["scopes"] == ["agent", "tools"]
        assert connect["device"]["id"] == "did:key:z6MkTest"
        assert connect["device"]["type"] == "cli"

    def test_health_not_ok(self):
        factory, _ = _mock_ws([_challenge(), _res("1"), _res("2", {"status": "degraded"})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = OpenClawClient("http://localhost:3000", token="t")
            assert c.health() is False

    def test_health_unreachable(self):
        with patch("dina_cli.openclaw.ws_connect", side_effect=OSError("refused")):
            c = OpenClawClient("http://localhost:3000", token="t")
            assert c.health() is False

    def test_connect_with_challenge_signing(self):
        """When sign_fn is provided, device block includes signed identity."""
        signed_bytes = b"\x01\x02\x03"
        factory, mock = _mock_ws([
            _challenge(nonce="challenge-nonce-xyz"),
            _res("1"),
            _res("2", {"status": "ok"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = OpenClawClient(
                "http://localhost:3000",
                token="t",
                device_id="did:key:z6MkSigner",
                sign_fn=lambda data: signed_bytes,
            )
            c.health()

        device = mock.sent[0]["params"]["device"]
        assert device["publicKey"] == "did:key:z6MkSigner"
        assert device["signature"] == "010203"
        assert device["nonce"] == "challenge-nonce-xyz"
        assert "signedAt" in device

    def test_connect_without_signing(self):
        """Without sign_fn, device block has no signature fields."""
        factory, mock = _mock_ws([_challenge(), _res("1"), _res("2", {"status": "ok"})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = OpenClawClient("http://localhost:3000", token="t", device_id="dev-1")
            c.health()

        device = mock.sent[0]["params"]["device"]
        assert device["id"] == "dev-1"
        assert "signature" not in device
        assert "publicKey" not in device

    def test_run_task_full_protocol(self):
        factory, mock = _mock_ws([
            _challenge(),
            _res("1"),
            _res("2", {"runId": "run-123"}),
            _event("agent.progress", {"progress": 0.5}),
            _res("3", {"chairs": ["ErgoMax"]}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            c = OpenClawClient("http://localhost:3000", token="t", device_id="did:key:z6Mk1")
            result = c.run_task("Research chairs", dina_session="task-abc")

        assert result == {"chairs": ["ErgoMax"]}
        assert all(f["type"] == "req" for f in mock.sent)

        # agent request
        assert mock.sent[1]["method"] == "agent"
        assert mock.sent[1]["params"]["task"] == "Research chairs"
        assert mock.sent[1]["params"]["context"]["dina_session"] == "task-abc"

        # agent.wait
        assert mock.sent[2]["method"] == "agent.wait"
        assert mock.sent[2]["params"]["runId"] == "run-123"

    def test_run_task_terminal_event(self):
        factory, _ = _mock_ws([
            _challenge(), _res("1"), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "completed", "result": {"ok": True}}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            result = OpenClawClient("http://localhost:3000", token="t").run_task("test")
        assert result == {"ok": True}

    def test_run_task_agent_failed(self):
        factory, _ = _mock_ws([
            _challenge(), _res("1"), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "failed", "error": "LLM quota exceeded"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="failed.*LLM quota"):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")

    def test_run_task_cancelled(self):
        factory, _ = _mock_ws([
            _challenge(), _res("1"), _res("2", {"runId": "r"}),
            _event("agent.status", {"status": "cancelled", "reason": "user"}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="cancelled"):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")

    def test_run_task_connection_refused(self):
        with patch("dina_cli.openclaw.ws_connect", side_effect=OSError("refused")):
            with pytest.raises(OpenClawError, match="unreachable"):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")

    def test_run_task_timeout(self):
        factory, _ = _mock_ws([_challenge(), _res("1"), _res("2", {"runId": "r"})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="timed out"):
                OpenClawClient("http://localhost:3000", token="t", timeout=1).run_task("test")

    def test_run_task_idempotency_key(self):
        factory, mock = _mock_ws([
            _challenge(), _res("1"), _res("2", {"runId": "r"}), _res("3", {}),
        ])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            OpenClawClient("http://localhost:3000", token="t").run_task("test", idempotency_key="k1")
        assert mock.sent[1]["params"]["idempotencyKey"] == "k1"

    def test_run_task_bad_challenge(self):
        factory, _ = _mock_ws([_event("error", {"message": "unauthorized"})])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="connect.challenge"):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")

    def test_run_task_rpc_error(self):
        factory, _ = _mock_ws([_challenge(), _res("1"), _res_err("2", "rate limited")])
        with patch("dina_cli.openclaw.ws_connect", side_effect=factory):
            with pytest.raises(OpenClawError, match="rate limited"):
                OpenClawClient("http://localhost:3000", token="t").run_task("test")
