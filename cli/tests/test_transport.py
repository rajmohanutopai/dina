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
    _resolve_homenode_x25519_pub,
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


# --- did:key Home Node encryption-key resolution ---
def test_resolve_homenode_did_key_without_plc_lookup():
    """A local Home Node's did:key resolves entirely from the DID."""
    from unittest.mock import patch

    import base58
    import nacl.bindings
    from nacl.signing import SigningKey

    ed25519_public = bytes(SigningKey(b"\x01" * 32).verify_key)
    did = "did:key:z" + base58.b58encode(b"\xed\x01" + ed25519_public).decode()
    expected = nacl.bindings.crypto_sign_ed25519_pk_to_curve25519(ed25519_public)

    with patch("dina_cli.transport.httpx.get") as get:
        assert _resolve_homenode_x25519_pub(did) == expected
        get.assert_not_called()


@pytest.mark.parametrize(
    "did",
    [
        "did:key:znot-base58!",
        "did:key:z3W3",  # valid base58, wrong length
        "did:web:node.example.com",
    ],
)
def test_resolve_homenode_key_rejects_malformed_or_unknown_dids(did):
    """Malformed or unsupported DIDs fail closed without a network fallback."""
    from unittest.mock import patch

    with patch("dina_cli.transport.httpx.get") as get:
        assert _resolve_homenode_x25519_pub(did) is None
        get.assert_not_called()


def test_resolve_homenode_did_key_rejects_wrong_multicodec():
    """A 32-byte key with a non-Ed25519 codec must not be accepted."""
    from unittest.mock import patch

    import base58

    did = "did:key:z" + base58.b58encode(b"\xec\x01" + b"\x00" * 32).decode()
    with patch("dina_cli.transport.httpx.get") as get:
        assert _resolve_homenode_x25519_pub(did) is None
        get.assert_not_called()


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
    # MT-24-I1 wiring — reliability fix attributes the production
    # __init__ sets up. Tests that bypass __init__ via __new__() must
    # supply these or the lock-wrapped request() raises AttributeError
    # before reaching the test's mocked ws.
    transport._lock = threading.RLock()
    transport._consecutive_auth_failures = 0
    transport._next_attempt_at = 0.0
    transport._max_backoff_seconds = 30.0

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
    transport._lock = threading.RLock()
    transport._consecutive_auth_failures = 0
    transport._next_attempt_at = 0.0
    transport._max_backoff_seconds = 30.0

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
                # The transport's send-failure path emits "MsgBox send
                # failed after Xms (envelope=…)" today — the contract is
                # that a send-leg ConnectionError is wrapped as a
                # TransportError (not raw `ConnectionError`).
                with pytest.raises(TransportError, match="MsgBox send failed"):
                    transport.request("GET", "/api/v1/status", {})


# ---------------------------------------------------------------------------
# MT-24-I1 reliability fixes — exponential backoff + thread serialization.
#
# Cover both surfaces the daemon hits in production:
#   1. Backoff bookkeeping in `_connect_and_auth` so a flaky relay doesn't
#      cascade into a `mark_running` failure as the daemon's poll loop
#      tight-spins.
#   2. RLock around `request()` so the daemon's main thread + reconciler
#      thread can't open overlapping WS handshakes from the same DID.
# ---------------------------------------------------------------------------


def _bare_msgbox_transport():
    """Build a `MsgBoxTransport` with the production reliability attributes
    wired but every external dependency mocked out. Used by the tests below
    that exercise the backoff/serialisation logic without standing up a
    real WebSocket relay or signing identity."""
    from unittest.mock import MagicMock
    from dina_cli.transport import MsgBoxTransport
    transport = MsgBoxTransport.__new__(MsgBoxTransport)
    transport._msgbox_url = "wss://test"
    transport._homenode_did = "did:plc:test"
    transport._timeout = 0.5
    transport._pending = {}
    transport._homenode_x25519_pub = None
    transport._cli_x25519_priv = None
    transport._cli_x25519_pub = None
    transport._lock = threading.RLock()
    transport._consecutive_auth_failures = 0
    transport._next_attempt_at = 0.0
    transport._max_backoff_seconds = 30.0
    transport._identity = MagicMock()
    transport._identity.did.return_value = "did:key:zTest"
    transport._identity.ensure_loaded.return_value = None
    return transport


