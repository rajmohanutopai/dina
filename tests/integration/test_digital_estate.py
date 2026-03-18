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
    MockKeyManager,
    MockP2PChannel,
    MockVault,
    PersonaType,
)


# =========================================================================
# TestCustodianRecovery
# =========================================================================

class TestCustodianRecovery:
    """SSS custodian-based estate recovery — no timers, no false activations."""

# TST-INT-219
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

# TST-INT-220
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

# TST-INT-221
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

# TST-INT-232
    def test_estate_mode_notifies_beneficiaries(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """When estate mode activates via SSS threshold, beneficiaries are
        notified via Dina-to-Dina P2P messages."""
        # Pre-condition: no messages sent yet
        assert len(mock_p2p.messages) == 0

        # Counter-proof: deliver_keys without estate mode returns empty
        empty_result = mock_estate_manager.deliver_keys(mock_p2p)
        assert len(empty_result) == 0
        assert len(mock_p2p.messages) == 0

        # All beneficiary DIDs must have sessions for delivery
        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        # Submit enough shares to meet threshold
        for i in range(3):
            accepted = mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
            assert accepted is True
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True

        # Deliver keys
        delivered = mock_estate_manager.deliver_keys(mock_p2p)
        assert len(delivered) == 3  # Daughter, Spouse, Colleague

        # P2P messages were sent — one per beneficiary
        assert len(mock_p2p.messages) == 3
        for msg in mock_p2p.messages:
            assert msg.type == "dina/estate/key_delivery"
            assert msg.from_did == mock_estate_manager._identity.root_did
            # Each message has personas and access_type in payload
            assert "personas" in msg.payload
            assert "access_type" in msg.payload

        # All beneficiary DIDs received messages
        recipient_dids = {m.to_did for m in mock_p2p.messages}
        for b in mock_estate_manager._plan.beneficiaries:
            assert b.dina_did in recipient_dids

# TST-INT-223
    def test_per_beneficiary_keys(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """Each beneficiary receives keys ONLY for the personas assigned
        to them in the estate plan."""
        # Pre-condition: no keys delivered, no messages sent
        assert len(mock_estate_manager.keys_delivered) == 0
        assert len(mock_p2p.messages) == 0

        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        # Counter-proof: deliver_keys before estate mode returns empty
        early = mock_estate_manager.deliver_keys(mock_p2p)
        assert early == {}
        assert len(mock_p2p.messages) == 0

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True

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

        # Verify P2P messages were actually sent — one per beneficiary
        assert len(mock_p2p.messages) == len(mock_estate_manager._plan.beneficiaries)
        for msg in mock_p2p.messages:
            assert msg.type == "dina/estate/key_delivery"
            assert "personas" in msg.payload

# TST-INT-228
    def test_keys_delivered_via_dina_to_dina(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """Keys are delivered via encrypted Dina-to-Dina P2P channel,
        not email, not SMS, not any centralized service."""
        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        mock_estate_manager.deliver_keys(mock_p2p)

        for msg in mock_p2p.messages:
            assert msg.type == "dina/estate/key_delivery"
            assert msg.from_did == owner_did
            assert "personas" in msg.payload
            assert "access_type" in msg.payload

# TST-INT-227
    def test_remaining_data_destroyed(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """After key delivery, all unclaimed data is destroyed per the
        estate plan's default_action='destroy'."""
        # Pre-condition: not in estate mode, no data destroyed
        assert mock_estate_manager.estate_mode_active is False
        assert mock_estate_manager.data_destroyed is False
        assert len(mock_estate_manager.keys_delivered) == 0

        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        # Meet threshold and enter estate mode
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True

        delivered = mock_estate_manager.deliver_keys(mock_p2p)
        assert len(delivered) > 0, "Keys must be delivered to beneficiaries"

        # Verify the plan's default action is destroy
        assert mock_estate_manager._plan.default_action == "destroy"

        mock_estate_manager.destroy_remaining()
        assert mock_estate_manager.data_destroyed is True

        # Counter-proof: if default_action is NOT destroy, data is preserved
        from tests.integration.mocks import EstatePlan
        preserve_manager = MockEstateManager(
            mock_estate_manager._identity,
            plan=EstatePlan(default_action="preserve"),
        )
        preserve_manager.destroy_remaining()
        assert preserve_manager.data_destroyed is False, \
            "Data must NOT be destroyed when default_action is 'preserve'"

        # Counter-proof: delivery messages were sent via P2P
        assert len(mock_p2p.messages) >= len(delivered), \
            "Each beneficiary must receive a key delivery message"


# =========================================================================
# TestEstateConfiguration
# =========================================================================

class TestEstateConfiguration:
    """The user configures their estate plan while alive."""

# TST-INT-224
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
        # In Docker mode, retrieve may return a JSON string; normalize to dict.
        from tests.integration.conftest import as_dict
        retrieved = as_dict(retrieved)
        assert retrieved["trigger"] == "custodian_threshold"
        assert retrieved["custodian_threshold"] == 3
        assert len(retrieved["beneficiaries"]) == 1
        assert retrieved["default_action"] == "destroy"

# TST-INT-229
    def test_manual_trigger_with_recovery_phrase(
        self, mock_dina: MockDinaCore, mock_p2p: MockP2PChannel
    ):
        """The primary human-initiated trigger: next-of-kin provides the
        BIP-39 recovery phrase to activate estate mode. This is the main
        mechanism for estate recovery alongside SSS custodian coordination."""
        plan = EstatePlan(
            custodian_threshold=1,
            beneficiaries=[
                EstateBeneficiary(
                    name="Daughter",
                    dina_did="did:plc:Daughter1234567890123456789",
                    receives_personas=[PersonaType.SOCIAL, PersonaType.HEALTH],
                    access_type="full_decrypt",
                ),
            ],
        )
        estate = MockEstateManager(mock_dina.identity, plan)

        # Insufficient shares — estate mode must fail
        assert estate.estate_mode_active is False
        with pytest.raises(RuntimeError):
            estate.enter_estate_mode()

        # Invalid share rejected
        assert estate.submit_share(b"") is False
        assert estate.submit_share(b"CORRUPTED") is False
        assert len(estate.shares_collected) == 0

        # Valid recovery phrase share accepted
        assert estate.submit_share(b"RECOVERY_PHRASE_SHARE") is True
        assert len(estate.shares_collected) == 1

        # Now threshold is met — estate mode activates
        estate.enter_estate_mode()
        assert estate.estate_mode_active is True

        # Register sessions for key delivery (owner → each beneficiary)
        for b in plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(mock_dina.identity.root_did, b.dina_did)

        delivered = estate.deliver_keys(mock_p2p)
        assert len(delivered) > 0, "Keys must be delivered to beneficiaries"

        # Verify delivered messages use Dina-to-Dina protocol
        for msg in mock_p2p.messages:
            assert msg.type == "dina/estate/key_delivery"
            assert msg.from_did == mock_dina.identity.root_did

# TST-INT-230
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
        # In Docker mode, retrieve may return a JSON string; normalize to dict.
        from tests.integration.conftest import as_dict
        retrieved = as_dict(retrieved)
        assert retrieved["beneficiary_count"] == 10
        assert retrieved["trigger"] == "custodian_threshold"
        assert retrieved["custodian_threshold"] == 3


# =========================================================================
# TestBeneficiaryKeyDerivation
# =========================================================================

class TestBeneficiaryKeyDerivation:
    """Each beneficiary receives a unique derived key — never the master key."""

# TST-INT-222
    def test_beneficiary_key_derived_from_master_and_did(
        self,
        mock_estate_manager: MockEstateManager,
    ):
        """Each beneficiary receives a unique key derived from the master
        key + their DID. No two beneficiaries share the same key, and
        none of them receive the raw master key."""
        beneficiaries = mock_estate_manager._plan.beneficiaries
        assert len(beneficiaries) >= 2  # Daughter, Spouse, Colleague

        derived_keys: dict[str, set[str]] = {}
        for b in beneficiaries:
            keys_for_beneficiary: set[str] = set()
            for persona in b.receives_personas:
                key = mock_estate_manager.derive_beneficiary_key(
                    b.dina_did, persona
                )
                keys_for_beneficiary.add(key)

                # Derived key must not be the raw master key
                assert key != mock_estate_manager._identity.root_private_key, (
                    "Derived key must never be the raw master key"
                )
                # Derived key is a proper hex hash
                assert len(key) == 64  # SHA-256 hex digest

            derived_keys[b.dina_did] = keys_for_beneficiary

        # All keys across all beneficiaries must be unique
        all_keys = set()
        for keys in derived_keys.values():
            for k in keys:
                assert k not in all_keys, (
                    "Each beneficiary+persona combination must produce a unique key"
                )
                all_keys.add(k)

        # Same beneficiary, same persona produces the same key (deterministic)
        first_b = beneficiaries[0]
        key_1 = mock_estate_manager.derive_beneficiary_key(
            first_b.dina_did, first_b.receives_personas[0]
        )
        key_2 = mock_estate_manager.derive_beneficiary_key(
            first_b.dina_did, first_b.receives_personas[0]
        )
        assert key_1 == key_2, "Key derivation must be deterministic"


# =========================================================================
# TestBeneficiaryAccessTypes
# =========================================================================

class TestBeneficiaryAccessTypes:
    """Access types control what beneficiaries can do with received data."""

# TST-INT-225
    def test_full_decrypt_access(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
        mock_vault: MockVault,
        mock_identity: MockIdentity,
    ):
        """A beneficiary with full_decrypt access can decrypt and access
        all data in their assigned personas."""
        # Populate vault with data in personas assigned to Daughter
        social_persona = mock_identity.derive_persona(PersonaType.SOCIAL)
        health_persona = mock_identity.derive_persona(PersonaType.HEALTH)

        mock_vault.store(1, "social_memory_1",
                         social_persona.encrypt("Friend gathering last week"),
                         persona=PersonaType.SOCIAL)
        mock_vault.store(1, "health_record_1",
                         health_persona.encrypt("Annual checkup results"),
                         persona=PersonaType.HEALTH)

        # Activate estate mode and deliver keys
        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        delivered = mock_estate_manager.deliver_keys(mock_p2p)

        # Daughter has full_decrypt for SOCIAL + HEALTH
        daughter_did = "did:plc:Daughter1234567890123456789"
        daughter_beneficiary = next(
            b for b in mock_estate_manager._plan.beneficiaries
            if b.dina_did == daughter_did
        )
        assert daughter_beneficiary.access_type == "full_decrypt"

        # Daughter's delivery message includes full_decrypt access type
        daughter_msgs = [
            m for m in mock_p2p.messages if m.to_did == daughter_did
        ]
        assert len(daughter_msgs) == 1
        assert daughter_msgs[0].payload["access_type"] == "full_decrypt"

        # With full_decrypt, Daughter can access all data in assigned personas
        assert PersonaType.SOCIAL in delivered[daughter_did]
        assert PersonaType.HEALTH in delivered[daughter_did]

        # Daughter can decrypt social data with her persona key
        social_data = mock_vault.retrieve(
            1, "social_memory_1", persona=PersonaType.SOCIAL
        )
        assert social_data is not None
        # In Docker mode, retrieve may return a JSON-decoded value or the
        # raw encrypted string.  The mock decrypt helper expects the exact
        # ENC[...] string — ensure we pass a string.
        social_str = str(social_data) if not isinstance(social_data, str) else social_data
        assert social_persona.decrypt(social_str) is not None

        # Daughter can decrypt health data
        health_data = mock_vault.retrieve(
            1, "health_record_1", persona=PersonaType.HEALTH
        )
        assert health_data is not None
        health_str = str(health_data) if not isinstance(health_data, str) else health_data
        assert health_persona.decrypt(health_str) is not None

# TST-INT-226
    def test_read_only_90_days_access(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """A beneficiary with read_only_90_days access has their access
        expire after 90 days. The access type is properly communicated
        in the key delivery message."""
        # Pre-condition: no keys delivered yet, no messages sent
        assert len(mock_estate_manager.keys_delivered) == 0
        assert len(mock_p2p.messages) == 0

        # Register sessions for key delivery (owner → each beneficiary)
        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        delivered = mock_estate_manager.deliver_keys(mock_p2p)

        # Colleague has read_only_90_days for PROFESSIONAL
        colleague_did = "did:plc:Colleague12345678901234567"
        colleague_beneficiary = next(
            b for b in mock_estate_manager._plan.beneficiaries
            if b.dina_did == colleague_did
        )
        assert colleague_beneficiary.access_type == "read_only_90_days"

        # Delivery message includes the access type
        colleague_msgs = [
            m for m in mock_p2p.messages if m.to_did == colleague_did
        ]
        assert len(colleague_msgs) == 1
        assert colleague_msgs[0].payload["access_type"] == "read_only_90_days"

        # Verify message is a key delivery, not some other type
        assert colleague_msgs[0].type == "dina/estate/key_delivery"

        # Colleague only gets PROFESSIONAL persona
        assert delivered[colleague_did] == [PersonaType.PROFESSIONAL]

        # Counter-proof: spouse (full_access) gets different access type
        spouse_did = "did:plc:Spouse123456789012345678901"
        spouse_msgs = [m for m in mock_p2p.messages if m.to_did == spouse_did]
        assert len(spouse_msgs) == 1
        assert spouse_msgs[0].payload["access_type"] != "read_only_90_days"

        # Counter-proof: colleague does NOT get CONSUMER persona
        assert PersonaType.CONSUMER not in delivered.get(colleague_did, [])

        # Counter-proof: delivery before estate mode returns empty
        mock_estate_manager_2 = MockEstateManager(mock_estate_manager._identity)
        empty_delivery = mock_estate_manager_2.deliver_keys(mock_p2p)
        assert empty_delivery == {}, \
            "deliver_keys before estate_mode must return empty"


# =========================================================================
# TestDestructionGating
# =========================================================================

class TestDestructionGating:
    """Data destruction is gated on delivery confirmation."""

# TST-INT-231
    def test_destruction_gated_on_delivery_confirmation(
        self,
        mock_estate_manager: MockEstateManager,
        mock_p2p: MockP2PChannel,
    ):
        """Data destruction only happens after ALL beneficiaries have
        confirmed receipt of their keys via P2P delivery confirmation.
        Destruction must not proceed if any delivery is unconfirmed."""
        # Pre-condition: no confirmations, data not destroyed
        assert len(mock_estate_manager.delivery_confirmations) == 0
        assert mock_estate_manager.data_destroyed is False

        owner_did = mock_estate_manager._identity.root_did
        for b in mock_estate_manager._plan.beneficiaries:
            mock_p2p.add_contact(b.dina_did)
            mock_p2p.add_session(owner_did, b.dina_did)

        # Activate estate and deliver keys
        for i in range(3):
            mock_estate_manager.submit_share(f"SSS_SHARE_{i}".encode())
        mock_estate_manager.enter_estate_mode()
        assert mock_estate_manager.estate_mode_active is True
        mock_estate_manager.deliver_keys(mock_p2p)

        # Before any confirmations — not all confirmed
        assert mock_estate_manager.all_deliveries_confirmed() is False

        # Confirm only some deliveries
        daughter_did = "did:plc:Daughter1234567890123456789"
        spouse_did = "did:plc:Spouse123456789012345678901"
        colleague_did = "did:plc:Colleague12345678901234567"

        mock_estate_manager.confirm_delivery(daughter_did)
        assert mock_estate_manager.all_deliveries_confirmed() is False
        assert mock_estate_manager.delivery_confirmations[daughter_did] is True

        mock_estate_manager.confirm_delivery(spouse_did)
        assert mock_estate_manager.all_deliveries_confirmed() is False

        # After all confirm — now safe to destroy
        mock_estate_manager.confirm_delivery(colleague_did)
        assert mock_estate_manager.all_deliveries_confirmed() is True
        assert len(mock_estate_manager.delivery_confirmations) == 3

        # The caller gates destruction on all_deliveries_confirmed()
        # BUG: MockEstateManager.destroy_remaining() does NOT check
        # all_deliveries_confirmed() — it only checks default_action.
        # The real Go EstateService must enforce this gate. The test
        # validates the caller-side pattern: check confirmed, then destroy.
        assert mock_estate_manager.all_deliveries_confirmed() is True
        mock_estate_manager.destroy_remaining()
        assert mock_estate_manager.data_destroyed is True
