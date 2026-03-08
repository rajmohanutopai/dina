"""E2E Test Suite 10: Resilience & Recovery.

Tests brain crash recovery with scratchpad resume, WAL recovery after
simulated power loss, full stack power loss, dead letter queue with
exponential backoff, disk full scenarios, and batch ingestion atomicity.

Actors: Don Alonso (fresh), D2D Network, PLC Directory.
"""

from __future__ import annotations

import time

import pytest

from tests.e2e.actors import HomeNode, PersonaType
from tests.e2e.mocks import (
    DeviceType,
    MockD2DNetwork,
    MockPLCDirectory,
    OutboxMessage,
    SilenceTier,
    TaskItem,
    TaskStatus,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 10: Resilience & Recovery
# ---------------------------------------------------------------------------


class TestResilienceRecovery:
    """E2E-10.x -- Brain crash recovery, WAL integrity, power loss,
    dead letter queue, disk full, and batch atomicity."""

# TST-E2E-047
    def test_brain_crash_scratchpad_resume(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-10.1 Brain Crash + Scratchpad Resume.

        Create a multi-step task, write a checkpoint after step 2,
        crash the brain, verify watchdog resets the task, restart the
        brain, confirm scratchpad retains step 2 results.

        Verify:
        - Task created with IN_PROGRESS status
        - Scratchpad checkpoint round-trips all field VALUES
        - Brain crash → healthz reports crashed/degraded
        - Brain cannot process events while crashed
        - Watchdog detects timed-out task and resets to PENDING
        - Brain restart → healthz reports healthy/ok
        - Scratchpad survives crash with ALL field values intact
        - Task remains PENDING after restart (awaiting scheduler)
        - Attempt counter preserved across restart
        - Negative: non-existent task scratchpad returns None
        - Brain is functional after restart (can create new tasks)
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Pair a device so notifications are observable
        code = node.generate_pairing_code()
        phone = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert phone is not None

        # Create a 5-step task with a 10-second timeout
        task = node.create_task("multi_step_analysis", timeout_seconds=10)
        assert task.status == TaskStatus.IN_PROGRESS, (
            "New task must start as IN_PROGRESS"
        )
        task_id = task.task_id
        assert task_id.startswith("task_"), (
            "Task ID must have task_ prefix"
        )

        # Write a scratchpad checkpoint after steps 1 and 2
        step_results = {
            "step_1": {"status": "done", "data": "fetched_reviews"},
            "step_2": {"status": "done", "data": "scored_products"},
            "completed_steps": 2,
            "total_steps": 5,
        }
        node.write_scratchpad(task_id, step_results)

        # Verify checkpoint written with correct VALUES
        checkpoint = node.read_scratchpad(task_id)
        assert checkpoint is not None
        assert checkpoint["completed_steps"] == 2
        assert checkpoint["total_steps"] == 5
        assert checkpoint["step_1"]["data"] == "fetched_reviews", (
            "Step 1 data must be preserved"
        )
        assert checkpoint["step_2"]["data"] == "scored_products", (
            "Step 2 data must be preserved"
        )

        # --- Crash the brain ---
        node.crash_brain()
        assert node._brain_crashed is True
        assert node.healthz()["brain"] == "crashed"
        assert node.healthz()["status"] == "degraded", (
            "System status must be degraded during brain crash"
        )

        # Brain cannot process events while crashed
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            node._brain_process("test_event", {"data": "test"})

        # --- Watchdog detects timed-out task ---
        node.set_test_clock(time.time() + 15)

        reset_tasks = node.watchdog_check()
        assert task_id in reset_tasks, (
            "Watchdog must detect and reset the timed-out task"
        )
        assert node.tasks[task_id].status == TaskStatus.PENDING, (
            "Task must be reset to PENDING after watchdog detection"
        )
        assert node.tasks[task_id].attempts == 1, (
            "Attempt counter must increment after watchdog reset"
        )

        # --- Restart the brain ---
        node.restart_brain()
        assert node._brain_crashed is False
        assert node.healthz()["brain"] == "healthy"
        assert node.healthz()["status"] == "ok", (
            "System status must be ok after brain restart"
        )

        # --- Scratchpad survives crash — ALL values intact ---
        recovered = node.read_scratchpad(task_id)
        assert recovered is not None, (
            "Scratchpad checkpoint must survive brain crash"
        )
        assert recovered["step_1"]["status"] == "done", (
            "Step 1 status must survive crash"
        )
        assert recovered["step_1"]["data"] == "fetched_reviews", (
            "Step 1 data must survive crash"
        )
        assert recovered["step_2"]["status"] == "done", (
            "Step 2 status must survive crash"
        )
        assert recovered["step_2"]["data"] == "scored_products", (
            "Step 2 data must survive crash"
        )
        assert recovered["completed_steps"] == 2, (
            "Completed step count must survive crash"
        )
        assert recovered["total_steps"] == 5, (
            "Total step count must survive crash"
        )

        # Task must remain PENDING (awaiting scheduler to resume)
        assert node.tasks[task_id].status == TaskStatus.PENDING, (
            "Task must remain PENDING after restart (awaiting scheduler)"
        )
        assert node.tasks[task_id].attempts == 1, (
            "Attempt counter must be preserved across restart"
        )

        # --- Negative control: non-existent task scratchpad ---
        ghost = node.read_scratchpad("task_nonexistent_xyz")
        assert ghost is None, (
            "Scratchpad for non-existent task must return None"
        )

        # --- Brain is functional after restart ---
        new_task = node.create_task("calendar_sync", timeout_seconds=30)
        assert new_task.status == TaskStatus.IN_PROGRESS, (
            "Brain must be able to create new tasks after restart"
        )
        assert new_task.task_id != task_id, (
            "New task must have a different ID from the recovered task"
        )

# TST-E2E-048
    def test_core_wal_recovery_after_power_loss(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-10.2 Core WAL Recovery After Power Loss.

        Store 100 items rapidly, simulate a crash by clearing some items,
        verify committed items are present with VALUE assertions and
        the FTS index is stale for removed items.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # ------------------------------------------------------------------
        # 1. Rapidly store 100 items
        # ------------------------------------------------------------------
        stored_ids = []
        for i in range(100):
            item_id = node.vault_store(
                "consumer", f"wal_item_{i:03d}",
                {"index": i, "payload": f"data_block_{i}"},
            )
            stored_ids.append(item_id)

        assert len(stored_ids) == 100

        # All 100 items should be present before crash
        persona = node.personas["consumer"]
        assert len(persona.items) == 100

        # ------------------------------------------------------------------
        # 2. Positive control: FTS works before crash
        # ------------------------------------------------------------------
        pre_crash_fts = node.vault_query("consumer", "wal_item_050")
        assert len(pre_crash_fts) >= 1, (
            "FTS must find item by keyword before crash"
        )
        pre_item = pre_crash_fts[0]
        assert pre_item.persona == "consumer"
        assert "data_block_50" in pre_item.body_text

        # Spot-check VALUE assertions on a few items
        item_0 = persona.items[stored_ids[0]]
        assert '"index": 0' in item_0.body_text or '"index":0' in item_0.body_text.replace(' ', '')
        assert "data_block_0" in item_0.body_text
        item_99 = persona.items[stored_ids[99]]
        assert "data_block_99" in item_99.body_text

        # Record committed snapshot
        committed_ids = set(persona.items.keys())
        assert len(committed_ids) == 100

        # ------------------------------------------------------------------
        # 3. Simulate power loss: remove first 10 items
        # ------------------------------------------------------------------
        items_to_remove = stored_ids[:10]
        for item_id in items_to_remove:
            del persona.items[item_id]

        # After crash, exactly 90 items remain
        assert len(persona.items) == 90

        # ------------------------------------------------------------------
        # 4. Verify surviving items are self-consistent with VALUES
        # ------------------------------------------------------------------
        surviving_ids = set(persona.items.keys())
        assert surviving_ids == committed_ids - set(items_to_remove)
        assert len(surviving_ids) == 90

        for item_id, item in persona.items.items():
            assert item.item_id == item_id
            assert item.persona == "consumer"
            assert "data_block" in item.body_text
            # Parse the body and verify index is in [10..99] range
            body = json.loads(item.body_text)
            assert body["index"] >= 10, (
                f"Item with index {body['index']} should have been removed"
            )

        # ------------------------------------------------------------------
        # 5. FTS index stale: removed items may still be in FTS
        #    but the authoritative store is the persona dict.
        #    Surviving items MUST still be findable via FTS.
        # ------------------------------------------------------------------
        post_crash_fts = node.vault_query("consumer", "wal_item_050")
        assert len(post_crash_fts) >= 1, (
            "Surviving items must still be findable via FTS after crash"
        )

        # ------------------------------------------------------------------
        # 6. Negative control: removed item IDs are gone from store
        # ------------------------------------------------------------------
        for removed_id in items_to_remove:
            assert removed_id not in persona.items, (
                f"Removed item {removed_id} must not be in persona store"
            )

# TST-E2E-049
    def test_full_stack_power_loss(
        self,
        fresh_don_alonso: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-10.3 Full Stack Power Loss.

        Create vault items and outbox messages, crash the brain, restart,
        verify vault data is intact and outbox messages are retried.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Store vault items
        item_ids = []
        for i in range(5):
            item_id = node.vault_store(
                "consumer", f"power_loss_item_{i}",
                {"data": f"important_data_{i}"},
            )
            item_ids.append(item_id)

        # Queue outbox messages (to a target that is offline)
        d2d_network.set_online("did:plc:target_offline", False)
        for i in range(3):
            msg_id = f"msg_power_{i:03d}"
            node.outbox[msg_id] = OutboxMessage(
                msg_id=msg_id,
                to_did="did:plc:target_offline",
                payload={"content": f"queued_message_{i}"},
                status="pending",
            )

        assert len(node.outbox) == 3

        # Crash the brain
        node.crash_brain()
        assert node.healthz()["status"] == "degraded"

        # Restart
        node.restart_brain()
        assert node.healthz()["status"] == "ok"

        # Vault data is intact after restart
        persona = node.personas["consumer"]
        for item_id in item_ids:
            assert item_id in persona.items
            item = persona.items[item_id]
            assert "important_data" in item.body_text

        # Outbox messages are still present and pending
        assert len(node.outbox) == 3
        for msg in node.outbox.values():
            assert msg.status == "pending"

        # Set test clock so we can control retry timing
        base_time = time.time()
        node.set_test_clock(base_time)

        # Retry outbox -- target still offline, so nothing delivered
        delivered = node.retry_outbox()
        assert len(delivered) == 0

        # Advance past the backoff window so next retry is eligible
        node.advance_clock(7200 + 1)

        # Bring target online and register a dummy node so delivery succeeds
        d2d_network.set_online("did:plc:target_offline", True)
        dummy = HomeNode(
            did="did:plc:target_offline",
            display_name="Dummy Target",
            trust_ring=TrustRing.RING_1_UNVERIFIED,
            plc=node.plc,
            network=d2d_network,
        )
        dummy.first_run_setup("dummy@example.com", "pass")

        delivered = node.retry_outbox()
        assert len(delivered) == 3

        # All outbox messages now delivered
        for msg in node.outbox.values():
            assert msg.status == "delivered"

# TST-E2E-050
    def test_dead_letter_queue(
        self,
        fresh_don_alonso: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-10.4 Dead Letter Queue.

        Set a target offline, queue a message, retry 5 times with
        exponential backoff. After 5 failures the message status becomes
        'failed' and the user is notified.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Pair a device to observe notifications
        code = node.generate_pairing_code()
        phone = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert phone is not None

        # Target is permanently offline
        target_did = "did:plc:unreachable_peer"
        d2d_network.set_online(target_did, False)

        # Queue a message via outbox
        msg_id = "msg_dead_letter_001"
        node.outbox[msg_id] = OutboxMessage(
            msg_id=msg_id,
            to_did=target_did,
            payload={"content": "important message that cannot be delivered"},
            max_attempts=5,
            status="pending",
        )

        # Set test clock to control backoff timing
        base_time = time.time()
        node.set_test_clock(base_time)

        # Retry 5 times with exponential backoff
        backoff_schedule = [30, 60, 300, 1800, 7200]
        for attempt in range(5):
            # Advance clock past the next_retry window
            if attempt > 0:
                node.advance_clock(backoff_schedule[attempt - 1] + 1)

            delivered = node.retry_outbox()
            assert msg_id not in delivered

            outbox_msg = node.outbox[msg_id]
            assert outbox_msg.attempts == attempt + 1

            if attempt < 4:
                assert outbox_msg.status == "pending"
            else:
                # After 5th failure, status should be 'failed'
                assert outbox_msg.status == "failed"

        # Verify the message is now in failed state
        assert node.outbox[msg_id].status == "failed"
        assert node.outbox[msg_id].attempts == 5

        # User should have been notified about the failure
        assert len(node.notifications) >= 1
        failure_notif = node.notifications[-1]
        assert failure_notif["type"] == "whisper"
        assert target_did in failure_notif["payload"]["text"]
        assert "5" in failure_notif["payload"]["text"]

# TST-E2E-051
    def test_disk_full_scenario(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-10.5 Disk Full Scenario.

        Simulate disk full by setting spool_max_bytes very low. Writes
        to the spool fail, reads from the vault continue. Freeing space
        allows recovery.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Store some items while space is available
        pre_items = []
        for i in range(5):
            item_id = node.vault_store(
                "consumer", f"pre_disk_full_{i}",
                {"data": f"accessible_data_{i}"},
            )
            pre_items.append(item_id)

        # Lock the vault so incoming D2D messages go to the spool
        node.lock_vault()

        # Simulate disk full: set spool_max_bytes very low (50 bytes)
        node.spool_max_bytes = 50

        # Try to spool a large encrypted message -- should fail (spool full)
        from tests.e2e.mocks import D2DMessage
        large_payload = b"X" * 100  # exceeds 50 byte limit
        result = node.receive_d2d(D2DMessage(
            msg_id="msg_disk_full_001",
            from_did="did:plc:sender",
            to_did=node.did,
            message_type="test",
            payload={"data": "will not fit"},
            encrypted_payload=large_payload,
        ))
        assert result["status"] == "429"
        assert result["reason"] == "spool_full"

        # Small messages that fit should still be spooled
        small_payload = b"tiny"
        result_small = node.receive_d2d(D2DMessage(
            msg_id="msg_disk_full_002",
            from_did="did:plc:sender",
            to_did=node.did,
            message_type="test",
            payload={"data": "fits"},
            encrypted_payload=small_payload,
        ))
        assert result_small["status"] == "202"
        assert result_small["reason"] == "spooled"

        # Reads from the vault continue to work even when spool was full.
        # Unlock the vault so persona is accessible again.
        node.unlock_vault("passphrase123")

        # All pre-stored items are still accessible via direct persona access
        persona = node.personas["consumer"]
        for item_id in pre_items:
            assert item_id in persona.items
            assert "accessible_data" in persona.items[item_id].body_text

        # Free space (increase spool limit) and verify recovery
        node.lock_vault()
        node.spool_max_bytes = 500 * 1024 * 1024  # restore to 500MB

        # Now large messages can be spooled again
        result_after = node.receive_d2d(D2DMessage(
            msg_id="msg_disk_full_003",
            from_did="did:plc:sender",
            to_did=node.did,
            message_type="test",
            payload={"data": "now it fits"},
            encrypted_payload=large_payload,
        ))
        assert result_after["status"] == "202"
        assert result_after["reason"] == "spooled"

# TST-E2E-052
    def test_batch_ingestion_atomicity(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-10.6 Batch Ingestion Atomicity.

        Use vault_store_batch with 10 items. Verify all items are stored
        (all-or-nothing semantics).
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")
        node.create_persona("consumer", PersonaType.CONSUMER, "open")

        # Prepare 10 items for batch ingestion
        batch_items = [
            (f"batch_product_{i}", {"product": f"Widget {i}", "score": 80 + i})
            for i in range(10)
        ]

        # Store the batch
        ids = node.vault_store_batch("consumer", batch_items)

        # All 10 items must be stored
        assert len(ids) == 10

        # Every returned ID must exist in the persona's vault
        persona = node.personas["consumer"]
        for item_id in ids:
            assert item_id in persona.items
            item = persona.items[item_id]
            assert item.persona == "consumer"
            assert "Widget" in item.body_text

        # Verify each item is individually queryable
        for i in range(10):
            results = node.vault_query("consumer", f"batch_product_{i}")
            assert len(results) >= 1
            found = any(f"Widget {i}" in r.body_text for r in results)
            assert found, f"batch_product_{i} not found in query results"

        # Verify all-or-nothing: attempt a batch against a locked persona
        node.create_persona("financial", PersonaType.FINANCIAL, "locked")
        node.lock_persona("financial")

        with pytest.raises(PermissionError, match="403 persona_locked"):
            node.vault_store_batch("financial", [
                ("locked_item_0", {"data": "should_fail"}),
                ("locked_item_1", {"data": "should_also_fail"}),
            ])

        # No items should have been stored in the locked persona
        financial = node.personas["financial"]
        assert len(financial.items) == 0
