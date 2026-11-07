"""docs/DAILY_PLAN.md — `dina plan push` / `dina plan status`, and the MsgBox
send-and-forget path that lets a batch wait for a sleeping phone."""

from __future__ import annotations

import json
import threading
import time
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from dina_cli.main import cli
from dina_cli.transport import MsgBoxTransport, _expiry_for_path


def _transport() -> MsgBoxTransport:
    t = MsgBoxTransport.__new__(MsgBoxTransport)
    t._msgbox_url = "wss://test"
    t._homenode_did = "did:plc:phone"
    t._timeout = 30.0
    t._pending = {}
    t._homenode_x25519_pub = None
    t._cli_x25519_priv = None
    t._cli_x25519_pub = None
    t._lock = threading.RLock()
    t._consecutive_auth_failures = 0
    t._next_attempt_at = 0.0
    t._max_backoff_seconds = 30.0
    identity = MagicMock()
    identity.sign_request.return_value = ("did:key:zOffice", "2026-11-03T07:00:00Z", "aa" * 16, "bb" * 64)
    identity.did.return_value = "did:key:zOffice"
    t._identity = identity
    return t


def _silent_ws(sent: list) -> MagicMock:
    ws = MagicMock()
    ws.recv.side_effect = TimeoutError()
    ws.send.side_effect = lambda data: sent.append(data)
    return ws


def test_deferred_send_leaves_the_batch_with_msgbox():
    t = _transport()
    sent: list = []
    with patch.object(t, "_connect_and_auth", return_value=_silent_ws(sent)), \
            patch.object(t, "_drain_buffered"), \
            patch.object(t, "_encrypt", side_effect=lambda x: x):
        started = time.monotonic()
        resp = t.request_deferred("POST", "/v1/plan/inbox", {}, body='{"items":[]}', wait=0.1)
        assert time.monotonic() - started < 5  # the 30 s timeout does not apply
    assert resp.status == 202
    assert json.loads(resp.body)["queued"] is True
    # One frame, the request; no cancel, so MsgBox keeps it.
    assert len(sent) == 1
    env = json.loads(sent[0])
    assert env["type"] == "rpc"
    assert env["expires_at"] - time.time() > 19 * 60 * 60


def test_an_ordinary_request_still_cancels_on_timeout():
    t = _transport()
    t._timeout = 0.1
    sent: list = []
    with patch.object(t, "_connect_and_auth", return_value=_silent_ws(sent)), \
            patch.object(t, "_drain_buffered"), \
            patch.object(t, "_encrypt", side_effect=lambda x: x):
        try:
            t.request("GET", "/v1/plan/status", {})
        except Exception:
            pass
    assert json.loads(sent[-1])["type"] == "cancel"


def test_expiry_is_long_only_for_the_inbox():
    now = time.time()
    assert _expiry_for_path("/v1/plan/inbox") - now > 19 * 60 * 60
    assert _expiry_for_path("/v1/plan/status") - now <= 31


def _config():
    from dina_cli.config import Config
    return Config(core_url="http://localhost:8100", timeout=5.0, device_name="office", role="agent")


def _invoke(args, client):
    runner = CliRunner()
    with patch("dina_cli.main.load_config", return_value=_config()), \
            patch("dina_cli.main.DinaClient", return_value=client):
        return runner.invoke(cli, ["--json", *args], catch_exceptions=False)


def test_push_sends_a_list_with_persona_and_a_batch_id(tmp_path):
    items = tmp_path / "items.json"
    items.write_text(json.dumps([{"title": "Reply to Priya", "source": "outlook", "source_ref": "m1"}]))
    client = MagicMock()
    client.req_id = "r1"
    client.plan_push.return_value = {"accepted": 0, "held": 1, "duplicate_batch": False}
    result = _invoke(["plan", "push", "--file", str(items), "--persona", "work"], client)
    assert result.exit_code == 0, result.output
    batch = client.plan_push.call_args.args[0]
    assert batch["persona"] == "work"
    assert batch["items"][0]["source_ref"] == "m1"
    assert batch["batch_id"]
    out = json.loads(result.output)
    assert out["status"] == "delivered"
    assert out["held"] == 1


def test_push_reports_queued_when_the_phone_is_asleep(tmp_path):
    items = tmp_path / "items.json"
    items.write_text(json.dumps({"items": [{"title": "Book the dentist"}]}))
    client = MagicMock()
    client.req_id = "r1"
    client.plan_push.return_value = {"queued": True}
    result = _invoke(["plan", "push", "--file", str(items), "--batch-id", "2026-11-03-home"], client)
    assert result.exit_code == 0, result.output
    out = json.loads(result.output)
    assert out["status"] == "queued"
    assert out["batch_id"] == "2026-11-03-home"
    assert client.plan_push.call_args.args[0]["persona"] == "general"


def test_push_rejects_something_that_is_not_items(tmp_path):
    items = tmp_path / "items.json"
    items.write_text(json.dumps({"title": "no list"}))
    client = MagicMock()
    client.req_id = "r1"
    runner = CliRunner()
    with patch("dina_cli.main.load_config", return_value=_config()), \
            patch("dina_cli.main.DinaClient", return_value=client):
        result = runner.invoke(cli, ["plan", "push", "--file", str(items)])
    assert result.exit_code != 0
    client.plan_push.assert_not_called()


def test_status_prints_the_agents_tasks():
    client = MagicMock()
    client.req_id = "r1"
    client.plan_status.return_value = {"tasks": [{"source_ref": "m1", "status": "done"}]}
    result = _invoke(["plan", "status", "--since", "5"], client)
    assert result.exit_code == 0, result.output
    client.plan_status.assert_called_once_with(5)
    assert json.loads(result.output)["tasks"][0]["status"] == "done"
