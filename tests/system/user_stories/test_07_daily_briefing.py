"""User Story 07: The Daily Briefing — silence-first notification triage.

SEQUENTIAL TEST — tests MUST run in order (00 → 04).
Each test builds on state from the previous one.

Story
-----
Alonso's day is full of low-priority noise: a news article his friend
shared, a social media mention, a product price drop, a reminder about
a podcast episode. None of these require immediate action.

Dina enforces **Silence First** (Law 1) — she queues all of these as
Tier 3 (Engagement) items in a briefing queue. They will surface during
Alonso's daily briefing, not as interrupts.

But then: an autonomous agent attempts to transfer money from Alonso's
account. This is a **Fiduciary** event (Tier 1) — silence here would
cause harm. Dina flags it immediately with HIGH risk, requiring human
approval before proceeding.

The three priority tiers:

  1. **Fiduciary** (Tier 1) — Interrupt immediately. Silence causes harm.
     Examples: money transfer, credential sharing, legal deadlines.

  2. **Solicited** (Tier 2) — Notify at next check-in. User asked for this.
     Examples: search results, product comparisons, scheduled reminders.

  3. **Engagement** (Tier 3) — Save for daily briefing. Silence merely
     misses an opportunity. Examples: news, social updates, price drops.

This is the opposite of every notification system today. Your phone
buzzes for everything. Dina buzzes for almost nothing — and when she
does, you know it matters.

Maps to Suite 17: Daily Briefing & Notification Triage.

Pipeline
--------
::

  Low-priority events arrive throughout the day
    → Dina classifies each as Tier 3 (Engagement)
    → Stores in vault KV as briefing_queue entries
    → No notification, no buzz, no interrupt
                    |
  Fiduciary event arrives (transfer_money)
    → POST /v1/agent/validate {action: transfer_money}
    → Guardian classifies: HIGH risk, flag_for_review
    → Interrupt: user sees this immediately
                    |
  Daily briefing time
    → GET /v1/vault/kv/briefing_queue
    → Retrieve all queued Tier 3 items
    → Present as a calm summary, not a barrage
    → Clear the queue after delivery
"""

from __future__ import annotations

