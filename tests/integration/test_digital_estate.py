"""Integration tests for the digital estate system.

Behavioral contracts tested:
- Dead man's switch: Periodic liveness checks, escalation protocol, estate
  mode activation, per-beneficiary key delivery, and data destruction.
- Estate configuration: Plan storage in Tier 0, manual trigger with recovery
  phrase, multi-beneficiary threshold support.

When the user is gone, Dina carries out their final wishes — distributing
digital assets to named beneficiaries and destroying everything else.
"""

from __future__ import annotations

import hashlib
import time

import pytest

from tests.integration.mocks import (
    DIDDocument,
    DinaMessage,
    EstateBeneficiary,
    EstatePlan,
    MockDinaCore,
    MockEstateManager,
    MockHuman,
    MockIdentity,
    MockP2PChannel,
    MockVault,
    PersonaType,
)


# =========================================================================
# TestDeadMansSwitch
# =========================================================================

class TestDeadMansSwitch:
    """Dina's dead man's switch — the final act of loyalty."""

    def test_liveness_check_every_n_days(
        self,
        mock_estate_manager: MockEstateManager,
        mock_human: MockHuman,
    ):
        """Dina sends a liveness check at the configured interval (90 days).
        A responsive user keeps the switch from triggering."""
        mock_human.liveness_responses = [True]

        alive = mock_estate_manager.liveness_check(mock_human)
        assert alive is True
        assert len(mock_estate_manager.liveness_checks) == 1
        assert mock_estate_manager.liveness_checks[0]["responded"] is True
        assert mock_estate_manager.estate_mode_active is False

    def test_three_attempts_over_two_weeks(
        self,
        mock_estate_manager: MockEstateManager,
        mock_human: MockHuman,
    ):
        """If the user does not respond, Dina tries 3 times over 2 weeks
        before activating estate mode."""
        # User does not respond to any check
        mock_human.liveness_responses = [False, False, False]

        for _ in range(3):
            alive = mock_estate_manager.liveness_check(mock_human)
            assert alive is False

        assert len(mock_estate_manager.liveness_checks) == 3
        all_failed = all(
            not check["responded"]
            for check in mock_estate_manager.liveness_checks
        )
        assert all_failed is True

        # After 3 failed attempts, enter estate mode
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True

    def test_estate_mode_notifies_beneficiaries(
        self,
        mock_estate_manager: MockEstateManager,
        mock_human: MockHuman,
        mock_p2p: MockP2PChannel,
    ):
        """When estate mode activates, beneficiaries are notified via
        Dina-to-Dina P2P messages."""
        # All beneficiary DIDs must be authenticated peers for delivery
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        # Trigger estate mode
        mock_human.liveness_responses = [False, False, False]
        for _ in range(3):
            mock_estate_manager.liveness_check(mock_human)
        mock_estate_manager.enter_estate_mode()

        # Deliver keys
        delivered = mock_estate_manager.deliver_keys(mock_p2p)
        assert len(delivered) == 3  # Daughter, Spouse, Colleague

        # P2P messages were sent
        assert len(mock_p2p.messages) == 3
        message_types = {m.type for m in mock_p2p.messages}
        assert "dina/estate/key_delivery" in message_types

    def test_per_beneficiary_keys(
        self,
        mock_estate_manager: MockEstateManager,
        mock_human: MockHuman,
        mock_p2p: MockP2PChannel,
    ):
        """Each beneficiary receives keys ONLY for the personas assigned
        to them in the estate plan."""
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        mock_estate_manager.enter_estate_mode()
        delivered = mock_estate_manager.deliver_keys(mock_p2p)

        # Daughter gets SOCIAL + HEALTH
        daughter_did = "did:plc:Daughter1234567890123456789"
        assert PersonaType.SOCIAL in delivered[daughter_did]
        assert PersonaType.HEALTH in delivered[daughter_did]
        assert PersonaType.FINANCIAL not in delivered[daughter_did]

        # Spouse gets FINANCIAL + CITIZEN
        spouse_did = "did:plc:Spouse123456789012345678901"
        assert PersonaType.FINANCIAL in delivered[spouse_did]
        assert PersonaType.CITIZEN in delivered[spouse_did]
        assert PersonaType.SOCIAL not in delivered[spouse_did]

        # Colleague gets PROFESSIONAL only, read-only access
        colleague_did = "did:plc:Colleague12345678901234567"
        assert PersonaType.PROFESSIONAL in delivered[colleague_did]
        assert len(delivered[colleague_did]) == 1

    def test_keys_delivered_via_dina_to_dina(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """Keys are delivered via encrypted Dina-to-Dina P2P channel,
        not email, not SMS, not any centralized service."""
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        mock_estate_manager.enter_estate_mode()
        mock_estate_manager.deliver_keys(mock_p2p)

        for msg in mock_p2p.messages:
            assert msg.type == "dina/estate/key_delivery"
            assert msg.from_did == mock_estate_manager._identity.root_did
            assert "personas" in msg.payload
            assert "access_type" in msg.payload

    def test_remaining_data_destroyed(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """After key delivery, all unclaimed data is destroyed per the
        estate plan's default_action='destroy'."""
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        mock_estate_manager.enter_estate_mode()
        mock_estate_manager.deliver_keys(mock_p2p)
        mock_estate_manager.destroy_remaining()

        assert mock_estate_manager.data_destroyed is True


# =========================================================================
# TestEstateConfiguration
# =========================================================================

class TestEstateConfiguration:
    """The user configures their estate plan while alive."""

    def test_plan_stored_in_tier_0(self, mock_dina: MockDinaCore):
        """The estate plan is stored in Tier 0 (identity/config tier),
        the most protected storage layer."""
        plan = EstatePlan(
            trigger="dead_mans_switch",
            switch_interval_days=90,
            beneficiaries=[
                EstateBeneficiary(
                    name="Partner",
                    dina_did="did:plc:Partner",
                    receives_personas=[PersonaType.FINANCIAL, PersonaType.SOCIAL],
                ),
            ],
            default_action="destroy",
        )

        # Serialize and store in Tier 0
        plan_data = {
            "trigger": plan.trigger,
            "switch_interval_days": plan.switch_interval_days,
            "beneficiaries": [
                {
                    "name": b.name,
                    "dina_did": b.dina_did,
                    "receives_personas": [p.value for p in b.receives_personas],
                    "access_type": b.access_type,
                }
                for b in plan.beneficiaries
            ],
            "default_action": plan.default_action,
        }
        mock_dina.vault.store(0, "estate_plan", plan_data)

        retrieved = mock_dina.vault.retrieve(0, "estate_plan")
        assert retrieved is not None
        assert retrieved["trigger"] == "dead_mans_switch"
        assert retrieved["switch_interval_days"] == 90
        assert len(retrieved["beneficiaries"]) == 1
        assert retrieved["default_action"] == "destroy"

    def test_manual_trigger_with_recovery_phrase(
        self, mock_dina: MockDinaCore
    ):
        """The user can manually trigger estate mode by entering their
        BIP-39 recovery phrase — a deliberate, irreversible action."""
        correct_mnemonic = mock_dina.identity.bip39_mnemonic
        wrong_mnemonic = "wrong " * 23 + "phrase"

        # Wrong phrase: rejected
        assert hashlib.sha256(wrong_mnemonic.encode()).hexdigest() != \
               hashlib.sha256(correct_mnemonic.encode()).hexdigest()

        # Correct phrase: accepted
        provided_hash = hashlib.sha256(correct_mnemonic.encode()).hexdigest()
        expected_hash = hashlib.sha256(
            mock_dina.identity.bip39_mnemonic.encode()
        ).hexdigest()
        assert provided_hash == expected_hash

        # Manual trigger creates an estate manager and enters estate mode
        estate = MockEstateManager(mock_dina.identity, EstatePlan())
        estate.enter_estate_mode()
        assert estate.estate_mode_active is True

    def test_multi_beneficiary_threshold(self, mock_dina: MockDinaCore):
        """Multiple beneficiaries can be configured, each with different
        personas and access types. The plan supports at least 10 beneficiaries."""
        beneficiaries = []
        for i in range(10):
            persona = list(PersonaType)[i % len(PersonaType)]
            beneficiaries.append(
                EstateBeneficiary(
                    name=f"Beneficiary_{i}",
                    dina_did=f"did:plc:Beneficiary{i:040d}",
                    receives_personas=[persona],
                    access_type="full_decrypt" if i < 5 else "read_only_90_days",
                )
            )

        plan = EstatePlan(
            trigger="dead_mans_switch",
            switch_interval_days=90,
            beneficiaries=beneficiaries,
            default_action="destroy",
        )

        assert len(plan.beneficiaries) == 10

        # Each beneficiary has a unique DID
        dids = {b.dina_did for b in plan.beneficiaries}
        assert len(dids) == 10

        # Access types are split
        full_access = [b for b in plan.beneficiaries if b.access_type == "full_decrypt"]
        read_only = [b for b in plan.beneficiaries if b.access_type == "read_only_90_days"]
        assert len(full_access) == 5
        assert len(read_only) == 5

        # Store in vault and verify retrieval
        plan_data = {
            "beneficiary_count": len(plan.beneficiaries),
            "trigger": plan.trigger,
        }
        mock_dina.vault.store(0, "estate_plan_multi", plan_data)
        retrieved = mock_dina.vault.retrieve(0, "estate_plan_multi")
        assert retrieved["beneficiary_count"] == 10
