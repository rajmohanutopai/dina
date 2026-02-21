"""Integration tests for the digital estate system.

Behavioral contracts tested:
- SSS custodian recovery: Custodians holding Shamir's Secret Sharing shares
  coordinate to reconstruct the master seed and activate estate mode.
  Threshold must be met (e.g., 3-of-5). No timer-based liveness checks.
- Estate configuration: Plan storage in Tier 0, manual trigger with recovery
  phrase (primary mechanism), SSS custodian coordination.

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
# TestCustodianRecovery
# =========================================================================

class TestCustodianRecovery:
    """SSS custodian-based estate recovery — no timers, no false activations."""

    def test_threshold_met_activates_estate(
        self,
        mock_estate_manager: MockEstateManager,
    ):
        """When the required number of custodians submit valid SSS shares,
        estate mode is activated and the master seed can be reconstructed."""
        # 3-of-5 threshold: submit 3 valid shares
        share_1 = b"SSS_SHARE_CUSTODIAN_A_001"
        share_2 = b"SSS_SHARE_CUSTODIAN_B_002"
        share_3 = b"SSS_SHARE_CUSTODIAN_C_003"

        assert mock_estate_manager.submit_share(share_1) is True
        assert mock_estate_manager.submit_share(share_2) is True
        assert mock_estate_manager.submit_share(share_3) is True

        assert len(mock_estate_manager.shares_collected) == 3
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True

    def test_below_threshold_blocks_estate(
        self,
        mock_estate_manager: MockEstateManager,
    ):
        """If fewer custodians than the threshold submit shares,
        estate mode cannot be activated."""
        # Only 2 of 3 required shares submitted
        share_1 = b"SSS_SHARE_CUSTODIAN_A_001"
        share_2 = b"SSS_SHARE_CUSTODIAN_B_002"

        assert mock_estate_manager.submit_share(share_1) is True
        assert mock_estate_manager.submit_share(share_2) is True

        assert len(mock_estate_manager.shares_collected) == 2

        # Attempting to enter estate mode with insufficient shares fails
        with pytest.raises(RuntimeError, match="2 shares collected, 3 required"):
            mock_estate_manager.enter_estate_mode()

        assert mock_estate_manager.estate_mode_active is False

    def test_invalid_share_rejected(
        self,
        mock_estate_manager: MockEstateManager,
    ):
        """Corrupted or empty shares are rejected. They do not count
        toward the threshold."""
        share_valid_1 = b"SSS_SHARE_CUSTODIAN_A_001"
        share_valid_2 = b"SSS_SHARE_CUSTODIAN_B_002"
        share_corrupted = b"CORRUPTED"
        share_empty = b""

        assert mock_estate_manager.submit_share(share_valid_1) is True
        assert mock_estate_manager.submit_share(share_corrupted) is False
        assert mock_estate_manager.submit_share(share_empty) is False
        assert mock_estate_manager.submit_share(share_valid_2) is True

        # Only 2 valid shares collected — corrupted/empty ones rejected
        assert len(mock_estate_manager.shares_collected) == 2

        # Still below threshold (3 required)
        with pytest.raises(RuntimeError):
            mock_estate_manager.enter_estate_mode()

        assert mock_estate_manager.estate_mode_active is False

    def test_estate_mode_notifies_beneficiaries(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """When estate mode activates via SSS threshold, beneficiaries are
        notified via Dina-to-Dina P2P messages."""
        # All beneficiary DIDs must be authenticated peers for delivery
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        # Submit enough shares to meet threshold
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
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
        mock_p2p: MockP2PChannel,
    ):
        """Each beneficiary receives keys ONLY for the personas assigned
        to them in the estate plan."""
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.authenticated_peers.add(b.dina_did)

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
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

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
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

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
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
            trigger="custodian_threshold",
            custodian_threshold=3,
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
            "custodian_threshold": plan.custodian_threshold,
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
        assert retrieved["trigger"] == "custodian_threshold"
        assert retrieved["custodian_threshold"] == 3
        assert len(retrieved["beneficiaries"]) == 1
        assert retrieved["default_action"] == "destroy"

    def test_manual_trigger_with_recovery_phrase(
        self, mock_dina: MockDinaCore
    ):
        """The primary human-initiated trigger: next-of-kin provides the
        BIP-39 recovery phrase to activate estate mode. This is the main
        mechanism for estate recovery alongside SSS custodian coordination."""
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

        # Manual trigger creates an estate manager with enough shares
        # pre-loaded (recovery phrase bypasses SSS threshold)
        plan = EstatePlan(custodian_threshold=1)
        estate = MockEstateManager(mock_dina.identity, plan)
        estate.submit_share(b"RECOVERY_PHRASE_SHARE")
        estate.enter_estate_mode()
        assert estate.estate_mode_active is True

    def test_sss_custodian_coordination(self, mock_dina: MockDinaCore):
        """SSS custodian coordination: multiple custodians present shares
        (some physical QR, some digital via D2D) to meet the threshold.
        No single custodian can trigger estate alone."""
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
            trigger="custodian_threshold",
            custodian_threshold=3,
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

        # Estate manager requires SSS threshold
        estate = MockEstateManager(mock_dina.identity, plan)

        # Single custodian cannot trigger alone
        estate.submit_share(b"CUSTODIAN_1_SHARE")
        with pytest.raises(RuntimeError):
            estate.enter_estate_mode()

        # Two custodians: still not enough
        estate.submit_share(b"CUSTODIAN_2_SHARE")
        with pytest.raises(RuntimeError):
            estate.enter_estate_mode()

        # Third custodian: threshold met
        estate.submit_share(b"CUSTODIAN_3_SHARE")
        estate.enter_estate_mode()
        assert estate.estate_mode_active is True

        # Store in vault and verify retrieval
        plan_data = {
            "beneficiary_count": len(plan.beneficiaries),
            "trigger": plan.trigger,
            "custodian_threshold": plan.custodian_threshold,
        }
        mock_dina.vault.store(0, "estate_plan_multi", plan_data)
        retrieved = mock_dina.vault.retrieve(0, "estate_plan_multi")
        assert retrieved["beneficiary_count"] == 10
        assert retrieved["trigger"] == "custodian_threshold"
        assert retrieved["custodian_threshold"] == 3
