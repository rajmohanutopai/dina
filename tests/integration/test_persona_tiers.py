"""Integration tests for 4-tier persona access control.

These tests run against real Core + Brain Docker containers.
They test the full HTTP flow: create persona → start session → query →
approval_required → approve → query succeeds → end session → denied.

Set DINA_INTEGRATION=docker to run against real containers.
"""

from __future__ import annotations

import hashlib
import json
import os
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

pytestmark = pytest.mark.skipif(not DOCKER_MODE, reason="requires Docker")


@pytest.fixture
def core(docker_services):
    """Core URL + auth headers."""
    return {
        "url": docker_services.core_url,
        "headers": {"Authorization": f"Bearer {docker_services.client_token}"},
    }


def _post(core, path, body=None):
    return httpx.post(
        f"{core['url']}{path}",
        json=body or {},
        headers=core["headers"],
        timeout=10,
    )


def _get(core, path, params=None):
    return httpx.get(
        f"{core['url']}{path}",
        params=params,
        headers=core["headers"],
        timeout=10,
    )


# ---------------------------------------------------------------------------
# Tier validation
# ---------------------------------------------------------------------------


class TestTierValidation:
    """POST /v1/personas accepts only valid tier names."""

    def test_create_with_valid_tiers(self, core) -> None:
        """All 4 tiers accepted."""
        for tier in ("default", "standard", "sensitive", "locked"):
            name = f"tier_valid_{tier}_{int(time.time())}"
            resp = _post(core, "/v1/personas", {"name": name, "tier": tier, "passphrase": "test1234"})
            assert resp.status_code in (201, 409), f"{tier}: {resp.status_code} {resp.text}"

    def test_reject_legacy_tiers(self, core) -> None:
        """Legacy 'open' and 'restricted' are rejected."""
        for tier in ("open", "restricted", "invalid", ""):
            resp = _post(core, "/v1/personas", {"name": f"tier_bad_{tier}", "tier": tier, "passphrase": "test1234"})
            assert resp.status_code == 400, f"{tier}: expected 400, got {resp.status_code}"

    def test_default_persona_vault_auto_opens(self, core) -> None:
        """Default-tier persona reports vault=open on creation."""
        name = f"auto_open_{int(time.time())}"
        resp = _post(core, "/v1/personas", {"name": name, "tier": "default", "passphrase": "test1234"})
        if resp.status_code == 201:
            data = resp.json()
            assert data.get("vault") == "open", f"expected vault=open: {data}"

    def test_standard_persona_vault_auto_opens(self, core) -> None:
        """Standard-tier persona reports vault=open on creation."""
        name = f"std_open_{int(time.time())}"
        resp = _post(core, "/v1/personas", {"name": name, "tier": "standard", "passphrase": "test1234"})
        if resp.status_code == 201:
            data = resp.json()
            assert data.get("vault") == "open", f"expected vault=open: {data}"


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    """POST /v1/session/start, /end, GET /v1/sessions."""

    def test_session_start(self, core) -> None:
        """Starting a session returns active session with ID and name."""
        name = f"sess_{int(time.time())}"
        resp = _post(core, "/v1/session/start", {"name": name})
        assert resp.status_code == 201, f"start: {resp.text}"
        data = resp.json()
        assert data["name"] == name
        assert data["status"] == "active"
        assert "id" in data

        # Cleanup
        _post(core, "/v1/session/end", {"name": name})

    def test_session_reconnect(self, core) -> None:
        """Starting same-name session returns existing (reconnect)."""
        name = f"reconnect_{int(time.time())}"
        r1 = _post(core, "/v1/session/start", {"name": name})
        r2 = _post(core, "/v1/session/start", {"name": name})
        assert r1.json()["id"] == r2.json()["id"]
        _post(core, "/v1/session/end", {"name": name})

    def test_session_list(self, core) -> None:
        """GET /v1/sessions lists active sessions."""
        name = f"listme_{int(time.time())}"
        _post(core, "/v1/session/start", {"name": name})
        resp = _get(core, "/v1/sessions")
        assert resp.status_code == 200
        names = [s["name"] for s in resp.json().get("sessions", [])]
        assert name in names
        _post(core, "/v1/session/end", {"name": name})

    def test_session_end(self, core) -> None:
        """Ending a session removes it from active list."""
        name = f"endme_{int(time.time())}"
        _post(core, "/v1/session/start", {"name": name})
        resp = _post(core, "/v1/session/end", {"name": name})
        assert resp.status_code == 200

        # Verify gone from active list
        resp = _get(core, "/v1/sessions")
        names = [s["name"] for s in resp.json().get("sessions", [])]
        assert name not in names


