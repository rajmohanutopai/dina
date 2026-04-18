"""Appointment-status MCP — demo implementation.

Exposes a single tool: ``check_appointment(patient_ref, date)``.

Returns a structured status matching the ``appointment_status``
capability schema:

  {
    "status": "confirmed" | "rescheduled" | "cancelled" | "not_found",
    "patient_ref": "alonso",
    "date": "2026-04-19",
    "time": "15:00",
    "note": "free-form confirmation text"
  }

Rules (deterministic so tests are reliable):

- Any non-empty ``patient_ref`` + ``date`` → ``confirmed`` with the
  submitted date echoed back.
- Empty patient_ref → ``not_found``.
- ``patient_ref`` starting with "rescheduled-" → ``rescheduled`` with a
  new date bumped one day later (for the scenario test where the test
  wants to verify the rescheduled path renders correctly).
- ``patient_ref`` starting with "cancelled-" → ``cancelled``.

Not a real appointment booking system — the demo is about the routing
pattern, not about replacing Calendly.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastmcp import FastMCP


mcp = FastMCP("appointment")


def _parse_date(date_str: str) -> datetime | None:
    """Accept either ``YYYY-MM-DD`` or ``Month Dth, YYYY`` strings."""
    if not date_str:
        return None
    date_str = date_str.strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%B %d, %Y", "%B %d %Y"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


@mcp.tool()
def check_appointment(patient_ref: str, date: str = "", time: str = "") -> dict[str, Any]:
    """Return the live confirmation status for a patient's appointment.

    Parameters
    ----------
    patient_ref
        Identifier for the patient the requester is asking about. In a
        real system this would be a booking ID or a DID; for the demo,
        any non-empty string counts as a known patient.
    date
        Expected appointment date in ``YYYY-MM-DD`` or ``Month Dth,
        YYYY`` form. Echoed back on the response.
    time
        Optional time string (``HH:MM`` or ``H:MMpm``) to echo back.

    Returns
    -------
    dict
        Matches the published ``appointment_status`` result schema:
        ``{status, patient_ref, date, time, note}``.
    """
    patient_ref = (patient_ref or "").strip()
    if not patient_ref:
        return {
            "status": "not_found",
            "patient_ref": "",
            "date": date,
            "time": time,
            "note": "No patient reference supplied.",
        }

    # Special-case prefixes so tests can exercise each status branch.
    if patient_ref.startswith("cancelled-"):
        return {
            "status": "cancelled",
            "patient_ref": patient_ref,
            "date": date,
            "time": time,
            "note": "Appointment cancelled — please reschedule via the clinic.",
        }

    if patient_ref.startswith("rescheduled-"):
        parsed = _parse_date(date)
        new_date = (parsed + timedelta(days=1)).strftime("%Y-%m-%d") if parsed else date
        return {
            "status": "rescheduled",
            "patient_ref": patient_ref,
            "date": new_date,
            "time": time,
            "note": f"Moved from {date} to {new_date}.",
        }

    # Default: confirmed.
    return {
        "status": "confirmed",
        "patient_ref": patient_ref,
        "date": date,
        "time": time,
        "note": f"See you on {date or 'the scheduled date'}.",
    }
