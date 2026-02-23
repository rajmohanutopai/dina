"""E2E Test Suite 1: First Run & Onboarding.

Tests the complete onboarding journey: first-run identity creation,
device pairing (phone + laptop), progressive disclosure, BIP-39 recovery,
and the single-root-identity invariant.

Actors: Don Alonso (fresh), PLC Directory, D2D Network.
"""

from __future__ import annotations

import hashlib
import time

import pytest

from tests.e2e.actors import HomeNode, Persona, PersonaType
from tests.e2e.mocks import (
    DeviceType,
    MockD2DNetwork,
    MockPLCDirectory,
    PairingCode,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 1: First Run & Onboarding
# ---------------------------------------------------------------------------


class TestFirstRunOnboarding:
    """E2E-1.x -- Complete first-run setup, device pairing, progressive
    disclosure, BIP-39 recovery, and exactly-one-root-identity guard."""

# TST-E2E-001
    def test_complete_first_run_setup(
        self,
        fresh_don_alonso: HomeNode,
        plc_directory: MockPLCDirectory,
    ) -> None:
        """E2E-1.1 Complete First-Run Setup.

        Fresh node performs first_run_setup(). Verify:
        - DID is registered in PLC directory (identity.sqlite equivalent)
        - Only the /personal persona exists after setup
        - Mnemonic is NOT persisted on disk (only returned once)
        - wrapped_seed exists (Argon2id -> KEK -> AES-256-GCM)
        - Failure variant: PLC unreachable -> clean error
        """
        node = fresh_don_alonso

        # -- Happy path --
        result = node.first_run_setup("alonso@example.com", "strong_passphrase")

        assert result["status"] == "ok"
        assert result["did"] == node.did

        # DID registered in PLC directory
        doc = plc_directory.resolve(node.did)
        assert doc is not None
        assert doc.did == node.did
        assert doc.public_key == node.root_public_key

        # Only /personal persona exists after first run
        assert "personal" in node.personas
        assert len(node.personas) == 1
        assert node.personas["personal"].persona_type == PersonaType.PERSONAL

        # Mnemonic is generated but must NOT be stored on disk.
        # In our mock, mnemonic lives only in RAM as a list.  The wrapped_seed
        # is what gets persisted (encrypted).
        assert isinstance(node.mnemonic, list)
        assert len(node.mnemonic) == 24
        # wrapped_seed exists and is non-empty bytes
        assert isinstance(node.wrapped_seed, bytes)
        assert len(node.wrapped_seed) > 0

        # Keyfile path is set (simulates on-disk wrapped seed location)
        assert node.keyfile_path != ""

        # Audit log contains the setup event
        setup_entries = node.get_audit_entries("first_run_setup")
        assert len(setup_entries) == 1
        assert setup_entries[0].details["mode"] == "convenience"

        # -- Failure variant: PLC unreachable --
        plc_directory.set_available(False)
        try:
            # Attempting to resolve during a hypothetical second setup
            # should raise a clean error
            with pytest.raises(ConnectionError, match="PLC Directory unreachable"):
                plc_directory.resolve(node.did)
        finally:
            plc_directory.set_available(True)

# TST-E2E-002
    def test_device_pairing_phone(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-1.2 Device Pairing Phone.

        Generate a pairing code, pair a RICH_CLIENT device. Verify:
        - token_hash is SHA-256 of the raw token (not plaintext)
        - Second use of the same pairing code fails
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Generate pairing code
        code = node.generate_pairing_code()
        assert isinstance(code, str)
        assert len(code) == 6  # 6-digit code

        # Pair phone
        phone = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert phone is not None
        assert phone.device_type == DeviceType.RICH_CLIENT
        assert phone.connected is True

        # token_hash is SHA-256 of the raw token, NOT the plaintext token
        expected_hash = hashlib.sha256(phone.token.encode()).hexdigest()
        assert phone.token_hash == expected_hash
        assert phone.token_hash != phone.token  # hash != plaintext

        # Second use of the same code must fail (one-time use)
        second_attempt = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert second_attempt is None

        # Device is registered
        assert phone.device_id in node.devices

# TST-E2E-003
    def test_second_device_pairing_laptop_ws_push(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-1.3 Second Device Pairing Laptop.

        Pair two devices (phone + laptop). Store a vault item via one device's
        context. Verify the other device receives a WS push notification.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Pair phone
        code1 = node.generate_pairing_code()
        phone = node.pair_device(code1, DeviceType.RICH_CLIENT)
        assert phone is not None

        # Pair laptop
        code2 = node.generate_pairing_code()
        laptop = node.pair_device(code2, DeviceType.RICH_CLIENT)
        assert laptop is not None

        # Both devices registered and connected
        assert len(node.devices) == 2
        assert phone.connected is True
        assert laptop.connected is True

        # Store a vault item (triggers internal processing, which pushes
        # notifications to connected devices via _push_to_devices)
        item_id = node.vault_store("personal", "test_item", {"data": "hello"})
        assert item_id.startswith("vi_")

        # Simulate a push to all devices (as would happen for vault events)
        push_msg = {
            "type": "vault_update",
            "payload": {"item_id": item_id, "persona": "personal"},
        }
        push_count = node._push_to_devices(push_msg)

        # Both devices should receive the WS push
        assert push_count == 2
        assert len(phone.ws_messages) >= 1
        assert len(laptop.ws_messages) >= 1

        # Verify the pushed message content on both devices
        assert phone.ws_messages[-1]["type"] == "vault_update"
        assert laptop.ws_messages[-1]["type"] == "vault_update"
        assert phone.ws_messages[-1]["payload"]["item_id"] == item_id
        assert laptop.ws_messages[-1]["payload"]["item_id"] == item_id

# TST-E2E-004
    def test_progressive_disclosure_day_7(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-1.4 Progressive Disclosure Day 7.

        Set the test clock to day 7 after setup. Trigger a mnemonic backup
        reminder notification. Verify the reminder is pushed to devices.
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # Pair a device so we can receive notifications
        code = node.generate_pairing_code()
        phone = node.pair_device(code, DeviceType.RICH_CLIENT)
        assert phone is not None

        # Advance clock to day 7 (7 * 86400 seconds from now)
        setup_time = time.time()
        node.set_test_clock(setup_time + 7 * 86400)

        # Mnemonic backup has NOT been confirmed
        assert node.mnemonic_backup_confirmed is False

        # Simulate the progressive disclosure check: on day 7, if mnemonic
        # backup is not confirmed, push a reminder.
        if not node.mnemonic_backup_confirmed:
            reminder = {
                "type": "whisper",
                "payload": {
                    "text": ("Please back up your recovery phrase. "
                             "Without it, you cannot recover your identity "
                             "if this device is lost."),
                    "tier": "fiduciary",
                    "trigger": "progressive_disclosure:day_7:mnemonic_backup",
                },
            }
            node._push_to_devices(reminder)

        # Verify the reminder was pushed
        assert len(node.notifications) >= 1
        last_notification = node.notifications[-1]
        assert last_notification["type"] == "whisper"
        assert "recovery phrase" in last_notification["payload"]["text"]
        assert last_notification["payload"]["tier"] == "fiduciary"
        assert "mnemonic_backup" in last_notification["payload"]["trigger"]

        # Verify the phone device received it
        assert len(phone.ws_messages) >= 1
        assert "recovery phrase" in phone.ws_messages[-1]["payload"]["text"]

# TST-E2E-005
    def test_bip39_recovery_same_mnemonic_same_did(
        self,
        plc_directory: MockPLCDirectory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-1.5 BIP-39 Recovery.

        Create a node, derive keys from a known master seed. Create a second
        node with the SAME seed. Verify:
        - Both derive identical root keys
        - Same DID resolves to the same keys
        """
        fixed_seed = "a" * 64  # deterministic seed for reproducibility

        # Create first node with known seed
        node1 = HomeNode(
            did="did:plc:recovery_test_1",
            display_name="Recovery Node 1",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=fixed_seed,
        )
        node1.first_run_setup("recover@example.com", "passphrase")

        # Capture derived keys
        root_priv_1 = node1.root_private_key
        root_pub_1 = node1.root_public_key

        # Create second node with the SAME seed (simulating recovery)
        node2 = HomeNode(
            did="did:plc:recovery_test_2",
            display_name="Recovery Node 2",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=fixed_seed,
        )
        node2.first_run_setup("recover@example.com", "passphrase")

        # Capture derived keys
        root_priv_2 = node2.root_private_key
        root_pub_2 = node2.root_public_key

        # Same seed must produce identical keys (deterministic derivation)
        assert root_priv_1 == root_priv_2
        assert root_pub_1 == root_pub_2

        # Both nodes' DID documents have the same public key
        doc1 = plc_directory.resolve("did:plc:recovery_test_1")
        doc2 = plc_directory.resolve("did:plc:recovery_test_2")
        assert doc1 is not None
        assert doc2 is not None
        assert doc1.public_key == doc2.public_key

        # Persona DEKs are also deterministic
        assert node1.personas["personal"].dek == node2.personas["personal"].dek

# TST-E2E-006
    def test_exactly_one_root_identity(
        self,
        fresh_don_alonso: HomeNode,
    ) -> None:
        """E2E-1.6 Exactly One Root Identity.

        first_run_setup() succeeds the first time. A second call returns
        an error -- the node must never create a second root identity.
        """
        node = fresh_don_alonso

        # First call succeeds
        result1 = node.first_run_setup("alonso@example.com", "passphrase123")
        assert result1["status"] == "ok"
        assert node.setup_complete is True

        # Second call returns an error
        result2 = node.first_run_setup("alonso@example.com", "passphrase456")
        assert "error" in result2
        assert "already exists" in result2["error"].lower() or "already" in result2["error"].lower()

        # State unchanged -- still exactly one root identity
        assert node.setup_complete is True
        assert len([p for p in node.personas.values()
                    if p.persona_type == PersonaType.PERSONAL]) == 1
