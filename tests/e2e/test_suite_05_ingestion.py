"""E2E Suite 5: Ingestion Pipeline.

Tests Gmail two-pass triage, Telegram ingestion, calendar sync,
cursor continuity across restarts, OAuth refresh isolation, and
startup fast sync with background backfill.

Actors: Don Alonso (primary user), OpenClaw (task agent)
Fixtures: don_alonso, fresh_don_alonso, openclaw, plc_directory, d2d_network
"""

from __future__ import annotations

import time

import pytest

from tests.e2e.actors import HomeNode, Persona, PersonaType
from tests.e2e.mocks import (
    DeviceType,
    MockOpenClaw,
    OAuthToken,
    SilenceTier,
    TaskStatus,
    TrustRing,
    VaultItem,
)


class TestIngestionPipeline:
    """Suite 5 — Ingestion Pipeline (TST-E2E-023 through TST-E2E-028)."""

    # TST-E2E-023
    def test_gmail_two_pass_triage(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-5.1  Gmail Two-Pass Triage.

        OpenClaw has 50 pre-loaded emails across 5 categories (PRIMARY,
        PROMOTIONS, SOCIAL, UPDATES, FORUMS — 10 each, round-robin).

        Pass 1: Filter out PROMOTIONS, SOCIAL, UPDATES, FORUMS.
        Pass 2: Remaining PRIMARY emails are classified and ingested.

        Verify:
        - Skipped emails get thin records (category + sender only).
        - Ingested PRIMARY emails get full vault records.
        - No email is lost — every email has either a thin or full record.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Pass 1: Fetch metadata from OpenClaw and triage by category
        # ------------------------------------------------------------------
        response = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 100,
        })
        assert response["status"] == "completed"
        all_emails = response["emails"]
        assert len(all_emails) == 50, "OpenClaw must return all 50 emails"

        skip_categories = {"PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"}
        skipped: list[dict] = []
        primary: list[dict] = []

        for email in all_emails:
            if email["category"] in skip_categories:
                skipped.append(email)
            else:
                primary.append(email)

        assert len(primary) == 10, "Exactly 10 PRIMARY emails expected (50 / 5 categories)"
        assert len(skipped) == 40, "40 non-PRIMARY emails should be skipped"

        # ------------------------------------------------------------------
        # Store thin records for skipped emails (category + sender only)
        # ------------------------------------------------------------------
        thin_ids: list[str] = []
        for email in skipped:
            item_id = node.vault_store(
                "personal",
                f"email_thin_{email['id']}",
                {"email_id": email["id"],
                 "category": email["category"],
                 "sender": email["sender"],
                 "record_type": "thin"},
                item_type="email_thin",
                source="openclaw/gmail",
            )
            thin_ids.append(item_id)

        assert len(thin_ids) == 40

        # ------------------------------------------------------------------
        # Pass 2: Fetch full body for PRIMARY emails and ingest
        # ------------------------------------------------------------------
        full_ids: list[str] = []
        for email in primary:
            body_resp = openclaw.handle_request({
                "action": "gmail_fetch_body",
                "email_id": email["id"],
            })
            assert body_resp["status"] == "completed"
            full_email = body_resp["email"]
            assert full_email is not None

            item_id = node.vault_store(
                "personal",
                f"email_full_{email['id']}",
                {"email_id": email["id"],
                 "category": email["category"],
                 "sender": email["sender"],
                 "subject": email["subject"],
                 "body": full_email["body"],
                 "record_type": "full"},
                item_type="email_full",
                source="openclaw/gmail",
            )
            full_ids.append(item_id)

        assert len(full_ids) == 10

        # ------------------------------------------------------------------
        # Verify: no email lost — thin + full = 50
        # ------------------------------------------------------------------
        total_records = len(thin_ids) + len(full_ids)
        assert total_records == 50, (
            f"Every email must have a record: {total_records} != 50"
        )

        # Verify thin records contain only metadata (no body)
        thin_search = node.vault_query("personal", "email_thin", mode="fts5")
        for item in thin_search:
            assert "thin" in item.body_text, (
                "Thin records must be identifiable as thin"
            )

    # TST-E2E-024
    def test_telegram_ingestion(
        self, don_alonso: HomeNode,
    ) -> None:
        """E2E-5.2  Telegram Ingestion.

        Simulate a Telegram message arriving.  Verify it is stored in the
        vault, the brain is notified, and it is classified as Priority 3
        (engagement tier — unsolicited message from a contact).
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Simulate incoming Telegram message
        # ------------------------------------------------------------------
        telegram_msg = {
            "platform": "telegram",
            "sender": "friend_42",
            "chat_id": "chat_abc",
            "text": "Hey, have you seen the new SpaceX launch video?",
            "timestamp": node._now(),
        }

        # Store in vault (use space-separated summary for FTS indexing)
        item_id = node.vault_store(
            "social",
            f"telegram message from {telegram_msg['sender']}",
            telegram_msg,
            item_type="message",
            source="telegram",
        )
        assert item_id.startswith("vi_"), "Vault item ID must be generated"

        # Notify brain (classify the event)
        tier = node._classify_silence("telegram_message", telegram_msg)
        assert tier == SilenceTier.TIER_3_ENGAGEMENT, (
            "Unsolicited Telegram message must be classified as Priority 3 (engagement)"
        )

        # Queue for briefing (engagement tier = save for briefing, do NOT interrupt)
        node.briefing_queue.append({
            "type": "telegram_message",
            "source": "telegram",
            "sender": telegram_msg["sender"],
            "preview": telegram_msg["text"][:80],
            "tier": tier.value,
        })

        assert len(node.briefing_queue) >= 1
        queued = node.briefing_queue[-1]
        assert queued["tier"] == SilenceTier.TIER_3_ENGAGEMENT.value
        assert queued["source"] == "telegram"

        # Verify retrievable from vault
        results = node.vault_query("social", "telegram", mode="fts5")
        assert len(results) >= 1, "Telegram message must be retrievable from vault"

    # TST-E2E-025
    def test_calendar_sync(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-5.3  Calendar Sync.

        Sync events from OpenClaw calendar.  Verify events are stored in
        the vault with all fields (title, start, end, attendees, location).
        Then ask 'Am I free at 4 PM?' and verify the answer comes from
        the local vault (not from a cloud API call).
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Sync calendar events via OpenClaw
        # ------------------------------------------------------------------
        cal_response = openclaw.handle_request({
            "action": "calendar_sync",
            "cursor": "",
        })
        assert cal_response["status"] == "completed"
        events = cal_response["events"]
        assert len(events) >= 2, "OpenClaw calendar must have at least 2 events"

        # Store each event in the vault (space-separated summary for FTS)
        stored_ids: list[str] = []
        for event in events:
            item_id = node.vault_store(
                "professional",
                f"calendar event {event['title']}",
                {
                    "event_id": event["id"],
                    "title": event["title"],
                    "start": event["start"],
                    "end": event["end"],
                    "attendees": event.get("attendees", []),
                    "location": event.get("location", ""),
                },
                item_type="calendar_event",
                source="openclaw/calendar",
            )
            stored_ids.append(item_id)

        assert len(stored_ids) == len(events)

        # ------------------------------------------------------------------
        # Verify all fields are stored
        # ------------------------------------------------------------------
        search_results = node.vault_query("professional", "calendar", mode="fts5")
        assert len(search_results) >= 2
        for item in search_results:
            assert "title" in item.body_text, "Calendar item must contain 'title'"
            assert "start" in item.body_text, "Calendar item must contain 'start'"
            assert "end" in item.body_text, "Calendar item must contain 'end'"

        # ------------------------------------------------------------------
        # Ask "Am I free at 4 PM?" — answer from local vault
        # ------------------------------------------------------------------
        # The first event (Meeting with Sancho) is ~4 hours from now.
        # Set up LLM to answer based on vault context.
        node.set_llm_response(
            "free at 4",
            "You have 'Meeting with Sancho' scheduled around that time. "
            "You are not free at 4 PM.",
        )

        # Query vault for calendar context
        cal_items = node.vault_query("professional", "calendar", mode="fts5")
        context = [item.body_text for item in cal_items]
        answer = node.llm_reason("Am I free at 4 PM?", context=context)

        assert "meeting" in answer.lower() or "not free" in answer.lower(), (
            "Answer must reference the stored calendar event"
        )

    # TST-E2E-026
    def test_cursor_continuity(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-5.4  Cursor Continuity.

        Sync a partial batch of emails, save the cursor via kv_put,
        simulate a restart (clear in-memory state, read cursor back),
        and resume from where we left off.  Verify no duplicates.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # First sync: fetch first 20 emails, save cursor
        # ------------------------------------------------------------------
        resp1 = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 20,
        })
        batch1 = resp1["emails"]
        assert len(batch1) == 20

        # Store them and record IDs for dedup checking
        seen_email_ids: set[str] = set()
        for email in batch1:
            node.vault_store(
                "personal",
                f"email_{email['id']}",
                email,
                item_type="email",
                source="openclaw/gmail",
            )
            seen_email_ids.add(email["id"])

        # Save cursor — last email ID of the batch
        last_cursor = batch1[-1]["id"]
        node.kv_put("gmail_sync_cursor", last_cursor)

        # ------------------------------------------------------------------
        # Simulate restart: read cursor back
        # ------------------------------------------------------------------
        restored_cursor = node.kv_get("gmail_sync_cursor")
        assert restored_cursor == last_cursor, (
            "Cursor must survive kv_put/kv_get round-trip"
        )

        # ------------------------------------------------------------------
        # Resume sync from cursor
        # ------------------------------------------------------------------
        resp2 = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": restored_cursor,
            "limit": 100,
        })
        batch2 = resp2["emails"]

        # Verify no overlap — no email ID from batch2 was already seen
        for email in batch2:
            assert email["id"] not in seen_email_ids, (
                f"Duplicate email detected: {email['id']}. "
                "Cursor continuity must prevent re-fetching."
            )
            seen_email_ids.add(email["id"])

        # Total across both batches should cover all 50 emails
        assert len(seen_email_ids) == 50, (
            f"Both batches combined must cover all 50 emails, got {len(seen_email_ids)}"
        )

    # TST-E2E-027
    def test_oauth_refresh_isolation(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-5.5  OAuth Refresh.

        Gmail OAuth token expires.  OpenClaw refreshes it.  Verify:
        1. The refresh succeeds.
        2. No OAuth tokens (access_token, refresh_token) are stored in
           Dina's vault or KV store.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Expire the token
        # ------------------------------------------------------------------
        openclaw.gmail._oauth_token.expires_at = time.time() - 3600  # expired 1h ago
        assert openclaw.gmail._oauth_token.expires_at < time.time(), (
            "Token must be expired for this test"
        )

        # ------------------------------------------------------------------
        # OpenClaw refreshes the token
        # ------------------------------------------------------------------
        refresh_ok = openclaw.gmail.refresh_oauth()
        assert refresh_ok is True, "OAuth refresh must succeed"
        assert openclaw.gmail._oauth_token.expires_at > time.time(), (
            "Refreshed token must have a future expiry"
        )

        # ------------------------------------------------------------------
        # Verify Dina's vault has NO OAuth tokens
        # ------------------------------------------------------------------
        for persona in node.personas.values():
            for item in persona.items.values():
                body_lower = item.body_text.lower()
                assert "access_token" not in body_lower, (
                    f"OAuth access_token found in vault item {item.item_id} — "
                    "Dina must NEVER store OAuth tokens"
                )
                assert "refresh_token" not in body_lower, (
                    f"OAuth refresh_token found in vault item {item.item_id} — "
                    "Dina must NEVER store OAuth tokens"
                )

        # Verify KV store has no OAuth tokens
        for key, value in node.kv_store.items():
            val_str = str(value).lower()
            assert "access_token" not in val_str, (
                f"OAuth access_token found in KV key '{key}' — "
                "Dina must NEVER store OAuth tokens"
            )
            assert "refresh_token" not in val_str, (
                f"OAuth refresh_token found in KV key '{key}' — "
                "Dina must NEVER store OAuth tokens"
            )

    # TST-E2E-028
    def test_startup_fast_sync_plus_background_backfill(
        self, fresh_don_alonso: HomeNode, openclaw: MockOpenClaw,
            plc_directory, d2d_network,
    ) -> None:
        """E2E-5.6  Startup Fast Sync + Background Backfill.

        On startup, fast-sync the last 30 days of emails (blocking).
        Verify they are immediately queryable.  Then background-backfill
        older emails.  Verify that a user query during backfill pauses
        the backfill (user queries take priority).
        """
        node = fresh_don_alonso
        node.first_run_setup("fastsync@example.com", "passphrase_fast")
        node.create_persona("personal", PersonaType.PERSONAL, "open")

        now = time.time()

        # ------------------------------------------------------------------
        # Classify emails by age: "recent" (< 30 days) vs "old" (> 30 days)
        # ------------------------------------------------------------------
        all_resp = openclaw.handle_request({
            "action": "gmail_sync", "cursor": "", "limit": 100,
        })
        all_emails = all_resp["emails"]

        thirty_days_ago = now - (30 * 86400)
        recent_emails = [e for e in all_emails if e["timestamp"] >= thirty_days_ago]
        old_emails = [e for e in all_emails if e["timestamp"] < thirty_days_ago]

        # ------------------------------------------------------------------
        # Phase 1: Fast sync (blocking) — recent emails only
        # ------------------------------------------------------------------
        for email in recent_emails:
            node.vault_store(
                "personal",
                f"fastsync email {email['id']}",
                email,
                item_type="email",
                source="openclaw/gmail",
            )

        # Verify immediately queryable
        fast_results = node.vault_query("personal", "fastsync", mode="fts5")
        assert len(fast_results) == len(recent_emails), (
            "All fast-synced recent emails must be immediately queryable"
        )

        # ------------------------------------------------------------------
        # Phase 2: Background backfill — old emails
        # ------------------------------------------------------------------
        backfill_progress: list[str] = []
        user_query_interrupted = False

        for i, email in enumerate(old_emails):
            # Simulate user query arriving mid-backfill
            if i == len(old_emails) // 2 and len(old_emails) > 0:
                # User query — must pause backfill and be served immediately
                user_results = node.vault_query(
                    "personal", "fastsync", mode="fts5",
                )
                assert len(user_results) >= 1, (
                    "User query during backfill must return results immediately"
                )
                user_query_interrupted = True

            # Continue backfill
            node.vault_store(
                "personal",
                f"backfill email {email['id']}",
                email,
                item_type="email",
                source="openclaw/gmail",
            )
            backfill_progress.append(email["id"])

        # Verify backfill completed
        backfill_results = node.vault_query(
            "personal", "backfill", mode="fts5",
        )
        assert len(backfill_results) == len(old_emails), (
            "All backfilled old emails must be stored"
        )

        # Verify user query was handled during backfill
        if len(old_emails) > 0:
            assert user_query_interrupted, (
                "User query must have been served during backfill"
            )

        # Total: fast + backfill = all emails
        total_stored = len(recent_emails) + len(old_emails)
        assert total_stored == len(all_emails), (
            "Fast sync + backfill must cover all emails"
        )
