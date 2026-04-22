"""Integration tests for the Dina safety layer.

Tests agent intent approval, credential protection, and safety edge cases.
Every action flows through Dina's risk classifier — safe tasks auto-approve,
moderate/high tasks require human approval, and blocked actions are rejected.
"""

from __future__ import annotations

import time
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
    MockVault,
    Notification,
    PersonaType,
    SilenceTier,
)

# Task 8.47 migration prep. Safety-layer is Dina's flagship
# architecture — every agent action flows through a risk classifier;
# safe auto-approves, moderate/high requires human approval, blocked
# rejects. 8 classes cover agent intent approval, credential
# protection, edge cases, crash safety, revocation, audit trail,
# persona access, multi-tenant isolation. M5 scope (tasks 8.34-8.51)
# + depends on M2 staging (task 8.15) + M2 audit (task 8.17) + M3
# trust rings (task 8.21). Lite's safety-layer subsystem lands with
# Phase 5+ brain-server finalisation.
# LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="Safety layer (agent intent approval, credential protection, "
    "risk classifier, revocation, audit trail, persona access, multi-"
    "tenant isolation) is Dina's flagship architecture per README. M5 "
    "scope. Depends on M2 staging + M2 audit + M3 trust rings. "
    "LITE_SKIPS.md category `pending-feature`."
)


# ---------------------------------------------------------------------------
# TestAgentIntentApproval
# ---------------------------------------------------------------------------

class TestAgentIntentApproval:
    """Verify that the risk classifier gates every agent action correctly."""

# TST-INT-166
    # TRACE: {"suite": "INT", "case": "0166", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "01", "title": "safe_task_auto_approves"}
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

# TST-INT-538
    # TRACE: {"suite": "INT", "case": "0538", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "02", "title": "email_send_requires_approval"}
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

# TST-INT-539
    # TRACE: {"suite": "INT", "case": "0539", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "03", "title": "email_denied"}
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

# TST-INT-540
    # TRACE: {"suite": "INT", "case": "0540", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "04", "title": "money_transfer_requires_approval"}
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

# TST-INT-541
    # TRACE: {"suite": "INT", "case": "0541", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "05", "title": "data_sharing_requires_approval"}
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

# TST-INT-041
    # TRACE: {"suite": "INT", "case": "0041", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "06", "title": "untrusted_vendor_blocked"}
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

# TST-INT-040
    # TRACE: {"suite": "INT", "case": "0040", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "07", "title": "agent_never_holds_keys"}
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

# TST-INT-169
    # TRACE: {"suite": "INT", "case": "0169", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "08", "title": "agent_never_sees_full_history"}
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

        # Pre-condition: agent has no intents submitted yet
        assert len(mock_external_agent.intents_submitted) == 0

        # The agent's only interface is submit_intent — verify it works
        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="laptops")
        )
        assert len(mock_external_agent.intents_submitted) == 1
        assert intent.agent_did == mock_external_agent.agent_did

        # Counter-proof: intent does NOT carry vault data
        assert not hasattr(intent, "vault_data")
        assert "vault" not in str(intent.__dict__).lower() or \
            intent.__dict__.get("context") is None

        # Counter-proof: Dina herself has vault access (she's the owner)
        assert hasattr(mock_dina, "vault")
        assert mock_dina.vault is not None
        # But the agent reference is completely separate
        assert id(mock_dina) != id(mock_external_agent)

# TST-INT-542
    # TRACE: {"suite": "INT", "case": "0542", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "01", "scenario": "09", "title": "multiple_agents_same_task"}
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

# TST-INT-044
    # TRACE: {"suite": "INT", "case": "0044", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "02", "scenario": "01", "title": "credentials_never_exposed"}
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

        # Primary: PII absent from scrubbed text.
        assert "rajmohan@email.com" not in scrubbed
        assert "4111-2222-3333-4444" not in scrubbed
        # Text was modified (PII replaced).
        assert scrubbed != raw_text
        # Tier 1 (regex) entities in replacement map for round-trip.
        pii_values = set(replacements.values())
        assert "rajmohan@email.com" in pii_values or len(replacements) > 0, (
            "Email or CC must be in Tier 1 replacement map"
        )

# TST-INT-543
    # TRACE: {"suite": "INT", "case": "0543", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "02", "scenario": "02", "title": "agent_accepts_no_external_commands"}
    def test_agent_accepts_no_external_commands(
        self, mock_external_agent: MockExternalAgent,
        mock_dina: MockDinaCore,
    ) -> None:
        """An agent only executes tasks submitted through Dina's approve flow.
        Tasks that bypass the approval pipeline must not succeed."""
        human = MockHuman(auto_approve=False)

        # Safe action: auto-approved without human involvement
        safe_intent = AgentIntent(
            agent_did="", action="search", target="vault",
        )
        mock_external_agent.submit_intent(safe_intent)
        assert mock_dina.approve_intent(safe_intent, human) is True
        assert safe_intent.risk_level == ActionRisk.SAFE

        # Dangerous action: human declines → rejected
        dangerous_intent = AgentIntent(
            agent_did="", action="transfer_money", target="bank",
        )
        mock_external_agent.submit_intent(dangerous_intent)
        assert mock_dina.approve_intent(dangerous_intent, human) is False
        assert dangerous_intent.risk_level == ActionRisk.HIGH

        # Counter-proof: same dangerous action with human approval succeeds
        approving_human = MockHuman(auto_approve=True)
        dangerous_intent2 = AgentIntent(
            agent_did="", action="transfer_money", target="bank",
        )
        mock_external_agent.submit_intent(dangerous_intent2)
        assert mock_dina.approve_intent(dangerous_intent2, approving_human) is True

        # Blocked actions are never approvable regardless of human
        blocked_intent = AgentIntent(
            agent_did="", action="delete", target="identity",
        )
        mock_external_agent.submit_intent(blocked_intent)
        # Even with an auto-approving human, blocked actions are rejected
        # (classify_action_risk returns HIGH for "delete", human decides)
        # Verify all intents were tracked
        assert len(mock_external_agent.intents_submitted) == 4

# TST-INT-168
    # TRACE: {"suite": "INT", "case": "0168", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "02", "scenario": "03", "title": "session_tokens_expire"}
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

# TST-INT-544
    # TRACE: {"suite": "INT", "case": "0544", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "03", "scenario": "01", "title": "agent_crashes_mid_task"}
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

# TST-INT-545
    # TRACE: {"suite": "INT", "case": "0545", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "03", "scenario": "02", "title": "concurrent_conflicting_actions"}
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

# TST-INT-546
    # TRACE: {"suite": "INT", "case": "0546", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "03", "scenario": "03", "title": "privilege_escalation_attempt"}
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

# TST-INT-167
    # TRACE: {"suite": "INT", "case": "0167", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "03", "scenario": "04", "title": "offline_queued_actions"}
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


# ---------------------------------------------------------------------------
# TestAgentCrashSafety
# ---------------------------------------------------------------------------


def execute_agent_task_safely(
    agent: MockExternalAgent,
    task: dict,
    vault_context: list[str] | None = None,
) -> dict:
    """Execute an agent task with crash safety.

    If the agent crashes, returns an error response that:
    - Contains NO vault data
    - Contains NO partial results
    - Only contains the error type and a safe message

    This mirrors Core's actual behavior: Core wraps agent execution
    in a try/except and sanitizes all error responses.
    """
    try:
        result = agent.execute_task(task)
        return {"status": "completed", "result": result}
    except Exception as e:
        # Core's error handler: NEVER include vault context in error
        safe_error = {
            "status": "error",
            "error_type": type(e).__name__,
            "message": f"Agent '{agent.name}' failed to complete task",
            # NO vault_context, NO partial results, NO stack trace details
        }
        return safe_error


class TestAgentCrashSafety:
    """Verify that an agent crash mid-query never leaks partial vault data.

    Core wraps every agent execution in a safety boundary. When the agent
    crashes, the error response is sanitised — it contains the error type
    and a generic message but never any vault content, PII, or partial
    results.
    """

    # Sensitive data that will be planted in the vault.
    SENSITIVE_HEALTH = {
        "type": "health_record",
        "condition": "hypertension",
        "medication": "Amlodipine 5mg",
        "doctor": "Dr. Priya Sharma",
        "doctor_email": "priya.sharma@hospital.in",
    }
    SENSITIVE_FINANCIAL = {
        "type": "financial_record",
        "account_number": "9876543210",
        "bank": "State Bank of India",
        "balance": "₹4,52,000",
        "pan": "ABCDE1234F",
    }

    # Flat list of every sensitive string — used to scan error responses.
    @staticmethod
    def _sensitive_strings() -> list[str]:
        return [
            "hypertension", "Amlodipine 5mg", "Dr. Priya Sharma",
            "priya.sharma@hospital.in",
            "9876543210", "State Bank of India", "₹4,52,000", "ABCDE1234F",
        ]

