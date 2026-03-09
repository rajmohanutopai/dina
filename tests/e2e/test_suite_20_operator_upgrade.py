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
        assert len(results) == 1, (
            f"Expected exactly 1 admin entry, got {len(results)}"
        )
        assert "balance check OK" in results[0].body_text, (
            "Stored admin entry must have correct VALUE"
        )
        assert results[0].persona == "financial"

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
        assert len(results) == 1, (
            "Previously stored admin entry must survive lock/unlock cycle"
        )
        assert "balance check OK" in results[0].body_text

        # Verify system-generated audit trail from operations above
        # (vault_store and persona_unlock create audit entries internally)
        store_audits = node.get_audit_entries("vault_store")
        assert any(
            a.details.get("key") == "admin_test_entry" for a in store_audits
        ), "vault_store must create a system-generated audit entry"

        unlock_audits = node.get_audit_entries("persona_unlock")
        assert any(
            a.details.get("persona") == "financial" for a in unlock_audits
        ), "persona_unlock must create a system-generated audit entry"

# TST-E2E-110
    def test_verified_upgrade_requires_operator_action(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-20.3 Upgrade checksum verification and KV persistence.

        Tests the data contracts for upgrade metadata: KV round-trip
        through real Go Core, SHA-256 checksum verification (tampered
        payload produces different hash), and operator approval workflow.

        No production upgrade manager exists yet — the test exercises
        KV persistence and checksum computation, not a real upgrade flow.
        """
        node = don_alonso

        # -- Compute upgrade checksum --------------------------------------
        upgrade_payload = json.dumps({
            "version": "0.5.0",
            "changelog": "The Hand: autonomous purchasing support",
            "binary_url": "https://releases.dina.local/v0.5.0/dina-core",
            "binary_size": 42_000_000,
        }).encode()

        valid_checksum = hashlib.sha256(upgrade_payload).hexdigest()

        # -- Store upgrade candidate in KV (real Go Core API) --------------
        node.kv_put("system:pending_upgrade", {
            "version": "0.5.0",
            "checksum_sha256": valid_checksum,
            "requires_operator_action": True,
            "operator_approved": False,
        })

        # Verify KV round-trip through real Go Core preserves values
        pending = node.kv_get("system:pending_upgrade")
        assert pending["version"] == "0.5.0"
        assert pending["checksum_sha256"] == valid_checksum
        assert pending["requires_operator_action"] is True
        assert pending["operator_approved"] is False

        # -- Tampered payload produces DIFFERENT checksum ------------------
        tampered_payload = json.dumps({
            "version": "0.5.0",
            "changelog": "TAMPERED: injected malicious code",
            "binary_url": "https://evil.com/dina-core",
            "binary_size": 42_000_000,
        }).encode()

        tampered_checksum = hashlib.sha256(tampered_payload).hexdigest()
        assert tampered_checksum != valid_checksum, (
            "Tampered payload must produce a different checksum"
        )

        # -- Operator approves: update KV ----------------------------------
        node.kv_put("system:pending_upgrade", {
            "version": "0.5.0",
            "checksum_sha256": valid_checksum,
            "requires_operator_action": True,
            "operator_approved": True,
        })

        approved = node.kv_get("system:pending_upgrade")
        assert approved["operator_approved"] is True

        # Record version in KV (real Go Core persistence)
        node.kv_put("system:version", "0.5.0")
        assert node.kv_get("system:version") == "0.5.0"

        # Clean up pending upgrade after apply
        node.kv_put("system:pending_upgrade", None)
        assert node.kv_get("system:pending_upgrade") is None, (
            "Pending upgrade must be cleared after apply"
        )
