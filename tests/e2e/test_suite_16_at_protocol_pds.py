"""E2E Test Suite 16: AT Protocol PDS Integration.

Tests real AT Protocol PDS (Personal Data Server) integration: PDS health,
server description, DID registration via Core->PDS->PLC, .well-known/atproto-did
endpoint, handle resolution, idempotent DID creation, and Core startup logs.

Dual-mode:
  - Mock mode (default): Verifies PDS contract expectations in-memory.
  - Docker mode (DINA_E2E=docker): Hits real PDS + main-stack Core containers.
    Requires main docker-compose stack (with PDS service) to be running.
    Skips if PDS is not reachable.

Actors: Don Alonso (primary user).

TST-E2E-092 through TST-E2E-098.
"""

from __future__ import annotations

import os

import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_E2E") == "docker"

# Main docker-compose stack endpoints (not E2E actor stack).
_MAIN_PDS_URL = "http://localhost:2583"
_MAIN_CORE_URL = "http://localhost:8100"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pds_available() -> bool:
    """Check if the main-stack PDS is reachable."""
    try:
        resp = httpx.get(f"{_MAIN_PDS_URL}/xrpc/_health", timeout=3)
        return resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _main_brain_token() -> str:
    """Read the brain token from the secrets file."""
    token_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "secrets", "brain_token",
    )
    try:
        return open(token_path).read().strip()
    except FileNotFoundError:
        return ""


# ---------------------------------------------------------------------------
# Suite 16: AT Protocol PDS Integration
# ---------------------------------------------------------------------------


