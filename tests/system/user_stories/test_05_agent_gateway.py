"""User Story 05: The Agent Gateway — External Agent Safety Layer.

SEQUENTIAL TEST — tests MUST run in order (00 → 09).
Each test builds on state from the previous one.

Story
-----
An external agent (OpenClaw, Claude, a custom bot) wants to act on behalf of
the user. It pairs with the Home Node via ``dina configure`` (Ed25519 keypair
+ 6-digit code) and submits every intent via ``dina validate`` to Dina's
Guardian for review.

CLI commands and the APIs they call:

  ``dina configure``  → POST /v1/pair/complete (keypair + 6-digit code)
  ``dina validate``   → POST /v1/agent/validate (Core proxies to Brain's Guardian)
  ``dina remember``   → POST /v1/vault/store
  ``dina recall``     → POST /v1/vault/query
  ``dina scrub``      → POST /api/v1/pii/scrub

Core proxies ``/v1/agent/validate`` to Brain's Guardian internally — the CLI
authenticates to Core via Ed25519 device auth, and Core forwards using its
internal token. Brain stays non-public.

Dina:

  1. **Pairs** the agent — ``dina configure`` (6-digit code ceremony).
  2. **Auto-approves** safe intents — ``dina validate search "product reviews"``
  3. **Flags** moderate intents — ``dina validate send_email "order confirmation"``
  4. **Flags** high-risk intents — ``dina validate share_data "third party"``
  5. **Rejects** unauthenticated agents — 401 before reaching Guardian.
  6. **Denies** blocked actions — ``dina validate read_vault "export all data"``
  7. **Enforces** persona isolation — vault compartments are cryptographic.
  8. **Revokes** agent device — token immediately invalidated.

Why Dina is unique
------------------
OpenClaw and similar agents operate without oversight — they hold keys, see
full history, and act without guardrails. Dina's Agent Safety Layer ensures
that ANY agent, regardless of origin, submits intent for review before acting.
Safe tasks pass silently. Risky actions require human approval. The agent
never holds your Home Node or vault keys, never sees your full history, and
never acts without oversight.

Two integration paths exist today:

1. **CLI path** — OpenClaw calls ``dina validate <action> <description>``
   which sends an ``agent_intent`` event to Core's ``/v1/agent/validate``.
   Core proxies to Brain's Guardian internally. The CLI is a paired device
   (Ed25519 signed requests) — no BRAIN_TOKEN needed on the client.
2. **MCP path** — Brain pulls data from OpenClaw connectors via MCP stdio
   (``sync_engine.py``), triages it, and stores relevant items in the vault.

Pipeline
--------
::

  OpenClaw runs: dina validate send_email "Send order confirmation"
    → CLI calls POST /v1/agent/validate {type: agent_intent, action: send_email}
    → Core proxies to Brain's Guardian: MODERATE → flag_for_review
    → CLI returns: {"status": "pending_approval", "risk": "MODERATE"}
    → OpenClaw waits for human approval before sending the email
"""

from __future__ import annotations

import os

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


