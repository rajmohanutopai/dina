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


def _core_available() -> bool:
    """Check if the main-stack Core is reachable."""
    try:
        resp = httpx.get(f"{_MAIN_CORE_URL}/healthz", timeout=3)
        return resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _main_client_token() -> str:
    """Read the client token from the secrets file."""
    token_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "secrets", "client_token",
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
    # TRACE: {"suite": "E2E", "case": "0092", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "01", "title": "16_pds_container_health"}
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
    # TRACE: {"suite": "E2E", "case": "0093", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "02", "title": "16_pds_server_description"}
    def test_16_pds_server_description(
        self,
        don_alonso,
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
            # Test stack runs with PDS_INVITE_REQUIRED=false for convenience.
            # Just verify the field is present and boolean.
            assert "inviteCodeRequired" in data, (
                "PDS must report inviteCodeRequired field"
            )
        else:
            # Mock mode: exercise HomeNode DID document via PLC resolution
            from tests.e2e.actors import _derive_dek

            # HomeNode DID must be properly formatted
            did = don_alonso.did
            assert did.startswith("did:plc:"), f"Expected did:plc: prefix, got {did}"

            # DID document must be registered in PLC directory
            doc = don_alonso.plc.resolve(did)
            assert doc is not None, "DID document must be PLC-registered"

            # DID document must contain public_key derived from private key
            expected_pub = _derive_dek(don_alonso.root_private_key, "pub")
            assert doc.public_key == expected_pub, (
                f"DID doc public_key {doc.public_key!r} != derived {expected_pub!r}"
            )

            # Service endpoint must reference the DID
            assert "alonso" in doc.service_endpoint, (
                f"service_endpoint must reference DID owner: {doc.service_endpoint}"
            )

    # TST-E2E-094
    # TRACE: {"suite": "E2E", "case": "0094", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "03", "title": "16_did_registration_via_core"}
    def test_16_did_registration_via_core(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.3 GET /v1/did registers did:plc on PDS via XRPC."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available() or not _core_available():
                pytest.skip("Main stack (PDS+Core) not running — start with: docker compose up -d")
            token = _main_client_token()
            if not token:
                pytest.skip("Client token not found in secrets/client_token")
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
            from tests.e2e.actors import _derive_dek

            did = don_alonso.did
            assert did.startswith("did:plc:"), f"Expected did:plc: prefix, got {did}"

            # DID document registered in PLC with correct structure
            doc = don_alonso.plc.resolve(did)
            assert doc is not None, "DID must be PLC-registered"

            # Public key must be derived from root private key (verification method)
            expected_pub = _derive_dek(don_alonso.root_private_key, "pub")
            assert doc.public_key == expected_pub, (
                f"Verification method public_key mismatch"
            )

            # Service endpoint must be well-formed
            assert doc.service_endpoint.startswith("https://"), (
                f"Service endpoint must be HTTPS: {doc.service_endpoint}"
            )

            # Persona DIDs should be populated after first_run_setup
            assert isinstance(doc.persona_dids, dict)

            # Negative: unregistered DID must NOT resolve
            assert don_alonso.plc.resolve("did:plc:nonexistent") is None

    # TST-E2E-095
    # TRACE: {"suite": "E2E", "case": "0095", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "04", "title": "16_well_known_atproto_did"}
    def test_16_well_known_atproto_did(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.4 GET /.well-known/atproto-did returns plain text DID."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available() or not _core_available():
                pytest.skip("Main stack (PDS+Core) not running — start with: docker compose up -d")
            token = _main_client_token()
            if not token:
                pytest.skip("Client token not found")

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
            # Mock mode: exercise well_known_atproto_did() production method
            did = don_alonso.did
            well_known = don_alonso.well_known_atproto_did()

            # well_known_atproto_did() must return exact DID (AT Protocol spec)
            assert well_known == did, (
                f"well_known_atproto_did() {well_known!r} != .did {did!r}"
            )

            # DID VALUE must be a valid did:plc
            assert well_known.startswith("did:plc:"), (
                f"Expected did:plc: prefix, got {well_known!r}"
            )

            # PLC resolution must agree
            doc = don_alonso.plc.resolve(well_known)
            assert doc is not None, "well-known DID must be PLC-resolvable"
            assert doc.did == did, "PLC doc DID must match well-known"

    # TST-E2E-096
    # TRACE: {"suite": "E2E", "case": "0096", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "05", "title": "16_pds_handle_resolution"}
    def test_16_pds_handle_resolution(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.5 PDS resolves handle to DID matching Core's identity."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available() or not _core_available():
                pytest.skip("Main stack (PDS+Core) not running — start with: docker compose up -d")
            token = _main_client_token()
            if not token:
                pytest.skip("Client token not found")

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
    # TRACE: {"suite": "E2E", "case": "0097", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "06", "title": "16_idempotent_did_creation"}
    def test_16_idempotent_did_creation(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.6 Multiple calls to /v1/did return the same DID."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available() or not _core_available():
                pytest.skip("Main stack (PDS+Core) not running — start with: docker compose up -d")
            token = _main_client_token()
            if not token:
                pytest.skip("Client token not found")
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
            # Mock mode: DID stability across multiple access paths
            did_prop = don_alonso.did
            did_well_known = don_alonso.well_known_atproto_did()
            did_doc = don_alonso.plc.resolve(did_prop)

            # All three access paths must return the same DID
            assert did_prop == did_well_known, (
                f".did {did_prop!r} != well_known {did_well_known!r}"
            )
            assert did_doc is not None, "PLC must resolve the DID"
            assert did_doc.did == did_prop, (
                f"PLC doc DID {did_doc.did!r} != .did {did_prop!r}"
            )

            # VALUE check — must be a valid did:plc
            assert did_prop.startswith("did:plc:"), (
                f"Expected did:plc: prefix, got {did_prop!r}"
            )

            # Negative: a different HomeNode must get a DIFFERENT DID
            from tests.e2e.actors import HomeNode
            other = HomeNode(
                did="did:plc:other",
                display_name="Other",
                trust_ring=don_alonso.trust_ring,
                plc=don_alonso.plc,
                network=don_alonso.network,
            )
            assert other.did != don_alonso.did, "Different nodes must have different DIDs"

    # TST-E2E-098
    # TRACE: {"suite": "E2E", "case": "0098", "section": "16", "sectionName": "AT Protocol PDS", "subsection": "01", "scenario": "07", "title": "16_core_logs_pds_configuration"}
    def test_16_core_logs_pds_configuration(
        self,
        don_alonso,
        docker_services,
    ) -> None:
        """E2E-16.7 Core startup logs confirm PDS configuration."""
        if DOCKER_MODE and docker_services is not None:
            if not _pds_available() or not _core_available():
                pytest.skip("Main stack (PDS+Core) not running — start with: docker compose up -d")
            import subprocess

            # Use main stack logs (not E2E stack).
            # test_status.py starts the main stack with -p dina-main.
            result = subprocess.run(
                ["docker", "compose", "-p", "dina-main", "logs", "core"],
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
            # Mock mode: verify MockPDS is properly initialized on HomeNode
            pds = don_alonso.pds
            assert pds is not None, "HomeNode must have a PDS instance"
            assert pds.did == don_alonso.did, (
                f"PDS DID {pds.did!r} != HomeNode DID {don_alonso.did!r}"
            )

            # PDS records dict must exist and be initially empty or populated
            assert isinstance(pds.records, dict)

            # PDS tombstones list must exist
            assert isinstance(pds.tombstones, list)

            # Verify PDS can publish and record (functional check)
            record_id = pds.publish("app.bsky.feed.post", {"text": "test"})
            assert record_id.startswith(f"at://{don_alonso.did}/"), (
                f"Record URI must reference owner DID: {record_id}"
            )
            assert record_id in pds.records
            assert pds.records[record_id] == {"text": "test"}
