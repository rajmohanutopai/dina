"""Persistent agent daemon — claims and executes delegated tasks.

Polls Core for queued tasks, launches OpenClaw to execute them,
and reports results back. Separate from dina mcp-server (which is
an ephemeral tool server spawned by OpenClaw).

Usage: dina agent-daemon [--poll-interval 15] [--lease-duration 300]
"""

from __future__ import annotations

import signal
import sys
import threading
import time

from .client import DinaClient, DinaClientError
from .config import load_config


def run_daemon(poll_interval: int = 15, lease_duration: int = 300) -> None:
    """Main daemon loop: claim → execute → report."""
    cfg = load_config()
    client = DinaClient(cfg)

    # OpenClaw client setup — fail fast if not configured
    openclaw = _build_openclaw_client(cfg, client)
    if openclaw is None:
        print("[agent-daemon] FATAL: OpenClaw not configured.", file=sys.stderr)
        print("  Set DINA_OPENCLAW_URL and DINA_OPENCLAW_TOKEN, or configure via dina configure.", file=sys.stderr)
        sys.exit(1)

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
    print(f"[agent-daemon] Device: {client._identity.did()}", file=sys.stderr)

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
        idempotency_key = task.get("idempotency_key", "")

        print(f"[agent-daemon] Claimed: {task_id} — {description[:80]}", file=sys.stderr)

        # End any orphaned session from a prior crashed attempt (best-effort).
        # This covers the case where session teardown failed on Complete/Fail.
        try:
            client.session_end(session_name)
        except Exception:
            pass  # normal — no prior session exists on first claim

        # Start fresh Dina session — required for MCP tool context
        try:
            client.session_start(name=session_name)
        except DinaClientError as e:
            print(f"[agent-daemon] Session start failed: {e} — failing task", file=sys.stderr)
            try:
                client.task_fail(task_id, f"Session start failed: {e}")
            except Exception:
                pass
            continue

        # Heartbeat thread
        heartbeat_stop = threading.Event()
        heartbeat_thread = threading.Thread(
            target=_heartbeat_loop,
            args=(client, task_id, lease_duration, heartbeat_stop),
            daemon=True,
        )
        heartbeat_thread.start()

        # Execute via OpenClaw
        result_summary = ""
        error_msg = ""
        try:
            if openclaw is not None:
                result = openclaw.run_task(
                    description,
                    dina_session=session_name,
                    idempotency_key=idempotency_key,
                )
                if isinstance(result, dict):
                    # OpenClaw returns varying shapes — try common fields
                    result_summary = (
                        result.get("summary", "")
                        or result.get("content", "")
                        or result.get("text", "")
                        or str(result)[:500]
                    )
                else:
                    result_summary = str(result)[:500]
            else:
                # Unreachable — daemon exits early if OpenClaw is None
                error_msg = "OpenClaw not configured"
        except Exception as e:
            error_msg = str(e)

        # Stop heartbeat
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=5)

        # Report result
        try:
            if error_msg:
                print(f"[agent-daemon] Failed: {task_id} — {error_msg[:100]}", file=sys.stderr)
                client.task_fail(task_id, error_msg)
            else:
                print(f"[agent-daemon] Completed: {task_id}", file=sys.stderr)
                client.task_complete(task_id, result_summary[:1000])
        except DinaClientError as e:
            print(f"[agent-daemon] Report error: {e}", file=sys.stderr)

        # Session end is best-effort — Complete/Fail already handle it server-side
        try:
            client.session_end(session_name)
        except Exception:
            pass

    print("[agent-daemon] Stopped.", file=sys.stderr)
    client.close()


def _heartbeat_loop(
    client: DinaClient, task_id: str, lease_duration: int, stop: threading.Event
) -> None:
    """Send heartbeats every 60s until stopped."""
    interval = min(60, lease_duration // 3)
    while not stop.wait(interval):
        try:
            client.task_heartbeat(task_id, lease_seconds=lease_duration)
        except Exception:
            pass  # best-effort


def _build_openclaw_client(cfg: object, client: DinaClient) -> object | None:
    """Build an OpenClawClient if configured."""
    try:
        from .openclaw import OpenClawClient
    except ImportError:
        return None

    url = getattr(cfg, "openclaw_url", "") or ""
    token = getattr(cfg, "openclaw_token", "") or ""
    if not url or not token:
        print("[agent-daemon] OpenClaw not configured — tasks will fail", file=sys.stderr)
        return None

    identity = client._identity
    device_did = identity.did()
    device_name = getattr(cfg, "device_name", "") or "agent-daemon"

    def sign_fn(data: bytes) -> bytes:
        return bytes.fromhex(identity.sign_data(data))

    return OpenClawClient(
        url, token=token,
        device_id=device_did,
        device_name=device_name,
        sign_fn=sign_fn,
    )
