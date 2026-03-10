"""E2E Test Suite 15: CLI Ed25519 Request Signing.

Tests CLI keypair generation, device pairing via public_key_multibase,
signed HTTP requests to Core, tamper detection, replay protection,
unpaired DID rejection, and Bearer token backward compatibility.

Dual-mode:
  - Mock mode (default): Uses CLIIdentity directly + mock HomeNode.
  - Docker mode (DINA_E2E=docker): Signs real HTTP requests against
    Go Core containers via docker_services.

Actors: Don Alonso (primary user).
"""

from __future__ import annotations

import hashlib
import json
import os
import time

import httpx
import pytest

from dina_cli.signing import CLIIdentity
from tests.e2e.mocks import DeviceType

DOCKER_MODE = os.environ.get("DINA_E2E") == "docker"

# Track whether the Docker Core supports Ed25519 signing (set by test_15_02).
_docker_ed25519_paired = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _signed_headers(identity: CLIIdentity, method: str, path: str, body: bytes | None = None) -> dict[str, str]:
    """Build X-DID / X-Timestamp / X-Signature headers for a request."""
    did, timestamp, sig_hex = identity.sign_request(method, path, body)
    return {
        "X-DID": did,
        "X-Timestamp": timestamp,
        "X-Signature": sig_hex,
    }


def _tamper_signature(headers: dict[str, str]) -> dict[str, str]:
    """Return a copy with the signature zeroed out."""
    h = dict(headers)
    h["X-Signature"] = "00" * 64
    return h


