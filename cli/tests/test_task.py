"""Tests for the dina task command (OpenClaw delegation)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from dina_cli.main import cli


def _test_config():
    from dina_cli.config import Config
    return Config(
        core_url="http://localhost:8100",
        timeout=5.0,
        device_name="test",
        role="agent",
        openclaw_url="http://localhost:3000",
        openclaw_token="test-token",
    )


def _invoke(args, mock_client=None, mock_openclaw=None, json_mode=False):
    """Run a CLI command with mocked DinaClient and OpenClawClient."""
    runner = CliRunner()
    patches = [
        patch("dina_cli.main.load_config", return_value=_test_config()),
    ]
    if mock_client:
        patches.append(patch("dina_cli.main.DinaClient", return_value=mock_client))
    if mock_openclaw:
        patches.append(
            patch("dina_cli.main.OpenClawClient" if False else "dina_cli.openclaw.OpenClawClient",
                  return_value=mock_openclaw)
        )

    cmd = ["--json"] + args if json_mode else args
    with patches[0], (patches[1] if len(patches) > 1 else patch("builtins.id")):
        # Need to patch at the import location
        with patch("dina_cli.main.DinaClient", return_value=mock_client) if mock_client else patch("builtins.id"):
            with patch("dina_cli.main.OpenClawClient", return_value=mock_openclaw) if mock_openclaw else patch("builtins.id"):
                result = runner.invoke(cli, cmd, catch_exceptions=False)
    return result


class TestDinaTask:

    def test_task_not_configured(self):
        """Error when openclaw_url is empty."""
        from dina_cli.config import Config
        empty_config = Config(core_url="http://localhost:8100", timeout=5.0)
        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=empty_config):
            result = runner.invoke(cli, ["task", "Research chairs"])
        assert result.exit_code != 0
        assert "OpenClaw not configured" in result.output or "openclaw" in result.output.lower()

    def test_task_validates_research_intent(self):
        """Task command calls process_event with action=research."""
        mc = MagicMock()
        mc.session_start.return_value = {"id": "ses-1", "name": "task-test"}
        mc.process_event.return_value = {
            "action": "flag_for_review",
            "requires_approval": True,
            "proposal_id": "prop-test",
        }
        mc.proposal_status.return_value = {"status": "approved"}

        oc = MagicMock()
        oc.run_task.return_value = {"status": "completed", "data": {"result": "ok"}}
        oc.close = MagicMock()

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc), \
             patch("dina_cli.openclaw.OpenClawClient", return_value=oc):
            # Won't actually run because it polls — just check process_event was called
            # Use dry-run to skip the polling loop
            mc.process_event.return_value = {
                "action": "auto_approve",
                "approved": True,
                "requires_approval": False,
            }
            result = runner.invoke(cli, ["task", "--dry-run", "Research chairs"])

        # Verify process_event was called with research action
        call_args = mc.process_event.call_args
        event = call_args[0][0]
        assert event["action"] == "research"
        assert event["type"] == "agent_intent"

    def test_task_denied(self):
        """Task denied by guardian → no OpenClaw call."""
        mc = MagicMock()
        mc.session_start.return_value = {"id": "ses-1"}
        mc.process_event.return_value = {
            "action": "deny",
            "reason": "blocked by policy",
        }

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["task", "Research chairs"])

        assert "denied" in result.output.lower() or "blocked" in result.output.lower()
        mc.session_end.assert_called()

    def test_task_dry_run(self):
        """Dry-run validates but doesn't invoke OpenClaw."""
        mc = MagicMock()
        mc.session_start.return_value = {"id": "ses-1"}
        mc.process_event.return_value = {
            "action": "auto_approve",
            "approved": True,
        }

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["task", "--dry-run", "Research chairs"])

        assert "dry-run" in result.output.lower()
        mc.session_end.assert_called()

    def test_task_session_lifecycle(self):
        """Session start/end always called, end in finally."""
        mc = MagicMock()
        mc.session_start.return_value = {"id": "ses-1"}
        mc.process_event.return_value = {"action": "deny", "reason": "test"}

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            runner.invoke(cli, ["task", "Research chairs"])

        mc.session_start.assert_called_once()
        mc.session_end.assert_called_once()

    def test_task_stores_via_staging(self):
        """Result stored via staging_ingest with type=note, source=openclaw."""
        mc = MagicMock()
        mc.session_start.return_value = {"id": "ses-1"}
        mc.process_event.return_value = {"action": "auto_approve", "approved": True}
        mc.staging_ingest.return_value = {"id": "stg-1"}

        oc = MagicMock()
        oc.run_task.return_value = {"status": "completed", "data": {"chairs": ["ErgoMax"]}, "summary": "Found chairs"}
        oc.close = MagicMock()

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc), \
             patch("dina_cli.openclaw.OpenClawClient", return_value=oc):
            result = runner.invoke(cli, ["task", "Research chairs"])

        # Verify staging_ingest was called
        assert mc.staging_ingest.called
        call_args = mc.staging_ingest.call_args
        item = call_args[0][0]
        assert item["type"] == "note"
        assert item["source"] == "openclaw"
