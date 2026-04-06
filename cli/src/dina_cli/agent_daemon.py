"""Persistent agent daemon — claims delegated tasks and executes via configured runner.

Runner-agnostic: the daemon claims tasks from Core, selects a runner
(OpenClaw, Hermes, etc.), and normalizes results back to Core.

Usage: dina agent-daemon [--poll-interval 15] [--lease-duration 300] [--runner openclaw]
"""

from __future__ import annotations

import os
import signal
import sys
import threading
import time

from .agent_runner import AgentRunner, RunnerResult, build_task_prompt
from .client import DinaClient, DinaClientError
from .config import load_config
from .runner_registry import get_runner


def run_daemon(
    poll_interval: int = 15,
    lease_duration: int = 300,
    runner_name: str = "",
) -> None:
    """Main daemon loop: claim → execute via runner → normalize state → next."""
    cfg = load_config()
    client = DinaClient(cfg)

    # Resolve runner.
    runner_name = runner_name or os.environ.get("DINA_AGENT_RUNNER", "") or getattr(cfg, "agent_runner", "") or "openclaw"
    try:
        runner = get_runner(runner_name, config=cfg)
        runner.validate_config()
    except RuntimeError as e:
        print(f"[agent-daemon] FATAL: {e}", file=sys.stderr)
        sys.exit(1)

    # Graceful shutdown.
    running = True

    def _signal_handler(sig: int, frame: object) -> None:
        nonlocal running
        print(f"\n[agent-daemon] Shutting down (signal {sig})...", file=sys.stderr)
        running = False

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    print(f"[agent-daemon] Started (poll={poll_interval}s, lease={lease_duration}s, runner={runner.runner_name})", file=sys.stderr)
    print(f"[agent-daemon] Core: {cfg.core_url}", file=sys.stderr)
    print(f"[agent-daemon] Device: {client._identity.did()}", file=sys.stderr)

    # Start reconciler thread only if the runner needs it.
    reconciler_stop = threading.Event()
    reconciler_thread = None
    if runner.supports_reconciliation:
        reconciler_thread = threading.Thread(
            target=_reconciler_loop,
            args=(client, runner, reconciler_stop, cfg.core_url,
                  os.environ.get("DINA_HOOK_CALLBACK_TOKEN", "")),
            daemon=True,
        )
        reconciler_thread.start()
        print(f"[agent-daemon] Reconciler: enabled ({runner.runner_name})", file=sys.stderr)
    else:
        print(f"[agent-daemon] Reconciler: disabled ({runner.runner_name} is inline)", file=sys.stderr)

    while running:
        try:
            task = client.claim_task(lease_seconds=lease_duration, runner_filter=runner.runner_name)
        except DinaClientError as e:
            print(f"[agent-daemon] Claim error: {e}", file=sys.stderr)
            time.sleep(poll_interval)
            continue

        if task is None:
            time.sleep(poll_interval)
            continue

        task_id = task.get("id", "")
        session_name = task.get("session_name", "")
        description = task.get("description", "")

        print(f"[agent-daemon] Claimed: {task_id} — {description[:80]}", file=sys.stderr)

        # End any orphaned session from a prior crashed attempt.
        try:
            client.session_end(session_name)
        except Exception:
            pass

        # Start fresh Dina session.
        try:
            client.session_start(name=session_name)
        except DinaClientError as e:
            print(f"[agent-daemon] Session start failed: {e} — failing task", file=sys.stderr)
            try:
                client.task_fail(task_id, f"Session start failed: {e}")
            except Exception:
                pass
            continue

        # Build task prompt.
        prompt = build_task_prompt(task, session_name, runner.runner_name)

        # Execute via runner.
        try:
            result = runner.execute(task, prompt, session_name)
        except Exception as e:
            result = RunnerResult(state="failed", error=f"Runner error: {e}")

        # Normalize result into Core task transitions.
        try:
            _apply_result(client, task_id, session_name, result, runner.runner_name)
        except Exception as e:
            print(f"[agent-daemon] Result normalization error: {e}", file=sys.stderr)

    # Shutdown.
    reconciler_stop.set()
    if reconciler_thread:
        reconciler_thread.join(timeout=5)
    print("[agent-daemon] Stopped.", file=sys.stderr)
    client.close()


