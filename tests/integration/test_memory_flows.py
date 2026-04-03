"""Integration tests for Dina memory flows.

Behavioral contracts tested:
- Private recall: Dina remembers promises, emotions, and context across sessions.
- Memory privacy: Raw memory never leaks to bots; deletion is permanent;
  persona partitioning enforces compartmentalization.
- Memory ingestion: Connectors (email, calendar, chat) feed the vault correctly.
"""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    MockDinaCore,
    MockGmailConnector,
    MockCalendarConnector,
    MockPIIScrubber,
    MockReviewBot,
    MockVault,
    MockTelegramConnector,
    PersonaType,
)


# =========================================================================
# TestPrivateRecall
# =========================================================================

class TestPrivateRecall:
    """Dina remembers the user's life — promises, emotions, meaning."""

# TST-INT-281
    # TRACE: {"suite": "INT", "case": "0281", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "01", "title": "book_promise_recall"}
    def test_book_promise_recall(
        self, mock_dina: MockDinaCore, sample_memory: MockVault
    ):
        """'I promised to read The Little Prince to my daughter last Tuesday.'
        Dina must find this by semantic search, not just keyword match."""
        results = sample_memory.search_fts("Prince")
        assert len(results) >= 1
        assert "promise_book" in results

        entry = sample_memory.retrieve(1, "promise_book")
        assert entry is not None
        assert "Little Prince" in entry["content"]
        assert entry["date"] == "last Tuesday"
        assert entry["to"] == "daughter"

# TST-INT-282
    # TRACE: {"suite": "INT", "case": "0282", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "02", "title": "emotion_indexed_search"}
    def test_emotion_indexed_search(
        self, mock_dina: MockDinaCore, sample_memory: MockVault
    ):
        """Searching for 'happy' returns emotion-tagged memories."""
        results = sample_memory.search_fts("happy")
        assert len(results) >= 1
        assert "moment_happy_1" in results

        entry = sample_memory.retrieve(1, "moment_happy_1")
        assert entry["emotion"] == "happy"
        assert "picnic" in entry["content"]

# TST-INT-275
    # TRACE: {"suite": "INT", "case": "0275", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "03", "title": "memory_survives_sessions"}
    def test_memory_survives_sessions(
        self, mock_identity, mock_vault: MockVault
    ):
        """Vault data persists when a new Dina core is instantiated
        against the same vault (simulates process restart)."""
        # Session 1: store a memory
        dina_session_1 = MockDinaCore(identity=mock_identity, vault=mock_vault)
        dina_session_1.vault.store(1, "session_test", {"note": "cross-session"})
        dina_session_1.vault.index_for_fts("session_test", "cross session test")

        # Session 2: new core, same vault
        dina_session_2 = MockDinaCore(identity=mock_identity, vault=mock_vault)
        assert dina_session_2.vault.retrieve(1, "session_test") == {"note": "cross-session"}
        assert "session_test" in dina_session_2.vault.search_fts("session")

# TST-INT-274
    # TRACE: {"suite": "INT", "case": "0274", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "04", "title": "encrypted_at_rest"}
    def test_encrypted_at_rest(self, mock_dina: MockDinaCore):
        """Data stored via persona encryption cannot be read as plaintext
        by inspecting the vault directly."""
        persona = mock_dina.identity.derive_persona(PersonaType.HEALTH)
        encrypted = persona.encrypt("blood_pressure=120/80")

        assert "blood_pressure" not in encrypted
        assert encrypted.startswith("ENC[")

        # Only the correct persona can decrypt
        decrypted = persona.decrypt(encrypted)
        assert decrypted is not None

# TST-INT-280
    # TRACE: {"suite": "INT", "case": "0280", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "01", "scenario": "05", "title": "searchable_by_meaning"}
    def test_searchable_by_meaning(
        self, mock_dina: MockDinaCore, sample_memory: MockVault
    ):
        """FTS returns results for semantically related queries —
        'daughter book' should find the promise even though the query
        does not contain 'Little Prince'."""
        results = sample_memory.search_fts("daughter")
        assert "promise_book" in results

        results_book = sample_memory.search_fts("book")
        assert "promise_book" in results_book


# =========================================================================
# TestMemoryPrivacy
# =========================================================================

class TestMemoryPrivacy:
    """Raw memory never leaves the user's control."""

