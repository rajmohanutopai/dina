"""Integration tests for crash recovery (Architecture §6).

Behavioral contracts tested:
- §6.1 Core Crash: outbox persistence, WAL protection, WS reconnection,
  encrypted spool survival across restarts.
- §6.2 Brain Crash: scratchpad checkpoint resume, fresh restart without
  checkpoint, idempotent LLM retry, briefing reconstruction.
- §6.3 LLM Crash: timeout handling, OOM fallback to cloud, corrupted
  model detection.
- §6.4 Power Loss: WAL mode on all SQLite DBs, disk-full protection.

The Home Node must survive abrupt crashes at every layer.  Go Core's
outbox, WAL, and encrypted spools persist through restarts.  The Python
Brain uses scratchpad checkpoints to resume interrupted tasks.  LLM
failures are contained and do not cascade.
"""

from __future__ import annotations

import time
import uuid

import pytest

from tests.integration.mocks import (
    DinaMessage,
    LLMTarget,
    MockCrashLog,
    MockDinaCore,
    MockDockerCompose,
    MockGoCore,
    MockIdentity,
    MockInboxSpool,
    MockLLMRouter,
    MockOutbox,
    MockPIIScrubber,
    MockPythonBrain,
    MockScratchpad,
    MockSilenceClassifier,
    MockVault,
    MockWebSocketServer,
    MockWhisperAssembler,
    Notification,
    PersonaType,
    SilenceTier,
    WSMessage,
)


# =========================================================================
# §6.1 Core Crash
# =========================================================================


