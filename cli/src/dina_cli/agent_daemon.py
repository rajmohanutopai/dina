"""Persistent agent daemon — claims delegated tasks and submits to OpenClaw.

Fire-and-forget: the daemon submits work via POST /hooks/dina-task,
marks the task running, and moves on. OpenClaw's agent_end hook
posts terminal status back to Core via /v1/internal/delegated-tasks/.

Usage: dina agent-daemon [--poll-interval 15] [--lease-duration 300]
"""

from __future__ import annotations

import os
import signal
import sys
import threading
import time

import httpx

from .client import DinaClient, DinaClientError
from .config import load_config


def run_daemon(poll_interval: int = 15, lease_duration: int = 300) -> None:
    """Main daemon loop: claim → submit to OpenClaw → mark running → next."""
    cfg = load_config()
    client = DinaClient(cfg)

    # OpenClaw hook config — fail fast if not configured
    openclaw_url = getattr(cfg, "openclaw_url", "") or ""
    hook_token = getattr(cfg, "openclaw_hook_token", "") or ""
    if not openclaw_url:
        print("[agent-daemon] FATAL: DINA_OPENCLAW_URL not set.", file=sys.stderr)
        sys.exit(1)
    if not hook_token:
        print("[agent-daemon] FATAL: DINA_OPENCLAW_HOOK_TOKEN not set.", file=sys.stderr)
        sys.exit(1)

    # Derive hook base URL from OpenClaw URL (strip /ws suffix if present)
    hook_base = openclaw_url.rstrip("/")
    for suffix in ("/ws", "/ws/"):
        if hook_base.endswith(suffix):
            hook_base = hook_base[: -len(suffix)]
    # Ensure HTTP scheme
    if hook_base.startswith("ws://"):
        hook_base = "http://" + hook_base[5:]
    elif hook_base.startswith("wss://"):
        hook_base = "https://" + hook_base[6:]

    # Graceful shutdown
    running = True

    def _signal_handler(sig: int, frame: object) -> None:
        nonlocal running
        print(f"\n[agent-daemon] Shutting down (signal {sig})...", file=sys.stderr)
        running = False

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    print(f"[agent-daemon] Started (poll={poll_interval}s, lease={lease_duration}s)", file=sys.stderr)
    print(f"[agent-daemon] Core: {cfg.core_url}", file=sys.stderr)
    print(f"[agent-daemon] OpenClaw hooks: {hook_base}/hooks/agent", file=sys.stderr)
    print(f"[agent-daemon] Device: {client._identity.did()}", file=sys.stderr)

    # Start reconciler thread
    reconciler_stop = threading.Event()
    reconciler = threading.Thread(
        target=_reconciler_loop,
        args=(client, hook_base, hook_token, reconciler_stop, cfg.core_url,
              os.environ.get("DINA_HOOK_CALLBACK_TOKEN", "")),
        daemon=True,
    )
    reconciler.start()

    while running:
        try:
            task = client.claim_task(lease_seconds=lease_duration)
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

        # End any orphaned session from a prior crashed attempt
        try:
            client.session_end(session_name)
        except Exception:
            pass

        # Start fresh Dina session
        try:
            client.session_start(name=session_name)
        except DinaClientError as e:
            print(f"[agent-daemon] Session start failed: {e} — failing task", file=sys.stderr)
            try:
                client.task_fail(task_id, f"Session start failed: {e}")
            except Exception:
                pass
            continue

        # Build task prompt with callback instructions
        prompt = (
            f"TASK ID: {task_id}\n"
            f"DINA SESSION: {session_name}\n\n"
            f"OBJECTIVE: {description}\n\n"
            f"INSTRUCTIONS:\n"
            f"1. You have Dina MCP tools available (dina_ask, dina_validate, dina_remember, etc.)\n"
            f"2. Use session '{session_name}' for all Dina tool calls\n"
            f"3. When you finish the task successfully, you MUST call dina_task_complete "
            f"with task_id='{task_id}' and a summary of what you accomplished\n"
            f"4. If you cannot complete the task, call dina_task_fail "
            f"with task_id='{task_id}' and an explanation\n"
            f"5. You may call dina_task_progress with task_id='{task_id}' "
            f"to report intermediate progress\n"
            f"6. The user can check status via /taskstatus {task_id} in Telegram"
        )

        # Submit to OpenClaw via POST /hooks/agent (fire-and-forget)
        try:
            resp = httpx.post(
                f"{hook_base}/hooks/agent",
                json={
                    "message": prompt,
                    "sessionKey": f"hook:dina-task:{task_id}",
                },
                headers={"Authorization": f"Bearer {hook_token}"},
                timeout=30,
            )
            if resp.status_code < 300:
                run_id = ""
                try:
                    run_id = resp.json().get("runId", "")
                except Exception:
                    pass
                # Mark running — clears lease so expiry won't requeue.
                # Critical: if this fails, we MUST fail the task to prevent
                # duplicate execution (OpenClaw is already running it).
                mark_ok = False
                try:
                    client.mark_running(task_id, run_id)
                    mark_ok = True
                except DinaClientError as me:
                    # Check if already terminal (fast callback race) — safe.
                    try:
                        t = client.get_task(task_id)
                        if t and t.get("status") in ("completed", "failed", "running"):
                            mark_ok = True  # already handled
                    except Exception:
                        pass

                if not mark_ok:
                    print(f"[agent-daemon] CRITICAL: mark_running failed after submit, failing task {task_id}", file=sys.stderr)
                    try:
                        client.task_fail(task_id, "mark_running failed after OpenClaw submit — preventing duplicate execution")
                    except Exception:
                        pass
                    try:
                        client.session_end(session_name)
                    except Exception:
                        pass
                    continue

                print(f"[agent-daemon] Submitted: {task_id} (run_id={run_id or 'none'})", file=sys.stderr)
            else:
                error_msg = f"Hook submission failed: {resp.status_code} {resp.text[:200]}"
                print(f"[agent-daemon] Failed: {task_id} — {error_msg}", file=sys.stderr)
                try:
                    client.task_fail(task_id, error_msg)
                except Exception:
                    pass
                try:
                    client.session_end(session_name)
                except Exception:
                    pass
        except Exception as e:
            error_msg = f"Hook submission error: {e}"
            print(f"[agent-daemon] Failed: {task_id} — {error_msg}", file=sys.stderr)
            try:
                client.task_fail(task_id, error_msg)
            except Exception:
                pass
            try:
                client.session_end(session_name)
            except Exception:
                pass

    # Shutdown
    reconciler_stop.set()
    reconciler.join(timeout=5)
    print("[agent-daemon] Stopped.", file=sys.stderr)
    client.close()