# ---------------------------------------------------------------------------
# Approval lifecycle
# ---------------------------------------------------------------------------


class TestApprovalLifecycle:
    """POST /v1/persona/approve, /deny, GET /v1/persona/approvals."""

    def test_list_pending_approvals(self, core) -> None:
        """GET /v1/persona/approvals returns list."""
        resp = _get(core, "/v1/persona/approvals")
        assert resp.status_code == 200
        data = resp.json()
        assert "approvals" in data

    def test_deny_nonexistent_returns_404(self, core) -> None:
        """Denying a nonexistent approval returns 404."""
        resp = _post(core, "/v1/persona/deny", {"id": "nonexistent-id"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Vault query with persona tier enforcement
# ---------------------------------------------------------------------------


class TestVaultTierEnforcement:
    """Vault query respects persona tier based on caller type."""

    def test_query_general_persona_succeeds(self, core) -> None:
        """Query on 'general' (default tier) succeeds for admin."""
        resp = _post(core, "/v1/vault/query", {
            "persona": "general", "query": "test", "mode": "fts5",
        })
        # Should succeed (200) or return empty results — not 403
        assert resp.status_code == 200, f"general query failed: {resp.text}"

    def test_query_standard_persona_succeeds_for_admin(self, core) -> None:
        """Query on standard tier succeeds for admin (CallerType=user)."""
        # Create a standard persona
        name = f"std_q_{int(time.time())}"
        _post(core, "/v1/personas", {"name": name, "tier": "standard", "passphrase": "test1234"})

        resp = _post(core, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 200, f"standard query failed: {resp.text}"

    def test_query_locked_persona_returns_403(self, core) -> None:
        """Query on locked tier returns 403 (vault not open)."""
        # Create locked persona (not unlocked)
        name = f"locked_q_{int(time.time())}"
        _post(core, "/v1/personas", {"name": name, "tier": "locked", "passphrase": "test1234"})

        resp = _post(core, "/v1/vault/query", {
            "persona": name, "query": "test", "mode": "fts5",
        })
        assert resp.status_code == 403, f"locked query should fail: {resp.text}"


# ---------------------------------------------------------------------------
# Device-signed tests
# ---------------------------------------------------------------------------


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sign_request(
    priv: Ed25519PrivateKey, method: str, path: str,
    query: str, timestamp: str, nonce: str, body: bytes,
) -> str:
    """Build canonical payload and sign with Ed25519 (same as Go Core)."""
    body_hash = _sha256_hex(body)
    payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
    sig = priv.sign(payload.encode())
    return sig.hex()


def _device_post(
    core_url: str, priv: Ed25519PrivateKey, did: str,
    path: str, body: dict, *, session: str = "",
) -> httpx.Response:
    """Send a device-signed POST request to Core."""
    import secrets
    body_bytes = json.dumps(body).encode()
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    nonce = secrets.token_hex(16)
    sig_hex = _sign_request(priv, "POST", path, "", timestamp, nonce, body_bytes)
    headers = {
        "X-DID": did,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": sig_hex,
        "Content-Type": "application/json",
    }
    if session:
        headers["X-Session"] = session
    return httpx.post(
        f"{core_url}{path}", content=body_bytes, headers=headers, timeout=30,
    )


def _pair_device_fixture(core_url, admin_headers):
    """Generate Ed25519 keypair, pair with Core, return (priv, did, device_id).

    The returned device_id is what Core stores as the identity for this
    device (auth.go:275 returns it from VerifySignature). The session
    handler uses this value — not the full did:key — as agent_did.
    """
    priv = Ed25519PrivateKey.generate()
    pub_raw = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    pub_prefixed = b"\xed\x01" + pub_raw

    import base58
    did = "did:key:z" + base58.b58encode(pub_prefixed).decode()

    # Initiate pairing.
    r1 = httpx.post(
        f"{core_url}/v1/pair/initiate",
        headers=admin_headers, timeout=10,
    )
    assert r1.status_code == 200, f"initiate: {r1.text}"
    code = r1.json()["code"]

    # Complete pairing with public key.
    pub_multibase = "z" + base58.b58encode(pub_prefixed).decode()
    r2 = httpx.post(
        f"{core_url}/v1/pair/complete",
        json={
            "code": code,
            "device_name": "test-agent",
            "public_key_multibase": pub_multibase,
        },
        headers=admin_headers, timeout=10,
    )
    assert r2.status_code == 200, f"complete: {r2.text}"
    device_id = r2.json()["device_id"]

    return priv, did, device_id


class TestDeviceSignedAgentContext:
    """Verify device-signed requests produce correct agent context.

    Proves auth middleware correctly derives CallerType=agent and
    AgentDID from Ed25519-signed HTTP requests.

    Key identity contract: VerifySignature returns the registered
    device_id (e.g. "tok-1"), not the DID. Middleware stores that
    as AgentDIDKey (auth.go:132). Session handlers use it.
    """

    @pytest.fixture(autouse=True)
    def _pair(self, core, docker_services):
        self._core_url = docker_services.core_url
        self._admin_headers = core["headers"]
        self._priv, self._did, self._device_id = _pair_device_fixture(
            self._core_url, self._admin_headers,
        )

    def test_session_scoped_to_device_id(self):
        """Session agent_did equals the registered device_id, not the DID."""
        sess_name = f"sig_sess_{int(time.time())}"
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/session/start", {"name": sess_name},
        )
        assert r.status_code == 201, f"session start: {r.status_code} {r.text}"
        data = r.json()
        assert data["name"] == sess_name
        assert data["status"] == "active"
        assert data.get("agent_did") == self._device_id, (
            f"session agent_did must be device_id {self._device_id!r}, got: {data}"
        )

        _device_post(
            self._core_url, self._priv, self._did,
            "/v1/session/end", {"name": sess_name},
        )

    def test_vault_read_blocked_by_authz(self):
        """Device-scoped agents cannot read vaults directly (persona-blind)."""
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/vault/query",
            {"persona": "general", "query": "test", "mode": "fts5"},
        )
        assert r.status_code == 403, (
            f"vault read must be blocked: {r.status_code} {r.text}"
        )

    def test_staging_ingest_allowed(self):
        """Phase 4: device-scoped agents write via staging, not vault/store."""
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/staging/ingest",
            {
                "source": "dina-cli",
                "source_id": "test-device-write",
                "type": "note",
                "summary": "test note from device",
                "body": "test body",
                "sender": "user",
            },
        )
        assert r.status_code == 201, (
            f"staging ingest must succeed: {r.status_code} {r.text}"
        )
        assert r.json().get("staged") is True

    def test_reason_endpoint_not_blocked(self):
        """Device-signed /api/v1/reason passes authz (in device allowlist).

        This only proves authz admission, not full approval propagation
        through Brain. The full Brain-mediated read path is tested
        deterministically by TestBrainMediatedApprovalPath, which uses
        Brain's service key + X-Agent-DID on /v1/vault/query — the
        exact Core endpoint Brain's tools call during reasoning.
        """
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/api/v1/reason",
            {"prompt": "hello"},
        )
        # 403 "forbidden" = authz block (bad). 403 "approval_required" = ok.
        # 200 / 502 = authz passed.
        if r.status_code == 403:
            assert "approval" in r.text.lower(), (
                f"/api/v1/reason blocked by authz: {r.text}"
            )


