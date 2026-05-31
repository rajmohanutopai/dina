"""Unit tests for EventExtractor — temporal event extraction from content.

Tests extraction of invoices, appointments, and birthdays from
classified vault content, with source lineage on created reminders.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from src.service.event_extractor import EventExtractor


@pytest.fixture
def core():
    c = AsyncMock()
    c.store_reminder.return_value = "rem-001"
    return c


@pytest.fixture
def extractor(core):
    return EventExtractor(core=core)


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0040", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "01", "title": "invoice_date_creates_payment_reminder"}
async def test_invoice_date_creates_payment_reminder(extractor, core):
    """Invoice with explicit date → payment_due reminder."""
    item = {
        "type": "email",
        "source": "gmail",
        "summary": "Invoice from XYZ Corp",
        "body": "Invoice ₹3,500 due by 2026-03-21. Please pay promptly.",
        "sender": "billing@xyz.com",
        "staging_id": "stg-inv-001",
    }
    count = await extractor.extract_and_create(item, "financial", "stg-inv-001")
    assert count >= 1
    core.store_reminder.assert_awaited()
    reminder = core.store_reminder.call_args[0][0]
    assert reminder["kind"] == "payment_due"
    assert reminder["source_item_id"] == "stg-inv-001"
    assert reminder["persona"] == "financial"


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0041", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "02", "title": "appointment_creates_reminder"}
async def test_appointment_creates_reminder(extractor, core):
    """Appointment with date → appointment reminder."""
    item = {
        "type": "email",
        "summary": "Doctor appointment",
        "body": "Your appointment with Dr. Sharma is on March 25, 2026 at 10am.",
        "sender": "clinic@example.com",
    }
    count = await extractor.extract_and_create(item, "health")
    assert count >= 1
    core.store_reminder.assert_awaited()
    reminder = core.store_reminder.call_args[0][0]
    assert reminder["kind"] == "appointment"
    assert reminder["persona"] == "health"


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0042", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "03", "title": "no_dates_no_reminders"}
async def test_no_dates_no_reminders(extractor, core):
    """Content without explicit dates → no reminders."""
    item = {
        "type": "email",
        "summary": "Hello",
        "body": "Just wanted to say hi. Hope you are well.",
    }
    count = await extractor.extract_and_create(item, "general")
    assert count == 0
    core.store_reminder.assert_not_awaited()


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0043", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "04", "title": "birthday_with_date_creates_reminder"}
async def test_birthday_with_date_creates_reminder(extractor, core):
    """Birthday with explicit date → birthday reminder."""
    item = {
        "type": "email",
        "summary": "Sancho's birthday",
        "body": "Sancho's birthday party is on March 25, 2026. Don't miss it!",
        "sender": "friend@example.com",
    }
    count = await extractor.extract_and_create(item, "social")
    assert count >= 1
    reminder = core.store_reminder.call_args[0][0]
    assert reminder["kind"] == "birthday"


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0044", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "05", "title": "source_lineage_present"}
async def test_source_lineage_present(extractor, core):
    """Reminder includes source lineage fields."""
    item = {
        "type": "email",
        "source": "gmail",
        "summary": "Meeting reminder",
        "body": "Team meeting on 2026-04-01 at 3pm.",
        "sender": "boss@company.com",
        "staging_id": "stg-meet-001",
    }
    await extractor.extract_and_create(item, "work", "vault-item-123")
    reminder = core.store_reminder.call_args[0][0]
    assert reminder["source_item_id"] == "vault-item-123"
    assert reminder["source"] == "gmail"
    assert reminder["persona"] == "work"


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0045", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "06", "title": "birthday_without_date_skipped"}
async def test_birthday_without_date_skipped(extractor, core):
    """Birthday without explicit date → no reminder (date required)."""
    item = {
        "type": "email",
        "summary": "Sancho's birthday",
        "body": "Don't forget Sancho's birthday party this weekend!",
        "sender": "friend@example.com",
    }
    count = await extractor.extract_and_create(item, "social")
    assert count == 0
    core.store_reminder.assert_not_awaited()


@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0046", "section": "05", "sectionName": "Sync Engine (Ingestion Pipeline)", "subsection": "01", "scenario": "07", "title": "reminder_payload_valid_for_core"}
async def test_reminder_payload_valid_for_core(extractor, core):
    """Reminder payload must be accepted by Core handler.

    Validates: trigger_at > 0, kind is set, type is empty or valid recurrence.
    This test would have caught Finding 1 (type="" rejected by Core).
    """
    item = {
        "type": "email",
        "source": "gmail",
        "summary": "Invoice from XYZ",
        "body": "Invoice ₹3,500 due by 2026-03-21.",
        "sender": "billing@xyz.com",
    }
    await extractor.extract_and_create(item, "financial", "vault-inv-001")
    assert core.store_reminder.await_count >= 1

    for call in core.store_reminder.await_args_list:
        reminder = call.args[0]
        # Core requires: trigger_at > 0
        assert reminder["trigger_at"] > 0, f"trigger_at must be positive: {reminder}"
        # Core requires: type or kind (type="" is ok if kind is set)
        assert reminder["kind"] != "", f"kind must be set: {reminder}"
        # type must be valid recurrence or empty
        assert reminder["type"] in ("", "daily", "weekly", "monthly"), (
            f"type must be valid recurrence: {reminder}"
        )
