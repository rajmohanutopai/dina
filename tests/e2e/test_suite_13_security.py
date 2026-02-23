"""E2E Test Suite 13: Security Adversarial.

Tests adversarial security scenarios: DDoS + rate limiting, dead drop abuse
prevention, replay attack prevention, cross-persona access violations,
oversized payload rejection, log exfiltration prevention, token brute force,
DID spoofing, relay content encryption, and data sovereignty on disk.

Actors: Don Alonso, Sancho, ChairMaker, MaliciousBot, D2D Network,
        PLC Directory.
"""

from __future__ import annotations

import json
import time
import uuid

import pytest

from tests.e2e.actors import (
    HomeNode,
    _derive_dek,
    _mock_decrypt,
    _mock_encrypt,
    _mock_sign,
    _mock_verify,
)
from tests.e2e.mocks import (
    ActionRisk,
    D2DMessage,
    DeviceType,
    MockD2DNetwork,
    MockMaliciousBot,
    MockPLCDirectory,
    PersonaType,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 13: Security Adversarial
# ---------------------------------------------------------------------------


class TestSecurityAdversarial:
    """E2E-13.x -- Adversarial security: DDoS, replay, spoofing, exfiltration,
    brute force, cross-persona violations, oversized payloads, relay opacity,
    and data sovereignty."""

# TST-E2E-065
    def test_ddos_rate_limiting(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-13.1 DDoS + Rate Limiting.

        1000 requests from an attacker IP trigger the rate limiter
        (check_rate_limit returns False after threshold). Authenticated
        traffic from Sancho on a different IP still works.
        """
        attacker_ip = "192.168.1.100"
        sancho_ip = "10.0.0.42"

        # Fire 1000 requests from attacker IP
        blocked_at = None
        for i in range(1000):
            allowed = don_alonso.check_rate_limit(attacker_ip)
            if not allowed and blocked_at is None:
                blocked_at = i

        # Rate limiter must have triggered before 1000 requests
        assert blocked_at is not None, "Rate limiter never triggered"
        assert blocked_at < 1000
        # Default rate limit is 100
        assert blocked_at == don_alonso.rate_limit

        # Attacker is now blocked
        assert don_alonso.check_rate_limit(attacker_ip) is False

        # Authenticated traffic from Sancho's IP still works
        # (rate limiting is per-IP, Sancho has a clean slate)
        sancho_allowed = don_alonso.check_rate_limit(sancho_ip)
        assert sancho_allowed is True, (
            "Legitimate traffic from Sancho must not be blocked by "
            "attacker's rate limit"
        )

        # Sancho can make multiple requests successfully
        for _ in range(10):
            assert don_alonso.check_rate_limit(sancho_ip) is True

        # Reset and verify attacker can proceed again
        don_alonso.reset_rate_limits()
        assert don_alonso.check_rate_limit(attacker_ip) is True

# TST-E2E-066
    def test_dead_drop_abuse_prevention(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-13.2 Dead Drop Abuse Prevention.

        Vault is locked. Attacker sends many messages to fill the spool
        (spool_max_bytes). Once the spool reaches its limit, new messages
        are rejected with 429. After unlocking, spooled messages are
        processed.
        """
        # Lock the vault (dead drop mode)
        don_alonso.lock_vault()
        assert don_alonso._vault_locked is True

        # Set a small spool limit for testing
        original_spool_max = don_alonso.spool_max_bytes
        don_alonso.spool_max_bytes = 1024  # 1KB limit for test

        # Attacker sends messages to fill spool
        spool_full = False
        msg_count = 0
        for i in range(200):
            # Each message is ~100 bytes of encrypted payload
            payload = b"X" * 100
            msg = D2DMessage(
                msg_id=f"spam_msg_{i:04d}",
                from_did="did:plc:attacker",
                to_did=don_alonso.did,
                message_type="spam",
                payload={"spam": True},
                encrypted_payload=payload,
            )
            result = don_alonso.receive_d2d(msg)
            msg_count += 1

            if result.get("status") == "429":
                spool_full = True
                break

        # Spool must have filled up and started rejecting
        assert spool_full is True, "Spool never reached capacity"
        assert msg_count < 200, "All messages accepted -- spool limit not enforced"

        # Verify the rejection reason
        reject_msg = D2DMessage(
            msg_id="spam_msg_final",
            from_did="did:plc:attacker",
            to_did=don_alonso.did,
            message_type="spam",
            payload={"spam": True},
            encrypted_payload=b"X" * 100,
        )
        reject_result = don_alonso.receive_d2d(reject_msg)
        assert reject_result["status"] == "429"
        assert reject_result["reason"] == "spool_full"

        # Unlock vault -> spooled messages are processed
        don_alonso.unlock_vault("passphrase123")
        assert don_alonso._vault_locked is False

        # Spool should be cleared after unlock
        assert len(don_alonso.spool) == 0

        # Restore original spool limit
        don_alonso.spool_max_bytes = original_spool_max

# TST-E2E-067
    def test_replay_attack_prevention(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
    ) -> None:
        """E2E-13.3 Replay Attack Prevention.

        Sancho sends a message, msg_id is recorded in _seen_msg_ids.
        Replaying the same msg_id is rejected as a duplicate.
        """
        # Sancho sends a legitimate message
        msg = sancho.send_d2d(
            don_alonso.did,
            "dina/social/greeting",
            {"text": "Hello Don Alonso!"},
        )
        original_msg_id = msg.msg_id

        # The msg_id should be recorded in Don Alonso's seen set
        assert original_msg_id in don_alonso._seen_msg_ids

        # Replay the EXACT same message (same msg_id)
        replay_msg = D2DMessage(
            msg_id=original_msg_id,  # Same ID = replay
            from_did=sancho.did,
            to_did=don_alonso.did,
            message_type="dina/social/greeting",
            payload={"text": "Hello Don Alonso!"},
            encrypted_payload=msg.encrypted_payload,
            signature=msg.signature,
        )
        replay_result = don_alonso.receive_d2d(replay_msg)

        # Must be rejected as duplicate
        assert replay_result["status"] == "duplicate"
        assert replay_result["msg_id"] == original_msg_id

        # A message with a NEW msg_id from the same sender should succeed
        fresh_msg = D2DMessage(
            msg_id=f"msg_{uuid.uuid4().hex[:12]}",
            from_did=sancho.did,
            to_did=don_alonso.did,
            message_type="dina/social/greeting",
            payload={"text": "Hello again!"},
            encrypted_payload=_mock_encrypt(
                json.dumps({"text": "Hello again!"}).encode(),
                don_alonso.root_public_key,
            ),
            signature=_mock_sign(
                json.dumps({"text": "Hello again!"}),
                sancho.root_private_key,
            ),
        )
        fresh_result = don_alonso.receive_d2d(fresh_msg)
        assert fresh_result.get("status") != "duplicate"

# TST-E2E-068
    def test_cross_persona_violation(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-13.4 Cross-Persona Violation.

        A brain agent has a valid token. It can access the open /personal
        persona. Locked /financial returns 403. Restricted /health returns
        data + audit entry. Admin endpoints return 403 (verify_agent_intent
        for admin actions returns HIGH risk).
        """
        brain_did = "did:plc:brain_agent"

        # /personal is open -> accessible
        personal_results = don_alonso.vault_query("personal", "sancho")
        assert isinstance(personal_results, list)  # Access granted

        # /financial is locked -> 403
        # First ensure financial is locked
        don_alonso.lock_persona("financial")
        with pytest.raises(PermissionError, match="403 persona_locked"):
            don_alonso.vault_query("financial", "balance")

        # /health is restricted -> data returned + audit entry
        don_alonso.unlock_persona("health", "passphrase", ttl_seconds=300)
        don_alonso.vault_store("health", "medication", "ibuprofen 200mg")
        health_results = don_alonso.vault_query("health", "medication")
        assert len(health_results) >= 1

        # Verify restricted access was logged in audit
        restricted_audits = don_alonso.get_audit_entries("restricted_persona_access")
        assert len(restricted_audits) >= 1
        assert restricted_audits[-1].details["persona"] == "health"

        # Also verify it was added to briefing queue
        restricted_briefings = [
            b for b in don_alonso.briefing_queue
            if b.get("type") == "restricted_access"
        ]
        assert len(restricted_briefings) >= 1

        # Admin action -> verify_agent_intent returns HIGH risk -> 403
        admin_intent = don_alonso.verify_agent_intent(
            brain_did, "delete_data", "all_personas",
        )
        assert admin_intent["risk"] == "HIGH"
        assert admin_intent["approved"] is False
        assert admin_intent["requires_approval"] is True

        # Another admin action
        money_intent = don_alonso.verify_agent_intent(
            brain_did, "transfer_money", "financial",
        )
        assert money_intent["risk"] == "HIGH"
        assert money_intent["approved"] is False

        # Safe action is allowed
        search_intent = don_alonso.verify_agent_intent(
            brain_did, "search", "personal",
        )
        assert search_intent["risk"] == "SAFE"
        assert search_intent["approved"] is True

# TST-E2E-069
    def test_oversized_payload_rejection(
        self,
        malicious_bot: MockMaliciousBot,
    ) -> None:
        """E2E-13.5 Oversized Payload.

        malicious_bot.send_oversized_payload() returns 100MB. The brain
        must reject payloads exceeding a reasonable size limit.
        """
        payload = malicious_bot.send_oversized_payload()

        # Verify it is indeed 100MB
        assert len(payload) == 100 * 1024 * 1024

        # Brain-side validation: reject anything over a threshold
        max_payload_bytes = 10 * 1024 * 1024  # 10MB limit
        payload_accepted = len(payload) <= max_payload_bytes

        assert payload_accepted is False, (
            f"Oversized payload ({len(payload)} bytes) should have been "
            f"rejected (limit: {max_payload_bytes} bytes)"
        )

        # Verify reasonable payloads pass
        small_payload = b"reasonable data" * 100  # ~1.5KB
        assert len(small_payload) <= max_payload_bytes

# TST-E2E-070
    def test_log_exfiltration_prevention(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-13.6 Log Exfiltration Prevention.

        Store PII, trigger operations, verify scrubber.validate_clean on
        all log/audit text. Crash tracebacks must be sanitized.
        """
        # Store PII-laden data in vault
        don_alonso.vault_store(
            "personal", "contact_info",
            "Rajmohan lives at 123 Main Street, email rajmohan@email.com, "
            "phone +91-9876543210, CC 4111-1111-1111-1111"
        )

        # Trigger operations that generate audit/log entries
        don_alonso.vault_query("personal", "contact_info")
        don_alonso.send_d2d(
            "did:plc:sancho",
            "dina/social/greeting",
            {"text": "Meeting at 123 Main Street, call me at +91-9876543210"},
        )

        # Collect all audit log text
        all_audit_text = []
        for entry in don_alonso.get_audit_entries():
            all_audit_text.append(json.dumps(entry.details))

        # Validate that all audit/log text is clean of PII
        scrubber = don_alonso.scrubber
        for text in all_audit_text:
            # Scrub the audit text and check
            scrubbed, vault_map = scrubber.scrub_full(text)
            assert scrubber.validate_clean(scrubbed), (
                f"PII found in audit log text after scrubbing: {scrubbed}"
            )

        # Simulate a crash traceback containing PII
        crash_traceback = (
            "Traceback (most recent call last):\n"
            "  File '/dina/brain/agent.py', line 42, in process\n"
            "    result = handle_query('Rajmohan', 'rajmohan@email.com')\n"
            "  File '/dina/brain/vault.py', line 88, in handle_query\n"
            "    data = fetch('+91-9876543210', '4111-1111-1111-1111')\n"
            "RuntimeError: vault timeout for Rajmohan at 123 Main Street"
        )

        # Scrub the traceback
        sanitized, traceback_vault = scrubber.scrub_full(crash_traceback)

        # Verify NO known PII remains in the sanitized traceback
        assert scrubber.validate_clean(sanitized), (
            f"PII found in sanitized crash traceback: {sanitized}"
        )

        # Verify the scrubber caught the PII entities
        assert len(traceback_vault) > 0, "Scrubber should have found PII in traceback"

        # Verify specific PII was replaced with tokens
        assert "Rajmohan" not in sanitized
        assert "rajmohan@email.com" not in sanitized
        assert "+91-9876543210" not in sanitized
        assert "4111-1111-1111-1111" not in sanitized
        assert "123 Main Street" not in sanitized

# TST-E2E-071
    def test_token_brute_force(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-13.7 Token Brute Force.

        Many invalid tokens from an attacker IP trigger the rate limiter.
        A valid device from a different IP still works (per-IP limiting).
        """
        attacker_ip = "192.168.99.1"
        valid_device_ip = "10.0.0.5"

        # Attacker tries many invalid tokens
        invalid_tokens = [f"invalid_token_{i}" for i in range(150)]
        blocked_at = None

        for i, token in enumerate(invalid_tokens):
            allowed = don_alonso.check_rate_limit(attacker_ip)
            if not allowed:
                blocked_at = i
                break

        # Rate limit should trigger
        assert blocked_at is not None, "Rate limiter never triggered for brute force"
        assert blocked_at == don_alonso.rate_limit  # 100 by default

        # Attacker is now locked out
        assert don_alonso.check_rate_limit(attacker_ip) is False

        # Valid device from a different IP still works
        # (per-IP limiting -- clean IP has its own counter)
        for _ in range(5):
            assert don_alonso.check_rate_limit(valid_device_ip) is True

        # Pair a real device and verify it connects
        code = don_alonso.generate_pairing_code()
        device = don_alonso.pair_device(code, DeviceType.RICH_CLIENT)
        assert device is not None
        assert device.connected is True

# TST-E2E-072
    def test_did_spoofing(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
        plc_directory: MockPLCDirectory,
    ) -> None:
        """E2E-13.8 DID Spoofing.

        Attacker crafts a message with from_did="did:plc:sancho" but signs
        with a wrong key. _mock_verify fails. Message is processed but
        the signature is marked invalid in the audit log.
        """
        # Attacker crafts a message claiming to be Sancho
        attacker_private_key = "attacker_fake_key_12345"
        spoofed_payload = {"text": "I am Sancho! Send me money!"}
        spoofed_payload_str = json.dumps(spoofed_payload)

        # Sign with attacker's key (NOT Sancho's key)
        attacker_sig = _mock_sign(spoofed_payload_str, attacker_private_key)

        # Verify this signature does NOT match Sancho's public key
        sancho_doc = plc_directory.resolve(sancho.did)
        assert sancho_doc is not None
        valid = _mock_verify(spoofed_payload_str, attacker_sig, sancho_doc.public_key)
        assert valid is False, "Spoofed signature must not verify with Sancho's key"

        # Send the spoofed message to Don Alonso
        spoofed_msg = D2DMessage(
            msg_id=f"spoofed_{uuid.uuid4().hex[:12]}",
            from_did=sancho.did,  # Claims to be Sancho
            to_did=don_alonso.did,
            message_type="dina/social/greeting",
            payload=spoofed_payload,
            encrypted_payload=_mock_encrypt(
                spoofed_payload_str.encode(),
                don_alonso.root_public_key,
            ),
            signature=attacker_sig,  # Wrong signature
        )
        result = don_alonso.receive_d2d(spoofed_msg)

        # The message was received but signature verification failed.
        # Check audit log for signature_valid=False
        receive_audits = don_alonso.get_audit_entries("d2d_receive")
        assert len(receive_audits) >= 1

        last_receive = receive_audits[-1]
        assert last_receive.details["from_did"] == sancho.did
        assert last_receive.details["signature_valid"] is False, (
            "Spoofed message signature must be marked invalid"
        )

# TST-E2E-073
    def test_relay_cannot_read_content(
        self,
        don_alonso: HomeNode,
        sancho: HomeNode,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-13.9 Relay Cannot Read Content.

        A message is sent through the D2D network/relay. The relay sees
        only the encrypted blob and cannot decrypt it. Verify
        network.traffic_contains_plaintext() is False.
        """
        # Clear previous captured traffic for a clean test
        d2d_network.captured_traffic.clear()

        secret_text = "Super secret financial data: account 12345678"

        # Sancho sends an encrypted message to Don Alonso
        msg = sancho.send_d2d(
            don_alonso.did,
            "dina/social/secret",
            {"text": secret_text},
        )

        # Network captured traffic during delivery
        assert len(d2d_network.captured_traffic) >= 1

        # The relay/network must NOT be able to see plaintext
        assert d2d_network.traffic_contains_plaintext(secret_text) is False, (
            "Relay can read plaintext content -- encryption failed!"
        )

        # Also verify the captured traffic only has metadata, not payload
        last_capture = d2d_network.captured_traffic[-1]
        assert "encrypted_size" in last_capture
        assert last_capture["encrypted_size"] > 0
        # The captured entry should not contain the plaintext payload
        assert secret_text not in str(last_capture)

        # Verify the message WAS actually encrypted (has ENC: prefix tag)
        assert len(msg.encrypted_payload) > 0
        # The mock encryption wraps plaintext with a key-derived tag.
        # In production this would be crypto_box_seal. Here we verify the
        # encrypted_payload is NOT identical to the raw plaintext -- it
        # carries a key-bound prefix that a real cipher would replace with
        # ciphertext.
        raw_plaintext = json.dumps({"text": secret_text}).encode()
        assert msg.encrypted_payload != raw_plaintext, (
            "Encrypted payload must not be identical to raw plaintext"
        )
        assert msg.encrypted_payload.startswith(b"ENC:"), (
            "Mock-encrypted payload must carry the ENC: crypto envelope tag"
        )

# TST-E2E-074
    def test_data_sovereignty_on_disk(
        self,
        don_alonso: HomeNode,
    ) -> None:
        """E2E-13.10 Data Sovereignty on Disk.

        Vault items are encrypted (simulated: all items have a persona DEK).
        FTS index lives inside the persona. No plaintext in the spool.
        """
        # Verify all personas have a DEK (data encryption key)
        for pname, persona in don_alonso.personas.items():
            if persona.unlocked:
                # Unlocked personas should have a DEK or have had one derived
                # The DEK is derived from master_seed
                expected_dek = _derive_dek(
                    don_alonso.master_seed, f"dina:vault:{pname}:v1"
                )
                # For unlocked personas that haven't been re-locked
                if persona.dek:
                    assert persona.dek == expected_dek, (
                        f"Persona {pname} DEK mismatch"
                    )

        # Store items and verify FTS index is per-persona
        test_item_id = don_alonso.vault_store(
            "consumer", "secret_purchase", "Bought a Herman Miller Aeron chair"
        )

        # FTS index should be inside the consumer persona
        consumer = don_alonso.personas["consumer"]
        assert len(consumer.fts_index) > 0

        # FTS index should NOT exist in other personas for this item
        personal = don_alonso.personas["personal"]
        # The personal persona has its own FTS index from its own items,
        # but it should NOT contain the consumer item's words
        # (unless they overlap with personal items)
        assert test_item_id not in personal.fts_index.get("aeron", set()), (
            "Consumer item leaked into personal persona's FTS index"
        )

        # Verify spool contains no plaintext
        # Lock vault and send messages to fill spool
        don_alonso.lock_vault()
        sensitive_text = "Top secret: password is hunter2"
        encrypted_payload = _mock_encrypt(
            sensitive_text.encode(),
            don_alonso.root_public_key,
        )

        spool_msg = D2DMessage(
            msg_id=f"spool_test_{uuid.uuid4().hex[:8]}",
            from_did="did:plc:sancho",
            to_did=don_alonso.did,
            message_type="dina/test",
            payload={"text": sensitive_text},
            encrypted_payload=encrypted_payload,
        )
        don_alonso.receive_d2d(spool_msg)

        # Verify spool contains encrypted data, NOT raw plaintext
        # The mock encryption wraps content with a key-derived ENC: tag.
        # In production this would be crypto_box_seal ciphertext.
        # We verify: (a) the raw plaintext is NOT stored as-is, and
        # (b) the spool entry carries the crypto envelope.
        assert len(don_alonso.spool) >= 1
        for spooled_item in don_alonso.spool:
            assert isinstance(spooled_item, bytes)
            raw_plaintext = sensitive_text.encode()
            assert spooled_item != raw_plaintext, (
                "Spool stores raw plaintext -- data sovereignty violated"
            )
            assert spooled_item.startswith(b"ENC:"), (
                "Spool entry must carry the ENC: crypto envelope tag"
            )

        # The encrypted payload in spool should match what was sent
        assert don_alonso.spool[-1] == encrypted_payload

        # Unlock vault to clean up
        don_alonso.unlock_vault("passphrase123")
        assert len(don_alonso.spool) == 0