class TestDeviceSignedApprovalLifecycle:
    """Phase 4: device clients use /v1/staging/ingest, NOT /v1/vault/store.

    Device-scoped tokens are blocked from /v1/vault/store by the auth
    middleware (Phase 4 lockdown). Content goes through staging_ingest
    and Brain classifies + routes it to the correct persona vault.

    Approval lifecycle for sensitive personas is now handled by Brain's
    reasoning flow (async approval-wait-resume), not by direct vault
    writes from device clients.

    This test verifies:
      1. Device can ingest via /v1/staging/ingest (201)
      2. Device is blocked from /v1/vault/store (403 forbidden)
      3. The 403 includes an actionable migration message
    """

    @pytest.fixture(autouse=True)
    def _setup(self, core, docker_services):
        self._core_url = docker_services.core_url
        self._admin_headers = core["headers"]
        self._priv, self._did, self._device_id = _pair_device_fixture(
            self._core_url, self._admin_headers,
        )

    def test_device_uses_staging_not_vault_store(self):
        """Device ingests via staging; vault/store returns 403 forbidden."""
        sess_name = f"staging_sess_{int(time.time())}"

        # --- Step 1: Start session ---
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/session/start", {"name": sess_name},
        )
        assert r.status_code == 201, f"session start: {r.status_code} {r.text}"

        # --- Step 2: Ingest via staging → 201 ---
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/staging/ingest",
            {"source": "dina-cli", "source_id": "test-1", "type": "note",
             "summary": "test note", "body": "test body", "sender": "user"},
            session=sess_name,
        )
        assert r.status_code == 201, (
            f"staging ingest must succeed: {r.status_code} {r.text}"
        )
        data = r.json()
        assert data.get("staged") is True

        # --- Step 3: Direct vault/store → 403 forbidden (Phase 4 lockdown) ---
        r = _device_post(
            self._core_url, self._priv, self._did,
            "/v1/vault/store",
            {"persona": "general", "item": {"Summary": "note", "Type": "note"}},
            session=sess_name,
        )
        assert r.status_code == 403, (
            f"device must be blocked from vault/store: {r.status_code} {r.text}"
        )
        err = r.json()
        assert err.get("error") == "forbidden", f"expected forbidden: {err}"
        # Phase 4 actionable message
        assert "staging/ingest" in err.get("message", ""), (
            f"403 must include migration guidance: {err}"
        )

        _device_post(
            self._core_url, self._priv, self._did,
            "/v1/session/end", {"name": sess_name},
        )


