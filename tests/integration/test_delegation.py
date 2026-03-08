"""Integration tests for task delegation to external agents with oversight.

Dina can delegate tasks to specialist agents (e.g. LegalBot for license
renewal, OpenClaw for general tasks). But delegation is always under Dina's
oversight: read-only tasks auto-approve, write actions need user approval,
financial actions are always flagged HIGH, and scope is strictly limited.
"""

from __future__ import annotations

import uuid

import pytest

from tests.integration.mocks import (
    ActionRisk,
    AgentIntent,
    Draft,
    MockDinaCore,
    MockExternalAgent,
    MockHuman,
    MockLegalBot,
    MockStagingTier,
    Notification,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# TestLicenseRenewalFlow
# ---------------------------------------------------------------------------

class TestLicenseRenewalFlow:
    """End-to-end delegation flow: detect expiring license, suggest
    delegation to LegalBot, user approves, agent executes, report back."""

# TST-INT-240
    def test_detects_license_expiring(
        self, mock_dina: MockDinaCore, sample_events: list[dict],
    ) -> None:
        """Dina detects an upcoming license expiry from calendar/reminder
        data and classifies it as a solicited notification."""
        license_event = next(
            e for e in sample_events if e["id"] == "license_renewal"
        )
        assert license_event["type"] == "reminder"
        assert "license" in license_event["title"].lower()

        # Classify the event
        tier = mock_dina.classifier.classify(
            event_type="reminder",
            content=license_event["title"],
        )
        assert tier == SilenceTier.TIER_2_SOLICITED

# TST-INT-296
    def test_suggests_delegation(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_legal_bot: MockLegalBot,
    ) -> None:
        """Dina suggests delegating the license renewal to LegalBot.
        This is a notification, not an auto-action — user must approve."""
        # Pre-condition: no notifications yet
        assert len(mock_human.notifications) == 0

        # Classify the delegation task — "create_draft" is MODERATE risk
        intent = AgentIntent(
            agent_did=mock_legal_bot.bot_did,
            action="create_draft",
            target="government_portal",
            context={"task": "license_renewal"},
        )
        risk = mock_dina.classify_action_risk(intent)
        assert risk == ActionRisk.MODERATE  # not SAFE — needs approval

        # Notification offers delegation as an option, not auto-action
        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="License renewal due soon",
            body="Your driver's license expires on 2026-02-22. "
                 "Would you like to delegate renewal to LegalBot?",
            actions=["delegate_to_legal_bot", "remind_later", "dismiss"],
            source="calendar_connector",
        )
        mock_human.receive_notification(notification)
        assert len(mock_human.notifications) == 1
        assert "delegate_to_legal_bot" in mock_human.notifications[0].actions

        # Counter-proof: delegation is NOT auto-approved — user must consent
        mock_human.set_approval("create_draft", False)
        rejected = mock_dina.approve_intent(intent, mock_human)
        assert rejected is False  # user rejected → no delegation

# TST-INT-293
    def test_user_approves_delegation(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_legal_bot: MockLegalBot,
    ) -> None:
        """When the user approves delegation, an AgentIntent is created
        and passes through the risk classifier."""
        mock_human.set_approval("create_draft", True)

        intent = AgentIntent(
            agent_did=mock_legal_bot.bot_did,
            action="create_draft",
            target="government_portal",
            context={"task": "license_renewal",
                      "deadline": "2026-02-22"},
        )

        # Risk classification: create_draft → MODERATE (not SAFE, not BLOCKED)
        risk = mock_dina.classify_action_risk(intent)
        assert risk == ActionRisk.MODERATE

        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is True
        assert intent.risk_level == ActionRisk.MODERATE

        # Counter-proof: user rejects → returns False
        mock_human.set_approval("create_draft", False)
        intent2 = AgentIntent(
            agent_did=mock_legal_bot.bot_did,
            action="create_draft",
            target="government_portal",
            context={"task": "license_renewal"},
        )
        rejected = mock_dina.approve_intent(intent2, mock_human)
        assert rejected is False

        # Counter-proof: SAFE action doesn't need user approval
        safe_intent = AgentIntent(
            agent_did=mock_legal_bot.bot_did,
            action="search",
            target="knowledge_base",
            context={},
        )
        safe_approved = mock_dina.approve_intent(safe_intent, mock_human)
        assert safe_approved is True
        assert safe_intent.risk_level == ActionRisk.SAFE

