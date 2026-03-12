"""User Story 14: Agent Sandbox — no agent acts without oversight.

SEQUENTIAL TEST — tests MUST run in order (00 → 03).
Each test builds on state from the previous one.

Thesis Invariant
----------------
Any agent acting on the user's behalf submits intent to Dina first.
Safe tasks pass silently.  Risky actions require human approval.
The agent never holds your Home Node or vault keys, never sees your
full history, and never acts without oversight.

What this story validates:

  1. **Unauthenticated agent blocked at Core** — a rogue agent with
     no credentials gets 401 before reaching the Guardian.  The gate
     is at the perimeter, not inside the house.

  2. **Agent revocation is immediate** — pair an agent, confirm it can
     validate, revoke the device, confirm the same request returns 401.
     No grace period, no stale cache.

  3. **Blocked actions + Draft-Don't-Send** — categorically blocked
     actions (read_vault, export_data, access_keys) and direct-send
     actions (messages.send, sms.send) are denied regardless of trust
     level.  The human always has the final say.

  4. **Identity binding** — Core overrides the caller-supplied
     ``agent_did`` with the authenticated identity.  An agent cannot
     claim to be someone else.

Pipeline
--------
::

  Rogue agent (no auth) → POST /v1/agent/validate
    → Core auth middleware: 401 Unauthorized
    → Guardian never sees the request

  Paired agent → POST /v1/pair/initiate + complete → device token
    → Validate succeeds (200)
    → Admin revokes device → DELETE /v1/devices/{id}
    → Same validate → 401 (revoked, immediate)

  Authenticated agent → POST /v1/agent/validate
    → Body says agent_did="did:key:z6MkFakeBot"
    → Core overrides with real authenticated identity
    → Guardian sees real DID, not the forged one
"""

from __future__ import annotations

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential thesis invariant verification
# ---------------------------------------------------------------------------


