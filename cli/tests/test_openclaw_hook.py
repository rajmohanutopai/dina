"""Tests for the OpenClaw agent_end hook.

``openclaw_hook.py`` runs inside the OpenClaw process and POSTs task
completion to Dina Core. Two failure modes mattered historically:

1. Structured agent output (``dict``/``list``) being stuffed into a text
   ``result`` field and truncated at 4000 bytes — which turned valid
   schema-matching results into silently malformed ones.
2. Wrong session-key prefix or missing env vars causing the hook to
   call Core with the wrong task_id or without auth.

These tests exercise ``on_agent_end`` and ``_extract_result`` without
ever hitting the network (``urllib.request.urlopen`` is patched).
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from dina_cli import openclaw_hook


@pytest.fixture(autouse=True)
def _callback_env(monkeypatch):
    """Wire up callback URL + token so _post_callback doesn't bail early."""
    monkeypatch.setattr(openclaw_hook, "CALLBACK_URL", "http://core:18100")
    monkeypatch.setattr(openclaw_hook, "CALLBACK_TOKEN", "test-token")


# ---------------------------------------------------------------------------
# _extract_result: the piece that used to truncate structured JSON
# ---------------------------------------------------------------------------

def test_extract_result_preserves_dict_as_structured():
    result = {"eta_minutes": 7, "stop_name": "Castro Station",
              "map_url": "https://maps.example/x"}
    summary, structured = openclaw_hook._extract_result(result)
    assert structured == result
    # Summary is a compact JSON string — parseable and deterministic.
    assert json.loads(summary) == result


def test_extract_result_preserves_list_as_structured():
    result = [{"a": 1}, {"b": 2}]
    summary, structured = openclaw_hook._extract_result(result)
    assert structured == result
    assert json.loads(summary) == result


def test_extract_result_parses_json_string_back_to_structured():
    # Some agents wrap their structured result as a JSON string. The hook
    # must recover the structure so the bridge sees the real shape.
    raw = json.dumps({"eta_minutes": 12, "stop_name": "Market St"})
    summary, structured = openclaw_hook._extract_result(raw)
    assert structured == {"eta_minutes": 12, "stop_name": "Market St"}
    assert json.loads(summary)["eta_minutes"] == 12


def test_extract_result_leaves_plain_text_without_structured():
    summary, structured = openclaw_hook._extract_result("no JSON here")
    assert structured is None
    assert summary == "no JSON here"


def test_extract_result_large_dict_not_truncated_in_structured():
    """Structured results must retain every byte even when the summary is
    clipped. The bridge reads ``result_json`` (which rides on
    ``structured``) — truncating it would corrupt the contract."""
    big = {f"key_{i}": f"value_{i}" * 20 for i in range(200)}
    summary, structured = openclaw_hook._extract_result(big)
    assert structured == big, "structured payload must not be truncated"
    assert len(summary) <= 2000, "summary is intentionally clipped"


def test_extract_result_non_json_object_stringified_safely():
    # Non-JSON-serialisable object falls through to str().
    class Opaque:
        def __str__(self):
            return "opaque-value"
    summary, structured = openclaw_hook._extract_result(Opaque())
    assert structured is None
    assert summary == "opaque-value"


# ---------------------------------------------------------------------------
# on_agent_end: routing + payload shape
# ---------------------------------------------------------------------------

def _event(status: str, **extra):
    base = {
        "sessionKey": "hook:dina-task:svc-exec-abc",
        "status": status,
    }
    base.update(extra)
    return base


def _captured_post(post_callback_mock):
    """Extract (task_id, action, payload) from the _post_callback mock."""
    assert post_callback_mock.called, "hook did not POST to Core"
    args, kwargs = post_callback_mock.call_args
    # _post_callback(task_id, action, payload)
    return args[0], args[1], args[2]


def test_on_agent_end_skips_non_dina_session_keys():
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end({"sessionKey": "other:random-session",
                                     "status": "ok", "result": "x"})
    assert not post.called, "hook must ignore non-Dina sessions"


