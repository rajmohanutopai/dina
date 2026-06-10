"""Headless-CLI runner — delegate tasks to any agent with a one-shot CLI mode.

The task-direction twin of `dina skill install`: every modern agent
platform converges on the same two primitives — it reads instructions
from markdown, and it can be invoked headlessly with a prompt:

    claude -p "<prompt>"        (Claude Code)
    codex exec "<prompt>"       (Codex CLI)
    gemini -p "<prompt>"        (Gemini CLI)

So "use agent X as a task executor" is ONE generic runner with a
per-platform argv template — not a protocol integration per agent.

Execution model: INLINE (like Hermes, unlike OpenClaw's fire-and-forget
Gateway). `execute()` blocks on the subprocess and returns a terminal
RunnerResult; the daemon reports completion and ends the session — the
child agent does NOT need dina task tools.

Safety loop: the child agent on this host has the Dina skill installed
(`dina init`), so it already knows to route reads through `dina ask`
and gate risky actions through `dina validate` — both under the task's
session, both still blocking on the owner's phone. The prompt envelope
restates the session + the pending-approval contract anyway: envelopes
are cheap, bypasses are not.

Known limitation (documented, not hidden): if a mid-task approval is
still pending when `DINA_HEADLESS_TIMEOUT` expires, the run fails with
a hint. The approval itself persists on the Home Node — re-running the
task after approving resumes cleanly.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from typing import Any

from .agent_runner import RunnerResult

# argv templates — "{prompt}" is replaced as a SINGLE argv element
# (list-form exec, no shell), so prompt content can never inject.
PLATFORMS: dict[str, dict[str, Any]] = {
    "claude-code": {"bin": "claude", "argv": ["claude", "-p", "{prompt}"]},
    "codex": {"bin": "codex", "argv": ["codex", "exec", "{prompt}"]},
    "gemini": {"bin": "gemini", "argv": ["gemini", "-p", "{prompt}"]},
    # One agent turn via OpenClaw's own CLI (which speaks the Gateway
    # protocol for us — handshake/auth/version drift become OpenClaw's
    # problem, not ours). The bespoke Gateway runner ("openclaw") stays
    # for fire-and-forget runs that outlive a subprocess timeout; pick
    # --agent / --local via DINA_HEADLESS_ARGS_OPENCLAW_CLI.
    "openclaw-cli": {"bin": "openclaw", "argv": ["openclaw", "agent", "--message", "{prompt}"]},
}

# Default per-task wall clock. Generous because agentic tasks legitimately
# take minutes; bounded because a wedged child process must not hold the
# daemon's claim lease forever.
DEFAULT_TIMEOUT_S = 900

# Stdout tail reported as the task summary. Caps what lands in the task
# record — the child's full transcript is not the deliverable.
SUMMARY_MAX_CHARS = 4000

HEADLESS_PROMPT_TEMPLATE = """\
TASK ID: {task_id}
DINA SESSION: {session_name}

OBJECTIVE: {description}

INSTRUCTIONS:
1. You are executing a delegated task for the user's Dina. For anything
   about the user (their data, schedule, contacts, history) use the
   `dina` CLI: `dina ask "<question>" --session {session_name}`.
2. Before any sensitive action (sending, deleting, sharing, spending),
   run `dina validate <action> "<description>" --session {session_name}`.
   If it returns pending_approval you MUST wait and poll
   `dina validate-status <id>` — never proceed on a pending or denied
   approval.
3. To store something for the user:
   `dina remember "<text>" --session {session_name}`.
4. When finished, print a concise final summary of the outcome as your
   last output — your output IS the task result. Do not print secrets.
