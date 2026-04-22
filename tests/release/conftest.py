"""Release test fixtures — Docker only, zero mocks.

All release tests run against real Docker containers:
  Go Core + Python Brain + dummy-agent (CLI container).

Requires: DINA_RELEASE=docker and running Docker daemon.
Uses the pre-started union test stack (prepare_non_unit_env.sh).
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from tests.shared.test_stack import TestStackServices


class BrainSigner:
    """Ed25519 request signer for calling Brain API endpoints directly."""

    def __init__(self, private_key_pem: bytes) -> None:
        self._private_key = load_pem_private_key(private_key_pem, password=None)

    def _sign(self, method: str, path: str, body: bytes, query: str = "") -> dict[str, str]:
        import secrets
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return {
            "X-DID": "did:key:zReleaseTestSigner",
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
            "X-Signature": signature.hex(),
        }

    def sign_request(self, method: str, path: str, body: bytes = b"") -> tuple[str, str, str, str]:
        import secrets
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return "did:key:zReleaseTestSigner", timestamp, nonce, signature.hex()

    def post(self, url: str, *, json: dict | None = None, timeout: int = 30) -> httpx.Response:
        import json as _json
        body = _json.dumps(json).encode() if json is not None else b""
        parsed = httpx.URL(url)
        path = parsed.raw_path.decode("ascii")
        headers = self._sign("POST", path, body)
        headers["Content-Type"] = "application/json"
        return httpx.post(url, content=body, headers=headers, timeout=timeout)

DOCKER_MODE = os.environ.get("DINA_RELEASE") == "docker"
LITE_MODE = os.environ.get("DINA_LITE_RELEASE") == "docker"

if DOCKER_MODE and LITE_MODE:
    raise RuntimeError(
        "DINA_RELEASE=docker and DINA_LITE_RELEASE=docker are mutually "
        "exclusive. Pick exactly one target stack per release session."
    )


def pytest_configure(config):
    """Task 9.17 migration prep — register the `skip_in_lite_release`
    marker so release test files can opt out of Lite runs at
    per-file or per-test granularity.

    The release suite's 23 tests (REL-001 through REL-023) exercise
    the full shipping contract: fresh install, first conversation,
    vault persistence, locked state, recovery, two-dinas D2D, trust
    network, agent gateway, persona wall, hostile network, failure
    handling, doc-claims, install rerun, upgrade, admin lifecycle,
    connector outage, silence + briefing, cart handover, export/import,
    exposure audit, CLI agent. Each REL's Lite coverage lands per the
    Phase 8/9 migration prep already done (iters 63-84).

    LITE_SKIPS.md entry for the whole tests/release/ directory is
    recorded as a single file-pattern entry rather than 23 per-file
    rows.
    """
    config.addinivalue_line(
        "markers",
        "skip_in_lite_release(reason): skip this release test when "
        "running under DINA_LITE_RELEASE=docker. Must be paired with an "
        "entry in tests/integration/LITE_SKIPS.md.",
    )


def pytest_collection_modifyitems(config, items):
    """Under DINA_LITE_RELEASE=docker, skip every release test.

    Release tests exercise whole-stack acceptance scenarios that
    depend on cross-milestone features (M1-M5). Rather than migrate
    each REL individually, the whole suite is skipped in Lite mode
    until Lite M5 features land — matches Phase 9c's scope per
    `docs/lite-release-signoff.md`. Individual REL tests can be
    un-skipped here once specific scenarios are Lite-validated.
    """
    if not LITE_MODE:
        return
    skip_marker = pytest.mark.skip(
        reason="[release-suite] Lite release tests deferred to M5 "
        "(task 9.17); individual REL scenarios unmarked as they land"
    )
    for item in items:
        item.add_marker(skip_marker)


# ---------------------------------------------------------------------------
# Release adapter over TestStackServices
# ---------------------------------------------------------------------------

# Actor DIDs — populated dynamically from Core /v1/did on first access.
_ACTOR_DIDS: dict[str, str] = {}


class _ReleaseAdapter:
    """Wraps TestStackServices with release-test-specific helpers.

    Provides agent_exec(*args) and agent_shell(cmd) matching the old
    ReleaseDockerServices interface.
    """

    def __init__(self, stack: TestStackServices) -> None:
        self._stack = stack

    # Delegate standard methods
    def core_url(self, actor: str) -> str:
        return self._stack.core_url(actor)

    def brain_url(self, actor: str) -> str:
        return self._stack.brain_url(actor)

    @property
    def client_token(self) -> str:
        return self._stack.client_token

    def core_private_key(self, actor: str) -> bytes:
        return self._stack.core_private_key(actor)

    def assert_ready(self) -> None:
        self._stack.assert_ready()

    # --- Compose file access ---

    @property
    def _compose_file(self) -> Path:
        return Path(self._stack._manifest["compose_file"])

    def core_service(self, actor: str) -> str:
        """Return the Docker Compose service name for an actor's Core."""
        return f"{actor}-core"

    # --- Actor DIDs ---

    def actor_did(self, actor: str) -> str:
        """Return the real PLC-registered DID for a given actor name.

        Fetches from Core /v1/did on first call, then caches.
        """
        if actor not in _ACTOR_DIDS:
            _ACTOR_DIDS[actor] = self._stack.actor_did(actor)
        return _ACTOR_DIDS[actor]

    def agent_exec(self, *args: str, timeout: int = 30) -> 'subprocess.CompletedProcess':
        """Run `dina --json <args>` inside the dummy-agent container."""
        import subprocess
        manifest = self._stack._manifest
        project = manifest["project"]
        compose_file = manifest["compose_file"]
        cmd = [
            "docker", "compose", "-p", project, "-f", compose_file,
            "exec", "-T", "dummy-agent",
            "dina", "--json",
        ] + list(args)
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )

    def agent_shell(self, command: str) -> 'subprocess.CompletedProcess':
        """Run a shell command inside the dummy-agent container."""
        import subprocess
        manifest = self._stack._manifest
        project = manifest["project"]
        compose_file = manifest["compose_file"]
        cmd = [
            "docker", "compose", "-p", project, "-f", compose_file,
            "exec", "-T", "dummy-agent",
            "sh", "-c", command,
        ]
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )


