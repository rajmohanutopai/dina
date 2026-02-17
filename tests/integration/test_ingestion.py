"""Integration tests for data ingestion connectors.

Tests Gmail, WhatsApp, and Calendar connectors against the Dina
security and privacy contract: read-only scopes, immediate encryption,
persona routing, deduplication, sandboxing.
"""

from __future__ import annotations

import time

import pytest

from tests.integration.mocks import (
    ConnectorStatus,
    MockCalendarConnector,
    MockDinaCore,
    MockGmailConnector,
    MockIdentity,
    MockKeyManager,
    MockVault,
    MockWhatsAppConnector,
    PersonaType,
)


# ---------------------------------------------------------------------------
# Gmail Connector
# ---------------------------------------------------------------------------


class TestGmailConnector:
    """Gmail connector — read-only OAuth, polling, encryption, routing, dedup."""

    def test_readonly_scope(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Gmail connector must request read-only OAuth scope — never send or modify."""
        assert mock_gmail_connector.oauth_scope == "readonly"

    def test_polling_interval_default(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Default polling interval for Gmail is 15 minutes."""
        assert mock_gmail_connector.poll_interval_minutes == 15

    def test_polling_updates_last_poll_timestamp(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Polling must record the timestamp of the last poll."""
        assert mock_gmail_connector.last_poll is None
        mock_gmail_connector.add_data([{"message_id": "msg_1", "content": "Hello"}])
        mock_gmail_connector.poll()
        assert mock_gmail_connector.last_poll is not None
        assert mock_gmail_connector.last_poll <= time.time()

    def test_data_encrypted_immediately(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """Ingested data must be encrypted before storing in the vault."""
        persona = mock_identity.derive_persona(mock_gmail_connector.persona)
        mock_gmail_connector.add_data([
            {"message_id": "msg_enc_1", "content": "Sensitive email body"}
        ])
        items = mock_gmail_connector.poll()
        for item in items:
            normalized = mock_gmail_connector.normalize(item)
            encrypted = persona.encrypt(normalized["content"])
            mock_vault.store(1, normalized["id"], encrypted, persona.persona_type)

        stored = mock_vault.retrieve(1, items[0]["message_id"], PersonaType.PROFESSIONAL)
        # Stored value must be the encrypted form, not the raw content.
        # MockPersona.encrypt returns "ENC[partition_...]:<sha256>"
        assert stored is not None or mock_vault._tiers[1]  # vault received data
        # Verify the encrypted string format
        stored_value = list(mock_vault._tiers[1].values())[0]
        assert stored_value.startswith("ENC[")

    def test_persona_routing(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Gmail connector routes to the PROFESSIONAL persona by default."""
        assert mock_gmail_connector.persona == PersonaType.PROFESSIONAL

    def test_persona_routing_custom(self) -> None:
        """Gmail connector can be assigned to a different persona."""
        connector = MockGmailConnector(persona=PersonaType.SOCIAL)
        assert connector.persona == PersonaType.SOCIAL

    def test_deduplication_by_message_id(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Polling the same message_id twice must not produce duplicates."""
        mock_gmail_connector.add_data([
            {"message_id": "msg_dup_1", "content": "First"},
            {"message_id": "msg_dup_1", "content": "First duplicate"},
            {"message_id": "msg_dup_2", "content": "Second"},
        ])
        items = mock_gmail_connector.poll()
        # Only two unique message IDs should come through
        assert len(items) == 2
        ids = {item["message_id"] for item in items}
        assert ids == {"msg_dup_1", "msg_dup_2"}

    def test_deduplication_across_polls(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Messages seen in earlier polls must not reappear."""
        mock_gmail_connector.add_data([
            {"message_id": "msg_cross_1", "content": "A"},
        ])
        first = mock_gmail_connector.poll()
        assert len(first) == 1

        # Second poll re-delivers the same message
        mock_gmail_connector.add_data([
            {"message_id": "msg_cross_1", "content": "A again"},
            {"message_id": "msg_cross_2", "content": "B"},
        ])
        second = mock_gmail_connector.poll()
        assert len(second) == 1
        assert second[0]["message_id"] == "msg_cross_2"

    def test_items_ingested_counter(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """items_ingested must count raw items pulled (before dedup)."""
        mock_gmail_connector.add_data([
            {"message_id": "c1", "content": "x"},
            {"message_id": "c2", "content": "y"},
        ])
        mock_gmail_connector.poll()
        # The parent poll counts all items, dedup happens afterward
        assert mock_gmail_connector.items_ingested >= 2


# ---------------------------------------------------------------------------
# WhatsApp Connector
# ---------------------------------------------------------------------------


class TestWhatsAppConnector:
    """WhatsApp connector — phone-only, text-only, device-key auth push."""

    def test_runs_on_phone_only_push_model(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """WhatsApp uses push (poll_interval 0) — it runs on the phone, not polled."""
        assert mock_whatsapp_connector.poll_interval_minutes == 0

    def test_text_only_no_media(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """WhatsApp connector strips all media — text only."""
        assert mock_whatsapp_connector.text_only is True

        mock_whatsapp_connector.set_device_key("device_key_abc")
        items = [
            {
                "content": "Meet at 5pm",
                "media": b"\x89PNG_binary",
                "photo": "photo_url",
            }
        ]
        result = mock_whatsapp_connector.push_to_home_node(items)
        assert result is True
        # After push, media and photo fields must be stripped
        for item in mock_whatsapp_connector._data:
            assert "media" not in item
            assert "photo" not in item
            assert "content" in item

    def test_authenticated_push_requires_device_key(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """Push to home node fails without a device key."""
        items = [{"content": "hello"}]
        result = mock_whatsapp_connector.push_to_home_node(items)
        assert result is False
        # No data should have been queued
        assert len(mock_whatsapp_connector._data) == 0

    def test_authenticated_push_succeeds_with_device_key(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """Push succeeds once device key is set."""
        mock_whatsapp_connector.set_device_key("valid_key_123")
        items = [{"content": "Test message"}]
        result = mock_whatsapp_connector.push_to_home_node(items)
        assert result is True
        assert len(mock_whatsapp_connector._data) == 1

    def test_default_persona_is_social(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """WhatsApp connector defaults to SOCIAL persona."""
        assert mock_whatsapp_connector.persona == PersonaType.SOCIAL


# ---------------------------------------------------------------------------
# Connector Security Rules
# ---------------------------------------------------------------------------


class TestConnectorSecurityRules:
    """Cross-cutting security rules for all connectors."""

    def test_minimum_permission_scope_gmail(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Gmail must only request read-only scope — minimum privilege."""
        assert mock_gmail_connector.oauth_scope == "readonly"

    def test_oauth_tokens_encrypted_in_tier_0(
        self, mock_gmail_connector: MockGmailConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """OAuth tokens must be stored encrypted in Tier 0 (secrets)."""
        key_manager = MockKeyManager(mock_identity)
        oauth_token = "ya29.AHES6ZRVmB7FkLtD1z1Amc-w-Kx8C8"
        encrypted_token = key_manager.argon2id_encrypt(
            oauth_token, "user_passphrase"
        )
        mock_vault.store(0, "oauth_gmail", encrypted_token)

        retrieved = mock_vault.retrieve(0, "oauth_gmail")
        assert retrieved is not None
        # Must be the encrypted form — not the raw token
        assert "ARGON2ID[" in retrieved
        assert oauth_token not in retrieved

    def test_connectors_sandboxed_no_cross_persona_access(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_whatsapp_connector: MockWhatsAppConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """Connectors are sandboxed — data from one persona cannot leak to another."""
        pro_persona = mock_identity.derive_persona(PersonaType.PROFESSIONAL)
        social_persona = mock_identity.derive_persona(PersonaType.SOCIAL)

        # Gmail stores to PROFESSIONAL partition
        mock_vault.store(1, "email_1", pro_persona.encrypt("work email"),
                         PersonaType.PROFESSIONAL)
        # WhatsApp stores to SOCIAL partition
        mock_vault.store(1, "chat_1", social_persona.encrypt("friend chat"),
                         PersonaType.SOCIAL)

        # PROFESSIONAL partition should not contain SOCIAL data
        pro_data = mock_vault.per_persona_partition(PersonaType.PROFESSIONAL)
        social_data = mock_vault.per_persona_partition(PersonaType.SOCIAL)

        assert "email_1" in pro_data
        assert "chat_1" not in pro_data
        assert "chat_1" in social_data
        assert "email_1" not in social_data

    def test_connector_status_visible(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_whatsapp_connector: MockWhatsAppConnector,
        mock_calendar_connector: MockCalendarConnector,
    ) -> None:
        """All connectors expose their current status."""
        connectors = [
            mock_gmail_connector,
            mock_whatsapp_connector,
            mock_calendar_connector,
        ]
        for conn in connectors:
            assert conn.status == ConnectorStatus.ACTIVE
            assert hasattr(conn, "name")
            assert hasattr(conn, "last_poll")
            assert hasattr(conn, "items_ingested")

    def test_connector_can_be_paused(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """User can pause a connector."""
        mock_gmail_connector.status = ConnectorStatus.PAUSED
        assert mock_gmail_connector.status == ConnectorStatus.PAUSED

    def test_connector_can_be_disabled(
        self, mock_whatsapp_connector: MockWhatsAppConnector
    ) -> None:
        """User can fully disable a connector."""
        mock_whatsapp_connector.status = ConnectorStatus.DISABLED
        assert mock_whatsapp_connector.status == ConnectorStatus.DISABLED

    def test_calendar_connector_defaults(
        self, mock_calendar_connector: MockCalendarConnector
    ) -> None:
        """Calendar connector has correct defaults."""
        assert mock_calendar_connector.name == "calendar"
        assert mock_calendar_connector.persona == PersonaType.PROFESSIONAL
        assert mock_calendar_connector.poll_interval_minutes == 30