"""


def build_headless_prompt(task: dict, session_name: str) -> str:
    """CLI-flavored envelope (the daemon's standard template instructs MCP
    task tools, which headless CLI agents don't have — the daemon reports
    completion from our return value instead)."""
    return HEADLESS_PROMPT_TEMPLATE.format(
        task_id=task.get("id", ""),
        session_name=session_name,
        description=task.get("description", ""),
    )


class HeadlessCliRunner:
    """Generic inline runner over a platform's one-shot CLI mode."""

    supports_reconciliation = False

    def __init__(self, platform: str, config: object = None) -> None:
        if platform not in PLATFORMS:
            raise RuntimeError(
                f"Unknown headless platform '{platform}'. Known: {', '.join(sorted(PLATFORMS))}"
            )
        self.runner_name = platform
        self._spec = PLATFORMS[platform]
        self._timeout = int(os.environ.get("DINA_HEADLESS_TIMEOUT", str(DEFAULT_TIMEOUT_S)))

    # ── AgentRunner protocol ────────────────────────────────────────────

    def validate_config(self) -> None:
        binary = self._spec["bin"]
        if shutil.which(binary) is None:
            raise RuntimeError(
                f"'{binary}' not found on PATH — install the {self.runner_name} "
                f"CLI on this host (the daemon shells out to it), or pick a "
                f"different runner with --runner."
            )

    def health(self) -> dict[str, Any]:
        binary = self._spec["bin"]
        path = shutil.which(binary)
        return {
            "status": "ok" if path else "unavailable",
            "runner": self.runner_name,
            "binary": path or binary,
        }

    def _extra_args(self) -> list[str]:
        """Operator-supplied flags, injected BEFORE the prompt element.

        Headless agents prompt for tool permissions by default, which in
        batch mode means hanging or denying — real autonomous tasks need
        the operator to grant a baseline, e.g.:

          DINA_HEADLESS_ARGS_CLAUDE_CODE='--allowedTools "Read,Bash" --permission-mode acceptEdits'
          DINA_HEADLESS_ARGS_CODEX='--sandbox workspace-write'

        Deliberately env-only (trusted operator input, same trust class as
        CLI flags) — task content can never reach these args.
        """
        key = "DINA_HEADLESS_ARGS_" + self.runner_name.upper().replace("-", "_")
        raw = os.environ.get(key, "")
        return shlex.split(raw) if raw else []

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        # Build our own envelope — see build_headless_prompt docstring.
        # The daemon-built `prompt` arg is intentionally unused.
        del prompt
        rendered = build_headless_prompt(task, session_name)
        argv: list[str] = []
        for a in self._spec["argv"]:
            if a == "{prompt}":
                argv.extend(self._extra_args())
                argv.append(rendered)
            else:
                argv.append(a)
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=self._timeout,
            )
        except subprocess.TimeoutExpired:
            return RunnerResult(
                state="failed",
                error=(
                    f"{self.runner_name} run exceeded {self._timeout}s. If the task "
                    f"was waiting on an approval, approve it in the Dina app and "
                    f"re-run — the approval persists."
                ),
            )
        except OSError as exc:
            return RunnerResult(state="failed", error=f"could not start {argv[0]}: {exc}")

        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-1000:]
            return RunnerResult(
                state="failed",
                error=f"{self.runner_name} exited {proc.returncode}: {tail}",
            )
        summary = (proc.stdout or "").strip()
        if len(summary) > SUMMARY_MAX_CHARS:
            summary = summary[-SUMMARY_MAX_CHARS:]
        return RunnerResult(
            state="completed",
            summary=summary or f"{self.runner_name} completed with no output",
        )

    def reconcile(self, task: dict) -> RunnerResult | None:
        # Inline runtime — nothing detached to reconcile.
        return None

    def cancel(self, task: dict) -> None:
        # Inline runtime — execute() owns the subprocess lifetime; a daemon
        # shutdown signal interrupts the loop between tasks. Best-effort no-op.
        return None


class ClaudeCodeRunner(HeadlessCliRunner):
    def __init__(self, config: object = None) -> None:
        super().__init__("claude-code", config)


class CodexRunner(HeadlessCliRunner):
    def __init__(self, config: object = None) -> None:
        super().__init__("codex", config)


class GeminiRunner(HeadlessCliRunner):
    def __init__(self, config: object = None) -> None:
        super().__init__("gemini", config)


class OpenClawCliRunner(HeadlessCliRunner):
    def __init__(self, config: object = None) -> None:
        super().__init__("openclaw-cli", config)
