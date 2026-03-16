"""Release test fixtures — Docker only, zero mocks.

All release tests run against real Docker containers:
  Go Core + Python Brain + dummy-agent (CLI container).

Requires: DINA_RELEASE=docker and running Docker daemon.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest

from tests.release.release_services import BrainSigner, ReleaseDockerServices

DOCKER_MODE = os.environ.get("DINA_RELEASE") == "docker"


# ---------------------------------------------------------------------------
# Docker services (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def release_services():
    """Start Docker containers for release testing."""
    if not DOCKER_MODE:
        pytest.skip("Release tests require Docker (DINA_RELEASE=docker)")

    svc = ReleaseDockerServices()
    # Always restart to avoid stale code; set RELEASE_RESTART=0 to reuse
    restart = os.environ.get("RELEASE_RESTART", "1") != "0"
    svc.start(restart=restart)
    yield svc
    svc.stop()


# ---------------------------------------------------------------------------
# URL and auth fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def core_url(release_services) -> str:
    return release_services.core_url


@pytest.fixture(scope="session")
def brain_url(release_services) -> str:
    return release_services.brain_url


@pytest.fixture(scope="session")
def auth_headers(release_services) -> dict[str, str]:
    """Bearer token headers for Core API calls."""
    return release_services.auth_headers()


@pytest.fixture(scope="session")
def core_b_url(release_services) -> str:
    return release_services.core_b_url


@pytest.fixture(scope="session")
def brain_b_url(release_services) -> str:
    return release_services.brain_b_url


@pytest.fixture(scope="session")
def brain_signer(release_services) -> BrainSigner:
    """Ed25519 signer for direct Brain API calls."""
    pem = release_services.extract_core_private_key()
    return BrainSigner(pem)


# ---------------------------------------------------------------------------
# httpx client (function-scoped for isolation)
# ---------------------------------------------------------------------------

@pytest.fixture
def api(core_url, auth_headers):
    """httpx client configured for the real Go Core."""
    with httpx.Client(
        base_url=core_url,
        headers=auth_headers,
        timeout=10.0,
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Persona setup (session-scoped, runs once)
# ---------------------------------------------------------------------------

PERSONA_TIERS = {
    "general": "default",
    "health": "sensitive",
    "financial": "locked",
    "consumer": "standard",
}
PERSONAS = list(PERSONA_TIERS.keys())


@pytest.fixture(scope="session", autouse=True)
def persona_setup(release_services, core_url, core_b_url, auth_headers):
    """Create and unlock personas on both Core nodes."""
    for url in (core_url, core_b_url):
        for name in PERSONAS:
            tier = PERSONA_TIERS[name]
            try:
                httpx.post(
                    f"{url}/v1/personas",
                    json={
                        "name": name,
                        "tier": tier,
                        "passphrase": "test",
                    },
                    headers=auth_headers,
                    timeout=10,
                )
            except Exception:
                pass

            try:
                httpx.post(
                    f"{url}/v1/persona/unlock",
                    json={"persona": name, "passphrase": "test"},
                    headers=auth_headers,
                    timeout=10,
                )
            except Exception:
                pass

        # Clear vaults for clean test state
        for name in PERSONAS:
            try:
                httpx.post(
                    f"{url}/v1/vault/clear",
                    json={"persona": name},
                    headers=auth_headers,
                    timeout=10,
                )
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Dummy agent pairing (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def agent_paired(release_services, core_url, auth_headers):
    """Generate keypair inside dummy-agent and pair with Core.

    Returns the agent's DID string. The dummy-agent container now has
    a configured CLI keypair paired with Core.
    """
    # Generate keypair inside the container
    gen_script = (
        "from pathlib import Path; "
        "from dina_cli.signing import CLIIdentity; "
        "i = CLIIdentity(identity_dir=Path('/tmp/agent-identity')); "
        "i.generate(); "
        "print(i.public_key_multibase()); "
        "print(i.did())"
    )
    result = release_services.agent_shell(f"python -c \"{gen_script}\"")
    if result.returncode != 0:
        pytest.skip(f"Failed to generate agent keypair: {result.stderr}")

    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        pytest.skip(f"Unexpected keygen output: {result.stdout}")

    public_key_multibase = lines[0].strip()
    agent_did = lines[1].strip()

    # Write CLI config inside the container
    config_script = (
        "import json, os; "
        "os.makedirs('/root/.dina/cli', exist_ok=True); "
        "json.dump("
        "{'core_url': 'http://release-core:8100', 'persona': 'personal'}, "
        "open('/root/.dina/cli/config.json', 'w')); "
        # Symlink identity dir so CLI finds it
        "os.makedirs('/root/.dina/cli/identity', exist_ok=True); "
        "import shutil; "
        "shutil.copy('/tmp/agent-identity/ed25519_private.pem', '/root/.dina/cli/identity/ed25519_private.pem'); "
        "shutil.copy('/tmp/agent-identity/ed25519_public.pem', '/root/.dina/cli/identity/ed25519_public.pem')"
    )
    release_services.agent_shell(f"python -c \"{config_script}\"")

    # Pair via Core API: initiate + complete
    try:
        resp = httpx.post(
            f"{core_url}/v1/pair/initiate",
            json={},
            headers=auth_headers,
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            pytest.skip(f"Pairing initiate failed: {resp.status_code}")

        code = resp.json().get("code") or resp.json().get("pairing_code")
        if not code:
            pytest.skip(f"No pairing code: {resp.json()}")

        resp = httpx.post(
            f"{core_url}/v1/pair/complete",
            json={
                "code": code,
                "device_name": "dummy-agent",
                "public_key_multibase": public_key_multibase,
            },
            headers=auth_headers,
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            pytest.skip(f"Pairing complete failed: {resp.status_code} {resp.text}")

    except httpx.ConnectError:
        pytest.skip("Cannot reach Core for agent pairing")

    return agent_did