import json

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestDailyBriefing:
    """The Daily Briefing: silence-first notification triage."""

    # ==================================================================
    # test_00: Store low-priority items in vault for briefing
    # ==================================================================

    # TST-USR-060
    def test_00_store_context_for_briefing(
        self, alonso_core, admin_headers,
    ):
        """Store several low-priority items (news, social updates) in vault.

        These represent the kind of noise that fills a modern notification
        tray: a friend shared a news article, someone mentioned Alonso
        on social media, a product Alonso was watching dropped in price.

        None of these require immediate action. Dina classifies them as
        Tier 3 (Engagement) and queues them for the daily briefing.

        In a full system, these would arrive via MCP connectors (Gmail,
        Twitter, RSS) and be triaged automatically by Brain. Here we
        store them directly to test the queuing and retrieval path.
        """
        briefing_items = [
            {
                "Type": "note",
                "Source": "news",
                "Summary": "Tech article shared by Sancho about AI regulation",
                "BodyText": (
                    "Sancho shared a Financial Times article about new EU AI "
                    "regulation proposals. Discusses licensing requirements for "
                    "autonomous agents. Relevant to Alonso's work but not urgent."
                ),
            },
            {
                "Type": "note",
                "Source": "social",
                "Summary": "Social media mention — tagged in Cervantes reading group",
                "BodyText": (
                    "Alonso was mentioned in the Cervantes Reading Group post "
                    "about next month's meetup. The group is reading 'The Exemplary "
                    "Novels.' No action needed — just awareness."
                ),
            },
            {
                "Type": "note",
                "Source": "price_tracker",
                "Summary": "Price drop on ergonomic standing desk — now 12K INR",
                "BodyText": (
                    "The FlexiSpot E7 standing desk Alonso was watching dropped "
                    "from 18K to 12K INR on Amazon. Deal expires in 3 days. "
                    "Not urgent but a good opportunity."
                ),
            },
        ]

        stored_ids = []
        for item in briefing_items:
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={"persona": "general", "item": item},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201), (
                f"Store failed: {r.status_code} {r.text[:200]}"
            )
            stored_ids.append(r.json().get("id", ""))

        _state["briefing_item_ids"] = stored_ids
        assert len(stored_ids) == 3
        print(f"\n  [briefing] Stored {len(stored_ids)} low-priority items")

    # ==================================================================
    # test_01: Fiduciary event interrupts immediately
    # ==================================================================

    # TST-USR-061
    def test_01_fiduciary_event_interrupts(
        self, alonso_core, admin_headers,
    ):
        """POST /v1/agent/validate with action=transfer_money.

        A fiduciary event is the exception to Silence First. When an
        autonomous agent attempts to move money, Dina MUST interrupt.
        Silence here causes harm — the money could be gone before the
        next daily briefing.

        The Guardian classifies transfer_money as HIGH risk and flags
        it for immediate human review. This is the safety layer: the
        agent cannot move money without Alonso's explicit approval.

        Expected: risk=HIGH, action=flag_for_review, requires_approval=True.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkFinanceBot001",
                "action": "transfer_money",
                "target": "vendor_account_XYZ",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Validate failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        # Transfer money is HIGH risk — must be flagged, not auto-approved.
        assert data.get("risk") == "HIGH", (
            f"Expected HIGH risk for transfer_money, got: {data.get('risk')}"
        )
        assert data.get("action") == "flag_for_review", (
            f"Expected flag_for_review, got: {data.get('action')}"
        )
        assert data.get("requires_approval") is True, (
            f"Expected requires_approval=True, got: {data.get('requires_approval')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )

        _state["fiduciary_response"] = data
        print(
            f"\n  [briefing] Fiduciary event (transfer_money): "
            f"risk={data.get('risk')}, action={data.get('action')}"
        )

    # ==================================================================
    # test_02: Engagement event queued via vault KV
    # ==================================================================

    # TST-USR-062
    def test_02_engagement_event_queued(
        self, alonso_core, admin_headers,
    ):
        """POST /v1/vault/kv/briefing_queue to store a Tier 3 event.

        Dina uses the vault KV store as a lightweight queue for events
        that do not warrant interrupting the user. Each entry is a JSON
        blob containing the event summary, source, and timestamp.

        This is how Dina implements Silence First at the storage layer:
        low-priority items are written to a key-value slot, not pushed
        as notifications. The user retrieves them at briefing time.
        """
        queue_payload = {
            "items": [
                {
                    "source": "news",
                    "summary": "EU AI regulation article shared by Sancho",
                    "tier": 3,
                    "timestamp": "2026-03-07T08:30:00Z",
                },
                {
                    "source": "social",
                    "summary": "Tagged in Cervantes reading group post",
                    "tier": 3,
                    "timestamp": "2026-03-07T10:15:00Z",
                },
                {
                    "source": "price_tracker",
                    "summary": "Standing desk price drop — 12K INR",
                    "tier": 3,
                    "timestamp": "2026-03-07T14:22:00Z",
                },
            ],
        }

        r = httpx.put(
            f"{alonso_core}/v1/vault/kv/briefing_queue?persona=general",
            json={"value": json.dumps(queue_payload)},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code in (200, 204), (
            f"KV put failed: {r.status_code} {r.text[:200]}"
        )

        _state["queue_payload"] = queue_payload
        print(
            f"\n  [briefing] Queued {len(queue_payload['items'])} "
            f"Tier 3 events in briefing_queue"
        )

    # ==================================================================
    # test_03: Briefing retrieves queued items
    # ==================================================================

    # TST-USR-063
    def test_03_briefing_retrieves_queued_items(
        self, alonso_core, admin_headers,
    ):
        """GET /v1/vault/kv/briefing_queue returns the queued items.

        At briefing time, Dina retrieves all queued Tier 3 events and
        presents them as a calm summary. The user sees:

          "3 things happened today:
           - Sancho shared an article about EU AI regulation
           - You were tagged in the Cervantes reading group
           - The standing desk you wanted dropped to 12K"

        Not 3 buzzes. Not 3 push notifications. One briefing.
        """
        r = httpx.get(
            f"{alonso_core}/v1/vault/kv/briefing_queue?persona=general",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"KV get failed: {r.status_code} {r.text[:200]}"
        )

        data = r.json()
        value_str = data.get("value", "")
        assert value_str, "briefing_queue KV value is empty"

        parsed = json.loads(value_str)
        items = parsed.get("items", [])
        assert len(items) == 3, (
            f"Expected 3 queued items, got {len(items)}"
        )

        # Verify the items match what we stored.
        sources = [item.get("source") for item in items]
        assert "news" in sources, f"Missing news item in queue: {sources}"
        assert "social" in sources, f"Missing social item in queue: {sources}"
        assert "price_tracker" in sources, (
            f"Missing price_tracker item in queue: {sources}"
        )

        _state["retrieved_items"] = items
        print(f"\n  [briefing] Retrieved {len(items)} items from briefing_queue")

    # ==================================================================
    # test_04: Clear briefing queue after delivery
    # ==================================================================

    # TST-USR-064
    def test_04_briefing_clear_after_delivery(
        self, alonso_core, admin_headers,
    ):
        """Clear the briefing queue after delivery, verify it is empty.

        After the daily briefing is delivered, Dina clears the queue.
        This ensures items are not repeated in the next briefing.

        We overwrite the KV key with an empty items list, then verify
        the retrieval returns the empty state.
        """
        # Overwrite with empty queue.
        r = httpx.put(
            f"{alonso_core}/v1/vault/kv/briefing_queue?persona=general",
            json={"value": json.dumps({"items": []})},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code in (200, 204), (
            f"KV clear failed: {r.status_code} {r.text[:200]}"
        )

        # Verify retrieval returns empty queue.
        r2 = httpx.get(
            f"{alonso_core}/v1/vault/kv/briefing_queue?persona=general",
            headers=admin_headers,
            timeout=10,
        )
        assert r2.status_code == 200, (
            f"KV get after clear failed: {r2.status_code} {r2.text[:200]}"
        )

        data = r2.json()
        value_str = data.get("value", "")
        parsed = json.loads(value_str)
        items = parsed.get("items", [])
        assert len(items) == 0, (
            f"Expected empty queue after clear, got {len(items)} items"
        )

        print("\n  [briefing] Briefing queue cleared after delivery")
        print("  [briefing] Silence First verified:")
        print("    - 3 low-priority items queued silently")
        print("    - 1 fiduciary event interrupted immediately")
        print("    - Queue cleared after briefing delivery")
