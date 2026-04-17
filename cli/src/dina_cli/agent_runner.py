"""Agent runner interface — generic abstraction for task execution runtimes.

All task runners (OpenClaw, Hermes, future runners) implement this interface.
The daemon and CLI use it without knowing which runtime executes the task.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable


@dataclass
class RunnerResult:
    """Result of a runner execution."""
    state: Literal["running", "completed", "failed"]
    run_id: str = ""
    summary: str = ""
    error: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class AgentRunner(Protocol):
    """Protocol for task execution runtimes.

    execute() may return:
      - state="running" for fire-and-forget runtimes (OpenClaw)
      - state="completed"/"failed" for inline runtimes (Hermes library mode)

    reconcile() is optional — only needed for detached runtimes.
    """

    runner_name: str

    def validate_config(self) -> None:
        """Validate runner configuration. Raises on invalid config."""
        ...

    def health(self) -> dict[str, Any]:
        """Check runner health. Returns status dict."""
        ...

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        """Execute a task. Returns terminal or running state."""
        ...

    def reconcile(self, task: dict) -> RunnerResult | None:
        """Reconcile a stale running task. Returns updated state or None if unknown."""
        ...

    def cancel(self, task: dict) -> None:
        """Cancel a running task. Best-effort."""
        ...

    @property
    def supports_reconciliation(self) -> bool:
        """Whether this runner needs a background reconciliation loop."""
        ...


# Standard task prompt envelope — all runners receive the same format.
TASK_PROMPT_TEMPLATE = """\
TASK ID: {task_id}
DINA SESSION: {session_name}
RUNNER: {runner_name}

OBJECTIVE: {description}

INSTRUCTIONS:
1. Use Dina MCP tools for memory, validation, and task status.
2. Use session '{session_name}' for all Dina tool calls.
3. Report progress via dina_task_progress.
4. Report success via dina_task_complete.
5. Report failure via dina_task_fail.
"""


def build_task_prompt(task: dict, session_name: str, runner_name: str) -> str:
    """Build the standard task prompt envelope.

    For service_query_execution tasks (WS2 public service discovery),
    augment the abstract description with the structured payload so the
    LLM has the capability + params it needs to pick tool arguments.
    The description itself stays abstract to avoid leaking payload values
    into admin UI task lists and logs (see fix #18).
    """
    import json as _json
    description = task.get("description", "")
    if task.get("payload_type") == "service_query_execution":
        payload_raw = task.get("payload", "")
        try:
            payload = (
                _json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
            )
        except Exception:
            payload = {}
        capability = payload.get("capability", "")
        params = payload.get("params", {})
        if capability and isinstance(params, dict):
            description = (
                f"Execute the `{capability}` capability with the following "
                f"parameters. Call the corresponding MCP tool using EXACTLY "
                f"these argument values, then report the result via "
                f"`dina_task_complete`.\n\n"
                f"Parameters JSON:\n{_json.dumps(params, indent=2)}"
            )
    return TASK_PROMPT_TEMPLATE.format(
        task_id=task.get("id", ""),
        session_name=session_name,
        runner_name=runner_name,
        description=description,
    )