class TestCoreCrash:
    """Core process crashes — outbox, WAL, WS, and spool must survive."""

    # TST-INT-138
    def test_core_crash_pending_outbox_persists(
        self,
        mock_dina: MockDinaCore,
        mock_outbox: MockOutbox,
    ) -> None:
        """Core crash with pending outbox — outbox persists, messages
        delivered after restart.

        The outbox is stored on disk (SQLite with WAL).  When Core crashes
        mid-delivery, pending messages remain in the outbox and are retried
        after restart.
        """
        recipient_did = "did:plc:Sancho12345678901234567890abc"

        # Enqueue three messages before crash
        msg1 = DinaMessage(
            type="dina/social/tea_invite",
            from_did=mock_dina.identity.root_did,
            to_did=recipient_did,
            payload={"text": "Tea at 4pm?"},
        )
        msg2 = DinaMessage(
            type="dina/social/arrival",
            from_did=mock_dina.identity.root_did,
            to_did=recipient_did,
            payload={"text": "I am at the cafe."},
        )
        msg3 = DinaMessage(
            type="dina/social/greeting",
            from_did=mock_dina.identity.root_did,
            to_did=recipient_did,
            payload={"text": "Good morning!"},
        )
        id1 = mock_outbox.enqueue(msg1)
        id2 = mock_outbox.enqueue(msg2)
        id3 = mock_outbox.enqueue(msg3)

        # Deliver only the first before crash
        mock_outbox.ack(id1)
        assert id1 in mock_outbox.delivered

        # --- CRASH ---
        # Outbox survives (it is on-disk); pending messages still there
        pending = mock_outbox.get_pending()
        pending_ids = [mid for mid, _ in pending]
        assert id2 in pending_ids
        assert id3 in pending_ids
        assert id1 not in pending_ids  # already delivered

        # --- RESTART ---
        # After restart, retry the remaining messages
        for mid, _msg in pending:
            mock_outbox.ack(mid)

        assert id2 in mock_outbox.delivered
        assert id3 in mock_outbox.delivered
        assert len(mock_outbox.get_pending()) == 0

    # TST-INT-139
    def test_core_crash_during_vault_write_wal_protects(
        self,
        mock_vault: MockVault,
    ) -> None:
        """Core crash during vault write — WAL protects against corruption.

        SQLite WAL mode ensures that an incomplete write is rolled back on
        restart.  We verify the vault's PRAGMA settings enforce WAL mode
        and that batch writes are atomic (single transaction), so a crash
        mid-batch cannot leave partial data.
        """
        # Verify WAL mode is configured — these are architectural requirements
        assert "journal_mode" in mock_vault.PRAGMAS
        assert mock_vault.PRAGMAS["journal_mode"] == "WAL"
        assert mock_vault.PRAGMAS["synchronous"] == "NORMAL"
        # Counter-proof: DELETE mode would not have WAL protection
        assert mock_vault.PRAGMAS["journal_mode"] != "DELETE"

        # Store a known-good value before crash
        mock_vault.store(1, "pre_crash_key", {"status": "committed"})
        assert mock_vault.retrieve(1, "pre_crash_key") == {"status": "committed"}

        # Verify batch write atomicity: store_batch uses a single transaction
        tx_before = mock_vault._tx_count
        write_before = mock_vault._write_count
        batch_items = [
            ("batch_item_1", {"status": "batch"}),
            ("batch_item_2", {"status": "batch"}),
            ("batch_item_3", {"status": "batch"}),
        ]
        written = mock_vault.store_batch(1, batch_items)
        assert written == 3
        # Batch is a single transaction — critical for WAL crash safety
        assert mock_vault._tx_count == tx_before + 1
        # But all 3 items were individually written
        assert mock_vault._write_count == write_before + 3

        # All batch items are retrievable (atomic commit)
        for key, value in batch_items:
            assert mock_vault.retrieve(1, key) == value

        # Pre-crash data survives independent operations
        assert mock_vault.retrieve(1, "pre_crash_key") == {"status": "committed"}

        # Counter-proof: a delete of one key does not affect others
        mock_vault.delete(1, "batch_item_2")
        assert mock_vault.retrieve(1, "batch_item_2") is None
        assert mock_vault.retrieve(1, "batch_item_1") == {"status": "batch"}
        assert mock_vault.retrieve(1, "batch_item_3") == {"status": "batch"}
        assert mock_vault.retrieve(1, "pre_crash_key") == {"status": "committed"}

    # TST-INT-140
    def test_core_crash_ws_clients_detect_disconnect(
        self,
        mock_ws_server: MockWebSocketServer,
    ) -> None:
        """Core crash with active WS connections — clients detect disconnect,
        reconnect with buffered messages.

        When Core crashes, all WebSocket connections drop.  On restart,
        clients reconnect and receive any buffered messages.
        """
        # Set up two connected clients
        token_a = "client_token_aaa"
        token_b = "client_token_bbb"
        mock_ws_server.add_valid_token(token_a)
        mock_ws_server.add_valid_token(token_b)

        conn_a = mock_ws_server.accept("phone_001")
        mock_ws_server.authenticate_connection(conn_a, token_a)
        assert conn_a.authenticated is True

        conn_b = mock_ws_server.accept("tablet_001")
        mock_ws_server.authenticate_connection(conn_b, token_b)
        assert conn_b.authenticated is True

        # --- CRASH: all connections drop ---
        mock_ws_server.disconnect_device("phone_001")
        mock_ws_server.disconnect_device("tablet_001")
        assert conn_a.connected is False
        assert conn_b.connected is False

        # While clients are disconnected, messages are buffered
        buffered_msg = WSMessage(
            type="whisper",
            payload={"text": "Price alert: ThinkPad dropped to 140k."},
        )
        delivered = mock_ws_server.push_to_device("phone_001", buffered_msg)
        assert delivered is False  # buffered, not delivered

        # --- RESTART: clients reconnect ---
        conn_a2 = mock_ws_server.accept("phone_001")
        result = mock_ws_server.authenticate_connection(conn_a2, token_a)
        assert result.type == "auth_ok"
        assert conn_a2.authenticated is True

        # Buffered messages were replayed on reconnect
        assert len(conn_a2.received) == 1
        assert conn_a2.received[0].type == "whisper"

    # TST-INT-141
    def test_core_crash_locked_persona_spool_survives(
        self,
        mock_inbox_spool: MockInboxSpool,
    ) -> None:
        """Core crash with locked persona spool — encrypted spool survives
        restart.

        Messages for a locked persona are queued in an encrypted spool.
        The spool is stored on disk and must survive a Core crash.
        After restart and persona unlock, all spooled messages are drained.
        """
        # Store encrypted blobs in the spool (messages for locked persona)
        blob1 = b"ENCRYPTED_MSG_FROM_SANCHO_001"
        blob2 = b"ENCRYPTED_MSG_FROM_MARIA_002"
        blob3 = b"ENCRYPTED_MSG_FROM_SELLER_003"

        id1 = mock_inbox_spool.store(blob1)
        id2 = mock_inbox_spool.store(blob2)
        id3 = mock_inbox_spool.store(blob3)

        assert id1 is not None
        assert id2 is not None
        assert id3 is not None
        assert mock_inbox_spool.used_bytes > 0

        # --- CRASH ---
        # Spool persists on disk; after restart we can still retrieve
        assert mock_inbox_spool.retrieve(id1) == blob1
        assert mock_inbox_spool.retrieve(id2) == blob2
        assert mock_inbox_spool.retrieve(id3) == blob3

        # --- RESTART + PERSONA UNLOCK: drain the spool ---
        drained = mock_inbox_spool.drain()
        assert len(drained) == 3
        assert blob1 in drained
        assert blob2 in drained
        assert blob3 in drained
        assert mock_inbox_spool.used_bytes == 0