class TestAgentGateway:
    """The Agent Gateway: external agent safety layer."""

    # ==================================================================
    # test_00: Register external agent via pairing ceremony
    # ==================================================================

    # TST-USR-040
    def test_00_register_agent_via_pairing(
        self, alonso_core, admin_headers,
    ):
        """External agent pairs with the Home Node — equivalent of ``dina configure``.

        CLI flow: ``dina configure`` prompts for a pairing code (displayed on
        admin UI or another paired device), generates an Ed25519 keypair, and
        calls POST /v1/pair/complete with public_key_multibase.

        Here we test the underlying APIs directly:
        POST /v1/pair/initiate → get 6-digit code (admin-side, not CLI)
        POST /v1/pair/complete → register device, get token (this is what CLI calls)
        """
        # Step 1: Initiate pairing
        init_r = httpx.post(
            f"{alonso_core}/v1/pair/initiate",
            json={},
            headers=admin_headers,
            timeout=10,
        )
        assert init_r.status_code == 200, (
            f"Initiate pairing failed: {init_r.status_code} {init_r.text[:200]}"
        )
        code = init_r.json().get("code", "")
        assert len(code) > 0, "No pairing code returned"

        # Step 2: Generate Ed25519 keypair for the agent and complete pairing
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        import base58

        agent_key = Ed25519PrivateKey.generate()
        agent_pub_raw = agent_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        # Multibase: 'z' prefix + base58btc(0xed01 + raw_pubkey)
        multicodec = b"\xed\x01" + agent_pub_raw
        public_key_multibase = "z" + base58.b58encode(multicodec).decode("ascii")

        complete_r = httpx.post(
            f"{alonso_core}/v1/pair/complete",
            json={
                "code": code,
                "device_name": "external_agent_v1",
                "public_key_multibase": public_key_multibase,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert complete_r.status_code == 200, (
            f"Complete pairing failed: {complete_r.status_code} {complete_r.text[:200]}"
        )
        data = complete_r.json()

        device_id = data.get("device_id", "")
        node_did = data.get("node_did", "")

        assert device_id, f"No device_id in response: {list(data.keys())}"

        _state["agent_device_id"] = device_id
        _state["agent_token"] = public_key_multibase  # used as truthy check by later tests
        _state["agent_private_key"] = agent_key  # for signed request verification
        _state["agent_did"] = f"did:key:{public_key_multibase}"
        _state["agent_device_name"] = "external_agent_v1"
        _state["node_did"] = node_did

    # ==================================================================
    # test_01: Verify agent appears in device list
    # ==================================================================

    # TST-USR-041
    def test_01_verify_agent_in_device_list(
        self, alonso_core, admin_headers,
    ):
        """The paired agent must appear in GET /v1/devices.

        We look for the device name 'external_agent_v1' in the list.
        """
        r = httpx.get(
            f"{alonso_core}/v1/devices",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"List devices failed: {r.status_code} {r.text[:200]}"
        )
        devices = r.json().get("devices", [])
        agent_name = _state.get("agent_device_name", "external_agent_v1")

        found = any(
            d.get("name", "") == agent_name
            for d in devices
        )
        assert found, (
            f"Agent '{agent_name}' not found in device list.\n"
            f"Devices: {[d.get('name', '') for d in devices]}"
        )

    # ==================================================================
    # test_02: Safe intent → auto_approve
    # ==================================================================

    # TST-USR-042
    def test_02_safe_intent_auto_approved(
        self, alonso_core, admin_headers,
    ):
        """Safe action auto-approved — ``dina validate search "product reviews"``.

        CLI sends POST /v1/agent/validate {type: agent_intent, action: search}.
        Core proxies to Brain's Guardian: SAFE → auto_approve, no human needed.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkExternalAgent001",
                "action": "search",
                "target": "product reviews",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        assert data.get("action") == "auto_approve", (
            f"Expected auto_approve, got: {data.get('action')}"
        )
        assert data.get("risk") == "SAFE", (
            f"Expected SAFE risk, got: {data.get('risk')}"
        )
        assert data.get("approved") is True, (
            f"Expected approved=True, got: {data.get('approved')}"
        )
        assert data.get("requires_approval") is False, (
            f"Expected requires_approval=False, got: {data.get('requires_approval')}"
        )

    # ==================================================================
    # test_03: Moderate intent → flag_for_review
    # ==================================================================

    # TST-USR-043
    def test_03_moderate_intent_flagged(
        self, alonso_core, admin_headers,
    ):
        """Moderate action flagged — ``dina validate send_email "order confirmation"``.

        CLI sends POST /v1/agent/validate {type: agent_intent, action: send_email}.
        Core proxies to Brain's Guardian: MODERATE → flag_for_review, human must approve.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkExternalAgent002",
                "action": "send_email",
                "target": "user@example.com",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        assert data.get("action") == "flag_for_review", (
            f"Expected flag_for_review, got: {data.get('action')}"
        )
        assert data.get("risk") == "MODERATE", (
            f"Expected MODERATE risk, got: {data.get('risk')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )
        assert data.get("requires_approval") is True, (
            f"Expected requires_approval=True, got: {data.get('requires_approval')}"
        )

    # ==================================================================
    # test_04: High-risk intent → flag_for_review
    # ==================================================================

    # TST-USR-044
    def test_04_high_risk_intent_flagged(
        self, alonso_core, admin_headers,
    ):
        """High-risk action flagged — ``dina validate share_data "third party"``.

        CLI sends POST /v1/agent/validate {type: agent_intent, action: share_data}.
        Core proxies to Brain's Guardian: HIGH → flag_for_review, human must approve.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkExternalAgent003",
                "action": "share_data",
                "target": "third_party_service",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        assert data.get("action") == "flag_for_review", (
            f"Expected flag_for_review, got: {data.get('action')}"
        )
        assert data.get("risk") == "HIGH", (
            f"Expected HIGH risk, got: {data.get('risk')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )
        assert data.get("requires_approval") is True, (
            f"Expected requires_approval=True, got: {data.get('requires_approval')}"
        )

    # ==================================================================
    # test_05: Untrusted agent → deny (regardless of action)
    # ==================================================================

    # TST-USR-045
    def test_05_unauthenticated_agent_rejected(
        self, alonso_core,
    ):
        """Unauthenticated agent rejected — no auth headers → 401.

        An untrusted/unpaired agent cannot even reach the Guardian. Core's
        auth middleware rejects the request before it reaches the handler.
        This is stronger than Guardian's trust_level check: the request
        never leaves Core.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkUntrustedBot",
                "action": "search",
                "target": "anything",
            },
            # No auth headers — unauthenticated request.
            timeout=15,
        )
        assert r.status_code == 401, (
            f"Expected 401 for unauthenticated request, got: {r.status_code}\n"
            f"Response: {r.text[:300]}"
        )

    # ==================================================================
    # test_06: Blocked action → deny (even for verified agent)
    # ==================================================================

    # TST-USR-046
    def test_06_blocked_action_denied(
        self, alonso_core, admin_headers,
    ):
        """Blocked action denied — ``dina validate read_vault`` always fails.

        read_vault is categorically blocked. Even a verified, paired agent
        cannot read the vault directly. action: "read_vault" → deny, BLOCKED.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkVerifiedAgent",
                "action": "read_vault",
                "target": "personal_vault",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        assert data.get("action") == "deny", (
            f"Expected deny, got: {data.get('action')}"
        )
        assert data.get("risk") == "BLOCKED", (
            f"Expected BLOCKED risk, got: {data.get('risk')}"
        )

    # ==================================================================
    # test_07: Export data → deny (second blocked action)
    # ==================================================================

    # TST-USR-047
    def test_07_export_data_blocked(
        self, alonso_core, admin_headers,
    ):
        """Export blocked — ``dina validate export_data`` always fails.

        export_data is categorically blocked, same as read_vault and access_keys.
        action: "export_data" → deny, BLOCKED.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkVerifiedAgent",
                "action": "export_data",
                "target": "external_service",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        assert data.get("action") == "deny", (
            f"Expected deny, got: {data.get('action')}"
        )
        assert data.get("risk") == "BLOCKED", (
            f"Expected BLOCKED risk, got: {data.get('risk')}"
        )

    # ==================================================================
    # test_08: Agent cannot cross personas (vault isolation)
    # ==================================================================

    # TST-USR-048
    def test_08_agent_cannot_cross_personas(
        self, alonso_core, admin_headers,
    ):
        """Vault isolation — ``dina recall`` in consumer cannot see health data.

        An agent paired to the consumer persona calls ``dina recall "health data"``
        (POST /v1/vault/query, persona=consumer). The health persona's vault is a
        separate encrypted database — nothing leaks across.
        """
        # Store a distinctive item in health persona
        store_r = httpx.post(
            f"{alonso_core}/v1/vault/store",
            json={
                "persona": "health",
                "item": {
                    "Type": "note",
                    "Source": "agent_gateway_test",
                    "Summary": "Agent gateway test secret health data xK9mQ",
                    "BodyText": "This is secret health data for agent gateway test xK9mQ.",
                },
            },
            headers=admin_headers,
            timeout=10,
        )
        assert store_r.status_code in (200, 201), (
            f"Store failed: {store_r.status_code} {store_r.text[:200]}"
        )

        # Query from consumer persona — should NOT find health data
        query_r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "consumer",
                "query": "agent gateway test secret xK9mQ",
                "mode": "fts5",
                "limit": 10,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert query_r.status_code == 200, (
            f"Query failed: {query_r.status_code} {query_r.text[:200]}"
        )
        items = query_r.json().get("items") or []

        # Verify no health data leaked to consumer persona
        leaked = [
            item for item in items
            if "xK9mQ" in str(item)
        ]
        assert len(leaked) == 0, (
            f"Health data leaked to consumer persona!\n"
            f"Found {len(leaked)} items containing test marker: {leaked}"
        )

    # ==================================================================
    # test_09: Revoke agent device → token invalidated
    # ==================================================================

    # TST-USR-049
    def test_09_revoke_agent_device(
        self, alonso_core, admin_headers,
    ):
        """Revoke agent — after DELETE /v1/devices/{id}, device is removed.

        Admin revokes the device via its device_id. After revocation,
        the device no longer appears in the device list.
        """
        agent_token = _state.get("agent_token", "")
        device_id = _state.get("agent_device_id", "")
        assert agent_token, "No agent_token — test_00 must pass first"
        assert device_id, "No agent_device_id — test_00 must pass first"

        # Step 0: Verify signed request WORKS before revoke
        import hashlib
        from datetime import datetime, timezone

        priv_key = _state.get("agent_private_key")
        agent_did = _state.get("agent_did", "")
        if priv_key and agent_did:
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            nonce = os.urandom(16).hex()
            body_hash = hashlib.sha256(b"").hexdigest()
            canonical = f"GET\n/v1/personas\n\n{ts}\n{nonce}\n{body_hash}"
            sig = priv_key.sign(canonical.encode()).hex()
            pre_r = httpx.get(
                f"{alonso_core}/v1/personas",
                headers={
                    "X-DID": agent_did,
                    "X-Timestamp": ts,
                    "X-Nonce": nonce,
                    "X-Signature": sig,
                },
                timeout=10,
            )
            assert pre_r.status_code == 200, (
                f"Signed request BEFORE revoke should succeed, got "
                f"{pre_r.status_code}. Pairing may not have registered the key."
            )

        # Step 1: Revoke the device
        revoke_r = httpx.delete(
            f"{alonso_core}/v1/devices/{device_id}",
            headers=admin_headers,
            timeout=10,
        )
        assert revoke_r.status_code == 204, (
            f"Revoke failed: {revoke_r.status_code} {revoke_r.text[:200]}"
        )

        # Step 2: Verify device is marked as revoked
        list_r = httpx.get(
            f"{alonso_core}/v1/devices",
            headers=admin_headers,
            timeout=10,
        )
        assert list_r.status_code == 200
        devices = list_r.json().get("devices", [])
        agent_name = _state.get("agent_device_name", "external_agent_v1")
        agent_device = next(
            (d for d in devices if d.get("name", "") == agent_name),
            None,
        )
        assert agent_device is not None, (
            f"Agent '{agent_name}' not found in device list after revocation.\n"
            f"Devices: {devices}"
        )
        assert agent_device.get("revoked", False) is True, (
            f"Agent device should be revoked but is not.\n"
            f"Device: {agent_device}"
        )

        # Step 3: Verify revoked device is actually rejected via signed request.
        priv_key = _state.get("agent_private_key")
        agent_did = _state.get("agent_did", "")
        if priv_key and agent_did:
            def _sign_and_get(label: str) -> httpx.Response:
                ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                nonce = os.urandom(16).hex()
                body_hash = hashlib.sha256(b"").hexdigest()
                canonical = f"GET\n/v1/personas\n\n{ts}\n{nonce}\n{body_hash}"
                sig = priv_key.sign(canonical.encode()).hex()
                return httpx.get(
                    f"{alonso_core}/v1/personas",
                    headers={
                        "X-DID": agent_did,
                        "X-Timestamp": ts,
                        "X-Nonce": nonce,
                        "X-Signature": sig,
                    },
                    timeout=10,
                )

            # The device is already revoked (Step 1). Signed request must fail.
            post_r = _sign_and_get("after-revoke")
            assert post_r.status_code == 401, (
                f"Revoked device signed request should get 401, got "
                f"{post_r.status_code}. Revocation did not invalidate auth."
            )
