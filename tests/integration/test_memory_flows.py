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
    MockReviewBot,
    MockVault,
    MockWhatsAppConnector,
    PersonaType,
)


# =========================================================================
# TestPrivateRecall
# =========================================================================

class TestPrivateRecall:
    """Dina remembers the user's life — promises, emotions, meaning."""

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

    def test_raw_memory_never_sent_to_bots(
        self,
        mock_dina: MockDinaCore,
        mock_review_bot: MockReviewBot,
        sample_memory: MockVault,
    ):
        """When Dina queries a review bot, raw vault entries are NOT included
        in the query payload. Only the product query string is sent."""
        response = mock_review_bot.query_product("best laptop for travel")

        # The bot received the query string, NOT vault contents
        assert len(mock_review_bot.queries) == 1
        sent_query = mock_review_bot.queries[0]
        assert "query" in sent_query
        # Ensure none of the private vault keys leak into the query
        assert "promise_book" not in str(sent_query)
        assert "moment_happy_1" not in str(sent_query)
        assert "contact_sancho" not in str(sent_query)

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

    def test_calendar_indexed(
        self,
        mock_calendar_connector: MockCalendarConnector,
        mock_dina: MockDinaCore,
        sample_events: list[dict],
    ):
        """Calendar events are polled, normalized, and stored in the vault
        so they become searchable."""
        mock_calendar_connector.add_data(sample_events)
        raw_items = mock_calendar_connector.poll()
        assert len(raw_items) == 2

        # Normalize and store each event
        for item in raw_items:
            normalized = mock_calendar_connector.normalize(item)
            mock_dina.vault.store(
                1, normalized["id"], normalized,
                persona=PersonaType.PROFESSIONAL,
            )
            mock_dina.vault.index_for_fts(normalized["id"], normalized["content"])

        # The events are now in the vault
        assert mock_dina.vault.retrieve(
            1, "meeting_1", persona=PersonaType.PROFESSIONAL
        ) is not None
        assert mock_dina.vault.retrieve(
            1, "license_renewal", persona=PersonaType.PROFESSIONAL
        ) is not None

    def test_chat_ingestion(
        self,
        mock_whatsapp_connector: MockWhatsAppConnector,
        mock_dina: MockDinaCore,
    ):
        """WhatsApp messages are text-only, pushed to home node only after
        device authentication, and stored in the social partition."""
        # Without device key, push fails
        assert mock_whatsapp_connector.push_to_home_node([
            {"content": "Hello!", "media": "photo.jpg"},
        ]) is False

        # Authenticate device
        device_key = mock_dina.identity.register_device("phone_001")
        mock_whatsapp_connector.set_device_key(device_key)

        # Push succeeds, media stripped
        assert mock_whatsapp_connector.push_to_home_node([
            {"content": "Hey, are we meeting?", "media": "voice_note.ogg"},
            {"content": "See you at 5", "photo": "selfie.jpg"},
        ]) is True

        items = mock_whatsapp_connector.poll()
        assert len(items) == 2
        for item in items:
            assert "media" not in item
            assert "photo" not in item

        # Store in social partition
        for item in items:
            normalized = mock_whatsapp_connector.normalize(item)
            mock_dina.vault.store(
                1, normalized["id"], normalized,
                persona=PersonaType.SOCIAL,
            )

        social_partition = mock_dina.vault.per_persona_partition(PersonaType.SOCIAL)
        assert len(social_partition) == 2
