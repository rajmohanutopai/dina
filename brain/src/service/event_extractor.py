"""Temporal event extraction — derives reminders from classified content.

Extracts explicit temporal events (invoices, appointments, birthdays)
from vault item content and creates reminder records with full source
lineage. Only extracts when dates are explicit in text — no LLM guessing.

No imports from adapter/ — only domain types and sibling services.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

log = logging.getLogger(__name__)

# Date patterns (explicit dates only — no "next week" or "soon").
_DATE_PATTERNS = [
    # "March 21, 2026" or "March 21 2026"
    re.compile(r"\b(\w+ \d{1,2},?\s*\d{4})\b"),
    # "21/03/2026" or "21-03-2026"
    re.compile(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b"),
    # "2026-03-21"
    re.compile(r"\b(\d{4}-\d{2}-\d{2})\b"),
    # Note: weekday patterns ("by Friday") are NOT included because the
    # parser cannot convert them to timestamps. Only explicit dates work.
]

# Event type patterns.
_PAYMENT_PATTERNS = re.compile(
    r"\b(?:invoice|payment|bill|due|overdue|amount|balance|owe|payable)\b",
    re.IGNORECASE,
)

_APPOINTMENT_PATTERNS = re.compile(
    r"\b(?:appointment|meeting|consultation|visit|check-?up|session|call|interview)\b",
    re.IGNORECASE,
)

_BIRTHDAY_PATTERNS = re.compile(
    r"\b(?:birthday|birth\s*day|bday|born|anniversary)\b",
    re.IGNORECASE,
)


class EventExtractor:
    """Extracts temporal events from classified content.

    Parameters
    ----------
    core:
        HTTP client for dina-core (reminder creation).
    """

    def __init__(self, core: Any) -> None:
        self._core = core

    async def extract_and_create(
        self, item: dict, persona: str, vault_item_id: str = "",
    ) -> int:
        """Extract events from item content and create reminders.

        Returns the count of reminders created.
        """
        text = item.get("body", item.get("body_text", item.get("summary", "")))
        if not text or len(text) < 10:
            return 0

        events = self._extract_events(text, item)
        created = 0

        for event in events:
            try:
                # Only create reminders with explicit parsed dates.
                # No fallback to now+24h — if we can't parse a date, skip.
                trigger_at = _parse_date_from_text(text)
                if not trigger_at:
                    log.debug("event_extractor.no_date_parsed", extra={
                        "kind": event["kind"],
                        "summary": item.get("summary", "")[:50],
                    })
                    continue

                reminder = {
                    "type": "",  # recurrence pattern (empty = one-time)
                    "message": event["message"],
                    "trigger_at": trigger_at,
                    "metadata": "{}",
                    "source_item_id": vault_item_id or item.get("staging_id", item.get("id", "")),
                    "source": item.get("source", ""),
                    "persona": persona,
                    "kind": event["kind"],
                }
                await self._core.store_reminder(reminder)
                created += 1
            except Exception as exc:
                log.debug("event_extractor.create_failed", extra={"error": str(exc)})

        return created

    def _extract_events(self, text: str, item: dict) -> list[dict]:
        """Extract temporal events from text. Returns list of event dicts."""
        events: list[dict] = []

        # Check for payment-related events.
        if _PAYMENT_PATTERNS.search(text) and _has_date(text):
            events.append({
                "kind": "payment_due",
                "message": _build_message("Payment due", text, item),
            })

        # Check for appointment-related events.
        if _APPOINTMENT_PATTERNS.search(text) and _has_date(text):
            events.append({
                "kind": "appointment",
                "message": _build_message("Appointment", text, item),
            })

        # Check for birthday mentions (must also have an explicit date).
        if _BIRTHDAY_PATTERNS.search(text) and _has_date(text):
            events.append({
                "kind": "birthday",
                "message": _build_message("Birthday", text, item),
            })

        return events


def _has_date(text: str) -> bool:
    """Check if text contains an explicit date."""
    return any(p.search(text) for p in _DATE_PATTERNS)


def _parse_date_from_text(text: str) -> int:
    """Try to parse an explicit date from text. Returns Unix timestamp or 0."""
    import datetime as _dt

    # Try ISO format: 2026-03-21
    m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if m:
        try:
            dt = _dt.datetime.strptime(m.group(1), "%Y-%m-%d")
            dt = dt.replace(hour=9, tzinfo=_dt.timezone.utc)  # default 9am UTC
            return int(dt.timestamp())
        except ValueError:
            pass

    # Try "Month DD, YYYY": March 21, 2026
    m = re.search(r"\b(\w+ \d{1,2},?\s*\d{4})\b", text)
    if m:
        for fmt in ("%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y"):
            try:
                dt = _dt.datetime.strptime(m.group(1).replace(",", ", ").strip(), fmt)
                dt = dt.replace(hour=9, tzinfo=_dt.timezone.utc)
                return int(dt.timestamp())
            except ValueError:
                continue

    # Try DD/MM/YYYY or DD-MM-YYYY
    m = re.search(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b", text)
    if m:
        for fmt in ("%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y"):
            try:
                dt = _dt.datetime.strptime(m.group(1), fmt)
                dt = dt.replace(hour=9, tzinfo=_dt.timezone.utc)
                return int(dt.timestamp())
            except ValueError:
                continue

    return 0


def _build_message(prefix: str, text: str, item: dict) -> str:
    """Build a reminder message from content."""
    summary = item.get("summary", "")
    sender = item.get("sender", "")
    if summary:
        msg = f"{prefix}: {summary}"
    else:
        msg = f"{prefix}: {text[:100]}"
    if sender:
        msg += f" (from {sender})"
    return msg