def test_on_agent_end_skips_empty_task_id():
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end({"sessionKey": "hook:dina-task:",
                                     "status": "ok", "result": "x"})
    assert not post.called


def test_on_agent_end_success_with_structured_result_sends_result_json():
    result = {"eta_minutes": 7, "stop_name": "Castro Station"}
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("ok", result=result))
    task_id, action, payload = _captured_post(post)
    assert task_id == "svc-exec-abc"
    assert action == "complete"
    # Structured path: both a human summary and the full result_json.
    assert "result" in payload
    assert payload["result_json"] == result


def test_on_agent_end_success_with_text_result_sends_no_result_json():
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("ok", result="agent said so"))
    _, action, payload = _captured_post(post)
    assert action == "complete"
    assert payload["result"] == "agent said so"
    assert "result_json" not in payload, \
        "free-form text must not masquerade as structured"


def test_on_agent_end_completed_alias_also_treated_as_success():
    # OpenClaw may report "completed" instead of "ok"; both should work.
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("completed", result={"k": 1}))
    _, action, _ = _captured_post(post)
    assert action == "complete"


def test_on_agent_end_failure_posts_fail_with_error():
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("error", error="route unreachable"))
    _, action, payload = _captured_post(post)
    assert action == "fail"
    assert payload["error"] == "route unreachable"


def test_on_agent_end_failure_without_error_text_falls_back_to_status():
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("timeout"))
    _, action, payload = _captured_post(post)
    assert action == "fail"
    assert "timeout" in payload["error"]


def test_on_agent_end_no_callback_config_is_noop(monkeypatch):
    # Missing env → hook warns but never calls _post_callback.
    monkeypatch.setattr(openclaw_hook, "CALLBACK_URL", "")
    monkeypatch.setattr(openclaw_hook, "CALLBACK_TOKEN", "")
    with patch.object(openclaw_hook, "_post_callback") as post:
        openclaw_hook.on_agent_end(_event("ok", result={"k": 1}))
    assert not post.called


# ---------------------------------------------------------------------------
# _post_callback: URL + auth + retry
# ---------------------------------------------------------------------------

def test_post_callback_builds_correct_url_and_auth_header():
    task_id = "svc-exec-xyz"
    payload = {"result": "done"}
    # Mock urlopen: return a response-like object whose .status < 300.
    resp = MagicMock()
    resp.status = 200
    resp.__enter__ = lambda self: self
    resp.__exit__ = lambda self, *a: None
    with patch("urllib.request.urlopen", return_value=resp) as urlopen:
        openclaw_hook._post_callback(task_id, "complete", payload)
    req = urlopen.call_args.args[0]
    assert req.full_url == "http://core:18100/v1/internal/workflow-tasks/svc-exec-xyz/complete"
    assert req.get_header("Authorization") == "Bearer test-token"
    assert req.get_header("Content-type") == "application/json"
    assert json.loads(req.data.decode()) == payload


def test_post_callback_retries_on_transient_error_then_succeeds(monkeypatch):
    calls = {"n": 0}
    resp = MagicMock()
    resp.status = 200
    resp.__enter__ = lambda self: self
    resp.__exit__ = lambda self, *a: None

    def flaky_urlopen(*a, **kw):
        calls["n"] += 1
        if calls["n"] < 2:
            raise OSError("connection refused")
        return resp

    monkeypatch.setattr("time.sleep", lambda s: None)  # skip backoff
    with patch("urllib.request.urlopen", side_effect=flaky_urlopen):
        openclaw_hook._post_callback("svc-exec-r", "complete", {"result": "x"})
    assert calls["n"] == 2


def test_post_callback_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    with patch("urllib.request.urlopen", side_effect=OSError("down")):
        # Must not raise — the hook is best-effort from OpenClaw's view.
        openclaw_hook._post_callback("svc-exec-g", "complete", {"result": "x"})
