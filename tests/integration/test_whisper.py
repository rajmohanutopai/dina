"""Integration tests for context injection (whispers) and disconnect detection.

A "whisper" is Dina's private overlay for the user: contextual hints
assembled from the vault before a conversation or meeting. Whispers are
displayed only to the user (never shared) and respect the silence tier.

Disconnect detection identifies when a conversation was interrupted
or when social cues suggest the user needs help.
"""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    MockDinaCore,
    MockHuman,
    MockSilenceClassifier,
    MockVault,
    MockWhisperAssembler,
    Notification,
    SilenceTier,
)


# -----------------------------------------------------------------------
# TestWhisperAssembly
# -----------------------------------------------------------------------


class TestWhisperAssembly:
    """Verify that whispers assemble context from the vault."""

    def test_telegram_conversation_context(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
        sancho_identity,
    ) -> None:
        """Whisper pulls relevant context before a Telegram chat."""
        contact_did = sancho_identity.root_did

        # Seed the vault with conversation history
        mock_vault.store(1, "telegram_sancho_last", {
            "contact": contact_did,
            "last_message": "He asked for the project PDF last Friday",
            "context_flag": "His mother was in hospital last month",
            "preference": "Prefers voice notes over text",
        })

        whisper = mock_whisper.assemble_context(contact_did, "telegram_chat")

        assert whisper is not None
        assert "PDF" in whisper
        assert "mother" in whisper
        assert "voice notes" in whisper
        # Whisper log records the assembly
        assert len(mock_whisper.whisper_log) == 1
        assert mock_whisper.whisper_log[0]["contact"] == contact_did

    def test_meeting_preparation(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
    ) -> None:
        """Whisper assembles context for an upcoming meeting."""
        colleague_did = "did:plc:Colleague000000000000000000000"

        mock_vault.store(1, "meeting_context_colleague", {
            "contact": colleague_did,
            "last_message": "Discussed budget overrun last sprint",
            "context_flag": "She prefers data-driven arguments",
        })

        whisper = mock_whisper.assemble_context(
            colleague_did, "meeting_preparation"
        )

        assert whisper is not None
        assert "budget" in whisper
        assert "data-driven" in whisper

    def test_whisper_delivered_as_overlay(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
        mock_human: MockHuman, sancho_identity,
    ) -> None:
        """Whisper is delivered to the user as a private overlay notification."""
        contact_did = sancho_identity.root_did

        mock_vault.store(1, "overlay_context_sancho", {
            "contact": contact_did,
            "last_message": "Promised to return his book",
            "context_flag": "Birthday next week",
        })

        whisper = mock_whisper.assemble_context(contact_did, "incoming_call")
        assert whisper is not None

        # Deliver the whisper as a Tier 2 notification (user requested context)
        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Context for Sancho",
            body=whisper,
            source="whisper_assembler",
        )
        mock_human.receive_notification(notification)

        assert len(mock_human.notifications) == 1
        assert "book" in mock_human.notifications[0].body
        assert "Birthday" in mock_human.notifications[0].body

    def test_whisper_respects_silence_tier(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
        mock_classifier: MockSilenceClassifier, mock_human: MockHuman,
        sancho_identity,
    ) -> None:
        """Whispers are classified and respect the silence tier system."""
        contact_did = sancho_identity.root_did

        mock_vault.store(1, "silence_context_sancho", {
            "contact": contact_did,
            "last_message": "Casual catch-up planned",
        })

        whisper = mock_whisper.assemble_context(contact_did)
        assert whisper is not None

        # Classify the whisper event
        tier = mock_classifier.classify(
            "whisper_context", whisper
        )
        # A casual whisper with no fiduciary keywords should be Tier 3
        assert tier == SilenceTier.TIER_3_ENGAGEMENT

        # In Tier 3, the whisper is saved for briefing, not pushed
        assert len(mock_human.notifications) == 0


# -----------------------------------------------------------------------
# TestDisconnectDetection
# -----------------------------------------------------------------------


class TestDisconnectDetection:
    """Detect interrupted conversations and social cues."""

    def test_detects_interrupted_conversation(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
        sancho_identity,
    ) -> None:
        """When conversation was left mid-thread, whisper flags it."""
        contact_did = sancho_identity.root_did

        # Store a context flag indicating the conversation was interrupted
        mock_vault.store(1, "interrupted_sancho", {
            "contact": contact_did,
            "last_message": "Conversation interrupted mid-sentence",
            "context_flag": "Disconnected abruptly during discussion about project",
        })

        whisper = mock_whisper.assemble_context(
            contact_did, "conversation_resume"
        )

        assert whisper is not None
        assert "interrupted" in whisper.lower() or "Disconnected" in whisper
        # The whisper log records the situation
        assert mock_whisper.whisper_log[-1]["situation"] == "conversation_resume"

    def test_social_cue_awareness(
        self, mock_vault: MockVault, mock_whisper: MockWhisperAssembler,
    ) -> None:
        """Whisper picks up social cues stored in the vault."""
        contact_did = "did:plc:Maria000000000000000000000000000"

        # Store social cue context
        mock_vault.store(1, "social_cue_maria", {
            "contact": contact_did,
            "context_flag": "She seemed upset in last conversation",
            "preference": "Be empathetic and avoid work topics",
        })

        whisper = mock_whisper.assemble_context(contact_did, "social_meeting")

        assert whisper is not None
        assert "upset" in whisper
        assert "empathetic" in whisper

        # No stored last_message, but context_flag and preference still assemble
        log_entry = mock_whisper.whisper_log[-1]
        assert log_entry["situation"] == "social_meeting"
        assert log_entry["whisper"] is not None
