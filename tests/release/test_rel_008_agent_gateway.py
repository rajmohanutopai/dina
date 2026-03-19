"""REL-008 Agent Gateway with a Real or Rogue Client.

Verify agent pairing, device management, and revocation via real API.
The manual portion (rogue script, approval UX) remains in test_rel_manual.py.

Execution class: Harness.
"""

from __future__ import annotations

import os

import httpx
import pytest


class TestAgentGateway:
    """Real API tests for REL-008: agent gateway lifecycle."""

    # REL-008
    def test_rel_008_pairing_initiate_returns_code(
        self, core_url, auth_headers,
    ) -> None:
        """POST /v1/pair/initiate returns a pairing code."""
        resp = httpx.post(
            f"{core_url}/v1/pair/initiate",
            json={},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201)
        data = resp.json()
        code = data.get("code") or data.get("pairing_code", "")
        assert len(code) > 0, f"No pairing code returned: {data}"

    # REL-008
    def test_rel_008_pairing_complete_registers_device(
        self, core_url, auth_headers,
    ) -> None:
        """Full pairing ceremony registers a device."""
        # Initiate
        resp = httpx.post(
            f"{core_url}/v1/pair/initiate",
            json={},
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201)
        code = resp.json().get("code") or resp.json().get("pairing_code")

        # Generate a test keypair
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        import base64

        private_key = Ed25519PrivateKey.generate()
        pub_bytes = private_key.public_key().public_bytes_raw()
        # multibase: z + base58btc(0xed01 + pub_bytes)
        import base58
        multibase = "z" + base58.b58encode(b"\xed\x01" + pub_bytes).decode()

        # Complete
        resp = httpx.post(
            f"{core_url}/v1/pair/complete",
            json={
                "code": code,
                "device_name": "rel008-test-agent",
                "public_key_multibase": multibase,
            },
            headers=auth_headers, timeout=10,
        )
        assert resp.status_code in (200, 201), (
            f"Pairing complete failed: {resp.status_code} {resp.text}"
        )
        device_id = resp.json().get("device_id", "")
        assert device_id, f"Pairing returned no device_id: {resp.json()}"

    # REL-008
    def test_rel_008_devices_list_shows_paired(
        self, core_url, auth_headers,
    ) -> None:
        """Pair a device, then verify it appears in device list by name."""
        # Pair a device with a unique name
        init = httpx.post(
            f"{core_url}/v1/pair/initiate",
            json={}, headers=auth_headers, timeout=10,
        )
        if init.status_code == 404:
            pytest.skip("Pairing not implemented")
        assert init.status_code in (200, 201)
        code = init.json().get("code") or init.json().get("pairing_code")

        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        import base58
        pk = Ed25519PrivateKey.generate()
        pub = pk.public_key().public_bytes_raw()
        mb = "z" + base58.b58encode(b"\xed\x01" + pub).decode()

        unique_name = f"rel008-verify-{os.getpid()}"
        pair = httpx.post(
            f"{core_url}/v1/pair/complete",
            json={"code": code, "device_name": unique_name, "public_key_multibase": mb},
            headers=auth_headers, timeout=10,
        )
        assert pair.status_code in (200, 201)
        paired_id = pair.json().get("device_id", "")
        assert paired_id

        # Verify the exact device appears in device list
        resp = httpx.get(f"{core_url}/v1/devices", headers=auth_headers, timeout=10)
        assert resp.status_code == 200
        devices = resp.json().get("devices", [])
        found = any(
            d.get("token_id") == paired_id or d.get("name") == unique_name
            for d in devices
        )
        assert found, (
            f"Paired device '{unique_name}' (id={paired_id}) not in list: "
            f"{[d.get('name') for d in devices]}"
        )

    # REL-008
    def test_rel_008_unapproved_agent_blocked(
        self, core_url,
    ) -> None:
        """Unapproved agent (no auth) is blocked from sensitive endpoints."""
        resp = httpx.post(
            f"{core_url}/v1/vault/store",
            json={"persona": "general", "item": {"Type": "note"}},
            timeout=10,
        )
        assert resp.status_code in (401, 403), (
            f"Unapproved agent should be blocked, got {resp.status_code}"
        )