def _expire_timestamp(headers: dict[str, str]) -> dict[str, str]:
    """Return a copy with timestamp set 10 minutes ago."""
    from datetime import datetime, timedelta, timezone
    expired = (datetime.now(timezone.utc) - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    h = dict(headers)
    h["X-Timestamp"] = expired
    return h


# ---------------------------------------------------------------------------
# Suite 15: CLI Ed25519 Request Signing
# ---------------------------------------------------------------------------


class TestCLIEd25519Signing:
    """E2E-15.x -- CLI Ed25519 request signing, pairing, and verification."""

    # TST-E2E-084
    def test_15_cli_generates_keypair_and_did_format(
        self,
        cli_identity: CLIIdentity,
    ) -> None:
        """E2E-15.1 CLI generates keypair and DID format is did:key:z6Mk..."""
        did = cli_identity.did()
        assert did.startswith("did:key:z"), f"Expected did:key:z prefix, got {did}"
        # Ed25519 multicodec 0xed01 → base58btc starts with 6Mk
        assert did.startswith("did:key:z6Mk"), f"Expected z6Mk prefix for Ed25519, got {did}"

        # Verify public_key_multibase matches DID
        multibase = cli_identity.public_key_multibase()
        assert multibase.startswith("z"), "multibase must start with z"
        assert did == f"did:key:{multibase}"

    # TST-E2E-085
    def test_15_cli_pairs_with_core_via_multibase(
        self,
        cli_identity: CLIIdentity,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.2 CLI pairs with Core via public_key_multibase."""
        global _docker_ed25519_paired
        if DOCKER_MODE and docker_services is not None:
            base = docker_services.core_url("alonso")
            # Pairing endpoints are admin-only → use CLIENT_TOKEN
            headers = {"Authorization": f"Bearer {docker_services.client_token}"}

            # Initiate pairing to get code
            resp = httpx.post(
                f"{base}/v1/pair/initiate",
                headers=headers, timeout=10,
            )
            assert resp.status_code in (200, 201), f"Initiate failed: {resp.status_code}"
            code = resp.json().get("code") or resp.json().get("pairing_code")
            assert code, f"No pairing code in response: {resp.json()}"

            # Complete pairing with CLI public key
            resp = httpx.post(
                f"{base}/v1/pair/complete",
                json={
                    "code": code,
                    "device_name": "e2e-cli-test",
                    "public_key_multibase": cli_identity.public_key_multibase(),
                },
                headers=headers, timeout=10,
            )
            assert resp.status_code in (200, 201), f"Pair failed: {resp.status_code} {resp.text}"
            data = resp.json()
            if not (data.get("device_id") or data.get("node_did")):
                # Docker Core doesn't support Ed25519 pairing yet (old image)
                pytest.skip("Docker Core does not support Ed25519 pairing — rebuild images")
            _docker_ed25519_paired = True
        else:
            # Mock mode: verify multibase format and DID derivation consistency
            multibase = cli_identity.public_key_multibase()
            assert multibase.startswith("z"), "multibase must start with z (base58btc)"
            assert len(multibase) > 40, "multibase too short for Ed25519"

            # Verify multibase is consistent with DID
            did = cli_identity.did()
            assert did == f"did:key:{multibase}", (
                "DID must equal did:key:{multibase}"
            )

            # Verify raw public key is 32 bytes (Ed25519)
            raw_pub = cli_identity._raw_public_key()
            assert len(raw_pub) == 32, (
                f"Ed25519 raw public key must be 32 bytes, got {len(raw_pub)}"
            )

            # Mock pairing via HomeNode
            code = don_alonso.generate_pairing_code()
            device = don_alonso.pair_device(code, DeviceType.RICH_CLIENT)
            assert device is not None
            assert device.device_type == DeviceType.RICH_CLIENT

            # Verify pairing was audited
            pair_audits = don_alonso.get_audit_entries("device_paired")
            assert len(pair_audits) >= 1
            assert pair_audits[-1].details["device_id"] == device.device_id

    # TST-E2E-086
    def test_15_signed_vault_query_returns_200(
        self,
        cli_identity: CLIIdentity,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.3 Signed vault/query request returns 200."""
        if DOCKER_MODE and docker_services is not None:
            if not _docker_ed25519_paired:
                pytest.skip("Ed25519 pairing not available — rebuild Docker images")
            base = docker_services.core_url("alonso")
            body = json.dumps({"query": "test", "persona": "personal"}).encode()
            headers = _signed_headers(cli_identity, "POST", "/v1/vault/query", body)
            headers["Content-Type"] = "application/json"

            resp = httpx.post(f"{base}/v1/vault/query", content=body, headers=headers, timeout=10)
            assert resp.status_code == 200, f"Signed query failed: {resp.status_code} {resp.text}"
        else:
            # Mock mode: verify sign_request produces valid components
            did, ts, sig = cli_identity.sign_request("POST", "/v1/vault/query", b'{"query":"test"}')
            assert did.startswith("did:key:z6Mk")
            assert "T" in ts and ts.endswith("Z")
            assert len(sig) == 128  # 64 bytes hex-encoded

    # TST-E2E-087
    def test_15_signed_vault_store_returns_200(
        self,
        cli_identity: CLIIdentity,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.4 Signed vault/store request returns 200."""
        if DOCKER_MODE and docker_services is not None:
            if not _docker_ed25519_paired:
                pytest.skip("Ed25519 pairing not available — rebuild Docker images")
            base = docker_services.core_url("alonso")
            body = json.dumps({
                "persona": "personal",
                "item": {
                    "Type": "note",
                    "Source": "e2e_test",
                    "Summary": "E2E signing test",
                    "BodyText": "Signed vault store test",
                    "Metadata": "{}",
                },
            }).encode()
            headers = _signed_headers(cli_identity, "POST", "/v1/vault/store", body)
            headers["Content-Type"] = "application/json"

            resp = httpx.post(f"{base}/v1/vault/store", content=body, headers=headers, timeout=10)
            assert resp.status_code in (200, 201), f"Signed store failed: {resp.status_code} {resp.text}"
        else:
            # Mock mode: verify canonical payload construction and signature
            body = b'{"persona":"personal","item_type":"note","summary":"test"}'
            did, ts, sig = cli_identity.sign_request("POST", "/v1/vault/store", body)

            # Verify DID format
            assert did.startswith("did:key:z6Mk"), f"Expected did:key:z6Mk prefix, got {did}"
            assert did == cli_identity.did(), "DID must match identity"

            # Verify timestamp is ISO 8601 UTC
            assert "T" in ts and ts.endswith("Z")

            # Verify signature is 64 bytes hex-encoded (128 chars)
            assert len(sig) == 128, f"Ed25519 sig must be 128 hex chars, got {len(sig)}"

            # Reconstruct canonical payload and verify signature with public key
            body_hash = hashlib.sha256(body).hexdigest()
            payload = f"POST\n/v1/vault/store\n\n{ts}\n{body_hash}"

            # Verify the 5-part canonical structure
            parts = payload.split("\n")
            assert len(parts) == 5, f"Canonical payload must have 5 parts, got {len(parts)}"
            assert parts[0] == "POST"
            assert parts[1] == "/v1/vault/store"
            assert parts[2] == ""  # empty query string
            assert parts[3] == ts
            assert parts[4] == body_hash

            # REAL Ed25519 signature verification
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            pub_key = cli_identity._private_key.public_key()
            sig_bytes = bytes.fromhex(sig)
            # This raises InvalidSignature if verification fails
            pub_key.verify(sig_bytes, payload.encode("utf-8"))

    # TST-E2E-088
    def test_15_tampered_signature_returns_401(
        self,
        cli_identity: CLIIdentity,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.5 Tampered signature returns 401."""
        if DOCKER_MODE and docker_services is not None:
            base = docker_services.core_url("alonso")
            body = json.dumps({"query": "test", "persona": "personal"}).encode()
            headers = _signed_headers(cli_identity, "POST", "/v1/vault/query", body)
            headers["Content-Type"] = "application/json"
            # Tamper the signature
            headers = _tamper_signature(headers)

            resp = httpx.post(f"{base}/v1/vault/query", content=body, headers=headers, timeout=10)
            assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
        else:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

            # 1. Sign a real request
            body = b'{"query":"test","persona":"personal"}'
            headers = _signed_headers(cli_identity, "POST", "/v1/vault/query", body)
            original_sig = headers["X-Signature"]

            # 2. Verify original signature IS valid (positive control)
            body_hash = hashlib.sha256(body).hexdigest()
            payload = f"POST\n/v1/vault/query\n\n{headers['X-Timestamp']}\n{body_hash}"
            pub_key = cli_identity._private_key.public_key()
            pub_key.verify(bytes.fromhex(original_sig), payload.encode("utf-8"))

            # 3. Tamper the signature
            tampered = _tamper_signature(headers)
            assert tampered["X-Signature"] != original_sig
            assert tampered["X-Signature"] == "00" * 64

            # 4. Verify tampered signature FAILS Ed25519 verification
            with pytest.raises(InvalidSignature):
                pub_key.verify(
                    bytes.fromhex(tampered["X-Signature"]),
                    payload.encode("utf-8"),
                )

    # TST-E2E-089
    def test_15_expired_timestamp_returns_401(
        self,
        cli_identity: CLIIdentity,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.6 Expired timestamp returns 401."""
        if DOCKER_MODE and docker_services is not None:
            base = docker_services.core_url("alonso")
            body = json.dumps({"query": "test", "persona": "personal"}).encode()
            headers = _signed_headers(cli_identity, "POST", "/v1/vault/query", body)
            headers["Content-Type"] = "application/json"
            # Set expired timestamp
            headers = _expire_timestamp(headers)

            resp = httpx.post(f"{base}/v1/vault/query", content=body, headers=headers, timeout=10)
            assert resp.status_code == 401, f"Expected 401 for expired ts, got {resp.status_code}"
        else:
            # Mock mode: verify expired timestamp is outside window
            from datetime import datetime, timedelta, timezone
            headers = _signed_headers(cli_identity, "POST", "/test", b"body")
            expired_headers = _expire_timestamp(headers)
            ts = expired_headers["X-Timestamp"]
            parsed = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            delta = now - parsed
            assert delta.total_seconds() > 5 * 60, "Expired timestamp should be >5 min old"

    # TST-E2E-090
    def test_15_unpaired_did_returns_401(
        self,
        cli_identity: CLIIdentity,
        docker_services,
    ) -> None:
        """E2E-15.7 Unpaired DID returns 401."""
        if DOCKER_MODE and docker_services is not None:
            import tempfile
            from pathlib import Path
            # Generate a fresh keypair NOT registered with Core
            with tempfile.TemporaryDirectory() as td:
                rogue = CLIIdentity(identity_dir=Path(td))
                rogue.generate()

                base = docker_services.core_url("alonso")
                body = json.dumps({"query": "test", "persona": "personal"}).encode()
                headers = _signed_headers(rogue, "POST", "/v1/vault/query", body)
                headers["Content-Type"] = "application/json"

                resp = httpx.post(f"{base}/v1/vault/query", content=body, headers=headers, timeout=10)
                assert resp.status_code == 401, f"Expected 401 for unpaired DID, got {resp.status_code}"
        else:
            import tempfile
            from pathlib import Path

            # 1. Generate rogue identity (not registered with any node)
            with tempfile.TemporaryDirectory() as td:
                rogue = CLIIdentity(identity_dir=Path(td))
                rogue.generate()

                rogue_did = rogue.did()
                paired_did = cli_identity.did()

                # Verify format
                assert rogue_did.startswith("did:key:z6Mk")
                assert paired_did.startswith("did:key:z6Mk")

                # 2. DIDs MUST be different (different keypairs → different DIDs)
                assert rogue_did != paired_did, (
                    "Rogue identity must have a different DID than the paired identity"
                )

                # 3. Raw public keys must differ
                rogue_pub = rogue._raw_public_key()
                paired_pub = cli_identity._raw_public_key()
                assert rogue_pub != paired_pub, (
                    "Rogue and paired identities must have different public keys"
                )

                # 4. Rogue can produce valid signatures (for its own key)
                body = b'{"query":"test"}'
                _, _, rogue_sig = rogue.sign_request("POST", "/v1/vault/query", body)
                assert len(rogue_sig) == 128, "Rogue signature must be valid Ed25519"

                # 5. Rogue's signature does NOT verify with paired identity's key
                from cryptography.exceptions import InvalidSignature
                body_hash = hashlib.sha256(body).hexdigest()
                _, ts, _ = rogue.sign_request("POST", "/v1/vault/query", body)
                payload = f"POST\n/v1/vault/query\n\n{ts}\n{body_hash}"
                paired_pub_key = cli_identity._private_key.public_key()
                with pytest.raises(InvalidSignature):
                    paired_pub_key.verify(
                        bytes.fromhex(rogue_sig),
                        payload.encode("utf-8"),
                    )

    # TST-E2E-091
    @pytest.mark.compat
    def test_15_bearer_token_fallback_still_works(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-15.8 Bearer token fallback still works (backward compat)."""
        if DOCKER_MODE and docker_services is not None:
            base = docker_services.core_url("alonso")
            headers = {"Authorization": f"Bearer {docker_services.client_token}"}
            body = json.dumps({"query": "test", "persona": "personal"}).encode()
            headers["Content-Type"] = "application/json"

            resp = httpx.post(f"{base}/v1/vault/query", content=body, headers=headers, timeout=10)
            assert resp.status_code == 200, f"Bearer fallback failed: {resp.status_code} {resp.text}"
        else:
            # Mock mode: verify vault_query works via mock (no signing)
            results = don_alonso.vault_query("personal", "test")
            # May be empty but should not raise
            assert isinstance(results, list)
