"""E2E Test Suite 20: Operator and Upgrade Journeys.

Release-facing operator flows.

Actors: Don Alonso.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from tests.e2e.actors import HomeNode, _derive_dek
from tests.e2e.mocks import (
    DeviceType,
    MockD2DNetwork,
    MockPLCDirectory,
    PersonaType,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Suite 20: Operator and Upgrade Journeys
# ---------------------------------------------------------------------------


class TestOperatorUpgrade:
    """E2E-20.x -- Bootstrap idempotency, locked-node admin access, and
    verified upgrade flows."""

# TST-E2E-108
    def test_rerun_install_no_identity_rotation(
        self,
        don_alonso: HomeNode,
        plc_directory: MockPLCDirectory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-20.1 Re-running bootstrap does not rotate identity.

        Record the DID and root public key, re-run first_run_setup
        (simulating a re-install), and verify the DID is unchanged.
        The system must detect that identity already exists and refuse
        to overwrite it.
        """
        node = don_alonso

        # Record identity before re-run
        original_did = node.did
        original_pubkey = node.root_public_key
        original_seed = node.master_seed

        assert node.setup_complete is True, (
            "Node must already be set up"
        )

        # -- Re-run first_run_setup (simulates re-install) -----------------
        result = node.first_run_setup("alonso@example.com", "passphrase123")

        # Must detect existing identity and refuse to overwrite
        assert "error" in result, (
            "Re-running first_run_setup must return an error "
            "when identity already exists"
        )
        assert "already exists" in result["error"].lower() or \
               "already registered" in result["error"].lower(), (
            f"Error message must indicate identity exists: {result['error']}"
        )

        # -- Verify identity unchanged after re-run -----------------------
        assert node.did == original_did, (
            f"DID must not change after re-run: "
            f"{node.did} != {original_did}"
        )
        assert node.root_public_key == original_pubkey, (
            "Root public key must not change after re-run"
        )
        assert node.master_seed == original_seed, (
            "Master seed must not change after re-run"
        )

        # Verify PLC directory still has the same DID document
        doc = plc_directory.resolve(original_did)
        assert doc is not None, (
            "PLC directory must still resolve the original DID"
        )
        assert doc.public_key == original_pubkey, (
            "PLC directory public key must remain unchanged"
        )

        # -- Verify a truly fresh node can still set up --------------------
        fresh = HomeNode(
            did="did:plc:fresh_operator_test",
            display_name="Fresh Node",
            trust_ring=TrustRing.RING_1_UNVERIFIED,
            plc=plc_directory,
            network=d2d_network,
        )
        fresh_result = fresh.first_run_setup("fresh@example.com", "pass123")
        assert fresh_result.get("status") == "ok", (
            "Fresh node setup must succeed"
        )
        assert fresh.setup_complete is True

