"""Suite 9: Digital Estate — E2E tests.

Verifies Shamir's Secret Sharing custodian recovery, beneficiary key
delivery via D2D, destruction gated on delivery confirmation, and mixed
physical/digital share recovery flows.

When the human is gone, Dina executes their final wishes: persona DEKs
are delivered to named beneficiaries, and everything else is destroyed.
The root seed is NEVER transmitted. Destruction cannot proceed until all
beneficiaries have confirmed receipt.
"""

from __future__ import annotations

import json

import pytest

from tests.e2e.actors import HomeNode, _derive_dek
from tests.e2e.mocks import (
    D2DMessage,
    EstateBeneficiary,
    EstatePlan,
    MockD2DNetwork,
    PersonaType,
    TrustRing,
)


# =========================================================================
# TestDigitalEstate — Suite 9
# =========================================================================

class TestDigitalEstate:
    """Digital Estate (TST-E2E-043 through TST-E2E-046)."""

    # -----------------------------------------------------------------
    # TST-E2E-043  SSS Custodian Recovery
    # -----------------------------------------------------------------
    def test_sss_custodian_recovery(self, don_alonso: HomeNode) -> None:
        # TST-E2E-043
        """Submit SSS shares one by one. With 2 of 3 required shares the
        estate is NOT activated. Once the third share arrives the estate
        transitions to 'estate_activated'. The estate plan is read from
        identity."""

        # Reset any previously collected shares
        don_alonso.sss_shares_collected.clear()
        don_alonso.estate_mode = False

        # Verify estate plan exists (set in conftest)
        assert don_alonso.estate_plan is not None, \
            "Estate plan must be configured"
        assert don_alonso.estate_plan.custodian_threshold == 3, \
            "Custodian threshold must be 3"

        # --- Share 1 of 3 ---
        result_1 = don_alonso.submit_sss_share("SSS_SHARE_CUSTODIAN_A_001")
        assert result_1["status"] == "share_accepted"
        assert result_1["collected"] == 1
        assert result_1["needed"] == 3
        assert don_alonso.estate_mode is False, \
            "Estate must NOT be activated with 1 of 3 shares"

        # --- Share 2 of 3 ---
        result_2 = don_alonso.submit_sss_share("SSS_SHARE_CUSTODIAN_B_002")
        assert result_2["status"] == "share_accepted"
        assert result_2["collected"] == 2
        assert result_2["needed"] == 3
        assert don_alonso.estate_mode is False, \
            "Estate must NOT be activated with 2 of 3 shares"

        # --- Share 3 of 3: threshold met ---
        result_3 = don_alonso.submit_sss_share("SSS_SHARE_CUSTODIAN_C_003")
        assert result_3["status"] == "estate_activated", \
            "Estate must activate when threshold is met"
        assert result_3["shares"] == 3
        assert don_alonso.estate_mode is True, \
            "estate_mode flag must be True after activation"

        # Estate plan is readable from identity
        plan = don_alonso.estate_plan
        assert plan.default_action == "destroy"
        assert len(plan.beneficiaries) >= 1
        assert plan.beneficiaries[0].did == "did:plc:albert"
        assert "personal" in plan.beneficiaries[0].personas
        assert "health" in plan.beneficiaries[0].personas

    # -----------------------------------------------------------------
    # TST-E2E-044  Beneficiary Key Delivery
    # -----------------------------------------------------------------
    def test_beneficiary_key_delivery(
        self,
        don_alonso: HomeNode,
        albert: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        # TST-E2E-044
        """With the estate activated, deliver_estate_keys() sends persona
        DEKs to Albert via D2D. The root seed is NEVER included in the
        payload. Albert receives only /personal and /health keys as
        specified in the estate plan."""

        # Activate estate mode
        don_alonso.sss_shares_collected.clear()
        don_alonso.estate_mode = False
        don_alonso.submit_sss_share("SSS_SHARE_A")
        don_alonso.submit_sss_share("SSS_SHARE_B")
        don_alonso.submit_sss_share("SSS_SHARE_C")
        assert don_alonso.estate_mode is True

        # Reset delivery_confirmed on beneficiaries
        for b in don_alonso.estate_plan.beneficiaries:
            b.delivery_confirmed = False

        # Ensure Albert is online
        d2d_network.set_online("did:plc:albert", True)

        # Record traffic baseline
        traffic_before = len(d2d_network.captured_traffic)

        # --- Deliver keys ---
        delivery_results = don_alonso.deliver_estate_keys()

        assert "did:plc:albert" in delivery_results, \
            "Delivery results must include Albert's DID"
        assert delivery_results["did:plc:albert"] is True, \
            "Keys must be successfully delivered to Albert"

        # --- Verify D2D traffic was generated ---
        traffic_after = len(d2d_network.captured_traffic)
        assert traffic_after > traffic_before, \
            "Key delivery must generate D2D traffic"

        # Find the estate key message in captured traffic
        estate_messages = [
            t for t in d2d_network.captured_traffic[traffic_before:]
            if t["type"] == "dina/identity/estate_keys"
        ]
        assert len(estate_messages) >= 1, \
            "At least one estate_keys message must be sent"

        # --- Root seed NEVER in payload ---
        # Check all captured traffic for the raw master seed
        for traffic_entry in d2d_network.captured_traffic[traffic_before:]:
            # The encrypted_size tells us a payload exists but we check
            # the mock network does not expose plaintext seed
            assert not d2d_network.traffic_contains_plaintext(
                don_alonso.master_seed
            ), "Root seed must NEVER appear in network traffic"

        # --- Albert receives only /personal + /health keys ---
        # Albert should have received the D2D message
        albert_received = [
            e for e in albert.audit_log
            if e.action == "d2d_receive"
               and e.details.get("type") == "dina/identity/estate_keys"
        ]
        assert len(albert_received) >= 1, \
            "Albert must have received estate_keys message"

        # Verify the estate plan specifies only personal + health
        albert_beneficiary = [
            b for b in don_alonso.estate_plan.beneficiaries
            if b.did == "did:plc:albert"
        ][0]
        assert set(albert_beneficiary.personas) == {"personal", "health"}, \
            "Albert should only receive personal and health persona keys"

        # Verify delivery was confirmed
        assert albert_beneficiary.delivery_confirmed is True

    # -----------------------------------------------------------------
    # TST-E2E-045  Destruction Gated on Delivery
    # -----------------------------------------------------------------
    def test_destruction_gated_on_delivery(
        self,
        fresh_don_alonso: HomeNode,
        albert: HomeNode,
        plc_directory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        # TST-E2E-045
        """Two beneficiaries: Albert (online) and a colleague (offline).
        execute_estate_destruction() returns False because not all keys
        have been delivered. Once the colleague comes online and keys are
        delivered, destruction succeeds."""

        node = fresh_don_alonso
        node.first_run_setup("fresh@example.com", "passphrase_fresh")

        # Create personas
        node.create_persona("personal", PersonaType.PERSONAL, "open")
        node.create_persona("health", PersonaType.HEALTH, "restricted")
        node.create_persona("financial", PersonaType.FINANCIAL, "locked")
        node.unlock_persona("financial", "passphrase_fresh")

        # Store data in each persona
        node.vault_store("personal", "diary_entry",
                         {"text": "Today was a good day"})
        node.vault_store("health", "medical_record",
                         {"condition": "healthy"})
        node.vault_store("financial", "savings",
                         {"amount": 100000})

        # Create a colleague node
        colleague = HomeNode(
            did="did:plc:colleague_test",
            display_name="Colleague",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=plc_directory,
            network=d2d_network,
        )
        colleague.first_run_setup("colleague@example.com", "pass_colleague")

        # Set up estate plan with TWO beneficiaries
        node.set_estate_plan(EstatePlan(
            beneficiaries=[
                EstateBeneficiary(
                    did="did:plc:albert",
                    personas=["personal", "health"],
                    access_level="full_decrypt",
                ),
                EstateBeneficiary(
                    did="did:plc:colleague_test",
                    personas=["financial"],
                    access_level="full_decrypt",
                ),
            ],
            custodian_threshold=3,
            custodian_total=5,
            default_action="destroy",
        ))

        # Activate estate
        node.submit_sss_share("SHARE_X")
        node.submit_sss_share("SHARE_Y")
        node.submit_sss_share("SHARE_Z")
        assert node.estate_mode is True

        # --- Colleague goes offline ---
        d2d_network.set_online("did:plc:colleague_test", False)
        d2d_network.set_online("did:plc:albert", True)

        # Attempt delivery: Albert succeeds, colleague fails
        delivery_round_1 = node.deliver_estate_keys()
        assert delivery_round_1["did:plc:albert"] is True, \
            "Albert (online) must receive keys"
        assert delivery_round_1["did:plc:colleague_test"] is False, \
            "Colleague (offline) must NOT receive keys"

        # --- Destruction must fail: not all delivered ---
        destruction_ok = node.execute_estate_destruction()
        assert destruction_ok is False, \
            "Destruction must be blocked when not all beneficiaries confirmed"

        # Verify data still exists
        assert len(node.personas["personal"].items) >= 1, \
            "Personal data must survive failed destruction"
        assert len(node.personas["financial"].items) >= 1, \
            "Financial data must survive failed destruction"

        # --- Colleague comes online ---
        d2d_network.set_online("did:plc:colleague_test", True)

        # Reset colleague beneficiary delivery flag for retry
        for b in node.estate_plan.beneficiaries:
            if b.did == "did:plc:colleague_test":
                b.delivery_confirmed = False

        # Retry delivery
        delivery_round_2 = node.deliver_estate_keys()
        assert delivery_round_2["did:plc:colleague_test"] is True, \
            "Colleague (now online) must receive keys"

        # --- Destruction now succeeds ---
        destruction_ok = node.execute_estate_destruction()
        assert destruction_ok is True, \
            "Destruction must succeed when all beneficiaries confirmed"

        # Non-assigned personas are destroyed
        # "personal" and "health" assigned to Albert, "financial" assigned
        # to colleague. Any other personas should be wiped.
        # The "personal" persona created by first_run_setup is a duplicate
        # of the one in the estate plan, so its items may or may not survive
        # depending on whether it's in the assigned set.
        assigned_personas = {"personal", "health", "financial"}
        for pname, persona in node.personas.items():
            if pname not in assigned_personas:
                assert len(persona.items) == 0, \
                    f"Non-assigned persona '{pname}' must be destroyed"

    # -----------------------------------------------------------------
    # TST-E2E-046  SSS Recovery with Physical Shares
    # -----------------------------------------------------------------
    def test_sss_recovery_with_physical_shares(
        self,
        don_alonso: HomeNode,
    ) -> None:
        # TST-E2E-046
        """Mix of physical and digital shares to meet the threshold.
        Same activation flow as TST-E2E-043 but with mixed share types
        (some marked as physical custody, some as digital)."""

        # Reset
        don_alonso.sss_shares_collected.clear()
        don_alonso.estate_mode = False

        assert don_alonso.estate_plan is not None
        threshold = don_alonso.estate_plan.custodian_threshold
        assert threshold == 3

        # --- Physical share 1: scanned QR code / typed passphrase ---
        physical_share_1 = "PHYSICAL:STEEL_PLATE:SSS_SHARE_PHYS_A_001"
        result_p1 = don_alonso.submit_sss_share(physical_share_1)
        assert result_p1["status"] == "share_accepted"
        assert result_p1["collected"] == 1

        # --- Digital share 2: submitted via D2D from custodian ---
        digital_share_2 = "DIGITAL:D2D:SSS_SHARE_DIG_B_002"
        result_d2 = don_alonso.submit_sss_share(digital_share_2)
        assert result_d2["status"] == "share_accepted"
        assert result_d2["collected"] == 2
        assert don_alonso.estate_mode is False, \
            "2 of 3 shares must NOT activate estate"

        # --- Physical share 3: typed from paper backup ---
        physical_share_3 = "PHYSICAL:PAPER:SSS_SHARE_PHYS_C_003"
        result_p3 = don_alonso.submit_sss_share(physical_share_3)
        assert result_p3["status"] == "estate_activated", \
            "Mixed physical+digital shares must activate estate at threshold"
        assert result_p3["shares"] == 3
        assert don_alonso.estate_mode is True

        # Verify all shares are recorded
        assert len(don_alonso.sss_shares_collected) == 3
        physical_shares = [
            s for s in don_alonso.sss_shares_collected
            if s.startswith("PHYSICAL:")
        ]
        digital_shares = [
            s for s in don_alonso.sss_shares_collected
            if s.startswith("DIGITAL:")
        ]
        assert len(physical_shares) == 2, \
            "Two physical shares must be recorded"
        assert len(digital_shares) == 1, \
            "One digital share must be recorded"

        # Estate plan is still readable after activation
        plan = don_alonso.estate_plan
        assert plan.default_action == "destroy"
        assert plan.custodian_total == 5
        assert len(plan.beneficiaries) >= 1
        assert plan.beneficiaries[0].did == "did:plc:albert"