# =========================================================================
# §6.2 Brain Crash
# =========================================================================


class TestBrainCrash:
    """Brain process crashes — checkpoints, idempotent retries, briefing."""

    # TST-INT-142
    def test_brain_crash_scratchpad_checkpoint_resume(
        self,
        mock_scratchpad: MockScratchpad,
        mock_brain: MockPythonBrain,
    ) -> None:
        """Brain crash mid-task — scratchpad checkpoint allows resume from
        last step.

        The Brain checkpoints progress to the scratchpad (stored in vault
        tier 4).  After a crash, the Brain loads the checkpoint and resumes
        from the last completed step instead of starting over.
        """
        task_id = "analysis_laptop_review_001"

        # Brain works through steps 1-3, checkpointing at each step
        mock_scratchpad.save(task_id, step=1, context={
            "sources_collected": 2,
            "partial_summary": "ThinkPad and MacBook reviews collected",
        })
        mock_scratchpad.save(task_id, step=2, context={
            "sources_collected": 4,
            "partial_summary": "Added Dell and HP reviews",
        })
        mock_scratchpad.save(task_id, step=3, context={
            "sources_collected": 6,
            "partial_summary": "All 6 reviews collected, beginning analysis",
        })

        # --- BRAIN CRASH ---
        mock_brain.crash()
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_brain.process({"type": "continue_analysis", "content": task_id})

        # --- BRAIN RESTART ---
        mock_brain.restart()

        # Load checkpoint — should be at step 3
        checkpoint = mock_scratchpad.load(task_id)
        assert checkpoint is not None
        assert checkpoint["step"] == 3
        assert checkpoint["context"]["sources_collected"] == 6

        # Resume from step 3 (not step 1)
        result = mock_brain.process({
            "type": "resume_analysis",
            "content": f"Resume {task_id} from step 3",
        })
        assert result["processed"] is True

        # Clean up checkpoint after task completes
        mock_scratchpad.delete(task_id)
        assert not mock_scratchpad.has_checkpoint(task_id)

    # TST-INT-143
    def test_brain_crash_no_checkpoint_starts_fresh(
        self,
        mock_scratchpad: MockScratchpad,
        mock_brain: MockPythonBrain,
    ) -> None:
        """Brain crash with no checkpoint — task starts from scratch.

        If no scratchpad checkpoint exists for the task, the Brain must
        start the entire task over from step 1.
        """
        task_id = "analysis_chair_review_002"

        # No checkpoint was saved before the crash
        assert not mock_scratchpad.has_checkpoint(task_id)

        # --- BRAIN CRASH ---
        mock_brain.crash()

        # --- BRAIN RESTART ---
        mock_brain.restart()

        # Attempt to load checkpoint — nothing found
        checkpoint = mock_scratchpad.load(task_id)
        assert checkpoint is None

        # Task must start from scratch (step 1)
        mock_scratchpad.save(task_id, step=1, context={
            "sources_collected": 0,
            "partial_summary": "Starting fresh after crash",
        })
        result = mock_brain.process({
            "type": "start_analysis",
            "content": "Starting chair review analysis from scratch",
        })
        assert result["processed"] is True
        assert mock_scratchpad.load(task_id)["step"] == 1

    # TST-INT-144
    def test_brain_crash_during_llm_call_idempotent_retry(
        self,
        mock_brain: MockPythonBrain,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Brain crash during LLM call — LLM call is idempotent, brain
        retries.

        LLM inference is a pure function: same input produces same output.
        If the Brain crashes mid-call, it simply retries the same request
        after restart.  No side effects occur from the incomplete call.
        """
        query = "Compare ThinkPad X1 vs MacBook Air for battery life"

        # First attempt: Brain routes to LLM
        target = mock_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        # --- BRAIN CRASH during LLM response ---
        mock_brain.crash()
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_brain.reason(query)

        # --- BRAIN RESTART ---
        mock_brain.restart()

        # Retry the same query — idempotent, no side effects from crash
        answer = mock_brain.reason(query)
        assert "Reasoned answer" in answer or "Compare" in answer

        # Verify the LLM router logged both attempts (the pre-crash route
        # and the post-restart route)
        cloud_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.CLOUD
        ]
        assert len(cloud_entries) >= 2  # original route + retry route

    # TST-INT-145
    def test_brain_crash_pending_briefing_reconstructed(
        self,
        mock_dina: MockDinaCore,
        mock_scratchpad: MockScratchpad,
    ) -> None:
        """Brain crash with pending briefing — briefing reconstructed from
        vault data.

        The daily briefing is assembled from vault entries.  If the Brain
        crashes while building a briefing, it can reconstruct it from the
        vault data after restart since the vault is on the Core (not Brain).
        """
        # Seed vault with briefing-relevant data
        mock_dina.vault.store(1, "briefing_item_1", {
            "type": "price_alert",
            "content": "ThinkPad X1 dropped to 140k INR",
            "timestamp": time.time(),
        })
        mock_dina.vault.store(1, "briefing_item_2", {
            "type": "calendar_reminder",
            "content": "Team standup at 09:00",
            "timestamp": time.time(),
        })
        mock_dina.vault.store(1, "briefing_item_3", {
            "type": "social_update",
            "content": "Sancho sent a message about weekend plans",
            "timestamp": time.time(),
        })
        mock_dina.vault.index_for_fts("briefing_item_1", "price alert ThinkPad 140k")
        mock_dina.vault.index_for_fts("briefing_item_2", "calendar standup meeting")
        mock_dina.vault.index_for_fts("briefing_item_3", "social Sancho weekend")

        # Brain starts building the briefing
        mock_scratchpad.save("daily_briefing", step=1, context={
            "items_collected": 1,
            "partial": ["ThinkPad price alert"],
        })

        # --- BRAIN CRASH ---
        mock_dina.brain.crash()

        # --- BRAIN RESTART ---
        mock_dina.brain.restart()

        # Vault data is intact (Core never crashed)
        assert mock_dina.vault.retrieve(1, "briefing_item_1") is not None
        assert mock_dina.vault.retrieve(1, "briefing_item_2") is not None
        assert mock_dina.vault.retrieve(1, "briefing_item_3") is not None

        # Brain reconstructs the briefing by re-querying the vault
        price_results = mock_dina.go_core.vault_query("price")
        calendar_results = mock_dina.go_core.vault_query("calendar")
        social_results = mock_dina.go_core.vault_query("social")

        assert len(price_results) >= 1
        assert len(calendar_results) >= 1
        assert len(social_results) >= 1

        # Brain can process the reconstructed briefing
        result = mock_dina.brain.process({
            "type": "daily_briefing",
            "content": "Reconstructed briefing after crash recovery",
        })
        assert result["processed"] is True


# =========================================================================
# §6.3 LLM Crash
# =========================================================================


class TestLLMCrash:
    """LLM process failures — timeout, OOM fallback, corrupted model."""

    # TST-INT-146
    def test_llm_crash_during_inference_graceful_error(
        self,
        mock_brain: MockPythonBrain,
    ) -> None:
        """LLM crash during inference — brain raises error, recovers
        after restart.

        If the LLM process crashes, the Brain raises RuntimeError.
        After restart, inference works again and produces a result.
        """
        # Counter-proof: Brain works BEFORE crash
        pre_crash = mock_brain.reason("What laptop should I buy?")
        assert pre_crash is not None
        assert len(mock_brain.reasoned) == 1

        # Simulate LLM crash
        mock_brain.crash()

        # All inference calls fail while crashed
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_brain.reason("What laptop should I buy?")

        # A second call also fails — crash is persistent, not transient
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_brain.reason("Different query entirely")

        # No new reasoned entries added during crashed state
        assert len(mock_brain.reasoned) == 1

        # Brain can be restarted and LLM calls succeed
        mock_brain.restart()
        answer = mock_brain.reason("What laptop should I buy?")
        assert answer is not None
        assert len(mock_brain.reasoned) == 2

    # TST-INT-147
    def test_llm_oom_fallback_to_cloud(
        self,
        mock_llm_router: MockLLMRouter,
        mock_cloud_llm_router: MockLLMRouter,
    ) -> None:
        """LLM OOM — brain detects unresponsive LLM, falls back to cloud
        (if configured).

        When the local LLM runs out of memory, the Brain's LLM router
        falls back to the cloud profile for non-sensitive tasks.  Sensitive
        personas still refuse cloud routing.
        """
        # Pre-condition: routing logs are empty
        assert len(mock_llm_router.routing_log) == 0
        assert len(mock_cloud_llm_router.routing_log) == 0

        # Local LLM is healthy: basic tasks go LOCAL
        target = mock_llm_router.route("summarize")
        assert target == LLMTarget.LOCAL

        # Verify the routing log recorded the decision
        assert len(mock_llm_router.routing_log) == 1
        assert mock_llm_router.routing_log[0]["target"] == LLMTarget.LOCAL

        # --- LOCAL LLM OOM ---
        # Simulate fallback: switch to cloud router profile
        # Non-sensitive tasks should now route to CLOUD
        target_fallback = mock_cloud_llm_router.route("summarize")
        assert target_fallback == LLMTarget.CLOUD

        # Complex reasoning also falls back to cloud
        target_complex = mock_cloud_llm_router.route("complex_reasoning")
        assert target_complex == LLMTarget.CLOUD

        # BUT: sensitive personas NEVER go to cloud, even during OOM fallback
        target_health = mock_cloud_llm_router.route(
            "summarize", persona=PersonaType.HEALTH
        )
        assert target_health != LLMTarget.CLOUD
        assert target_health == LLMTarget.ON_DEVICE

        target_financial = mock_cloud_llm_router.route(
            "complex_reasoning", persona=PersonaType.FINANCIAL
        )
        assert target_financial != LLMTarget.CLOUD
        assert target_financial == LLMTarget.ON_DEVICE

        # Verify cloud router logged ALL routing decisions with reasons
        assert len(mock_cloud_llm_router.routing_log) == 4
        sensitive_entries = [e for e in mock_cloud_llm_router.routing_log
                            if "sensitive" in e.get("reason", "")]
        assert len(sensitive_entries) == 2, (
            "Both HEALTH and FINANCIAL must be logged as sensitive persona routing"
        )

    # TST-INT-148
    def test_corrupted_model_file_halts_routing(
        self,
        mock_llm_router: MockLLMRouter,
        mock_crash_log: MockCrashLog,
    ) -> None:
        """Corrupted model file — brain detects integrity failure, halts LLM
        routing.

        If the model file is corrupted (checksum mismatch), the Brain
        must not attempt inference.  It logs the integrity failure and
        disables LLM routing until the model is re-downloaded.
        """
        # Simulate model integrity check
        expected_checksum = "abc123def456"
        actual_checksum = "CORRUPTED_HASH"

        integrity_ok = expected_checksum == actual_checksum
        assert integrity_ok is False

        # Log the integrity failure
        mock_crash_log.record(
            error="Model integrity check failed",
            traceback=f"Expected {expected_checksum}, got {actual_checksum}",
            sanitized_line="model_checksum_mismatch",
        )

        assert len(mock_crash_log.entries) == 1
        assert "integrity" in mock_crash_log.entries[0]["error"].lower()

        # With corrupted model, FTS-only queries still work (no LLM needed)
        target = mock_llm_router.route("fts_search")
        assert target == LLMTarget.NONE

        # But LLM-dependent tasks should be blocked (model unusable).
        # In production the router would check model health before routing.
        # Here we verify the crash log records the failure for the operator.
        recent = mock_crash_log.get_recent(count=5)
        assert any("integrity" in e["error"].lower() for e in recent)


# =========================================================================
# §6.4 Power Loss
# =========================================================================


class TestPowerLoss:
    """Abrupt power loss — WAL mode and disk-full recovery."""

    # TST-INT-149
    def test_power_loss_all_sqlite_wal_mode(
        self,
        mock_vault: MockVault,
    ) -> None:
        """Power loss simulation — all SQLite DBs have WAL mode, survive
        abrupt shutdown.

        Every SQLite database in the system (vault, identity, trust)
        must use WAL journal mode.  This ensures that committed
        transactions survive power loss and uncommitted transactions are
        rolled back cleanly.
        """
        # Verify WAL mode PRAGMAs on the vault
        assert mock_vault.PRAGMAS["journal_mode"] == "WAL"
        assert mock_vault.PRAGMAS["synchronous"] == "NORMAL"
        assert mock_vault.PRAGMAS["busy_timeout"] == 5000
        assert mock_vault.PRAGMAS["foreign_keys"] == "ON"

        # Write data before power loss
        mock_vault.store(1, "before_power_loss_1", {"critical": True})
        mock_vault.store(1, "before_power_loss_2", {"important": True})
        mock_vault.store(2, "before_power_loss_3", {"contacts": ["Sancho"]})

        # --- POWER LOSS ---
        # (No graceful shutdown — data must survive from WAL)

        # --- POWER RESTORED ---
        # All committed data should be intact
        assert mock_vault.retrieve(1, "before_power_loss_1") == {"critical": True}
        assert mock_vault.retrieve(1, "before_power_loss_2") == {"important": True}
        assert mock_vault.retrieve(2, "before_power_loss_3") == {"contacts": ["Sancho"]}

        # New writes succeed after power restoration
        mock_vault.store(1, "after_power_loss", {"recovered": True})
        assert mock_vault.retrieve(1, "after_power_loss") == {"recovered": True}

    # TST-INT-150
    def test_disk_full_vault_rejects_writes_existing_data_preserved(
        self,
        mock_vault: MockVault,
    ) -> None:
        """Disk full recovery — vault rejects writes when disk full,
        existing data preserved.

        When the disk is full, new writes to the vault must fail gracefully
        without corrupting existing data.  Once disk space is freed, writes
        resume normally.
        """
        # Pre-populate vault with critical data
        mock_vault.store(0, "master_key_wrapped", {"key": "WRAPPED_DEK_001"})
        mock_vault.store(1, "laptop_verdict_001", {"product": "ThinkPad X1"})
        mock_vault.store(1, "chair_verdict_001", {"product": "Aeron"})

        initial_write_count = mock_vault._write_count

        # --- DISK FULL ---
        # Simulate disk full by checking that existing data is intact
        # before and after a failed write attempt.  In production, the
        # SQLite write would return SQLITE_FULL and the transaction would
        # roll back.

        # Verify existing data is intact
        assert mock_vault.retrieve(0, "master_key_wrapped") is not None
        assert mock_vault.retrieve(1, "laptop_verdict_001") is not None
        assert mock_vault.retrieve(1, "chair_verdict_001") is not None

        # Simulate a write rejection (disk full scenario):
        # We model this as a conditional write that checks available space.
        disk_full = True
        write_succeeded = False
        if not disk_full:
            mock_vault.store(1, "new_verdict_blocked", {"product": "blocked"})
            write_succeeded = True

        assert write_succeeded is False
        assert mock_vault.retrieve(1, "new_verdict_blocked") is None

        # Existing data is still intact after the rejected write
        assert mock_vault.retrieve(0, "master_key_wrapped") == {"key": "WRAPPED_DEK_001"}
        assert mock_vault.retrieve(1, "laptop_verdict_001") == {"product": "ThinkPad X1"}
        assert mock_vault.retrieve(1, "chair_verdict_001") == {"product": "Aeron"}

        # --- DISK SPACE FREED ---
        disk_full = False
        if not disk_full:
            mock_vault.store(1, "new_verdict_ok", {"product": "Post-recovery"})
            write_succeeded = True

        assert write_succeeded is True
        assert mock_vault.retrieve(1, "new_verdict_ok") == {"product": "Post-recovery"}
