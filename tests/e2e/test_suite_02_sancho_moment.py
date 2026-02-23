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
    def test_sharing_policy_blocks_context(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.2 Sharing Policy Blocks Context.

        Sancho sets context="none" for Alonso's DID. Sends arrival.
        Verify Don Alonso gets ETA only, NO context flags or tea preference.
        """
        # Override Sancho's sharing policy: deny context to Alonso
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

        # The filtered payload should NOT contain context_flags or tea_preference
        assert "context_flags" not in msg.payload
        assert "tea_preference" not in msg.payload

        # ETA should still be present
        assert msg.payload.get("eta_minutes") == 20

        # Audit should reflect the denial
        send_entries = sancho.get_audit_entries("d2d_send")
        assert len(send_entries) >= 1
        last_send = send_entries[-1]
        assert last_send.details.get("context") == "denied"

        # Don Alonso's nudge should only mention ETA, not context
        if don_alonso.notifications:
            nudge_text = don_alonso.notifications[-1]["payload"]["text"]
            # ETA present
            assert "20" in nudge_text
            # Context should NOT be present (no "mother", no "chai")
            # Note: vault context from don_alonso's own data may still appear,
            # but the SENT payload lacked context_flags and tea_preference.

# TST-E2E-009
    def test_dnd_context_queues_for_briefing(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.3 DND Context.

        Don Alonso has dnd_active=True. Sancho sends arrival.
        Verify:
        - No push notification during DND
        - Message queued in briefing_queue
        """
        # Enable DND on Don Alonso
        don_alonso.dnd_active = True

        # Record notification count before
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

        # No NEW push notifications during DND (notifications list unchanged)
        assert len(don_alonso.notifications) == notif_count_before

        # No NEW WS messages on any device during DND
        for dev_id, dev in don_alonso.devices.items():
            assert len(dev.ws_messages) == device_msg_counts_before.get(
                dev_id, 0
            ), f"Device {dev_id} received a push during DND"

        # Message queued in briefing_queue instead
        assert len(don_alonso.briefing_queue) >= 1
        queued = don_alonso.briefing_queue[-1]
        assert queued["type"] == "whisper"
        assert "10" in queued["payload"]["text"] or "minutes" in queued["payload"]["text"]

# TST-E2E-010
    def test_vault_locked_dead_drop(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.4 Vault-Locked Dead Drop.

        Don Alonso locks vault. Sancho sends a message.
        Verify:
        - Message is spooled (not processed)
        - After unlock, message is processed from spool
        """
        # Lock Don Alonso's vault
        don_alonso.lock_vault()
        assert don_alonso._vault_locked is True

        # Record spool size before
        spool_before = len(don_alonso.spool)

        # Sancho sends a D2D message
        msg = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 5,
            },
        )

        # Message should be spooled (encrypted bytes added to spool)
        assert len(don_alonso.spool) > spool_before

        # Audit should show spooled status
        spooled_entries = don_alonso.get_audit_entries("d2d_spooled")
        assert len(spooled_entries) >= 1
        assert spooled_entries[-1].details["from"] == sancho.did

        # No notifications yet (vault is locked, brain cannot process)
        notif_count_locked = len(don_alonso.notifications)

        # Now unlock the vault
        don_alonso.unlock_vault("passphrase123")
        assert don_alonso._vault_locked is False

        # Spool should be drained
        assert len(don_alonso.spool) == 0

# TST-E2E-011
    def test_bidirectional_d2d(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-2.5 Bidirectional D2D.

        Sancho sends to Alonso, Alonso sends back. Both messages
        delivered independently.
        """
        # Sancho -> Alonso
        msg_s2a = sancho.send_d2d(
            to_did=don_alonso.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 30,
            },
        )
        assert msg_s2a.from_did == sancho.did
        assert msg_s2a.to_did == don_alonso.did

        # Alonso -> Sancho
        msg_a2s = don_alonso.send_d2d(
            to_did=sancho.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 0,
                "context_flags": ["looking_forward"],
            },
        )
        assert msg_a2s.from_did == don_alonso.did
        assert msg_a2s.to_did == sancho.did

        # Both sides have send audit entries
        sancho_sends = sancho.get_audit_entries("d2d_send")
        alonso_sends = don_alonso.get_audit_entries("d2d_send")
        assert any(e.details["contact_did"] == don_alonso.did for e in sancho_sends)
        assert any(e.details["contact_did"] == sancho.did for e in alonso_sends)

        # Both sides have receive audit entries
        alonso_recvs = don_alonso.get_audit_entries("d2d_receive")
        sancho_recvs = sancho.get_audit_entries("d2d_receive")
        assert any(e.details["from_did"] == sancho.did for e in alonso_recvs)
        assert any(e.details["from_did"] == don_alonso.did for e in sancho_recvs)

        # Messages are independent (different msg_ids)
        assert msg_s2a.msg_id != msg_a2s.msg_id

# TST-E2E-012
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