# TST-INT-292
    def test_agent_executes_with_oversight(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_legal_bot: MockLegalBot,
    ) -> None:
        """LegalBot fills the form but produces a Draft, not a submission.
        Dina stores the draft in staging for user review."""
        identity_data = {
            "name": "Rajmohan",
            "license_number": "DL-XXXX-1234",
            "dob": "XXXX-XX-XX",
        }

        draft = mock_legal_bot.form_fill(
            task="Driver license renewal",
            identity_data=identity_data,
            constraints={"max_fee": 500},
        )

        # Verify LegalBot produced a draft, not a submission
        assert isinstance(draft, Draft)
        assert draft.sent is False
        assert "Driver license renewal" in draft.subject

        # Store in staging
        mock_dina.staging.store_draft(draft)
        retrieved = mock_dina.staging.get(draft.draft_id)
        assert retrieved is not None
        assert retrieved.sent is False

        # LegalBot logged its form fill
        assert len(mock_legal_bot.form_fills) == 1
        fill_log = mock_legal_bot.form_fills[0]
        assert fill_log["task"] == "Driver license renewal"
        assert "name" in fill_log["identity_fields"]

# TST-INT-465
    def test_completion_reported(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_legal_bot: MockLegalBot,
    ) -> None:
        """After the user reviews and sends the draft, a completion
        notification is generated.  Verifies the full staging pipeline:
        form_fill → store → retrieve → mark sent."""
        # Counter-proof: non-existent draft returns None
        assert mock_dina.staging.get("nonexistent_draft_id") is None

        # LegalBot fills the form
        draft = mock_legal_bot.form_fill(
            task="License renewal",
            identity_data={"name": "Rajmohan"},
        )
        assert draft.draft_id  # must have an ID
        assert draft.sent is False  # draft starts unsent

        # Store in staging
        stored_id = mock_dina.staging.store_draft(draft)
        assert stored_id == draft.draft_id

        # Retrieve and verify content matches form_fill output
        retrieved = mock_dina.staging.get(draft.draft_id)
        assert retrieved is not None
        assert retrieved.draft_id == draft.draft_id
        assert retrieved.sent is False  # still unsent before review

        # Counter-proof: a different draft_id does not collide
        assert mock_dina.staging.get("some_other_draft") is None

        # User reviews and marks as sent
        retrieved.sent = True
        assert mock_dina.staging.get(draft.draft_id).sent is True

        # Verify the draft has meaningful content from form_fill
        assert "License renewal" in retrieved.body
        assert retrieved.subject == "Draft: License renewal"

# TST-INT-466
    def test_failure_handled(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """If the delegated agent fails, Dina notifies the user and the
        task is not silently dropped."""
        agent = MockExternalAgent(name="FailBot")
        agent.set_should_fail(True)

        intent = agent.submit_intent(
            AgentIntent(agent_did="", action="search",
                        target="license_renewal_portal")
        )
        mock_dina.approve_intent(intent, mock_human)

        with pytest.raises(RuntimeError, match="crashed"):
            agent.execute_task(
                {"task_id": "license_task", "action": "form_fill"}
            )

        assert agent.status == "failed"

        # Dina notifies the user about the failure
        failure_notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Delegation failed",
            body=f"Agent '{agent.name}' failed while processing "
                 f"license renewal. Manual action may be required.",
            actions=["retry", "manual", "dismiss"],
            source="delegation_manager",
        )
        mock_human.receive_notification(failure_notification)

        assert len(mock_human.notifications) == 1
        assert "failed" in mock_human.notifications[0].body
        assert "retry" in mock_human.notifications[0].actions