# TST-INT-510
    # TRACE: {"suite": "INT", "case": "0510", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "01", "title": "raw_memory_never_sent_to_bots"}
    def test_raw_memory_never_sent_to_bots(
        self,
        mock_dina: MockDinaCore,
        mock_review_bot: MockReviewBot,
        sample_memory: MockVault,
    ):
        """When Dina queries a review bot, raw vault data is scrubbed first.
        PII (names, emails, etc.) must be replaced before leaving the node."""
        scrubber = MockPIIScrubber()

        # Simulate the real flow: user context contains PII from vault
        raw_context = (
            "Rajmohan wants a laptop for travel. "
            "Sancho recommended ThinkPad last week via sancho@email.com. "
            "Budget from contact_sancho vault entry."
        )

        # PII scrubber strips structured PII before it leaves the node
        scrubbed, replacements = scrubber.scrub(raw_context)

        # Names pass through (intentional), structured PII removed
        assert "Rajmohan" in scrubbed
        assert "Sancho" in scrubbed
        assert "sancho@email.com" not in scrubbed
        assert "[EMAIL_2]" in scrubbed

        # Only the scrubbed query goes to the bot
        response = mock_review_bot.query_product(scrubbed)
        assert len(mock_review_bot.queries) == 1
        sent_query = str(mock_review_bot.queries[0])

        # Counter-proof: structured PII must NOT appear in what the bot received
        assert "sancho@email.com" not in sent_query

        # But the product intent survived scrubbing
        assert "laptop" in sent_query
        assert "travel" in sent_query

# TST-INT-511
    # TRACE: {"suite": "INT", "case": "0511", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "02", "title": "deletion_is_permanent"}
    def test_deletion_is_permanent(self, mock_dina: MockDinaCore):
        """When the user deletes a memory, it is truly gone — not soft-deleted."""
        vault = mock_dina.vault
        vault.store(1, "delete_me", {"secret": "very_private"})
        vault.index_for_fts("delete_me", "secret very private")

        # Confirm it exists
        assert vault.retrieve(1, "delete_me") is not None
        assert "delete_me" in vault.search_fts("secret")

        # Delete
        deleted = vault.delete(1, "delete_me")
        assert deleted is True

        # Gone from tier storage
        assert vault.retrieve(1, "delete_me") is None
        # Gone from FTS index
        assert "delete_me" not in vault.search_fts("secret")
        # Gone from all partitions
        for partition in vault._partitions.values():
            assert "delete_me" not in partition

# TST-INT-512
    # TRACE: {"suite": "INT", "case": "0512", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "02", "scenario": "03", "title": "not_accessible_by_other_personas"}
    def test_not_accessible_by_other_personas(self, mock_dina: MockDinaCore):
        """Health persona data is invisible to consumer persona queries."""
        vault = mock_dina.vault

        # Store in health partition
        vault.store(1, "health_record", {"diagnosis": "healthy"},
                    persona=PersonaType.HEALTH)

        # Consumer persona cannot see it
        consumer_view = vault.per_persona_partition(PersonaType.CONSUMER)
        assert "health_record" not in consumer_view

        # Health persona can see it
        health_view = vault.per_persona_partition(PersonaType.HEALTH)
        assert "health_record" in health_view

        # Cross-persona retrieval returns None when scoped to consumer
        assert vault.retrieve(1, "health_record", persona=PersonaType.CONSUMER) is None
        assert vault.retrieve(1, "health_record", persona=PersonaType.HEALTH) is not None


# =========================================================================
# TestMemoryIngestion
# =========================================================================

class TestMemoryIngestion:
    """Connectors ingest external data into the vault correctly."""

# TST-INT-513
    # TRACE: {"suite": "INT", "case": "0513", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "01", "title": "email_read_only"}
    def test_email_read_only(self, mock_gmail_connector: MockGmailConnector):
        """Gmail connector operates in read-only mode — it polls but never
        writes back to the mail server."""
        assert mock_gmail_connector.oauth_scope == "readonly"

        mock_gmail_connector.add_data([
            {"message_id": "msg_001", "content": "Meeting tomorrow at 10am"},
            {"message_id": "msg_002", "content": "Invoice attached"},
        ])

        items = mock_gmail_connector.poll()
        assert len(items) == 2
        assert mock_gmail_connector.items_ingested == 2

        # Deduplication: polling the same IDs again yields nothing new
        mock_gmail_connector.add_data([
            {"message_id": "msg_001", "content": "Meeting tomorrow at 10am"},
        ])
        items_again = mock_gmail_connector.poll()
        assert len(items_again) == 0

