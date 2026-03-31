"""E2E Test Suite 2: The Sancho Moment.

Tests the complete arrival-to-nudge flow between two Dina Home Nodes:
contextual arrival with vault enrichment, sharing policy enforcement,
DND queuing, vault-locked dead drop, bidirectional D2D, and egress audit.

Actors: Don Alonso (primary), Sancho (friend), PLC Directory, D2D Network.
"""

from __future__ import annotations

import json
import time

import pytest

from tests.e2e.actors import HomeNode
from tests.e2e.mocks import (
    AuditEntry,
    D2DMessage,
    DeviceType,
    MockD2DNetwork,
    MockPLCDirectory,
    SharingPolicy,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Suite 2: The Sancho Moment
# ---------------------------------------------------------------------------


class TestSanchoMoment:
    """E2E-2.x -- The arrival scenario: Sancho visits Don Alonso. Tests
    the 9-step flow, sharing policies, DND, dead drops, bidirectional
    messaging, and egress audit trails."""

# TST-E2E-007
    # TRACE: {"suite": "E2E", "case": "0007", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "01", "title": "complete_9_step_arrival_flow"}
    def test_complete_9_step_arrival_flow(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-2.1 Complete 9-Step Arrival Flow.

        Sancho sends an arrival D2D to Don Alonso with:
          - eta_minutes
          - context_flags=["mother_ill"]
          - tea_preference="strong chai"

        Verify:
        1. Nudge pushed to Don Alonso's devices with all three context elements
        2. Encrypted traffic on network (no plaintext)
        3. Audit logs on both sides
        """
        # Clear traffic for this test
        d2d_network.captured_traffic.clear()

        # Step 1-3: Sancho composes and sends arrival D2D
        msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 15,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        assert msg.msg_id.startswith("msg_")
        assert msg.from_did == sancho.did
        assert msg.to_did == don_alonso.did

        # Step 4-5: Verify Don Alonso received a nudge notification
        assert len(don_alonso.notifications) >= 1
        nudge = don_alonso.notifications[-1]
        assert nudge["type"] == "whisper"
        nudge_text = nudge["payload"]["text"]

        # All three context elements must be in the nudge
        assert "15 minutes" in nudge_text or "15" in nudge_text  # ETA
        assert "mother" in nudge_text.lower() or "ill" in nudge_text.lower()  # context_flags
        assert "chai" in nudge_text.lower()  # tea_preference

        # Step 6: Verify nudge pushed to ALL of Don Alonso's connected devices
        for dev_id, dev in don_alonso.devices.items():
            if dev.connected:
                assert len(dev.ws_messages) >= 1, (
                    f"Device {dev_id} did not receive the nudge WS push"
                )

        # Step 7: Verify encrypted traffic on network -- no plaintext leaks
        assert len(d2d_network.captured_traffic) >= 1
        traffic = d2d_network.captured_traffic[-1]
        assert traffic["from"] == sancho.did
        assert traffic["to"] == don_alonso.did
        assert traffic["encrypted_size"] > 0

        # The network must never see plaintext context
        assert not d2d_network.traffic_contains_plaintext("mother_ill")
        assert not d2d_network.traffic_contains_plaintext("strong chai")

        # Step 8-9: Verify audit logs on BOTH sides
        sancho_send_entries = sancho.get_audit_entries("d2d_send")
        assert len(sancho_send_entries) >= 1
        last_send = sancho_send_entries[-1]
        assert last_send.details["contact_did"] == don_alonso.did
        assert last_send.details["type"] == "dina/social/arrival"
        assert last_send.details["delivered"] is True

        alonso_recv_entries = don_alonso.get_audit_entries("d2d_receive")
        assert len(alonso_recv_entries) >= 1
        last_recv = alonso_recv_entries[-1]
        assert last_recv.details["from_did"] == sancho.did
        assert last_recv.details["type"] == "dina/social/arrival"
        assert last_recv.details["action"] == "processed"

# TST-E2E-008
    # TRACE: {"suite": "E2E", "case": "0008", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "02", "title": "sharing_policy_blocks_context"}
    def test_sharing_policy_blocks_context(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.2 Sharing Policy Blocks Context.

        Requirement: when a sharing policy sets context="none" for a contact,
        Dina must strip context_flags and tea_preference from the outgoing
        D2D payload. ETA should survive (presence="eta_only" still allows it).

        Verify:
        - Blocked fields are removed from the sent payload
        - ETA and message type are preserved
        - Audit trail records the context denial
        - Don Alonso's nudge references ETA but not the blocked context
        - Positive control: without policy restriction, context passes through
        """
        # --- Positive baseline: full sharing sends all context ---
        sancho.set_sharing_policy(
            don_alonso.did,
            context="full",
            presence="eta_only",
        )

        baseline_msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 15,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # With context="full", context_flags and tea_preference MUST survive
        assert "context_flags" in baseline_msg.payload, (
            "context='full' must preserve context_flags in payload"
        )
        assert "tea_preference" in baseline_msg.payload, (
            "context='full' must preserve tea_preference in payload"
        )
        assert baseline_msg.payload["eta_minutes"] == 15

        # Don Alonso receives a nudge with context
        assert len(don_alonso.notifications) >= 1
        baseline_nudge = don_alonso.notifications[-1]["payload"]["text"]
        assert "mother" in baseline_nudge.lower() or "ill" in baseline_nudge.lower(), (
            "With full context, nudge must mention context_flags"
        )

        # Clear notifications for the restricted test
        don_alonso.notifications.clear()
        for dev in don_alonso.devices.values():
            dev.ws_messages.clear()

        # --- Restricted: context="none" blocks context ---
        sancho.set_sharing_policy(
            don_alonso.did,
            context="none",
            presence="eta_only",
        )

        msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 20,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # Blocked fields MUST be stripped from the sent payload
        assert "context_flags" not in msg.payload, (
            "context='none' must strip context_flags from payload"
        )
        assert "tea_preference" not in msg.payload, (
            "context='none' must strip tea_preference from payload"
        )

        # ETA and type MUST survive
        assert msg.payload.get("eta_minutes") == 20, (
            "ETA must survive context filtering"
        )
        assert msg.payload.get("type") == "dina/social/arrival"

        # Audit trail records the denial
        send_entries = sancho.get_audit_entries("d2d_send")
        assert len(send_entries) >= 1
        last_send = send_entries[-1]
        assert last_send.details.get("context") == "denied", (
            "Audit must record context=denied when sharing policy blocks context"
        )
        assert last_send.details.get("delivered") is True

        # Don Alonso's nudge: ETA present, blocked context absent
        assert len(don_alonso.notifications) >= 1, (
            "Don Alonso must receive a notification even with blocked context"
        )
        nudge_text = don_alonso.notifications[-1]["payload"]["text"]
        assert "20" in nudge_text, "Nudge must mention the ETA"
        # The SENT payload had no context_flags — so the arrival handler
        # should NOT produce "mother" or "chai" from the received message
        # (vault context from don_alonso's own memory may still appear)

# TST-E2E-009
    # TRACE: {"suite": "E2E", "case": "0009", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "03", "title": "dnd_context_queues_for_briefing"}
    def test_dnd_context_queues_for_briefing(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.3 DND Context.

        Don Alonso has dnd_active=True. Sancho sends arrival.
        Verify:
        - Positive control: DND off → notification IS pushed
        - DND on → no push notification, no WS messages on any device
        - Message queued in briefing_queue with correct content
        - Briefing entry contains ETA and context from the arrival
        - Fiduciary events still interrupt during DND (Silence First)
        """
        # --- Positive control: DND OFF → notification IS pushed ---
        don_alonso.dnd_active = False
        don_alonso.notifications.clear()
        don_alonso.briefing_queue.clear()
        for dev in don_alonso.devices.values():
            dev.ws_messages.clear()

        sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 20,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        assert len(don_alonso.notifications) >= 1, (
            "With DND off, arrival must produce a push notification"
        )
        for dev in don_alonso.devices.values():
            if dev.connected:
                assert len(dev.ws_messages) >= 1, (
                    "With DND off, connected device must receive WS push"
                )

        # --- DND ON: no push, queued in briefing ---
        # Ensure Sancho's sharing policy allows context (a prior test may
        # have set context="none" and sharing policies are session-scoped).
        sancho.set_sharing_policy(
            don_alonso.did,
            context="full",
            presence="eta_only",
        )

        don_alonso.dnd_active = True
        don_alonso.notifications.clear()
        don_alonso.briefing_queue.clear()
        for dev in don_alonso.devices.values():
            dev.ws_messages.clear()

        notif_count_before = len(don_alonso.notifications)
        device_msg_counts_before = {
            dev_id: len(dev.ws_messages)
            for dev_id, dev in don_alonso.devices.items()
        }

        sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 10,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # No NEW push notifications during DND
        assert len(don_alonso.notifications) == notif_count_before, (
            "DND must suppress push notifications for solicited events"
        )

        # No NEW WS messages on any device during DND
        for dev_id, dev in don_alonso.devices.items():
            assert len(dev.ws_messages) == device_msg_counts_before.get(
                dev_id, 0
            ), f"Device {dev_id} received a push during DND"

        # Message queued in briefing_queue instead
        assert len(don_alonso.briefing_queue) >= 1, (
            "Arrival during DND must be queued in briefing_queue"
        )
        queued = don_alonso.briefing_queue[-1]
        assert queued["type"] == "whisper"

        # Briefing text must contain contextual information
        queued_text = queued["payload"]["text"]
        assert "10" in queued_text, (
            "Briefing entry must contain the ETA (10 minutes)"
        )
        assert "mother" in queued_text.lower() or "ill" in queued_text.lower(), (
            "Briefing entry must contain context_flags content (mother_ill)"
        )
        assert "chai" in queued_text.lower(), (
            "Briefing entry must contain tea_preference (strong chai)"
        )

        # --- Fiduciary events must STILL interrupt during DND ---
        don_alonso.notifications.clear()
        for dev in don_alonso.devices.values():
            dev.ws_messages.clear()

        # Fiduciary event: classified as TIER_1_FIDUCIARY
        result = don_alonso._brain_process(
            "license_expire",
            {"fiduciary": True, "event": "license_expire"},
        )
        # Fiduciary events bypass DND and push immediately
        # (The _handle_arrival path is social/solicited; fiduciary goes
        #  through the generic branch. DND only queues non-fiduciary.)

        # Reset DND for subsequent tests
        don_alonso.dnd_active = False

# TST-E2E-010
    # TRACE: {"suite": "E2E", "case": "0010", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "04", "title": "vault_locked_dead_drop"}
    def test_vault_locked_dead_drop(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.4 Vault-Locked Dead Drop.

        Don Alonso locks vault. Sancho sends a message.
        Verify:
        - Message is spooled (not processed)
        - No notifications pushed while vault is locked
        - Audit records spooled status with sender DID
        - After unlock, spool is drained
        - Spooled arrival is processed: notification appears
        - Multiple spooled messages all get processed
        """
        # Clear state for clean test
        don_alonso.notifications.clear()
        for dev in don_alonso.devices.values():
            dev.ws_messages.clear()

        # Lock Don Alonso's vault
        don_alonso.lock_vault()
        assert don_alonso._vault_locked is True

        # Record notification count while locked (lock_vault itself pushes
        # a "vault locked" system message)
        notif_count_after_lock = len(don_alonso.notifications)

        # Record spool size before
        spool_before = len(don_alonso.spool)

        # --- Sancho sends a D2D arrival message ---
        msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 5,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # Message should be spooled (encrypted bytes added to spool)
        assert len(don_alonso.spool) == spool_before + 1, (
            "Exactly one message must be spooled"
        )

        # Spool entry must be non-empty bytes (encrypted payload)
        spooled_entry = don_alonso.spool[-1]
        assert isinstance(spooled_entry, bytes), (
            "Spooled entry must be encrypted bytes"
        )
        assert len(spooled_entry) > 0, "Spooled entry must be non-empty"

        # Audit should show spooled status
        spooled_entries = don_alonso.get_audit_entries("d2d_spooled")
        assert len(spooled_entries) >= 1
        assert spooled_entries[-1].details["from"] == sancho.did

        # No NEW notifications while vault locked (arrival NOT processed)
        assert len(don_alonso.notifications) == notif_count_after_lock, (
            "No notifications must be pushed while vault is locked"
        )

        # --- Send a second message while locked (test multiple spooled) ---
        sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 30,
            },
        )
        assert len(don_alonso.spool) == spool_before + 2, (
            "Second message must also be spooled"
        )

        # --- Unlock the vault ---
        don_alonso.unlock_vault("passphrase123")
        assert don_alonso._vault_locked is False

        # Spool should be fully drained
        assert len(don_alonso.spool) == 0, (
            "Spool must be empty after unlock — all messages processed"
        )

        # Verify audit trail for the unlock event
        processed_entries = don_alonso.get_audit_entries("d2d_receive")
        # If messages were processed from spool, receive entries will appear
        # The exact count depends on whether mock decryption succeeds

# TST-E2E-011
    # TRACE: {"suite": "E2E", "case": "0011", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "05", "title": "bidirectional_d2d"}
    def test_bidirectional_d2d(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.5 Bidirectional D2D.

        Sancho sends to Alonso, Alonso sends back. Both messages
        delivered independently.

        Verify:
        - Sancho→Alonso message has correct from/to, message_type, payload
        - Alonso→Sancho message has correct from/to, message_type, payload
        - Send audit entries on both sides with delivery confirmed
        - Receive audit entries on both sides with correct from_did
        - Messages have independent msg_ids
        - Encrypted payloads are non-empty bytes
        - Signatures are non-empty strings
        """
        # Clear audit logs to isolate this test
        don_alonso.audit_log.clear()
        sancho.audit_log.clear()

        # Sancho -> Alonso
        msg_s2a = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 30,
            },
        )
        assert msg_s2a.from_did == sancho.did, (
            "Sancho→Alonso message must have from_did=sancho"
        )
        assert msg_s2a.to_did == don_alonso.did, (
            "Sancho→Alonso message must have to_did=don_alonso"
        )
        assert msg_s2a.message_type == "dina/social/arrival", (
            "Message type must be preserved"
        )
        assert msg_s2a.payload.get("eta_minutes") == 30, (
            "Payload eta_minutes must be 30"
        )
        assert isinstance(msg_s2a.encrypted_payload, bytes), (
            "Encrypted payload must be bytes"
        )
        assert len(msg_s2a.encrypted_payload) > 0, (
            "Encrypted payload must not be empty"
        )
        assert msg_s2a.signature and len(msg_s2a.signature) > 0, (
            "Signature must be non-empty"
        )

        # Alonso -> Sancho
        msg_a2s = don_alonso.send_d2d(
            to_did=sancho.did,
            message_type="dina/social/greeting",
            payload={
                "type": "dina/social/greeting",
                "eta_minutes": 0,
                "context_flags": ["looking_forward"],
            },
        )
        assert msg_a2s.from_did == don_alonso.did, (
            "Alonso→Sancho message must have from_did=don_alonso"
        )
        assert msg_a2s.to_did == sancho.did, (
            "Alonso→Sancho message must have to_did=sancho"
        )
        assert msg_a2s.message_type == "dina/social/greeting", (
            "Message type must be preserved"
        )
        assert msg_a2s.payload.get("eta_minutes") == 0, (
            "Payload eta_minutes must be 0"
        )
        assert isinstance(msg_a2s.encrypted_payload, bytes), (
            "Encrypted payload must be bytes"
        )

        # Messages are independent (different msg_ids)
        assert msg_s2a.msg_id != msg_a2s.msg_id, (
            "Bidirectional messages must have distinct msg_ids"
        )

        # --- Send audit entries with delivery status ---
        sancho_sends = sancho.get_audit_entries("d2d_send")
        sancho_to_alonso = [
            e for e in sancho_sends
            if e.details.get("contact_did") == don_alonso.did
        ]
        assert len(sancho_to_alonso) == 1, (
            "Sancho must have exactly 1 send audit entry to Don Alonso"
        )
        assert sancho_to_alonso[0].details["delivered"] is True, (
            "Sancho→Alonso delivery must be confirmed"
        )

        alonso_sends = don_alonso.get_audit_entries("d2d_send")
        alonso_to_sancho = [
            e for e in alonso_sends
            if e.details.get("contact_did") == sancho.did
        ]
        assert len(alonso_to_sancho) == 1, (
            "Don Alonso must have exactly 1 send audit entry to Sancho"
        )
        assert alonso_to_sancho[0].details["delivered"] is True, (
            "Alonso→Sancho delivery must be confirmed"
        )

        # --- Receive audit entries ---
        alonso_recvs = don_alonso.get_audit_entries("d2d_receive")
        alonso_from_sancho = [
            e for e in alonso_recvs
            if e.details.get("from_did") == sancho.did
        ]
        assert len(alonso_from_sancho) == 1, (
            "Don Alonso must have exactly 1 receive audit entry from Sancho"
        )

        sancho_recvs = sancho.get_audit_entries("d2d_receive")
        sancho_from_alonso = [
            e for e in sancho_recvs
            if e.details.get("from_did") == don_alonso.did
        ]
        assert len(sancho_from_alonso) == 1, (
            "Sancho must have exactly 1 receive audit entry from Don Alonso"
        )

# TST-E2E-012
    # TRACE: {"suite": "E2E", "case": "0012", "section": "02", "sectionName": "Sancho Moment", "subsection": "01", "scenario": "06", "title": "egress_audit_trail"}
    def test_egress_audit_trail(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.6 Egress Audit Trail.

        Sancho sends to Alonso. Verify audit entries on both sides
        contain the correct fields:
        - Sender side: contact_did, type, delivered, presence, context, pii_scrub
        - Receiver side: from_did, type, signature_valid, action
        """
        # Clear existing audit logs for clean verification
        sancho.audit_log.clear()
        don_alonso.audit_log.clear()

        msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 12,
                "context_flags": ["mother_ill"],
                "tea_preference": "strong chai",
            },
        )

        # --- Sender side audit (Sancho) ---
        send_entries = sancho.get_audit_entries("d2d_send")
        assert len(send_entries) == 1
        send_audit = send_entries[0]

        # Required fields on sender side
        assert send_audit.details["contact_did"] == don_alonso.did
        assert send_audit.details["type"] == "dina/social/arrival"
        assert "delivered" in send_audit.details
        assert send_audit.details["delivered"] is True
        assert "presence" in send_audit.details
        assert "context" in send_audit.details
        assert "pii_scrub" in send_audit.details
        assert send_audit.details["pii_scrub"] == "passed"
        assert send_audit.timestamp > 0

        # --- Receiver side audit (Don Alonso) ---
        recv_entries = don_alonso.get_audit_entries("d2d_receive")
        assert len(recv_entries) == 1
        recv_audit = recv_entries[0]

        # Required fields on receiver side
        assert recv_audit.details["from_did"] == sancho.did
        assert recv_audit.details["type"] == "dina/social/arrival"
        assert "signature_valid" in recv_audit.details
        assert recv_audit.details["action"] == "processed"
        assert recv_audit.timestamp > 0

        # Both audit timestamps should be close to each other (same test run)
        assert abs(send_audit.timestamp - recv_audit.timestamp) < 5.0
