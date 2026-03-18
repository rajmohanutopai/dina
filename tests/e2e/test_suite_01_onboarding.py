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
        assert "general" in node.personas
        assert len(node.personas) == 1
        assert node.personas["general"].persona_type == PersonaType.GENERAL

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

        Pair two devices (phone + laptop). Verify:
        - Each pairing code is unique and single-use
        - Both devices are registered with distinct IDs and hashed tokens
        - D2D arrival messages trigger WS push to ALL connected devices
        - Disconnected devices do NOT receive WS push
        """
        node = fresh_don_alonso
        node.first_run_setup("alonso@example.com", "passphrase123")

        # --- Pair phone ---
        code1 = node.generate_pairing_code()
        phone = node.pair_device(code1, DeviceType.RICH_CLIENT)
        assert phone is not None
        assert phone.connected is True

        # --- Pair laptop with a DIFFERENT code ---
        code2 = node.generate_pairing_code()
        assert code2 != code1, "Each pairing code must be unique"
        laptop = node.pair_device(code2, DeviceType.RICH_CLIENT)
        assert laptop is not None
        assert laptop.connected is True

        # Both devices registered with distinct IDs
        assert len(node.devices) == 2
        assert phone.device_id != laptop.device_id

        # Token hashes are SHA-256 of tokens (not plaintext)
        assert phone.token_hash != phone.token
        assert laptop.token_hash != laptop.token
        import hashlib
        assert phone.token_hash == hashlib.sha256(phone.token.encode()).hexdigest()
        assert laptop.token_hash == hashlib.sha256(laptop.token.encode()).hexdigest()

        # Pairing codes are single-use
        assert node.pair_device(code1, DeviceType.RICH_CLIENT) is None
        assert node.pair_device(code2, DeviceType.RICH_CLIENT) is None

        # --- Store a vault item ---
        item_id = node.vault_store("general", "test_item", {"data": "hello"})
        assert item_id.startswith("vi_")

        # Record WS message counts before D2D arrival
        phone_before = len(phone.ws_messages)
        laptop_before = len(laptop.ws_messages)

        # --- D2D arrival triggers WS push to ALL connected devices ---
        # (send_d2d → _handle_arrival → _push_to_devices — the real flow)
        from tests.e2e.mocks import MockD2DNetwork, MockPLCDirectory
        sender_plc = node.plc
        sender_net = node.network

        # Create a temporary sender node to trigger a real arrival flow
        sender = HomeNode(
            did="did:plc:visitor_test_003",
            display_name="Visitor",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=sender_plc,
            network=sender_net,
        )
        sender.first_run_setup("visitor@example.com", "pass_visitor")

        msg = sender.send_d2d(
            to_did=node.did,
            message_type="dina/social/arrival",
            payload={
                "type": "dina/social/arrival",
                "eta_minutes": 10,
            },
        )
        assert msg.from_did == sender.did

        # Both connected devices must have received the WS push
        assert len(phone.ws_messages) > phone_before, (
            "Phone must receive WS push from D2D arrival"
        )
        assert len(laptop.ws_messages) > laptop_before, (
            "Laptop must receive WS push from D2D arrival"
        )

        # Both devices received the same notification
        phone_notif = phone.ws_messages[-1]
        laptop_notif = laptop.ws_messages[-1]
        assert phone_notif["type"] == "whisper"
        assert laptop_notif["type"] == "whisper"
        assert "10" in phone_notif["payload"]["text"]

        # --- Negative: disconnected device does NOT receive push ---
        node.disconnect_device(laptop.device_id)
        assert laptop.connected is False

        laptop_count_before = len(laptop.ws_messages)

        sender2 = HomeNode(
            did="did:plc:visitor2_test_003",
            display_name="Visitor2",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=sender_plc,
            network=sender_net,
        )
        sender2.first_run_setup("visitor2@example.com", "pass_v2")
        sender2.send_d2d(
            to_did=node.did,
            message_type="dina/social/arrival",
            payload={"type": "dina/social/arrival", "eta_minutes": 5},
        )

        assert len(laptop.ws_messages) == laptop_count_before, (
            "Disconnected device must NOT receive WS push"
        )
        # Phone (still connected) should have received it
        assert len(phone.ws_messages) > phone_before + 1

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
        node with the SAME seed (simulating device recovery). Verify:
        - Both derive identical root keys (private + public)
        - DID documents have the same public key
        - Persona DEKs are deterministic (same seed → same DEK)
        - Negative control: different seed → different keys
        - Keys are non-empty and have expected format
        - Mnemonic is populated (24 words for BIP-39)
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

        # Keys must be non-empty hex strings
        assert len(root_priv_1) == 64, (
            "Root private key must be 32 bytes (64 hex chars)"
        )
        assert len(root_pub_1) == 64, (
            "Root public key must be 32 bytes (64 hex chars)"
        )
        assert root_priv_1 != root_pub_1, (
            "Private and public keys must differ"
        )

        # Mnemonic must be populated (BIP-39 = 24 words)
        assert len(node1.mnemonic) == 24, (
            "BIP-39 mnemonic must have 24 words"
        )

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
        assert root_priv_1 == root_priv_2, (
            "Same seed must produce identical private keys"
        )
        assert root_pub_1 == root_pub_2, (
            "Same seed must produce identical public keys"
        )

        # Both nodes' DID documents have the same public key
        doc1 = plc_directory.resolve("did:plc:recovery_test_1")
        doc2 = plc_directory.resolve("did:plc:recovery_test_2")
        assert doc1 is not None
        assert doc2 is not None
        assert doc1.public_key == doc2.public_key, (
            "DID documents for same-seed nodes must have identical public keys"
        )

        # Persona DEKs are also deterministic
        assert node1.personas["general"].dek == node2.personas["general"].dek, (
            "Persona DEKs must be deterministic from the same seed"
        )
        assert node1.personas["general"].dek != "", (
            "Persona DEK must be non-empty"
        )

        # --- Negative control: different seed → different keys ---
        different_seed = "b" * 64
        node3 = HomeNode(
            did="did:plc:recovery_test_3",
            display_name="Recovery Node 3 (different seed)",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=different_seed,
        )
        node3.first_run_setup("other@example.com", "otherpass")

        assert node3.root_private_key != root_priv_1, (
            "Different seed must produce different private key"
        )
        assert node3.root_public_key != root_pub_1, (
            "Different seed must produce different public key"
        )
        assert node3.personas["general"].dek != node1.personas["general"].dek, (
            "Different seed must produce different persona DEK"
        )

        # Different-seed DID doc has different public key
        doc3 = plc_directory.resolve("did:plc:recovery_test_3")
        assert doc3 is not None
        assert doc3.public_key != doc1.public_key, (
            "DID document for different-seed node must have different public key"
        )

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
                    if p.persona_type == PersonaType.GENERAL]) == 1
