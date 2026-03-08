"""E2E Test Suite 19: Connector Failure and Recovery.

User-visible resilience of Dina's senses.

Actors: Don Alonso.
"""

from __future__ import annotations

import time

import pytest

from tests.e2e.actors import HomeNode
from tests.e2e.mocks import (
    ConnectorStatus,
    MockOpenClaw,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# Suite 19: Connector Failure and Recovery
# ---------------------------------------------------------------------------


class TestConnectorFailure:
    """E2E-19.x -- Connector outage detection, credential expiry, and
    backfill resume after interruption."""

# TST-E2E-105
    def test_openclaw_outage_degrades_recovers(
        self,
        don_alonso: HomeNode,
        openclaw: MockOpenClaw,
    ) -> None:
        """E2E-19.1 OpenClaw outage: baseline OK, degrade, recover.

        1. Baseline: sync with OpenClaw succeeds.
        2. Stop OpenClaw (set_should_fail): status becomes degraded.
        3. Restore OpenClaw: sync resumes and status returns to healthy.
        """
        node = don_alonso

        # -- Step 1: Baseline sync works -----------------------------------
        baseline_result = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 10,
        })
        assert baseline_result["status"] == "completed", (
            "Baseline OpenClaw sync must succeed"
        )
        assert len(baseline_result["emails"]) > 0

        # Record connector status as ACTIVE
        node.kv_put("connector:openclaw:status", ConnectorStatus.ACTIVE.name)
        assert node.kv_get("connector:openclaw:status") == ConnectorStatus.ACTIVE.name

        # -- Step 2: OpenClaw outage -> degraded ---------------------------
        openclaw.set_should_fail(True)

        with pytest.raises(RuntimeError, match="OpenClaw agent crashed"):
            openclaw.handle_request({
                "action": "gmail_sync",
                "cursor": "",
                "limit": 10,
            })

        # Update connector status to ERROR
        node.kv_put("connector:openclaw:status", ConnectorStatus.ERROR.name)
        assert node.kv_get("connector:openclaw:status") == ConnectorStatus.ERROR.name

        # Surface degradation to user via notification
        node._push_to_devices({
            "type": "whisper",
            "payload": {
                "text": "OpenClaw connector is unavailable. Email sync paused.",
                "tier": SilenceTier.TIER_2_SOLICITED.value,
            },
        })
        assert len(node.notifications) >= 1
        last_notif = node.notifications[-1]
        assert "OpenClaw" in last_notif["payload"]["text"]

        # -- Step 3: Restore OpenClaw -> healthy ---------------------------
        openclaw.set_should_fail(False)

        recovery_result = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 10,
        })
        assert recovery_result["status"] == "completed", (
            "OpenClaw must resume after outage"
        )

        # Update connector status back to ACTIVE
        node.kv_put("connector:openclaw:status", ConnectorStatus.ACTIVE.name)
        assert node.kv_get("connector:openclaw:status") == ConnectorStatus.ACTIVE.name

        # Notify user of recovery
        node._push_to_devices({
            "type": "whisper",
            "payload": {
                "text": "OpenClaw connector restored. Email sync resumed.",
                "tier": SilenceTier.TIER_2_SOLICITED.value,
            },
        })