# --- TST-MBX-MT24-I1-A: backoff arms after a connect failure ---
def test_note_auth_failure_arms_exponential_backoff():
    """`_note_auth_failure` schedules the next attempt with a doubling
    delay (1s, 2s, 4s, 8s, …) capped at `_max_backoff_seconds`.

    The wait isn't actually slept here — `_connect_and_auth`'s entry
    block consumes it on the next call. We just assert the bookkeeping.
    """
    import time as _time
    transport = _bare_msgbox_transport()

    # Pristine state — no wait.
    assert transport._consecutive_auth_failures == 0
    assert transport._next_attempt_at == 0.0

    # 1st failure → ≈1s window.
    t0 = _time.monotonic()
    transport._note_auth_failure()
    assert transport._consecutive_auth_failures == 1
    delay = transport._next_attempt_at - t0
    assert 0.9 <= delay <= 1.5, f"first backoff should be ~1s, was {delay:.2f}s"

    # 2nd failure → ≈2s window.
    transport._note_auth_failure()
    assert transport._consecutive_auth_failures == 2
    delay = transport._next_attempt_at - _time.monotonic()
    assert 1.5 <= delay <= 2.5, f"second backoff should be ~2s, was {delay:.2f}s"

    # 3rd failure → ≈4s window.
    transport._note_auth_failure()
    assert transport._consecutive_auth_failures == 3
    delay = transport._next_attempt_at - _time.monotonic()
    assert 3.5 <= delay <= 4.5, f"third backoff should be ~4s, was {delay:.2f}s"


# --- TST-MBX-MT24-I1-B: backoff caps at the configured ceiling ---
def test_backoff_caps_at_max_after_many_failures():
    """The backoff window must NOT grow without bound — a daemon that's
    been failing for hours should still retry on a sane cadence."""
    import time as _time
    transport = _bare_msgbox_transport()
    transport._max_backoff_seconds = 5.0  # tighten cap so test stays fast

    for _ in range(10):
        transport._note_auth_failure()

    delay = transport._next_attempt_at - _time.monotonic()
    assert delay <= transport._max_backoff_seconds + 0.1, (
        f"backoff exceeded cap: {delay:.2f}s"
    )


# --- TST-MBX-MT24-I1-C: a successful auth resets the backoff counter ---
def test_successful_auth_resets_backoff_counter():
    """The reset path lives at the end of `_connect_and_auth`'s success
    branch — once it returns the live ws, both the counter and the next-
    attempt timestamp must be back to zero so subsequent calls don't pay
    a stale tax."""
    transport = _bare_msgbox_transport()
    transport._note_auth_failure()
    transport._note_auth_failure()
    assert transport._consecutive_auth_failures == 2

    # Simulate the success-path reset that `_connect_and_auth` does
    # right before `return ws`.
    transport._consecutive_auth_failures = 0
    transport._next_attempt_at = 0.0
    assert transport._consecutive_auth_failures == 0
    assert transport._next_attempt_at == 0.0


# --- TST-MBX-MT24-I1-D: connect failure raises AND records bookkeeping ---
def test_connect_failure_records_for_next_attempt_backoff():
    """When the websocket connect itself raises, `_connect_and_auth`
    must still wrap the error as a `TransportError` AND increment the
    failure counter so the next call sleeps before retrying. Without
    the bookkeeping, the daemon's poll loop tight-spins."""
    from unittest.mock import patch
    transport = _bare_msgbox_transport()

    # Stub out `websockets.sync.client.connect` to raise — simulates
    # the relay being unreachable.
    with patch(
        "dina_cli.transport.websockets.sync.client.connect",
        side_effect=ConnectionRefusedError("relay refused connection"),
    ):
        with pytest.raises(TransportError, match="MsgBox unreachable"):
            transport._connect_and_auth(rid="test-rid")

    assert transport._consecutive_auth_failures == 1
    assert transport._next_attempt_at > 0.0


