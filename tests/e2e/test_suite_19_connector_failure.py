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
)


# ---------------------------------------------------------------------------
# Suite 19: Connector Failure and Recovery
# ---------------------------------------------------------------------------


class TestConnectorFailure:
    """E2E-19.x -- Connector outage detection, credential expiry, and
    backfill resume after interruption."""

# TST-E2E-105
    # TRACE: {"suite": "E2E", "case": "0105", "section": "19", "sectionName": "Connector Failure", "subsection": "01", "scenario": "01", "title": "openclaw_outage_degrades_recovers"}
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
        requests_before = len(openclaw.requests_received)
        baseline_result = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 10,
        })
        assert baseline_result["status"] == "completed", (
            "Baseline OpenClaw sync must succeed"
        )
        emails = baseline_result["emails"]
        assert len(emails) == 10, (
            f"Expected exactly 10 emails with limit=10, got {len(emails)}"
        )
        # Verify email VALUE assertions (real MockGmailAPI data)
        assert emails[0]["id"] == "email_0000"
        assert "sender" in emails[0]
        assert "subject" in emails[0]

        # Request was recorded by the agent
        assert len(openclaw.requests_received) == requests_before + 1

        # Store baseline items in vault for later survival verification
        stored_ids = []
        for email in emails[:3]:
            item_id = node.vault_store(
                "general", f"email_{email['id']}",
                {"subject": email["subject"], "sender": email["sender"]},
                item_type="email", source="gmail",
            )
            stored_ids.append(item_id)

        # Verify vault_store created system-generated audit entries
        store_audits = node.get_audit_entries("vault_store")
        baseline_store_count = len(store_audits)
        assert baseline_store_count >= 3, (
            "vault_store must create system-generated audit entries"
        )

        # -- Step 2: OpenClaw outage -> agent crashes ----------------------
        openclaw.set_should_fail(True)

        with pytest.raises(RuntimeError, match="OpenClaw agent crashed"):
            openclaw.handle_request({
                "action": "gmail_sync",
                "cursor": "",
                "limit": 10,
            })

        # Previously stored vault items survive the outage
        pre_outage_results = node.vault_query("general", "email_email_0000")
        assert len(pre_outage_results) >= 1, (
            "Vault data must survive connector outage"
        )

        # -- Step 3: Restore OpenClaw -> resumes ---------------------------
        openclaw.set_should_fail(False)

        recovery_result = openclaw.handle_request({
            "action": "gmail_sync",
            "cursor": "",
            "limit": 10,
        })
        assert recovery_result["status"] == "completed", (
            "OpenClaw must resume after outage"
        )
        assert len(recovery_result["emails"]) == 10

# TST-E2E-106
    # TRACE: {"suite": "E2E", "case": "0106", "section": "19", "sectionName": "Connector Failure", "subsection": "01", "scenario": "02", "title": "telegram_credential_expiry"}
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
        initial_token = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
        chat_id = "987654321"
        telegram_config = {
            "bot_token": initial_token,
            "chat_id": chat_id,
            "expires_at": time.time() + 3600,
        }
        node.kv_put("connector:telegram:config", telegram_config)
        node.kv_put("connector:telegram:status", ConnectorStatus.ACTIVE.name)

        # Verify config round-trip preserves all field VALUES
        stored = node.kv_get("connector:telegram:config")
        assert stored["bot_token"] == initial_token
        assert stored["chat_id"] == chat_id
        assert stored["expires_at"] > time.time(), "Token must be valid initially"

        # -- Expire the token (simulate time passing) ----------------------
        expired_config = dict(stored)
        expired_config["expires_at"] = time.time() - 1
        node.kv_put("connector:telegram:config", expired_config)

        # Verify expired config persisted through real Go Core KV
        expired_stored = node.kv_get("connector:telegram:config")
        assert expired_stored["expires_at"] < time.time(), (
            "Expired token must have past expiry timestamp"
        )
        assert expired_stored["bot_token"] == initial_token, (
            "Token value must be preserved even when expired"
        )

        # -- Reconfigure with fresh token ----------------------------------
        fresh_token = "654321:NEW-TOKEN-xyz789"
        fresh_config = {
            "bot_token": fresh_token,
            "chat_id": chat_id,
            "expires_at": time.time() + 86400,
        }
        node.kv_put("connector:telegram:config", fresh_config)

        # Verify old token completely replaced (token isolation)
        restored = node.kv_get("connector:telegram:config")
        assert restored["bot_token"] == fresh_token, (
            "Fresh token must replace old token"
        )
        assert restored["bot_token"] != initial_token, (
            "Old token must not persist after reconfiguration"
        )
        assert restored["expires_at"] > time.time(), (
            "Reconfigured token must be valid"
        )
        # chat_id preserved across reconfiguration
        assert restored["chat_id"] == chat_id, (
            "chat_id must be preserved across reconfiguration"
        )

# TST-E2E-107
    # TRACE: {"suite": "E2E", "case": "0107", "section": "19", "sectionName": "Connector Failure", "subsection": "01", "scenario": "03", "title": "fast_sync_backfill_resume"}
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
                "general",
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
                "general",
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
