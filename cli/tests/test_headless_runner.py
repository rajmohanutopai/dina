"""Headless-CLI runner — argv safety, envelope contract, result mapping, registry."""

import subprocess
from unittest.mock import patch

import pytest

from dina_cli.headless_cli_runner import (
    PLATFORMS,
    HeadlessCliRunner,
    build_headless_prompt,
)
from dina_cli.runner_registry import get_runner, list_runners

TASK = {"id": "task-123", "description": "Summarize the user's week and draft a note"}
SESSION = "task-abc12345"


def _completed(stdout: str = "all done", returncode: int = 0, stderr: str = ""):
    class P:
        pass

    p = P()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


# ── registry ────────────────────────────────────────────────────────────


def test_headless_runners_registered():
    names = list_runners()
    for key in ("claude-code", "codex", "gemini"):
        assert key in names
        runner = get_runner(key)
        assert runner.runner_name == key
        assert runner.supports_reconciliation is False  # inline, no reconciler thread


def test_unknown_platform_rejected():
    with pytest.raises(RuntimeError, match="Unknown headless platform"):
        HeadlessCliRunner("copilot-2030")


# ── validate_config ─────────────────────────────────────────────────────


def test_validate_config_missing_binary_gives_install_hint():
    runner = HeadlessCliRunner("claude-code")
    with patch("dina_cli.headless_cli_runner.shutil.which", return_value=None):
        with pytest.raises(RuntimeError, match="not found on PATH"):
            runner.validate_config()
    with patch("dina_cli.headless_cli_runner.shutil.which", return_value="/usr/local/bin/claude"):
        runner.validate_config()  # no raise
        assert runner.health()["status"] == "ok"


# ── envelope contract ───────────────────────────────────────────────────


def test_envelope_is_cli_flavored_not_mcp():
    prompt = build_headless_prompt(TASK, SESSION)
    assert TASK["description"] in prompt
    assert f"--session {SESSION}" in prompt
    assert "pending_approval" in prompt
    assert "dina validate" in prompt
    # The daemon's MCP-era tool names must NOT leak into the headless
    # envelope — these agents have no MCP tools, the daemon reports for them.
    assert "dina_task_complete" not in prompt
    assert "dina_task_progress" not in prompt


def test_execute_substitutes_prompt_as_single_argv_element():
    """List-form exec: prompt content lands in ONE argv slot — a malicious
    description can never become extra arguments or shell syntax."""
    runner = HeadlessCliRunner("codex")
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        assert kwargs.get("shell") is not True
        return _completed()

    with patch("dina_cli.headless_cli_runner.subprocess.run", side_effect=fake_run):
        evil = {"id": "t1", "description": 'x"; rm -rf / #'}
        runner.execute(evil, "daemon-prompt-ignored", SESSION)

    argv = captured["argv"]
    assert argv[:2] == ["codex", "exec"]
    assert len(argv) == 3  # exactly one prompt slot, regardless of content
    assert 'x"; rm -rf / #' in argv[2]
    assert f"--session {SESSION}" in argv[2]  # our envelope, not the daemon's


# ── result mapping ──────────────────────────────────────────────────────


def test_execute_success_maps_stdout_to_summary():
    runner = HeadlessCliRunner("claude-code")
    with patch(
        "dina_cli.headless_cli_runner.subprocess.run",
        return_value=_completed(stdout="Drafted the note.\n"),
    ):
        result = runner.execute(TASK, "", SESSION)
    assert result.state == "completed"
    assert result.summary == "Drafted the note."


def test_execute_caps_runaway_summaries():
    runner = HeadlessCliRunner("gemini")
    with patch(
        "dina_cli.headless_cli_runner.subprocess.run",
        return_value=_completed(stdout="x" * 50_000),
    ):
        result = runner.execute(TASK, "", SESSION)
    assert result.state == "completed"
    assert len(result.summary) == 4000


def test_execute_nonzero_exit_fails_with_stderr_tail():
    runner = HeadlessCliRunner("codex")
    with patch(
        "dina_cli.headless_cli_runner.subprocess.run",
        return_value=_completed(stdout="", returncode=2, stderr="auth expired"),
    ):
        result = runner.execute(TASK, "", SESSION)
    assert result.state == "failed"
    assert "exited 2" in result.error
    assert "auth expired" in result.error


def test_execute_timeout_mentions_approval_persistence():
    runner = HeadlessCliRunner("claude-code")
    with patch(
        "dina_cli.headless_cli_runner.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=900),
    ):
        result = runner.execute(TASK, "", SESSION)
    assert result.state == "failed"
    assert "approval" in result.error  # the documented limitation, surfaced


def test_execute_missing_binary_at_runtime_fails_cleanly():
    runner = HeadlessCliRunner("gemini")
    with patch(
        "dina_cli.headless_cli_runner.subprocess.run",
        side_effect=FileNotFoundError("gemini"),
    ):
        result = runner.execute(TASK, "", SESSION)
    assert result.state == "failed"
    assert "could not start" in result.error


def test_reconcile_and_cancel_are_inline_noops():
    runner = HeadlessCliRunner("codex")
    assert runner.reconcile(TASK) is None
    assert runner.cancel(TASK) is None


def test_platform_table_shapes():
    for key, spec in PLATFORMS.items():
        assert spec["argv"].count("{prompt}") == 1, key
        assert spec["bin"] == spec["argv"][0], key


def test_operator_extra_args_injected_before_prompt(monkeypatch):
    """Headless agents need operator-granted tool permissions for real
    autonomous work (e.g. claude -p hangs/denies on tool use otherwise).
    Env-supplied flags land between the fixed argv and the prompt; task
    content can never reach them."""
    monkeypatch.setenv(
        "DINA_HEADLESS_ARGS_CLAUDE_CODE", "--allowedTools Read,Bash --permission-mode acceptEdits"
    )
    runner = HeadlessCliRunner("claude-code")
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        return _completed()

    with patch("dina_cli.headless_cli_runner.subprocess.run", side_effect=fake_run):
        runner.execute(TASK, "", SESSION)

    argv = captured["argv"]
    assert argv[:2] == ["claude", "-p"]
    assert argv[2:6] == ["--allowedTools", "Read,Bash", "--permission-mode", "acceptEdits"]
    assert TASK["description"] in argv[6]  # prompt still last, still one element
    assert len(argv) == 7
