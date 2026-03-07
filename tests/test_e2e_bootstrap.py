"""End-to-end Docker bootstrap test.

Validates that a fresh install -> compose up -> health check cycle works
against real containers. Uses docker-compose.test.yml (ports 18100/18200).

Prerequisites:
  - Docker daemon running
  - No other containers on ports 18100/18200

Run:
  pytest tests/test_e2e_bootstrap.py -v -s

Skip when Docker is unavailable:
  Tests auto-skip if Docker daemon is not reachable.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest
import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose.test.yml"
SECRETS_DIR = PROJECT_ROOT / "secrets"
SERVICE_KEY_DIR = SECRETS_DIR / "service_keys"

# Ports from docker-compose.test.yml
CORE_PORT = 18100
BRAIN_PORT = 18200

HEALTH_TIMEOUT = 180  # seconds — includes container startup
HEALTH_INTERVAL = 5


def _docker_available() -> bool:
    try:
        r = subprocess.run(["docker", "info"], capture_output=True, timeout=10)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _compose(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess:
    cmd = ["docker", "compose", "-f", str(COMPOSE_FILE), *args]
    return subprocess.run(
        cmd, capture_output=True, text=True,
        cwd=str(PROJECT_ROOT), timeout=timeout, check=check,
    )


def _provision_service_keys() -> None:
    """Ensure Ed25519 service keys exist for Core and Brain."""
    needed = [
        SERVICE_KEY_DIR / "core" / "core_ed25519_private.pem",
        SERVICE_KEY_DIR / "brain" / "brain_ed25519_private.pem",
        SERVICE_KEY_DIR / "public" / "core_ed25519_public.pem",
        SERVICE_KEY_DIR / "public" / "brain_ed25519_public.pem",
    ]
    if all(p.exists() for p in needed):
        return

    for sub in ("core", "brain", "public"):
        (SERVICE_KEY_DIR / sub).mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["python3", str(PROJECT_ROOT / "scripts" / "provision_service_keys.py"),
         str(SERVICE_KEY_DIR)],
        check=True, capture_output=True, timeout=30,
    )
    for p in needed:
        assert p.exists(), f"Key provisioning failed: {p} not found"


def _provision_seed() -> None:
    """Ensure wrapped seed, salt, and seed_password exist."""
    wrapped = SECRETS_DIR / "wrapped_seed.bin"
    salt = SECRETS_DIR / "master_seed.salt"
    password = SECRETS_DIR / "seed_password"

    if wrapped.exists() and salt.exists() and password.exists():
        return

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)

    # Ensure the install venv with crypto deps exists
    venv_dir = PROJECT_ROOT / ".install-venv"
    vpython = venv_dir / "bin" / "python3"
    if not vpython.exists():
        subprocess.run(
            ["python3", "-m", "venv", str(venv_dir)],
            check=True, capture_output=True, timeout=30,
        )
        subprocess.run(
            [str(venv_dir / "bin" / "pip"), "install", "-q",
             "argon2-cffi", "cryptography", "mnemonic"],
            check=True, capture_output=True, timeout=60,
        )

    # Generate a test seed and wrap it
    test_seed = "a" * 64  # deterministic test seed
    test_passphrase = "test-passphrase-e2e"

    subprocess.run(
        [str(vpython), str(PROJECT_ROOT / "scripts" / "wrap_seed.py"),
         str(SECRETS_DIR)],
        check=True, capture_output=True, timeout=120,
        env={**os.environ, "DINA_SEED_HEX": test_seed, "DINA_SEED_PASSPHRASE": test_passphrase},
    )

    # Write seed password for Server Mode (auto-unlock)
    password.write_text(test_passphrase)
    os.chmod(str(password), 0o600)

    assert wrapped.exists(), "wrap_seed.py did not create wrapped_seed.bin"
    assert salt.exists(), "wrap_seed.py did not create master_seed.salt"


def _wait_for_health(port: int, path: str = "/healthz", timeout: int = HEALTH_TIMEOUT) -> dict:
    """Poll a health endpoint until it responds or timeout."""
    deadline = time.monotonic() + timeout
    last_err = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"http://localhost:{port}{path}", timeout=5)
            if r.status_code == 200:
                return r.json()
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
                httpx.RemoteProtocolError, httpx.ReadError) as e:
            last_err = e
        time.sleep(HEALTH_INTERVAL)
    raise TimeoutError(
        f"Health check at localhost:{port}{path} did not pass within {timeout}s. "
        f"Last error: {last_err}"
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def docker_bootstrap():
    """Build, start, yield, then tear down the test containers."""
    if not _docker_available():
        pytest.skip("Docker daemon not available")

    # 1. Provision all secrets
    _provision_service_keys()
    _provision_seed()

    # 2. Build images
    print("\n[e2e] Building Docker images...")
    try:
        _compose("build", timeout=600)
    except subprocess.CalledProcessError as e:
        pytest.fail(f"Docker build failed:\nstdout: {e.stdout}\nstderr: {e.stderr}")

    # 3. Start containers
    print("[e2e] Starting containers...")
    try:
        _compose("up", "-d")
    except subprocess.CalledProcessError as e:
        logs = _compose("logs", "--tail=50", check=False)
        pytest.fail(
            f"docker compose up failed:\n{e.stderr}\n"
            f"Container logs:\n{logs.stdout}"
        )

    # 4. Wait for both services to become healthy
    print("[e2e] Waiting for Brain health...")
    try:
        _wait_for_health(BRAIN_PORT)
        print("[e2e] Brain healthy. Waiting for Core health...")
        _wait_for_health(CORE_PORT)
        print("[e2e] Core healthy.")
    except TimeoutError:
        # Capture logs for diagnosis before failing
        logs = _compose("logs", "--tail=80", check=False)
        ps = _compose("ps", check=False)
        _compose("down", "-v", "--remove-orphans", check=False, timeout=60)
        pytest.fail(
            f"Health check timed out.\n"
            f"Container status:\n{ps.stdout}\n"
            f"Logs:\n{logs.stdout}"
        )

    yield

    # 5. Tear down
    print("\n[e2e] Tearing down containers...")
    _compose("down", "-v", "--remove-orphans", check=False, timeout=60)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.e2e
class TestDockerBootstrap:
    """End-to-end Docker bootstrap: build -> start -> health -> verify."""

    def test_brain_healthy(self, docker_bootstrap) -> None:
        """Brain /healthz returns 200 with valid JSON."""
        r = httpx.get(f"http://localhost:{BRAIN_PORT}/healthz", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert "status" in body

    def test_core_healthy(self, docker_bootstrap) -> None:
        """Core /healthz returns 200 with status field."""
        r = httpx.get(f"http://localhost:{CORE_PORT}/healthz", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") in ("ok", "healthy", "unlocked", "locked")

    def test_containers_running(self, docker_bootstrap) -> None:
        """Both core and brain containers are in running state."""
        result = _compose("ps", "--format", "{{.Name}} {{.State}}")
        lines = result.stdout.strip().splitlines()
        states = {}
        for line in lines:
            parts = line.split()
            if len(parts) >= 2:
                states[parts[0]] = parts[1]
        running = [name for name, state in states.items() if state == "running"]
        assert len(running) >= 2, f"Expected 2+ running containers, got: {states}"

    def test_service_keys_mounted(self, docker_bootstrap) -> None:
        """Service keys are accessible inside the containers."""
        # Core should see its private key
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE),
             "exec", "-T", "core",
             "ls", "/run/secrets/service_keys/private/"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=15,
        )
        assert "core_ed25519_private.pem" in result.stdout

        # Brain should see its private key
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE),
             "exec", "-T", "brain",
             "ls", "/run/secrets/service_keys/private/"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=15,
        )
        assert "brain_ed25519_private.pem" in result.stdout

    def test_key_isolation(self, docker_bootstrap) -> None:
        """Core cannot see Brain's private key and vice versa."""
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE),
             "exec", "-T", "core",
             "ls", "/run/secrets/service_keys/private/"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=15,
        )
        assert "brain_ed25519_private.pem" not in result.stdout

        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE),
             "exec", "-T", "brain",
             "ls", "/run/secrets/service_keys/private/"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=15,
        )
        assert "core_ed25519_private.pem" not in result.stdout

    def test_public_keys_shared(self, docker_bootstrap) -> None:
        """Both containers can see both public keys."""
        for svc in ("core", "brain"):
            result = subprocess.run(
                ["docker", "compose", "-f", str(COMPOSE_FILE),
                 "exec", "-T", svc,
                 "ls", "/run/secrets/service_keys/public/"],
                capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=15,
            )
            assert "core_ed25519_public.pem" in result.stdout, f"{svc} missing core public key"
            assert "brain_ed25519_public.pem" in result.stdout, f"{svc} missing brain public key"