# ---------------------------------------------------------------------------
# Brain-mediated read path (service-key + X-Agent-DID)
# ---------------------------------------------------------------------------


def _try_load_brain_signer():
    """Load Brain's service key for signing. Returns None if unavailable."""
    try:
        from tests.integration.real_clients import _get_signer
        return _get_signer("brain")
    except Exception:
        pass
    try:
        # Fallback: direct import when running from repo root
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, os.pardir))
        from tests.integration.real_clients import _get_signer
        return _get_signer("brain")
    except Exception:
        return None


class TestBrainMediatedApprovalPath:
    """Deterministic proof of the Brain-mediated read path.

    Uses Brain's actual service key to sign requests with X-Agent-DID
    and X-Session headers — the exact pattern Brain uses when calling
    Core's vault on behalf of a device-scoped agent (auth.go:138-146).

    This exercises:
      - service-key signature verification (TokenBrain)
      - X-Agent-DID override: CallerType set to "agent" (auth.go:144)
      - X-Session propagation (auth.go:149)
      - AccessPersona tier enforcement with agent context
      - approval_required → approve → grant → retry succeeds
    """

    @pytest.fixture(autouse=True)
    def _setup(self, core, docker_services):
        self._core_url = docker_services.core_url
        self._admin_headers = core["headers"]
        self._signer = _try_load_brain_signer()
        if self._signer is None:
            pytest.skip("Brain service key not available")

        self._agent_did = "did:key:z6MkBrainPathTestAgent"
        self._persona = f"sens_brain_{int(time.time())}"

        cr = httpx.post(
            f"{self._core_url}/v1/personas",
            json={"name": self._persona, "tier": "sensitive", "passphrase": "test1234"},
            headers=self._admin_headers, timeout=10,
        )
        assert cr.status_code in (201, 409), f"create persona: {cr.text}"

    def _brain_post(self, path, body, *, agent_did="", session=""):
        """Send a Brain-service-key-signed POST with agent context headers."""
        body_bytes = json.dumps(body).encode()
        did, ts, nonce, sig = self._signer.sign_request("POST", path, body_bytes)
        headers = {
            "X-DID": did,
            "X-Timestamp": ts,
            "X-Nonce": nonce,
            "X-Signature": sig,
            "Content-Type": "application/json",
        }
        if agent_did:
            headers["X-Agent-DID"] = agent_did
        if session:
            headers["X-Session"] = session
        return httpx.post(
            f"{self._core_url}{path}",
            content=body_bytes, headers=headers, timeout=10,
        )

    def test_brain_read_approval_lifecycle(self):
        """Service-key + X-Agent-DID vault query: denied → approve → 200.

        This is the exact auth path Brain takes when an agent calls
        /api/v1/reason and Brain's vault tools hit Core:
          Brain signs with service key → Core sees TokenBrain →
          X-Agent-DID present → CallerType overridden to "agent" →
          AccessPersona → ErrApprovalRequired → 403.
        """
        sess_name = f"brain_sess_{int(time.time())}"

        # --- Step 1: Start session (Brain-signed with X-Agent-DID) ---
        # Must use Brain's service key with X-Agent-DID so the session's
        # agent_did matches the identity used in subsequent vault calls.
        # An admin bearer start would create a session with the wrong
        # agent_did (bootstrap identity), causing grant lookup to fail.
        sr = self._brain_post(
            "/v1/session/start", {"name": sess_name},
            agent_did=self._agent_did,
        )
        assert sr.status_code in (201, 409), f"session start: {sr.status_code} {sr.text}"

        # --- Step 2: Brain-signed vault query with agent context → 403 ---
        r = self._brain_post(
            "/v1/vault/query",
            {"persona": self._persona, "query": "test", "mode": "fts5"},
            agent_did=self._agent_did, session=sess_name,
        )
        assert r.status_code == 403, (
            f"expected 403, got {r.status_code}: {r.text}"
        )
        data = r.json()
        assert data.get("error") == "approval_required", (
            f"must be approval_required: {data}"
        )
        approval_id = data.get("approval_id", "")
        assert approval_id, f"must include approval_id: {data}"

        # --- Step 3: Verify pending ---
        pending = httpx.get(
            f"{self._core_url}/v1/persona/approvals",
            headers=self._admin_headers, timeout=10,
        ).json().get("approvals", [])
        assert any(a["id"] == approval_id for a in pending), (
            f"{approval_id} not in pending"
        )

        # --- Step 4: Admin approves ---
        ar = httpx.post(
            f"{self._core_url}/v1/persona/approve",
            json={"id": approval_id, "scope": "session"},
            headers=self._admin_headers, timeout=10,
        )
        assert ar.status_code == 200, f"approve: {ar.text}"

        # --- Step 5: Retry → 200 ---
        retry = self._brain_post(
            "/v1/vault/query",
            {"persona": self._persona, "query": "test", "mode": "fts5"},
            agent_did=self._agent_did, session=sess_name,
        )
        assert retry.status_code == 200, (
            f"after approve, must succeed: {retry.status_code} {retry.text}"
        )

        # --- Step 6: Without X-Agent-DID, Brain gets its own access (not agent) ---
        # Brain without X-Agent-DID = CallerType "brain", not "agent".
        # Sensitive persona requires grant for brain too.
        brain_only = self._brain_post(
            "/v1/vault/query",
            {"persona": self._persona, "query": "test", "mode": "fts5"},
        )
        # Brain callerType triggers the sensitive-tier grant check too,
        # but without session context it won't find the agent's grant.
        assert brain_only.status_code == 403, (
            f"brain without agent context must also be denied for sensitive: "
            f"{brain_only.status_code} {brain_only.text}"
        )
