"""Integration tests for data ingestion connectors.

Tests Gmail, Telegram, and Calendar connectors against the Dina
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
    MockExternalAgent,
    MockGmailConnector,
    MockGoCore,
    MockIdentity,
    MockKeyManager,
    MockLLMRouter,
    MockPIIScrubber,
    MockPythonBrain,
    MockSilenceClassifier,
    MockVault,
    MockTelegramConnector,
    MockWhisperAssembler,
    OAuthToken,
    PersonaType,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# Gmail Connector
# ---------------------------------------------------------------------------


class TestGmailConnector:
    """Gmail connector — read-only OAuth, polling, encryption, routing, dedup."""

# TST-INT-236
    def test_readonly_scope(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Gmail connector must request read-only OAuth scope — never send or modify."""
        assert mock_gmail_connector.oauth_scope == "readonly"

# TST-INT-242
    def test_polling_interval_default(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Default polling interval for Gmail is 15 minutes."""
        assert mock_gmail_connector.poll_interval_minutes == 15

# TST-INT-249
    def test_polling_updates_last_poll_timestamp(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Polling must record the timestamp of the last poll."""
        assert mock_gmail_connector.last_poll is None
        mock_gmail_connector.add_data([{"message_id": "msg_1", "content": "Hello"}])
        mock_gmail_connector.poll()
        assert mock_gmail_connector.last_poll is not None
        assert mock_gmail_connector.last_poll <= time.time()

# TST-INT-251
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

# TST-INT-495
    def test_persona_routing(self, mock_gmail_connector: MockGmailConnector) -> None:
        """Gmail connector routes to the PROFESSIONAL persona by default."""
        assert mock_gmail_connector.persona == PersonaType.PROFESSIONAL

# TST-INT-237
    def test_persona_routing_custom(self) -> None:
        """Gmail connector can be assigned to a different persona."""
        connector = MockGmailConnector(persona=PersonaType.SOCIAL)
        assert connector.persona == PersonaType.SOCIAL

# TST-INT-496
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

# TST-INT-238
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

# TST-INT-497
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
# Telegram Connector
# ---------------------------------------------------------------------------


class TestTelegramConnector:
    """Telegram connector — server-side Bot API, full message+media, polling."""

# TST-INT-255
    def test_uses_polling_model(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """Telegram uses Bot API polling (poll_interval 5 min) — runs server-side on Home Node."""
        assert mock_telegram_connector.poll_interval_minutes == 5

# TST-INT-246
    def test_supports_media(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """Telegram connector supports full message+media ingestion."""
        assert mock_telegram_connector.supports_media is True

        mock_telegram_connector.set_bot_token("bot_token_abc")
        items = [
            {
                "content": "Meet at 5pm",
                "media": b"\x89PNG_binary",
                "photo": "photo_url",
            }
        ]
        result = mock_telegram_connector.ingest_from_bot_api(items)
        assert result is True
        # After ingestion, media and photo fields are preserved (Telegram supports media)
        for item in mock_telegram_connector._data:
            assert "media" in item
            assert "photo" in item
            assert "content" in item

# TST-INT-248
    def test_ingestion_requires_bot_token(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """Ingestion from Bot API fails without a bot token."""
        items = [{"content": "hello"}]
        result = mock_telegram_connector.ingest_from_bot_api(items)
        assert result is False
        # No data should have been queued
        assert len(mock_telegram_connector._data) == 0

# TST-INT-244
    def test_ingestion_succeeds_with_bot_token(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """Ingestion succeeds once bot token is set."""
        mock_telegram_connector.set_bot_token("valid_bot_token_123")
        items = [{"content": "Test message"}]
        result = mock_telegram_connector.ingest_from_bot_api(items)
        assert result is True
        assert len(mock_telegram_connector._data) == 1

# TST-INT-247
    def test_default_persona_is_social(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """Telegram connector defaults to SOCIAL persona."""
        assert mock_telegram_connector.persona == PersonaType.SOCIAL


# ---------------------------------------------------------------------------
# Connector Security Rules
# ---------------------------------------------------------------------------


class TestConnectorSecurityRules:
    """Cross-cutting security rules for all connectors."""

# TST-INT-498
    def test_minimum_permission_scope_gmail(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Gmail must only request read-only scope — minimum privilege."""
        assert mock_gmail_connector.oauth_scope == "readonly"

# TST-INT-254
    def test_oauth_tokens_encrypted_in_tier_0(
        self, mock_gmail_connector: MockGmailConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """OAuth tokens must be stored key-wrapped in Tier 0 (secrets)."""
        key_manager = MockKeyManager(mock_identity)
        oauth_token = "ya29.AHES6ZRVmB7FkLtD1z1Amc-w-Kx8C8"
        wrapped_token = key_manager.key_wrap(
            oauth_token, "user_passphrase"
        )
        mock_vault.store(0, "oauth_gmail", wrapped_token)

        retrieved = mock_vault.retrieve(0, "oauth_gmail")
        assert retrieved is not None
        # Must be the wrapped form — not the raw token
        assert "WRAPPED[" in retrieved
        assert oauth_token not in retrieved

# TST-INT-240
    def test_connectors_sandboxed_no_cross_persona_access(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_telegram_connector: MockTelegramConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """Connectors are sandboxed — data from one persona cannot leak to another."""
        pro_persona = mock_identity.derive_persona(PersonaType.PROFESSIONAL)
        social_persona = mock_identity.derive_persona(PersonaType.SOCIAL)

        # Gmail stores to PROFESSIONAL partition
        mock_vault.store(1, "email_1", pro_persona.encrypt("work email"),
                         PersonaType.PROFESSIONAL)
        # Telegram stores to SOCIAL partition
        mock_vault.store(1, "chat_1", social_persona.encrypt("friend chat"),
                         PersonaType.SOCIAL)

        # PROFESSIONAL partition should not contain SOCIAL data
        pro_data = mock_vault.per_persona_partition(PersonaType.PROFESSIONAL)
        social_data = mock_vault.per_persona_partition(PersonaType.SOCIAL)

        assert "email_1" in pro_data
        assert "chat_1" not in pro_data
        assert "chat_1" in social_data
        assert "email_1" not in social_data

# TST-INT-257
    def test_connector_status_visible(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_telegram_connector: MockTelegramConnector,
        mock_calendar_connector: MockCalendarConnector,
    ) -> None:
        """All connectors expose their current status."""
        connectors = [
            mock_gmail_connector,
            mock_telegram_connector,
            mock_calendar_connector,
        ]
        for conn in connectors:
            assert conn.status == ConnectorStatus.ACTIVE
            assert hasattr(conn, "name")
            assert hasattr(conn, "last_poll")
            assert hasattr(conn, "items_ingested")

# TST-INT-499
    def test_connector_can_be_paused(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """User can pause a connector."""
        mock_gmail_connector.status = ConnectorStatus.PAUSED
        assert mock_gmail_connector.status == ConnectorStatus.PAUSED

# TST-INT-500
    def test_connector_can_be_disabled(
        self, mock_telegram_connector: MockTelegramConnector
    ) -> None:
        """User can fully disable a connector."""
        mock_telegram_connector.status = ConnectorStatus.DISABLED
        assert mock_telegram_connector.status == ConnectorStatus.DISABLED

# TST-INT-234
    def test_calendar_connector_defaults(
        self, mock_calendar_connector: MockCalendarConnector
    ) -> None:
        """Calendar connector has correct defaults."""
        assert mock_calendar_connector.name == "calendar"
        assert mock_calendar_connector.persona == PersonaType.PROFESSIONAL
        assert mock_calendar_connector.poll_interval_minutes == 30


# ---------------------------------------------------------------------------
# OAuth Token Lifecycle (Issue #6)
# ---------------------------------------------------------------------------


class TestOAuthTokenLifecycle:
    """OAuth token health state machine.

    States: ACTIVE → NEEDS_REFRESH → ACTIVE (refresh OK)
            ACTIVE → NEEDS_REFRESH → EXPIRED (refresh failed) → notification
            EXPIRED → ACTIVE (user re-authorizes)
            REVOKED → ACTIVE (user re-authorizes)

    Gmail tokens expire every hour. Refresh tokens rotate on use.
    Revocation on password change, security event, or manual revoke.
    """

    def _make_token(self, expires_in: float = 3600) -> OAuthToken:
        """Helper: create a token expiring in ``expires_in`` seconds."""
        return OAuthToken(
            access_token="ya29.mock_access_token",
            refresh_token="1//mock_refresh_token",
            expires_at=time.time() + expires_in,
        )

    # --- Healthy token ---

# TST-INT-501
    def test_healthy_token_stays_active(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Token with >5 min remaining keeps connector ACTIVE."""
        token = self._make_token(expires_in=3600)
        mock_gmail_connector.set_oauth_token(token)

        status = mock_gmail_connector.check_token_health()
        assert status == ConnectorStatus.ACTIVE

    # --- Needs refresh ---

# TST-INT-502
    def test_token_near_expiry_triggers_needs_refresh(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Token expiring in <5 min transitions to NEEDS_REFRESH."""
        token = self._make_token(expires_in=120)  # 2 minutes left
        mock_gmail_connector.set_oauth_token(token)

        status = mock_gmail_connector.check_token_health()
        # Should have attempted refresh — since no handler set, falls to EXPIRED
        assert status in (ConnectorStatus.NEEDS_REFRESH, ConnectorStatus.EXPIRED)

# TST-INT-503
    def test_auto_refresh_succeeds(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Successful auto-refresh transitions NEEDS_REFRESH → ACTIVE."""
        old_token = self._make_token(expires_in=120)
        new_token = self._make_token(expires_in=3600)

        def refresh_handler(token: OAuthToken) -> OAuthToken:
            return new_token

        mock_gmail_connector.set_oauth_token(old_token)
        mock_gmail_connector.set_refresh_handler(refresh_handler)

        status = mock_gmail_connector.check_token_health()
        assert status == ConnectorStatus.ACTIVE
        assert mock_gmail_connector.refresh_attempts == 1
        # No notification emitted on success
        assert len(mock_gmail_connector.notifications_emitted) == 0

# TST-INT-504
    def test_auto_refresh_fails_transitions_to_expired(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Failed auto-refresh transitions NEEDS_REFRESH → EXPIRED."""
        old_token = self._make_token(expires_in=120)

        def failing_handler(token: OAuthToken) -> OAuthToken | None:
            return None  # Refresh failed

        mock_gmail_connector.set_oauth_token(old_token)
        mock_gmail_connector.set_refresh_handler(failing_handler)

        status = mock_gmail_connector.check_token_health()
        assert status == ConnectorStatus.EXPIRED
        assert mock_gmail_connector.refresh_attempts == 1

    # --- Expired token ---

# TST-INT-505
    def test_expired_token_emits_tier2_notification(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Expired token emits a Tier 2 'Re-authorize' notification."""
        token = self._make_token(expires_in=-10)  # Already expired
        mock_gmail_connector.set_oauth_token(token)

        mock_gmail_connector.check_token_health()

        assert mock_gmail_connector.status == ConnectorStatus.EXPIRED
        assert len(mock_gmail_connector.notifications_emitted) == 1
        notif = mock_gmail_connector.notifications_emitted[0]
        assert notif.tier == SilenceTier.TIER_2_SOLICITED
        assert "Gmail" in notif.title
        assert "Re-authorize" in notif.body

# TST-INT-241
    def test_expired_connector_returns_no_data_on_poll(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """An EXPIRED connector must not poll the API — returns empty."""
        token = self._make_token(expires_in=-10)
        mock_gmail_connector.set_oauth_token(token)
        mock_gmail_connector.add_data([
            {"message_id": "msg_nopoll", "content": "Should not be returned"},
        ])

        items = mock_gmail_connector.poll()
        assert items == []

# TST-INT-260
    def test_user_reauthorize_restores_active(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """User re-authorization with fresh token restores ACTIVE."""
        expired_token = self._make_token(expires_in=-10)
        mock_gmail_connector.set_oauth_token(expired_token)
        mock_gmail_connector.check_token_health()
        assert mock_gmail_connector.status == ConnectorStatus.EXPIRED

        fresh_token = self._make_token(expires_in=3600)
        mock_gmail_connector.reauthorize(fresh_token)
        assert mock_gmail_connector.status == ConnectorStatus.ACTIVE

    # --- Revoked token ---

# TST-INT-243
    def test_revoked_token_emits_notification(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Token revocation (e.g. password change) emits Tier 2 notification."""
        token = self._make_token(expires_in=3600)
        mock_gmail_connector.set_oauth_token(token)
        assert mock_gmail_connector.status == ConnectorStatus.ACTIVE

        mock_gmail_connector.revoke()

        assert mock_gmail_connector.status == ConnectorStatus.REVOKED
        assert len(mock_gmail_connector.notifications_emitted) == 1
        notif = mock_gmail_connector.notifications_emitted[0]
        assert notif.tier == SilenceTier.TIER_2_SOLICITED
        assert "revoked" in notif.body.lower()

# TST-INT-506
    def test_revoked_check_token_health_stays_revoked(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Once revoked, check_token_health confirms REVOKED status."""
        token = self._make_token(expires_in=3600)
        mock_gmail_connector.set_oauth_token(token)
        mock_gmail_connector.revoke()

        status = mock_gmail_connector.check_token_health()
        assert status == ConnectorStatus.REVOKED

# TST-INT-507
    def test_revoked_reauthorize_restores_active(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """User can re-authorize after revocation."""
        token = self._make_token(expires_in=3600)
        mock_gmail_connector.set_oauth_token(token)
        mock_gmail_connector.revoke()
        assert mock_gmail_connector.status == ConnectorStatus.REVOKED

        fresh_token = self._make_token(expires_in=3600)
        mock_gmail_connector.reauthorize(fresh_token)
        assert mock_gmail_connector.status == ConnectorStatus.ACTIVE

    # --- No token ---

# TST-INT-245
    def test_no_token_set_is_expired(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Connector with no OAuth token reports EXPIRED."""
        status = mock_gmail_connector.check_token_health()
        assert status == ConnectorStatus.EXPIRED

    # --- Status log ---

# TST-INT-508
    def test_status_transitions_logged(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Every status transition is logged for observability."""
        token = self._make_token(expires_in=3600)
        mock_gmail_connector.set_oauth_token(token)
        mock_gmail_connector.revoke()
        fresh = self._make_token(expires_in=3600)
        mock_gmail_connector.reauthorize(fresh)

        # token_set → ACTIVE, revoke → REVOKED, reauthorize → ACTIVE
        assert len(mock_gmail_connector.status_log) >= 3
        reasons = [e["reason"] for e in mock_gmail_connector.status_log]
        assert "token_set" in reasons
        assert "provider_revoked" in reasons
        assert "user_reauthorized" in reasons

    # --- Refresh token rotation ---

# TST-INT-509
    def test_refresh_rotates_token(
        self, mock_gmail_connector: MockGmailConnector
    ) -> None:
        """Successful refresh replaces the old token entirely (rotation)."""
        old_token = self._make_token(expires_in=120)
        rotated_token = OAuthToken(
            access_token="ya29.new_access",
            refresh_token="1//new_refresh",
            expires_at=time.time() + 3600,
        )

        def rotating_handler(token: OAuthToken) -> OAuthToken:
            return rotated_token

        mock_gmail_connector.set_oauth_token(old_token)
        mock_gmail_connector.set_refresh_handler(rotating_handler)
        mock_gmail_connector.check_token_health()

        assert mock_gmail_connector.status == ConnectorStatus.ACTIVE
        assert mock_gmail_connector._oauth_token is rotated_token


# ---------------------------------------------------------------------------
# Full Ingestion Pipelines
# ---------------------------------------------------------------------------


class TestFullIngestionPipelines:
    """End-to-end ingestion flows — Gmail full pipeline, contacts, cursors."""

# TST-INT-233
    def test_email_ingestion_full_pipeline(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_identity: MockIdentity,
        mock_vault: MockVault,
    ) -> None:
        """Gmail OAuth -> messages fetched -> encrypted -> stored in vault.
        The complete ingestion pipeline from OAuth through to vault storage."""
        # Step 1: Set up OAuth token (simulates Gmail OAuth flow)
        token = OAuthToken(
            access_token="ya29.mock_gmail_token",
            refresh_token="1//mock_refresh",
            expires_at=time.time() + 3600,
        )
        mock_gmail_connector.set_oauth_token(token)
        assert mock_gmail_connector.status == ConnectorStatus.ACTIVE

        # Step 2: Messages arrive from Gmail API
        mock_gmail_connector.add_data([
            {"message_id": "gmail_001", "content": "Q3 quarterly report"},
            {"message_id": "gmail_002", "content": "Team offsite agenda"},
            {"message_id": "gmail_003", "content": "Invoice from vendor"},
        ])

        # Step 3: Poll fetches messages
        items = mock_gmail_connector.poll()
        assert len(items) == 3

        # Step 4: Encrypt and store in vault with persona routing
        persona = mock_identity.derive_persona(mock_gmail_connector.persona)
        for item in items:
            normalized = mock_gmail_connector.normalize(item)
            encrypted = persona.encrypt(normalized["content"])
            mock_vault.store(1, normalized["id"], encrypted,
                             persona=mock_gmail_connector.persona)

        # Step 5: Verify stored data is encrypted
        stored = mock_vault.per_persona_partition(PersonaType.PROFESSIONAL)
        assert len(stored) == 3
        for value in stored.values():
            assert value.startswith("ENC[")

# TST-INT-235
    def test_contacts_sync(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """Contacts synced from Gmail to vault."""
        mock_gmail_connector.add_contacts([
            {"email": "alice@example.com", "name": "Alice Smith"},
            {"email": "bob@corp.com", "name": "Bob Jones"},
            {"email": "carol@startup.io", "name": "Carol Lee"},
        ])

        contacts = mock_gmail_connector.sync_contacts()
        assert len(contacts) == 3

        # Store contacts in vault
        for contact in contacts:
            key = f"contact_{contact['email']}"
            mock_vault.store(1, key, contact,
                             persona=PersonaType.PROFESSIONAL)
            mock_vault.index_for_fts(key, f"{contact['name']} {contact['email']}")

        # Contacts are searchable
        results = mock_vault.search_fts("Alice")
        assert len(results) == 1
        assert "contact_alice@example.com" in results

# TST-INT-239
    def test_cursor_continuity_across_restart(
        self,
        mock_gmail_connector: MockGmailConnector,
    ) -> None:
        """After restart, ingestion resumes from last cursor, not from the
        beginning. The cursor is persisted so no messages are re-processed."""
        # First session: ingest some messages and save cursor
        mock_gmail_connector.add_data([
            {"message_id": "msg_100", "content": "First batch"},
            {"message_id": "msg_101", "content": "First batch"},
        ])
        items = mock_gmail_connector.poll()
        assert len(items) == 2

        # Save cursor after processing
        mock_gmail_connector.save_cursor("cursor_after_msg_101")
        assert mock_gmail_connector.cursor == "cursor_after_msg_101"

        # Simulate restart: create a new connector but restore cursor
        restarted_connector = MockGmailConnector()
        saved_cursor = mock_gmail_connector.cursor
        restarted_connector.save_cursor(saved_cursor)

        # The restarted connector has the cursor from the previous session
        assert restarted_connector.cursor == "cursor_after_msg_101"

        # New messages arrive after cursor position
        restarted_connector.add_data([
            {"message_id": "msg_102", "content": "New after restart"},
        ])
        new_items = restarted_connector.poll()
        assert len(new_items) == 1
        assert new_items[0]["message_id"] == "msg_102"


# ---------------------------------------------------------------------------
# Core/Brain Boundary Rules
# ---------------------------------------------------------------------------


class TestCoreBrainBoundary:
    """Security boundaries between Core, Brain, and external systems."""

# TST-INT-250
    def test_core_never_calls_external_apis_during_ingestion(
        self,
        mock_go_core: MockGoCore,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """Core never calls external APIs during ingestion. All external
        calls (Gmail API, etc.) go through Brain/connectors. Core only
        receives pre-fetched data and stores it in the vault."""
        # Simulate connector fetching data (this is the Brain/connector's job)
        mock_gmail_connector.add_data([
            {"message_id": "ext_1", "content": "External data"},
        ])
        items = mock_gmail_connector.poll()

        # Core only stores — it never reaches out externally
        for item in items:
            mock_go_core.vault_store(
                key=item["message_id"],
                value=item["content"],
                tier=1,
                persona=PersonaType.PROFESSIONAL,
            )

        # Core's API call log shows only vault operations
        for call in mock_go_core.api_calls:
            assert call["endpoint"].startswith("/v1/vault/"), (
                f"Core must only call vault endpoints, got: {call['endpoint']}"
            )

# TST-INT-252
    def test_openclaw_sandboxed_no_vault_access(
        self,
        mock_external_agent: MockExternalAgent,
        mock_vault: MockVault,
    ) -> None:
        """External agent (OpenClaw) has no vault access. It receives
        only cleaned queries — never raw vault data."""
        # Store private data in vault
        mock_vault.store(1, "private_health", {"diagnosis": "healthy"},
                         persona=PersonaType.HEALTH)
        mock_vault.store(1, "private_email", {"content": "salary discussion"},
                         persona=PersonaType.FINANCIAL)

        # External agent executes a task — it gets a cleaned query, not vault data
        task = {
            "task_id": "search_001",
            "action": "search",
            "query": "Find best laptop for travel",
            # No vault data included
        }
        result = mock_external_agent.execute_task(task)

        # Agent completed the task without accessing the vault
        assert result["status"] == "completed"

        # The agent's task history should not contain any vault data
        for executed in mock_external_agent.tasks_executed:
            task_str = str(executed)
            assert "private_health" not in task_str
            assert "salary discussion" not in task_str
            assert "diagnosis" not in task_str

# TST-INT-253
    def test_brain_scrubs_before_cloud_llm(
        self,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
    ) -> None:
        """PII is scrubbed before any data is sent to cloud LLM.
        The scrubber removes personal information, and the Brain
        only sends the cleaned version to cloud providers."""
        scrubber = MockPIIScrubber()

        # Simulate vault data that contains PII
        raw_text = (
            "Meeting with Rajmohan at rajmohan@email.com about "
            "Sancho's project at 123 Main Street"
        )

        # Brain must scrub before sending to cloud LLM
        scrubbed, replacement_map = scrubber.scrub(raw_text)

        # Scrubbed text must not contain any PII
        assert "Rajmohan" not in scrubbed
        assert "rajmohan@email.com" not in scrubbed
        assert "Sancho" not in scrubbed
        assert "123 Main Street" not in scrubbed

        # Placeholders are present instead
        assert "[PERSON_1]" in scrubbed
        assert "[EMAIL_1]" in scrubbed
        assert "[PERSON_2]" in scrubbed
        assert "[ADDRESS_1]" in scrubbed

        # Validate the scrubbed text is clean
        assert scrubber.validate_clean(scrubbed) is True

        # After LLM response, Brain can restore PII locally
        llm_response = "Schedule follow-up with [PERSON_1] at [ADDRESS_1]"
        restored = scrubber.desanitize(llm_response, replacement_map)
        assert "Rajmohan" in restored
        assert "123 Main Street" in restored

# TST-INT-256
    def test_attachment_metadata_only_in_vault(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """Attachments are stored as metadata only — not raw file content.
        The vault stores filename, size, type, etc. but not the binary blob."""
        mock_gmail_connector.add_data([
            {
                "message_id": "att_msg_1",
                "content": "Please review the attached report",
                "attachments": [
                    {
                        "filename": "Q3_Report.pdf",
                        "size_bytes": 2_500_000,
                        "mime_type": "application/pdf",
                    },
                    {
                        "filename": "budget.xlsx",
                        "size_bytes": 150_000,
                        "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    },
                ],
            },
        ])
        items = mock_gmail_connector.poll()

        for item in items:
            # Store metadata only — strip binary content
            metadata = {
                "id": item["message_id"],
                "content": item["content"],
                "attachment_metadata": [
                    {
                        "filename": att["filename"],
                        "size_bytes": att["size_bytes"],
                        "mime_type": att["mime_type"],
                    }
                    for att in item.get("attachments", [])
                ],
            }
            mock_vault.store(1, item["message_id"], metadata,
                             persona=PersonaType.PROFESSIONAL)

        stored = mock_vault.retrieve(1, "att_msg_1",
                                      persona=PersonaType.PROFESSIONAL)
        assert stored is not None
        assert len(stored["attachment_metadata"]) == 2
        assert stored["attachment_metadata"][0]["filename"] == "Q3_Report.pdf"
        # No raw file content in vault — only metadata fields
        assert "file_content" not in str(stored)
        assert "binary" not in str(stored).lower()  # no binary blobs stored


# ---------------------------------------------------------------------------
# Fast Sync and Backfill
# ---------------------------------------------------------------------------


class TestFastSyncAndBackfill:
    """Fast initial sync returns results quickly; background backfill follows."""

# TST-INT-258
    def test_fast_sync_ready_in_seconds(
        self,
        mock_gmail_connector: MockGmailConnector,
    ) -> None:
        """Initial sync returns the first batch quickly (fast sync).
        The user sees results immediately instead of waiting for full sync."""
        # 500 emails total
        all_emails = [
            {"message_id": f"email_{i}", "content": f"Email content {i}"}
            for i in range(500)
        ]

        # Fast sync returns only the first batch
        first_batch = mock_gmail_connector.fast_sync(all_emails)

        assert len(first_batch) == mock_gmail_connector._fast_sync_batch_size
        assert len(first_batch) == 50  # default fast sync batch
        assert first_batch[0]["message_id"] == "email_0"

        # Remaining items queued for backfill
        assert len(mock_gmail_connector._backfill_queue) == 450

# TST-INT-259
    def test_background_backfill(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """After fast sync, remaining emails are backfilled in background."""
        all_emails = [
            {"message_id": f"bf_{i}", "content": f"Backfill email {i}"}
            for i in range(200)
        ]

        # Fast sync grabs the first batch
        first_batch = mock_gmail_connector.fast_sync(all_emails)
        assert len(first_batch) == 50

        # Background backfill processes the rest
        assert not mock_gmail_connector._backfill_complete
        backfill_items = mock_gmail_connector.backfill()
        assert len(backfill_items) == 150
        assert mock_gmail_connector._backfill_complete is True

        # After backfill, queue is empty
        assert len(mock_gmail_connector._backfill_queue) == 0

        # Total items = fast sync + backfill
        total = len(first_batch) + len(backfill_items)
        assert total == 200

# TST-INT-261
    def test_time_horizon_enforced(
        self,
        mock_gmail_connector: MockGmailConnector,
    ) -> None:
        """Ingestion respects configured time horizon (e.g. 30 days).
        Only messages within the horizon are ingested."""
        now = time.time()
        mock_gmail_connector.set_time_horizon(30)

        items = [
            {"message_id": "recent_1", "content": "Today's email",
             "timestamp": now - 86400},          # 1 day ago
            {"message_id": "recent_2", "content": "Last week's email",
             "timestamp": now - 7 * 86400},      # 7 days ago
            {"message_id": "old_1", "content": "Two months ago",
             "timestamp": now - 60 * 86400},     # 60 days ago
            {"message_id": "old_2", "content": "Last year",
             "timestamp": now - 365 * 86400},    # 365 days ago
        ]

        filtered = mock_gmail_connector.filter_by_time_horizon(items, now=now)

        assert len(filtered) == 2
        filtered_ids = {item["message_id"] for item in filtered}
        assert "recent_1" in filtered_ids
        assert "recent_2" in filtered_ids
        assert "old_1" not in filtered_ids
        assert "old_2" not in filtered_ids

# TST-INT-262
    def test_cold_archive_pass_through(
        self,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """Old emails outside the time horizon are stored in deep archive
        (Tier 5) but not indexed for search. They are preserved as a
        pass-through to cold storage."""
        now = time.time()
        mock_gmail_connector.set_time_horizon(30)

        all_items = [
            {"message_id": "hot_1", "content": "Recent email",
             "timestamp": now - 5 * 86400},
            {"message_id": "cold_1", "content": "Ancient email",
             "timestamp": now - 180 * 86400},
            {"message_id": "cold_2", "content": "Very old email",
             "timestamp": now - 365 * 86400},
        ]

        hot_items = mock_gmail_connector.filter_by_time_horizon(
            all_items, now=now
        )
        cold_items = [i for i in all_items if i not in hot_items]

        # Hot items go to Tier 1 with FTS indexing
        for item in hot_items:
            mock_vault.store(1, item["message_id"], item,
                             persona=PersonaType.PROFESSIONAL)
            mock_vault.index_for_fts(item["message_id"], item["content"])

        # Cold items go to Tier 5 archive — stored but NOT indexed
        for item in cold_items:
            mock_vault.store(5, item["message_id"], item,
                             persona=PersonaType.PROFESSIONAL)

        # Hot items are searchable
        assert mock_vault.search_fts("Recent") == ["hot_1"]

        # Cold items are in archive but NOT searchable
        assert mock_vault.retrieve(5, "cold_1",
                                    persona=PersonaType.PROFESSIONAL) is not None
        assert mock_vault.retrieve(5, "cold_2",
                                    persona=PersonaType.PROFESSIONAL) is not None
        assert "cold_1" not in mock_vault.search_fts("Ancient")
        assert "cold_2" not in mock_vault.search_fts("Very")

# TST-INT-263
    def test_openclaw_outage_during_backfill(
        self,
        mock_external_agent: MockExternalAgent,
        mock_gmail_connector: MockGmailConnector,
        mock_vault: MockVault,
    ) -> None:
        """Connector outage (e.g. OpenClaw crash) does not block other
        ingestion. Gmail continues to ingest even if an external agent
        is unavailable."""
        # External agent crashes
        mock_external_agent.set_should_fail(True)

        # Gmail ingestion continues independently
        mock_gmail_connector.add_data([
            {"message_id": "resilient_1", "content": "Email 1"},
            {"message_id": "resilient_2", "content": "Email 2"},
        ])
        items = mock_gmail_connector.poll()
        assert len(items) == 2

        # Store in vault — not blocked by agent outage
        for item in items:
            normalized = mock_gmail_connector.normalize(item)
            mock_vault.store(1, normalized["id"], normalized,
                             persona=PersonaType.PROFESSIONAL)

        # Verify data stored successfully despite agent outage
        stored = mock_vault.per_persona_partition(PersonaType.PROFESSIONAL)
        assert len(stored) == 2

        # Agent is still crashed — unrelated to ingestion
        assert mock_external_agent._should_fail is True