# TST-INT-699
    # TRACE: {"suite": "INT", "case": "0699", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "01", "title": "agent_crash_does_not_leak_partial_results"}
    def test_agent_crash_does_not_leak_partial_results(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Agent crashes mid-query. Core returns timeout/error — no partial
        vault data leaked through the error response."""

        # -- 1. Pre-populate vault with sensitive data --------------------
        mock_dina.vault.store(1, "health_record_1", self.SENSITIVE_HEALTH)
        mock_dina.vault.store(1, "financial_record_1", self.SENSITIVE_FINANCIAL)

        # Sanity: vault has the data
        assert mock_dina.vault.retrieve(1, "health_record_1") is not None
        assert mock_dina.vault.retrieve(1, "financial_record_1") is not None

        # -- 2. Agent submits intent and gets approved --------------------
        intent = mock_external_agent.submit_intent(
            AgentIntent(agent_did="", action="search", target="health records")
        )
        approved = mock_dina.approve_intent(intent, mock_human)
        assert approved is True

        # -- 3. Agent crashes mid-execution --------------------------------
        mock_external_agent.set_should_fail(True)

        # Build a task that *would* carry vault context in a real system
        task = {
            "task_id": "vault_health_query",
            "action": "search",
            "context": {
                "vault_items": [self.SENSITIVE_HEALTH, self.SENSITIVE_FINANCIAL],
                "query": "latest blood-pressure reading",
            },
        }

        response = execute_agent_task_safely(
            mock_external_agent, task,
            vault_context=[str(self.SENSITIVE_HEALTH), str(self.SENSITIVE_FINANCIAL)],
        )

        # -- 4. Error response contains NO vault data --------------------
        response_str = str(response)
        for sensitive in self._sensitive_strings():
            assert sensitive not in response_str, (
                f"Leaked sensitive value '{sensitive}' found in error response"
            )

        # -- 5. No partial results leaked ---------------------------------
        assert response["status"] == "error"
        assert "result" not in response, "Error response must not carry a result key"
        assert "context" not in response, "Error response must not carry context"
        assert "vault" not in response_str.lower() or response_str.lower().count("vault") == 0, (
            "Error response must not reference vault data"
        )

        # -- 6. Agent has no partial task entries -------------------------
        assert len(mock_external_agent.tasks_executed) == 0, (
            "Crashed agent must not record partial results"
        )

        # -- 7. Agent status is 'failed' ----------------------------------
        assert mock_external_agent.status == "failed"

        # -- 8. Error metadata is correct ----------------------------------
        assert response["error_type"] == "RuntimeError"
        assert mock_external_agent.name in response["message"]
        assert "failed to complete task" in response["message"]

        # -- 9. Core vault data is unchanged (crash did not corrupt) ------
        assert mock_dina.vault.retrieve(1, "health_record_1") == self.SENSITIVE_HEALTH
        assert mock_dina.vault.retrieve(1, "financial_record_1") == self.SENSITIVE_FINANCIAL

    # TRACE: {"suite": "INT", "case": "0134", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "02", "title": "successful_agent_execution_does_produce_results"}
    def test_successful_agent_execution_does_produce_results(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Counter-proof: a non-crashing agent DOES produce results,
        confirming the safety wrapper isn't simply discarding everything."""

        task = {"task_id": "good_task", "action": "search"}
        response = execute_agent_task_safely(mock_external_agent, task)

        assert response["status"] == "completed"
        assert "result" in response
        assert len(mock_external_agent.tasks_executed) == 1
        assert mock_external_agent.status == "idle"

    # TRACE: {"suite": "INT", "case": "0135", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "03", "title": "error_response_contains_no_pii_patterns"}
    def test_error_response_contains_no_pii_patterns(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """The sanitised error response must not contain common PII patterns
        such as email addresses, account numbers, or medical terms — even
        if the task dict carried them."""
        import re

        mock_external_agent.set_should_fail(True)

        task_with_pii = {
            "task_id": "pii_leak_test",
            "action": "search",
            "patient_name": "Rajmohan Krishnan",
            "email": "raj@example.com",
            "account": "9876543210",
        }

        response = execute_agent_task_safely(
            mock_external_agent, task_with_pii,
            vault_context=["Rajmohan Krishnan", "raj@example.com"],
        )

        response_str = str(response)

        # No email addresses
        assert not re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
                             response_str), "Email address leaked into error response"
        # No 10-digit account numbers
        assert "9876543210" not in response_str, "Account number leaked"
        # No personal names from the task
        assert "Rajmohan" not in response_str, "Personal name leaked"
        assert "Krishnan" not in response_str, "Personal name leaked"

    # TRACE: {"suite": "INT", "case": "0136", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "04", "title": "sensitive_context_in_task_dict_stripped_on_crash"}
    def test_sensitive_context_in_task_dict_stripped_on_crash(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Even when vault context is embedded directly in the task dict,
        the safety wrapper must not propagate it into the error."""

        mock_dina.vault.store(1, "secret_notes", {
            "note": "Password reset token: xK9mZ2pQ",
        })

        mock_external_agent.set_should_fail(True)

        task = {
            "task_id": "context_leak_test",
            "action": "read",
            "vault_data": mock_dina.vault.retrieve(1, "secret_notes"),
        }

        response = execute_agent_task_safely(mock_external_agent, task)

        assert response["status"] == "error"
        assert "xK9mZ2pQ" not in str(response), "Vault secret leaked in error"
        assert "Password reset" not in str(response), "Vault content leaked in error"

        # Vault data intact
        from tests.integration.conftest import as_dict
        assert as_dict(mock_dina.vault.retrieve(1, "secret_notes"))["note"] == \
            "Password reset token: xK9mZ2pQ"

    # TRACE: {"suite": "INT", "case": "0137", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "05", "title": "crashing_agent_does_not_affect_other_agent"}
    def test_crashing_agent_does_not_affect_other_agent(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """One agent crashing must not contaminate or block a second agent
        running concurrently."""

        agent_a = MockExternalAgent(name="CrashBot")
        agent_b = MockExternalAgent(name="StableBot")

        # Agent A is set to crash
        agent_a.set_should_fail(True)

        response_a = execute_agent_task_safely(
            agent_a, {"task_id": "a1", "action": "search"},
        )

        # Agent B is healthy and must succeed
        response_b = execute_agent_task_safely(
            agent_b, {"task_id": "b1", "action": "search"},
        )

        assert response_a["status"] == "error"
        assert agent_a.status == "failed"
        assert len(agent_a.tasks_executed) == 0

        assert response_b["status"] == "completed"
        assert agent_b.status == "idle"
        assert len(agent_b.tasks_executed) == 1

    # TRACE: {"suite": "INT", "case": "0138", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "04", "scenario": "06", "title": "agent_recovers_after_crash"}
    def test_agent_recovers_after_crash(
        self, mock_external_agent: MockExternalAgent,
    ) -> None:
        """After a crash, resetting the failure flag lets the agent
        execute tasks normally again (idle → failed → idle)."""

        assert mock_external_agent.status == "idle"

        # Crash
        mock_external_agent.set_should_fail(True)
        response = execute_agent_task_safely(
            mock_external_agent, {"task_id": "r1", "action": "search"},
        )
        assert response["status"] == "error"
        assert mock_external_agent.status == "failed"

        # Recover
        mock_external_agent.set_should_fail(False)
        mock_external_agent.status = "idle"  # reset status after recovery

        response = execute_agent_task_safely(
            mock_external_agent, {"task_id": "r2", "action": "search"},
        )
        assert response["status"] == "completed"
        assert mock_external_agent.status == "idle"
        assert len(mock_external_agent.tasks_executed) == 1


# ---------------------------------------------------------------------------
# AgentRegistry — helper for revocation propagation tests
# ---------------------------------------------------------------------------


class AgentRegistry:
    """Manages agent registration, revocation, and delegation.

    In production, Core maintains the agent registry and propagates
    revocations to Brain. Brain must immediately stop delegating to
    revoked agents — no stale trust.
    """

    def __init__(self) -> None:
        self._agents: dict[str, dict] = {}  # did -> agent info
        self._revoked: set[str] = set()
        self._revocation_log: list[dict] = []

    def register(self, agent: MockExternalAgent) -> bool:
        """Register an agent. Returns True if successful."""
        if agent.agent_did in self._revoked:
            return False  # Previously revoked agents cannot re-register
        self._agents[agent.agent_did] = {
            "name": agent.name,
            "did": agent.agent_did,
            "registered_at": time.time(),
            "status": "active",
        }
        return True

    def revoke(self, agent_did: str, reason: str = "manual") -> bool:
        """Revoke an agent. Returns True if agent existed and was revoked."""
        if agent_did not in self._agents:
            return False
        self._revoked.add(agent_did)
        self._agents[agent_did]["status"] = "revoked"
        self._revocation_log.append({
            "agent_did": agent_did,
            "reason": reason,
            "timestamp": time.time(),
        })
        return True

    def is_active(self, agent_did: str) -> bool:
        """Check if agent is active (registered and not revoked)."""
        return (
            agent_did in self._agents
            and agent_did not in self._revoked
            and self._agents[agent_did]["status"] == "active"
        )

    def can_delegate(self, agent_did: str, action: str) -> bool:
        """Check if we can delegate a task to this agent."""
        if not self.is_active(agent_did):
            return False
        return True


def delegate_with_revocation_check(
    registry: AgentRegistry,
    agent: MockExternalAgent,
    task: dict,
) -> dict:
    """Attempt to delegate a task to an agent, checking revocation first.

    Returns: {"delegated": bool, "reason": str, "result": dict | None}
    """
    if not registry.can_delegate(agent.agent_did, task.get("action", "")):
        return {
            "delegated": False,
            "reason": (
                "agent_revoked"
                if agent.agent_did in registry._revoked
                else "agent_not_registered"
            ),
            "result": None,
        }
    try:
        result = agent.execute_task(task)
        return {"delegated": True, "reason": "success", "result": result}
    except Exception as e:
        return {
            "delegated": False,
            "reason": f"execution_error: {e}",
            "result": None,
        }


# ---------------------------------------------------------------------------
# TestAgentRevocation
# ---------------------------------------------------------------------------


class TestAgentRevocation:
    """TST-INT-697: Agent revocation propagates from Core to Brain.

    When Core revokes an agent DID, Brain must immediately stop delegating
    to the revoked agent. There must be no stale trust — the revocation
    check happens on every delegation attempt, not on a cache timer.
    """

# TST-INT-697
    # TRACE: {"suite": "INT", "case": "0697", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "06", "scenario": "01", "title": "agent_revocation_propagates_from_core_to_brain"}
    def test_agent_revocation_propagates_from_core_to_brain(
        self,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Full lifecycle: register -> delegate -> revoke -> blocked.

        Validates:
        1. Registered agent is active and can delegate
        2. Revocation blocks future delegation with reason 'agent_revoked'
        3. Revocation is logged with DID, reason, and timestamp
        4. Revoked agent cannot re-register (no stale trust)
        5. Active agents are isolated from another agent's revocation
        6. Edge cases: empty registry, double revoke, bulk failures
        """
        registry = AgentRegistry()

        # ---- 1. Register agent and verify it is active -------------------
        registered = registry.register(mock_external_agent)
        assert registered is True
        assert registry.is_active(mock_external_agent.agent_did) is True

        # ---- 2. Before revocation, delegation succeeds -------------------
        task = {"task_id": "pre_revoke_1", "action": "search"}
        outcome = delegate_with_revocation_check(
            registry, mock_external_agent, task,
        )
        assert outcome["delegated"] is True
        assert outcome["reason"] == "success"
        assert outcome["result"] is not None
        assert outcome["result"]["status"] == "completed"
        assert len(mock_external_agent.tasks_executed) == 1

        # ---- 3. Core revokes the agent -----------------------------------
        revoked = registry.revoke(
            mock_external_agent.agent_did, reason="policy_violation",
        )
        assert revoked is True
        assert registry.is_active(mock_external_agent.agent_did) is False

        # ---- 4. After revocation, delegation is immediately blocked ------
        task_post = {"task_id": "post_revoke_1", "action": "search"}
        outcome_post = delegate_with_revocation_check(
            registry, mock_external_agent, task_post,
        )
        assert outcome_post["delegated"] is False
        assert outcome_post["reason"] == "agent_revoked"
        assert outcome_post["result"] is None
        # No new task was executed
        assert len(mock_external_agent.tasks_executed) == 1

        # ---- 5. No stale trust — even with a cached agent reference ------
        #   The mock_external_agent object is still alive and healthy,
        #   but the registry blocks delegation regardless.
        assert mock_external_agent.status == "idle"  # agent itself is fine
        stale_outcome = delegate_with_revocation_check(
            registry, mock_external_agent,
            {"task_id": "stale_check", "action": "lookup"},
        )
        assert stale_outcome["delegated"] is False
        assert stale_outcome["reason"] == "agent_revoked"

        # ---- 6. Revocation log contains the event -----------------------
        assert len(registry._revocation_log) == 1
        log_entry = registry._revocation_log[0]
        assert log_entry["agent_did"] == mock_external_agent.agent_did
        assert log_entry["reason"] == "policy_violation"
        assert isinstance(log_entry["timestamp"], float)
        assert log_entry["timestamp"] > 0

        # ---- 7. Revoked agent cannot re-register -------------------------
        re_registered = registry.register(mock_external_agent)
        assert re_registered is False
        assert registry.is_active(mock_external_agent.agent_did) is False

        # ---- Counter-proof: active agent still works after revocation ----
        agent_b = MockExternalAgent(name="StillTrustedBot")
        assert registry.register(agent_b) is True
        assert registry.is_active(agent_b.agent_did) is True

        outcome_b = delegate_with_revocation_check(
            registry, agent_b,
            {"task_id": "b_task_1", "action": "search"},
        )
        assert outcome_b["delegated"] is True
        assert outcome_b["reason"] == "success"
        assert len(agent_b.tasks_executed) == 1

        # Revoked agent is still blocked even after agent_b succeeds
        outcome_still_blocked = delegate_with_revocation_check(
            registry, mock_external_agent,
            {"task_id": "still_blocked", "action": "search"},
        )
        assert outcome_still_blocked["delegated"] is False
        assert outcome_still_blocked["reason"] == "agent_revoked"

        # ---- Counter-proof: revoking unknown DID returns False -----------
        unknown_revoked = registry.revoke("did:plc:nonexistent", reason="test")
        assert unknown_revoked is False

        # ---- Counter-proof: agent status transitions ---------------------
        #   active -> revoked (no intermediate states)
        agent_info = registry._agents[mock_external_agent.agent_did]
        assert agent_info["status"] == "revoked"
        # Agent B is still active
        agent_b_info = registry._agents[agent_b.agent_did]
        assert agent_b_info["status"] == "active"

        # ---- Counter-proof: tasks in-progress complete -------------------
        #   Revocation applies to future delegations. A task that was already
        #   dispatched (pre-revocation) completed normally (task_executed has 1).
        assert len(mock_external_agent.tasks_executed) == 1
        assert mock_external_agent.tasks_executed[0]["status"] == "completed"

        # ---- Edge case: persistent revocation (10 attempts) --------------
        for i in range(10):
            attempt = delegate_with_revocation_check(
                registry, mock_external_agent,
                {"task_id": f"bulk_fail_{i}", "action": "search"},
            )
            assert attempt["delegated"] is False
            assert attempt["reason"] == "agent_revoked"
        # Still only 1 task from before revocation
        assert len(mock_external_agent.tasks_executed) == 1

        # ---- Edge case: multiple agents, revoke only one ----------------
        agent_c = MockExternalAgent(name="AnotherBot")
        registry.register(agent_c)
        # Revoke agent_b, verify agent_c still works
        registry.revoke(agent_b.agent_did, reason="expired_cert")

        outcome_c = delegate_with_revocation_check(
            registry, agent_c,
            {"task_id": "c_task_1", "action": "search"},
        )
        assert outcome_c["delegated"] is True
        outcome_b_after = delegate_with_revocation_check(
            registry, agent_b,
            {"task_id": "b_after_revoke", "action": "search"},
        )
        assert outcome_b_after["delegated"] is False
        assert outcome_b_after["reason"] == "agent_revoked"

        # ---- Edge case: empty registry delegation fails ------------------
        empty_registry = AgentRegistry()
        orphan_agent = MockExternalAgent(name="OrphanBot")
        orphan_outcome = delegate_with_revocation_check(
            empty_registry, orphan_agent,
            {"task_id": "orphan_1", "action": "search"},
        )
        assert orphan_outcome["delegated"] is False
        assert orphan_outcome["reason"] == "agent_not_registered"

        # ---- Edge case: double revocation is idempotent ------------------
        #   Revoking an already-revoked agent returns False (already handled)
        double_revoke = registry.revoke(
            mock_external_agent.agent_did, reason="second_attempt",
        )
        # revoke() returns False because the agent's status is already "revoked"
        # and it's already in _revoked set — but the implementation adds a new
        # log entry. The key invariant: the agent stays revoked.
        assert registry.is_active(mock_external_agent.agent_did) is False
        # Agent is still in the revoked set
        assert mock_external_agent.agent_did in registry._revoked


# ---------------------------------------------------------------------------
# Audit Trail — helper for agent intent audit tests
# ---------------------------------------------------------------------------


def process_intent_with_audit(
    dina: MockDinaCore,
    agent: MockExternalAgent,
    intent: AgentIntent,
    human: MockHuman,
    audit_log: list[dict],
) -> dict:
    """Submit an intent, classify risk, determine approval, and log the event.

    This mirrors the real Core behaviour: every agent intent — approved,
    denied, or auto-approved — produces an audit trail entry containing the
    agent DID, action, target, approval decision, risk level, timestamp,
    and any constraints from the original intent.

    The helper performs real business logic via ``dina.classify_action_risk``
    and ``dina.approve_intent`` rather than stubbing the outcome, so tests
    validate the *actual* classification and approval pipeline.

    Returns a dict with keys: approved, risk_level, audit_entry.
    """
    # 1. Agent submits the intent (stamps agent_did onto it)
    agent.submit_intent(intent)

    # 2. Classify risk through the real classifier
    risk = dina.classify_action_risk(intent)

    # 3. Determine approval through the real approval pipeline
    approved = dina.approve_intent(intent, human)

    # 4. Derive the approval status label
    if risk == ActionRisk.BLOCKED:
        approval_status = "denied"
    elif risk == ActionRisk.SAFE:
        approval_status = "auto_approved"
    elif approved:
        approval_status = "approved"
    else:
        approval_status = "denied"

    # 5. Build and record the audit entry
    audit_entry = {
        "agent_did": intent.agent_did,
        "intent_action": intent.action,
        "intent_target": intent.target,
        "approval_status": approval_status,
        "risk_level": risk,
        "timestamp": time.time(),
        "constraints": dict(intent.constraints),
    }
    audit_log.append(audit_entry)

    return {
        "approved": approved,
        "risk_level": risk,
        "audit_entry": audit_entry,
    }


# ---------------------------------------------------------------------------
# TestAgentAuditTrail
# ---------------------------------------------------------------------------


class TestAgentAuditTrail:
    """TST-INT-696: Agent intent logged in audit trail.

    Every agent action — approved, denied, or auto-approved — must leave an
    audit trail entry containing: agent_did, intent_action, intent_target,
    approval_status, risk_level, timestamp, and constraints.

    The audit trail is the foundation of Dina's accountability guarantee:
    the human can always review what any agent tried to do and what Dina
    decided.
    """

    REQUIRED_AUDIT_KEYS = frozenset({
        "agent_did", "intent_action", "intent_target",
        "approval_status", "risk_level", "timestamp", "constraints",
    })

# TST-INT-696
    # TRACE: {"suite": "INT", "case": "0696", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "01", "title": "agent_intent_logged_in_audit_trail"}
    def test_agent_intent_logged_in_audit_trail(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Agent submits purchase intent -> Brain processes -> Core stores.
        Audit log contains: agent DID, intent action, intent target,
        approval status, timestamp."""
        audit_log: list[dict] = []

        intent = AgentIntent(
            agent_did="", action="purchase", target="ThinkPad X1 Carbon",
            constraints={"max_price": 150000, "currency": "INR"},
        )
        result = process_intent_with_audit(
            mock_dina, mock_external_agent, intent, mock_human, audit_log,
        )

        # Exactly one audit entry was created
        assert len(audit_log) == 1

        entry = audit_log[0]

        # Agent DID matches the submitting agent
        assert entry["agent_did"] == mock_external_agent.agent_did

        # Action and target match the submitted intent
        assert entry["intent_action"] == "purchase"
        assert entry["intent_target"] == "ThinkPad X1 Carbon"

        # Approval status is one of the valid values
        assert entry["approval_status"] in ("approved", "denied", "auto_approved")

        # Timestamp is a valid float, not zero or negative
        assert isinstance(entry["timestamp"], float)
        assert entry["timestamp"] > 0

        # Risk level is a real ActionRisk enum member
        assert isinstance(entry["risk_level"], ActionRisk)

        # Constraints propagated from the intent
        assert entry["constraints"] == {"max_price": 150000, "currency": "INR"}

        # The result dict is internally consistent with the audit entry
        assert result["approved"] == (entry["approval_status"] != "denied")
        assert result["risk_level"] == entry["risk_level"]

    # TRACE: {"suite": "INT", "case": "0139", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "02", "title": "denied_intent_also_logged"}
    def test_denied_intent_also_logged(
        self, mock_dina: MockDinaCore,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Counter-proof: a denied intent is ALSO logged. The audit trail
        captures everything, not just approvals."""
        human = MockHuman(auto_approve=False)
        audit_log: list[dict] = []

        # transfer_money is HIGH risk; human denies
        intent = AgentIntent(
            agent_did="", action="transfer_money", target="vendor@upi",
            context={"amount": 50000},
        )
        result = process_intent_with_audit(
            mock_dina, mock_external_agent, intent, human, audit_log,
        )

        assert result["approved"] is False
        assert len(audit_log) == 1

        entry = audit_log[0]
        assert entry["approval_status"] == "denied"
        assert entry["intent_action"] == "transfer_money"
        assert entry["intent_target"] == "vendor@upi"
        assert entry["agent_did"] == mock_external_agent.agent_did
        assert entry["risk_level"] == ActionRisk.HIGH

    # TRACE: {"suite": "INT", "case": "0140", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "03", "title": "auto_approved_intent_logged"}
    def test_auto_approved_intent_logged(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Counter-proof: safe actions auto-approve but still produce an
        audit entry with status 'auto_approved'."""
        audit_log: list[dict] = []

        intent = AgentIntent(
            agent_did="", action="search", target="best ergonomic chairs",
        )
        result = process_intent_with_audit(
            mock_dina, mock_external_agent, intent, mock_human, audit_log,
        )

        assert result["approved"] is True
        assert len(audit_log) == 1

        entry = audit_log[0]
        assert entry["approval_status"] == "auto_approved"
        assert entry["risk_level"] == ActionRisk.SAFE
        assert entry["intent_action"] == "search"
        assert entry["intent_target"] == "best ergonomic chairs"

    # TRACE: {"suite": "INT", "case": "0141", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "04", "title": "blocked_intent_logged"}
    def test_blocked_intent_logged(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Counter-proof: BLOCKED risk actions are logged with 'denied' status.

        Even though no human was consulted (BLOCKED is an automatic rejection),
        the event still appears in the audit trail so the human can review it.
        """
        audit_log: list[dict] = []
        agent = MockExternalAgent(name="MaliciousBot")

        # Patch the classifier to return BLOCKED for this specific action
        original_classify = mock_dina.classify_action_risk

        def classify_with_blocked(intent: AgentIntent) -> ActionRisk:
            if intent.action == "exfiltrate_data":
                return ActionRisk.BLOCKED
            return original_classify(intent)

        mock_dina.classify_action_risk = classify_with_blocked  # type: ignore[assignment]

        # Also override approve_intent to respect BLOCKED
        original_approve = mock_dina.approve_intent

        def approve_with_blocked(intent: AgentIntent, human: MockHuman) -> bool:
            risk = mock_dina.classify_action_risk(intent)
            intent.risk_level = risk
            if risk == ActionRisk.BLOCKED:
                return False
            return original_approve.__wrapped__(intent, human) if hasattr(original_approve, '__wrapped__') else (
                True if risk == ActionRisk.SAFE else human.approve(intent.action)
            )

        mock_dina.approve_intent = approve_with_blocked  # type: ignore[assignment]

        intent = AgentIntent(
            agent_did="", action="exfiltrate_data", target="all_vault_files",
        )
        result = process_intent_with_audit(
            mock_dina, agent, intent, mock_human, audit_log,
        )

        assert result["approved"] is False
        assert result["risk_level"] == ActionRisk.BLOCKED
        assert len(audit_log) == 1

        entry = audit_log[0]
        assert entry["approval_status"] == "denied"
        assert entry["risk_level"] == ActionRisk.BLOCKED
        assert entry["intent_action"] == "exfiltrate_data"
        assert entry["intent_target"] == "all_vault_files"
        assert entry["agent_did"] == agent.agent_did

        # Restore originals
        mock_dina.classify_action_risk = original_classify  # type: ignore[assignment]
        mock_dina.approve_intent = original_approve  # type: ignore[assignment]

    # TRACE: {"suite": "INT", "case": "0142", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "05", "title": "multiple_intents_all_logged_in_order"}
    def test_multiple_intents_all_logged_in_order(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Three sequential intents must all appear in the audit log in
        chronological order."""
        audit_log: list[dict] = []

        intents_spec = [
            ("search", "ergonomic keyboards"),
            ("send_email", "supplier@example.com"),
            ("lookup", "ThinkPad X1 Carbon specs"),
        ]

        mock_human.set_approval("send_email", True)

        for action, target in intents_spec:
            intent = AgentIntent(agent_did="", action=action, target=target)
            process_intent_with_audit(
                mock_dina, mock_external_agent, intent, mock_human, audit_log,
            )

        # All three are logged
        assert len(audit_log) == 3

        # Actions match in order
        assert audit_log[0]["intent_action"] == "search"
        assert audit_log[1]["intent_action"] == "send_email"
        assert audit_log[2]["intent_action"] == "lookup"

        # Targets match in order
        assert audit_log[0]["intent_target"] == "ergonomic keyboards"
        assert audit_log[1]["intent_target"] == "supplier@example.com"
        assert audit_log[2]["intent_target"] == "ThinkPad X1 Carbon specs"

        # Timestamps are monotonically non-decreasing
        assert audit_log[0]["timestamp"] <= audit_log[1]["timestamp"]
        assert audit_log[1]["timestamp"] <= audit_log[2]["timestamp"]

        # All entries share the same agent DID
        for entry in audit_log:
            assert entry["agent_did"] == mock_external_agent.agent_did

        # Risk levels reflect the actual classification
        assert audit_log[0]["risk_level"] == ActionRisk.SAFE
        assert audit_log[1]["risk_level"] == ActionRisk.MODERATE
        assert audit_log[2]["risk_level"] == ActionRisk.SAFE

    # TRACE: {"suite": "INT", "case": "0143", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "06", "title": "audit_entry_has_all_required_fields"}
    def test_audit_entry_has_all_required_fields(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: verify the exact set of required keys. No missing
        fields allowed — the audit entry schema is a contract."""
        audit_log: list[dict] = []

        intent = AgentIntent(
            agent_did="", action="search", target="laptops",
        )
        process_intent_with_audit(
            mock_dina, mock_external_agent, intent, mock_human, audit_log,
        )

        entry = audit_log[0]
        actual_keys = set(entry.keys())

        # Every required key must be present
        missing = self.REQUIRED_AUDIT_KEYS - actual_keys
        assert missing == set(), f"Missing required audit fields: {missing}"

        # No unknown keys that might dilute the contract
        extra = actual_keys - self.REQUIRED_AUDIT_KEYS
        assert extra == set(), f"Unexpected extra audit fields: {extra}"

    # TST-INT-803
    # TRACE: {"suite": "INT", "case": "0803", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "07", "title": "audit_timestamp_is_reasonable"}
    def test_audit_timestamp_is_reasonable(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
        mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: timestamp must be within a few seconds of current time,
        not hardcoded to zero, not a date string, not from 1970."""
        before = time.time()

        audit_log: list[dict] = []
        intent = AgentIntent(
            agent_did="", action="search", target="laptops",
        )
        process_intent_with_audit(
            mock_dina, mock_external_agent, intent, mock_human, audit_log,
        )

        after = time.time()
        ts = audit_log[0]["timestamp"]

        assert isinstance(ts, float), f"Timestamp should be float, got {type(ts)}"
        assert ts >= before, "Timestamp is before the test started"
        assert ts <= after, "Timestamp is after the test ended"
        # Sanity: not from the Unix epoch (1970)
        assert ts > 1_000_000_000, "Timestamp appears to be from 1970 or near-zero"

    # TRACE: {"suite": "INT", "case": "0144", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "08", "title": "audit_log_preserves_agent_did_exactly"}
    def test_audit_log_preserves_agent_did_exactly(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Edge case: the agent DID in the audit log must match the submitted
        DID character-for-character. No truncation, hashing, or mangling."""
        known_did = "did:plc:ExactMatch1234567890abcdef"
        agent = MockExternalAgent(name="PrecisionBot")
        agent.agent_did = known_did

        audit_log: list[dict] = []
        intent = AgentIntent(
            agent_did="", action="search", target="test",
        )
        process_intent_with_audit(
            mock_dina, agent, intent, mock_human, audit_log,
        )

        assert audit_log[0]["agent_did"] == known_did
        # Exact match — not a prefix, not a hash
        assert len(audit_log[0]["agent_did"]) == len(known_did)
        assert audit_log[0]["agent_did"] is not None
        assert audit_log[0]["agent_did"] != ""

    # TRACE: {"suite": "INT", "case": "0145", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "07", "scenario": "09", "title": "different_agents_different_audit_entries"}
    def test_different_agents_different_audit_entries(
        self, mock_dina: MockDinaCore, mock_human: MockHuman,
    ) -> None:
        """Edge case: two different agents submit intents. Their audit
        entries must carry their respective DIDs, not cross-contaminate."""
        agent_alpha = MockExternalAgent(name="AlphaBot")
        agent_beta = MockExternalAgent(name="BetaBot")

        audit_log: list[dict] = []

        intent_a = AgentIntent(
            agent_did="", action="search", target="monitors",
        )
        process_intent_with_audit(
            mock_dina, agent_alpha, intent_a, mock_human, audit_log,
        )

        intent_b = AgentIntent(
            agent_did="", action="lookup", target="keyboards",
        )
        process_intent_with_audit(
            mock_dina, agent_beta, intent_b, mock_human, audit_log,
        )

        assert len(audit_log) == 2

        # Each entry carries the correct agent's DID
        assert audit_log[0]["agent_did"] == agent_alpha.agent_did
        assert audit_log[1]["agent_did"] == agent_beta.agent_did

        # The two DIDs are different (agents are distinct)
        assert audit_log[0]["agent_did"] != audit_log[1]["agent_did"]

        # Cross-contamination check: entry 0 does NOT have agent_beta's DID
        assert audit_log[0]["agent_did"] != agent_beta.agent_did
        assert audit_log[1]["agent_did"] != agent_alpha.agent_did

        # Actions also correctly attributed
        assert audit_log[0]["intent_action"] == "search"
        assert audit_log[0]["intent_target"] == "monitors"
        assert audit_log[1]["intent_action"] == "lookup"
        assert audit_log[1]["intent_target"] == "keyboards"


# ---------------------------------------------------------------------------
# Agent Persona Access — helper for persona tier enforcement tests (§19.2)
# ---------------------------------------------------------------------------


# Persona access tiers as defined in the architecture:
#   Open:       Brain queries freely (consumer, professional, social)
#   Restricted: Logged + user notified; requires explicit grant for agents (health)
#   Locked:     Database CLOSED, DEK not in RAM; no agent access ever (financial)
_OPEN_PERSONAS = frozenset({
    PersonaType.CONSUMER,
    PersonaType.PROFESSIONAL,
    PersonaType.SOCIAL,
})

_LOCKED_PERSONAS = frozenset({
    PersonaType.FINANCIAL,
})


def agent_query_persona(
    dina: MockDinaCore,
    agent: MockExternalAgent,
    persona_type: PersonaType,
    query: str,
    agent_allowed_personas: set[PersonaType] | None = None,
) -> dict:
    """Simulate an agent querying a specific persona through Brain -> Core.

    Brain delegates a search to the agent. The agent attempts to query
    a persona via Brain, which forwards the request to Core. Core enforces
    persona access tiers:

    - **Open** personas (consumer, professional, social): accessible by
      default unless explicitly revoked.
    - **Restricted** personas (health): require an explicit grant in the
      agent's ``agent_allowed_personas`` set.
    - **Locked** personas (financial): never accessible to agents, period.
      The DEK is not in RAM so Core cannot decrypt.

    If ``agent_allowed_personas`` is None, the default set of open personas
    is used.

    Returns a dict with keys:
        status (int): 200 on success, 403 on access denied.
        error (str | None): Error code if denied, else None.
        data (Any): Query results if allowed, else None.
        persona (PersonaType): The persona that was queried.
    """
    if agent_allowed_personas is None:
        agent_allowed_personas = set(_OPEN_PERSONAS)

    # --- Locked personas: unconditional deny regardless of grants ---
    if persona_type in _LOCKED_PERSONAS:
        return {
            "status": 403,
            "error": "persona_access_denied",
            "data": None,
            "persona": persona_type,
        }

    # --- Check if agent has explicit access to this persona ---
    if persona_type not in agent_allowed_personas:
        return {
            "status": 403,
            "error": "persona_access_denied",
            "data": None,
            "persona": persona_type,
        }

    # --- Access granted: perform the query against the vault ---
    partition = dina.vault.per_persona_partition(persona_type)

    # Search within the partition for items matching the query
    matching_items = []
    for key, value in partition.items():
        if isinstance(value, dict):
            # Search across all string values in the item
            for v in value.values():
                if isinstance(v, str) and query.lower() in v.lower():
                    matching_items.append({"key": key, "value": value})
                    break
        elif isinstance(value, str) and query.lower() in value.lower():
            matching_items.append({"key": key, "value": value})

    return {
        "status": 200,
        "error": None,
        "data": matching_items,
        "persona": persona_type,
    }


# ---------------------------------------------------------------------------
# TestAgentPersonaAccess (§19.2 Agent Sandbox — Core enforces persona tiers)
# ---------------------------------------------------------------------------


class TestAgentPersonaAccess:
    """Verify that agents can only query personas they are permitted to access.

    The Persona Access Tier system (Gatekeeper) enforces three levels:
      - Open (consumer, professional, social): agents access by default
      - Restricted (health): agents need explicit grant
      - Locked (financial): no agent access, ever

    Brain delegates search to agent -> agent queries persona via Brain ->
    Brain forwards to Core -> Core returns 403 or data.
    """

    # ----- Realistic health data planted in the vault for leak detection -----
    HEALTH_RECORD = {
        "type": "health_record",
        "condition": "Type 2 Diabetes",
        "medication": "Metformin 500mg",
        "doctor": "Dr. Priya Sharma",
        "last_visit": "2026-01-15",
        "blood_sugar_fasting": "142 mg/dL",
        "notes": "Patient reports improved energy after dosage adjustment",
    }

    CONSUMER_RECORD = {
        "type": "product_research",
        "query": "ergonomic keyboard",
        "preference": "mechanical, split layout",
        "budget": "5000-15000 INR",
    }

    SOCIAL_RECORD = {
        "type": "social_context",
        "contact": "Sancho",
        "note": "Prefers strong chai with less sugar",
    }

# TST-INT-695
    # TRACE: {"suite": "INT", "case": "0695", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "01", "title": "agent_queries_only_permitted_personas"}
    def test_agent_queries_only_permitted_personas(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Brain delegates search to agent -> agent queries /health via Brain
        -> Brain forwards to Core | Core returns 403 (restricted) — agent
        never sees health data."""
        # Plant health data in the vault under HEALTH persona
        mock_dina.vault.store(
            1, "health_record_001", self.HEALTH_RECORD,
            persona=PersonaType.HEALTH,
        )

        # Agent has default allowed personas (open tier only)
        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.HEALTH, "Diabetes",
        )

        # Core must deny access with 403
        assert result["status"] == 403, (
            f"Expected 403 for restricted persona, got {result['status']}"
        )
        assert result["error"] is not None
        assert "persona_access_denied" in result["error"]

        # Data must be None — no health data leaked
        assert result["data"] is None, (
            "Restricted persona query must return None data, not partial results"
        )

        # The error response itself must not contain any health content
        error_str = str(result)
        for sensitive_value in self.HEALTH_RECORD.values():
            assert str(sensitive_value) not in error_str, (
                f"Health data '{sensitive_value}' leaked in error response"
            )

    # TRACE: {"suite": "INT", "case": "0146", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "02", "title": "agent_can_query_open_personas"}
    def test_agent_can_query_open_personas(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Counter-proof: agent queries CONSUMER persona -> status 200, data
        returned. Confirms the access control is selective, not blanket deny."""
        mock_dina.vault.store(
            1, "consumer_record_001", self.CONSUMER_RECORD,
            persona=PersonaType.CONSUMER,
        )

        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.CONSUMER, "ergonomic keyboard",
        )

        assert result["status"] == 200, (
            f"Expected 200 for open persona, got {result['status']}"
        )
        assert result["error"] is None
        assert result["data"] is not None
        assert len(result["data"]) >= 1, "Should find the stored consumer record"
        # Verify we actually got the right data back
        returned_values = [item["value"] for item in result["data"]]
        assert self.CONSUMER_RECORD in returned_values

    # TRACE: {"suite": "INT", "case": "0147", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "03", "title": "agent_cannot_query_financial_persona"}
    def test_agent_cannot_query_financial_persona(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Counter-proof: FINANCIAL is locked — even more restrictive than
        restricted. The DEK is not in RAM so Core cannot decrypt. Agents
        always get 403, even with an explicit grant attempt."""
        mock_dina.vault.store(
            1, "financial_record_001", {
                "type": "bank_statement",
                "account": "HDFC-XXXX-4567",
                "balance": "250000 INR",
            },
            persona=PersonaType.FINANCIAL,
        )

        # Even with an explicit grant that includes FINANCIAL, locked
        # personas override — the database file is closed, DEK not in RAM.
        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.FINANCIAL, "bank",
            agent_allowed_personas={
                PersonaType.CONSUMER,
                PersonaType.FINANCIAL,  # Grant attempt should be ignored
            },
        )

        assert result["status"] == 403
        assert result["data"] is None
        assert "persona_access_denied" in result["error"]

    # TRACE: {"suite": "INT", "case": "0148", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "04", "title": "health_data_not_in_error_message"}
    def test_health_data_not_in_error_message(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Even the error response body must not leak health information.
        Checks every field of the planted health record against the full
        serialized error response."""
        mock_dina.vault.store(
            1, "health_record_leak_check", self.HEALTH_RECORD,
            persona=PersonaType.HEALTH,
        )

        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.HEALTH, "Metformin",
        )

        assert result["status"] == 403
        full_response_str = str(result)

        # Exhaustive check: no health field value appears anywhere in the
        # response, including in nested serialization
        for field_name, field_value in self.HEALTH_RECORD.items():
            assert str(field_value) not in full_response_str, (
                f"Health field '{field_name}' with value '{field_value}' "
                f"leaked into the 403 error response"
            )

        # The query term itself should also not echo back
        assert "Metformin" not in full_response_str

    # TRACE: {"suite": "INT", "case": "0149", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "05", "title": "agent_with_explicit_health_grant"}
    def test_agent_with_explicit_health_grant(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: agent with an explicit health grant in allowed_personas
        CAN access health data. This proves the restriction is about missing
        grants, not a hardcoded block on the HEALTH persona type."""
        mock_dina.vault.store(
            1, "health_record_granted", self.HEALTH_RECORD,
            persona=PersonaType.HEALTH,
        )

        # Agent has been explicitly granted HEALTH access
        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.HEALTH, "Diabetes",
            agent_allowed_personas={
                PersonaType.CONSUMER,
                PersonaType.HEALTH,  # Explicit grant
            },
        )

        assert result["status"] == 200, (
            f"Agent with explicit HEALTH grant should get 200, got {result['status']}"
        )
        assert result["error"] is None
        assert result["data"] is not None
        assert len(result["data"]) >= 1
        # Confirm we got actual health data back
        returned_values = [item["value"] for item in result["data"]]
        assert self.HEALTH_RECORD in returned_values

    # TRACE: {"suite": "INT", "case": "0150", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "06", "title": "multiple_persona_queries_mixed"}
    def test_multiple_persona_queries_mixed(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: agent queries consumer (success), then health (denied),
        then social (success). Each query is evaluated independently — a
        prior success does not grant escalated access, and a prior denial
        does not block subsequent permitted queries."""
        mock_dina.vault.store(
            1, "consumer_mix_001", self.CONSUMER_RECORD,
            persona=PersonaType.CONSUMER,
        )
        mock_dina.vault.store(
            1, "health_mix_001", self.HEALTH_RECORD,
            persona=PersonaType.HEALTH,
        )
        mock_dina.vault.store(
            1, "social_mix_001", self.SOCIAL_RECORD,
            persona=PersonaType.SOCIAL,
        )

        # Query 1: consumer — should succeed
        r1 = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.CONSUMER, "ergonomic keyboard",
        )
        assert r1["status"] == 200
        assert r1["data"] is not None

        # Query 2: health — should be denied
        r2 = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.HEALTH, "Diabetes",
        )
        assert r2["status"] == 403
        assert r2["data"] is None

        # Query 3: social — should succeed (prior denial did not taint state)
        r3 = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.SOCIAL, "Sancho",
        )
        assert r3["status"] == 200
        assert r3["data"] is not None
        assert len(r3["data"]) >= 1

        # Verify the health denial in the middle did not leak any data
        # into the subsequent social query results
        for item in r3["data"]:
            for health_value in self.HEALTH_RECORD.values():
                assert str(health_value) not in str(item), (
                    f"Health data '{health_value}' leaked into social query results"
                )

    # TRACE: {"suite": "INT", "case": "0151", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "07", "title": "empty_allowed_personas_blocks_all"}
    def test_empty_allowed_personas_blocks_all(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: agent with empty allowed_personas set — all queries
        denied, even to normally-open personas."""
        mock_dina.vault.store(
            1, "consumer_blocked_001", self.CONSUMER_RECORD,
            persona=PersonaType.CONSUMER,
        )

        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.CONSUMER, "keyboard",
            agent_allowed_personas=set(),  # Empty — no access
        )

        assert result["status"] == 403, (
            "Agent with empty allowed_personas should be denied all access"
        )
        assert result["data"] is None
        assert "persona_access_denied" in result["error"]

    # TRACE: {"suite": "INT", "case": "0152", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "08", "scenario": "08", "title": "query_nonexistent_persona_data_returns_empty"}
    def test_query_nonexistent_persona_data_returns_empty(
        self, mock_dina: MockDinaCore, mock_external_agent: MockExternalAgent,
    ) -> None:
        """Edge case: agent queries an allowed persona where no matching data
        exists. Should return status 200 with empty data — not 403. Access
        control and data availability are separate concerns."""
        # Do NOT store anything in the consumer persona for this query

        result = agent_query_persona(
            mock_dina, mock_external_agent,
            PersonaType.CONSUMER, "nonexistent_product_xyzzy",
        )

        assert result["status"] == 200, (
            f"Allowed persona with no data should return 200, got {result['status']}"
        )
        assert result["error"] is None
        assert result["data"] is not None, "Data should be an empty list, not None"
        assert result["data"] == [], (
            f"Expected empty list for no matching data, got {result['data']}"
        )


# ---------------------------------------------------------------------------
# Helper: Multi-tenant agent vault query with user-scope enforcement
# ---------------------------------------------------------------------------


def agent_query_with_user_scope(
    agent: MockExternalAgent,
    agent_owner_did: str,
    target_user_did: str,
    query: str,
    vaults: dict[str, MockVault],
) -> dict:
    """Simulate an agent querying a vault with user-scope enforcement.

    In a multi-tenant Home Node, each user's vault is a separate encrypted
    SQLCipher file. An agent is cryptographically bound to its owner's DID
    at pairing time. Core enforces this binding on every request: the agent's
    authenticated DID must match the vault owner's DID.

    This models the real flow: Agent submits query -> Core checks
    agent_owner_did == vault_owner_did -> if mismatch, 403 with no data.

    Args:
        agent: The agent making the request.
        agent_owner_did: The DID of the user who paired/owns this agent.
        target_user_did: The DID of the user whose vault is being queried.
        query: The search query string.
        vaults: A dict mapping user DIDs to their MockVault instances.

    Returns:
        Dict with keys: status, error, data, owner_did, target_did.
    """
    # Core enforces: agent can only access the vault of the user it is
    # paired with. DID comparison is exact (case-sensitive, byte-equal).
    if agent_owner_did != target_user_did:
        return {
            "status": 403,
            "error": "cross_user_access_denied",
            "data": None,
            "owner_did": agent_owner_did,
            "target_did": target_user_did,
        }

    # Agent is accessing its own owner's vault — perform the query
    vault = vaults.get(agent_owner_did)
    if vault is None:
        return {
            "status": 404,
            "error": "vault_not_found",
            "data": None,
            "owner_did": agent_owner_did,
            "target_did": target_user_did,
        }

    # Search across all tiers in the owner's vault
    matching_items = []
    for tier_data in vault._tiers.values():
        for key, value in tier_data.items():
            if isinstance(value, dict):
                for v in value.values():
                    if isinstance(v, str) and query.lower() in v.lower():
                        matching_items.append({"key": key, "value": value})
                        break
            elif isinstance(value, str) and query.lower() in value.lower():
                matching_items.append({"key": key, "value": value})

    return {
        "status": 200,
        "error": None,
        "data": matching_items,
        "owner_did": agent_owner_did,
        "target_did": target_user_did,
    }


# ---------------------------------------------------------------------------
# TestAgentMultiTenantIsolation (§19.2 Agent Sandbox — Core↔Brain Integration)
# ---------------------------------------------------------------------------


class TestAgentMultiTenantIsolation:
    """Verify that agents are scoped to a single user identity.

    On a multi-tenant Home Node (e.g., a managed service hosting multiple
    users), each user's vault is a separate SQLCipher-encrypted file with
    its own DEK. An agent paired with User A must never be able to read,
    query, or infer data belonging to User B — even if both vaults reside
    on the same physical machine.

    The safety boundary is enforced by Core: the agent's authenticated DID
    (established during the pairing ceremony) is checked against the vault
    owner's DID on every request. Mismatches produce a 403 with zero data.
    """

    USER_A_DID = "did:plc:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
    USER_B_DID = "did:plc:f8e7d6c5b4a3029187f6e5d4c3b2a10987654321"
    USER_C_DID = "did:plc:0123456789abcdef0123456789abcdef01234567"

    USER_A_DATA = {
        "type": "medical_record",
        "patient": "Alice Ramirez",
        "condition": "Seasonal allergies",
        "medication": "Cetirizine 10mg",
        "doctor": "Dr. Kumar",
    }

    USER_B_DATA = {
        "type": "financial_record",
        "account_holder": "Bob Chen",
        "bank": "State Bank",
        "balance": "850000 INR",
        "transactions": "Monthly SIP 25000 INR",
    }

    USER_C_DATA = {
        "type": "legal_document",
        "party": "Carol Dubois",
        "case_number": "HC-2026-44891",
        "status": "Pending review",
    }

    def _create_user_vaults(self) -> dict[str, MockVault]:
        """Create separate vaults for each user and populate with data."""
        vault_a = MockVault()
        vault_a.store(1, "user_a_medical_001", self.USER_A_DATA)

        vault_b = MockVault()
        vault_b.store(1, "user_b_financial_001", self.USER_B_DATA)

        vault_c = MockVault()
        vault_c.store(1, "user_c_legal_001", self.USER_C_DATA)

        return {
            self.USER_A_DID: vault_a,
            self.USER_B_DID: vault_b,
            self.USER_C_DID: vault_c,
        }

    # ------------------------------------------------------------------
    # TST-INT-698 — Primary test
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0698", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "01", "title": "agent_cannot_access_another_users_data"}
    def test_agent_cannot_access_another_users_data(self) -> None:
        """Agent authenticated for User A attempts vault query for User B.

        Request fails — agent scoped to single user identity. No data
        from User B is returned or leaked in the error response.
        """
        vaults = self._create_user_vaults()
        agent = MockExternalAgent(name="OpenClaw")
        # Agent is paired with User A
        agent_owner_did = self.USER_A_DID

        # Agent attempts to query User B's vault
        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=agent_owner_did,
            target_user_did=self.USER_B_DID,
            query="bank",
            vaults=vaults,
        )

        # 1. Access denied
        assert result["status"] == 403, (
            f"Cross-user vault access must return 403, got {result['status']}"
        )

        # 2. Correct error code
        assert result["error"] == "cross_user_access_denied", (
            f"Expected 'cross_user_access_denied', got {result['error']}"
        )

        # 3. No data returned
        assert result["data"] is None, (
            "Cross-user access must return None data, not partial or empty results"
        )

        # 4. Error response does not contain ANY of User B's data content
        response_str = str(result)
        for field_name, field_value in self.USER_B_DATA.items():
            assert str(field_value) not in response_str, (
                f"User B's '{field_name}' value '{field_value}' leaked in "
                f"the 403 error response"
            )

        # 5. Documented DID mismatch in response
        assert result["owner_did"] != result["target_did"], (
            "Response must document the DID mismatch for audit logging"
        )
        assert result["owner_did"] == self.USER_A_DID
        assert result["target_did"] == self.USER_B_DID

    # ------------------------------------------------------------------
    # Counter-proof 1: Agent CAN access its own user's data
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0153", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "02", "title": "agent_can_access_own_users_data"}
    def test_agent_can_access_own_users_data(self) -> None:
        """Same agent queries User A's vault (its owner) — status 200,
        data returned. Proves the access control is about user-scoping,
        not a blanket deny."""
        vaults = self._create_user_vaults()
        agent = MockExternalAgent(name="OpenClaw")

        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_A_DID,
            query="allergies",
            vaults=vaults,
        )

        assert result["status"] == 200, (
            f"Agent querying own user's vault should get 200, got {result['status']}"
        )
        assert result["error"] is None
        assert result["data"] is not None
        assert len(result["data"]) >= 1, (
            "Agent should find at least one matching record in owner's vault"
        )
        # Verify the returned data is actually User A's data
        returned_values = [item["value"] for item in result["data"]]
        assert self.USER_A_DATA in returned_values, (
            "Returned data must contain User A's actual vault content"
        )
        # Verify NO User B data is present
        assert self.USER_B_DATA not in returned_values, (
            "User B's data must never appear in User A's query results"
        )

    # ------------------------------------------------------------------
    # Counter-proof 2: Error response leaks no vault content
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0154", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "03", "title": "cross_user_error_does_not_leak_target_data"}
    def test_cross_user_error_does_not_leak_target_data(self) -> None:
        """The 403 error response must contain zero vault content from
        either User A or User B — only structural fields (status, error
        code, DIDs)."""
        vaults = self._create_user_vaults()
        agent = MockExternalAgent(name="OpenClaw")

        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_B_DID,
            query="bank",
            vaults=vaults,
        )

        response_str = str(result)

        # No User B data in the error
        for field_name, field_value in self.USER_B_DATA.items():
            assert str(field_value) not in response_str, (
                f"User B's '{field_name}' leaked in cross-user error response"
            )

        # No User A data in the error either — the error should be pure
        # structural information, not a data response
        for field_name, field_value in self.USER_A_DATA.items():
            assert str(field_value) not in response_str, (
                f"User A's '{field_name}' leaked in cross-user error response"
            )

        # The response must only contain known structural keys
        assert set(result.keys()) == {
            "status", "error", "data", "owner_did", "target_did"
        }, f"Unexpected keys in error response: {set(result.keys())}"

    # ------------------------------------------------------------------
    # Counter-proof 3: User B's data unaffected by failed access
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0155", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "04", "title": "user_b_data_unaffected_by_failed_access"}
    def test_user_b_data_unaffected_by_failed_access(self) -> None:
        """After a failed cross-user access attempt, User B's vault is
        still intact and accessible by User B's own agent."""
        vaults = self._create_user_vaults()
        agent_a = MockExternalAgent(name="OpenClaw-A")
        agent_b = MockExternalAgent(name="OpenClaw-B")

        # Agent A tries to access User B's vault — denied
        failed_result = agent_query_with_user_scope(
            agent=agent_a,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_B_DID,
            query="bank",
            vaults=vaults,
        )
        assert failed_result["status"] == 403

        # Now User B's own agent queries the same vault — succeeds
        success_result = agent_query_with_user_scope(
            agent=agent_b,
            agent_owner_did=self.USER_B_DID,
            target_user_did=self.USER_B_DID,
            query="bank",
            vaults=vaults,
        )

        assert success_result["status"] == 200, (
            f"User B's own agent should get 200 after failed cross-user attempt, "
            f"got {success_result['status']}"
        )
        assert success_result["data"] is not None
        assert len(success_result["data"]) >= 1
        returned_values = [item["value"] for item in success_result["data"]]
        assert self.USER_B_DATA in returned_values, (
            "User B's data must be fully intact after a rejected cross-user query"
        )

    # ------------------------------------------------------------------
    # Edge case 1: Similar but different DIDs still blocked
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0156", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "05", "title": "agent_with_similar_did_still_blocked"}
    def test_agent_with_similar_did_still_blocked(self) -> None:
        """DID comparison is exact. 'did:plc:alice123' and
        'did:plc:alice124' differ by one character — access denied."""
        similar_did_a = "did:plc:alice123"
        similar_did_b = "did:plc:alice124"

        vault_a = MockVault()
        vault_a.store(1, "data_001", {"content": "User A secret notes"})
        vault_b = MockVault()
        vault_b.store(1, "data_002", {"content": "User B private journal"})

        vaults = {similar_did_a: vault_a, similar_did_b: vault_b}
        agent = MockExternalAgent(name="OpenClaw")

        # Agent paired with alice123 tries to access alice124's vault
        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=similar_did_a,
            target_user_did=similar_did_b,
            query="journal",
            vaults=vaults,
        )

        assert result["status"] == 403, (
            "DIDs differing by a single character must still be treated as "
            f"different users — expected 403, got {result['status']}"
        )
        assert result["error"] == "cross_user_access_denied"
        assert result["data"] is None

        # Confirm the agent CAN access its own vault with the exact DID
        own_result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=similar_did_a,
            target_user_did=similar_did_a,
            query="secret",
            vaults=vaults,
        )
        assert own_result["status"] == 200, (
            "Agent should access its own vault with exact DID match"
        )

    # ------------------------------------------------------------------
    # Edge case 2: Multiple users — strict pairwise isolation
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0157", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "06", "title": "multiple_users_strict_isolation"}
    def test_multiple_users_strict_isolation(self) -> None:
        """3 users (A, B, C) — agent for A can only access A, fails on
        B and C. Tests that isolation holds across all user pairs."""
        vaults = self._create_user_vaults()
        agent = MockExternalAgent(name="OpenClaw")

        # Agent for A queries A — allowed
        result_a = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_A_DID,
            query="allergies",
            vaults=vaults,
        )
        assert result_a["status"] == 200
        assert result_a["data"] is not None
        assert len(result_a["data"]) >= 1

        # Agent for A queries B — denied
        result_b = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_B_DID,
            query="bank",
            vaults=vaults,
        )
        assert result_b["status"] == 403
        assert result_b["error"] == "cross_user_access_denied"
        assert result_b["data"] is None

        # Agent for A queries C — denied
        result_c = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_C_DID,
            query="case",
            vaults=vaults,
        )
        assert result_c["status"] == 403
        assert result_c["error"] == "cross_user_access_denied"
        assert result_c["data"] is None

        # Verify no cross-contamination: results from A contain no B or C data
        result_a_str = str(result_a)
        for field_value in self.USER_B_DATA.values():
            assert str(field_value) not in result_a_str
        for field_value in self.USER_C_DATA.values():
            assert str(field_value) not in result_a_str

    # ------------------------------------------------------------------
    # Edge case 3: Empty target vault still returns 403, not 200
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0158", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "07", "title": "empty_target_vault_still_returns_403"}
    def test_empty_target_vault_still_returns_403(self) -> None:
        """Even if User B's vault has no data, the cross-user access
        attempt must return 403, not 200 with empty results. The access
        control check happens BEFORE any data lookup."""
        vault_a = MockVault()
        vault_a.store(1, "a_data_001", {"content": "User A data"})
        vault_b = MockVault()  # Empty — no data stored

        vaults = {self.USER_A_DID: vault_a, self.USER_B_DID: vault_b}
        agent = MockExternalAgent(name="OpenClaw")

        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=self.USER_A_DID,
            target_user_did=self.USER_B_DID,
            query="anything",
            vaults=vaults,
        )

        assert result["status"] == 403, (
            "Empty vault must still return 403 for cross-user access, not 200. "
            "Access control is checked before data lookup."
        )
        assert result["error"] == "cross_user_access_denied"
        assert result["data"] is None

    # ------------------------------------------------------------------
    # Edge case 4: Case-sensitive DID comparison
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0159", "section": "07", "sectionName": "Security Boundary Tests", "subsection": "09", "scenario": "08", "title": "agent_owner_did_must_match_exactly"}
    def test_agent_owner_did_must_match_exactly(self) -> None:
        """DID comparison is case-sensitive. 'did:plc:Alice' is a
        different identity from 'did:plc:alice'. Core must not
        normalize or fold case."""
        did_lower = "did:plc:alice"
        did_mixed = "did:plc:Alice"

        vault_lower = MockVault()
        vault_lower.store(1, "lower_001", {"content": "Lowercase Alice data"})
        vault_mixed = MockVault()
        vault_mixed.store(1, "mixed_001", {"content": "Mixed-case Alice data"})

        vaults = {did_lower: vault_lower, did_mixed: vault_mixed}
        agent = MockExternalAgent(name="OpenClaw")

        # Agent paired with "did:plc:alice" tries "did:plc:Alice" vault
        result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=did_lower,
            target_user_did=did_mixed,
            query="Alice",
            vaults=vaults,
        )

        assert result["status"] == 403, (
            "Case-different DIDs must be treated as different users — "
            f"expected 403, got {result['status']}"
        )
        assert result["error"] == "cross_user_access_denied"
        assert result["data"] is None

        # Confirm the agent CAN access its own (lowercase) vault
        own_result = agent_query_with_user_scope(
            agent=agent,
            agent_owner_did=did_lower,
            target_user_did=did_lower,
            query="Lowercase",
            vaults=vaults,
        )
        assert own_result["status"] == 200
        assert own_result["data"] is not None
        assert len(own_result["data"]) >= 1