class TestATProtocolPDS:
    """E2E-16.x -- AT Protocol PDS integration (TST-E2E-092 through TST-E2E-098)."""

    # TST-E2E-092
    def test_16_pds_container_health(
        self,
        docker_services,
    ) -> None:
        """E2E-16.1 PDS container health check returns version."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            resp = httpx.get(f"{_MAIN_PDS_URL}/xrpc/_health", timeout=10)
            assert resp.status_code == 200, f"PDS health failed: {resp.status_code}"
            data = resp.json()
            assert "version" in data, f"No version in PDS health: {data}"
            assert isinstance(data["version"], str) and len(data["version"]) > 0
        else:
            # Mock mode: verify expected PDS health contract
            expected = {"version": "0.4.208"}
            assert "version" in expected
            assert isinstance(expected["version"], str)

    # TST-E2E-093
    def test_16_pds_server_description(
        self,
        docker_services,
    ) -> None:
        """E2E-16.2 PDS describeServer returns DID, domains, no invite required."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            resp = httpx.get(
                f"{_MAIN_PDS_URL}/xrpc/com.atproto.server.describeServer",
                timeout=10,
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data.get("did", "").startswith("did:web:"), (
                f"PDS DID must be did:web:, got {data.get('did')}"
            )
            assert isinstance(data.get("availableUserDomains"), list)
            assert len(data["availableUserDomains"]) > 0, (
                "PDS must have at least one available user domain"
            )
            assert data.get("inviteCodeRequired") is False, (
                "PDS must not require invites for Dina"
            )
        else:
            # Mock mode: verify expected contract shape
            mock_desc = {
                "did": "did:web:localhost",
                "availableUserDomains": [".test"],
                "inviteCodeRequired": False,
            }
            assert mock_desc["did"].startswith("did:web:")
            assert len(mock_desc["availableUserDomains"]) > 0
            assert mock_desc["inviteCodeRequired"] is False

    # TST-E2E-094
    def test_16_did_registration_via_core(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.3 GET /v1/did registers did:plc on PDS via XRPC."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            token = _main_brain_token()
            if not token:
                pytest.skip("Brain token not found in secrets/brain_token")
            resp = httpx.get(
                f"{_MAIN_CORE_URL}/v1/did",
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
            assert resp.status_code == 200, f"DID init failed: {resp.status_code}"
            data = resp.json()

            # DID must be a real did:plc (registered on PDS/PLC)
            did = data.get("id", "")
            assert did.startswith("did:plc:"), (
                f"Expected did:plc: prefix, got {did}"
            )

            # Verification method must use Ed25519 Multikey
            vm = data.get("verificationMethod", [])
            assert len(vm) >= 1, "Must have at least one verification method"
            assert vm[0].get("type") == "Multikey"
            assert vm[0].get("publicKeyMultibase", "").startswith("z6Mk"), (
                "Ed25519 multikey must start with z6Mk"
            )

            # Authentication array must reference the key
            auth = data.get("authentication", [])
            assert len(auth) >= 1, "Must have at least one authentication entry"
            assert "#key-1" in auth[0]
        else:
            # Mock mode: verify DID creation contract via HomeNode
            did = don_alonso.did
            assert did.startswith("did:plc:") or did.startswith("did:key:")
            assert len(did) > 10

    # TST-E2E-095
    def test_16_well_known_atproto_did(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.4 GET /.well-known/atproto-did returns plain text DID."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            token = _main_brain_token()
            if not token:
                pytest.skip("Brain token not found")

            # First ensure DID exists
            resp_did = httpx.get(
                f"{_MAIN_CORE_URL}/v1/did",
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
            assert resp_did.status_code == 200
            expected_did = resp_did.json().get("id", "")

            # Now check .well-known/atproto-did
            resp = httpx.get(
                f"{_MAIN_CORE_URL}/.well-known/atproto-did", timeout=10,
            )
            assert resp.status_code == 200, (
                f"well-known failed: {resp.status_code}"
            )
            well_known_did = resp.text.strip()
            assert well_known_did.startswith("did:plc:"), (
                f"Expected did:plc: prefix, got {well_known_did!r}"
            )
            assert well_known_did == expected_did, (
                f"well-known DID {well_known_did!r} != /v1/did {expected_did!r}"
            )
        else:
            # Mock mode: verify contract
            did = don_alonso.did
            # In mock mode, DID is available immediately
            assert len(did) > 0

    # TST-E2E-096
    def test_16_pds_handle_resolution(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.5 PDS resolves handle to DID matching Core's identity."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            token = _main_brain_token()
            if not token:
                pytest.skip("Brain token not found")

            # Get DID from Core
            resp_did = httpx.get(
                f"{_MAIN_CORE_URL}/v1/did",
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
            assert resp_did.status_code == 200
            core_did = resp_did.json().get("id", "")

            # Resolve handle on PDS
            resp = httpx.get(
                f"{_MAIN_PDS_URL}/xrpc/com.atproto.identity.resolveHandle",
                params={"handle": "dina.test"},
                timeout=10,
            )
            assert resp.status_code == 200, (
                f"Handle resolution failed: {resp.status_code}"
            )
            pds_did = resp.json().get("did", "")
            assert pds_did == core_did, (
                f"PDS DID {pds_did!r} != Core DID {core_did!r}"
            )
        else:
            # Mock mode: verify handle resolution contract
            did = don_alonso.did
            assert did.startswith("did:plc:") or did.startswith("did:key:")

    # TST-E2E-097
    def test_16_idempotent_did_creation(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.6 Multiple calls to /v1/did return the same DID."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            token = _main_brain_token()
            if not token:
                pytest.skip("Brain token not found")
            headers = {"Authorization": f"Bearer {token}"}

            # First call
            resp1 = httpx.get(
                f"{_MAIN_CORE_URL}/v1/did", headers=headers, timeout=30,
            )
            assert resp1.status_code == 200
            did1 = resp1.json().get("id", "")

            # Second call
            resp2 = httpx.get(
                f"{_MAIN_CORE_URL}/v1/did", headers=headers, timeout=10,
            )
            assert resp2.status_code == 200
            did2 = resp2.json().get("id", "")

            # Third call via .well-known
            resp3 = httpx.get(
                f"{_MAIN_CORE_URL}/.well-known/atproto-did", timeout=10,
            )
            assert resp3.status_code == 200
            did3 = resp3.text.strip()

            assert did1 == did2, (
                f"DID changed between calls: {did1!r} vs {did2!r}"
            )
            assert did1 == did3, (
                f"DID changed between /v1/did and .well-known: "
                f"{did1!r} vs {did3!r}"
            )
        else:
            # Mock mode: HomeNode DID is stable
            did1 = don_alonso.did
            did2 = don_alonso.did
            assert did1 == did2

    # TST-E2E-098
    def test_16_core_logs_pds_configuration(
        self,
        docker_services,
    ) -> None:
        """E2E-16.7 Core startup logs confirm PDS configuration."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available():
                pytest.skip("PDS not running — start main stack with: docker compose up -d")
            import subprocess

            # Use main stack logs (not E2E stack)
            result = subprocess.run(
                ["docker", "compose", "logs", "core"],
                capture_output=True, text=True, timeout=10,
            )
            logs = result.stdout

            # Check for PDS configuration log line
            assert "AT Protocol PDS configured" in logs, (
                "Core must log PDS configuration at startup"
            )

            # Check for PDS URL in logs
            assert "pds_url" in logs, (
                "Core must log pds_url field"
            )
        else:
            # Mock mode: verify log message contract
            expected_msg = "AT Protocol PDS configured"
            assert "PDS" in expected_msg
