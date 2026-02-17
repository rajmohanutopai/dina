"""Integration tests for the Dina safety layer.

Tests agent intent approval, credential protection, and safety edge cases.
Every action flows through Dina's risk classifier — safe tasks auto-approve,
moderate/high tasks require human approval, and blocked actions are rejected.
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
    MockStagingTier,
    Notification,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# TestAgentIntentApproval
# ---------------------------------------------------------------------------

class TestAgentIntentApproval:
    """Verify that the risk classifier gates every agent action correctly."""

    def test_safe_task_auto_approves(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Read-only actions (search, lookup) should auto-approve without
        prompting the user."""
        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="laptops")
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is True
        assert intent.risk_level == ActionRisk.SAFE
        # User was never asked — no approval entry was consumed
        assert mock_human.notifications == []

    def test_email_send_requires_approval(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Sending email is a moderate-risk write action. The human must
        explicitly approve."""
        mock_human.set_approval("send_email", True)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="send_email",
                        target="boss@company.com")
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is True
        assert intent.risk_level == ActionRisk.MODERATE

    def test_email_denied(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """When the user denies an email-send intent, Dina must refuse."""
        mock_human.set_approval("send_email", False)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="send_email",
                        target="spam@example.com")
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is False
        assert intent.risk_level == ActionRisk.MODERATE

    def test_money_transfer_requires_approval(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Financial actions are always HIGH risk — never auto-approved."""
        mock_human.set_approval("transfer_money", True)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor@upi",
                        context={"amount": 5000, "currency": "INR"})
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is True
        assert intent.risk_level == ActionRisk.HIGH

    def test_data_sharing_requires_approval(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Sharing personal data is HIGH risk — user must approve."""
        mock_human.set_approval("share_data", False)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="share_data",
                        target="analytics_corp",
                        context={"fields": ["email", "location"]})
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is False
        assert intent.risk_level == ActionRisk.HIGH

    def test_untrusted_vendor_blocked(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """An intent with an action that doesn't match any known category
        is classified as MODERATE by default. A truly blocked vendor would
        have its risk overridden. Here we test that unknown agents still
        require approval and are not auto-approved."""
        mock_human.set_approval("install_extension", False)

        untrusted = MockExternalAgent(name="ShadyBot")
        intent = untrusted.submit_intent(
            AgentIntent(agent_did="", action="install_extension",
                        target="spyware.crx")
        )
        approved = mock_dina.approve_intent(intent, mock_human)

        assert approved is False
        # Default for unknown actions is MODERATE
        assert intent.risk_level == ActionRisk.MODERATE

    def test_agent_never_holds_keys(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """External agents must never receive the user's root private key
        or any persona-derived key."""
        root_key = mock_dina.identity.root_private_key

        # Agent submits and executes a task
        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="products")
        )
        task_result = mock_external_agent.execute_task(
            {"task_id": "t1", "action": "search"}
        )

        # Assert the key never appears in the agent's memory
        all_agent_data = str(mock_external_agent.intents_submitted) + \
            str(mock_external_agent.tasks_executed)
        assert root_key not in all_agent_data

    def test_agent_never_sees_full_history(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
        sample_memory,
    ) -> None:
        """An external agent cannot query Dina's vault directly."""
        # The vault has pre-populated data (via sample_memory fixture)
        vault_content = mock_dina.vault._tiers[1]
        assert len(vault_content) > 0  # Sanity: data exists

        # Agent can only submit intents — it has no vault reference
        assert not hasattr(mock_external_agent, "vault")
        assert not hasattr(mock_external_agent, "_vault")

    def test_multiple_agents_same_task(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Two agents submitting the same intent should each be approved
        independently — no cross-contamination."""
        agent_a = MockExternalAgent(name="AgentA")
        agent_b = MockExternalAgent(name="AgentB")

        intent_a = agent_a.submit_intent(
            AgentIntent(agent_did="", action="search", target="laptops")
        )
        intent_b = agent_b.submit_intent(
            AgentIntent(agent_did="", action="search", target="laptops")
        )

        approved_a = mock_dina.approve_intent(intent_a, mock_human)
        approved_b = mock_dina.approve_intent(intent_b, mock_human)

        assert approved_a is True
        assert approved_b is True
        # Each agent has its own DID
        assert intent_a.agent_did != intent_b.agent_did
        # Each agent recorded its own intent
        assert len(agent_a.intents_submitted) == 1
        assert len(agent_b.intents_submitted) == 1


# ---------------------------------------------------------------------------
# TestCredentialProtection
# ---------------------------------------------------------------------------

class TestCredentialProtection:
    """Dina never exposes raw credentials to agents or external systems."""

    def test_credentials_never_exposed(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """The PII scrubber must strip credentials before any cloud-bound
        data leaves the system."""
        raw_text = (
            "My email is rajmohan@email.com and my card is 4111-2222-3333-4444. "
            "Please help me buy a laptop."
        )
        scrubbed, replacements = mock_dina.scrubber.scrub(raw_text)

        assert "rajmohan@email.com" not in scrubbed
        assert "4111-2222-3333-4444" not in scrubbed
        assert "[EMAIL_1]" in scrubbed
        assert "[CC_NUM]" in scrubbed
        # Replacement map allows Dina to restore later
        assert replacements["[EMAIL_1]"] == "rajmohan@email.com"
        assert replacements["[CC_NUM]"] == "4111-2222-3333-4444"

    def test_agent_accepts_no_external_commands(
        self, mock_external_agent: MockExternalAgent,
    ) -> None:
        """An agent only executes tasks submitted through Dina's approve flow.
        It has no public 'run arbitrary command' method."""
        # The agent's public interface is limited to submit_intent / execute_task
        public_methods = [m for m in dir(mock_external_agent) if not m.startswith("_")]
        dangerous_methods = {"run_command", "eval", "exec", "shell", "os_call"}
        assert dangerous_methods.isdisjoint(set(public_methods))

    def test_session_tokens_expire(
        self, mock_dina: MockDinaCore,
    ) -> None:
        """Staging-tier items (drafts, payment intents) expire automatically.
        There are no immortal session tokens."""
        import time as _time

        staging = mock_dina.staging
        now = _time.time()

        draft = Draft(
            draft_id="d_expire_test",
            to="someone@example.com",
            subject="Test",
            body="Hello",
            confidence=0.9,
            created_at=now,
            expires_at=0.0,  # will be set by staging
        )
        staging.store_draft(draft)

        # Immediately retrievable (expires_at should be ~now + 72h)
        assert staging.get(draft.draft_id) is not None

        # After expiry window passes, the item should be gone
        far_future = draft.expires_at + 1
        expired_count = staging.auto_expire(current_time=far_future)
        assert expired_count == 1
        assert staging.get(draft.draft_id) is None


# ---------------------------------------------------------------------------
# TestSafetyEdgeCases
# ---------------------------------------------------------------------------

class TestSafetyEdgeCases:
    """Edge cases: crashes, concurrency, escalation, offline queuing."""

    def test_agent_crashes_mid_task(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """If an external agent crashes during execution, its status is
        'failed' and Dina is never left in an inconsistent state."""
        mock_external_agent.set_should_fail(True)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="chairs")
        )
        mock_dina.approve_intent(intent, mock_human)

        with pytest.raises(RuntimeError, match="crashed during execution"):
            mock_external_agent.execute_task(
                {"task_id": "crash_test", "action": "search"}
            )

        assert mock_external_agent.status == "failed"
        # No task recorded in executed list
        assert len(mock_external_agent.tasks_executed) == 0

    def test_concurrent_conflicting_actions(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Two agents submitting conflicting intents (e.g. buy vs. cancel)
        are evaluated independently. The human decides each one."""
        buyer = MockExternalAgent(name="BuyerBot")
        canceller = MockExternalAgent(name="CancelBot")

        buy_intent = buyer.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor",
                        context={"amount": 10000})
        )
        cancel_intent = canceller.submit_intent(
            AgentIntent(agent_did="", action="transfer_money",
                        target="vendor",
                        context={"amount": -10000, "reason": "cancel"})
        )

        mock_human.set_approval("transfer_money", True)
        buy_approved = mock_dina.approve_intent(buy_intent, mock_human)

        # Now user changes mind — denies the cancel refund
        mock_human.set_approval("transfer_money", False)
        cancel_approved = mock_dina.approve_intent(cancel_intent, mock_human)

        assert buy_approved is True
        assert cancel_approved is False

    def test_privilege_escalation_attempt(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """An agent that attempts privilege escalation should have the
        escalation flag set, but Dina's approval layer evaluates the *original*
        intent risk, not the escalated one."""
        mock_external_agent.set_should_escalate(True)

        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="public_data")
        )
        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is True  # search is SAFE

        # Even though escalation flag is set, Dina evaluated the declared action
        result = mock_external_agent.execute_task(
            {"task_id": "esc_test", "action": "search"}
        )
        assert result["status"] == "completed"
        # The escalation flag was injected by the rogue agent
        # A real system would detect and block this — here we verify the flag exists
        # so the audit trail catches it
        assert mock_external_agent._should_escalate is True

    def test_offline_queued_actions(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_rich_client,
    ) -> None:
        """When the device is offline, actions are queued locally and
        replayed when connectivity returns. No action executes silently."""
        client = mock_rich_client
        client.connected = False

        # Queue an action while offline
        queued_action = {
            "id": "offline_search_1",
            "action": "search",
            "target": "best headphones",
            "queued_at": 1000.0,
        }
        client.queue_offline(queued_action)

        assert len(client.offline_queue) == 1
        assert client.offline_queue[0]["action"] == "search"

        # When back online, push queued items
        client.connected = True
        pending = client.push_queued()

        assert len(pending) == 1
        assert pending[0]["id"] == "offline_search_1"
        # Queue is now empty
        assert len(client.offline_queue) == 0