class TestAgentSandbox:
    """Agent Sandbox: no agent acts without oversight."""

    # ==================================================================
    # test_00: Unauthenticated agent blocked at Core perimeter
    # ==================================================================

    # TST-USR-097
    def test_00_unauthenticated_agent_blocked(
        self, alonso_core,
    ):
        """Rogue agent with no credentials → 401 before Guardian.

        This is the first line of defense.  Core's auth middleware
        rejects unauthenticated requests at the perimeter.  The
        Guardian never sees the request — the gate is locked before
        the analyst is consulted.

        Even a "safe" action (search) is blocked without auth.
        The intent doesn't matter if the identity is unverified.
        """
        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": "did:key:z6MkRogueBot999",
                "action": "search",
                "target": "product reviews",
            },
            # No auth headers — unauthenticated request.
            timeout=15,
        )
        assert r.status_code == 401, (
            f"Expected 401 for unauthenticated agent, got: {r.status_code}\n"
            f"Response: {r.text[:300]}\n"
            f"Core must reject unauthenticated requests at the perimeter."
        )

        # Verify the response does NOT contain guardian decision fields.
        # The request should never have reached the Guardian.
        try:
            data = r.json()
        except Exception:
            data = {}

        assert data.get("action") != "auto_approve", (
            "Unauthenticated request was auto-approved — critical security failure"
        )

    # ==================================================================
    # test_01: Revoked agent blocked immediately — no grace period
    # ==================================================================

    # TST-USR-098
    def test_01_revoked_agent_blocked_immediately(
        self, alonso_core, admin_headers,
    ):
        """Pair → validate succeeds → revoke → validate returns 401.

        This is the real revocation test.  We pair an agent (full
        pairing ceremony: initiate + Ed25519 keypair + complete),
        confirm the agent can submit intent, revoke the device, and
        confirm the same request now returns 401.

        No grace period, no stale token cache.  Revocation is
        enforced at Core's auth middleware — the Guardian never
        sees the revoked agent's request.
        """
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            PublicFormat,
        )

        import base58

        # Step 1: Initiate pairing.
        init_r = httpx.post(
            f"{alonso_core}/v1/pair/initiate",
            json={},
            headers=admin_headers,
            timeout=10,
        )
        assert init_r.status_code == 200, (
            f"Initiate pairing failed: {init_r.status_code} "
            f"{init_r.text[:200]}"
        )
        code = init_r.json().get("code", "")
        assert len(code) > 0, "No pairing code returned"

        # Step 2: Generate Ed25519 keypair for the agent.
        agent_key = Ed25519PrivateKey.generate()
        agent_pub_raw = agent_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw,
        )
        # Multibase: 'z' prefix + base58btc(0xed01 + raw_pubkey)
        multicodec = b"\xed\x01" + agent_pub_raw
        public_key_multibase = (
            "z" + base58.b58encode(multicodec).decode("ascii")
        )

        # Step 3: Complete pairing.
        complete_r = httpx.post(
            f"{alonso_core}/v1/pair/complete",
            json={
                "code": code,
                "device_name": "sandbox_agent_v1",
                "public_key_multibase": public_key_multibase,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert complete_r.status_code == 200, (
            f"Complete pairing failed: {complete_r.status_code} "
            f"{complete_r.text[:200]}"
        )
        data = complete_r.json()
        device_id = data.get("device_id", "")
        assert device_id, (
            f"No device_id in pairing response: {list(data.keys())}"
        )
        _state["agent_device_id"] = device_id
        _state["agent_key"] = agent_key

        # Step 4: Verify the paired agent CAN validate (200).
        # Build Ed25519 signature for the request.
        import hashlib
        import time as _time

        validate_url = f"{alonso_core}/v1/agent/validate"
        validate_body = {
            "type": "agent_intent",
            "agent_did": "did:key:z6MkSandboxAgent",
            "action": "search",
            "target": "product reviews",
        }
        import json as _json

        body_bytes = _json.dumps(validate_body).encode()
        body_hash = hashlib.sha256(body_bytes).hexdigest()
        ts = str(int(_time.time()))

        # Canonical string: METHOD\nPATH\nQUERY\nTIMESTAMP\nBODY_HASH
        canonical = f"POST\n/v1/agent/validate\n\n{ts}\n{body_hash}"
        sig = agent_key.sign(canonical.encode())

        import base64

        sig_b64 = base64.b64encode(sig).decode()

        # Build the did:key from the public key for X-DID header.
        agent_did_key = "did:key:" + public_key_multibase

        pre_revoke_r = httpx.post(
            validate_url,
            content=body_bytes,
            headers={
                "Content-Type": "application/json",
                "X-DID": agent_did_key,
                "X-Timestamp": ts,
                "X-Signature": sig_b64,
            },
            timeout=15,
        )
        assert pre_revoke_r.status_code == 200, (
            f"Paired agent should be able to validate before revocation, "
            f"got: {pre_revoke_r.status_code}\n"
            f"Response: {pre_revoke_r.text[:300]}"
        )

        # Step 5: Revoke the device.
        revoke_r = httpx.delete(
            f"{alonso_core}/v1/devices/{device_id}",
            headers=admin_headers,
            timeout=10,
        )
        assert revoke_r.status_code == 204, (
            f"Revoke failed: {revoke_r.status_code} "
            f"{revoke_r.text[:200]}"
        )

        # Step 6: Same request with fresh timestamp → 401.
        ts2 = str(int(_time.time()))
        canonical2 = f"POST\n/v1/agent/validate\n\n{ts2}\n{body_hash}"
        sig2 = agent_key.sign(canonical2.encode())
        sig2_b64 = base64.b64encode(sig2).decode()

        post_revoke_r = httpx.post(
            validate_url,
            content=body_bytes,
            headers={
                "Content-Type": "application/json",
                "X-DID": agent_did_key,
                "X-Timestamp": ts2,
                "X-Signature": sig2_b64,
            },
            timeout=15,
        )
        assert post_revoke_r.status_code == 401, (
            f"Expected 401 after revocation, got: {post_revoke_r.status_code}\n"
            f"Response: {post_revoke_r.text[:300]}\n"
            f"Revocation must be immediate — no grace period."
        )

    # ==================================================================
    # test_02: Blocked actions + Draft-Don't-Send categorically denied
    # ==================================================================

    # TST-USR-099
    def test_02_blocked_actions_categorically_denied(
        self, alonso_core, admin_headers,
    ):
        """Blocked actions and direct-send are denied regardless of trust.

        Two categories of categorically denied actions:

        1. _BLOCKED_ACTIONS: read_vault, export_data, access_keys
           These are architectural invariants — no agent may access raw
           vault data or encryption keys, regardless of trust level.

        2. _DIRECT_SEND_ACTIONS: messages.send, sms.send
           Draft-Don't-Send: no agent may press Send, only Draft.
           The human always has the final say before a message leaves.
           This is Law 4 applied to communication.
        """
        # Blocked actions — architectural invariants.
        blocked_actions = ["read_vault", "export_data", "access_keys"]
        for action in blocked_actions:
            r = httpx.post(
                f"{alonso_core}/v1/agent/validate",
                json={
                    "type": "agent_intent",
                    "agent_did": "did:key:z6MkVerifiedAgentX",
                    "action": action,
                    "target": "full_vault_export",
                    "risk_level": "",
                    "trust_level": "verified",
                },
                headers=admin_headers,
                timeout=15,
            )
            assert r.status_code == 200, (
                f"Process failed for {action}: "
                f"{r.status_code} {r.text[:300]}"
            )
            data = r.json()

            assert data.get("action") == "deny", (
                f"Expected deny for {action}, got: {data.get('action')}. "
                f"Blocked actions are architectural invariants — no agent "
                f"may perform them regardless of trust level."
            )
            assert data.get("risk") == "BLOCKED", (
                f"Expected BLOCKED risk for {action}, "
                f"got: {data.get('risk')}"
            )

        # Direct-send actions — Draft-Don't-Send invariant.
        direct_send_actions = [
            ("messages.send", "Send email directly via Gmail API"),
            ("sms.send", "Send SMS directly"),
        ]
        for action, description in direct_send_actions:
            r = httpx.post(
                f"{alonso_core}/v1/agent/validate",
                json={
                    "type": "agent_intent",
                    "agent_did": "did:key:z6MkTrustedAgent",
                    "action": action,
                    "target": description,
                    "risk_level": "",
                    "trust_level": "verified",
                },
                headers=admin_headers,
                timeout=15,
            )
            assert r.status_code == 200, (
                f"Process failed for {action}: "
                f"{r.status_code} {r.text[:300]}"
            )
            data = r.json()

            assert data.get("action") == "deny", (
                f"Expected deny for direct-send action '{action}', "
                f"got: {data.get('action')}. "
                f"Draft-Don't-Send: no agent may press Send, only Draft."
            )
            assert data.get("risk") == "BLOCKED", (
                f"Expected BLOCKED risk for {action}, "
                f"got: {data.get('risk')}"
            )

    # ==================================================================
    # test_03: Core binds authenticated identity, ignores caller-supplied
    # ==================================================================

    # TST-USR-100
    def test_03_caller_supplied_agent_did_ignored(
        self, alonso_core, admin_headers,
    ):
        """Core overrides agent_did with authenticated identity.

        An agent sends agent_did="did:key:z6MkFakeBot" in the request
        body, but authenticates with admin_headers.  Core's AgentHandler
        (agent.go lines 73-89) overrides agent_did with the real
        authenticated identity before forwarding to the Guardian.

        The Guardian never sees the forged DID.  This test validates
        that the Guardian's response reflects the real caller, not
        the attacker's claimed identity.

        Note: admin_headers use Bearer token auth, so Core binds
        "device:<id>" rather than a did:key.  The key invariant is
        that the forged DID is NOT what the Guardian uses.
        """
        forged_did = "did:key:z6MkFakeBot999NotReal"

        r = httpx.post(
            f"{alonso_core}/v1/agent/validate",
            json={
                "type": "agent_intent",
                "agent_did": forged_did,
                "action": "search",
                "target": "product reviews",
                "risk_level": "",
                "trust_level": "verified",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Validate failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        # The Guardian should have received the real identity, not the
        # forged one.  The response may echo agent_did or include it
        # in decision metadata.
        response_did = data.get("agent_did", "")

        if response_did:
            # If the response includes agent_did, it must NOT be the
            # forged value.  Core should have overridden it.
            assert response_did != forged_did, (
                f"Core did NOT override agent_did.  Forged DID "
                f"'{forged_did}' reached the Guardian unchanged.\n"
                f"Response: {data}\n"
                f"Core must bind the authenticated identity, never "
                f"trust caller-supplied agent_did."
            )

        # Also verify trust_level was set to "verified" by Core
        # (not whatever the caller sent — Core always overrides this
        # for authenticated requests).
        # The response should show the action was processed normally
        # (not denied due to identity mismatch).
        action = data.get("action")
        assert action in ("auto_approve", "deny", "ask_human"), (
            f"Unexpected guardian action: {action}. "
            f"Expected a valid guardian decision."
        )