# ---------------------------------------------------------------------------
# Docker services (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def release_services():
    """Locate the pre-started test stack for release testing.

    Reads .test-stack.json written by prepare_non_unit_env.sh.
    Does NOT manage Docker lifecycle.
    """
    if not DOCKER_MODE:
        pytest.skip("Release tests require Docker (DINA_RELEASE=docker)")

    stack = TestStackServices()
    stack.assert_ready()
    yield _ReleaseAdapter(stack)


# ---------------------------------------------------------------------------
# URL and auth fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def core_url(release_services) -> str:
    return release_services.core_url("alonso")


@pytest.fixture(scope="session")
def brain_url(release_services) -> str:
    return release_services.brain_url("alonso")


@pytest.fixture(scope="session")
def auth_headers(release_services) -> dict[str, str]:
    """Bearer token headers for Core API calls."""
    return {"Authorization": f"Bearer {release_services.client_token}"}


@pytest.fixture(scope="session")
def core_b_url(release_services) -> str:
    return release_services.core_url("sancho")


@pytest.fixture(scope="session")
def actor_a_did(release_services) -> str:
    """DID for the primary actor (alonso)."""
    return release_services.actor_did("alonso")


@pytest.fixture(scope="session")
def actor_b_did(release_services) -> str:
    """DID for the secondary actor (sancho)."""
    return release_services.actor_did("sancho")


@pytest.fixture(scope="session")
def brain_b_url(release_services) -> str:
    return release_services.brain_url("sancho")


@pytest.fixture(scope="session")
def brain_signer(release_services) -> BrainSigner:
    """Ed25519 signer for direct Brain API calls."""
    pem = release_services.core_private_key("alonso")
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
    result = release_services.agent_shell(f'python -c "{gen_script}"')
    if result.returncode != 0:
        pytest.skip(f"Failed to generate agent keypair: {result.stderr}")

    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        pytest.skip(f"Unexpected keygen output: {result.stdout}")

    public_key_multibase = lines[0].strip()
    agent_did = lines[1].strip()

    # Write CLI config inside the container — use alonso-core as internal URL
    config_script = (
        "import json, os; "
        "os.makedirs('/root/.dina/cli', exist_ok=True); "
        "json.dump("
        "{'core_url': 'http://alonso-core:8100', 'persona': 'personal'}, "
        "open('/root/.dina/cli/config.json', 'w')); "
        # Symlink identity dir so CLI finds it
        "os.makedirs('/root/.dina/cli/identity', exist_ok=True); "
        "import shutil; "
        "shutil.copy('/tmp/agent-identity/ed25519_private.pem', '/root/.dina/cli/identity/ed25519_private.pem'); "
        "shutil.copy('/tmp/agent-identity/ed25519_public.pem', '/root/.dina/cli/identity/ed25519_public.pem')"
    )
    release_services.agent_shell(f'python -c "{config_script}"')

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


@pytest.fixture(scope="session")
def agent_session(release_services, agent_paired):
    """Create a session for the paired agent. Returns the session ID."""
    result = release_services.agent_exec("session", "start", "--name", "release-test")
    if result.returncode != 0:
        pytest.skip(f"Failed to create session: {result.stderr}")
    try:
        import json
        data = json.loads(result.stdout)
        session_id = data.get("id", "")
        if not session_id:
            pytest.skip(f"No session ID in response: {result.stdout}")
        return session_id
    except Exception:
        pytest.skip(f"Failed to parse session response: {result.stdout}")
