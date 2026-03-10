"""Docker Compose lifecycle management for integration tests.

Starts core + brain containers, waits for health endpoints,
provides base URLs for real HTTP clients, and tears down on cleanup.

Usage as a pytest fixture (session-scoped):

    @pytest.fixture(scope="session")
    def docker_services():
        svc = DockerServices()
        svc.start()
        yield svc
        svc.stop()
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import httpx


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose.test.yml"

DEFAULT_CORE_PORT = 18100
DEFAULT_BRAIN_PORT = 18200

HEALTH_TIMEOUT = 120  # seconds to wait for both services
HEALTH_INTERVAL = 2   # seconds between health polls


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

@dataclass
class ServiceURLs:
    """Base URLs for the running Docker services."""
    core: str
    brain: str


# ---------------------------------------------------------------------------
# DockerServices
# ---------------------------------------------------------------------------

class DockerServices:
    """Manages the Docker Compose test stack lifecycle."""

    def __init__(
        self,
        compose_file: Path = COMPOSE_FILE,
        core_port: int = DEFAULT_CORE_PORT,
        brain_port: int = DEFAULT_BRAIN_PORT,
    ) -> None:
        self._compose_file = compose_file
        self._core_port = core_port
        self._brain_port = brain_port
        self._started = False
        self.urls = ServiceURLs(
            core=f"http://localhost:{core_port}",
            brain=f"http://localhost:{brain_port}",
        )
        self.client_token: str = ""

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Build and start containers, wait for health endpoints.

        If containers are already running and healthy, skip build/start.
        """
        if self._started:
            return

        self._load_client_token()

        # Skip docker compose up if services are already healthy
        if self.is_running():
            self._externally_managed = True
            self._started = True
            return

        self._externally_managed = False
        self._compose("up", "--build", "-d")
        self._wait_for_health()
        self._started = True

    def stop(self) -> None:
        """Stop and remove containers + ephemeral volumes.

        Skips teardown if containers were externally managed (pre-started).
        """
        if not self._started:
            return
        if not getattr(self, "_externally_managed", False):
            self._compose("down", "-v")
        self._started = False

    # -- health wait ---------------------------------------------------------

    def _wait_for_health(self) -> None:
        """Poll /healthz on both services until they respond 200."""
        core_url = f"{self.urls.core}/healthz"
        brain_url = f"{self.urls.brain}/healthz"

        deadline = time.monotonic() + HEALTH_TIMEOUT
        core_healthy = False
        brain_healthy = False

        while time.monotonic() < deadline:
            if not brain_healthy:
                brain_healthy = self._probe(brain_url)
            if not core_healthy:
                core_healthy = self._probe(core_url)

            if core_healthy and brain_healthy:
                return

            time.sleep(HEALTH_INTERVAL)

        # Dump logs for debugging before raising
        self._compose("logs", "--tail=50")

        parts = []
        if not core_healthy:
            parts.append(f"core ({core_url})")
        if not brain_healthy:
            parts.append(f"brain ({brain_url})")
        raise TimeoutError(
            f"Docker services not healthy after {HEALTH_TIMEOUT}s: "
            + ", ".join(parts)
        )

    @staticmethod
    def _probe(url: str) -> bool:
        """Return True if url responds with 2xx."""
        try:
            resp = httpx.get(url, timeout=3)
            return resp.is_success
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            return False

    # -- helpers -------------------------------------------------------------

    def _compose(self, *args: str) -> subprocess.CompletedProcess:
        """Run docker compose with the test compose file."""
        cmd = [
            "docker", "compose",
            "-f", str(self._compose_file),
            *args,
        ]
        return subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=300,
        )

    def _load_client_token(self) -> None:
        """Read the client token from secrets/client_token.

        Raises RuntimeError if CLIENT_TOKEN is missing — fail fast rather than
        silently falling back to empty auth (TST-CORE-989).
        """
        token_path = PROJECT_ROOT / "secrets" / "client_token"
        if token_path.exists():
            self.client_token = token_path.read_text().strip()
        else:
            self.client_token = ""
        if not self.client_token:
            raise RuntimeError(
                f"CLIENT_TOKEN not found or empty at {token_path}. "
                "Docker integration mode requires a pre-provisioned client_token. "
                "Run install.sh or create secrets/client_token manually."
            )

    # -- convenience for tests -----------------------------------------------

    @property
    def core_url(self) -> str:
        return self.urls.core

    @property
    def brain_url(self) -> str:
        return self.urls.brain

    def is_running(self) -> bool:
        """Check if both services respond to health checks right now."""
        return (
            self._probe(f"{self.urls.core}/healthz")
            and self._probe(f"{self.urls.brain}/healthz")
        )
