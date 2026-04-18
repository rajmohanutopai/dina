"""Unit tests for service_query formatters.

Traces to TEST_PLAN §28.3 (Requester Orchestrator). The formatters
convert provider responses into user-visible text. Per-capability
formatters exist for `eta_query` (transit) and `appointment_status`
(appointment check); the generic formatter is the fallback.
"""
from __future__ import annotations

import json

from src.service.service_query import (
    _FORMATTERS,
    _format_appointment_status,
    _format_generic,
    format_service_query_result,
)


def _success(capability: str, service_name: str, result: dict) -> dict:
    return {
        "response_status": "success",
        "capability": capability,
        "service_name": service_name,
        "result": result,
    }


class TestAppointmentStatusFormatter:
    # TST-BRAIN-874 — confirmed with full date + time
    def test_confirmed_full_date_time(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "confirmed", "date": "2026-04-19", "time": "15:00",
             "patient_ref": "self", "note": ""},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        # Provenance-first: provider name in header; body reads cleanly
        # on the second line.
        assert msg == (
            "📬 Reply from Dr Carl's Clinic\n"
            "Your appointment on 2026-04-19 at 15:00 is confirmed."
        )

    # TST-BRAIN-875 — confirmed with empty date/time degrades gracefully
    def test_confirmed_empty_date_time(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "confirmed", "date": "", "time": "",
             "patient_ref": "self", "note": "See you on the scheduled date."},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        # No empty quotes, no awkward spacing, header still carries
        # the attribution.
        assert msg == (
            "📬 Reply from Dr Carl's Clinic\nYour appointment is confirmed."
        )

    def test_confirmed_date_only(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "confirmed", "date": "2026-04-19", "time": "",
             "patient_ref": "self", "note": ""},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert msg == (
            "📬 Reply from Dr Carl's Clinic\n"
            "Your appointment on 2026-04-19 is confirmed."
        )

    # TST-BRAIN-876 — rescheduled with new date
    def test_rescheduled_with_new_date(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "rescheduled", "date": "2026-04-20", "time": "10:00",
             "patient_ref": "self", "note": "Moved from 2026-04-19 to 2026-04-20."},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert msg.startswith("📬 Reply from Dr Carl's Clinic\n")
        assert "rescheduled" in msg.lower()
        assert "2026-04-20" in msg
        assert "10:00" in msg
        assert "Moved from" in msg  # note preserved

    # TST-BRAIN-877 — cancelled includes provider note
    def test_cancelled_includes_note(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "cancelled", "date": "", "time": "",
             "patient_ref": "self",
             "note": "Appointment cancelled — please reschedule via the clinic."},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert msg.startswith("📬 Reply from Dr Carl's Clinic\n")
        assert "cancelled" in msg.lower()
        assert "reschedule via the clinic" in msg

    # TST-BRAIN-878 — not_found produces useful message
    def test_not_found(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "not_found", "date": "", "time": "",
             "patient_ref": "", "note": "No patient reference supplied."},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert msg == (
            "📬 Reply from Dr Carl's Clinic\n"
            "No record of your appointment was found."
        )

    # TST-BRAIN-879 — never returns raw JSON
    def test_never_returns_raw_json(self) -> None:
        """Regression: the pre-fix output was literal JSON like
        '{"date": "", "note": ...}' — ugly and hard to read. Formatter
        must never fall back to JSON dump.
        """
        result = {"status": "confirmed", "date": "", "time": "",
                  "patient_ref": "self", "note": "See you on the scheduled date."}
        details = _success("appointment_status", "Dr Carl's Clinic", result)
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert "{" not in msg
        assert "}" not in msg
        assert '"' not in msg  # no JSON-style quoting

    # TST-BRAIN-880 — unknown status degrades without dumping JSON
    def test_unknown_status_degrades_gracefully(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "mysterious_new_status", "date": "", "time": "",
             "patient_ref": "self", "note": ""},
        )
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert msg.startswith("📬 Reply from Dr Carl's Clinic\n")
        # No JSON in output.
        assert "{" not in msg
        assert "mysterious_new_status" in msg

    # TST-BRAIN-881 — JSON-string result is parsed before formatting
    def test_string_result_parsed_as_json(self) -> None:
        """Workflow events sometimes arrive with `result` as a JSON string
        (round-tripped through storage). Formatter parses it so users see
        the structured message, not the raw JSON string.
        """
        result_str = json.dumps({"status": "confirmed", "date": "2026-04-19",
                                 "time": "15:00", "patient_ref": "self",
                                 "note": ""})
        details = _success("appointment_status", "Dr Carl's Clinic", result_str)
        # Pass the string result through.
        msg = _format_appointment_status(details, "Dr Carl's Clinic")
        assert "2026-04-19" in msg
        assert "15:00" in msg
        assert "confirmed" in msg
        assert msg.startswith("📬 Reply from Dr Carl's Clinic\n")


class TestFormatterRegistry:
    # TST-BRAIN-882 — appointment_status wired into the registry
    def test_appointment_status_registered(self) -> None:
        assert _FORMATTERS.get("appointment_status") is _format_appointment_status

    # TST-BRAIN-883 — end-to-end: format_service_query_result routes via registry
    def test_format_service_query_result_routes_to_appointment_formatter(self) -> None:
        details = _success(
            "appointment_status", "Dr Carl's Clinic",
            {"status": "confirmed", "date": "2026-04-19", "time": "15:00",
             "patient_ref": "self", "note": ""},
        )
        msg = format_service_query_result(details)
        # Should come from _format_appointment_status, not _format_generic.
        assert "response received" not in msg  # generic's signature
        assert "confirmed" in msg
        assert "📬 Reply from" in msg  # provenance header always present