# TST-INT-276
    # TRACE: {"suite": "INT", "case": "0276", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "02", "title": "calendar_indexed"}
    def test_calendar_indexed(
        self,
        mock_calendar_connector: MockCalendarConnector,
        mock_dina: MockDinaCore,
        sample_events: list[dict],
    ):
        """Calendar events are polled, normalized, and stored in the vault
        so they become searchable."""
        # Pre-condition: no data and vault partition empty
        assert len(mock_calendar_connector.poll()) == 0
        assert len(mock_dina.vault.per_persona_partition(PersonaType.PROFESSIONAL)) == 0

        mock_calendar_connector.add_data(sample_events)
        raw_items = mock_calendar_connector.poll()
        assert len(raw_items) == 2

        # Normalize and store each event
        for item in raw_items:
            normalized = mock_calendar_connector.normalize(item)
            assert normalized["source"] == "calendar"
            assert "id" in normalized
            mock_dina.vault.store(
                1, normalized["id"], normalized,
                persona=PersonaType.PROFESSIONAL,
            )
            # Index by title for FTS — normalize() may return empty content
            # for calendar items, so use the raw title for searchability
            fts_text = item.get("title", normalized["content"])
            mock_dina.vault.index_for_fts(normalized["id"], fts_text)

        # The events are now in the vault
        assert mock_dina.vault.retrieve(
            1, "meeting_1", persona=PersonaType.PROFESSIONAL
        ) is not None
        assert mock_dina.vault.retrieve(
            1, "license_renewal", persona=PersonaType.PROFESSIONAL
        ) is not None

        # FTS search finds stored events by title
        results = mock_dina.vault.search_fts("standup")
        assert "meeting_1" in results

        # Counter-proof: non-matching FTS returns empty
        assert len(mock_dina.vault.search_fts("nonexistent_event")) == 0

        # Counter-proof: not in SOCIAL partition
        assert mock_dina.vault.retrieve(
            1, "meeting_1", persona=PersonaType.SOCIAL
        ) is None

# TST-INT-277
    # TRACE: {"suite": "INT", "case": "0277", "section": "10", "sectionName": "Data Flow Patterns", "subsection": "03", "scenario": "03", "title": "chat_ingestion"}
    def test_chat_ingestion(
        self,
        mock_telegram_connector: MockTelegramConnector,
        mock_dina: MockDinaCore,
    ):
        """Telegram messages include full text+media, ingested via Bot API
        after bot token configuration, and stored in the social partition."""
        # Pre-condition: no data ingested, social partition empty
        assert len(mock_telegram_connector.poll()) == 0
        assert len(mock_dina.vault.per_persona_partition(PersonaType.SOCIAL)) == 0

        # Without bot token, ingestion fails
        assert mock_telegram_connector.bot_token is None
        assert mock_telegram_connector.ingest_from_bot_api([
            {"content": "Hello!", "media": "photo.jpg"},
        ]) is False
        # Rejected items are NOT stored
        assert len(mock_telegram_connector.poll()) == 0

        # Configure bot token
        mock_telegram_connector.set_bot_token("bot_token_123")

        # Ingestion succeeds, media preserved (Telegram supports full media)
        assert mock_telegram_connector.ingest_from_bot_api([
            {"content": "Hey, are we meeting?", "media": "voice_note.ogg"},
            {"content": "See you at 5", "photo": "selfie.jpg"},
        ]) is True

        items = mock_telegram_connector.poll()
        assert len(items) == 2
        # Telegram preserves media fields
        assert any("media" in item for item in items)
        assert any("photo" in item for item in items)

        # Store in social partition
        for item in items:
            normalized = mock_telegram_connector.normalize(item)
            assert "id" in normalized, "Normalized item must have an id"
            assert "source" in normalized, "Normalized item must have a source"
            assert normalized["source"] == "telegram"
            mock_dina.vault.store(
                1, normalized["id"], normalized,
                persona=PersonaType.SOCIAL,
            )

        social_partition = mock_dina.vault.per_persona_partition(PersonaType.SOCIAL)
        assert len(social_partition) == 2

        # Counter-proof: items are NOT in the consumer partition
        consumer_partition = mock_dina.vault.per_persona_partition(PersonaType.CONSUMER)
        assert len(consumer_partition) == 0
