"""OpenClaw runner — fire-and-forget task submission via OpenClaw hooks.

Wraps the existing OpenClaw hook submission and reconciliation logic
behind the AgentRunner interface. OpenClaw runs detached; terminal
status comes back via the agent_end callback hook.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import httpx

from .agent_runner import AgentRunner, RunnerResult


class OpenClawRunner:
    """AgentRunner implementation for OpenClaw."""

    runner_name = "openclaw"

    def __init__(self, config: Any = None) -> None:
        # Read from loaded config first, fall back to env vars.
        # This preserves existing setups where users configured via `dina configure`.
        openclaw_url = (
            os.environ.get("DINA_OPENCLAW_URL")
            or (getattr(config, "openclaw_url", "") if config else "")
            or ""
        )
        self._hook_token = (
            os.environ.get("DINA_OPENCLAW_HOOK_TOKEN")
            or (getattr(config, "openclaw_hook_token", "") if config else "")
            or ""
        )
        self._callback_token = os.environ.get("DINA_HOOK_CALLBACK_TOKEN", "")
        self._core_url = os.environ.get("DINA_CORE_URL", "")

        # Derive hook base URL
        hook_base = (openclaw_url or "").rstrip("/")
        for suffix in ("/ws", "/ws/"):
            if hook_base.endswith(suffix):
                hook_base = hook_base[: -len(suffix)]
        if hook_base.startswith("ws://"):
            hook_base = "http://" + hook_base[5:]
        elif hook_base.startswith("wss://"):
            hook_base = "https://" + hook_base[6:]
        self._hook_base = hook_base

    def validate_config(self) -> None:
        if not self._hook_base:
            raise RuntimeError("OpenClaw runner: DINA_OPENCLAW_URL not set")
        if not self._hook_token:
            raise RuntimeError("OpenClaw runner: DINA_OPENCLAW_HOOK_TOKEN not set")

    def health(self) -> dict[str, Any]:
        try:
            r = httpx.get(f"{self._hook_base}/healthz", timeout=5)
            return {"status": "ok" if r.status_code == 200 else "unhealthy"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        """Submit task to OpenClaw hooks — fire-and-forget."""
        task_id = task.get("id", "")
        try:
            resp = httpx.post(
                f"{self._hook_base}/hooks/agent",
                json={
                    "message": prompt,
                    "sessionKey": f"hook:dina-task:{task_id}",
                },
                headers={"Authorization": f"Bearer {self._hook_token}"},
                timeout=30,
            )
            if resp.status_code < 300:
                run_id = ""
                try:
                    run_id = resp.json().get("runId", "")
                except Exception:
                    pass
                return RunnerResult(state="running", run_id=run_id)
            else:
                return RunnerResult(
                    state="failed",
                    error=f"Hook submission failed: {resp.status_code} {resp.text[:200]}",
                )
        except Exception as e:
            return RunnerResult(state="failed", error=f"Hook submission error: {e}")

    def reconcile(self, task: dict) -> RunnerResult | None:
        """Check OpenClaw task ledger for stale running tasks."""
        task_id = task.get("id", "")
        session_key = f"hook:dina-task:{task_id}"

        try:
            resp = httpx.get(
                f"{self._hook_base}/api/v1/tasks",
                params={"sessionKey": session_key},
                headers={"Authorization": f"Bearer {self._hook_token}"},
                timeout=15,
            )
            if resp.status_code != 200:
                return None

            oc_tasks = resp.json().get("tasks", [])
            if not oc_tasks:
                return RunnerResult(
                    state="failed",
                    error="execution lost: no OpenClaw task found",
                )

            oc_task = oc_tasks[0]
            oc_status = oc_task.get("status", "")

            if oc_status in ("completed", "ok"):
                raw_result = oc_task.get("result", "reconciled")
                if not isinstance(raw_result, str):
                    import json
                    raw_result = json.dumps(raw_result)[:2000]
                return RunnerResult(state="completed", summary=raw_result)

            if oc_status in ("failed", "error", "cancelled", "timeout"):
                raw_error = oc_task.get("error", f"reconciled: {oc_status}")
                if not isinstance(raw_error, str):
                    import json
                    raw_error = json.dumps(raw_error)[:2000]
                return RunnerResult(state="failed", error=raw_error)

            return None  # still running

        except Exception:
            return None

    def cancel(self, task: dict) -> None:
        pass  # OpenClaw doesn't support cancel via hook

    @property
    def supports_reconciliation(self) -> bool:
        return True

    @property
    def reconcile_interval_seconds(self) -> int:
        return 15 * 60  # 15 minutes

    @property
    def stale_threshold_seconds(self) -> int:
        return 24 * 60 * 60  # 24 hours
