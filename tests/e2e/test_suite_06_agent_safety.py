"""E2E Suite 6: Agent Safety & Delegation.

Tests the agent safety layer: license renewal delegation with draft-only,
draft-don't-send for email, malicious bot blocking via reputation graph,
agent intent verification, task queue crash recovery, and dead letter
notification.

Actors: Don Alonso (primary user), OpenClaw (task agent), ReviewBot
        (trusted bot, rep 94), MaliciousBot (untrusted bot, rep 12)
Fixtures: don_alonso, fresh_don_alonso, openclaw, reviewbot, malicious_bot,
          appview, plc_directory, d2d_network
"""

from __future__ import annotations

import pytest

from tests.e2e.actors import HomeNode, Persona, PersonaType
from tests.e2e.mocks import (
    ActionRisk,
    MockAppView,
    MockMaliciousBot,
    MockOpenClaw,
    MockReviewBot,
    SilenceTier,
    StagingItem,
    TaskItem,
    TaskStatus,
    TrustRing,
)


class TestAgentSafetyDelegation:
    """Suite 6 — Agent Safety & Delegation (TST-E2E-029 through TST-E2E-034)."""

    # TST-E2E-029
    def test_license_renewal_delegation(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-6.1  License Renewal Delegation.

        Brain detects that a license is expiring (fiduciary priority).
        It delegates to OpenClaw with draft_only=True.  Verify:
        - The form is returned as a draft, NOT submitted.
        - A staging item is created with 72-hour expiry.
        - The notification tier is FIDUCIARY (interrupt the user).
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Brain detects license expiring (fiduciary event)
        # ------------------------------------------------------------------
        event_payload = {
            "fiduciary": True,
            "event": "license_expire",
            "details": {
                "license_type": "driving",
                "expires_in_days": 5,
                "renewal_form_url": "https://transport.gov/renew",
            },
        }

        tier = node._classify_silence("license_expire", event_payload)
        assert tier == SilenceTier.TIER_1_FIDUCIARY, (
            "License expiration must be classified as Tier 1 (Fiduciary)"
        )

        # ------------------------------------------------------------------
        # Delegate to OpenClaw: fill the form as DRAFT ONLY
        # ------------------------------------------------------------------
        form_data = {
            "license_number": "DL-2024-XXXXXX",
            "full_name": "Don Alonso",
            "date_of_birth": "1985-03-15",
            "address": "42 Windmill Lane, La Mancha",
        }

        response = openclaw.handle_request({
            "action": "form_fill",
            "draft_only": True,
            "data": form_data,
            "form_url": "https://transport.gov/renew",
        })

        assert response["status"] == "completed"
        assert response["submitted"] is False, (
            "Form must NOT be submitted — draft_only=True"
        )
        assert response["form_data"] == form_data, (
            "Returned form data must match what was sent"
        )

        # ------------------------------------------------------------------
        # Create staging item with 72h expiry
        # ------------------------------------------------------------------
        staging = node.create_staging_item(
            item_type="form_draft",
            data={
                "form_url": "https://transport.gov/renew",
                "form_data": response["form_data"],
                "agent": "openclaw",
                "action_required": "review_and_submit",
            },
            confidence=0.92,
        )

        assert staging.staging_id.startswith("stg_")
        assert staging.item_type == "form_draft"
        assert staging.data["action_required"] == "review_and_submit"

        # Verify 72h expiry (default in StagingItem.__post_init__)
        expected_expiry = staging.created_at + 72 * 3600
        assert abs(staging.expires_at - expected_expiry) < 1.0, (
            "Staging item must expire in 72 hours"
        )

        # Verify it is retrievable from node.staging
        assert staging.staging_id in node.staging

    # TST-E2E-030
    def test_draft_dont_send_email(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-6.2  Draft-Don't-Send for Email.

        Brain drafts an email via OpenClaw's draft_create action.  Verify:
        - OpenClaw NEVER calls messages.send.
        - A draft is created and stored.
        - A staging item is created for user review.
        """
        node = don_alonso

        # Record initial state of sent messages
        initial_sent_count = len(openclaw.gmail.messages_sent)

        # ------------------------------------------------------------------
        # Brain drafts an email via OpenClaw
        # ------------------------------------------------------------------
        draft_request = {
            "action": "draft_create",
            "draft_only": True,
            "draft": {
                "to": "sancho@example.com",
                "subject": "Tea this afternoon?",
                "body": "Would you like to come over for tea at 4 PM? "
                        "I found some excellent Darjeeling.",
            },
        }

        response = openclaw.handle_request(draft_request)
        assert response["status"] == "completed"
        assert "draft" in response
        assert "draft_id" in response["draft"], (
            "Draft must receive a unique draft_id"
        )

        # ------------------------------------------------------------------
        # CRITICAL: Verify messages.send was NEVER called
        # ------------------------------------------------------------------
        assert len(openclaw.gmail.messages_sent) == initial_sent_count, (
            "messages.send must NEVER be called — Dina drafts, never sends. "
            f"Found {len(openclaw.gmail.messages_sent) - initial_sent_count} "
            "unauthorized sends."
        )

        # Verify draft was stored in OpenClaw's drafts
        assert len(openclaw.gmail.drafts_created) >= 1
        latest_draft = openclaw.gmail.drafts_created[-1]
        assert latest_draft["to"] == "sancho@example.com"
        assert latest_draft["subject"] == "Tea this afternoon?"

        # ------------------------------------------------------------------
        # Create staging item for user review
        # ------------------------------------------------------------------
        staging = node.create_staging_item(
            item_type="email_draft",
            data={
                "draft_id": response["draft"]["draft_id"],
                "to": "sancho@example.com",
                "subject": "Tea this afternoon?",
                "action_required": "review_and_send",
            },
            confidence=0.88,
        )

        assert staging.staging_id in node.staging
        assert staging.data["action_required"] == "review_and_send"

    # TST-E2E-031
    def test_malicious_bot_blocking(
        self,
        don_alonso: HomeNode,
        reviewbot: MockReviewBot,
        malicious_bot: MockMaliciousBot,
        appview: MockAppView,
    ) -> None:
        """E2E-6.3  Malicious Bot Blocking.

        Brain checks bot reputations via the AppView before routing a
        product query.  Routes to ReviewBot (reputation 94), NOT to
        MaliciousBot (reputation 12).  MaliciousBot sends an injection
        attempt — verify it is rejected at schema validation.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Check reputations via AppView
        # ------------------------------------------------------------------
        reviewbot_rep = appview.query_bot("did:plc:reviewbot")
        malbot_rep = appview.query_bot("did:plc:malbot")

        assert reviewbot_rep is not None
        assert malbot_rep is not None
        assert reviewbot_rep.score == 94
        assert malbot_rep.score == 12

        # ------------------------------------------------------------------
        # Route query to the highest-reputation bot
        # ------------------------------------------------------------------
        candidates = [
            ("did:plc:reviewbot", reviewbot_rep.score, reviewbot),
            ("did:plc:malbot", malbot_rep.score, malicious_bot),
        ]
        # Sort by reputation descending — pick the best
        candidates.sort(key=lambda c: c[1], reverse=True)
        chosen_did, chosen_score, chosen_bot = candidates[0]

        assert chosen_did == "did:plc:reviewbot", (
            "Brain must route to the highest-reputation bot (ReviewBot, 94)"
        )
        assert chosen_did != "did:plc:malbot", (
            "Brain must NOT route to MaliciousBot (reputation 12)"
        )

        # ------------------------------------------------------------------
        # Send query to chosen bot (ReviewBot)
        # ------------------------------------------------------------------
        query_request = {
            "query": "ergonomic chair",
            "requester_trust_ring": node.trust_ring.value,
        }
        result = chosen_bot.handle_request(query_request)
        assert result["status"] == "completed"
        assert len(result.get("recommendations", [])) >= 1

        # ------------------------------------------------------------------
        # MaliciousBot sends injection — verify rejection
        # ------------------------------------------------------------------
        injection_response = malicious_bot.handle_request({
            "query": "office chair",
        })

        # The injection payload contains SQL injection and prompt injection
        assert "injection_payload" in injection_response, (
            "MaliciousBot must produce an injection payload"
        )
        assert "DROP TABLE" in injection_response.get("query", ""), (
            "MaliciousBot must attempt SQL injection"
        )

        # Schema validation: the injection response does NOT conform to
        # expected schema (no valid 'status' field, has extraneous fields)
        required_fields = {"status", "recommendations"}
        has_status = injection_response.get("status") == "completed"
        has_extra = "injection_payload" in injection_response

        assert has_extra, "Injection payload must be detected"
        # Brain validates schema: extraneous fields = rejection
        schema_valid = (
            has_status
            and isinstance(injection_response.get("recommendations"), list)
            and "injection_payload" not in injection_response
        )
        assert not schema_valid, (
            "MaliciousBot response must FAIL schema validation "
            "(extraneous 'injection_payload' field present)"
        )

        # Log the blocked attempt
        node._log_audit("malicious_bot_blocked", {
            "bot_did": "did:plc:malbot",
            "reputation": malbot_rep.score,
            "reason": "injection_detected",
        })
        blocked_audits = node.get_audit_entries("malicious_bot_blocked")
        assert len(blocked_audits) >= 1

    # TST-E2E-032
    def test_agent_intent_verification(
        self, don_alonso: HomeNode, openclaw: MockOpenClaw,
    ) -> None:
        """E2E-6.4  Agent Intent Verification.

        OpenClaw submits a 'send_email' intent.  verify_agent_intent
        classifies it as MODERATE risk, requiring user approval.
        Safe actions (e.g., 'search') are auto-approved.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # MODERATE risk: send_email
        # ------------------------------------------------------------------
        email_intent = node.verify_agent_intent(
            agent_did="did:plc:openclaw",
            action="send_email",
            target="sancho@example.com",
            context={"subject": "Tea invitation"},
        )

        assert email_intent["action"] == "send_email"
        assert email_intent["risk"] == "MODERATE", (
            "send_email must be classified as MODERATE risk"
        )
        assert email_intent["requires_approval"] is True, (
            "MODERATE risk actions must require user approval"
        )
        assert email_intent["approved"] is False, (
            "MODERATE risk actions must NOT be auto-approved"
        )

        # ------------------------------------------------------------------
        # SAFE action: search (auto-approved)
        # ------------------------------------------------------------------
        search_intent = node.verify_agent_intent(
            agent_did="did:plc:openclaw",
            action="search",
            target="best ergonomic chair",
        )

        assert search_intent["action"] == "search"
        assert search_intent["risk"] == "SAFE", (
            "search must be classified as SAFE risk"
        )
        assert search_intent["approved"] is True, (
            "SAFE actions must be auto-approved"
        )
        assert search_intent["requires_approval"] is False, (
            "SAFE actions must NOT require approval"
        )

        # ------------------------------------------------------------------
        # HIGH risk: transfer_money
        # ------------------------------------------------------------------
        money_intent = node.verify_agent_intent(
            agent_did="did:plc:openclaw",
            action="transfer_money",
            target="did:plc:chairmaker",
            context={"amount": 72000, "currency": "INR"},
        )

        assert money_intent["risk"] == "HIGH"
        assert money_intent["requires_approval"] is True
        assert money_intent["approved"] is False

        # ------------------------------------------------------------------
        # Verify audit trail
        # ------------------------------------------------------------------
        intent_audits = node.get_audit_entries("agent_intent")
        assert len(intent_audits) >= 3, (
            "All three intent verifications must be in the audit log"
        )

        # Check that actions are correctly logged
        logged_actions = [e.details["action"] for e in intent_audits]
        assert "send_email" in logged_actions
        assert "search" in logged_actions
        assert "transfer_money" in logged_actions

    # TST-E2E-033
    def test_task_queue_crash_recovery(
        self, don_alonso: HomeNode,
    ) -> None:
        """E2E-6.5  Task Queue Crash Recovery.

        1. Create a task.
        2. Write a scratchpad checkpoint with progress state.
        3. Crash the brain (simulated OOM).
        4. Watchdog detects the timed-out task and resets it to PENDING.
        5. Restart the brain.
        6. Read the scratchpad checkpoint and verify the task can resume
           from where it left off.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Step 1: Create task
        # ------------------------------------------------------------------
        task = node.create_task(
            action="gmail_full_sync",
            timeout_seconds=60,
        )
        assert task.status == TaskStatus.IN_PROGRESS
        assert task.task_id.startswith("task_")
        task_id = task.task_id

        # ------------------------------------------------------------------
        # Step 2: Write scratchpad checkpoint
        # ------------------------------------------------------------------
        checkpoint = {
            "action": "gmail_full_sync",
            "emails_processed": 25,
            "total_emails": 50,
            "last_cursor": "email_0024",
            "phase": "pass_2_body_fetch",
        }
        node.write_scratchpad(task_id, checkpoint)
        assert node.read_scratchpad(task_id) == checkpoint

        # ------------------------------------------------------------------
        # Step 3: Crash the brain
        # ------------------------------------------------------------------
        node.crash_brain()
        assert node._brain_crashed is True
        assert node.healthz()["brain"] == "crashed"
        assert node.healthz()["status"] == "degraded"

        # Verify brain cannot process events while crashed
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            node._brain_process("test_event", {"data": "test"})

        # ------------------------------------------------------------------
        # Step 4: Watchdog resets timed-out task
        # ------------------------------------------------------------------
        # Advance clock past timeout
        node.set_test_clock(task.timeout_at + 10)
        reset_tasks = node.watchdog_check()
        assert task_id in reset_tasks, (
            "Watchdog must detect and reset the timed-out task"
        )
        assert node.tasks[task_id].status == TaskStatus.PENDING, (
            "Task must be reset to PENDING after watchdog detection"
        )
        assert node.tasks[task_id].attempts == 1

        # ------------------------------------------------------------------
        # Step 5: Restart the brain
        # ------------------------------------------------------------------
        node.restart_brain()
        assert node._brain_crashed is False
        assert node.healthz()["brain"] == "healthy"
        assert node.healthz()["status"] == "ok"

        # ------------------------------------------------------------------
        # Step 6: Read scratchpad and resume
        # ------------------------------------------------------------------
        restored = node.read_scratchpad(task_id)
        assert restored is not None, (
            "Scratchpad checkpoint must survive brain crash"
        )
        assert restored["emails_processed"] == 25
        assert restored["last_cursor"] == "email_0024"
        assert restored["phase"] == "pass_2_body_fetch"

        # Resume the task from checkpoint
        task_after = node.tasks[task_id]
        task_after.status = TaskStatus.IN_PROGRESS
        assert task_after.status == TaskStatus.IN_PROGRESS

    # TST-E2E-034
    def test_dead_letter_notification(
        self, don_alonso: HomeNode,
    ) -> None:
        """E2E-6.6  Dead Letter Notification.

        A task fails 3 times.  After the third failure, its status must
        become 'dead' and the user must be notified.
        """
        node = don_alonso
        node.set_test_clock(1000000.0)  # Fixed clock for deterministic behavior

        # ------------------------------------------------------------------
        # Create a task with a short timeout
        # ------------------------------------------------------------------
        task = node.create_task(
            action="calendar_sync_retry",
            timeout_seconds=10,
        )
        task_id = task.task_id
        assert task.status == TaskStatus.IN_PROGRESS
        assert task.attempts == 0

        # ------------------------------------------------------------------
        # Attempt 1: timeout, watchdog resets to PENDING
        # ------------------------------------------------------------------
        node.advance_clock(15)  # Past timeout
        reset1 = node.watchdog_check()
        assert task_id in reset1
        assert node.tasks[task_id].attempts == 1
        assert node.tasks[task_id].status == TaskStatus.PENDING

        # Simulate retry: set back to IN_PROGRESS with new timeout
        node.tasks[task_id].status = TaskStatus.IN_PROGRESS
        node.tasks[task_id].timeout_at = node._now() + 10

        # ------------------------------------------------------------------
        # Attempt 2: timeout again
        # ------------------------------------------------------------------
        node.advance_clock(15)
        reset2 = node.watchdog_check()
        assert task_id in reset2
        assert node.tasks[task_id].attempts == 2
        assert node.tasks[task_id].status == TaskStatus.PENDING

        # Simulate retry again
        node.tasks[task_id].status = TaskStatus.IN_PROGRESS
        node.tasks[task_id].timeout_at = node._now() + 10

        # ------------------------------------------------------------------
        # Attempt 3: timeout — should become DEAD
        # ------------------------------------------------------------------
        pre_notification_count = len(node.notifications)

        node.advance_clock(15)
        reset3 = node.watchdog_check()
        assert task_id in reset3
        assert node.tasks[task_id].attempts == 3
        assert node.tasks[task_id].status == TaskStatus.DEAD, (
            "Task must be marked DEAD after 3 failed attempts"
        )

        # ------------------------------------------------------------------
        # Verify user was notified
        # ------------------------------------------------------------------
        assert len(node.notifications) > pre_notification_count, (
            "User must be notified when a task becomes dead"
        )

        # Check the notification content
        dead_notification = node.notifications[-1]
        assert dead_notification["type"] == "whisper"
        assert "failed" in dead_notification["payload"]["text"].lower(), (
            "Dead letter notification must mention failure"
        )
        assert dead_notification["payload"]["tier"] == SilenceTier.TIER_2_SOLICITED.value, (
            "Dead letter notification must be Tier 2 (solicited — user created the task)"
        )
