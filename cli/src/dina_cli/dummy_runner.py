"""Dummy runner — a deterministic task executor for debugging the approval gate.

The headless runners (claude/codex/gemini) shell out to an LLM, so what an
agent actually *does* with a task is non-deterministic and hard to debug. The
dummy runner does ONE fixed, fully-logged thing instead, so an expected
approval that goes missing can be isolated to an exact layer.

On every task it claims, it:
  1. Logs the EXACT task envelope + prompt the Home Node handed it. If the
     prompt already contains the health summary, the node leaked locked-vault
     context into the delegated task — the agent never needed to ask, so the
     gate was bypassed at delegation time.
  2. Issues ONE `dina ask` that must cross a sensitive persona (health), and
     logs the full response. Reading the result tells you which layer failed:
       - status == "pending_approval"  → gate FIRED. The device SHOULD be
         showing an approval card right now; if it isn't, the bug is
         UI-surfacing on the device, not the gate.
       - status == "complete" WITH health data → gate did NOT fire for the
         agent caller (authorization bug).
       - prompt/desc already had the data → delegation leak (see #1).

Select it with:  dina agent-daemon --runner dummy
Logs (JSONL) to: $DINA_DUMMY_RUNNER_LOG  (default <config_dir>/dummy_runner.log)
                 and stdout, prefixed `[dummy-runner]`.
Probe query:     $DINA_DUMMY_QUERY  (default: a health-summary request)
Poll cycles:     $DINA_DUMMY_POLL   (default 8 × 3s while pending_approval)
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from .agent_runner import RunnerResult

DEFAULT_QUERY = "Summarize my health conditions and current medications in detail."

# Substrings that should NEVER appear in a delegated task prompt for an agent
# that hasn't been granted health access. Their presence == a locked-vault leak.
_LEAK_MARKERS = (
    "hba1c",
    "blood pressure",
    "diabet",
    "medication",
    "diagnos",
    "allergy",
    "allergic",
    "bpm",
    "mmhg",
    "cholesterol",
    "asthma",
    "prescription",
)


class DummyRunner:
    """Deterministic agent runner for approval-gate diagnosis."""

    runner_name = "dummy"

    def __init__(self, config: Any = None) -> None:
        self._config = config
        self._log_path = os.environ.get("DINA_DUMMY_RUNNER_LOG", "").strip() or self._default_log()

    # ── infra ────────────────────────────────────────────────────────────
    def _default_log(self) -> str:
        base = os.environ.get("DINA_CONFIG_DIR", "").strip() or os.getcwd()
        return os.path.join(base, "dummy_runner.log")

    def _log(self, event: str, **fields: Any) -> None:
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "runner": "dummy",
            "event": event,
            **fields,
        }
        line = json.dumps(rec, default=str, ensure_ascii=False)
        try:
            with open(self._log_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass
        print(f"[dummy-runner] {line}", flush=True)

    # ── AgentRunner protocol ─────────────────────────────────────────────
    def validate_config(self) -> None:
        # No external binary or library needed — always runnable.
        return None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "runner": "dummy", "log": self._log_path}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        self._log(
            "task_received",
            task_id=task.get("id", ""),
            session=session_name,
            description=task.get("description", ""),
            prompt=prompt,
            task=task,
        )

        # Detect a delegation-time leak: locked-vault facts baked into the
        # prompt/description the agent never should have seen un-approved.
        haystack = f"{task.get('description', '')}\n{prompt}".lower()
        leaked = [m for m in _LEAK_MARKERS if m in haystack and m.isascii()]
        if leaked:
            self._log("LEAK_SUSPECTED", markers=leaked,
                      note="locked-vault facts present in delegated prompt before any approval")

        query = os.environ.get("DINA_DUMMY_QUERY", "").strip() or DEFAULT_QUERY

        try:
            from .client import DinaClient

            client = DinaClient(self._config, verbose=True) if self._config is not None else None
        except Exception as exc:  # noqa: BLE001 — log + fail, never crash the daemon
            self._log("client_init_error", error=str(exc))
            return RunnerResult(state="failed", error=f"dummy: client init failed: {exc}")
        if client is None:
            self._log("no_config")
            return RunnerResult(state="failed", error="dummy: no config supplied")

        self._log("probe_ask", query=query, session=session_name)
        try:
            resp = client.ask(query, session=session_name)
        except Exception as exc:  # noqa: BLE001
            self._log("ask_error", error=str(exc))
            return RunnerResult(state="failed", error=f"dummy: ask failed: {exc}")

        status = str(resp.get("status", ""))
        req_id = str(resp.get("request_id", "") or resp.get("id", ""))
        self._log("ask_response", status=status, request_id=req_id, body=resp)

        # While pending_approval, the device should be showing an approval
        # card. Poll so the log records the transition (approve → complete,
        # or expiry).
        if status in ("pending_approval", "in_flight") and req_id:
            cycles = int(os.environ.get("DINA_DUMMY_POLL", "8") or "8")
            for i in range(cycles):
                time.sleep(3)
                try:
                    st = client.ask_status(req_id)
                except Exception as exc:  # noqa: BLE001
                    self._log("poll_error", i=i, error=str(exc))
                    break
                cur = str(st.get("status", ""))
                self._log("ask_poll", i=i, status=cur, body=st)
                if cur in ("complete", "failed", "expired"):
                    status, resp = cur, st
                    break

        verdict = self._verdict(status, leaked, resp)
        self._log("verdict", **verdict)
        return RunnerResult(
            state="completed",
            summary=verdict["summary"],
            metadata={"status": status, "leaked": leaked, "verdict": verdict},
        )

    def _verdict(self, status: str, leaked: list[str], resp: dict) -> dict[str, Any]:
        if leaked:
            return {
                "layer": "delegation_leak",
                "summary": "LEAK: locked-vault facts were in the delegated prompt; "
                "gate bypassed before the agent asked.",
            }
        if status == "pending_approval":
            return {
                "layer": "gate_ok_check_device_ui",
                "summary": "GATE FIRED (pending_approval). The device should be showing "
                "an approval card — if not, the bug is UI surfacing on the device.",
            }
        if status == "complete":
            answer = ""
            ans = resp.get("answer")
            if isinstance(ans, dict):
                answer = str(ans.get("text", ""))
            answer = answer or str(resp.get("text", ""))
            return {
                "layer": "gate_bypassed_or_no_sensitive_data",
                "summary": "Returned COMPLETE with no approval. Inspect the answer: if it "
                "contains health data, the gate did not fire for the agent.",
                "answer_preview": answer[:280],
            }
        return {"layer": "unknown", "summary": f"Unexpected terminal status: {status!r}"}

    def reconcile(self, task: dict) -> RunnerResult | None:
        return None

    def cancel(self, task: dict) -> None:
        return None

    @property
    def supports_reconciliation(self) -> bool:
        return False
