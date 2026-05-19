"""Stub ETA runner — returns canned bus ETA data for service_query_execution tasks.

Used by the bus42-agent test setup to provide the `eta_query` capability
backend for iOS Dina (paired). When iOS Dina hands the agent a
`service_query_execution` task for `eta_query`, this runner returns a
canned `{eta_minutes, stop_name, route_id, …}` payload that satisfies
the `eta_query` result schema (params/result schemas in
`packages/protocol/src/types/capability.ts` and AppView).

This is a deterministic test stub — no MCP, no network, no LLM. The
flow it validates is the dina-agent claim → execute → reply chain, not
the accuracy of the data.
"""

from __future__ import annotations

import json
from typing import Any

from dina_cli.agent_runner import AgentRunner, RunnerResult


class StubEtaRunner:
    """AgentRunner that returns canned ETA for service_query_execution tasks."""

    runner_name = "stub_eta"
    supports_reconciliation = False

    def __init__(self, config: object = None):
        self.config = config

    def validate_config(self) -> None:
        return None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "runner": self.runner_name}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        # Parse the task payload to confirm it's a service_query_execution
        # for the eta_query capability. If not, fail gracefully so we can
        # see what was claimed.
        payload_type = task.get("payload_type", "")
        payload_raw = task.get("payload", "")
        try:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else (payload_raw or {})
        except json.JSONDecodeError:
            payload = {}

        capability = payload.get("capability", "")
        params = payload.get("params", {}) if isinstance(payload.get("params"), dict) else {}

        # Echo what we saw so we can debug from the logs if needed.
        print(
            f"[stub_eta] claimed task {task.get('id','?')} "
            f"payload_type={payload_type} capability={capability} params={params}",
            flush=True,
        )

        if capability != "eta_query":
            return RunnerResult(
                state="failed",
                error=f"stub_eta runner only handles eta_query; got '{capability}'",
            )

        # Canned result matching the eta_query result schema. Lexicon
        # requires `status` (one of on_route/not_on_route/out_of_service/
        # not_found); other fields optional.
        result_payload = {
            "status": "on_route",
            "eta_minutes": 6,
            "vehicle_type": "bus",
            "route_name": f"Route {params.get('route_id', '14')}",
            "stop_name": params.get("stop_name", "Mission and 16th"),
            "message": "stub_eta_runner (canned test data)",
        }

        # Pass back as compact JSON in `summary` — daemon._apply_result
        # will call client.task_complete with this string and Core will
        # use it as the service response payload on the D2D reply.
        return RunnerResult(
            state="completed",
            summary=json.dumps(result_payload),
            metadata={"capability": capability},
        )

    def reconcile(self, task: dict) -> RunnerResult | None:
        return None

    def cancel(self, task: dict) -> None:
        return None
