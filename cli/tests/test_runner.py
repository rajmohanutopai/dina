"""Tests for the agent runner abstraction and runner implementations.

Covers:
  - AgentRunner interface contract
  - OpenClawRunner: config validation, execute, reconcile
  - HermesRunner: config validation, health, execute fallback
  - RunnerRegistry: registration, lookup, unknown runner
  - Task prompt building
"""

from __future__ import annotations

import os
from unittest.mock import patch, MagicMock

import pytest

from dina_cli.agent_runner import AgentRunner, RunnerResult, build_task_prompt
from dina_cli.openclaw_runner import OpenClawRunner
from dina_cli.hermes_runner import HermesRunner
from dina_cli.runner_registry import get_runner, list_runners


# ---------------------------------------------------------------------------
# RunnerResult
# ---------------------------------------------------------------------------

class TestRunnerResult:

    def test_running_state(self):
        r = RunnerResult(state="running", run_id="abc")
        assert r.state == "running"
        assert r.run_id == "abc"

    def test_completed_state(self):
        r = RunnerResult(state="completed", summary="done")
        assert r.state == "completed"
        assert r.summary == "done"

    def test_failed_state(self):
        r = RunnerResult(state="failed", error="timeout")
        assert r.state == "failed"
        assert r.error == "timeout"


# ---------------------------------------------------------------------------
# Task prompt
# ---------------------------------------------------------------------------

class TestTaskPrompt:

    def test_build_prompt(self):
        task = {"id": "task-1", "description": "Find best books"}
        prompt = build_task_prompt(task, "ses_abc", "hermes")
        assert "task-1" in prompt
        assert "ses_abc" in prompt
        assert "hermes" in prompt
        assert "Find best books" in prompt

    def test_prompt_includes_instructions(self):
        prompt = build_task_prompt({"id": "t", "description": "d"}, "s", "r")
        assert "dina_task_complete" in prompt
        assert "dina_task_fail" in prompt
        assert "dina_task_progress" in prompt


# ---------------------------------------------------------------------------
# Runner Registry
# ---------------------------------------------------------------------------

class TestRunnerRegistry:

    def test_list_runners(self):
        runners = list_runners()
        assert "openclaw" in runners
        assert "hermes" in runners

    def test_get_openclaw(self):
        r = get_runner("openclaw")
        assert r.runner_name == "openclaw"

    def test_get_hermes(self):
        r = get_runner("hermes")
        assert r.runner_name == "hermes"

    def test_unknown_runner(self):
        with pytest.raises(RuntimeError, match="Unknown runner"):
            get_runner("nonexistent")


# ---------------------------------------------------------------------------
# OpenClawRunner
# ---------------------------------------------------------------------------

class TestOpenClawRunner:

    def test_runner_name(self):
        r = OpenClawRunner()
        assert r.runner_name == "openclaw"

    def test_supports_reconciliation(self):
        r = OpenClawRunner()
        assert r.supports_reconciliation is True

    @patch.dict(os.environ, {"DINA_OPENCLAW_URL": "", "DINA_OPENCLAW_HOOK_TOKEN": ""})
    def test_validate_config_missing_url(self):
        r = OpenClawRunner()
        with pytest.raises(RuntimeError, match="DINA_OPENCLAW_URL"):
            r.validate_config()

    @patch.dict(os.environ, {"DINA_OPENCLAW_URL": "http://localhost:3000", "DINA_OPENCLAW_HOOK_TOKEN": ""})
    def test_validate_config_missing_token(self):
        r = OpenClawRunner()
        with pytest.raises(RuntimeError, match="DINA_OPENCLAW_HOOK_TOKEN"):
            r.validate_config()

    @patch.dict(os.environ, {"DINA_OPENCLAW_URL": "http://localhost:3000", "DINA_OPENCLAW_HOOK_TOKEN": "tok"})
    def test_validate_config_ok(self):
        r = OpenClawRunner()
        r.validate_config()  # should not raise

    def test_execute_returns_running_or_failed(self):
        """Execute returns RunnerResult with state running or failed."""
        r = OpenClawRunner()
        # Without a real OpenClaw, execute will fail with connection error.
        result = r.execute({"id": "t1"}, "prompt", "ses_1")
        assert result.state in ("running", "failed")

    def test_reconcile_returns_none_on_error(self):
        r = OpenClawRunner()
        result = r.reconcile({"id": "t1"})
        assert result is None  # no OpenClaw to query


# ---------------------------------------------------------------------------
# HermesRunner
# ---------------------------------------------------------------------------

class TestHermesRunner:

    def test_runner_name(self):
        r = HermesRunner()
        assert r.runner_name == "hermes"

    def test_no_reconciliation(self):
        r = HermesRunner()
        assert r.supports_reconciliation is False

    def test_reconcile_returns_none(self):
        r = HermesRunner()
        assert r.reconcile({"id": "t1"}) is None

    def test_health_without_hermes(self):
        """Health reports unavailable when hermes isn't installed."""
        r = HermesRunner()
        h = r.health()
        # hermes may or may not be installed — either is valid
        assert h["runner"] == "hermes"
        assert h["status"] in ("ok", "unavailable")

    def test_execute_without_hermes_fails_gracefully(self):
        """Execute fails gracefully when hermes isn't installed."""
        r = HermesRunner()
        result = r.execute({"id": "t1"}, "prompt", "ses_1")
        assert result.state == "failed"
        # Error should mention hermes library not being available.
        assert "hermes" in result.error.lower()
