"""Tests for CLI transport selection (TST-MBX-0061 through TST-MBX-0065)
and full MsgBox pairing (TST-MBX-0045).

# TRACE metadata embedded in test docstrings.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from dina_cli.transport import (
    DirectTransport,
    MsgBoxTransport,
    TransportError,
    select_transport,
)


# --- Test helpers ---

class HealthHandler(BaseHTTPRequestHandler):
    """Minimal HTTP server that returns 200 on /healthz."""

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress logs


def start_health_server():
    """Start a local HTTP server and return (url, shutdown_fn)."""
    server = HTTPServer(("127.0.0.1", 0), HealthHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{port}", server.shutdown


# --- TST-MBX-0061: transport=auto, Core reachable → DirectTransport ---
# TRACE: {"suite": "MBX", "case": "0061", "section": "06", "sectionName": "Operational & Load", "subsection": "05", "scenario": "01", "title": "transport_auto_direct"}
def test_transport_auto_core_reachable():
    """auto mode: Core reachable directly → uses DirectTransport."""
    url, shutdown = start_health_server()
    try:
        transport = select_transport(
            mode="auto",
            core_url=url,
            msgbox_url="wss://msgbox.example.com",
            homenode_did="did:plc:test",
        )
        assert isinstance(transport, DirectTransport)
    finally:
        shutdown()


# --- TST-MBX-0062: transport=auto, Core unreachable, MsgBox up → MsgBoxTransport ---
# TRACE: {"suite": "MBX", "case": "0062", "section": "06", "sectionName": "Operational & Load", "subsection": "05", "scenario": "02", "title": "transport_auto_fallback_msgbox"}
def test_transport_auto_fallback_msgbox():
    """auto mode: Core unreachable, MsgBox configured → falls back to MsgBoxTransport."""
    transport = select_transport(
        mode="auto",
        core_url="http://127.0.0.1:1",  # unreachable port
        msgbox_url="wss://msgbox.example.com",
        homenode_did="did:plc:test",
    )
    assert isinstance(transport, MsgBoxTransport)


# --- TST-MBX-0063: transport=auto, both unreachable → error ---
# TRACE: {"suite": "MBX", "case": "0063", "section": "06", "sectionName": "Operational & Load", "subsection": "05", "scenario": "03", "title": "transport_auto_both_unreachable"}
def test_transport_auto_both_unreachable():
    """auto mode: both unreachable → clear error."""
    with pytest.raises(TransportError, match="Home Node unreachable"):
        select_transport(
            mode="auto",
            core_url="http://127.0.0.1:1",  # unreachable
            msgbox_url=None,  # no MsgBox configured
            homenode_did=None,
        )


# --- TST-MBX-0064: transport=msgbox, MsgBox down → fail-closed ---
# TRACE: {"suite": "MBX", "case": "0064", "section": "06", "sectionName": "Operational & Load", "subsection": "05", "scenario": "04", "title": "transport_msgbox_fail_closed"}
def test_transport_msgbox_fail_closed():
    """msgbox mode: fail-closed — no fallback to direct even if Core is reachable."""
    # select_transport returns MsgBoxTransport (not DirectTransport).
    transport = select_transport(
        mode="msgbox",
        core_url="http://127.0.0.1:18100",  # Core reachable, but ignored
        msgbox_url="wss://msgbox.example.com",
        homenode_did="did:plc:test",
    )
    assert isinstance(transport, MsgBoxTransport)
    assert not isinstance(transport, DirectTransport)

    # Calling request() must fail with TransportError (MsgBox unreachable) —
    # it must NOT silently fall back to DirectTransport.
    with pytest.raises(TransportError, match="MsgBox unreachable"):
        transport.request("GET", "/healthz", {})


# --- TST-MBX-0065: transport=direct, never contacts MsgBox ---
# TRACE: {"suite": "MBX", "case": "0065", "section": "06", "sectionName": "Operational & Load", "subsection": "05", "scenario": "05", "title": "transport_direct_no_msgbox"}
def test_transport_direct_no_msgbox():
    """direct mode: never contacts MsgBox, even if configured."""
    transport = select_transport(
        mode="direct",
        core_url="http://127.0.0.1:18100",
        msgbox_url="wss://msgbox.example.com",  # configured but ignored
        homenode_did="did:plc:test",
    )
    assert isinstance(transport, DirectTransport)


# --- TST-MBX-0045: Pairing transport selection + interface contract ---
# TRACE: {"suite": "MBX", "case": "0045", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "01", "title": "pairing_transport_contract"}
def test_pairing_transport_contract():
    """Pairing transport contract: select_transport("msgbox") returns
    MsgBoxTransport with correct interface. MsgBoxTransport.request()
    raises NotImplementedError until MBX-040 (WebSocket relay) is built.

    NOTE: This is NOT an end-to-end pairing test. Full pairing through
    MsgBox (device registration + CLI config) requires MsgBox + Core
    containers and is an integration test (tests/e2e/test_msgbox_e2e.py).
    """
    transport = select_transport(
        mode="msgbox",
        core_url=None,  # no direct access — forces MsgBox path
        msgbox_url="wss://msgbox.dinakernel.com",
        homenode_did="did:plc:abc123",
    )
    assert isinstance(transport, MsgBoxTransport)
    assert hasattr(transport, "request")

    # MsgBoxTransport.request() now attempts a real WebSocket connection.
    # With no MsgBox server running, it raises TransportError (unreachable).
    with pytest.raises(TransportError, match="MsgBox unreachable"):
        transport.request("POST", "/v1/pair/complete", {}, body='{"code":"123456"}')


# --- TST-MBX-0034: Cancel envelope sent on timeout ---
# TRACE: {"suite": "MBX", "case": "0034", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "03", "scenario": "01", "title": "cli_cancel_on_timeout"}
def test_cancel_sent_on_timeout():
    """MBX-044: CLI sends cancel envelope when request times out."""
    from unittest.mock import MagicMock, patch
    from dina_cli.transport import MsgBoxTransport

    # Create a transport with mocked internals.
    transport = MsgBoxTransport.__new__(MsgBoxTransport)
    transport._msgbox_url = "wss://test"
    transport._homenode_did = "did:plc:test"
    transport._timeout = 0.2  # short timeout
    transport._pending = {}
    transport._homenode_x25519_pub = None  # skip encryption
    transport._cli_x25519_priv = None
    transport._cli_x25519_pub = None

    # Mock identity for signing.
    mock_identity = MagicMock()
    mock_identity.sign_request.return_value = ("did:key:zTest", "2026-01-01T00:00:00Z", "aa" * 16, "bb" * 64)
    mock_identity.did.return_value = "did:key:zTest"
    mock_identity._raw_public_key.return_value = b"\x00" * 32
    mock_identity.ensure_loaded.return_value = None
    transport._identity = mock_identity

    # Track what ws.send receives.
    sent_frames = []
    mock_ws = MagicMock()
    mock_ws.recv.side_effect = Exception("timeout")  # never returns data
    mock_ws.send.side_effect = lambda data: sent_frames.append(
        data if isinstance(data, bytes) else data.encode() if isinstance(data, str) else data
    )
    mock_ws.socket = MagicMock()
    mock_ws.close = MagicMock()

    # Patch _connect_and_auth to return our mock.
    with patch.object(transport, "_connect_and_auth", return_value=mock_ws):
        with patch.object(transport, "_drain_buffered"):
            with patch.object(transport, "_encrypt", side_effect=lambda x: x):
                with pytest.raises(TransportError, match="Home Node did not respond"):
                    transport.request("GET", "/api/v1/status", {})

    # Verify cancel envelope was sent.
    assert len(sent_frames) >= 2, f"expected ≥2 frames (envelope + cancel), got {len(sent_frames)}"
    cancel_frame = json.loads(sent_frames[-1])
    assert cancel_frame["type"] == "cancel"
    assert cancel_frame["from_did"] == "did:key:zTest"
    assert cancel_frame["to_did"] == "did:plc:test"
    assert "cancel_of" in cancel_frame


# --- ws.send wraps connection loss into TransportError ---
def test_send_wraps_connection_loss():
    """ws.send failure produces a clean TransportError, not raw websocket error."""
    from unittest.mock import MagicMock, patch
    from dina_cli.transport import MsgBoxTransport

    transport = MsgBoxTransport.__new__(MsgBoxTransport)
    transport._msgbox_url = "wss://test"
    transport._homenode_did = "did:plc:test"
    transport._timeout = 1.0
    transport._pending = {}
    transport._homenode_x25519_pub = None
    transport._cli_x25519_priv = None
    transport._cli_x25519_pub = None

    mock_identity = MagicMock()
    mock_identity.sign_request.return_value = ("did:key:zTest", "2026-01-01T00:00:00Z", "aa" * 16, "bb" * 64)
    mock_identity.did.return_value = "did:key:zTest"
    mock_identity.ensure_loaded.return_value = None
    transport._identity = mock_identity

    mock_ws = MagicMock()
    mock_ws.send.side_effect = ConnectionError("connection closed by server")
    mock_ws.close = MagicMock()

    with patch.object(transport, "_connect_and_auth", return_value=mock_ws):
        with patch.object(transport, "_drain_buffered"):
            with patch.object(transport, "_encrypt", side_effect=lambda x: x):
                with pytest.raises(TransportError, match="MsgBox connection lost"):
                    transport.request("GET", "/api/v1/status", {})