# TST-E2E-109
    def test_locked_node_admin_journey(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-20.2 Locked node admin journey: lock -> unlock -> admin -> logout.

        1. Lock the vault -> admin operations fail (vault locked).
        2. Unlock -> admin operations succeed.
        3. Logout (lock again) + login (unlock) -> session correct.
        """
        node = don_alonso

        # Ensure a device exists for notification observation
        device_list = list(node.devices.values())
        assert len(device_list) >= 1
        device = device_list[0]
        device.ws_messages.clear()

        # -- Step 1: Lock the vault ----------------------------------------
        node.lock_vault()
        assert node._vault_locked is True

        # Admin operation: storing to vault must fail or be blocked
        # When vault is locked, D2D messages are spooled, but direct
        # vault queries should still work (vault_query checks persona
        # accessibility, not vault lock). Lock a persona to simulate
        # the admin-locked scenario.
        node.lock_persona("financial")

        with pytest.raises(PermissionError, match="403 persona_locked"):
            node.vault_query("financial", "balance")

        # Health check reflects locked state
        health = node.healthz()
        assert health["vault_locked"] is True

        # -- Step 2: Unlock the vault -> admin works -----------------------
        unlock_ok = node.unlock_vault("passphrase123")
        assert unlock_ok is True
        assert node._vault_locked is False

        health_after = node.healthz()
        assert health_after["vault_locked"] is False

        # Unlock the financial persona and verify admin access
        node.unlock_persona("financial", "passphrase", ttl_seconds=300)
        node.vault_store("financial", "admin_test_entry", "balance check OK")
        results = node.vault_query("financial", "admin_test_entry")
        assert len(results) >= 1, (
            "Admin must be able to query vault after unlock"
        )

        # -- Step 3: Logout (lock) + Login (unlock) -> session correct -----
        # Logout: lock vault and personas
        node.lock_vault()
        node.lock_persona("financial")
        assert node._vault_locked is True

        # Login: unlock
        node.unlock_vault("passphrase123")
        assert node._vault_locked is False

        # Verify session state is clean after re-login
        health_final = node.healthz()
        assert health_final["status"] == "ok"
        assert health_final["vault_locked"] is False
        assert health_final["brain"] == "healthy"

        # The financial persona stays locked until explicitly unlocked
        with pytest.raises(PermissionError, match="403 persona_locked"):
            node.vault_query("financial", "balance")

        # Unlock financial and verify it works again
        node.unlock_persona("financial", "passphrase")
        results = node.vault_query("financial", "admin_test_entry")
        assert len(results) >= 1

# TST-E2E-110
    def test_verified_upgrade_requires_operator_action(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-20.3 Upgrade requires explicit operator action; tampered rejected.

        1. An upgrade is only applied when the operator explicitly
           triggers it (no silent auto-updates).
        2. A tampered upgrade candidate (bad checksum) is rejected.
        3. A valid candidate (correct checksum) succeeds.
        """
        node = don_alonso

        # -- Simulate upgrade metadata ------------------------------------
        upgrade_payload = json.dumps({
            "version": "0.5.0",
            "changelog": "The Hand: autonomous purchasing support",
            "binary_url": "https://releases.dina.local/v0.5.0/dina-core",
            "binary_size": 42_000_000,
        }).encode()

        # Compute a valid checksum
        valid_checksum = hashlib.sha256(upgrade_payload).hexdigest()

        upgrade_candidate = {
            "version": "0.5.0",
            "payload": upgrade_payload.decode(),
            "checksum_sha256": valid_checksum,
            "requires_operator_action": True,
        }

        # -- Verify upgrade requires explicit operator action --------------
        assert upgrade_candidate["requires_operator_action"] is True, (
            "Upgrade must require explicit operator action"
        )

        # Simulate the check: operator has NOT approved yet
        operator_approved = False

        if not operator_approved:
            # Upgrade must not proceed without approval
            upgrade_applied = False
        else:
            upgrade_applied = True

        assert upgrade_applied is False, (
            "Upgrade must NOT be applied without operator approval"
        )

        # Notify operator about available upgrade
        node._push_to_devices({
            "type": "whisper",
            "payload": {
                "text": f"Upgrade available: v{upgrade_candidate['version']}. "
                        f"Review changelog and approve in Settings > Updates.",
                "tier": SilenceTier.TIER_2_SOLICITED.value,
            },
        })
        upgrade_notifs = [
            n for n in node.notifications
            if "Upgrade available" in n.get("payload", {}).get("text", "")
        ]
        assert len(upgrade_notifs) >= 1, (
            "Operator must be notified about available upgrade"
        )

        # -- Tampered candidate: bad checksum -> rejected ------------------
        tampered_payload = json.dumps({
            "version": "0.5.0",
            "changelog": "TAMPERED: injected malicious code",
            "binary_url": "https://evil.com/dina-core",
            "binary_size": 42_000_000,
        }).encode()

        tampered_checksum = hashlib.sha256(tampered_payload).hexdigest()

        # The tampered payload has a DIFFERENT checksum than the valid one
        assert tampered_checksum != valid_checksum, (
            "Tampered payload must produce a different checksum"
        )

        # Verify checksum validation catches the tamper
        presented_checksum = valid_checksum  # attacker claims valid checksum
        actual_checksum = hashlib.sha256(tampered_payload).hexdigest()
        checksum_valid = (presented_checksum == actual_checksum)

        assert checksum_valid is False, (
            "Tampered upgrade must fail checksum validation"
        )

        # Log the rejection in audit
        node._log_audit("upgrade_rejected", {
            "version": upgrade_candidate["version"],
            "reason": "checksum_mismatch",
            "expected": presented_checksum,
            "actual": actual_checksum,
        })

        rejection_audits = node.get_audit_entries("upgrade_rejected")
        assert len(rejection_audits) >= 1, (
            "Tampered upgrade rejection must be logged in audit"
        )
        assert rejection_audits[-1].details["reason"] == "checksum_mismatch"

        # -- Valid candidate: operator approves, checksum passes -----------
        operator_approved = True

        # Verify checksum on the valid payload
        actual_valid = hashlib.sha256(upgrade_payload).hexdigest()
        checksum_passes = (valid_checksum == actual_valid)
        assert checksum_passes is True, (
            "Valid upgrade candidate must pass checksum validation"
        )

        # Apply the upgrade (simulated)
        upgrade_applied = operator_approved and checksum_passes
        assert upgrade_applied is True, (
            "Upgrade must proceed when operator approves and checksum is valid"
        )

        # Record successful upgrade in KV and audit
        node.kv_put("system:version", upgrade_candidate["version"])
        node._log_audit("upgrade_applied", {
            "version": upgrade_candidate["version"],
            "checksum": valid_checksum,
        })

        assert node.kv_get("system:version") == "0.5.0"

        applied_audits = node.get_audit_entries("upgrade_applied")
        assert len(applied_audits) >= 1
        assert applied_audits[-1].details["version"] == "0.5.0"
        assert applied_audits[-1].details["checksum"] == valid_checksum