def _reconciler_loop(
    client: DinaClient,
    hook_base: str,
    hook_token: str,
    stop: threading.Event,
    core_url: str = "",
    callback_token: str = "",
) -> None:
    """Background reconciler: checks stale running tasks against OpenClaw ledger.

    Runs every 15 minutes. Handles lost callbacks.
    """
    while not stop.wait(15 * 60):  # 15 minutes
        try:
            # Use internal endpoint (unfiltered by agent_did) so we can
            # reconcile tasks from ANY daemon, not just our own.
            try:
                resp = httpx.get(
                    f"{core_url}/v1/internal/delegated-tasks",
                    params={"status": "running"},
                    headers={"Authorization": f"Bearer {callback_token}"},
                    timeout=15,
                )
                tasks = resp.json().get("tasks", []) if resp.status_code == 200 else []
            except Exception:
                tasks = client.list_tasks(status="running")  # fallback to own tasks
            if not tasks:
                continue

            now = time.time()
            stale_threshold = 24 * 60 * 60  # 24 hours

            for task in tasks:
                # Use updated_at (set when task entered running), not created_at
                # (which could be days earlier if task sat in pending_approval).
                last_updated = task.get("updated_at", 0) or task.get("created_at", 0)
                if now - last_updated < stale_threshold:
                    continue

                task_id = task.get("id", "")
                session_key = f"hook:dina-task:{task_id}"

                # Query OpenClaw background task ledger by session key.
                # Note: /api/v1/tasks is inferred from OpenClaw CLI docs
                # (openclaw tasks show <lookup>). If this endpoint doesn't
                # exist, the reconciler logs the error and moves on — the task
                # stays in running until manually resolved.
                try:
                    resp = httpx.get(
                        f"{hook_base}/api/v1/tasks",
                        params={"sessionKey": session_key},
                        headers={"Authorization": f"Bearer {hook_token}"},
                        timeout=15,
                    )
                    if resp.status_code == 200:
                        oc_tasks = resp.json().get("tasks", [])
                        if not oc_tasks:
                            client.task_fail(task_id, "execution lost: no OpenClaw task found")
                            print(f"[reconciler] Lost: {task_id}", file=sys.stderr)
                        else:
                            oc_task = oc_tasks[0]
                            oc_status = oc_task.get("status", "")
                            if oc_status in ("completed", "ok"):
                                # Stringify result in case it's structured
                                raw_result = oc_task.get("result", "reconciled")
                                if not isinstance(raw_result, str):
                                    import json as _json
                                    raw_result = _json.dumps(raw_result)[:2000]
                                client.task_complete(task_id, raw_result)
                                print(f"[reconciler] Completed: {task_id}", file=sys.stderr)
                            elif oc_status in ("failed", "error", "cancelled", "timeout"):
                                raw_error = oc_task.get("error", f"reconciled: {oc_status}")
                                if not isinstance(raw_error, str):
                                    import json as _json
                                    raw_error = _json.dumps(raw_error)[:2000]
                                client.task_fail(task_id, raw_error)
                                print(f"[reconciler] Failed: {task_id}", file=sys.stderr)
                            # else: still running, do nothing
                except Exception as e:
                    print(f"[reconciler] Error checking {task_id}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[reconciler] Error: {e}", file=sys.stderr)
