"""Tests for the coding-agent gate: `dina gate-hook` + the `bin/dina-gate`
supervisor (Plugin Developer Surface §10/§12 / NEW-27).

Two classes of coverage:
  1. gate-hook LOGIC — the Core decision → exit-code mapping, and that EVERY
     handled failure fails CLOSED (exit 2, never a silent allow).
  2. SUPERVISOR conformance (NEW-27 child-gate failures) — a child that crashes,
     signals, exits non-2, or is missing must still BLOCK (exit 2).
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from dina_cli.client import DinaClientError
from dina_cli.main import cli

SUPERVISOR = (
    Path(__file__).resolve().parents[1] / "claude-plugin" / "dina" / "bin" / "dina-gate"
)


def _cfg():
    from dina_cli.config import Config

    return Config(
        core_url="http://localhost:8100", timeout=5.0, device_name="test-device"
    )


def _run_gate(
    stdin_text: str,
    *,
    gate_return=None,
    gate_exc=None,
    load_exc=None,
    inject_session: bool = True,
    host: str = "claude-code",
):
    """Invoke `dina gate-hook` with a mocked client. `signal` is patched off so
    the self-deadline never arms a real SIGALRM inside the in-process runner."""
    if inject_session:
        try:
            event = json.loads(stdin_text)
            if isinstance(event, dict) and event.get("tool_name"):
                event.setdefault("session_id", "claude-test")
                stdin_text = json.dumps(event)
        except (json.JSONDecodeError, TypeError):
            pass
    runner = CliRunner()
    with (
        patch("dina_cli.main.DinaClient") as MockCls,
        patch("dina_cli.main.load_config") as mock_load,
        patch("signal.signal"),
        patch("signal.alarm"),
    ):
        if load_exc is not None:
            mock_load.side_effect = load_exc
        else:
            mock_load.return_value = _cfg()
        inst = MockCls.return_value
        if gate_exc is not None:
            inst.gate.side_effect = gate_exc
        else:
            inst.gate.return_value = gate_return
        return runner.invoke(cli, ["gate-hook", "--host", host], input=stdin_text)


# ── gate-hook decision → exit-code mapping ────────────────────────────────


def test_allow_exits_0():
    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {"file_path": "a.ts"}}),
        gate_return={"action": "code_read", "risk": "SAFE", "outcome": "allow"},
    )
    assert r.exit_code == 0


def test_owner_approved_allow_explicitly_overrides_claude_permission_layer():
    r = _run_gate(
        json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": "git reset --hard"}}
        ),
        gate_return={
            "action": "vcs_destructive",
            "risk": "HIGH",
            "outcome": "allow",
            "permit_id": "permit_1_deadbeef",
            "owner_approval_redeemed": True,
            "reason": "redeemed durable owner approval",
        },
    )
    assert r.exit_code == 0
    assert '"permissionDecision": "allow"' in r.output
    assert "redeemed durable owner approval" in r.output


def test_owner_approved_allow_stays_silent_for_codex():
    r = _run_gate(
        json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": "git reset --hard"}}
        ),
        gate_return={
            "action": "vcs_destructive",
            "risk": "HIGH",
            "outcome": "allow",
            "permit_id": "permit_1_deadbeef",
            "owner_approval_redeemed": True,
        },
        host="codex",
    )
    assert r.exit_code == 0
    assert "permissionDecision" not in r.output


def test_auto_permit_allow_does_not_override_claude_permission_layer():
    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {"file_path": "a.ts"}}),
        gate_return={
            "action": "code_read",
            "risk": "SAFE",
            "outcome": "allow",
            "permit_id": "permit_1_deadbeef",
            "owner_approval_redeemed": False,
        },
    )
    assert r.exit_code == 0
    assert "permissionDecision" not in r.output


def test_deny_exits_2():
    r = _run_gate(
        json.dumps({"tool_name": "Bash", "tool_input": {"command": "cat keyfile"}}),
        gate_return={
            "action": "secret_read",
            "risk": "BLOCKED",
            "outcome": "deny",
            "reason": "reads a protected path",
        },
    )
    assert r.exit_code == 2


def test_approval_required_asks():
    r = _run_gate(
        json.dumps({"tool_name": "Bash", "tool_input": {"command": "git push"}}),
        gate_return={
            "action": "vcs_push",
            "risk": "MODERATE",
            "outcome": "approval_required",
            "reason": "pushes to a remote",
        },
    )
    # exit 0 + a PreToolUse `ask` decision on stdout — the developer decides.
    assert r.exit_code == 0
    assert '"permissionDecision": "ask"' in r.output
    assert "pushes to a remote" in r.output


def test_codex_moderate_routes_to_dina_approval_instead_of_unsupported_host_ask():
    r = _run_gate(
        json.dumps({"tool_name": "Bash", "tool_input": {"command": "git push"}}),
        gate_return={
            "action": "vcs_push",
            "risk": "MODERATE",
            "outcome": "approval_required",
            "task_id": "coding-gate-codex-1",
        },
        host="codex",
    )
    assert r.exit_code == 2
    assert "coding-gate-codex-1" in r.output
    assert "Approve it in Dina, then retry" in r.output
    assert "permissionDecision" not in r.output


def test_high_approval_required_blocks_until_dina_approval():
    r = _run_gate(
        json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": "git reset --hard"}}
        ),
        gate_return={
            "action": "vcs_destructive",
            "risk": "HIGH",
            "outcome": "approval_required",
            "task_id": "coding-gate-123",
            "reason": "destructive repository operation",
        },
    )
    assert r.exit_code == 2
    assert "coding-gate-123" in r.output
    assert "Approve it in Dina, then retry" in r.output
    assert "permissionDecision" not in r.output


def test_high_without_approval_task_fails_closed():
    r = _run_gate(
        json.dumps({"tool_name": "Bash", "tool_input": {"command": "sudo reboot"}}),
        gate_return={
            "action": "system_modify",
            "risk": "HIGH",
            "outcome": "approval_required",
            "task_id": None,
        },
    )
    assert r.exit_code == 2
    assert "no approval task could be created" in r.output


def test_approval_required_with_unknown_risk_fails_closed():
    r = _run_gate(
        json.dumps({"tool_name": "FutureTool", "tool_input": {}}),
        gate_return={"outcome": "approval_required", "risk": "SURPRISE"},
    )
    assert r.exit_code == 2
    assert "unrecognized risk" in r.output


def test_unreachable_core_fails_closed():
    # A DinaClientError (Core down / 501 no-gate / 401) blocks — never allows.
    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {}}),
        gate_exc=DinaClientError("connection refused"),
    )
    assert r.exit_code == 2


def test_not_configured_fails_closed():
    import click

    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {}}),
        load_exc=click.UsageError("Not configured. Run: dina configure"),
    )
    assert r.exit_code == 2


def test_malformed_stdin_fails_closed():
    r = _run_gate("{ this is not json", gate_return={"outcome": "allow"})
    assert r.exit_code == 2


def test_missing_tool_name_fails_closed():
    r = _run_gate(
        json.dumps({"tool_input": {"x": 1}}), gate_return={"outcome": "allow"}
    )
    assert r.exit_code == 2


def test_non_object_tool_input_fails_closed():
    r = _run_gate(
        json.dumps({"tool_name": "Bash", "tool_input": "git status"}),
        gate_return={"outcome": "allow"},
    )
    assert r.exit_code == 2
    assert "non-object tool_input" in r.output


def test_empty_stdin_fails_closed():
    r = _run_gate("", gate_return={"outcome": "allow"})
    assert r.exit_code == 2


def test_missing_host_session_fails_closed():
    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {}}),
        gate_return={"outcome": "allow"},
        inject_session=False,
    )
    assert r.exit_code == 2
    assert "no host session_id" in r.output


def test_unknown_outcome_fails_closed():
    # An unrecognized decision from a REACHABLE Core must never allow (§12.2).
    r = _run_gate(
        json.dumps({"tool_name": "Read", "tool_input": {}}),
        gate_return={"outcome": "maybe?"},
    )
    assert r.exit_code == 2


def test_gate_receives_raw_tool_call():
    # Core owns classification: the hook forwards the RAW (tool_name, tool_input)
    # + cwd, and decides nothing itself.
    with (
        patch("dina_cli.main.DinaClient") as MockCls,
        patch("dina_cli.main.load_config", return_value=_cfg()),
        patch("signal.signal"),
        patch("signal.alarm"),
    ):
        inst = MockCls.return_value
        inst.gate.return_value = {"outcome": "allow"}
        CliRunner().invoke(
            cli,
            ["gate-hook"],
            input=json.dumps(
                {
                    "tool_name": "Write",
                    "tool_input": {"file_path": "x.ts"},
                    "cwd": "/work",
                    "session_id": "claude-abc",
                }
            ),
        )
        inst.gate.assert_called_once()
        kwargs = inst.gate.call_args.kwargs
        args = inst.gate.call_args.args
        assert args[0] == "Write"  # tool_name
        assert args[1] == {"file_path": "x.ts"}  # tool_input (raw)
        assert kwargs.get("cwd") == "/work"
        assert kwargs.get("host_session") == "claude-abc"
        assert kwargs.get("approval_surface") == "host"


def test_codex_gate_requests_owner_approval_surface():
    with (
        patch("dina_cli.main.DinaClient") as MockCls,
        patch("dina_cli.main.load_config", return_value=_cfg()),
        patch("signal.signal"),
        patch("signal.alarm"),
    ):
        inst = MockCls.return_value
        inst.gate.return_value = {"outcome": "allow"}
        result = CliRunner().invoke(
            cli,
            ["gate-hook", "--host", "codex"],
            input=json.dumps(
                {
                    "tool_name": "Read",
                    "tool_input": {"file_path": "x.ts"},
                    "cwd": "/work",
                    "session_id": "codex-abc",
                }
            ),
        )

    assert result.exit_code == 0
    assert inst.gate.call_args.kwargs["approval_surface"] == "owner"


def test_session_end_hook_ends_matching_core_session():
    payload = json.dumps({"session_id": "claude-abc"})
    runner = CliRunner()
    with (
        patch("dina_cli.main.DinaClient") as MockCls,
        patch("dina_cli.main.load_config", return_value=_cfg()),
    ):
        inst = MockCls.return_value
        inst.session_list.return_value = {
            "sessions": [
                {"session_id": "sess-other", "name": "other"},
                {"session_id": "sess-match", "name": "claude-abc"},
            ]
        }
        result = runner.invoke(cli, ["session-end-hook"], input=payload)

    assert result.exit_code == 0
    inst.session_end.assert_called_once_with("sess-match")


def test_session_end_hook_is_best_effort_on_core_failure():
    runner = CliRunner()
    with (
        patch("dina_cli.main.DinaClient") as MockCls,
        patch("dina_cli.main.load_config", return_value=_cfg()),
    ):
        MockCls.return_value.session_list.side_effect = DinaClientError("offline")
        result = runner.invoke(
            cli,
            ["session-end-hook"],
            input=json.dumps({"session_id": "claude-abc"}),
        )

    assert result.exit_code == 0
    assert "lease will expire automatically" in result.output


# ── supervisor conformance (NEW-27 child-gate failures must BLOCK) ────────

pytestmark_posix = pytest.mark.skipif(
    os.name != "posix", reason="supervisor is a POSIX sh script"
)


def _run_supervisor(*, fake_dina_body: str | None, tmp_path: Path):
    """Run the real supervisor with a controlled fake `dina` on an isolated PATH.
    `fake_dina_body=None` means dina is NOT on PATH."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    if fake_dina_body is not None:
        fake = bindir / "dina"
        fake.write_text("#!/bin/sh\n" + fake_dina_body + "\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "PATH": str(bindir),
        "DINA_PLUGIN_DEV_MODE": "1",
        "DINA_BOOTSTRAP_PYTHON": sys.executable,
    }
    if fake_dina_body is not None:
        env["DINA_CLI_BIN"] = str(fake)
    return subprocess.run(
        [str(SUPERVISOR)],
        input=b'{"tool_name":"Read","tool_input":{}}',
        env=env,
        capture_output=True,
        timeout=30,
    )