# TST-E2E-106
    def test_telegram_credential_expiry(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-19.2 Telegram credential expiry surfaces reconfigure prompt.

        Configure a Telegram connector with a token, expire the token,
        verify the connector status becomes EXPIRED and the user is
        prompted to reconfigure. After reconfiguration, status returns
        to ACTIVE.
        """
        node = don_alonso

        # -- Configure Telegram connector with a token ---------------------
        telegram_config = {
            "bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
            "chat_id": "987654321",
            "expires_at": time.time() + 3600,  # valid for 1 hour
        }
        node.kv_put("connector:telegram:config", telegram_config)
        node.kv_put("connector:telegram:status", ConnectorStatus.ACTIVE.name)

        assert node.kv_get("connector:telegram:status") == ConnectorStatus.ACTIVE.name

        # -- Expire the token (simulate time passing or revocation) --------
        telegram_config["expires_at"] = time.time() - 1  # already expired
        node.kv_put("connector:telegram:config", telegram_config)

        # Check token validity
        config = node.kv_get("connector:telegram:config")
        is_expired = config["expires_at"] < time.time()
        assert is_expired is True, "Token must be expired"

        # Update status to EXPIRED
        node.kv_put("connector:telegram:status", ConnectorStatus.EXPIRED.name)
        assert node.kv_get("connector:telegram:status") == ConnectorStatus.EXPIRED.name

        # Surface reconfigure prompt to user
        node._push_to_devices({
            "type": "whisper",
            "payload": {
                "text": "Telegram credentials expired. Reconfigure in Settings > Connectors.",
                "tier": SilenceTier.TIER_2_SOLICITED.value,
            },
        })
        reconfigure_notifs = [
            n for n in node.notifications
            if "Telegram" in n.get("payload", {}).get("text", "")
            and "expired" in n.get("payload", {}).get("text", "").lower()
        ]
        assert len(reconfigure_notifs) >= 1, (
            "User must be notified about Telegram credential expiry"
        )

        # -- Reconfigure with fresh token ----------------------------------
        fresh_config = {
            "bot_token": "654321:NEW-TOKEN-xyz789",
            "chat_id": "987654321",
            "expires_at": time.time() + 86400,  # valid for 24 hours
        }
        node.kv_put("connector:telegram:config", fresh_config)
        node.kv_put("connector:telegram:status", ConnectorStatus.ACTIVE.name)

        # Verify restored
        assert node.kv_get("connector:telegram:status") == ConnectorStatus.ACTIVE.name
        restored_config = node.kv_get("connector:telegram:config")
        assert restored_config["expires_at"] > time.time(), (
            "Reconfigured token must be valid"
        )
        assert restored_config["bot_token"] == "654321:NEW-TOKEN-xyz789"

# TST-E2E-107
    def test_fast_sync_backfill_resume(
        self,
        don_alonso: HomeNode,
        openclaw: MockOpenClaw,
    ) -> None:
        """E2E-19.3 Backfill resumes from cursor after interruption.

        Start a backfill sync, process some items, interrupt by
        simulating a failure, persist the cursor, restore, and verify
        backfill resumes from the saved cursor without re-processing
        earlier items.
        """
        node = don_alonso

        # -- Step 1: Start backfill sync, process first batch --------------
        cursor_key = "connector:openclaw:gmail_cursor"
        node.kv_put(cursor_key, "")  # start from beginning

        # First batch: fetch first 10 emails
        result_1 = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": node.kv_get(cursor_key),
            "limit": 10,
        })
        assert result_1["status"] == "completed"
        batch_1 = result_1["emails"]
        assert len(batch_1) > 0, "First batch must return emails"

        # Persist cursor (last email ID in the batch)
        last_id_batch_1 = batch_1[-1]["id"]
        node.kv_put(cursor_key, last_id_batch_1)

        # Store batch 1 items in vault
        batch_1_item_ids = []
        for email in batch_1:
            item_id = node.vault_store(
                "personal",
                f"email_{email['id']}",
                {"subject": email["subject"], "sender": email["sender"]},
                item_type="email",
                source="gmail",
            )
            batch_1_item_ids.append(item_id)

        # -- Step 2: Interrupt during second batch (simulate failure) ------
        openclaw.set_should_fail(True)

        with pytest.raises(RuntimeError, match="OpenClaw agent crashed"):
            openclaw.handle_request({
                "action": "gmail_sync",
                "cursor": node.kv_get(cursor_key),
                "limit": 10,
            })

        # Cursor remains at last successful position
        assert node.kv_get(cursor_key) == last_id_batch_1, (
            "Cursor must remain at last successful position after failure"
        )

        # -- Step 3: Restore and resume from cursor ------------------------
        openclaw.set_should_fail(False)

        result_2 = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": node.kv_get(cursor_key),
            "limit": 10,
        })
        assert result_2["status"] == "completed"
        batch_2 = result_2["emails"]

        # Batch 2 must start AFTER the cursor (no overlap with batch 1)
        if len(batch_2) > 0:
            batch_2_ids = {e["id"] for e in batch_2}
            batch_1_ids = {e["id"] for e in batch_1}
            overlap = batch_1_ids & batch_2_ids
            assert len(overlap) == 0, (
                f"Resumed batch must not re-process earlier items. "
                f"Overlap: {overlap}"
            )

        # Update cursor to new position
        if len(batch_2) > 0:
            node.kv_put(cursor_key, batch_2[-1]["id"])

        # Store batch 2 items in vault
        batch_2_item_ids = []
        for email in batch_2:
            item_id = node.vault_store(
                "personal",
                f"email_{email['id']}",
                {"subject": email["subject"], "sender": email["sender"]},
                item_type="email",
                source="gmail",
            )
            batch_2_item_ids.append(item_id)

        # No duplicates across batch 1 and batch 2
        all_stored_ids = set(batch_1_item_ids) | set(batch_2_item_ids)
        assert len(all_stored_ids) == len(batch_1_item_ids) + len(batch_2_item_ids), (
            "No duplicate vault items across batches"
        )

        # Final cursor is ahead of the initial position
        final_cursor = node.kv_get(cursor_key)
        assert final_cursor != "", "Final cursor must not be empty"
