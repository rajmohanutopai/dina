"""OpenClaw agent_end hook — posts terminal status back to Dina Core.

This module is installed into OpenClaw's runtime as a plugin/hook,
NOT imported by the Dina MCP server. It runs in OpenClaw's process.

Setup: Copy to OpenClaw's hooks directory and configure in openclaw.json:
  hooks.plugins.dina-callback.path = "/path/to/openclaw_hook.py"

Environment:
  DINA_CORE_CALLBACK_URL  — e.g. http://host.docker.internal:18100
  DINA_HOOK_CALLBACK_TOKEN — Bearer token for /v1/internal/workflow-tasks/

The hook fires on agent_end for sessions with key starting "hook:dina-task:".
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error

CALLBACK_URL = os.environ.get("DINA_CORE_CALLBACK_URL", "")
CALLBACK_TOKEN = os.environ.get("DINA_HOOK_CALLBACK_TOKEN", "")
SESSION_PREFIX = "hook:dina-task:"


def on_agent_end(event: dict) -> None:
    """Called by OpenClaw runtime when an agent run ends.

    Args:
        event: OpenClaw agent_end event payload containing:
            - sessionKey: the session identifier
            - status: "ok", "error", "timeout", "cancelled"
            - result: agent output (if completed)
            - error: error message (if failed)
    """
    session_key = event.get("sessionKey", "")
    if not session_key.startswith(SESSION_PREFIX):
        return  # not a Dina task

    task_id = session_key[len(SESSION_PREFIX):]
    if not task_id:
        return

    status = event.get("status", "")
    result = event.get("result", "")
    error = event.get("error", "")

    if not CALLBACK_URL or not CALLBACK_TOKEN:
        print(f"[dina-hook] WARN: callback not configured for task {task_id}", file=sys.stderr)
        return

    if status in ("ok", "completed"):
        _post_callback(task_id, "complete", {"result": _extract_result(result)})
    else:
        _post_callback(task_id, "fail", {"error": error or f"agent ended with status: {status}"})


def _extract_result(result: object) -> str:
    """Extract result as JSON string when possible, text otherwise.

    Preserves structured data for the task completion → D2D response bridge.
    The bridge reads result_summary and tries to parse it as JSON.
    """
    if isinstance(result, dict):
        # Preserve structured data as JSON string.
        return json.dumps(result)[:4000]
    if isinstance(result, str):
        # Try to parse as JSON — might be a serialized dict.
        try:
            parsed = json.loads(result)
            if isinstance(parsed, dict):
                return json.dumps(parsed)[:4000]
        except (json.JSONDecodeError, TypeError):
            pass
        return result[:4000]
    return str(result)[:4000]


def _post_callback(task_id: str, action: str, payload: dict) -> None:
    """POST terminal status to Dina Core with retry."""
    url = f"{CALLBACK_URL}/v1/internal/workflow-tasks/{task_id}/{action}"
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {CALLBACK_TOKEN}",
        "Content-Type": "application/json",
    }

    delays = [1, 5, 15]  # exponential backoff
    for attempt, delay in enumerate(delays, 1):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status < 300:
                    print(f"[dina-hook] {action}: task {task_id} (attempt {attempt})", file=sys.stderr)
                    return
                print(f"[dina-hook] WARN: {action} returned {resp.status} for {task_id}", file=sys.stderr)
        except urllib.error.HTTPError as e:
            print(f"[dina-hook] WARN: {action} HTTP {e.code} for {task_id} (attempt {attempt})", file=sys.stderr)
        except Exception as e:
            print(f"[dina-hook] WARN: {action} error for {task_id}: {e} (attempt {attempt})", file=sys.stderr)

        if attempt < len(delays):
            time.sleep(delay)

    print(f"[dina-hook] ERROR: {action} failed after {len(delays)} attempts for {task_id}", file=sys.stderr)