@pytestmark_posix
def test_supervisor_propagates_allow(tmp_path):
    r = _run_supervisor(fake_dina_body="exit 0", tmp_path=tmp_path)
    assert r.returncode == 0


@pytestmark_posix
def test_supervisor_propagates_deny(tmp_path):
    r = _run_supervisor(fake_dina_body="echo 'nope' >&2; exit 2", tmp_path=tmp_path)
    assert r.returncode == 2


@pytestmark_posix
def test_supervisor_blocks_on_child_exit_1(tmp_path):
    # A non-2 exit from the gate is a FAILURE, not an allow → block.
    r = _run_supervisor(fake_dina_body="exit 1", tmp_path=tmp_path)
    assert r.returncode == 2
    assert b"blocked" in r.stderr.lower()


@pytestmark_posix
def test_supervisor_blocks_on_child_signal(tmp_path):
    # The gate killed by a signal (crash) → block.
    r = _run_supervisor(fake_dina_body="kill -TERM $$", tmp_path=tmp_path)
    assert r.returncode == 2


@pytestmark_posix
def test_supervisor_blocks_when_dina_missing(tmp_path):
    # `dina` not installed / not on PATH → block (never run the tool ungated).
    r = _run_supervisor(fake_dina_body=None, tmp_path=tmp_path)
    assert r.returncode == 2
    assert b"not set up" in r.stderr.lower()
