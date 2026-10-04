"""The agent daemon's reports on a claimed task (design §7.3, §7.7): every
one carries the task's claim token, and none is sent for a task the runner
already reported on, or parked on its requester's answer."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli.agent_daemon import _apply_result
from dina_cli.agent_runner import RunnerResult


@pytest.fixture()
def client():
    return MagicMock()


def test_a_fallback_completion_carries_the_claim_token(client):
    client.get_task.return_value = {"id": "t-1", "status": "running"}
    _apply_result(client, "t-1", "ses", RunnerResult(state="completed", summary="done"), "hermes", "claim-1")
    client.task_complete.assert_called_once_with(
        "t-1", "done", assigned_runner="hermes", claim_id="claim-1"
    )


def test_a_failure_carries_the_claim_token(client):
    client.get_task.return_value = {"id": "t-1", "status": "running"}
    _apply_result(client, "t-1", "ses", RunnerResult(state="failed", error="broke"), "hermes", "claim-1")
    client.task_fail.assert_called_once_with(
        "t-1", "broke", assigned_runner="hermes", claim_id="claim-1"
    )


@pytest.mark.parametrize("status", ["completed", "failed", "awaiting", "cancelled", "outcome_unknown"])
@pytest.mark.parametrize("state", ["completed", "failed"])
def test_no_report_for_a_task_already_reported_or_waiting_on_its_requester(client, status, state):
    client.get_task.return_value = {"id": "t-1", "status": status}
    _apply_result(client, "t-1", "ses", RunnerResult(state=state, summary="s", error="e"), "hermes", "claim-1")
    client.task_complete.assert_not_called()
    client.task_fail.assert_not_called()
    client.session_end.assert_called_once_with("ses")


def test_a_failed_mark_running_fails_the_task_under_its_claim(client):
    from dina_cli.client import DinaClientError

    client.mark_running.side_effect = DinaClientError("boom")
    client.get_task.return_value = {"id": "t-1", "status": "queued"}
    _apply_result(client, "t-1", "ses", RunnerResult(state="running", run_id="r"), "openclaw", "claim-1")
    client.task_fail.assert_called_once_with(
        "t-1", "mark_running failed after openclaw submit", claim_id="claim-1"
    )