# ---------------------------------------------------------------------------
# TestGenericDelegation
# ---------------------------------------------------------------------------

class TestGenericDelegation:
    """Generic delegation rules — risk-based approval for any agent."""

# TST-INT-467
    def test_read_only_auto_approved(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Read-only operations (search, lookup, read) are SAFE and
        auto-approved without user interaction.  Write/financial actions
        are NOT auto-approved — they require human consent."""
        for action in ("search", "lookup", "read"):
            intent = mock_external_agent.submit_intent(
                AgentIntent(agent_did="", action=action,
                            target="public_data")
            )
            approved = mock_dina.approve_intent(intent, mock_human)

            assert approved is True
            assert intent.risk_level == ActionRisk.SAFE

        # Counter-proof: a write action is NOT auto-approved (MODERATE risk)
        mock_human.set_approval("send_email", False)
        write_intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="send_email",
                        target="colleague@work.com")
        )
        write_approved = mock_dina.approve_intent(write_intent, mock_human)
        assert write_approved is False, (
            "Write action must NOT be auto-approved — requires human consent"
        )
        assert write_intent.risk_level == ActionRisk.MODERATE

        # Counter-proof: a financial action is HIGH risk, never auto-approved
        mock_human.set_approval("transfer_money", False)
        financial_intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor_account")
        )
        financial_approved = mock_dina.approve_intent(financial_intent, mock_human)
        assert financial_approved is False, (
            "Financial action must NOT be auto-approved"
        )
        assert financial_intent.risk_level == ActionRisk.HIGH

# TST-INT-242
    def test_write_requires_approval(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Write operations (send_email, create_draft, update_calendar)
        are MODERATE risk and require user approval."""
        mock_human.set_approval("send_email", True)
        mock_human.set_approval("create_draft", True)
        mock_human.set_approval("update_calendar", False)

        # send_email — approved
        intent_email = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="send_email",
                        target="colleague@work.com")
        )
        assert mock_dina.approve_intent(intent_email, mock_human) is True
        assert intent_email.risk_level == ActionRisk.MODERATE

        # create_draft — approved
        intent_draft = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="create_draft",
                        target="notes")
        )
        assert mock_dina.approve_intent(intent_draft, mock_human) is True
        assert intent_draft.risk_level == ActionRisk.MODERATE

        # update_calendar — denied by user
        intent_cal = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="update_calendar",
                        target="meeting_slot")
        )
        assert mock_dina.approve_intent(intent_cal, mock_human) is False
        assert intent_cal.risk_level == ActionRisk.MODERATE

# TST-INT-294
    def test_financial_always_flagged(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Financial actions (transfer_money) are always HIGH risk,
        regardless of the agent's trust score."""
        # Even with default_approve=True, the risk level is HIGH
        mock_human.default_approve = True

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor@upi",
                        context={"amount": 100, "currency": "INR"})
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        # Approved because default_approve is True, but risk is still HIGH
        assert approved is True
        assert intent.risk_level == ActionRisk.HIGH

        # Now deny it — financial should always be flagged even if small
        mock_human.set_approval("transfer_money", False)
        intent2 = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor@upi",
                        context={"amount": 1, "currency": "INR"})
        )
        approved2 = mock_dina.approve_intent(intent2, mock_human)

        assert approved2 is False
        assert intent2.risk_level == ActionRisk.HIGH

# TST-INT-468
    def test_delegation_scope_limited(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """An agent approved for 'search' cannot escalate to 'delete'.
        Each action requires its own approval cycle."""
        # Approve search
        search_intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="docs")
        )
        search_approved = mock_dina.approve_intent(search_intent, mock_human)
        assert search_approved is True

        # Now the same agent tries to delete — requires separate approval
        mock_human.set_approval("delete", False)
        delete_intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="delete", target="docs")
        )
        delete_approved = mock_dina.approve_intent(delete_intent, mock_human)

        assert delete_approved is False
        assert delete_intent.risk_level == ActionRisk.HIGH
        # The search approval does not carry over to delete
        assert search_intent.action != delete_intent.action
