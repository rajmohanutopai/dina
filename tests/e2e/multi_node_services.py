"""Docker Compose lifecycle for multi-node E2E tests.

Manages 4 Core+Brain pairs (Alonso, Sancho, ChairMaker, Albert),
each running in its own Docker container with a separate vault volume.
Shared Docker network enables real inter-node D2D messaging.

Usage as a pytest fixture (session-scoped):

    @pytest.fixture(scope="session")
    def docker_services():
        svc = MultiNodeDockerServices()
        svc.start()
        yield svc
        svc.stop()
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose-e2e.yml"

HEALTH_TIMEOUT = 180  # seconds (4 services take longer)
HEALTH_INTERVAL = 3   # seconds between polls

# Actor → port mapping
ACTOR_PORTS: dict[str, dict[str, int]] = {
    "alonso":     {"core": 19100, "brain": 19200},
    "sancho":     {"core": 19101, "brain": 19201},
    "chairmaker": {"core": 19102, "brain": 19202},
    "albert":     {"core": 19103, "brain": 19203},
}


# ---------------------------------------------------------------------------
# MultiNodeDockerServices
# ---------------------------------------------------------------------------

class MultiNodeDockerServices:
    """Manages the 4-node Docker Compose E2E stack."""

    def __init__(
        self,
        compose_file: Path = COMPOSE_FILE,
    ) -> None:
        self._compose_file = compose_file
        self._started = False
        self._externally_managed = False
        self.client_token: str = ""

    # -- per-actor URLs ------------------------------------------------------

    def core_url(self, actor: str) -> str:
        """External URL for an actor's Go Core (localhost:port)."""
        return f"http://localhost:{ACTOR_PORTS[actor]['core']}"

    def brain_url(self, actor: str) -> str:
        """External URL for an actor's Python Brain (localhost:port)."""
        return f"http://localhost:{ACTOR_PORTS[actor]['brain']}"

    def internal_core_url(self, actor: str) -> str:
        """Docker-internal URL for inter-container communication."""
        return f"http://core-{actor}:8100"

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Build and start all containers, wait for health endpoints."""
        if self._started:
            return

        self._load_tokens()

        # Always rebuild — never reuse containers from a prior suite.
        # Reusing stale images masks code changes during development.
        self._externally_managed = False
        # Tear down any leftover containers from previous runs.
        self._compose("down", "-v")
        # Bust Docker layer cache for COPY src/ layers so tests always
        # run against the current working directory, not stale images.
        # Write a timestamp into the source dirs that Dockerfiles COPY.
        for src_dir in [PROJECT_ROOT / "brain" / "src", PROJECT_ROOT / "core" / "cmd"]:
            sentinel = src_dir / ".build-sentinel"
            sentinel.write_text(f"{time.time()}\n")
        self._compose("up", "--build", "-d")
        self._wait_for_health()
        self._started = True

    def stop(self) -> None:
        """Stop and remove containers + volumes."""
        if not self._started:
            return
        if not self._externally_managed:
            self._compose("down", "-v")
        self._started = False

    # -- health wait ---------------------------------------------------------

    def _wait_for_health(self) -> None:
        """Poll /healthz on all services until they respond 200."""
        deadline = time.monotonic() + HEALTH_TIMEOUT
        healthy: dict[str, bool] = {}

        for actor in ACTOR_PORTS:
            healthy[f"core-{actor}"] = False
            healthy[f"brain-{actor}"] = False

        while time.monotonic() < deadline:
            for actor in ACTOR_PORTS:
                core_key = f"core-{actor}"
                brain_key = f"brain-{actor}"
                if not healthy[core_key]:
                    healthy[core_key] = self._probe(
                        f"{self.core_url(actor)}/healthz"
                    )
                if not healthy[brain_key]:
                    healthy[brain_key] = self._probe(
                        f"{self.brain_url(actor)}/healthz"
                    )

            if all(healthy.values()):
                return

            time.sleep(HEALTH_INTERVAL)

        # Dump logs for debugging
        self._compose("logs", "--tail=30")

        unhealthy = [k for k, v in healthy.items() if not v]
        raise TimeoutError(
            f"E2E services not healthy after {HEALTH_TIMEOUT}s: "
            + ", ".join(unhealthy)
        )

    def _all_healthy(self) -> bool:
        """Check if all services respond to health checks right now."""
        for actor in ACTOR_PORTS:
            if not self._probe(f"{self.core_url(actor)}/healthz"):
                return False
            if not self._probe(f"{self.brain_url(actor)}/healthz"):
                return False
        return True

    @staticmethod
    def _probe(url: str) -> bool:
        """Return True if URL responds with 2xx."""
        try:
            resp = httpx.get(url, timeout=3)
            return resp.is_success
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            return False

    # -- helpers -------------------------------------------------------------

    def _compose(self, *args: str) -> subprocess.CompletedProcess:
        """Run docker compose with the E2E compose file."""
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
            timeout=600,
        )

    def _load_tokens(self) -> None:
        """Read auth tokens used by the E2E stack.

        Raises RuntimeError if CLIENT_TOKEN is missing — fail fast rather than
        silently falling back to empty auth (TST-CORE-989).
        """
        client_path = PROJECT_ROOT / "secrets" / "client_token"
        if client_path.exists():
            self.client_token = client_path.read_text().strip()
        else:
            self.client_token = ""
        if not self.client_token:
            raise RuntimeError(
                f"CLIENT_TOKEN not found or empty at {client_path}. "
                "Docker E2E mode requires a pre-provisioned client_token. "
                "Run install.sh or create secrets/client_token manually."
            )

    def extract_core_private_key(self, actor: str) -> bytes:
        """Extract Core's Ed25519 private key PEM from a running container.

        Returns the PEM bytes for use with BrainSigner (Ed25519 request
        signing for Brain API calls).  Same pattern as SystemServices in
        tests/system/conftest.py.
        """
        result = self._compose(
            "exec", "-T", f"core-{actor}",
            "cat", "/run/secrets/service_keys/private/core_ed25519_private.pem",
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to extract core private key for {actor}: "
                f"{result.stderr[:200]}"
            )
        out = result.stdout
        return out.encode() if isinstance(out, str) else out

    def is_running(self) -> bool:
        """Check if all services respond to health checks."""
        return self._all_healthy()
