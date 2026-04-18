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
        summary, structured = _extract_result(result)
        payload: dict = {"result": summary}
        if structured is not None:
            # Send structured result on a dedicated field so the bridge can
            # validate it against the schema contract without parsing a
            # truncated text summary. No byte cap here — the Core callback
            # accepts JSON of any size Go's net/http will read.
            payload["result_json"] = structured
        _post_callback(task_id, "complete", payload)
    else:
        _post_callback(task_id, "fail", {"error": error or f"agent ended with status: {status}"})


def _extract_result(result: object) -> tuple[str, object | None]:
    """Return ``(summary, structured)`` for the callback body.

    ``summary`` is a short human-readable string suitable for UI/logs.
    ``structured`` is the full agent output as a JSON-serialisable object
    (dict/list), or ``None`` when the agent only produced free-form text.
    """
    if isinstance(result, dict):
        return json.dumps(result)[:2000], result
    if isinstance(result, list):
        return json.dumps(result)[:2000], result
    if isinstance(result, str):
        # A string may itself be a serialised dict/list from upstream —
        # parse it so the bridge sees structured data where possible.
        try:
            parsed = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if isinstance(parsed, (dict, list)):
            return json.dumps(parsed)[:2000], parsed
        return result[:2000], None
    return str(result)[:2000], None


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
