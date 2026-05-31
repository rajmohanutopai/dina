"""Stub appointment runner — canned `appointment_status` backend for the
"Dr Carl's Clinic" demo provider (the SECOND service in the two-service
test).

Mirror of `stub_eta_runner.py`, but for a DIFFERENT capability returning
a DIFFERENT result shape, so we can see how a non-transit result renders
on the requester side. The brain's `result_formatter.ts::formatAppointmentStatus`
expects:

    status: "confirmed" | "rescheduled" | "cancelled" | "not_found"
    date:   echoed back (may be empty)
    time:   echoed back (may be empty)
    note:   provider free-text (may be empty)

and produces "📬 Reply from <name>\\nYour appointment on <date> at <time>
is confirmed." — which the mobile `InlineServiceQueryCard` renders via its
GENERIC card body (title = service name, body = that text, handoff footer),
visibly distinct from the bespoke transit ETA card.

Deterministic test stub — no MCP, no network, no LLM. It validates the
dina-agent claim → execute → reply chain for a second capability, not the
accuracy of the data.

Run (paired to the Dr Carl node):
  source venv/bin/activate
  python run_daemon_appt.py
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from dina_cli.agent_runner import RunnerResult

# Demo pacing — hold the canned response so the requester's "asked the
# directory → found the provider → sent → awaiting reply" handoff stepper
# plays before the answer lands. Override with STUB_APPT_DELAY_SECONDS=0
# for fast tests.
_RESPONSE_DELAY_SECONDS = float(os.environ.get("STUB_APPT_DELAY_SECONDS", "7"))

# Canned appointment slot. A real clinic would look the patient up; the
# stub returns a fixed confirmed slot (overridable via env so the demo
# can be re-pointed without editing code).
_APPT_STATUS = os.environ.get("STUB_APPT_STATUS", "confirmed")
_APPT_DATE = os.environ.get("STUB_APPT_DATE", "Tuesday, June 3")
_APPT_TIME = os.environ.get("STUB_APPT_TIME", "2:30 PM")
_APPT_NOTE = os.environ.get(
    "STUB_APPT_NOTE",
    "Please arrive 10 minutes early and bring your insurance card.",
)


class StubAppointmentRunner:
    """AgentRunner that returns a canned appointment_status reply for
    service_query_execution tasks."""

    runner_name = "stub_appt"
    supports_reconciliation = False

    def __init__(self, config: object = None):
        self.config = config

    def validate_config(self) -> None:
        return None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "runner": self.runner_name}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        payload_type = task.get("payload_type", "")
        payload_raw = task.get("payload", "")
        try:
            payload = (
                json.loads(payload_raw)
                if isinstance(payload_raw, str)
                else (payload_raw or {})
            )
        except json.JSONDecodeError:
            payload = {}

        capability = payload.get("capability", "")
        params = payload.get("params", {}) if isinstance(payload.get("params"), dict) else {}

        print(
            f"[stub_appt] claimed task {task.get('id','?')} "
            f"payload_type={payload_type} capability={capability} params={params}",
            flush=True,
        )

        # Alias-aware on the provider side too: the requester canonicalizes
        # before dispatch, so we expect the canonical `appointment_status`.
        if capability not in ("appointment_status", "appointment_query", "appt_status", "booking_status"):
            return RunnerResult(
                state="failed",
                error=f"stub_appt runner only handles appointment_status; got '{capability}'",
            )

        if _RESPONSE_DELAY_SECONDS > 0:
            print(
                f"[stub_appt] holding response {_RESPONSE_DELAY_SECONDS}s (demo pacing)",
                flush=True,
            )
            time.sleep(_RESPONSE_DELAY_SECONDS)

        # Echo back any date/time the requester supplied; otherwise use the
        # canned slot. A provider knows its own schedule, so canned is fine.
        date = params.get("date") if isinstance(params.get("date"), str) and params.get("date") else _APPT_DATE
        time_ = params.get("time") if isinstance(params.get("time"), str) and params.get("time") else _APPT_TIME

        result_payload = {
            "status": _APPT_STATUS,
            "date": date,
            "time": time_,
            "note": _APPT_NOTE,
            "message": "stub_appt_runner (canned test data)",
        }

        return RunnerResult(
            state="completed",
            summary=json.dumps(result_payload),
            metadata={"capability": "appointment_status"},
        )

    def reconcile(self, task: dict) -> RunnerResult | None:
        return None

    def cancel(self, task: dict) -> None:
        return None