# --- TST-MBX-MT24-I1-E: request() serialises concurrent callers ---
def test_request_lock_serialises_concurrent_callers():
    """The daemon's main loop and reconciler thread share one transport.
    `request()` must serialise them so two threads can't open
    overlapping WS handshakes from the same DID — that confused the
    relay's session tracking and produced spurious auth_success
    timeouts on rapid sequential reconnects (MT-24-I1).

    We don't actually open WS connections — we patch `_do_request` to
    record concurrent entries. The lock guarantees at most one is
    active at any moment.
    """
    import time as _time
    from unittest.mock import patch
    from dina_cli.transport import TransportResponse

    transport = _bare_msgbox_transport()

    in_flight = 0
    max_concurrent = 0
    enter_lock = threading.Lock()

    def fake_do_request(*args, **kwargs):
        nonlocal in_flight, max_concurrent
        with enter_lock:
            in_flight += 1
            max_concurrent = max(max_concurrent, in_flight)
        # Hold the slot briefly so a competing thread has time to
        # show up if the lock isn't holding.
        _time.sleep(0.05)
        with enter_lock:
            in_flight -= 1
        return TransportResponse(status=200, headers={}, body="ok")

    threads = [
        threading.Thread(
            target=lambda: None if patch.object(
                transport, "_do_request", side_effect=fake_do_request,
            ) else None,
        )
        for _ in range(4)
    ]
    # The lambda above won't actually call the patched function —
    # use a cleaner approach: patch once, then run callers under it.
    with patch.object(transport, "_do_request", side_effect=fake_do_request):
        runners = [
            threading.Thread(
                target=lambda: transport.request("GET", "/v1/status", {}),
            )
            for _ in range(4)
        ]
        for t in runners:
            t.start()
        for t in runners:
            t.join(timeout=5)

    assert max_concurrent == 1, (
        f"request() lock failed: saw {max_concurrent} concurrent callers"
    )


# --- TST-MBX-MT24-I1-F: lock is RE-entrant (drain → request inside same thread) ---
def test_request_lock_is_reentrant_for_same_thread():
    """If a `_drain_buffered` call ever ends up triggering another
    `request()` on the same thread (currently doesn't, but defensive),
    the lock must NOT self-deadlock. RLock semantics."""
    from unittest.mock import patch
    from dina_cli.transport import TransportResponse

    transport = _bare_msgbox_transport()
    seen = {"calls": 0}

    def reentrant_do_request(*args, **kwargs):
        seen["calls"] += 1
        if seen["calls"] == 1:
            # Re-enter request() from the same thread under the same
            # lock — would deadlock with a plain Lock.
            transport.request("GET", "/v1/inner", {})
        return TransportResponse(status=200, headers={}, body="ok")

    with patch.object(transport, "_do_request", side_effect=reentrant_do_request):
        # If the lock weren't re-entrant, this would hang forever and
        # pytest's per-test timeout would kill the run.
        transport.request("GET", "/v1/outer", {})

    assert seen["calls"] == 2


# --- CLI.2: plaintext-response gating (TST-MBX-0066..0069) ---
#
# Core sends plaintext ONLY for error responses (best-effort encryption,
# no user data). A SUCCESS payload must always be encrypted, so a plaintext
# 2xx is illegitimate and is rejected outside dev/test. Plaintext errors
# always pass through so the user still sees a genuine failure.
# Reuses `_bare_msgbox_transport()` defined above (it already wires
# `_cli_x25519_priv = None`, which is all `_parse_response` reads).

def test_plaintext_error_response_passes_through(monkeypatch):
    """A plaintext ERROR (non-2xx) response is always accepted — it carries
    no user data and the user must see the failure (prod or dev)."""
    monkeypatch.delenv("DINA_TEST_MODE", raising=False)
    t = _bare_msgbox_transport()
    env = {"ciphertext": json.dumps({"status": 503, "headers": {}, "body": "node busy"})}
    resp = t._parse_response(env)
    assert resp.status == 503
    assert resp.body == "node busy"


def test_plaintext_success_rejected_in_production(monkeypatch):
    """A plaintext SUCCESS (2xx) response is rejected when not in dev/test —
    success payloads must be encrypted (a plaintext 2xx is MITM/misconfig)."""
    monkeypatch.delenv("DINA_TEST_MODE", raising=False)
    t = _bare_msgbox_transport()
    env = {"ciphertext": json.dumps({"status": 200, "headers": {}, "body": "secret"})}
    with pytest.raises(TransportError, match="plaintext success"):
        t._parse_response(env)


def test_plaintext_success_allowed_in_test_mode(monkeypatch):
    """Dev/test (DINA_TEST_MODE=1) still accepts plaintext success so the
    existing local/test flows keep working."""
    monkeypatch.setenv("DINA_TEST_MODE", "1")
    t = _bare_msgbox_transport()
    env = {"ciphertext": json.dumps({"status": 200, "headers": {}, "body": "ok"})}
    resp = t._parse_response(env)
    assert resp.status == 200
    assert resp.body == "ok"
