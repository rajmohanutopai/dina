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

    For service_query_execution tasks (WS2 provider service discovery),
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
        mcp_tool = payload.get("mcp_tool", "")
        if capability and isinstance(params, dict):
            # Explicit tool binding when the provider declared one; else the
            # agent is left to infer from the capability name. Explicit is
            # always preferable — stops the LLM from wandering to other MCP
            # tools (e.g. dina_ask, dina_search) that happen to be in scope.
            if mcp_tool:
                tool_instruction = (
                    f"Execute the `{capability}` capability by calling the MCP "
                    f"tool `{mcp_tool}` with EXACTLY these argument values. "
                    f"Do not call any other tool."
                )
            else:
                tool_instruction = (
                    f"Execute the `{capability}` capability. Call the MCP tool "
                    f"whose name matches the capability (e.g. `{capability}` or "
                    f"`<server>__{capability}`) with EXACTLY these argument values."
                )
            description = (
                f"{tool_instruction}\n\n"
                f"Parameters JSON:\n{_json.dumps(params, indent=2)}\n\n"
                f"CRITICAL result handling:\n"
                f"- After the MCP tool returns, call `dina_task_complete` with "
                f"the tool's JSON output VERBATIM as the `result` argument — "
                f"serialize the JSON object to a compact string and pass that "
                f"string. Do NOT summarize, do NOT paraphrase, do NOT wrap it "
                f"in prose. The requester validates the raw JSON against a "
                f"schema; a human-readable summary will be rejected as a "
                f"schema violation.\n"
                f"- If the tool fails, call `dina_task_fail` with the raw "
                f"error text.\n"
                f"- Example: if the MCP tool returns "
                f'`{{"eta_minutes": 6, "stop_name": "X"}}`, call '
                f'`dina_task_complete(task_id=..., result=\'{{"eta_minutes": 6, "stop_name": "X"}}\')`.'
            )
    return TASK_PROMPT_TEMPLATE.format(
        task_id=task.get("id", ""),
        session_name=session_name,
        runner_name=runner_name,
        description=description,
    )
