"""Docker Compose lifecycle for release tests.

Manages Node A (Core + Brain) + Node B (Core + Brain) + dummy-agent
+ AT Protocol tier (PLC, PDS, Jetstream, AppView) for release validation.
All release tests run against real services — zero mocks.

Usage as a pytest fixture (session-scoped):

    @pytest.fixture(scope="session")
    def release_services():
        svc = ReleaseDockerServices()
        svc.start()
        yield svc
        svc.stop()
"""

from __future__ import annotations

import hashlib
import os
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.serialization import load_pem_private_key

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose-release.yml"

HEALTH_TIMEOUT = 240  # seconds
HEALTH_INTERVAL = 3   # seconds

_DEFAULT_PORT_BASE = 19500


def _port_free(port: int) -> bool:
    """Check if a TCP port is free on localhost."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        s.connect(("localhost", port))
        s.close()
        return False
    except (ConnectionRefusedError, OSError):
        return True


def _allocate_ports(base: int | None = None) -> dict[str, int]:
    """Find a free port base and compute all port assignments."""
    if base is None:
        base = int(os.environ.get("PORT_RELEASE_CORE", str(_DEFAULT_PORT_BASE)))

    for _ in range(40):
        if _port_free(base):
            break
        base += 500

    ports = {
        "core": base,
        "brain": base + 100,
        "core_b": base + 1,
        "brain_b": base + 101,
    }

    os.environ["PORT_RELEASE_CORE"] = str(ports["core"])
    os.environ["PORT_RELEASE_BRAIN"] = str(ports["brain"])
    os.environ["PORT_RELEASE_CORE_B"] = str(ports["core_b"])
    os.environ["PORT_RELEASE_BRAIN_B"] = str(ports["brain_b"])

    return ports


PORTS = _allocate_ports()


class BrainSigner:
    """Ed25519 request signer for calling Brain API endpoints directly.

    Loads Core's private key from the running Docker container and signs
    requests using the canonical payload format that Brain verifies.
    """

    def __init__(self, private_key_pem: bytes) -> None:
        key = load_pem_private_key(private_key_pem, password=None)
        self._private_key = key

    def _sign(
        self, method: str, path: str, body: bytes, query: str = "",
    ) -> dict[str, str]:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return {
            "X-DID": "did:key:zReleaseTestSigner",
            "X-Timestamp": timestamp,
            "X-Signature": signature.hex(),
        }

    def post(
        self, url: str, *, json: dict | None = None, timeout: int = 30,
    ) -> httpx.Response:
        """POST with Ed25519 signed headers."""
        import json as _json
        body = _json.dumps(json).encode() if json is not None else b""
        parsed = httpx.URL(url)
        path = parsed.raw_path.decode("ascii")
        headers = self._sign("POST", path, body)
        headers["Content-Type"] = "application/json"
        return httpx.post(url, content=body, headers=headers, timeout=timeout)


class ReleaseDockerServices:
    """Manages the release test Docker stack.

    Node A (Core + Brain) + Node B (Core + Brain) + dummy-agent
    + AT Protocol tier (PLC, PDS, Jetstream, AppView).
    """

    def __init__(
        self, compose_file: Path = COMPOSE_FILE,
    ) -> None:
        self._compose_file = compose_file
        self._started = False
        self._externally_managed = False
        self.client_token: str = ""

    @property
    def core_url(self) -> str:
        return f"http://localhost:{PORTS['core']}"

    @property
    def brain_url(self) -> str:
        return f"http://localhost:{PORTS['brain']}"

    @property
    def core_b_url(self) -> str:
        return f"http://localhost:{PORTS['core_b']}"

    @property
    def brain_b_url(self) -> str:
        return f"http://localhost:{PORTS['brain_b']}"

    def auth_headers(self) -> dict[str, str]:
        """Bearer token headers for Core API calls."""
        return {"Authorization": f"Bearer {self.client_token}"}

    # -- lifecycle -----------------------------------------------------------

    def start(self, restart: bool = False) -> None:
        global PORTS

        self._load_tokens()

        if restart:
            print("\n  [release] Tearing down existing stack (restart)...")
            self._compose("down", "-v")

        if self._all_healthy():
            self._externally_managed = True
            self._started = True
            print("  [release] Reusing running containers.")
            return

        self._externally_managed = False

        for attempt in range(5):
            base = PORTS["core"]
            print(
                f"  [release] Starting release stack "
                f"(ports {base}+, attempt {attempt + 1})..."
            )
            result = self._compose("up", "--build", "-d")
            if result.returncode == 0:
                break

            stderr = (result.stderr or "").lower()
            if "port is already allocated" in stderr or "address already in use" in stderr:
                print(f"  [release] Port conflict on base {base} — re-allocating...")
                self._compose("down", "-v")
                PORTS = _allocate_ports(base + 500)
                continue

            raise RuntimeError(
                f"docker compose up failed (exit {result.returncode}):\n"
                f"{(result.stderr or '')[-1000:]}"
            )
        else:
            raise RuntimeError("Failed to start release stack after 5 re-allocations")

        self._wait_for_health()
        self._started = True
        print("  [release] All services healthy.")

    def stop(self) -> None:
        if not self._started:
            return
        if not self._externally_managed:
            print("\n  [release] Stopping release stack...")
            self._compose("down", "-v")
            print("  [release] Stack stopped.")

    # -- agent exec ----------------------------------------------------------

    def agent_exec(self, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
        """Run a dina CLI command inside the dummy-agent container."""
        cmd = [
            "docker", "compose",
            "-f", str(self._compose_file),
            "exec", "-T", "dummy-agent",
            "dina", "--json",
        ] + list(args)
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=timeout,
        )

    def agent_shell(self, command: str, timeout: int = 30) -> subprocess.CompletedProcess:
        """Run an arbitrary shell command inside the dummy-agent container."""
        cmd = [
            "docker", "compose",
            "-f", str(self._compose_file),
            "exec", "-T", "dummy-agent",
            "sh", "-c", command,
        ]
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=timeout,
        )

    # -- service key extraction -----------------------------------------------

    def extract_core_private_key(self) -> bytes:
        """Extract Core's Ed25519 private key PEM from the running container."""
        result = self._compose(
            "exec", "-T", "release-core",
            "cat", "/run/secrets/service_keys/private/core_ed25519_private.pem",
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to extract core private key: {result.stderr[:200]}"
            )
        return result.stdout.encode() if isinstance(result.stdout, str) else result.stdout

    # -- health wait ---------------------------------------------------------

    def _wait_for_health(self) -> None:
        deadline = time.monotonic() + HEALTH_TIMEOUT
        while time.monotonic() < deadline:
            if self._all_healthy():
                return
            remaining = int(deadline - time.monotonic())
            print(f"  [release] Waiting for services... ({remaining}s remaining)")
            time.sleep(HEALTH_INTERVAL)
        self._compose("logs", "--tail=50")
        raise TimeoutError(
            f"Release services not healthy after {HEALTH_TIMEOUT}s"
        )

    def _all_healthy(self) -> bool:
        return (
            self._probe(f"{self.core_url}/healthz")
            and self._probe(f"{self.brain_url}/healthz")
            and self._probe(f"{self.core_b_url}/healthz")
            and self._probe(f"{self.brain_b_url}/healthz")
        )

    @staticmethod
    def _probe(url: str) -> bool:
        try:
            return httpx.get(url, timeout=3).is_success
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            return False

    def _compose(self, *args: str) -> subprocess.CompletedProcess:
        cmd = ["docker", "compose", "-f", str(self._compose_file)] + list(args)
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=str(PROJECT_ROOT),
        )

    def _load_tokens(self) -> None:
        token_path = PROJECT_ROOT / "secrets" / "client_token"
        self.client_token = token_path.read_text().strip() if token_path.exists() else ""