def _apply_result(
    client: DinaClient,
    task_id: str,
    session_name: str,
    result: RunnerResult,
    runner_name: str,
) -> None:
    """Apply a RunnerResult to Core task state."""
    if result.state == "running":
        # Fire-and-forget runner (OpenClaw) — mark running and move on.
        mark_ok = False
        try:
            client.mark_running(task_id, result.run_id, assigned_runner=runner_name)
            mark_ok = True
        except DinaClientError:
            # Check if already terminal (fast callback race).
            try:
                t = client.get_task(task_id)
                if t and t.get("status") in ("completed", "failed", "running"):
                    mark_ok = True
            except Exception:
                pass

        if not mark_ok:
            print(f"[agent-daemon] CRITICAL: mark_running failed after submit, failing {task_id}", file=sys.stderr)
            try:
                client.task_fail(task_id, f"mark_running failed after {runner_name} submit")
            except Exception:
                pass
            try:
                client.session_end(session_name)
            except Exception:
                pass
        else:
            print(f"[agent-daemon] Submitted: {task_id} (run_id={result.run_id or 'none'})", file=sys.stderr)

    elif result.state == "completed":
        # Inline runner (Hermes) — task finished, apply result.
        # The runner may have already called dina_task_complete via MCP.
        try:
            t = client.get_task(task_id)
            if t and t.get("status") in ("completed", "failed"):
                print(f"[agent-daemon] Completed (via MCP): {task_id}", file=sys.stderr)
            else:
                # Fallback: runner returned completed but didn't call MCP complete.
                # Pass assigned_runner so it's recorded even on terminal-state write.
                client.task_complete(task_id, result.summary or "Task completed by runner",
                                     assigned_runner=runner_name)
                print(f"[agent-daemon] Completed (fallback): {task_id}", file=sys.stderr)
        except Exception as e:
            print(f"[agent-daemon] Complete fallback error: {e}", file=sys.stderr)
        try:
            client.session_end(session_name)
        except Exception:
            pass

    elif result.state == "failed":
        # Task failed — pass assigned_runner so it's recorded on terminal write.
        try:
            t = client.get_task(task_id)
            if t and t.get("status") in ("completed", "failed"):
                print(f"[agent-daemon] Failed (already terminal): {task_id}", file=sys.stderr)
            else:
                client.task_fail(task_id, result.error or "Task failed",
                                 assigned_runner=runner_name)
                print(f"[agent-daemon] Failed: {task_id} — {result.error[:100]}", file=sys.stderr)
        except Exception as e:
            print(f"[agent-daemon] Fail error: {e}", file=sys.stderr)
        try:
            client.session_end(session_name)
        except Exception:
            pass


def _reconciler_loop(
    client: DinaClient,
    runner: AgentRunner,
    stop: threading.Event,
    core_url: str = "",
    callback_token: str = "",
) -> None:
    """Background reconciler: checks stale running tasks via runner-specific logic."""
    import httpx

    interval = getattr(runner, "reconcile_interval_seconds", 15 * 60)
    stale_threshold = getattr(runner, "stale_threshold_seconds", 24 * 60 * 60)

    while not stop.wait(interval):
        try:
            # Fetch running tasks from Core.
            try:
                resp = httpx.get(
                    f"{core_url}/v1/internal/delegated-tasks",
                    params={"status": "running"},
                    headers={"Authorization": f"Bearer {callback_token}"},
                    timeout=15,
                )
                tasks = resp.json().get("tasks", []) if resp.status_code == 200 else []
            except Exception:
                tasks = client.list_tasks(status="running")

            if not tasks:
                continue

            now = time.time()
            for task in tasks:
                last_updated = task.get("updated_at", 0) or task.get("created_at", 0)
                if now - last_updated < stale_threshold:
                    continue

                task_id = task.get("id", "")
                result = runner.reconcile(task)
                if result is None:
                    continue

                if result.state == "completed":
                    try:
                        client.task_complete(task_id, result.summary or "reconciled")
                        print(f"[reconciler] Completed: {task_id}", file=sys.stderr)
                    except Exception as e:
                        print(f"[reconciler] Complete error: {task_id}: {e}", file=sys.stderr)
                elif result.state == "failed":
                    try:
                        client.task_fail(task_id, result.error or "reconciled: failed")
                        print(f"[reconciler] Failed: {task_id}", file=sys.stderr)
                    except Exception as e:
                        print(f"[reconciler] Fail error: {task_id}: {e}", file=sys.stderr)

        except Exception as e:
            print(f"[reconciler] Error: {e}", file=sys.stderr)
